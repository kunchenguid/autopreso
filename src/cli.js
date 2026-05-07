#!/usr/bin/env node
import open from "open";

import { resolveWhiteboardAgentProvider } from "./agent-provider.js";
import { parseCliArgs } from "./cli-options.js";
import { startServer } from "./server.js";

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

  const agentProvider = resolveWhiteboardAgentProvider(process.env);
  if (!agentProvider) {
    console.error("OPENAI_API_KEY, OLLAMA_MODEL, or Codex CLI auth is required for the whiteboard agent.");
    console.error("Set one in your shell, or run `codex` and sign in with ChatGPT, then run `autopreso` again.");
    process.exitCode = 1;
    return;
  }

  const { url } = await startServer({
    ...options,
    agentProvider,
    onStatus: (message) => console.log(message),
  });

  console.log(`autopreso listening at ${url}`);
  console.log(`transcription engine: Moonshine ${options.moonshineModel}`);
  console.log(`whiteboard agent: ${agentProvider.provider} ${agentProvider.requestedModel ?? agentProvider.model}`);

  if (options.openBrowser) {
    await open(url);
  }
}

function printHelp() {
  console.log(`autopreso

Usage:
  autopreso [options]

Options:
  --host <host>                   Host to bind. Default: 127.0.0.1
  --moonshine-model <model>       tiny, small, or medium. Default: medium
  --no-open                       Do not open the browser automatically
  -h, --help                      Show this help

Environment:
  PORT                            Port to listen on. Default: 3210
  OPENAI_API_KEY                  OpenAI API key for the default whiteboard agent
  OPENAI_MODEL                    OpenAI model id. Default: gpt-5.5
  OPENAI_REASONING_EFFORT         none, low, medium, high, or xhigh. Default: low
  OPENAI_CODEX                    Set to 1 to force Codex CLI auth over OPENAI_API_KEY
  CODEX_MODEL                     Codex model id. Use gpt-5.5-fast for fast mode. Default: gpt-5.5
  CODEX_HOME                      Codex CLI home. Default: ~/.codex
  CODEX_BASE_URL                  Codex backend URL. Default: https://chatgpt.com/backend-api/codex
  OLLAMA_MODEL                    Ollama model id for local whiteboard agent inference
  OLLAMA_BASE_URL                 Ollama OpenAI-compatible base URL. Default: http://localhost:11434/v1
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
