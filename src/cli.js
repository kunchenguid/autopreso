#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import open from "open";

import { resolveAgentProviderFromSettings } from "./agent-provider.js";
import { parseCliArgs } from "./cli-options.js";
import { startServer } from "./server.js";
import { createSettingsStore } from "./settings-store.js";

const SETTINGS_PATH = path.join(os.homedir(), ".config", "autopreso", "settings.json");

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("Run `autopreso --help` for usage.");
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  const settingsStore = createSettingsStore({ filePath: SETTINGS_PATH });
  const settings = await settingsStore.load();

  let agentProvider;
  try {
    agentProvider = resolveAgentProviderFromSettings({ settings, env: process.env });
  } catch (error) {
    console.error(`Whiteboard agent is not configured: ${error.message}`);
    console.error("Open the app and configure the agent in the status panel, or set OPENAI_API_KEY / OLLAMA_MODEL in your shell.");
    console.error(`Settings file: ${SETTINGS_PATH}`);
    process.exitCode = 1;
    return;
  }

  if (settings.transcription.provider === "openai" && !(settings.apiKeys?.openai || process.env.OPENAI_API_KEY)) {
    console.error("OpenAI transcription is selected but no API key is configured.");
    console.error("Open the app and add the key in the STT engine row, or set OPENAI_API_KEY in your shell.");
    process.exitCode = 1;
    return;
  }

  const { url } = await startServer({
    ...options,
    settingsStore,
    onStatus: (message) => console.log(message),
  });

  console.log(`autopreso listening at ${url}`);

  if (options.openBrowser) {
    await open(url);
  }
}

function printHelp() {
  console.log(`autopreso

Usage:
  autopreso [options]

Options:
  --no-open                Do not open the browser automatically
  -h, --help               Show this help

The server binds to 127.0.0.1 only.

Environment:
  PORT                     Port to listen on. Default: 3210
  OPENAI_API_KEY           Seeds the OpenAI key on first run if no settings file exists
  OPENAI_MODEL             Seeds the OpenAI agent model on first run
  OPENAI_REASONING_EFFORT  Seeds reasoning effort on first run (none, low, medium, high, xhigh)
  CODEX_HOME               Codex CLI home directory. Default: ~/.codex
  CODEX_MODEL              Seeds the Codex model on first run
  CODEX_BASE_URL           Seeds the Codex backend URL on first run
  OLLAMA_MODEL             Seeds the Ollama model on first run
  OLLAMA_BASE_URL          Seeds the Ollama base URL on first run

Models and providers are configured in the UI after launch. Settings persist at:
  ${SETTINGS_PATH}
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
