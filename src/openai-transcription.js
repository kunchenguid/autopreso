import { WebSocket } from "ws";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

export function createOpenAITranscription({
  sendTranscript,
  queueTranscript,
  options,
  env = process.env,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
}) {
  let socket = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let configured = false;
  let pendingAudio = [];
  let partialText = "";
  let bufferedSinceCommit = false;

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
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: options.openaiTranscriptionModel },
            },
          },
        },
      }));
      for (const audio of pendingAudio) {
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      }
      pendingAudio = [];
    });

    socket.on("message", (raw) => {
      handleSocketMessage(raw.toString("utf8"), {
        sendTranscript,
        queueTranscript,
        onReady: () => resolveReady?.(),
        getPartial: () => partialText,
        setPartial: (value) => { partialText = value; },
        onBufferDrained: () => { bufferedSinceCommit = false; },
      });
    });

    socket.on("error", (error) => {
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    socket.on("close", () => {
      rejectReady?.(new Error("OpenAI realtime socket closed before it was ready."));
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
    stop: () => {
      if (!socket || !configured) return;
      // If server-side VAD already auto-committed (or no audio was sent), skip the manual
      // commit - OpenAI rejects commits on empty buffers with "buffer too small".
      if (!bufferedSinceCommit) return;
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      bufferedSinceCommit = false;
    },
    close: () => {
      if (!socket) return;
      socket.close();
      socket = null;
    },
  };
}

function handleSocketMessage(line, { sendTranscript, queueTranscript, onReady, getPartial, setPartial, onBufferDrained }) {
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
    return;
  }

  if (message.type === "conversation.item.input_audio_transcription.completed") {
    const text = message.transcript ?? "";
    setPartial("");
    onBufferDrained?.();
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
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
