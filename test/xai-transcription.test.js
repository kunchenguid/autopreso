// @ts-nocheck - hand-rolled EventEmitter is used as a fake WebSocket; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createXAITranscription } from "../src/xai-transcription.js";

function createMockSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closed = false;
  socket.send = (data) => {
    socket.sent.push(data);
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  return socket;
}

test("createXAITranscription opens a streaming STT websocket with bearer auth and language", async () => {
  const socket = createMockSocket();
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    log: { debug: () => {} },
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  const readyPromise = transcription.ready();
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "wss://api.x.ai/v1/stt");
  assert.equal(url.searchParams.get("sample_rate"), "24000");
  assert.equal(url.searchParams.get("encoding"), "pcm");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("language"), "fr");
  assert.equal(url.searchParams.get("smart_turn_timeout"), "1200");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xai-test");
});

test("createXAITranscription lets xAI smart turn timeout be tuned", async () => {
  const socket = createMockSocket();
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr", xaiSttSmartTurnTimeoutMs: 800 },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  const readyPromise = transcription.ready();
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("smart_turn_timeout"), "800");
});

test("createXAITranscription sends raw PCM bytes instead of base64 text frames", () => {
  const socket = createMockSocket();
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio(Buffer.from([1, 2, 3, 4]).toString("base64"));
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));

  assert.equal(socket.sent.length, 1);
  assert.ok(Buffer.isBuffer(socket.sent[0]));
  assert.deepEqual([...socket.sent[0]], [1, 2, 3, 4]);
});

test("createXAITranscription maps partial and final speech-final events into app transcripts", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour",
    is_final: false,
    speech_final: false,
  }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour tout le monde",
    is_final: true,
    speech_final: true,
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Bonjour" },
    { type: "transcript:partial", text: "Bonjour tout le monde" },
    { type: "transcript:committed", text: "Bonjour tout le monde" },
  ]);
  assert.deepEqual(queued, ["Bonjour tout le monde"]);
});

test("createXAITranscription does not commit xAI chunk-final partials until speech-final", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour",
    is_final: true,
    speech_final: false,
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Bonjour" },
  ]);
  assert.deepEqual(queued, []);
});

test("createXAITranscription stop sends audio.done and flushes the last partial once", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "final words",
    is_final: false,
    speech_final: false,
  }));
  transcription.stop();
  transcription.stop();

  assert.deepEqual(
    socket.sent.filter((item) => typeof item === "string").map((item) => JSON.parse(item)),
    [{ type: "audio.done" }],
  );
  assert.deepEqual(queued, ["final words"]);
  assert.deepEqual(messages.at(-1), { type: "transcript:committed", text: "final words" });
});

test("createXAITranscription sends session keywords as xAI keyterms and reconnects when they change", () => {
  const sockets = [];
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    log: { debug: () => {} },
    createWebSocket: (url, protocols, init) => {
      const socket = createMockSocket();
      sockets.push(socket);
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  transcription.setSessionContext({ keywords: ["Kafka", "", "  Avro  "] });
  transcription.sendAudio(Buffer.from([1]).toString("base64"));

  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("keyterm"), ["Kafka", "Avro"]);

  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ type: "transcript.created" }));
  transcription.setSessionContext({ keywords: ["Kafka", "gRPC"] });
  transcription.sendAudio(Buffer.from([2]).toString("base64"));

  assert.equal(sockets[0].closed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(new URL(calls[1].url).searchParams.getAll("keyterm"), ["Kafka", "gRPC"]);
});

test("createXAITranscription opens a fresh websocket for audio after stop", () => {
  const sockets = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => {
      const socket = createMockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  transcription.sendAudio(Buffer.from([1]).toString("base64"));
  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ type: "transcript.created" }));
  transcription.stop();
  transcription.sendAudio(Buffer.from([2]).toString("base64"));
  sockets[1].emit("open");
  sockets[1].emit("message", JSON.stringify({ type: "transcript.created" }));

  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  assert.deepEqual([...sockets[1].sent[0]], [2]);
});

test("createXAITranscription waits for transcript.created before flushing pending audio", async () => {
  const socket = createMockSocket();
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  const readyPromise = transcription.ready();
  transcription.sendAudio(Buffer.from([9]).toString("base64"));
  socket.emit("open");

  assert.equal(socket.sent.length, 0);

  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  assert.equal(socket.sent.length, 1);
  assert.deepEqual([...socket.sent[0]], [9]);
});

test("createXAITranscription reports missing API key without throwing from sendAudio", () => {
  const messages = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: {},
  });

  transcription.sendAudio("a");

  assert.deepEqual(messages, [
    { type: "error", message: "XAI_API_KEY is required for the xAI transcription provider." },
  ]);
});
