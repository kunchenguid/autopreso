import { WebSocket } from "ws";

import { buildTranscriptionVocabularyPrompt } from "./whiteboard-keywords.js";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

// Models that reject the `prompt` parameter. For these we silently skip
// vocabulary biasing rather than failing the whole session.update.
// (Verified empirically via scripts/probe-openai-realtime.js - gpt-realtime-whisper
// returns "The 'prompt' parameter is not supported for this model".)
const MODELS_WITHOUT_PROMPT_SUPPORT = new Set(["gpt-realtime-whisper"]);

// We don't trust transcription.completed to drive agent turns. Some models
// (notably gpt-realtime-whisper) wipe turn_detection on every session.update,
// so server-VAD never auto-commits and completed never fires until the user
// clicks Stop. Instead, we drive turns purely from delta arrival timing:
// when no new delta arrives within DEFAULT_DELTA_QUIET_MS, the accumulated
// partial is queued as one turn. This is provider-agnostic and reacts
// faster than waiting for completed (saves an API roundtrip per utterance).
//
// This is the *only* debounce in the transcript path - the turn queue runs
// straight-through. 1000ms is long enough to ride through typical
// mid-sentence breaths without splitting one thought into multiple turns.
const DEFAULT_DELTA_QUIET_MS = 1000;

function buildTranscriptionSession(model, vocabularyPrompt, { includeEmptyPrompt = false } = {}) {
  const transcription = { model };
  if (!MODELS_WITHOUT_PROMPT_SUPPORT.has(model)) {
    if (vocabularyPrompt) transcription.prompt = vocabularyPrompt;
    else if (includeEmptyPrompt) transcription.prompt = "";
  }
  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription,
      },
    },
  };
}

export function createOpenAITranscription({
  sendTranscript,
  queueTranscript,
  options,
  env = process.env,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
  log = console,
}) {
  let socket = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let configured = false;
  let pendingAudio = [];
  let partialText = "";
  let bufferedSinceCommit = false;
  let vocabularyPrompt = "";
  let deltaQuietTimer = null;
  const deltaQuietMs = Number.isFinite(options.openaiDeltaQuietMs)
    ? options.openaiDeltaQuietMs
    : DEFAULT_DELTA_QUIET_MS;

  function cancelDeltaQuietTimer() {
    if (deltaQuietTimer) {
      clearTimeout(deltaQuietTimer);
      deltaQuietTimer = null;
    }
  }

  // Drain the accumulated partial as one agent turn. Idempotent: if the
  // partial is empty (already flushed), do nothing.
  function flushPartialAsTurn() {
    cancelDeltaQuietTimer();
    const text = partialText.trim();
    if (!text) return;
    partialText = "";
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
    // Commit OpenAI's audio buffer so the next utterance's deltas start
    // from a clean state (otherwise the buffer would grow without bound and
    // delta semantics could drift).
    if (socket && configured && bufferedSinceCommit) {
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      bufferedSinceCommit = false;
    }
  }

  function scheduleDeltaQuietFlush() {
    cancelDeltaQuietTimer();
    if (deltaQuietMs <= 0) return;
    deltaQuietTimer = setTimeout(() => {
      deltaQuietTimer = null;
      flushPartialAsTurn();
    }, deltaQuietMs);
  }

  function ensureSocket() {
    if (socket) return socket;

    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI transcription provider.");
    }

    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    socket = createWebSocket(REALTIME_URL, undefined, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    socket.on("open", () => {
      configured = true;
      socket.send(JSON.stringify({
        type: "session.update",
        session: buildTranscriptionSession(options.openaiTranscriptionModel, vocabularyPrompt),
      }));
      for (const audio of pendingAudio) {
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      }
      pendingAudio = [];
    });

    socket.on("message", (raw) => {
      handleSocketMessage(raw.toString("utf8"), {
        sendTranscript,
        getPartial: () => partialText,
        setPartial: (value) => { partialText = value; },
        onReady: () => resolveReady?.(),
        onBufferDrained: () => {
          bufferedSinceCommit = false;
        },
        onDelta: () => {
          // Re-arm the quiet timer on every delta. When deltas stop arriving
          // for deltaQuietMs, flushPartialAsTurn fires and the agent runs.
          if (partialText) scheduleDeltaQuietFlush();
        },
        onCompleted: () => {
          // Fallback: if our quiet timer hasn't fired yet (e.g., user clicked
          // Stop and the server's manual commit produced a completed event
          // before deltaQuietMs elapsed), drain whatever partial we still
          // have. flushPartialAsTurn is idempotent.
          flushPartialAsTurn();
        },
      });
    });

    socket.on("error", (error) => {
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    socket.on("close", () => {
      rejectReady?.(new Error("OpenAI realtime socket closed before it was ready."));
      cancelDeltaQuietTimer();
      socket = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
      configured = false;
      pendingAudio = [];
      partialText = "";
      bufferedSinceCommit = false;
    });

    return socket;
  }

  return {
    ready: async () => {
      try {
        ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        throw error;
      }
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      let connection;
      try {
        connection = ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      if (!configured) {
        pendingAudio.push(audio);
        bufferedSinceCommit = true;
        return;
      }
      connection.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      bufferedSinceCommit = true;
    },
    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      const keywords = ctx?.keywords ?? [];
      const prompt = buildTranscriptionVocabularyPrompt(keywords);
      // Empty input + nothing to clear: bail. Empty input + a previously
      // pushed prompt: fall through and emit a clearing session.update.
      if (!prompt && !vocabularyPrompt) return;
      if (prompt === vocabularyPrompt) return;
      vocabularyPrompt = prompt;
      if (prompt) {
        log.debug?.(`[openai-transcription] vocabulary prompt set (${keywords.length} terms, ${prompt.length} chars)`);
      } else {
        log.debug?.(`[openai-transcription] vocabulary prompt cleared`);
      }
      if (!socket || !configured) return;
      // Re-state audio.input.format on every follow-up so a partial update
      // can't accidentally wipe it. Pass includeEmptyPrompt: true so we can
      // clear a previously-set prompt by sending an explicit empty string.
      socket.send(JSON.stringify({
        type: "session.update",
        session: buildTranscriptionSession(options.openaiTranscriptionModel, vocabularyPrompt, { includeEmptyPrompt: true }),
      }));
    },
    stop: () => {
      // Stop is a hard signal that the user wants whatever they've said
      // queued NOW. Flush any pending partial as a turn (idempotent), and
      // make sure the OpenAI buffer is committed if we still hold audio.
      flushPartialAsTurn();
      if (!socket || !configured) return;
      if (!bufferedSinceCommit) return;
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      bufferedSinceCommit = false;
    },
    close: () => {
      cancelDeltaQuietTimer();
      if (!socket) return;
      socket.close();
      socket = null;
    },
  };
}

function handleSocketMessage(line, { sendTranscript, getPartial, setPartial, onReady, onBufferDrained, onDelta, onCompleted }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid OpenAI realtime message: ${line}` });
    return;
  }

  if (
    message.type === "transcription_session.created" ||
    message.type === "transcription_session.updated" ||
    message.type === "session.created" ||
    message.type === "session.updated"
  ) {
    onReady?.();
    return;
  }

  if (message.type === "conversation.item.input_audio_transcription.delta") {
    const next = getPartial() + (message.delta ?? "");
    setPartial(next);
    sendTranscript({ type: "transcript:partial", text: next });
    onDelta?.();
    return;
  }

  if (message.type === "conversation.item.input_audio_transcription.completed") {
    // We do NOT use completed to drive agent turns - delta-quiet does that.
    // completed is a fallback for the rare case where deltas stopped without
    // our quiet timer having fired (e.g., Stop click). Pass to onCompleted
    // which calls flushPartialAsTurn (idempotent).
    onBufferDrained?.();
    onCompleted?.();
    return;
  }

  // Server VAD commits the buffer well before transcription completes, and
  // discards silent audio outright. Track the actual buffer state from this
  // signal so a later stop() doesn't try to commit an empty buffer.
  if (message.type === "input_audio_buffer.committed") {
    onBufferDrained?.();
    return;
  }

  if (message.type === "error") {
    // input_audio_buffer_commit_empty is a benign race: server VAD already
    // drained (or discarded silent audio) before our manual commit landed.
    // Don't surface it to the UI.
    if (message.error?.code === "input_audio_buffer_commit_empty") return;
    sendTranscript({ type: "error", message: message.error?.message ?? "OpenAI realtime error" });
  }
}
