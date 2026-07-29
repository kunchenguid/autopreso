#!/usr/bin/env node
const path = require("node:path");
const readline = require("node:readline");

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function pcm16leBase64ToFloat32(audioBase64) {
  const pcm = Buffer.from(audioBase64, "base64");
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function createRecognizerConfig(modelDir) {
  return {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder-epoch-99-avg-1.int8.onnx"),
        decoder: path.join(modelDir, "decoder-epoch-99-avg-1.onnx"),
        joiner: path.join(modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 20,
  };
}

function createSidecarRuntime({ sherpaOnnx, modelDir, emitMessage = emit }) {
  const recognizer = new sherpaOnnx.OnlineRecognizer(createRecognizerConfig(modelDir));
  let stream = recognizer.createStream();
  let lastPartial = "";

  function emitResult({ commit = false } = {}) {
    const result = recognizer.getResult(stream);
    const text = typeof result?.text === "string" ? result.text.trim() : "";

    if (!commit && text !== lastPartial) {
      lastPartial = text;
      emitMessage({ type: "transcript:partial", text });
    }
    if (commit && text) {
      emitMessage({ type: "transcript:committed", text });
      lastPartial = "";
    }
    return text;
  }

  function decodeReadyFrames() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    emitResult();

    if (recognizer.isEndpoint(stream)) {
      emitResult({ commit: true });
      recognizer.reset(stream);
      lastPartial = "";
    }
  }

  return {
    handleMessage(message) {
      if (message.type === "audio") {
        const samples = pcm16leBase64ToFloat32(message.audio ?? "");
        if (samples.length === 0) return;
        stream.acceptWaveform({
          samples,
          sampleRate: Number(message.sampleRate) || 24000,
        });
        decodeReadyFrames();
        return;
      }

      if (message.type === "stop") {
        stream.inputFinished();
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        emitResult({ commit: true });
        stream = recognizer.createStream();
        lastPartial = "";
      }
    },
  };
}

function readModelDir(args) {
  const index = args.indexOf("--model-dir");
  if (index === -1 || !args[index + 1]) {
    throw new Error("--model-dir is required");
  }
  return path.resolve(args[index + 1]);
}

function main() {
  const modelDir = readModelDir(process.argv.slice(2));
  const sherpaOnnx = require("sherpa-onnx-node");
  const runtime = createSidecarRuntime({ sherpaOnnx, modelDir });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  emit({ type: "ready" });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      runtime.handleMessage(JSON.parse(line));
    } catch (error) {
      emit({ type: "error", message: error.message });
    }
  });
}

module.exports = {
  createRecognizerConfig,
  createSidecarRuntime,
  pcm16leBase64ToFloat32,
  readModelDir,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    emit({ type: "error", message: error.message });
    process.exitCode = 1;
  }
}
