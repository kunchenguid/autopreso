import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 24000;
const SIDECAR_PACKAGE_BY_PLATFORM = new Map([
  ["darwin:arm64", "@autopreso/moonshine-darwin-arm64"],
  ["darwin:x64", "@autopreso/moonshine-darwin-x64"],
]);

export function moonshinePlatformPackageName(platform = process.platform, arch = process.arch) {
  const packageName = SIDECAR_PACKAGE_BY_PLATFORM.get(`${platform}:${arch}`);
  if (!packageName) {
    throw new Error("Moonshine local transcription is currently available for macOS arm64 and x64.");
  }
  return packageName;
}

export function resolveMoonshineSidecarPath({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  requireResolve = require.resolve,
} = {}) {
  if (env.AUTOPRESO_MOONSHINE_BIN) return env.AUTOPRESO_MOONSHINE_BIN;

  const packageName = moonshinePlatformPackageName(platform, arch);
  const packageJsonPath = requireResolve(`${packageName}/package.json`);
  return path.join(path.dirname(packageJsonPath), "bin", "autopreso-moonshine");
}

export function createMoonshineTranscription({
  sendTranscript,
  queueTranscript,
  options,
  spawnProcess = spawn,
  resolveSidecarPath = () => resolveMoonshineSidecarPath(),
}) {
  let child = null;
  let stdoutBuffer = "";
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;

  function ensureChild() {
    if (child) return child;

    const binary = resolveSidecarPath();
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    child = spawnProcess(binary, ["--model", options.moonshineModel, "--language", "en"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleSidecarLine(line, { sendTranscript, queueTranscript, onReady: resolveReady });
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) sendTranscript({ type: "error", message });
    });

    child.on("error", (error) => {
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    child.on("close", (code) => {
      rejectReady?.(new Error(`Moonshine sidecar exited before it was ready${code === null ? "" : ` (code ${code})`}.`));
      child = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
    });

    return child;
  }

  return {
    ready: async () => {
      ensureChild();
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      let process;
      try {
        process = ensureChild();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      process.stdin.write(`${JSON.stringify({ type: "audio", encoding: "pcm16le", sampleRate: SAMPLE_RATE, audio })}\n`);
    },
    stop: () => {
      if (!child) return;
      child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
    },
    close: () => {
      if (!child) return;
      child.stdin.end();
      child.kill();
      child = null;
    },
  };
}

function handleSidecarLine(line, { sendTranscript, queueTranscript, onReady }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid Moonshine sidecar message: ${line}` });
    return;
  }

  if (message.type === "ready") {
    onReady?.();
    return;
  }

  if (message.type === "transcript:partial") {
    sendTranscript({ type: "transcript:partial", text: message.text ?? "" });
  }

  if (message.type === "transcript:committed") {
    const text = message.text ?? "";
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  if (message.type === "error") {
    sendTranscript({ type: "error", message: message.message ?? "Moonshine transcription error" });
  }
}
