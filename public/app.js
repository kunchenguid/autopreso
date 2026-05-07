import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";

import { STARTER_ELEMENTS } from "./starter-elements.js";
import { appendCommittedTranscript, scrollTranscriptToBottom } from "./transcript-panel.js";

const SAMPLE_RATE = 24000;

function App() {
  const [api, setApi] = React.useState(null);
  const [connected, setConnected] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [agentStatus, setAgentStatus] = React.useState("idle");
  const [transcriptionEngine, setTranscriptionEngine] = React.useState("loading");
  const [partial, setPartial] = React.useState("");
  const [committed, setCommitted] = React.useState([]);
  const [error, setError] = React.useState("");
  const sessionRef = React.useRef(null);
  const apiRef = React.useRef(null);
  const screenshotTimerRef = React.useRef(null);
  const transcriptRef = React.useRef(null);

  React.useEffect(() => {
    apiRef.current = api;
  }, [api]);

  React.useEffect(() => {
    return () => clearTimeout(screenshotTimerRef.current);
  }, []);

  React.useEffect(() => {
    if (!api) return;

    let cancelled = false;
    const refreshStarterScene = () => {
      if (!cancelled) updateScene(STARTER_ELEMENTS);
    };
    const timer = setTimeout(refreshStarterScene, 750);

    document.fonts?.ready.then(refreshStarterScene).catch(() => {});

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api]);

  React.useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config) => setTranscriptionEngine(config.transcriptionEngine))
      .catch((err) => setError(err.message));
  }, []);

  React.useEffect(() => {
    scrollTranscriptToBottom(transcriptRef.current);
  }, [committed, partial]);

  async function startListening() {
    if (listening || starting) return;
    setError("");
    setStarting(true);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    let media = null;
    let audio = null;

    ws.addEventListener("open", () => {
      setConnected(true);
      setListening(true);
      setStarting(false);
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "config") setTranscriptionEngine(message.transcriptionEngine);
      if (message.type === "transcript:partial") setPartial((message.text ?? "").trim());
      if (message.type === "transcript:committed") {
        setPartial("");
        setCommitted((items) => appendCommittedTranscript(items, message.text));
      }
      if (message.type === "agent:status") setAgentStatus(message.status);
      if (message.type === "whiteboard:update") updateScene(message.elements);
      if (message.type === "whiteboard:viewport") applyWhiteboardViewportCommand(message);
      if (message.type === "error") setError(message.message);
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setListening(false);
      setStarting(false);
      setAgentStatus("idle");
    });

    ws.addEventListener("error", () => {
      setError("WebSocket connection failed.");
      setStarting(false);
    });

    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audio = await createAudioStreamer(media, (audioBase64) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", audio: audioBase64 }));
        }
      });
    } catch (err) {
      setError(err.message);
      setStarting(false);
      ws.close();
      media?.getTracks().forEach((track) => track.stop());
      await audio?.close();
      return;
    }

    sessionRef.current = { ws, media, audio };
  }

  async function stopListening() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    session.ws.send(JSON.stringify({ type: "stop" }));
    session.ws.close();
    session.media.getTracks().forEach((track) => track.stop());
    await session.audio.close();
    setListening(false);
    setConnected(false);
    setPartial("");
    setAgentStatus("idle");
  }

  function toggleListening() {
    if (listening) stopListening();
    else startListening();
  }

  function updateScene(elements) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI || !Array.isArray(elements)) return;
    excalidrawAPI.updateScene({
      elements: convertToExcalidrawElements(elements),
      appState: { viewBackgroundColor: "#fffdf8" },
    });
    scheduleWhiteboardScreenshot();
  }

  function applyWhiteboardViewportCommand(command) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) return;

    const action = command.action;
    if (action === "scroll_to_content") {
      excalidrawAPI.scrollToContent(undefined, { animate: true });
    }
    if (action === "set_zoom") {
      setWhiteboardZoom(command.zoom);
    }
    if (action === "zoom_in") {
      setWhiteboardZoom(currentWhiteboardZoom() * 1.2);
    }
    if (action === "zoom_out") {
      setWhiteboardZoom(currentWhiteboardZoom() / 1.2);
    }
    if (action === "reset_zoom") {
      setWhiteboardZoom(1);
    }
    scheduleWhiteboardScreenshot();
  }

  function currentWhiteboardZoom() {
    return apiRef.current?.getAppState().zoom?.value ?? 1;
  }

  function setWhiteboardZoom(zoom) {
    const zoomValue = Math.min(3, Math.max(0.1, Number(zoom) || 1));
    apiRef.current?.updateScene({ appState: { zoom: { value: zoomValue } } });
  }

  function scheduleWhiteboardScreenshot() {
    clearTimeout(screenshotTimerRef.current);
    screenshotTimerRef.current = setTimeout(sendWhiteboardScreenshot, 500);
  }

  async function sendWhiteboardScreenshot() {
    const excalidrawAPI = apiRef.current;
    const ws = sessionRef.current?.ws;
    if (!excalidrawAPI || ws?.readyState !== WebSocket.OPEN) return;

    try {
      const canvas = document.querySelector("canvas.excalidraw__canvas.static");
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      ws.send(JSON.stringify({ type: "whiteboard:screenshot", image: await blobToDataUrl(blob) }));
    } catch (error) {
      console.warn("Failed to export whiteboard screenshot:", error);
    }
  }

  return React.createElement(
    "main",
    { className: "shell" },
    React.createElement(
      "section",
      { className: "canvas-wrap" },
      React.createElement(Excalidraw, {
        excalidrawAPI: setApi,
        initialData: {
          elements: convertToExcalidrawElements(STARTER_ELEMENTS),
          appState: { viewBackgroundColor: "#fffdf8" },
        },
      }),
    ),
    React.createElement(
      "aside",
      { className: "panel" },
      React.createElement(
        "div",
        { className: "brand" },
        React.createElement("h1", null, "AutoPreso"),
        React.createElement("p", null, "Talk through an idea and let the whiteboard keep up."),
      ),
      React.createElement(
        "div",
        { className: "controls" },
        React.createElement(
          "button",
          {
            className: `record-toggle ${listening ? "recording" : ""}`,
            onClick: toggleListening,
            disabled: starting,
          },
          React.createElement("span", { className: "record-icon" }, listening ? "■" : "●"),
          " ",
          listening ? "Stop" : starting ? "Starting..." : "Start listening",
        ),
      ),
      React.createElement(
        "div",
        { className: "status-card" },
        statusRow("Mic", React.createElement("span", { className: "pill" }, React.createElement("span", { className: `dot ${listening ? "live" : ""}` }), listening ? "Listening" : "Stopped")),
        statusRow("Socket", connected ? "Connected" : "Disconnected"),
        statusRow("Agent", React.createElement("span", { className: "pill" }, React.createElement("span", { className: `dot ${agentStatus === "thinking" ? "busy" : ""}` }), agentStatus)),
        statusRow("STT engine", transcriptionEngine),
      ),
      error ? React.createElement("div", { className: "error" }, error) : null,
      React.createElement(
        "div",
        { className: "transcript-card" },
        React.createElement("h2", null, "Live Transcript"),
        React.createElement(
          "div",
          { className: "committed", ref: transcriptRef },
          committed.length === 0 && !partial ? React.createElement("p", { className: "partial empty" }, "Partial transcript will appear here.") : null,
          committed.map((text, index) => React.createElement("p", { key: `${index}:${text}` }, text)),
          partial ? React.createElement("p", { className: "partial" }, partial) : null,
        ),
      ),
    ),
  );
}

function statusRow(label, value) {
  return React.createElement(
    "div",
    { className: "status-row" },
    React.createElement("span", { className: "label" }, label),
    React.createElement("span", { className: "value" }, value),
  );
}

async function createAudioStreamer(media, onChunk) {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let carry = new Float32Array(0);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resample(input, context.sampleRate, SAMPLE_RATE, carry);
    carry = resampled.carry;
    if (resampled.samples.length > 0) {
      onChunk(pcm16ToBase64(resampled.samples));
    }
  };

  source.connect(processor);
  processor.connect(context.destination);

  return {
    close: async () => {
      processor.disconnect();
      source.disconnect();
      await context.close();
    },
  };
}

function resample(input, fromRate, toRate, carry) {
  const merged = new Float32Array(carry.length + input.length);
  merged.set(carry);
  merged.set(input, carry.length);

  const ratio = fromRate / toRate;
  const outputLength = Math.floor((merged.length - 1) / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, merged.length - 1);
    const weight = sourceIndex - left;
    output[index] = merged[left] * (1 - weight) + merged[right] * weight;
  }

  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: merged.slice(consumed) };
}

function pcm16ToBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas screenshot export failed."));
    }, "image/png");
  });
}

createRoot(document.getElementById("app")).render(React.createElement(App));
