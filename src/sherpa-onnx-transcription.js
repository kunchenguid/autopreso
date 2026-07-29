import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultSherpaOnnxModelDir,
  ensureSherpaOnnxModel,
} from "./sherpa-model.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 24000;
const RUNTIME_PACKAGE_BY_PLATFORM = new Map([
  ["darwin:arm64", "sherpa-onnx-darwin-arm64"],
  ["darwin:x64", "sherpa-onnx-darwin-x64"],
  ["linux:arm64", "sherpa-onnx-linux-arm64"],
  ["linux:x64", "sherpa-onnx-linux-x64"],
  ["win32:ia32", "sherpa-onnx-win-ia32"],
  ["win32:x64", "sherpa-onnx-win-x64"],
]);

export function sherpaOnnxPlatformPackageName(platform = process.platform, arch = process.arch) {
  const packageName = RUNTIME_PACKAGE_BY_PLATFORM.get(`${platform}:${arch}`);
  if (!packageName) {
    throw new Error(`Sherpa-ONNX local transcription is not available for ${platform} ${arch}.`);
  }
  return packageName;
}

export function resolveSherpaOnnxLibraryDir({
  platform = process.platform,
  arch = process.arch,
  requireResolve = /** @type {(id: string) => string} */ ((id) => require.resolve(id)),
} = {}) {
  const packageName = sherpaOnnxPlatformPackageName(platform, arch);
  return path.dirname(requireResolve(`${packageName}/package.json`));
}

export function resolveSherpaOnnxSidecarPath({ env = process.env } = {}) {
  return env.AUTOPRESO_SHERPA_SIDECAR || path.join(__dirname, "sherpa-onnx-sidecar.cjs");
}

export function createSherpaOnnxTranscription({
  sendTranscript,
  queueTranscript,
  options,
  env = undefined,
  spawnProcess = /** @type {any} */ (spawn),
  ensureModel = ensureSherpaOnnxModel,
  resolveLibraryDir = () => resolveSherpaOnnxLibraryDir(),
  resolveSidecarPath = () => resolveSherpaOnnxSidecarPath({ env: env ?? options.env }),
}) {
  const processEnv = env ?? options.env ?? process.env;
  let child = null;
  let stdoutBuffer = "";
  let readyPromise = null;
  let readySettled = false;

  async function prepare() {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      try {
        const modelDir = await ensureModel({
          modelDir: defaultSherpaOnnxModelDir({ env: processEnv }),
          onStatus: options.onStatus,
        });
        const libraryDir = resolveLibraryDir();
        const childEnv = withNativeLibraryPath(processEnv, libraryDir);
        const sidecarPath = resolveSidecarPath();

        await new Promise((resolve, reject) => {
          child = spawnProcess(
            process.execPath,
            [sidecarPath, "--model-dir", modelDir],
            { stdio: ["pipe", "pipe", "pipe"], env: childEnv },
          );

          child.stdout.on("data", (chunk) => {
            stdoutBuffer += chunk.toString("utf8");
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
              handleSidecarLine(line, {
                sendTranscript,
                queueTranscript,
                onReady: () => {
                  readySettled = true;
                  resolve();
                },
              });
            }
          });

          child.stderr.on("data", (chunk) => {
            const message = chunk.toString("utf8").trim();
            if (message) options.onStatus?.(`[sherpa-onnx] ${message}`);
          });

          child.on("error", (error) => {
            sendTranscript({ type: "error", message: error.message });
            reject(error);
          });

          child.on("close", (code) => {
            if (!readySettled) {
              reject(new Error(`Sherpa-ONNX sidecar exited before it was ready${code === null ? "" : ` (code ${code})`}.`));
            }
            child = null;
            readyPromise = null;
            readySettled = false;
          });
        });
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        readyPromise = null;
        throw error;
      }
    })();

    return readyPromise;
  }

  return {
    ready: prepare,
    sendAudio: (audio) => {
      if (!audio || !child || !readySettled) return;
      child.stdin.write(`${JSON.stringify({
        type: "audio",
        encoding: "pcm16le",
        sampleRate: SAMPLE_RATE,
        audio,
      })}\n`);
    },
    stop: () => {
      if (!child || !readySettled) return;
      child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
    },
    close: () => {
      if (!child) return;
      child.stdin.end();
      child.kill();
      child = null;
      readyPromise = null;
      readySettled = false;
    },
  };
}

function withNativeLibraryPath(env, libraryDir, platform = process.platform) {
  const next = { ...env };
  const variable = platform === "darwin"
    ? "DYLD_LIBRARY_PATH"
    : platform === "linux"
      ? "LD_LIBRARY_PATH"
      : "PATH";
  next[variable] = [libraryDir, env[variable]].filter(Boolean).join(path.delimiter);
  return next;
}

function handleSidecarLine(line, { sendTranscript, queueTranscript, onReady }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid Sherpa-ONNX sidecar message: ${line}` });
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
    sendTranscript({ type: "error", message: message.message ?? "Sherpa-ONNX transcription error" });
  }
}
