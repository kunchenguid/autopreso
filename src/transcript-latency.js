export const DEFAULT_TRANSCRIPT_TURN_DEBOUNCE_MS = 250;
export const DEFAULT_TRANSCRIPT_TURN_MAX_WAIT_MS = 1_200;

export function normalizeTranscriptLatencySettings(settings = {}) {
  return {
    transcriptTurnDebounceMs: normalizeLatencyMs(
      settings.transcriptTurnDebounceMs,
      DEFAULT_TRANSCRIPT_TURN_DEBOUNCE_MS,
      { min: 0, max: 5_000 },
    ),
    transcriptTurnMaxWaitMs: normalizeLatencyMs(
      settings.transcriptTurnMaxWaitMs,
      DEFAULT_TRANSCRIPT_TURN_MAX_WAIT_MS,
      { min: 100, max: 10_000 },
    ),
  };
}

function normalizeLatencyMs(value, fallback, { min, max }) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}
