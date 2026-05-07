import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardAgentModel } from "../src/agent-provider.js";

test("createWhiteboardAgentModel creates an Ollama chat model", () => {
  const model = createWhiteboardAgentModel({
    provider: "ollama",
    model: "llama3.2",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });

  assert.equal(model.provider, "ollama.chat");
  assert.equal(model.modelId, "llama3.2");
});

test("createWhiteboardAgentModel creates a Codex responses model", () => {
  const model = createWhiteboardAgentModel({
    provider: "codex",
    model: "gpt-5.5",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
  });

  assert.equal(model.provider, "openai-codex.responses");
  assert.equal(model.modelId, "gpt-5.5");
});
