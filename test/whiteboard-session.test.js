import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardSession, isTrivialTranscript } from "../src/whiteboard-session.js";

test("isTrivialTranscript skips fillers and ultra-short utterances", () => {
  // Fillers
  for (const filler of ["uh", "um", "yeah", "ok", "right", "hmm", "well"]) {
    assert.equal(isTrivialTranscript(filler), true, `should skip "${filler}"`);
  }
  // Punctuation around fillers
  assert.equal(isTrivialTranscript("Uh."), true);
  assert.equal(isTrivialTranscript("yeah!"), true);
  // 2-3 word filler chains
  assert.equal(isTrivialTranscript("uh well"), true);
  assert.equal(isTrivialTranscript("yeah ok"), true);
  // Empty / whitespace
  assert.equal(isTrivialTranscript(""), true);
  assert.equal(isTrivialTranscript("   "), true);
  assert.equal(isTrivialTranscript(null), true);
});

test("isTrivialTranscript keeps real content", () => {
  assert.equal(isTrivialTranscript("OpenAI just released a new model today"), false);
  assert.equal(isTrivialTranscript("Yes, the answer is 42"), false, "filler word in real sentence is fine");
  assert.equal(isTrivialTranscript("Stop the recording"), false);
  assert.equal(isTrivialTranscript("Done!"), false, "single 4-letter command is real content");
});

test("whiteboard session batches consecutive transcript chunks into one turn", async () => {
  const turns = [];
  const session = createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async ({ transcript }) => {
      turns.push(transcript);
    },
  });
  session.mode = "live";

  session.queueTranscript("first");
  session.queueTranscript("second");
  session.queueTranscript("third");

  await session.idle();

  // All three chunks should batch into a single turn (debounce coalesces them).
  assert.deepEqual(turns, ["first\nsecond\nthird"]);
});

test("whiteboard session stores latest browser screenshot for later agent turns", async () => {
  const screenshots = [];
  const session = createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async ({ state }) => screenshots.push(state.latestScreenshot),
  });
  session.mode = "live";

  session.updateLatestScreenshot("data:image/png;base64,latest");
  await session.queueTranscript("inspect current canvas");
  await session.idle();

  assert.deepEqual(screenshots, ["data:image/png;base64,latest"]);
});

function makeWarmupSession() {
  const broadcasts = [];
  const session = createWhiteboardSession({
    options: {},
    wss: {
      clients: new Set([
        { readyState: 1, send: (m) => broadcasts.push(JSON.parse(m)) },
      ]),
    },
    runAgent: async () => {},
  });
  return { session, broadcasts };
}

test("startWarmupLoop confirms when cache hit reaches the 50% threshold", async () => {
  const { session, broadcasts } = makeWarmupSession();
  let calls = 0;
  await session.startWarmupLoop({
    runOnce: async () => {
      calls += 1;
      return { usage: { input: 1000, cached: 500, output: 5 } };
    },
    delays: [10, 10, 10, 10, 10, 10, 10],
  });

  assert.equal(calls, 1, "stops after first confirmed attempt");
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  const states = warmupBroadcasts.map((m) => m.state);
  assert.deepEqual(states, ["running", "confirmed"]);
  assert.equal(warmupBroadcasts.at(-1).attempt, 1);
  assert.equal(warmupBroadcasts.at(-1).maxAttempts, 8);
});

test("startWarmupLoop keeps retrying when cache hit is below 50% (only static system+tools cached)", async () => {
  const { session, broadcasts } = makeWarmupSession();
  // 200/1000 = 20%: looks like only static system+tools matched, primer prefix
  // is not yet primed. Loop must keep going.
  const cachedSeq = [0, 200, 200, 600];
  let calls = 0;
  await session.startWarmupLoop({
    runOnce: async () => {
      const cached = cachedSeq[calls] ?? 0;
      calls += 1;
      return { usage: { input: 1000, cached, output: 5 } };
    },
    delays: [1, 1, 1, 1, 1, 1, 1],
  });

  assert.equal(calls, 4, "ran 4 attempts before crossing the 50% threshold");
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  assert.equal(warmupBroadcasts.at(-1).state, "confirmed");
  assert.equal(warmupBroadcasts.at(-1).attempt, 4);
});

test("startWarmupLoop transitions to exhausted after 8 unsuccessful attempts", async () => {
  const { session, broadcasts } = makeWarmupSession();
  let calls = 0;
  await session.startWarmupLoop({
    runOnce: async () => {
      calls += 1;
      return { usage: { input: 1000, cached: 0, output: 5 } };
    },
    delays: [1, 1, 1, 1, 1, 1, 1],
  });

  assert.equal(calls, 8, "ran the full 8 attempts");
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  assert.equal(warmupBroadcasts.at(-1).state, "exhausted");
  assert.equal(warmupBroadcasts.at(-1).attempt, 8);
});

test("cancelWarmup short-circuits the loop and broadcasts cancelled", async () => {
  const { session, broadcasts } = makeWarmupSession();
  let calls = 0;
  const loopPromise = session.startWarmupLoop({
    runOnce: async () => {
      calls += 1;
      // Cancel mid-flight after the first attempt starts.
      session.cancelWarmup();
      return { usage: { input: 1000, cached: 0, output: 5 } };
    },
    delays: [50, 50, 50, 50, 50, 50, 50],
  });

  await loopPromise;
  assert.equal(calls, 1, "no more attempts after cancel");
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  assert.equal(warmupBroadcasts.at(-1).state, "cancelled");
});

test("backToStaging cancels any in-flight warmup", async () => {
  const { session, broadcasts } = makeWarmupSession();
  let calls = 0;
  const loopPromise = session.startWarmupLoop({
    runOnce: async () => {
      calls += 1;
      session.backToStaging();
      return { usage: { input: 1000, cached: 0, output: 5 } };
    },
    delays: [50, 50, 50, 50, 50, 50, 50],
  });

  await loopPromise;
  assert.equal(calls, 1);
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  assert.equal(warmupBroadcasts.at(-1).state, "cancelled");
  assert.equal(session.mode, "staging");
});

test("warmupPromise blocks transcript turns until cache is confirmed (or loop ends)", async () => {
  const { session } = makeWarmupSession();
  const turnsRanAt = [];
  const turns = [];
  const sessionWithAgent = createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async ({ transcript }) => {
      turnsRanAt.push(Date.now());
      turns.push(transcript);
    },
  });
  sessionWithAgent.mode = "live";

  const warmupResolved = sessionWithAgent.startWarmupLoop({
    runOnce: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { usage: { input: 1000, cached: 500, output: 5 } };
    },
    delays: [10, 10, 10, 10, 10, 10, 10],
  });
  const warmupStartedAt = Date.now();

  // Queue a transcript IMMEDIATELY - the runTurn awaits warmup before agent fires.
  sessionWithAgent.queueTranscript("OpenAI just released a new model");
  await sessionWithAgent.idle();
  await warmupResolved;

  assert.equal(turns.length, 1);
  assert.ok(
    turnsRanAt[0] - warmupStartedAt >= 40,
    `transcript should have waited for warmup (took ${turnsRanAt[0] - warmupStartedAt}ms)`,
  );
});

test("startWarmupLoop appends primingMessages to agentHistory once the loop ends", async () => {
  const { session } = makeWarmupSession();
  session.agentHistory = [{ role: "user", content: "primer" }];
  await session.startWarmupLoop({
    runOnce: async () => ({ usage: { input: 1000, cached: 500, output: 5 } }),
    delays: [10, 10, 10, 10, 10, 10, 10],
    primingMessages: [
      { role: "user", content: "Speaker turn:\n(cache warmup)" },
      { role: "assistant", content: "UNDERSTOOD" },
    ],
  });
  assert.deepEqual(session.agentHistory, [
    { role: "user", content: "primer" },
    { role: "user", content: "Speaker turn:\n(cache warmup)" },
    { role: "assistant", content: "UNDERSTOOD" },
  ]);
});

test("startWarmupLoop is a no-op if called while already running", async () => {
  const { session, broadcasts } = makeWarmupSession();
  let calls = 0;
  // First invocation: blocks on a promise we control.
  let release = (..._args) => {};
  const block = new Promise((r) => { release = r; });
  const first = session.startWarmupLoop({
    runOnce: async () => {
      calls += 1;
      await block;
      return { usage: { input: 1000, cached: 500, output: 5 } };
    },
    delays: [1, 1, 1, 1, 1, 1, 1],
  });
  // Second invocation while first is still in-flight should be ignored.
  const second = session.startWarmupLoop({
    runOnce: async () => { calls += 1; return { usage: { input: 0, cached: 0, output: 0 } }; },
    delays: [1, 1, 1, 1, 1, 1, 1],
  });
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1, "second startWarmupLoop call should be ignored while first is running");
  const warmupBroadcasts = broadcasts.filter((m) => m.type === "warmup");
  assert.equal(warmupBroadcasts.at(-1).state, "confirmed");
});
