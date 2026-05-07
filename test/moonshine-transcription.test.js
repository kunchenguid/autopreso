import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createMoonshineTranscription,
  moonshinePlatformPackageName,
  resolveMoonshineSidecarPath,
} from "../src/moonshine-transcription.js";

test("moonshinePlatformPackageName supports both macOS binary variants", () => {
  assert.equal(moonshinePlatformPackageName("darwin", "arm64"), "@autopreso/moonshine-darwin-arm64");
  assert.equal(moonshinePlatformPackageName("darwin", "x64"), "@autopreso/moonshine-darwin-x64");
});

test("moonshinePlatformPackageName rejects unsupported platforms", () => {
  assert.throws(
    () => moonshinePlatformPackageName("linux", "x64"),
    /Moonshine local transcription is currently available for macOS arm64 and x64/,
  );
});

test("resolveMoonshineSidecarPath resolves the binary inside the optional package", () => {
  const resolved = resolveMoonshineSidecarPath({
    platform: "darwin",
    arch: "arm64",
    requireResolve: () => "/workspace/node_modules/@autopreso/moonshine-darwin-arm64/package.json",
  });

  assert.equal(resolved, "/workspace/node_modules/@autopreso/moonshine-darwin-arm64/bin/autopreso-moonshine");
});

test("resolveMoonshineSidecarPath prefers an explicit binary override", () => {
  const resolved = resolveMoonshineSidecarPath({
    env: { AUTOPRESO_MOONSHINE_BIN: "/tmp/dev/autopreso-moonshine" },
    platform: "linux",
    arch: "x64",
    requireResolve: () => {
      throw new Error("should not resolve optional package");
    },
  });

  assert.equal(resolved, "/tmp/dev/autopreso-moonshine");
});

test("createMoonshineTranscription maps sidecar transcript events and sends audio JSONL", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites = [];
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write: (value) => stdinWrites.push(value),
    end: () => stdinWrites.push("<end>"),
  };
  child.kill = () => child.emit("close", 0);

  const messages = [];
  const queued = [];
  const transcription = createMoonshineTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: (text) => queued.push(text),
    options: { moonshineModel: "medium" },
    spawnProcess: (binary, args) => {
      assert.equal(binary, "/tmp/autopreso-moonshine");
      assert.deepEqual(args, ["--model", "medium", "--language", "en"]);
      return child;
    },
    resolveSidecarPath: () => "/tmp/autopreso-moonshine",
  });

  transcription.sendAudio("abc123");
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"Hello"}\n'));
  stdout.emit("data", Buffer.from('{"type":"transcript:committed","text":"Hello world"}\n'));

  assert.deepEqual(JSON.parse(stdinWrites[0]), {
    type: "audio",
    encoding: "pcm16le",
    sampleRate: 24000,
    audio: "abc123",
  });
  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Hello" },
    { type: "transcript:committed", text: "Hello world" },
  ]);
  assert.deepEqual(queued, ["Hello world"]);
});

test("createMoonshineTranscription can prewarm the sidecar before audio arrives", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => {}, end: () => {} };
  child.kill = () => child.emit("close", 0);

  const transcription = createMoonshineTranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { moonshineModel: "medium" },
    spawnProcess: () => child,
    resolveSidecarPath: () => "/tmp/autopreso-moonshine",
  });

  let ready = false;
  const readyPromise = transcription.ready().then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);

  stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  await readyPromise;

  assert.equal(ready, true);
});

test("createMoonshineTranscription keeps the warmed process alive when recording stops", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites = [];
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write: (value) => stdinWrites.push(value),
    end: () => stdinWrites.push("<end>"),
  };
  child.kill = () => stdinWrites.push("<kill>");

  const transcription = createMoonshineTranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { moonshineModel: "medium" },
    spawnProcess: () => child,
    resolveSidecarPath: () => "/tmp/autopreso-moonshine",
  });

  transcription.sendAudio("abc123");
  transcription.stop();

  assert.deepEqual(JSON.parse(stdinWrites[1]), { type: "stop" });
  assert.equal(stdinWrites.includes("<kill>"), false);
});

test("createMoonshineTranscription reports sidecar resolution failures without throwing", () => {
  const messages = [];
  const transcription = createMoonshineTranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: () => {},
    options: { moonshineModel: "medium" },
    resolveSidecarPath: () => {
      throw new Error("Cannot find Moonshine sidecar package");
    },
  });

  assert.doesNotThrow(() => transcription.sendAudio("abc123"));
  assert.deepEqual(messages, [{ type: "error", message: "Cannot find Moonshine sidecar package" }]);
});
