// @ts-nocheck - constructs minimal `state` shapes that don't carry the full
// production fields; structural typing fights here without JSDoc.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runWhiteboardAgent } from "../src/server.js";
import { createWhiteboardSession } from "../src/whiteboard-session.js";

function makeSession({ runAgentSpy } = {}) {
  return createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: runAgentSpy ?? (async () => {}),
  });
}

test("late tool execute is a no-op once the session has ended", async () => {
  const wssBroadcasts = [];
  const wss = {
    clients: new Set([
      { readyState: 1, send: (m) => wssBroadcasts.push(JSON.parse(m)) },
    ]),
  };
  const state = makeSession();
  state.elements = [];
  state.agentHistory = [];
  state.mode = "live";
  const initialElements = state.elements;

  // Mock generateText: when the model fires the tool, the user has already
  // clicked Stop. The execute callback should refuse to mutate state.
  const generateTextFn = async ({ tools }) => {
    state.endSession();
    const toolResult = await tools.whiteboard_apply.execute({
      operations: [{
        type: "insert_after",
        line: 0,
        element: { type: "rectangle", id: "late", x: 0, y: 0, width: 100, height: 50 },
      }],
    });
    return { text: "DONE", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5 }, toolResults: [{ result: toolResult }] };
  };

  await runWhiteboardAgent({
    transcript: "hello",
    state,
    wss,
    options: {
      agentProvider: { provider: "openai", model: "gpt-5.4-mini", apiKey: "test", reasoningEffort: "low" },
    },
    generateTextFn,
  });

  assert.equal(state.elements, initialElements, "stale tool must not replace state.elements");
  const updates = wssBroadcasts.filter((m) => m.type === "whiteboard:update");
  assert.equal(updates.length, 0, "stale tool must not broadcast whiteboard:update");
});

test("cost is recorded even when the tool execute is skipped (stale session)", async () => {
  const state = makeSession();
  state.elements = [];
  state.agentHistory = [];
  state.mode = "live";

  const generateTextFn = async ({ tools }) => {
    state.endSession();
    await tools.whiteboard_apply.execute({
      operations: [{
        type: "insert_after",
        line: 0,
        element: { type: "rectangle", id: "x", x: 0, y: 0, width: 50, height: 50 },
      }],
    });
    return { text: "DONE", finishReason: "stop", usage: { inputTokens: 4321, outputTokens: 12 } };
  };

  await runWhiteboardAgent({
    transcript: "hello",
    state,
    wss: { clients: new Set() },
    options: {
      agentProvider: { provider: "openai", model: "gpt-5.4-mini", apiKey: "test", reasoningEffort: "low" },
    },
    generateTextFn,
  });

  const summary = state.cost.getSummary();
  assert.equal(summary.agent.tokens.input, 4321, "input tokens must be recorded across session boundary");
  assert.equal(summary.agent.tokens.output, 12);
  assert.ok(summary.agent.priced, "openai+real-model cost should still price normally");
  assert.ok(summary.agent.cost > 0, "non-zero cost expected");
});

test("agentHistory is not appended when the session ended mid-turn", async () => {
  const state = makeSession();
  state.elements = [];
  state.agentHistory = [{ role: "user", content: "primer" }];
  state.mode = "live";
  const initialHistoryLength = state.agentHistory.length;

  const generateTextFn = async () => {
    state.endSession();
    return { text: "DONE", finishReason: "stop", usage: {} };
  };

  await runWhiteboardAgent({
    transcript: "should not be persisted",
    state,
    wss: { clients: new Set() },
    options: {
      agentProvider: { provider: "openai", model: "gpt-5.4-mini", apiKey: "test", reasoningEffort: "low" },
    },
    generateTextFn,
  });

  assert.equal(state.agentHistory.length, initialHistoryLength, "stale turn must not extend agentHistory");
});
