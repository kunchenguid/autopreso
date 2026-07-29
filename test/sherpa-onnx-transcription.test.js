import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createSherpaOnnxTranscription,
  resolveSherpaOnnxLibraryDir,
  sherpaOnnxPlatformPackageName,
} from "../src/sherpa-onnx-transcription.js";

test("sherpaOnnxPlatformPackageName supports native addon targets", () => {
  assert.equal(sherpaOnnxPlatformPackageName("darwin", "arm64"), "sherpa-onnx-darwin-arm64");
  assert.equal(sherpaOnnxPlatformPackageName("darwin", "x64"), "sherpa-onnx-darwin-x64");
  assert.equal(sherpaOnnxPlatformPackageName("linux", "arm64"), "sherpa-onnx-linux-arm64");
  assert.equal(sherpaOnnxPlatformPackageName("linux", "x64"), "sherpa-onnx-linux-x64");
  assert.equal(sherpaOnnxPlatformPackageName("win32", "x64"), "sherpa-onnx-win-x64");
});

test("sherpaOnnxPlatformPackageName rejects unsupported targets", () => {
  assert.throws(
    () => sherpaOnnxPlatformPackageName("freebsd", "x64"),
    /Sherpa-ONNX local transcription is not available for freebsd x64/,
  );
});

test("resolveSherpaOnnxLibraryDir locates the native runtime package", () => {
  const resolved = resolveSherpaOnnxLibraryDir({
    platform: "darwin",
    arch: "arm64",
    requireResolve: () => "/workspace/node_modules/sherpa-onnx-darwin-arm64/package.json",
  });

  assert.equal(resolved, "/workspace/node_modules/sherpa-onnx-darwin-arm64");
});

test("createSherpaOnnxTranscription maps bilingual sidecar events and audio JSONL", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites = [];
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write: (value) => stdinWrites.push(value),
    end: () => stdinWrites.push("<end>"),
  };
  child.kill = () => child.emit("close", 0);

  const messages = [];
  const queued = [];
  const transcription = createSherpaOnnxTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: (text) => queued.push(text),
    options: {
      env: { DYLD_LIBRARY_PATH: "/existing/lib" },
      sherpaOnnxModel: "zipformer-bilingual-zh-en",
    },
    ensureModel: async () => "/tmp/sherpa-model",
    resolveLibraryDir: () => "/tmp/sherpa-runtime",
    resolveSidecarPath: () => "/tmp/sherpa-onnx-sidecar.cjs",
    spawnProcess: (binary, args, spawnOptions) => {
      assert.equal(binary, process.execPath);
      assert.deepEqual(args, [
        "/tmp/sherpa-onnx-sidecar.cjs",
        "--model-dir",
        "/tmp/sherpa-model",
      ]);
      assert.equal(
        spawnOptions.env.DYLD_LIBRARY_PATH,
        `/tmp/sherpa-runtime:${"/existing/lib"}`,
      );
      return child;
    },
  });

  const ready = transcription.ready();
  await new Promise((resolve) => setImmediate(resolve));
  stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await ready;

  transcription.sendAudio("abc123");
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"你好 Auto"}\n'));
  stdout.emit("data", Buffer.from('{"type":"transcript:committed","text":"你好 Auto Preso"}\n'));

  assert.deepEqual(JSON.parse(stdinWrites[0]), {
    type: "audio",
    encoding: "pcm16le",
    sampleRate: 24000,
    audio: "abc123",
  });
  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "你好 Auto" },
    { type: "transcript:committed", text: "你好 Auto Preso" },
  ]);
  assert.deepEqual(queued, ["你好 Auto Preso"]);
});

test("createSherpaOnnxTranscription keeps the warmed process alive when recording stops", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites = [];
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write: (value) => stdinWrites.push(value),
    end: () => stdinWrites.push("<end>"),
  };
  child.kill = () => stdinWrites.push("<kill>");

  const transcription = createSherpaOnnxTranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { env: {}, sherpaOnnxModel: "zipformer-bilingual-zh-en" },
    ensureModel: async () => "/tmp/sherpa-model",
    resolveLibraryDir: () => "/tmp/sherpa-runtime",
    resolveSidecarPath: () => "/tmp/sherpa-onnx-sidecar.cjs",
    spawnProcess: () => child,
  });

  const ready = transcription.ready();
  await new Promise((resolve) => setImmediate(resolve));
  stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await ready;
  transcription.stop();

  assert.deepEqual(JSON.parse(stdinWrites[0]), { type: "stop" });
  assert.equal(stdinWrites.includes("<kill>"), false);
});

test("createSherpaOnnxTranscription reports crashes and preserves stop ordering during recovery", async () => {
  const children = [];
  const messages = [];
  const transcription = createSherpaOnnxTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: () => {},
    options: { env: {}, sherpaOnnxModel: "zipformer-bilingual-zh-en" },
    ensureModel: async () => "/tmp/sherpa-model",
    resolveLibraryDir: () => "/tmp/sherpa-runtime",
    resolveSidecarPath: () => "/tmp/sherpa-onnx-sidecar.cjs",
    spawnProcess: () => {
      const child = /** @type {any} */ (new EventEmitter());
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdinWrites = [];
      child.stdin = {
        write: (value) => child.stdinWrites.push(value),
        end: () => {},
      };
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });

  const ready = transcription.ready();
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await ready;

  children[0].emit("close", 17);
  assert.deepEqual(messages, [{
    type: "error",
    message: "Sherpa-ONNX sidecar exited unexpectedly (code 17).",
  }]);

  transcription.sendAudio("after-crash");
  transcription.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  children[1].stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    children[1].stdinWrites.map((write) => JSON.parse(write)),
    [
      {
        type: "audio",
        encoding: "pcm16le",
        sampleRate: 24000,
        audio: "after-crash",
      },
      { type: "stop" },
    ],
  );
});

test("createSherpaOnnxTranscription recovers from sidecar stdin errors", async () => {
  const children = [];
  const messages = [];
  const transcription = createSherpaOnnxTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: () => {},
    options: { env: {}, sherpaOnnxModel: "zipformer-bilingual-zh-en" },
    ensureModel: async () => "/tmp/sherpa-model",
    resolveLibraryDir: () => "/tmp/sherpa-runtime",
    resolveSidecarPath: () => "/tmp/sherpa-onnx-sidecar.cjs",
    spawnProcess: () => {
      const child = /** @type {any} */ (new EventEmitter());
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdinWrites = [];
      child.stdin.write = (value) => child.stdinWrites.push(value);
      child.stdin.end = () => {};
      child.kill = () => {
        child.killed = true;
        child.emit("close", null);
      };
      children.push(child);
      return child;
    },
  });

  const ready = transcription.ready();
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await ready;

  children[0].stdin.emit("error", new Error("write EPIPE"));

  assert.equal(children[0].killed, true);
  assert.deepEqual(messages, [{ type: "error", message: "write EPIPE" }]);

  transcription.sendAudio("after-pipe-error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  children[1].stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(JSON.parse(children[1].stdinWrites[0]).audio, "after-pipe-error");
});

test("createSherpaOnnxTranscription reports model preparation failures", async () => {
  const messages = [];
  const transcription = createSherpaOnnxTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: () => {},
    options: { env: {}, sherpaOnnxModel: "zipformer-bilingual-zh-en" },
    ensureModel: async () => {
      throw new Error("model download failed");
    },
  });

  await assert.rejects(transcription.ready(), /model download failed/);
  assert.deepEqual(messages, [{ type: "error", message: "model download failed" }]);
});
