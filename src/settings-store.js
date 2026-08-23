import fs from "node:fs/promises";
import path from "node:path";

import { readCodexCliAuthSync } from "./codex-auth.js";
import {
  DEFAULT_TRANSCRIPT_TURN_DEBOUNCE_MS,
  DEFAULT_TRANSCRIPT_TURN_MAX_WAIT_MS,
} from "./transcript-latency.js";
import { DEFAULT_XAI_SMART_TURN_TIMEOUT_MS } from "./xai-transcription.js";

export const MAX_AGENT_INSTRUCTIONS_CHARS = 100_000;

export const DEFAULT_SETTINGS = Object.freeze({
  agent: {
    provider: "openai",
    openai: { model: "gpt-5.5", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
    xai: { model: "grok-4.3", baseURL: "https://api.x.ai/v1" },
    codex: { model: "gpt-5.5-fast", baseURL: "https://chatgpt.com/backend-api/codex" },
    ollama: { model: "", baseURL: "http://localhost:11434/v1" },
  },
  transcription: {
    provider: "moonshine",
    moonshine: { model: "medium" },
    openai: { model: "gpt-realtime-whisper" },
    xai: { language: "en", smartTurnTimeoutMs: DEFAULT_XAI_SMART_TURN_TIMEOUT_MS },
  },
  latency: {
    transcriptTurnDebounceMs: DEFAULT_TRANSCRIPT_TURN_DEBOUNCE_MS,
    transcriptTurnMaxWaitMs: DEFAULT_TRANSCRIPT_TURN_MAX_WAIT_MS,
  },
  apiKeys: {
    openai: "",
    xai: "",
  },
  agentInstructions: "",
});

export function createSettingsStore({ filePath, env = process.env, readCodexAuth = readCodexCliAuthSync }) {
  let cached = null;

  async function readFromDisk() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return deepMerge(cloneDefaults(), JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeToDisk(settings) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    try {
      await fs.chmod(filePath, 0o600);
    } catch {}
  }

  async function load() {
    if (cached) return cached;
    const fromDisk = await readFromDisk();
    if (fromDisk) {
      cached = fromDisk;
      return cached;
    }
    const seeded = seedFromEnv(cloneDefaults(), env, readCodexAuth);
    await writeToDisk(seeded);
    cached = seeded;
    return cached;
  }

  async function save(partial) {
    if (!cached) await load();
    validateAgentInstructions(partial?.agentInstructions);
    cached = deepMerge(cached, partial);
    await writeToDisk(cached);
    return cached;
  }

  async function getSanitized() {
    const settings = await load();
    const { apiKeys, ...rest } = settings;
    return {
      ...rest,
      hasOpenAIKey: Boolean(apiKeys?.openai),
      hasXAIKey: Boolean(apiKeys?.xai),
    };
  }

  return { load, save, getSanitized };
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function seedFromEnv(settings, env, readCodexAuth) {
  const next = settings;
  const openaiKey = trimOrEmpty(env.OPENAI_API_KEY);
  if (openaiKey) next.apiKeys.openai = openaiKey;

  const xaiKey = trimOrEmpty(env.XAI_API_KEY);
  if (xaiKey) next.apiKeys.xai = xaiKey;

  const openaiModel = trimOrEmpty(env.OPENAI_MODEL);
  if (openaiModel) next.agent.openai.model = openaiModel;

  const openaiBaseURL = trimOrEmpty(env.OPENAI_BASE_URL);
  if (openaiBaseURL) next.agent.openai.baseURL = openaiBaseURL;

  const xaiModel = trimOrEmpty(env.XAI_MODEL);
  if (xaiModel) next.agent.xai.model = xaiModel;

  const xaiBaseURL = trimOrEmpty(env.XAI_BASE_URL);
  if (xaiBaseURL) next.agent.xai.baseURL = xaiBaseURL;

  const xaiSttLanguage = trimOrEmpty(env.XAI_STT_LANGUAGE);
  if (xaiSttLanguage) next.transcription.xai.language = xaiSttLanguage;

  const xaiSttSmartTurnTimeoutMs = parsePositiveInteger(env.XAI_STT_SMART_TURN_TIMEOUT_MS);
  if (xaiSttSmartTurnTimeoutMs) next.transcription.xai.smartTurnTimeoutMs = xaiSttSmartTurnTimeoutMs;

  const transcriptTurnDebounceMs = parseNonNegativeInteger(env.AUTOPRESO_TRANSCRIPT_TURN_DEBOUNCE_MS);
  if (transcriptTurnDebounceMs !== null) next.latency.transcriptTurnDebounceMs = transcriptTurnDebounceMs;

  const transcriptTurnMaxWaitMs = parsePositiveInteger(env.AUTOPRESO_TRANSCRIPT_TURN_MAX_WAIT_MS);
  if (transcriptTurnMaxWaitMs) next.latency.transcriptTurnMaxWaitMs = transcriptTurnMaxWaitMs;

  const reasoningEffort = trimOrEmpty(env.OPENAI_REASONING_EFFORT);
  if (reasoningEffort) next.agent.openai.reasoningEffort = reasoningEffort;

  const codexModel = trimOrEmpty(env.CODEX_MODEL);
  if (codexModel) next.agent.codex.model = codexModel;

  const codexBaseURL = trimOrEmpty(env.CODEX_BASE_URL);
  if (codexBaseURL) next.agent.codex.baseURL = codexBaseURL;

  const ollamaModel = trimOrEmpty(env.OLLAMA_MODEL);
  if (ollamaModel) next.agent.ollama.model = ollamaModel;

  const ollamaBaseURL = trimOrEmpty(env.OLLAMA_BASE_URL);
  if (ollamaBaseURL) next.agent.ollama.baseURL = ollamaBaseURL;

  const codexAuth = safeReadCodexAuth(readCodexAuth, env);
  if (codexAuth) next.agent.provider = "codex";
  else if (ollamaModel) next.agent.provider = "ollama";
  else if (xaiKey) next.agent.provider = "xai";
  else next.agent.provider = "openai";

  if (openaiKey) next.transcription.provider = "openai";
  else if (xaiKey) next.transcription.provider = "xai";

  return next;
}

function safeReadCodexAuth(readCodexAuth, env) {
  try {
    return readCodexAuth(env);
  } catch {
    return null;
  }
}

function trimOrEmpty(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parsePositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function parseNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

export function validateAgentInstructions(value) {
  if (typeof value === "string" && value.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    throw new Error(`Agent instructions must be ${MAX_AGENT_INSTRUCTIONS_CHARS} characters or fewer.`);
  }
}
