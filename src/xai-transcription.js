import { WebSocket } from "ws";

const XAI_STT_URL = "wss://api.x.ai/v1/stt";
const SAMPLE_RATE = 24000;
const DEFAULT_LANGUAGE = "en";
export const DEFAULT_XAI_SMART_TURN_TIMEOUT_MS = 1_200;

export function createXAITranscription({
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
  let lastPartialText = "";
  let lastCommittedText = "";
  let doneSent = false;
  let sessionContext = { keywords: [] };

  function buildURL() {
    const url = new URL(XAI_STT_URL);
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    url.searchParams.set("encoding", "pcm");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("language", normalizeLanguage(options.xaiSttLanguage));
    url.searchParams.set("smart_turn", "0.7");
    url.searchParams.set("smart_turn_timeout", String(normalizeSmartTurnTimeoutMs(options.xaiSttSmartTurnTimeoutMs)));
    for (const keyword of normalizeKeywords(sessionContext.keywords)) {
      url.searchParams.append("keyterm", keyword);
    }
    return url.toString();
  }

  function resetSocketState() {
    socket = null;
    readyPromise = null;
    resolveReady = null;
    rejectReady = null;
    configured = false;
    pendingAudio = [];
    doneSent = false;
    lastPartialText = "";
    lastCommittedText = "";
  }

  function detachSocket() {
    if (!socket) return null;
    const previous = socket;
    socket = null;
    readyPromise = null;
    resolveReady = null;
    rejectReady = null;
    configured = false;
    pendingAudio = [];
    doneSent = false;
    lastPartialText = "";
    lastCommittedText = "";
    return previous;
  }

  function ensureSocket() {
    if (socket && !doneSent) return socket;

    if (socket && doneSent) {
      const previous = detachSocket();
      previous?.close();
    }

    const apiKey = env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI_API_KEY is required for the xAI transcription provider.");
    }

    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const nextSocket = createWebSocket(buildURL(), undefined, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    socket = nextSocket;

    nextSocket.on("message", (raw) => {
      if (socket !== nextSocket) return;
      handleSocketMessage(raw.toString("utf8"), {
        sendTranscript,
        queueTranscript,
        getLastPartial: () => lastPartialText,
        setLastPartial: (value) => { lastPartialText = value; },
        getLastCommitted: () => lastCommittedText,
        setLastCommitted: (value) => { lastCommittedText = value; },
        onReady: () => {
          if (socket !== nextSocket) return;
          configured = true;
          for (const audio of pendingAudio) nextSocket.send(audio);
          pendingAudio = [];
          resolveReady?.();
        },
      });
    });

    nextSocket.on("error", (error) => {
      if (socket !== nextSocket) return;
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    nextSocket.on("close", () => {
      if (socket !== nextSocket) return;
      rejectReady?.(new Error("xAI STT socket closed before it was ready."));
      resetSocketState();
    });

    return socket;
  }

  function flushPartialAsTurn() {
    const text = lastPartialText.trim();
    if (!text || text === lastCommittedText) return;
    lastCommittedText = text;
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  function sendDone() {
    if (!socket || !configured || doneSent) return;
    doneSent = true;
    socket.send(JSON.stringify({ type: "audio.done" }));
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
      const buffer = Buffer.from(audio, "base64");
      if (!configured) {
        pendingAudio.push(buffer);
        return;
      }
      connection.send(buffer);
    },
    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      const next = { keywords: ctx?.keywords ?? [] };
      const unchanged = JSON.stringify(normalizeKeywords(next.keywords)) === JSON.stringify(normalizeKeywords(sessionContext.keywords));
      sessionContext = next;
      if (unchanged) return;
      if (socket) {
        log.debug?.("[xai-transcription] session context changed; reconnecting STT websocket");
        const previous = detachSocket();
        previous?.close();
      }
    },
    stop: () => {
      flushPartialAsTurn();
      sendDone();
    },
    close: () => {
      if (!socket) return;
      const previous = detachSocket();
      previous?.close();
    },
  };
}

function handleSocketMessage(line, { sendTranscript, queueTranscript, getLastPartial, setLastPartial, getLastCommitted, setLastCommitted, onReady }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid xAI STT message: ${line}` });
    return;
  }

  if (message.type === "transcript.created") {
    onReady?.();
    return;
  }

  if (message.type === "transcript.partial") {
    const text = (message.text ?? "").trim();
    if (text) {
      setLastPartial(text);
      sendTranscript({ type: "transcript:partial", text });
    }
    if (message.speech_final && text && text !== getLastCommitted()) {
      setLastCommitted(text);
      sendTranscript({ type: "transcript:committed", text });
      queueTranscript(text);
    }
    return;
  }

  if (message.type === "transcript.done") {
    const text = (message.text ?? getLastPartial()).trim();
    if (text && text !== getLastCommitted()) {
      setLastCommitted(text);
      sendTranscript({ type: "transcript:committed", text });
      queueTranscript(text);
    }
    return;
  }

  if (message.type === "error") {
    sendTranscript({ type: "error", message: message.message ?? message.error?.message ?? "xAI STT error" });
  }
}

function normalizeLanguage(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_LANGUAGE;
}

function normalizeSmartTurnTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_XAI_SMART_TURN_TIMEOUT_MS;
  return Math.min(5_000, Math.max(300, Math.round(numeric)));
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
    .filter((keyword) => keyword.length > 0)
    .slice(0, 100)
    .map((keyword) => keyword.slice(0, 50));
}
