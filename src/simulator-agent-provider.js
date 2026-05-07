import { DEFAULT_CODEX_BASE_URL } from "./codex-auth.js";
import { resolveAgentProviderFromSettings } from "./agent-provider.js";

export function resolveSimulatorAgentProvider(env = process.env) {
  const requested = env.CODEX_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-5.5";
  const model = stripFastMode(requested);
  return resolveAgentProviderFromSettings({
    settings: {
      agent: {
        provider: "codex",
        openai: { model: "gpt-5.5", reasoningEffort: "low" },
        codex: { model, baseURL: DEFAULT_CODEX_BASE_URL },
        ollama: { model: "", baseURL: "" },
      },
      apiKeys: { openai: "" },
    },
    env,
  });
}

function stripFastMode(model) {
  if (model.endsWith("-fast")) return model.slice(0, -"-fast".length);
  return model;
}
