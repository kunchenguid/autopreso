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
  assert.deepEqual(progressMessages, ["Loading Moonshine medium transcription model..."]);

  resolveReady();
  const { httpServer } = await serverPromise;
  assert.equal(started, true);
  assert.deepEqual(progressMessages, [
    "Loading Moonshine medium transcription model...",
    "Moonshine medium transcription model is ready.",
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
    const messages = await collectWebSocketMessages(url.replace("http:", "ws:") + "/ws", 3);
    assert.deepEqual(
      messages.map((message) => message.type),
      ["config", "agent:status", "whiteboard:update"],
    );
    assert.equal(messages[1].status, "idle");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("websocket screenshot messages update agent visual context", async () => {
  let resolveGenerateText;
  const generateTextStarted = new Promise((resolve) => {
    resolveGenerateText = resolve;
  });
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => queueTranscript("Update the visual layout"),
      close: () => {},
    }),
    generateTextFn: async ({ messages }) => {
      const currentCanvasMessage = messages.at(-1);
      assert.deepEqual(currentCanvasMessage.content.at(-1), { type: "image", image: "data:image/png;base64,latest" });
      resolveGenerateText();
    },
  });

  try {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "whiteboard:screenshot", image: "data:image/png;base64,latest" }));
    ws.send(JSON.stringify({ type: "stop" }));
    await generateTextStarted;
    ws.close();
  } finally {
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

test("runWhiteboardAgent exposes overwrite and edit tools that return latest numbered content", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a voice box",
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
      assert.ok(tools.whiteboard_overwrite);
      assert.ok(tools.whiteboard_edit);
      assert.ok(tools.whiteboard_viewport);

      const editResult = await tools.whiteboard_edit.execute({
        operations: [
          {
            type: "insert_after",
            line: 1,
            element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
          },
        ],
      });

      assert.equal(
        editResult,
        [
          '001: {"type":"text","id":"title","x":72,"y":68,"text":"AutoPreso"}',
          '002: {"type":"rectangle","id":"voice","x":80,"y":140,"width":220,"height":80}',
        ].join("\n"),
      );
    },
  });

  assert.deepEqual(state.elements, [
    { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ]);
  assert.deepEqual(broadcasts, [{ type: "whiteboard:update", elements: state.elements }]);
});

test("runWhiteboardAgent exposes a viewer viewport control tool", async () => {
  const broadcasts = [];

  await runWhiteboardAgent({
    transcript: "Zoom out to inspect the layout",
    state: { elements: [], agentHistory: [] },
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
      const result = await tools.whiteboard_viewport.execute({ action: "zoom_out" });
      assert.equal(result, "Viewport command sent. Use the next screenshot to inspect the updated view.");
    },
  });

  assert.deepEqual(broadcasts, [{ type: "whiteboard:viewport", action: "zoom_out" }]);
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
