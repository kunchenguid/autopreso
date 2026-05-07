import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createWhiteboardAgentModel,
  resolveWhiteboardAgentProvider,
} from "../src/agent-provider.js";

test("resolveWhiteboardAgentProvider prefers OLLAMA_MODEL over OPENAI_API_KEY", () => {
  assert.deepEqual(
    resolveWhiteboardAgentProvider({
      OLLAMA_MODEL: "llama3.2",
      OPENAI_API_KEY: "openai-key",
    }),
    {
      provider: "ollama",
      model: "llama3.2",
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    },
  );
});

test("resolveWhiteboardAgentProvider supports an Ollama base URL override", () => {
  assert.deepEqual(
    resolveWhiteboardAgentProvider({
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_BASE_URL: "http://example.test:11434/v1/",
    }),
    {
      provider: "ollama",
      model: "qwen3:8b",
      baseURL: "http://example.test:11434/v1",
      apiKey: "ollama",
    },
  );
});

test("resolveWhiteboardAgentProvider falls back to OpenAI when Ollama is not configured", () => {
  assert.deepEqual(resolveWhiteboardAgentProvider({ OPENAI_API_KEY: "openai-key" }), {
    provider: "openai",
    model: "gpt-5.5",
    apiKey: "openai-key",
    reasoningEffort: "low",
  });
});

test("resolveWhiteboardAgentProvider supports an OpenAI reasoning effort override", () => {
  assert.deepEqual(
    resolveWhiteboardAgentProvider({
      OPENAI_API_KEY: "openai-key",
      OPENAI_REASONING_EFFORT: "high",
    }),
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "openai-key",
      reasoningEffort: "high",
    },
  );
});

test("resolveWhiteboardAgentProvider supports an OpenAI model override", () => {
  assert.deepEqual(
    resolveWhiteboardAgentProvider({
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-5.5",
    }),
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "openai-key",
      reasoningEffort: "low",
    },
  );
});

test("resolveWhiteboardAgentProvider uses Codex CLI auth when OpenAI API key is not configured", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autopreso-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  assert.deepEqual(resolveWhiteboardAgentProvider({ CODEX_HOME: codexHome }), {
    provider: "codex",
    model: "gpt-5.5",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
  });
});

test("resolveWhiteboardAgentProvider can force Codex CLI auth over OpenAI API key", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autopreso-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  assert.deepEqual(resolveWhiteboardAgentProvider({ CODEX_HOME: codexHome, OPENAI_API_KEY: "openai-key", OPENAI_CODEX: "1" }), {
    provider: "codex",
    model: "gpt-5.5",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
  });
});

test("resolveWhiteboardAgentProvider supports the Codex fast model mode", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autopreso-codex-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-token", refresh_token: "refresh" } }));

  assert.deepEqual(resolveWhiteboardAgentProvider({ CODEX_HOME: codexHome, CODEX_MODEL: "gpt-5.5-fast" }), {
    provider: "codex",
    model: "gpt-5.5",
    requestedModel: "gpt-5.5-fast",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "codex-token",
    reasoningEffort: "low",
    serviceTier: "priority",
  });
});

test("resolveWhiteboardAgentProvider rejects forced Codex without Codex CLI auth", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autopreso-codex-empty-"));

  assert.throws(
    () => resolveWhiteboardAgentProvider({ CODEX_HOME: codexHome, OPENAI_API_KEY: "openai-key", OPENAI_CODEX: "1" }),
    /Codex CLI auth not found/,
  );
});

test("resolveWhiteboardAgentProvider rejects unsupported OpenAI reasoning effort values", () => {
  assert.throws(
    () => resolveWhiteboardAgentProvider({ OPENAI_API_KEY: "openai-key", OPENAI_REASONING_EFFORT: "maximum" }),
    /Unsupported OPENAI_REASONING_EFFORT/,
  );
});

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
