const DEFAULT_CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function parseSimulatorArgs(args, env = process.env) {
  const options = {
    host: "127.0.0.1",
    port: 0,
    chunkIntervalMs: 500,
    speakingWordsPerMinute: 160,
    chromeBin: env.CHROME_BIN ?? DEFAULT_CHROME_BIN,
    agentTimeoutMs: 90_000,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--transcript") {
      options.transcriptPath = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--out") {
      options.outDir = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--chrome-bin") {
      options.chromeBin = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--chunk-interval-ms") {
      options.chunkIntervalMs = parseNonNegativeInteger(readValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--speaking-words-per-minute") {
      options.speakingWordsPerMinute = parsePositiveInteger(readValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--agent-timeout-ms") {
      options.agentTimeoutMs = parsePositiveInteger(readValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--host") {
      options.host = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--port") {
      options.port = parseNonNegativeInteger(readValue(args, ++index, arg), arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.transcriptPath) throw new Error("--transcript is required");
  if (!options.outDir) throw new Error("--out is required");
  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
