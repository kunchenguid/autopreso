const SUPPORTED_MOONSHINE_MODELS = new Set(["tiny", "small", "medium"]);

export function parseCliArgs(args, env = process.env) {
  const options = {
    host: "127.0.0.1",
    port: parsePort(env.PORT),
    moonshineModel: "medium",
    openBrowser: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--host") {
      options.host = requireValue(arg, args[++index]);
    } else if (arg === "--moonshine-model") {
      const model = requireValue(arg, args[++index]);
      if (!SUPPORTED_MOONSHINE_MODELS.has(model)) {
        throw new Error(`Unsupported Moonshine model "${model}". Use tiny, small, or medium.`);
      }
      options.moonshineModel = model;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parsePort(value) {
  const raw = value || "3210";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}".`);
  }
  return port;
}
