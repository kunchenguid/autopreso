import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { STARTER_ELEMENTS } from "../public/starter-elements.js";

test("POST /api/session/reset restores starter whiteboard and clears agent history", async () => {
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    state.elements = [{ type: "text", id: "scratch", x: 0, y: 0, text: "scratch" }];
    state.agentHistory = [{ role: "user", content: "old turn" }];
    state.latestScreenshot = "data:image/png;base64,old";

    const res = await fetch(`${url}/api/session/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Live canvas resets to blank, not to STARTER_ELEMENTS - the user can draw
    // on it before the first transcript turn fires.
    assert.deepEqual(state.elements, []);
    assert.deepEqual(state.agentHistory, []);
    assert.equal(state.latestScreenshot, undefined);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("session reset broadcasts the starter whiteboard to connected websocket clients", async () => {
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  const wsUrl = url.replace("http:", "ws:") + "/ws";
  const ws = new WebSocket(wsUrl);
  try {
    state.elements = [{ type: "text", id: "scratch", x: 0, y: 0, text: "scratch" }];

    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const initialDeadline = Date.now() + 2000;
    while (Date.now() < initialDeadline && messages.length < 3) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const initialCount = messages.length;

    const res = await fetch(`${url}/api/session/reset`, { method: "POST" });
    assert.equal(res.status, 200);

    const broadcastDeadline = Date.now() + 2000;
    while (Date.now() < broadcastDeadline && messages.length <= initialCount) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const update = messages.slice(initialCount).find((m) => m.type === "whiteboard:update");
    assert.ok(update, "expected whiteboard:update broadcast after reset");
    assert.deepEqual(update.elements, []);
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/session/reset clears transcription vocabulary context", async () => {
  const sessionContextCalls = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      setSessionContext: (ctx) => sessionContextCalls.push(ctx),
      close: () => {},
    }),
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });

  try {
    const startRes = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: [{ type: "text", id: "t1", text: "Kafka consumer group" }],
        stagingScreenshot: "data:image/png;base64,c3RhZ2luZw==",
      }),
    });
    assert.equal(startRes.status, 200);
    assert.deepEqual(sessionContextCalls.at(-1), { keywords: ["Kafka consumer group"] });

    const resetRes = await fetch(`${url}/api/session/reset`, { method: "POST" });
    assert.equal(resetRes.status, 200);

    assert.deepEqual(sessionContextCalls.at(-1), { keywords: [] });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
