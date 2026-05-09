import { WebSocket } from "ws";

import { createTranscriptTurnQueue } from "./transcript-turn-queue.js";

const FILLER_WORDS = new Set([
  "uh", "uhh", "uhhh", "um", "umm", "ummm", "ah", "ahh", "er", "erm",
  "hmm", "hm", "huh", "mm", "mhm",
  "yeah", "yep", "yup", "yes", "ok", "okay", "right", "alright",
  "so", "well", "like",
]);

export function isTrivialTranscript(text) {
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Strip common punctuation and lowercase, then split into words.
  const cleaned = trimmed.replace(/[.,!?;:'"()\-]/g, " ").toLowerCase();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  // Single word: skip if it's filler or very short (1-2 chars).
  if (words.length === 1) {
    return FILLER_WORDS.has(words[0]) || words[0].length <= 2;
  }
  // 2-3 words and ALL are filler: skip ("you know", "uh well").
  if (words.length <= 3 && words.every((w) => FILLER_WORDS.has(w))) return true;
  return false;
}

// Default backoff between warmup attempts (after attempt N completes, wait
// delays[N-1] ms before the next). Total budget with 8 attempts: ~120s.
const DEFAULT_WARMUP_DELAYS = [2000, 4000, 8000, 16000, 30000, 30000, 30000];
const DEFAULT_WARMUP_MAX_ATTEMPTS = 8;

export function createWhiteboardSession({ options, wss, runAgent }) {
  const state = {
    mode: "staging",
    elements: seedElements(),
    agentHistory: [],
    agentStatus: "idle",
    agentBusy: false,
    warmupBusy: false,
    latestScreenshot: undefined,
    // Snapshot of the user's free-form "Agent instructions" textarea taken at
    // /api/preso/start. Frozen for the duration of the preso so the cached
    // system-prompt prefix the warmup loop primes stays stable; mid-preso edits
    // to the textarea only take effect on the next Start Preso.
    agentInstructions: "",
    warmupPromise: Promise.resolve(),
    // Snapshot of the warmup loop state, also broadcast to clients via WS.
    warmupState: { state: "idle", attempt: 0, maxAttempts: DEFAULT_WARMUP_MAX_ATTEMPTS },
    // True iff the canvas was edited since the last time a screenshot was
    // sent to the agent. We only attach the live screenshot when this is true
    // (saves ~7-10k tokens per turn on DONE-only turns when nothing changed).
    canvasDirtyForAgent: false,
  };

  let warmupCancelled = false;
  let warmupRunning = false;

  function publishAgentStatus() {
    const status = (state.agentBusy || state.warmupBusy) ? "thinking" : "idle";
    if (state.agentStatus === status) return;
    state.agentStatus = status;
    broadcast(wss, { type: "agent:status", status });
  }

  const queue = createTranscriptTurnQueue({
    // A turn is "ready" only when the accumulated buffer has at least one
    // substantive (non-filler) word. Pure fillers ("uh", "uh um") keep
    // accumulating until the speaker says something real, then fire as one
    // combined turn ("uh\num\nOpenAI just released...").
    isReady: (text) => !isTrivialTranscript(text),
    runTurn: async (transcript) => {
      if (state.mode !== "live") return;
      // Wait for any in-flight prompt-cache warmup so the cache is primed
      // before we send the first real transcript turn through.
      try { await state.warmupPromise; } catch { /* warmup errors are logged elsewhere */ }
      if (state.mode !== "live") return;
      state.agentBusy = true;
      publishAgentStatus();
      options.onAgentEvent?.({ type: "turn:start", transcript, timestamp: new Date().toISOString() });
      try {
        await runAgent({ transcript, state, wss, options });
        options.onAgentEvent?.({ type: "turn:end", transcript, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error("Whiteboard agent failed:", error);
        broadcast(wss, { type: "error", message: `Whiteboard agent failed: ${error.message}` });
        options.onAgentEvent?.({ type: "turn:error", transcript, error: error.message, timestamp: new Date().toISOString() });
      } finally {
        state.agentBusy = false;
        publishAgentStatus();
      }
    },
  });

  state.queueTranscript = (text) => queue.enqueue(text);
  state.idle = () => queue.idle();
  state.updateLatestScreenshot = (image) => {
    state.latestScreenshot = image;
    // A fresh screenshot means the canvas changed (either the agent just
    // edited or the user drew something pre-listening). Mark dirty so the
    // next agent turn includes it.
    state.canvasDirtyForAgent = true;
  };
  state.reset = () => {
    state.elements = seedElements();
    state.agentHistory = [];
    state.latestScreenshot = undefined;
  };
  state.startPreso = ({ primerMessage, agentInstructions = "" }) => {
    state.mode = "live";
    state.elements = seedElements();
    state.latestScreenshot = undefined;
    state.agentHistory = [primerMessage];
    state.agentInstructions = typeof agentInstructions === "string" ? agentInstructions : "";
    state.warmupPromise = Promise.resolve();
    state.canvasDirtyForAgent = false;
    // Reset warmup state for this preso. The startWarmupLoop call that follows
    // will publish the first "running" broadcast.
    state.warmupState = { state: "idle", attempt: 0, maxAttempts: DEFAULT_WARMUP_MAX_ATTEMPTS };
  };
  function publishWarmupState(next) {
    state.warmupState = { ...state.warmupState, ...next };
    broadcast(wss, { type: "warmup", ...state.warmupState });
  }

  state.startWarmupLoop = ({
    runOnce,
    delays = DEFAULT_WARMUP_DELAYS,
    maxAttempts = DEFAULT_WARMUP_MAX_ATTEMPTS,
    primingMessages = null,
  }) => {
    // Ignore overlapping calls. The previous loop must finish (or be cancelled)
    // before a new one starts, otherwise multiple loops would race for cache
    // confirmation on the same session.
    if (warmupRunning) return state.warmupPromise;

    warmupRunning = true;
    warmupCancelled = false;
    state.warmupBusy = true;
    publishAgentStatus();

    const promise = (async () => {
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (warmupCancelled) {
            publishWarmupState({ state: "cancelled", attempt: attempt - 1, maxAttempts });
            return;
          }
          publishWarmupState({ state: "running", attempt, maxAttempts });
          let cached = 0;
          let input = 0;
          try {
            const result = await runOnce({ attempt, maxAttempts });
            cached = Number(result?.usage?.cached) || 0;
            input = Number(result?.usage?.input) || 0;
          } catch (error) {
            // Swallow per-attempt errors; loop should still progress to the
            // next attempt. The actual error is logged by the caller.
            cached = 0;
            input = 0;
          }
          if (warmupCancelled) {
            publishWarmupState({ state: "cancelled", attempt, maxAttempts });
            return;
          }
          // Require >=50% of the prefix to be cached. A small `cached` value
          // (e.g., the static system+tools chunk only) doesn't mean the primer
          // and warmup_user prefix are primed, so keep retrying.
          if (input > 0 && cached >= input * 0.5) {
            publishWarmupState({ state: "confirmed", attempt, maxAttempts });
            return;
          }
          if (attempt >= maxAttempts) {
            publishWarmupState({ state: "exhausted", attempt, maxAttempts });
            return;
          }
          // Wait before the next attempt, but bail early if cancelled mid-sleep.
          const delay = delays[attempt - 1] ?? delays.at(-1) ?? 0;
          await sleepCancellable(delay, () => warmupCancelled);
        }
      } finally {
        // Append the priming pair AFTER all warmup attempts finish (regardless
        // of confirmed/exhausted/cancelled). This makes every subsequent turn's
        // request prefix start with the EXACT bytes warmup just wrote to cache:
        //   warmup wrote: [primer, warmup_user_msg]
        //   turn sends:   [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard]
        // Without this, turn 1 diverges from warmup at messages[1] and never
        // hits the cache that warmup just primed.
        if (Array.isArray(primingMessages) && primingMessages.length > 0) {
          state.agentHistory = [...state.agentHistory, ...primingMessages];
        }
        warmupRunning = false;
        state.warmupBusy = false;
        publishAgentStatus();
      }
    })();

    state.warmupPromise = promise;
    return promise;
  };

  state.cancelWarmup = () => {
    if (!warmupRunning) return;
    warmupCancelled = true;
  };

  state.backToStaging = () => {
    state.mode = "staging";
    state.cancelWarmup();
  };
  return state;
}

function sleepCancellable(ms, isCancelled) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isCancelled() || Date.now() - start >= ms) return resolve();
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}

export function broadcast(wss, message) {
  const serialized = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function seedElements() {
  // Live canvas starts blank. The user may draw on it before clicking Start
  // listening; those edits are pushed to the server via whiteboard:user-elements
  // and will be in state.elements by the first transcript turn.
  return [];
}
