import { createOpenAI } from "@ai-sdk/openai";

import { DEFAULT_CODEX_BASE_URL, createCodexFetch, readCodexCliAuthSync } from "./codex-auth.js";

const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.5";
const DEFAULT_OPENAI_REASONING_EFFORT = "low";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OPENAI_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

export function defaultWhiteboardAgentProvider(options = {}) {
  return {
    provider: "openai",
    model: DEFAULT_OPENAI_AGENT_MODEL,
    apiKey: options.openaiApiKey,
    reasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
  };
}

export function resolveAgentProviderFromSettings({ settings, env = process.env }) {
  const provider = settings.agent.provider;

  if (provider === "ollama") {
    const model = (settings.agent.ollama.model ?? "").trim();
    if (!model) throw new Error("Ollama model is not configured. Set it in the agent settings.");
    return {
      provider: "ollama",
      model,
      baseURL: withoutTrailingSlash(settings.agent.ollama.baseURL ?? DEFAULT_OLLAMA_BASE_URL),
      apiKey: "ollama",
    };
  }

  if (provider === "codex") {
    const codexAuth = readCodexCliAuthSync(env);
    if (!codexAuth) throw new Error("Codex CLI auth not found. Run `codex` and sign in with ChatGPT.");
    const codexModel = resolveCodexModel(settings.agent.codex.model || DEFAULT_OPENAI_AGENT_MODEL);
    return {
      provider: "codex",
      ...codexModel,
      baseURL: withoutTrailingSlash(settings.agent.codex.baseURL ?? DEFAULT_CODEX_BASE_URL),
      apiKey: codexAuth.accessToken,
      reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    };
  }

  const apiKey = (settings.apiKeys?.openai ?? "").trim() || cleanEnvValue(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("OpenAI API key is not configured. Add it in the agent settings.");
  return {
    provider: "openai",
    model: settings.agent.openai.model || DEFAULT_OPENAI_AGENT_MODEL,
    apiKey,
    reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
  };
}

function validateReasoningEffort(reasoningEffort) {
  const value = reasoningEffort || DEFAULT_OPENAI_REASONING_EFFORT;
  if (!OPENAI_REASONING_EFFORTS.has(value)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use none, low, medium, high, or xhigh.`);
  }
  return value;
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
