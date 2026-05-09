// @ts-nocheck - injected fakes for streamText/generateText return simplified shapes that don't satisfy the AI SDK return type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { DEFAULT_AGENT_TIMEOUT_MS, runWhiteboardAgent, startServer, whiteboardSystemPrompt } from "../src/server.js";

test("default whiteboard agent timeout is 90 seconds", () => {
  assert.equal(DEFAULT_AGENT_TIMEOUT_MS, 90_000);
});

test("startServer waits for Moonshine readiness before listening", async () => {
  let resolveReady;
  let closed = false;
  const progressMessages = [];
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const serverPromise = startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    onStatus: (message) => progressMessages.push(message),
    createTranscription: () => ({
      ready: () => readyPromise,
      sendAudio: () => {},
      stop: () => {},
      close: () => {
        closed = true;
      },
    }),
  });

  let started = false;
  serverPromise.then(() => {
    started = true;
  });
  await Promise.resolve();
  assert.equal(started, false);
  assert.deepEqual(progressMessages, ["Preparing Moonshine medium transcription model..."]);

  resolveReady();
  const { httpServer } = await serverPromise;
  assert.equal(started, true);
  assert.deepEqual(progressMessages, [
    "Preparing Moonshine medium transcription model...",
    "Moonshine medium transcription model ready.",
  ]);

  await new Promise((resolve) => httpServer.close(resolve));
  assert.equal(closed, true);
});

test("websocket clients receive the current agent status on connect", async () => {
  const { httpServer, url } = await startServer({
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
    const messages = await collectWebSocketMessages(url.replace("http:", "ws:") + "/ws", 5);
    assert.deepEqual(
      messages.map((message) => message.type),
      ["config", "agent:status", "mode", "warmup", "cost"],
    );
    assert.equal(messages[1].status, "idle");
    assert.equal(messages[2].mode, "staging");
    assert.equal(messages[3].state, "idle");
    assert.equal(messages[4].agent.cost, 0);
    assert.equal(messages[4].transcription.cost, 0);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("websocket screenshot messages update agent visual context", async () => {
  let resolveGenerateText;
  const generateTextStarted = new Promise((resolve) => {
    resolveGenerateText = resolve;
  });
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => queueTranscript("Update the visual layout"),
      stop: () => {},
      close: () => {},
    }),
    generateTextFn: async ({ messages }) => {
      const currentCanvasMessage = messages.at(-1);
      assert.deepEqual(currentCanvasMessage.content.at(-1), { type: "image", image: "data:image/png;base64,latest" });
      resolveGenerateText();
      return { text: "DONE", finishReason: "stop" };
    },
  });

  try {
    state.mode = "live";
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    const initialMessages = new Promise((resolve) => {
      let count = 0;
      ws.on("message", () => {
        count += 1;
        if (count === 6) resolve();
      });
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await initialMessages;
    ws.send(JSON.stringify({ type: "whiteboard:screenshot", image: "data:image/png;base64,latest" }));
    ws.send(JSON.stringify({ type: "audio", audio: "" }));
    await generateTextStarted;
    ws.close();
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("websocket stop makes synchronous transcript flush stale", async () => {
  let generateCalled = false;
  let ws;
  let resolveStopCalled;
  const stopCalled = new Promise((resolve) => {
    resolveStopCalled = resolve;
  });
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {
        queueTranscript("Final flushed words");
        resolveStopCalled();
      },
      close: () => {},
    }),
    generateTextFn: async () => {
      generateCalled = true;
      return { text: "DONE", finishReason: "stop" };
    },
  });

  try {
    state.mode = "live";
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    const initialMessages = new Promise((resolve) => {
      let count = 0;
      ws.on("message", () => {
        count += 1;
        if (count === 5) resolve();
      });
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await initialMessages;
    ws.send(JSON.stringify({ type: "stop" }));
    await Promise.race([
      stopCalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for transcription stop.")), 2000)),
    ]);
    await state.idle();
    assert.equal(generateCalled, false);
    ws.close();
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("runWhiteboardAgent rejects with a timeout instead of hanging forever", async () => {
  await assert.rejects(
    () =>
      runWhiteboardAgent({
        transcript: "hello",
        state: { elements: [], agentHistory: [] },
        wss: { clients: new Set() },
        options: { agentTimeoutMs: 1 },
        generateTextFn: () => new Promise(() => {}),
      }),
    /Whiteboard agent timed out/,
  );
});

test("runWhiteboardAgent exposes whiteboard_apply that combines edits and viewport in one call", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a voice box and focus on it",
    state,
    wss: {
      clients: new Set([
        {
          readyState: WebSocket.OPEN,
          send: (message) => broadcasts.push(JSON.parse(message)),
        },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      assert.equal(tools.updateWhiteboard, undefined);
      assert.equal(tools.whiteboard_edit, undefined, "whiteboard_edit removed");
      assert.equal(tools.whiteboard_viewport, undefined, "whiteboard_viewport removed");
      assert.ok(tools.whiteboard_overwrite);
      assert.ok(tools.whiteboard_apply);

      const result = await tools.whiteboard_apply.execute({
        operations: [
          {
            type: "insert_after",
            line: 1,
            element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
          },
        ],
        viewport: { action: "scroll_to_content", focus_ids: ["voice"] },
      });

      assert.match(result, /001: \{"type":"text","id":"title"/);
      assert.match(result, /002: \{"type":"rectangle","id":"voice"/);
      assert.match(result, /Viewport scrolled to 1 element: \["voice"\]/);
    },
  });

  assert.deepEqual(state.elements, [
    { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ]);
  assert.deepEqual(
    broadcasts,
    [
      { type: "whiteboard:update", elements: state.elements },
      { type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["voice"] },
    ],
  );
});

test("whiteboard_apply with operations only edits the canvas without touching viewport", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 0, y: 0, text: "Hi" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        operations: [
          { type: "insert_after", line: 1, element: { type: "rectangle", id: "box", x: 10, y: 50, width: 100, height: 50 } },
        ],
      });
      assert.match(result, /002: \{"type":"rectangle","id":"box"/);
      assert.doesNotMatch(result, /Viewport/);
    },
  });

  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:viewport").length, 0);
});

test("whiteboard_apply with viewport only moves the camera without editing", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "rectangle", id: "oauth-box", x: 0, y: 0, width: 200, height: 100 }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Zoom to the OAuth box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content", focus_ids: ["oauth-box"] },
      });
      assert.match(result, /Viewport scrolled to 1 element/);
    },
  });

  assert.deepEqual(
    broadcasts.filter((m) => m.type === "whiteboard:viewport"),
    [{ type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["oauth-box"] }],
  );
  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:update").length, 0);
});

test("whiteboard_apply rejects calls with neither operations nor viewport", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "do nothing",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({});
    },
  });
  assert.match(returned, /Provide at least one of operations or viewport/);
});

test("whiteboard_apply scroll_to_content without focus_ids returns a nudge to use them", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "scroll please",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content" },
      });
    },
  });
  assert.match(returned, /focus_ids/);
});

test("runWhiteboardAgent passes OpenAI reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "openai",
        model: "gpt-5.5",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    generateTextFn: async ({ providerOptions }) => {
      assert.deepEqual(providerOptions, {
        openai: { reasoningEffort: "low" },
      });
    },
  });
});

test("runWhiteboardAgent always uses the production system prompt", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { systemPrompt: "Custom whiteboard instructions" },
    generateTextFn: async ({ system }) => {
      assert.equal(system, whiteboardSystemPrompt());
    },
  });
});

test("runWhiteboardAgent records a model result summary in agent events", async () => {
  const events = [];

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { onAgentEvent: (event) => events.push(event) },
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop", usage: { totalTokens: 12 } }),
  });

  const endEvent = events.find((event) => event.type === "model:end");
  assert.deepEqual(endEvent.result, {
    text: "DONE",
    finishReason: "stop",
    usage: { totalTokens: 12 },
  });
});

test("runWhiteboardAgent passes Codex reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex fast mode provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        requestedModel: "gpt-5.5-fast",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
        serviceTier: "priority",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", serviceTier: "priority", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex instructions provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions, system }) => ({
      consumeStream: async () => {
        assert.equal(providerOptions.openai.instructions, system);
      },
    }),
  });
});

test("runWhiteboardAgent disables Codex response storage", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.equal(providerOptions.openai.store, false);
      },
    }),
  });
});

test("runWhiteboardAgent uses streaming for Codex responses", async () => {
  let consumed = false;

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    generateTextFn: async () => {
      throw new Error("Codex should use streamText");
    },
    streamTextFn: () => ({
      consumeStream: async () => {
        consumed = true;
      },
    }),
  });

  assert.equal(consumed, true);
});

function collectWebSocketMessages(url, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for ${count} websocket messages.`));
    }, 2000);

    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length === count) {
        clearTimeout(timeout);
        ws.close();
        resolve(messages);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
