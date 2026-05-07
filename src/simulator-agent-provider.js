import { resolveWhiteboardAgentProvider } from "./agent-provider.js";

export function resolveSimulatorAgentProvider(env = process.env) {
  const model = stripFastMode(env.CODEX_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-5.5");
  return resolveWhiteboardAgentProvider({
    ...env,
    OLLAMA_MODEL: "",
    OPENAI_API_KEY: "",
    OPENAI_CODEX: "1",
    CODEX_MODEL: model,
  });
}

function stripFastMode(model) {
  if (model.endsWith("-fast")) return model.slice(0, -"-fast".length);
  return model;
}
