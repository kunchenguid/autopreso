import { createOpenAI } from "@ai-sdk/openai";

import { DEFAULT_CODEX_BASE_URL, createCodexFetch, readCodexCliAuthSync } from "./codex-auth.js";

const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.5";
const DEFAULT_OPENAI_REASONING_EFFORT = "low";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OPENAI_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

export function resolveWhiteboardAgentProvider(env = process.env) {
  const ollamaModel = cleanEnvValue(env.OLLAMA_MODEL);
  if (ollamaModel) {
    return {
      provider: "ollama",
      model: ollamaModel,
      baseURL: withoutTrailingSlash(cleanEnvValue(env.OLLAMA_BASE_URL) ?? DEFAULT_OLLAMA_BASE_URL),
      apiKey: "ollama",
    };
  }

  const openaiApiKey = cleanEnvValue(env.OPENAI_API_KEY);
  const codexAuth = readCodexCliAuthSync(env);
  const forceCodex = isTruthyEnvValue(env.OPENAI_CODEX);
  if (forceCodex && !codexAuth) {
    throw new Error("Codex CLI auth not found. Run `codex` and sign in with ChatGPT, or unset OPENAI_CODEX.");
  }
  if (codexAuth && (forceCodex || !openaiApiKey)) {
    const codexModel = resolveCodexModel(cleanEnvValue(env.CODEX_MODEL) ?? cleanEnvValue(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_AGENT_MODEL);
    return {
      provider: "codex",
      ...codexModel,
      baseURL: withoutTrailingSlash(cleanEnvValue(env.CODEX_BASE_URL) ?? DEFAULT_CODEX_BASE_URL),
      apiKey: codexAuth.accessToken,
      reasoningEffort: resolveOpenAIReasoningEffort(env),
    };
  }

  if (!openaiApiKey) {
    return undefined;
  }

  return {
    provider: "openai",
    model: cleanEnvValue(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_AGENT_MODEL,
    apiKey: openaiApiKey,
    reasoningEffort: resolveOpenAIReasoningEffort(env),
  };
}

export function defaultWhiteboardAgentProvider(options = {}) {
  return {
    provider: "openai",
    model: DEFAULT_OPENAI_AGENT_MODEL,
    apiKey: options.openaiApiKey,
    reasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
  };
}

export function createWhiteboardAgentModel(agentProvider) {
  if (agentProvider.provider === "ollama") {
    const ollama = createOpenAI({
      name: "ollama",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    return ollama.chat(agentProvider.model);
  }

  if (agentProvider.provider === "codex") {
    const codex = createOpenAI({
      name: "openai-codex",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
      fetch: createCodexFetch(),
    });
    return codex.responses(agentProvider.model);
  }

  const openai = createOpenAI({ apiKey: agentProvider.apiKey });
  return openai(agentProvider.model);
}

function cleanEnvValue(value) {
  const trimmedValue = value?.trim();
  return trimmedValue || undefined;
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function isTruthyEnvValue(value) {
  return ["1", "true", "yes", "on"].includes(cleanEnvValue(value)?.toLowerCase());
}

function resolveCodexModel(requestedModel) {
  if (requestedModel.endsWith("-fast")) {
    return {
      model: requestedModel.slice(0, -"-fast".length),
      requestedModel,
      serviceTier: "priority",
    };
  }
  return { model: requestedModel };
}

function resolveOpenAIReasoningEffort(env) {
  const reasoningEffort = cleanEnvValue(env.OPENAI_REASONING_EFFORT) ?? DEFAULT_OPENAI_REASONING_EFFORT;
  if (!OPENAI_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported OPENAI_REASONING_EFFORT "${reasoningEffort}". Use none, low, medium, high, or xhigh.`);
  }
  return reasoningEffort;
}
