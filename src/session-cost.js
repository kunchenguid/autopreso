// Session cost tracking. The numbers in AGENT_PRICING / TRANSCRIPTION_PRICING
// are OpenAI list pricing as of May 2026 - update them in one place if OpenAI
// changes its rate card. Local providers (moonshine, ollama) are billed at
// $0; codex routes through the user's ChatGPT subscription so it isn't
// billed per-token here either.

const SAMPLE_RATE_HZ = 24_000;
const PCM16_BYTES_PER_SAMPLE = 2;

// Per 1M tokens, USD. cachedInput is the rate for input tokens served from
// the prompt cache (10% of input across the board per OpenAI's policy).
// Reasoning tokens are billed at the output rate.
export const AGENT_PRICING = {
  openai: {
    "gpt-5.5":      { input: 5.00, cachedInput: 0.50,  output: 30.00 },
    "gpt-5.4":      { input: 2.50, cachedInput: 0.25,  output: 15.00 },
    "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output:  4.50 },
  },
};

// Per minute of audio sent, USD.
export const TRANSCRIPTION_PRICING = {
  openai: {
    "gpt-realtime-whisper":   0.017,
    "gpt-4o-transcribe":      0.006,
    "gpt-4o-mini-transcribe": 0.003,
    "whisper-1":              0.006,
  },
};

export function computeAgentCost({ provider, model, usage }) {
  if (provider === "ollama") return { priced: false, cost: 0, reason: "local" };
  if (provider === "codex") return { priced: false, cost: 0, reason: "subscription" };
  const rates = AGENT_PRICING[provider]?.[model];
  if (!rates) return { priced: false, cost: 0, reason: "unknown" };
  const input = Number(usage?.input) || 0;
  const cached = Math.min(Number(usage?.cached) || 0, input);
  const uncachedInput = Math.max(0, input - cached);
  const output = Number(usage?.output) || 0;
  const reasoning = Number(usage?.reasoning) || 0;
  const cost =
    (uncachedInput * rates.input) / 1_000_000 +
    (cached * rates.cachedInput) / 1_000_000 +
    ((output + reasoning) * rates.output) / 1_000_000;
  return { priced: true, cost, rates };
}

export function computeTranscriptionCost({ provider, model, seconds }) {
  if (provider === "moonshine") return { priced: false, cost: 0, reason: "local" };
  const ratePerMin = TRANSCRIPTION_PRICING[provider]?.[model];
  if (typeof ratePerMin !== "number") return { priced: false, cost: 0, reason: "unknown" };
  const cost = (Number(seconds) || 0) / 60 * ratePerMin;
  return { priced: true, cost, ratePerMin };
}

export function audioSecondsFromBase64Pcm16(base64Audio) {
  if (typeof base64Audio !== "string" || base64Audio.length === 0) return 0;
  // Buffer.byteLength avoids allocating a decoded buffer just to measure length.
  const bytes = Buffer.byteLength(base64Audio, "base64");
  return bytes / PCM16_BYTES_PER_SAMPLE / SAMPLE_RATE_HZ;
}

export function createSessionCostTracker() {
  const agent = {
    provider: null,
    model: null,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
  };
  const transcription = {
    provider: null,
    model: null,
    seconds: 0,
  };

  return {
    recordAgentUsage({ provider, model, usage }) {
      if (!provider || !model) return;
      agent.provider = provider;
      agent.model = model;
      agent.tokens.input += Number(usage?.input) || 0;
      agent.tokens.cached += Number(usage?.cached) || 0;
      agent.tokens.output += Number(usage?.output) || 0;
      agent.tokens.reasoning += Number(usage?.reasoning) || 0;
    },
    recordTranscriptionAudio(args = {}) {
      const { provider, model = null, base64Audio = null, seconds = null } = args;
      if (!provider) return;
      transcription.provider = provider;
      transcription.model = model ?? transcription.model;
      const delta = typeof seconds === "number" ? seconds : audioSecondsFromBase64Pcm16(base64Audio);
      transcription.seconds += delta;
    },
    reset() {
      agent.tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
      transcription.seconds = 0;
    },
    getSummary() {
      const agentCost = computeAgentCost({
        provider: agent.provider,
        model: agent.model,
        usage: agent.tokens,
      });
      const transcriptionCost = computeTranscriptionCost({
        provider: transcription.provider,
        model: transcription.model,
        seconds: transcription.seconds,
      });
      return {
        agent: {
          provider: agent.provider,
          model: agent.model,
          tokens: { ...agent.tokens },
          cost: agentCost.cost,
          priced: agentCost.priced,
          reason: agentCost.reason,
        },
        transcription: {
          provider: transcription.provider,
          model: transcription.model,
          seconds: transcription.seconds,
          cost: transcriptionCost.cost,
          priced: transcriptionCost.priced,
          reason: transcriptionCost.reason,
        },
      };
    },
  };
}
