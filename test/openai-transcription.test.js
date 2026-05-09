// @ts-nocheck - hand-rolled EventEmitter is used as a fake WebSocket; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createOpenAITranscription } from "../src/openai-transcription.js";

function createMockSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closed = false;
  socket.send = (data) => {
    socket.sent.push(typeof data === "string" ? data : data.toString("utf8"));
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  return socket;
}

test("createOpenAITranscription opens a transcription session with bearer auth", () => {
  const calls = [];
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return createMockSocket();
    },
  });

  transcription.sendAudio("ignored");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "wss://api.openai.com/v1/realtime?intent=transcription");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers["OpenAI-Beta"], undefined);
});

test("createOpenAITranscription configures the session on open and signals ready on update ack", async () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-mini-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  const readyPromise = transcription.ready();
  socket.emit("open");

  const sessionUpdate = JSON.parse(socket.sent[0]);
  assert.equal(sessionUpdate.type, "session.update");
  assert.equal(sessionUpdate.session.type, "transcription");
  assert.equal(sessionUpdate.session.audio.input.format.type, "audio/pcm");
  assert.equal(sessionUpdate.session.audio.input.format.rate, 24000);
  assert.equal(sessionUpdate.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(sessionUpdate.session.audio.input.turn_detection, undefined);

  let ready = false;
  readyPromise.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await readyPromise;
});

test("createOpenAITranscription sends audio frames as input_audio_buffer.append", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("base64audio");
  socket.emit("open");

  const messages = socket.sent.map((line) => JSON.parse(line));
  const audioMessage = messages.find((m) => m.type === "input_audio_buffer.append");
  assert.ok(audioMessage, "audio frame should flush after open");
  assert.equal(audioMessage.audio, "base64audio");
});

test("createOpenAITranscription maps delta and completed events to transcript messages", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    delta: "Hello",
  }));
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Hello world",
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Hello" },
    { type: "transcript:committed", text: "Hello world" },
  ]);
  assert.deepEqual(queued, ["Hello world"]);
});

test("createOpenAITranscription accumulates partial deltas across one utterance", () => {
  const socket = createMockSocket();
  const messages = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    delta: "Hello",
  }));
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    delta: " world",
  }));
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Hello world",
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Hello" },
    { type: "transcript:partial", text: "Hello world" },
    { type: "transcript:committed", text: "Hello world" },
  ]);
});

test("stop() does not commit when nothing was buffered since the last commit", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  socket.emit("open");
  // Stop without any audio sent
  transcription.stop();
  const types = socket.sent.map((line) => JSON.parse(line).type);
  assert.ok(!types.includes("input_audio_buffer.commit"), "should not commit empty buffer");
});

test("stop() does commit when audio has been buffered since the last commit", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  transcription.stop();

  const types = socket.sent.map((line) => JSON.parse(line).type);
  assert.ok(types.includes("input_audio_buffer.commit"), "should commit when audio buffered");
});

test("stop() skips commit if VAD already drained the buffer (transcription.completed)", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "auto-committed",
  }));
  // After VAD-driven completion, manual stop must not commit again
  transcription.stop();

  const commitCount = socket.sent.filter((line) => {
    try { return JSON.parse(line).type === "input_audio_buffer.commit"; } catch { return false; }
  }).length;
  assert.equal(commitCount, 0, "manual commit should be skipped after VAD-driven drain");
});

test("stop() skips commit after server signals input_audio_buffer.committed (VAD commit)", () => {
  // Server VAD commits the buffer before transcription completes. Once we see
  // input_audio_buffer.committed, the server-side buffer is empty even though
  // we're still waiting on the transcription.completed event. A manual commit
  // here would error with input_audio_buffer_commit_empty.
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
  transcription.stop();

  const commitCount = socket.sent.filter((line) => {
    try { return JSON.parse(line).type === "input_audio_buffer.commit"; } catch { return false; }
  }).length;
  assert.equal(commitCount, 0, "manual commit should be skipped after server-side commit");
});

test("suppresses input_audio_buffer_commit_empty error from server", () => {
  // Server VAD discards silent audio, so a manual commit can race with an
  // already-empty buffer. The error is benign and shouldn't surface in the UI.
  const socket = createMockSocket();
  const messages = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "input_audio_buffer_commit_empty",
      message: "Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.",
    },
  }));

  assert.deepEqual(messages, [], "benign empty-commit error should not surface");
});

test("createOpenAITranscription surfaces other server error events", () => {
  const socket = createMockSocket();
  const messages = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "error",
    error: { message: "some other failure" },
  }));

  assert.deepEqual(messages, [
    { type: "error", message: "some other failure" },
  ]);
});

test("setSessionContext stashes a vocabulary prompt and folds it into the session.update on open", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.setSessionContext({ keywords: ["Kafka", "schema registry"] });
  transcription.sendAudio("a");
  socket.emit("open");

  const sessionUpdate = JSON.parse(socket.sent[0]);
  assert.equal(sessionUpdate.type, "session.update");
  const prompt = sessionUpdate.session.audio.input.transcription.prompt;
  assert.ok(typeof prompt === "string" && prompt.length > 0, "expected vocabulary prompt on session.update");
  assert.match(prompt, /Kafka/);
  assert.match(prompt, /schema registry/);
});

test("setSessionContext after the session is configured pushes a follow-up session.update", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  socket.sent.length = 0;

  transcription.setSessionContext({ keywords: ["gRPC", "Avro"] });

  const updates = socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "session.update");
  assert.equal(updates.length, 1, "expected one follow-up session.update with vocabulary prompt");
  const prompt = updates[0].session.audio.input.transcription.prompt;
  assert.match(prompt, /gRPC/);
  assert.match(prompt, /Avro/);
});

test("setSessionContext with empty keywords is a no-op when no prompt was ever set", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  socket.sent.length = 0;

  transcription.setSessionContext({ keywords: [] });
  transcription.setSessionContext({ keywords: null });

  const updates = socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "session.update");
  assert.equal(updates.length, 0, "no session.update expected when there was nothing to clear");
});

test("setSessionContext with empty keywords after a prompt was set clears it server-side", () => {
  const socket = createMockSocket();
  const transcription = createOpenAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: { OPENAI_API_KEY: "sk-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("frame");
  socket.emit("open");
  transcription.setSessionContext({ keywords: ["Kafka"] });
  socket.sent.length = 0;

  transcription.setSessionContext({ keywords: [] });

  const updates = socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "session.update");
  assert.equal(updates.length, 1, "expected one clearing session.update");
  assert.equal(updates[0].session.audio.input.transcription.prompt, "", "prompt should be empty string to clear");
});

test("createOpenAITranscription reports a missing API key without throwing", () => {
  const messages = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { openaiTranscriptionModel: "gpt-4o-transcribe" },
    env: {},
    createWebSocket: () => {
      throw new Error("should not open a socket without an API key");
    },
  });

  assert.doesNotThrow(() => transcription.sendAudio("a"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "error");
  assert.match(messages[0].message, /OPENAI_API_KEY/);
});
