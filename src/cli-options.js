export function parseCliArgs(args, env = process.env) {
  const options = {
    host: "127.0.0.1",
    port: parsePort(env.PORT),
    openBrowser: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  return options;
}

function parsePort(value) {
  const raw = value || "3210";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}".`);
  }
  return port;
}
