import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createRecognizerConfig,
  createSidecarRuntime,
  pcm16leBase64ToFloat32,
} = require("../src/sherpa-onnx-sidecar.cjs");

test("pcm16leBase64ToFloat32 converts browser PCM without losing sign", () => {
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(0, 2);
  pcm.writeInt16LE(32767, 4);

  const samples = pcm16leBase64ToFloat32(pcm.toString("base64"));

  assert.equal(samples.length, 3);
  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.ok(samples[2] > 0.999);
});

test("createRecognizerConfig selects the bilingual streaming Zipformer files", () => {
  const modelDir = "/models/zipformer-bilingual";
  const config = createRecognizerConfig(modelDir);

  assert.equal(config.featConfig.sampleRate, 16000);
  assert.equal(
    config.modelConfig.transducer.encoder,
    path.join(modelDir, "encoder-epoch-99-avg-1.int8.onnx"),
  );
  assert.equal(
    config.modelConfig.transducer.decoder,
    path.join(modelDir, "decoder-epoch-99-avg-1.onnx"),
  );
  assert.equal(
    config.modelConfig.transducer.joiner,
    path.join(modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
  );
  assert.equal(config.enableEndpoint, true);
});

test("createSidecarRuntime emits Chinese-English mixed partial and committed text", () => {
  const accepted = [];
  const emitted = [];
  let ready = true;
  let resetCount = 0;

  const stream = {
    acceptWaveform: (waveform) => accepted.push(waveform),
    inputFinished: () => {},
  };
  class OnlineRecognizer {
    createStream() {
      return stream;
    }
    isReady() {
      const value = ready;
      ready = false;
      return value;
    }
    decode() {}
    getResult() {
      return { text: "这是 Auto Preso demo" };
    }
    isEndpoint() {
      return true;
    }
    reset() {
      resetCount += 1;
    }
  }

  const runtime = createSidecarRuntime({
    sherpaOnnx: { OnlineRecognizer },
    modelDir: "/models/zipformer-bilingual",
    emitMessage: (message) => emitted.push(message),
  });
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);

  runtime.handleMessage({
    type: "audio",
    sampleRate: 24000,
    audio: pcm.toString("base64"),
  });

  assert.equal(accepted[0].sampleRate, 24000);
  assert.equal(accepted[0].samples.length, 2);
  assert.deepEqual(emitted, [
    { type: "transcript:partial", text: "这是 Auto Preso demo" },
    { type: "transcript:committed", text: "这是 Auto Preso demo" },
  ]);
  assert.equal(resetCount, 1);
});
