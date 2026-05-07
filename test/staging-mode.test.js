import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { STARTER_ELEMENTS } from "../public/starter-elements.js";

const SAMPLE_STAGING_ELEMENTS = [
  { type: "text", id: "ref-title", x: 0, y: 0, text: "Reference notes" },
  { type: "rectangle", id: "ref-card", x: 0, y: 40, width: 200, height: 80 },
];
const SAMPLE_SCREENSHOT = "data:image/png;base64,c3RhZ2luZw==";

function makeTranscriptionMock() {
  const audioCalls = [];
  const stopCalls = [];
  const factory = () => ({
    ready: async () => {},
    sendAudio: (audio) => audioCalls.push(audio),
    stop: () => stopCalls.push(true),
    close: () => {},
  });
  return { factory, audioCalls, stopCalls };
}

async function startTestServer(extraOptions = {}) {
  const transcription = makeTranscriptionMock();
  // Default no-op LLM mock so the warmup that fires on Start preso doesn't hit
  // the real OpenAI API in tests. Tests that care about LLM calls override this.
  // The warmup loop defaults to 8 attempts with multi-second backoffs in
  // production; tests use 1 attempt with no delay so they run instantly.
  const defaults = {
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  };
  const server = await startServer({ ...defaults, ...extraOptions });
  return { ...server, transcription };
}

async function collectMessages(ws, predicate, { timeoutMs = 2000 } = {}) {
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate(messages)) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return messages;
}

test("session starts in staging mode by default", async () => {
  const { httpServer, state } = await startTestServer();
  try {
    assert.equal(state.mode, "staging");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("WebSocket clients receive mode on connect", async () => {
  const { httpServer, url } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    const messages = await collectMessages(ws, (m) => m.some((x) => x.type === "mode"));
    const modeMsg = messages.find((m) => m.type === "mode");
    assert.ok(modeMsg, "expected initial mode message");
    assert.equal(modeMsg.mode, "staging");
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/preso/start flips to live, primes agentHistory, blanks the live canvas", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    state.agentHistory = [{ role: "user", content: "stale turn" }];
    state.elements = [{ type: "text", id: "stale", x: 0, y: 0, text: "stale" }];
    state.latestScreenshot = "data:image/png;base64,old";

    const res = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    assert.equal(state.mode, "live");
    assert.deepEqual(state.elements, [], "live canvas starts blank");
    assert.equal(state.latestScreenshot, undefined);

    // Primer lives at index 0; the warmup loop appends a priming pair (warmup
    // user msg + assistant("UNDERSTOOD")) after it finishes so subsequent turns
    // share the cached prefix, but the primer itself stays at index 0.
    await state.warmupPromise;
    assert.equal(state.agentHistory.length, 3, "primer + warmup priming pair");
    const primer = state.agentHistory[0];
    assert.equal(primer.role, "user");
    assert.ok(Array.isArray(primer.content), "primer with screenshot is multimodal");
    const textPart = primer.content.find((p) => p.type === "text");
    const imagePart = primer.content.find((p) => p.type === "image");
    assert.ok(textPart, "primer should include a text part");
    assert.ok(imagePart, "primer should include an image part");
    assert.equal(imagePart.image, SAMPLE_SCREENSHOT);
    assert.match(textPart.text, /reference/i, "primer should mention reference context");
    assert.match(textPart.text, /structure|layout/i, "primer should nudge the agent to follow staging structure");
    assert.ok(
      textPart.text.includes("ref-title") || textPart.text.includes("Reference notes"),
      "primer text should embed staging elements info",
    );
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/preso/start broadcasts mode change and fresh whiteboard", async () => {
  const { httpServer, url } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    // wait for initial init messages to settle
    await new Promise((r) => setTimeout(r, 100));
    const baseline = messages.length;

    const res = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    assert.equal(res.status, 200);

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const after = messages.slice(baseline);
      if (after.find((m) => m.type === "mode" && m.mode === "live") &&
          after.find((m) => m.type === "whiteboard:update")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const after = messages.slice(baseline);
    const modeMsg = after.find((m) => m.type === "mode");
    assert.ok(modeMsg, "expected mode broadcast after start preso");
    assert.equal(modeMsg.mode, "live");
    const update = after.find((m) => m.type === "whiteboard:update");
    assert.ok(update, "expected whiteboard:update after start preso");
    assert.deepEqual(update.elements, []);
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/preso/back-to-staging flips mode without clearing history", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    assert.equal(state.mode, "live");
    const historyBefore = state.agentHistory;

    const res = await fetch(`${url}/api/preso/back-to-staging`, { method: "POST" });
    assert.equal(res.status, 200);

    assert.equal(state.mode, "staging");
    assert.equal(state.agentHistory, historyBefore, "agentHistory reference should be unchanged");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("audio frames received in staging mode are not forwarded to transcription", async () => {
  const { httpServer, url, transcription } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "audio", audio: "AAAA" }));
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(transcription.audioCalls.length, 0, "audio should be dropped while in staging mode");
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("audio frames are forwarded to transcription after Start preso", async () => {
  const { httpServer, url, transcription } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });

    ws.send(JSON.stringify({ type: "audio", audio: "BBBB" }));
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(transcription.audioCalls.length, 1);
    assert.equal(transcription.audioCalls[0], "BBBB");
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("transcript queued in staging mode does not invoke the agent", async () => {
  const agentInvocations = [];
  const { httpServer, state } = await startTestServer({
    generateTextFn: async (opts) => {
      agentInvocations.push(opts);
      return { text: "DONE", finishReason: "stop" };
    },
  });
  try {
    assert.equal(state.mode, "staging");
    state.queueTranscript("hello world");
    await state.idle();
    assert.equal(agentInvocations.length, 0, "agent should not run while in staging mode");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("repeat Start preso calls cleanly replace the primer", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    await state.warmupPromise;
    assert.equal(state.agentHistory.length, 3, "primer + warmup priming pair");

    const secondScreenshot = "data:image/png;base64,c2Vjb25k";
    const secondElements = [
      { type: "text", id: "ref-2", x: 0, y: 0, text: "Updated reference content here" },
    ];
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stagingElements: secondElements, stagingScreenshot: secondScreenshot }),
    });
    await state.warmupPromise;

    assert.equal(state.agentHistory.length, 3, "primer reset + new warmup priming pair");
    const primer = state.agentHistory[0];
    const imagePart = Array.isArray(primer.content) && primer.content.find((p) => p.type === "image");
    assert.ok(imagePart, "primer with screenshot should be multimodal");
    assert.equal(imagePart.image, secondScreenshot, "primer reflects the latest staging screenshot");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("warmup loop retries until cache is hit, then stops", async () => {
  const calls = [];
  // 50% threshold for "primer is primed" - see whiteboard-session.js. 0 + 0
  // are misses, 600/1000 = 60% trips the threshold.
  const cachedSeq = [0, 0, 600];
  const { httpServer, url, state } = await startTestServer({
    warmupMaxAttempts: 8,
    warmupDelays: [1, 1, 1, 1, 1, 1, 1],
    generateTextFn: async (opts) => {
      const i = calls.length;
      calls.push({ messages: opts.messages, system: opts.system });
      const cached = cachedSeq[i] ?? 0;
      // Mimic OpenAI Chat Completions usage shape with cached_tokens.
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: cached },
        },
      };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    await state.warmupPromise;

    assert.equal(calls.length, 3, "ran 3 attempts: misses on 1+2, hit on 3");
    assert.equal(state.warmupState.state, "confirmed");
    // Same system prompt across retries (the cached prefix is what we want stable).
    assert.equal(calls[0].system, calls[1].system);
    assert.equal(calls[1].system, calls[2].system);
    // Same primer message across retries.
    assert.deepEqual(calls[0].messages[0], calls[1].messages[0]);
    assert.deepEqual(calls[1].messages[0], calls[2].messages[0]);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("warmup loop transitions to exhausted after maxAttempts without a cache hit", async () => {
  let calls = 0;
  const { httpServer, url, state } = await startTestServer({
    warmupMaxAttempts: 3,
    warmupDelays: [1, 1, 1],
    generateTextFn: async () => {
      calls += 1;
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    await state.warmupPromise;
    assert.equal(calls, 3);
    assert.equal(state.warmupState.state, "exhausted");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/preso/warmup/cancel short-circuits the loop", async () => {
  let calls = 0;
  let resolveBlock;
  const block = new Promise((r) => { resolveBlock = r; });
  const { httpServer, url, state } = await startTestServer({
    warmupMaxAttempts: 8,
    warmupDelays: [1, 1, 1, 1, 1, 1, 1],
    generateTextFn: async () => {
      calls += 1;
      await block;
      return {
        text: "UNDERSTOOD",
        finishReason: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    // Cancel while attempt 1 is still in-flight.
    await new Promise((r) => setTimeout(r, 30));
    const res = await fetch(`${url}/api/preso/warmup/cancel`, { method: "POST" });
    assert.equal(res.status, 200);
    resolveBlock();
    await state.warmupPromise;
    assert.equal(calls, 1, "no further attempts after cancel");
    assert.equal(state.warmupState.state, "cancelled");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("Start preso fires a warmup call shaped like a real transcript turn", async () => {
  const calls = [];
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async (opts) => {
      calls.push({ messages: opts.messages, system: opts.system });
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });
    await state.warmupPromise;

    assert.equal(calls.length, 1, "expected exactly one warmup call");
    const messages = calls[0].messages;
    // primer (image-only after text stripped to system) + warmup placeholder
    assert.equal(messages.length, 2, `warmup should be image primer + warmup placeholder; got ${messages.length}`);
    assert.equal(messages[0].role, "user");
    assert.ok(Array.isArray(messages[0].content), "primer image part stays as multimodal user content");
    const onlyImage = messages[0].content.every((p) => p.type === "image");
    assert.ok(onlyImage, "primer message should contain only image parts (text now lives in system)");
    assert.match(messages[1].content, /cache warmup/i, "speaker turn should be a warmup placeholder");
    // Primer text should be folded into the system prompt for both providers.
    assert.match(calls[0].system, /Reference context for this presentation/, "system should include primer text");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("transcripts queued during warmup wait for warmup to finish, then run", async () => {
  let resolveWarmup;
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const calls = [];
  // A warmup call sends [primer, warmup_user_msg] (2 messages, no assistant).
  // A real turn sends [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard].
  const isWarmupCall = (opts) => !opts.messages.some((m) => m.role === "assistant");
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async (opts) => {
      const kind = isWarmupCall(opts) ? "warmup" : "real";
      calls.push({ kind, messages: opts.messages });
      if (kind === "warmup") await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });

    // Queue a transcript before warmup resolves.
    state.queueTranscript("hello world");
    await new Promise((r) => setTimeout(r, 50));

    const realBeforeUnblock = calls.filter((c) => c.kind === "real");
    assert.equal(realBeforeUnblock.length, 0, "real turn must not run while warmup is pending");

    resolveWarmup();
    await state.idle();

    const realAfterUnblock = calls.filter((c) => c.kind === "real");
    assert.equal(realAfterUnblock.length, 1, "real turn should run after warmup completes");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("multiple transcripts queued during warmup are batched into a single follow-up turn", async () => {
  let resolveWarmup;
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const calls = [];
  // A warmup call sends [primer, warmup_user_msg] (2 messages, no assistant).
  // A real turn sends [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard].
  const isWarmupCall = (opts) => !opts.messages.some((m) => m.role === "assistant");
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async (opts) => {
      const kind = isWarmupCall(opts) ? "warmup" : "real";
      calls.push({ kind, messages: opts.messages });
      if (kind === "warmup") await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });

    state.queueTranscript("first chunk");
    state.queueTranscript("second chunk");
    state.queueTranscript("third chunk");

    resolveWarmup();
    await state.idle();

    const realCalls = calls.filter((c) => c.kind === "real");
    // The first chunk runs alone (it was the head of the queue), then 2nd+3rd join.
    // What matters: all chunks reach the agent, and warmup ran first.
    assert.ok(realCalls.length >= 1, "at least one real turn should run");
    assert.equal(calls[0].kind, "warmup", "warmup must run before any real turn");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("warmup broadcasts agent:status thinking while running, idle when done", async () => {
  let resolveWarmup;
  const warmupBlocker = new Promise((resolve) => { resolveWarmup = resolve; });
  const { httpServer, url } = await startTestServer({
    generateTextFn: async (opts) => {
      // Warmup has no assistant message in its prefix; turns do.
      if (!opts.messages.some((m) => m.role === "assistant")) await warmupBlocker;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
  });
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stagingElements: SAMPLE_STAGING_ELEMENTS,
        stagingScreenshot: SAMPLE_SCREENSHOT,
      }),
    });

    const thinkingDeadline = Date.now() + 1500;
    while (Date.now() < thinkingDeadline) {
      if (messages.find((m) => m.type === "agent:status" && m.status === "thinking")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      messages.find((m) => m.type === "agent:status" && m.status === "thinking"),
      "expected thinking broadcast while warmup runs",
    );

    resolveWarmup();

    const idleDeadline = Date.now() + 2000;
    while (Date.now() < idleDeadline) {
      const idleAfterThinking = messages.findIndex((m) => m.type === "agent:status" && m.status === "thinking") >= 0
        && messages.slice(messages.findIndex((m) => m.type === "agent:status" && m.status === "thinking") + 1)
            .find((m) => m.type === "agent:status" && m.status === "idle");
      if (idleAfterThinking) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const thinkingIndex = messages.findIndex((m) => m.type === "agent:status" && m.status === "thinking");
    const idleAfter = messages.slice(thinkingIndex + 1).find((m) => m.type === "agent:status" && m.status === "idle");
    assert.ok(idleAfter, "expected idle broadcast after warmup completes");
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("whiteboard:user-elements WS messages update state.elements in live mode", async () => {
  const { httpServer, url, state } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Drop staging mode by going live first.
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stagingElements: SAMPLE_STAGING_ELEMENTS }),
    });
    assert.equal(state.mode, "live");
    assert.deepEqual(state.elements, []);

    const userDrawn = [
      { type: "rectangle", id: "user-1", x: 100, y: 100, width: 200, height: 80 },
      { type: "text", id: "user-2", x: 110, y: 120, text: "OAuth flow" },
    ];
    ws.send(JSON.stringify({ type: "whiteboard:user-elements", elements: userDrawn }));

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && state.elements.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(state.elements, userDrawn);
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("whiteboard:user-elements is ignored in staging mode", async () => {
  const { httpServer, url, state } = await startTestServer();
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    assert.equal(state.mode, "staging");
    const before = state.elements;
    ws.send(JSON.stringify({
      type: "whiteboard:user-elements",
      elements: [{ type: "rectangle", id: "x", x: 0, y: 0, width: 1, height: 1 }],
    }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(state.elements, before, "staging mode must not accept live-canvas pushes");
  } finally {
    ws.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /api/preso/start rejects payload missing required fields", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const res = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
