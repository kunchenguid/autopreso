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
  let readyPromise = null;
  let readySettled = false;
  let closeRequested = false;

  async function prepare() {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      try {
        const modelDir = await ensureModel({
          modelDir: defaultSherpaOnnxModelDir({ env: processEnv }),
          onStatus: options.onStatus,
        });
        if (closeRequested) return;

        const libraryDir = resolveLibraryDir();
        const childEnv = withNativeLibraryPath(processEnv, libraryDir);
        const sidecarPath = resolveSidecarPath();

        await new Promise((resolve, reject) => {
          const spawnedChild = spawnProcess(
            process.execPath,
            [sidecarPath, "--model-dir", modelDir],
            { stdio: ["pipe", "pipe", "pipe"], env: childEnv },
          );
          let processReady = false;
          let runtimeFailureReported = false;
          let processStdoutBuffer = "";
          child = spawnedChild;

          spawnedChild.stdout.on("data", (chunk) => {
            processStdoutBuffer += chunk.toString("utf8");
            const lines = processStdoutBuffer.split("\n");
            processStdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
              handleSidecarLine(line, {
                sendTranscript,
                queueTranscript,
                onReady: () => {
                  if (child !== spawnedChild || closeRequested) return;
                  processReady = true;
                  readySettled = true;
                  resolve();
                },
              });
            }
          });

          spawnedChild.stderr.on("data", (chunk) => {
            const message = chunk.toString("utf8").trim();
            if (message) options.onStatus?.(`[sherpa-onnx] ${message}`);
          });

          spawnedChild.on("error", (error) => {
            if (closeRequested) return;
            if (!processReady) {
              reject(error);
              return;
            }
            runtimeFailureReported = true;
            sendTranscript({ type: "error", message: error.message });
          });

          spawnedChild.on("close", (code) => {
            if (!processReady) {
              reject(new Error(`Sherpa-ONNX sidecar exited before it was ready${code === null ? "" : ` (code ${code})`}.`));
            }
            if (child !== spawnedChild) return;
            child = null;
            readyPromise = null;
            readySettled = false;
            if (processReady && !closeRequested && !runtimeFailureReported) {
              sendTranscript({
                type: "error",
                message: `Sherpa-ONNX sidecar exited unexpectedly${code === null ? "" : ` (code ${code})`}.`,
              });
            }
          });
        });
      } catch (error) {
        if (!closeRequested) sendTranscript({ type: "error", message: error.message });
        readyPromise = null;
        throw error;
      }
    })();

    return readyPromise;
  }

  return {
    ready: prepare,
    sendAudio: (audio) => {
      if (!audio || closeRequested) return;
      if (child && readySettled) {
        writeAudio(child, audio);
        return;
      }
      prepare()
        .then(() => {
          if (child && readySettled && !closeRequested) writeAudio(child, audio);
        })
        .catch(() => {});
    },
    stop: () => {
      if (!child || !readySettled) return;
      child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
    },
    close: () => {
      closeRequested = true;
      const childToClose = child;
      child = null;
      readyPromise = null;
      readySettled = false;
      if (!childToClose) return;
      childToClose.stdin.end();
      childToClose.kill();
    },
  };
}

function writeAudio(child, audio) {
  child.stdin.write(`${JSON.stringify({
    type: "audio",
    encoding: "pcm16le",
    sampleRate: SAMPLE_RATE,
    audio,
  })}\n`);
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
