import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";

import { STARTER_ELEMENTS } from "./starter-elements.js";

const SAMPLE_RATE = 24000;
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const OPENAI_AGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const CODEX_AGENT_MODELS = ["gpt-5.5-fast", "gpt-5.5", "gpt-5.4"];
const OPENAI_TRANSCRIPTION_MODELS = [
  "gpt-realtime-whisper",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
];
const MOONSHINE_MODELS = ["tiny", "small", "medium"];
const MIC_STORAGE_KEY = "autopreso.mic";

const STARTER_STAGING_ELEMENTS = [];

function fullscreenIcon(isFullscreen) {
  const paths = isFullscreen
    ? ["M3 6 H6 V3", "M10 3 V6 H13", "M13 10 H10 V13", "M6 13 V10 H3"]
    : ["M3 6 V3 H6", "M10 3 H13 V6", "M13 10 V13 H10", "M6 13 H3 V10"];
  return React.createElement(
    "svg",
    {
      width: "1em",
      height: "1em",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...paths.map((d, i) => React.createElement("path", { key: i, d })),
  );
}

function loadStoredMic() {
  try {
    const raw = localStorage.getItem(MIC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { deviceId: "", label: "" };
  } catch {
    return { deviceId: "", label: "" };
  }
}

function saveStoredMic(mic) {
  localStorage.setItem(MIC_STORAGE_KEY, JSON.stringify(mic));
}

function App() {
  const [api, setApi] = React.useState(null);
  const [mode, setMode] = React.useState("staging");
  const [listening, setListening] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [presoStarting, setPresoStarting] = React.useState(false);
  const [agentStatus, setAgentStatus] = React.useState("idle");
  const [transcriptionEngine, setTranscriptionEngine] =
    React.useState("loading");
  const [settings, setSettings] = React.useState(null);
  const [captionText, setCaptionText] = React.useState("");
  const [error, setError] = React.useState("");
  const [micError, setMicError] = React.useState(false);
  const [agentError, setAgentError] = React.useState(false);
  const [sttError, setSttError] = React.useState(false);
  const [expandedRow, setExpandedRow] = React.useState(null);
  const [mic, setMic] = React.useState(loadStoredMic);
  const [analyser, setAnalyser] = React.useState(null);
  const [resetConfirming, setResetConfirming] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  // warmupState: { state: "idle"|"running"|"confirmed"|"exhausted"|"cancelled", attempt, maxAttempts }
  const [warmupState, setWarmupState] = React.useState({
    state: "idle",
    attempt: 0,
    maxAttempts: 8,
  });
  const [agentInstructions, setAgentInstructionsValue] = React.useState("");
  const [cost, setCost] = React.useState(null);
  const audioSessionRef = React.useRef(null);
  const apiRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const modeRef = React.useRef("staging");
  const stagingSceneRef = React.useRef(null);
  const screenshotTimerRef = React.useRef(null);
  const captionTimerRef = React.useRef(null);
  const resetConfirmTimerRef = React.useRef(null);
  const canvasWrapRef = React.useRef(null);
  const shellRef = React.useRef(null);
  const userElementsSyncTimerRef = React.useRef(null);
  const lastSyncedElementsHashRef = React.useRef("");
  const listeningRef = React.useRef(false);
  // Seed the textarea once from settings, then let the user own it locally so
  // their keystrokes don't fight the WS settings broadcast we trigger on save.
  const agentInstructionsSeededRef = React.useRef(false);
  const agentInstructionsSaveTimerRef = React.useRef(null);
  const agentInstructionsSavePromiseRef = React.useRef(Promise.resolve());

  React.useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  React.useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      shellRef.current?.requestFullscreen?.();
    }
  }

  React.useEffect(() => {
    apiRef.current = api;
  }, [api]);

  React.useEffect(() => {
    return () => {
      clearTimeout(screenshotTimerRef.current);
      clearTimeout(captionTimerRef.current);
      clearTimeout(resetConfirmTimerRef.current);
      clearTimeout(userElementsSyncTimerRef.current);
      clearTimeout(agentInstructionsSaveTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (agentInstructionsSeededRef.current) return;
    if (!settings || typeof settings.agentInstructions !== "string") return;
    setAgentInstructionsValue(settings.agentInstructions);
    agentInstructionsSeededRef.current = true;
  }, [settings]);

  function handleAgentInstructionsChange(value) {
    setAgentInstructionsValue(value);
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = setTimeout(() => {
      agentInstructionsSaveTimerRef.current = null;
      agentInstructionsSavePromiseRef.current = saveSettings({
        agentInstructions: value,
      }).catch((err) => setError(err.message));
    }, 600);
  }

  async function flushAgentInstructionsSave() {
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = null;
    await agentInstructionsSavePromiseRef.current;
    agentInstructionsSavePromiseRef.current = saveSettings({
      agentInstructions,
    });
    await agentInstructionsSavePromiseRef.current;
  }

  function handleExcalidrawChange(elements) {
    // Only push user edits to the server while in live mode. In staging the
    // canvas is a client-side scratchpad; the server doesn't need to know.
    if (modeRef.current !== "live") return;
    // Once listening starts, the agent owns the canvas. Echoing user-elements
    // back creates an ID-rotation feedback loop: applyScene re-runs
    // convertToExcalidrawElements, which assigns fresh IDs, which propagate
    // back via onChange, which break the agent's cache prefix and confuse
    // line-numbered references. Sync only during the pre-listen window.
    if (listeningRef.current) return;
    clearTimeout(userElementsSyncTimerRef.current);
    userElementsSyncTimerRef.current = setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const cleaned = nativeElementsToSkeletonForSync(elements ?? []);
      const hash = JSON.stringify(cleaned);
      if (hash === lastSyncedElementsHashRef.current) return;
      lastSyncedElementsHashRef.current = hash;
      ws.send(
        JSON.stringify({ type: "whiteboard:user-elements", elements: cleaned }),
      );
    }, 500);
  }

  // Persistent WebSocket connection for the lifetime of the app.
  React.useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "config")
        setTranscriptionEngine(message.transcriptionEngine);
      if (message.type === "settings") setSettings(message.settings);
      if (message.type === "transcript:partial") {
        const text = (message.text ?? "").trim();
        if (text) {
          clearTimeout(captionTimerRef.current);
          setCaptionText(text);
        }
      }
      if (message.type === "transcript:committed") {
        const text = (message.text ?? "").trim();
        if (text) {
          clearTimeout(captionTimerRef.current);
          setCaptionText(text);
          captionTimerRef.current = setTimeout(() => setCaptionText(""), 3500);
        }
      }
      if (message.type === "agent:status") {
        setAgentStatus(message.status);
        if (message.status === "thinking") setAgentError(false);
      }
      if (message.type === "warmup") {
        setWarmupState({
          state: message.state,
          attempt: message.attempt ?? 0,
          maxAttempts: message.maxAttempts ?? 8,
        });
      }
      if (message.type === "cost") {
        setCost({ agent: message.agent, transcription: message.transcription });
      }
      if (message.type === "mode") {
        const previousMode = modeRef.current;
        modeRef.current = message.mode;
        setMode(message.mode);
        if (message.mode === "staging" && previousMode === "live") {
          // Returning from live: restore the staged canvas the user was last working on.
          applyScene(stagingSceneRef.current, { recenter: true });
        }
      }
      if (message.type === "whiteboard:update") {
        // Recenter when the live canvas resets to a fresh starter (Start preso, Reset session).
        const isFreshStarter =
          Array.isArray(message.elements) &&
          message.elements.length <= STARTER_ELEMENTS.length + 1;
        applyScene(message.elements, { recenter: isFreshStarter });
      }
      if (message.type === "whiteboard:viewport")
        applyWhiteboardViewportCommand(message);
      if (message.type === "error") {
        setError(message.message);
        if (/agent/i.test(message.message)) setAgentError(true);
        else setSttError(true);
      }
    });

    ws.addEventListener("close", () => {
      setListening(false);
      setStarting(false);
      setAgentStatus("idle");
    });

    ws.addEventListener("error", () => {
      setError("Lost connection to the server.");
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  // Seed the staging scene ref and the initial canvas once Excalidraw is ready.
  React.useEffect(() => {
    if (!api) return;
    if (!stagingSceneRef.current) {
      stagingSceneRef.current = convertToExcalidrawElements(
        STARTER_STAGING_ELEMENTS,
        { regenerateIds: false },
      );
    }
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      if (modeRef.current === "staging")
        applyScene(stagingSceneRef.current, { recenter: true });
    };
    const timer = setTimeout(refresh, 750);
    document.fonts?.ready.then(refresh).catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api]);

  React.useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config) => {
        setTranscriptionEngine(config.transcriptionEngine);
        if (config.settings) setSettings(config.settings);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function saveSettings(patch) {
    setError("");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to save settings");
    setSettings(body.settings);
    setTranscriptionEngine(body.transcriptionEngine);
    setSttError(false);
    setAgentError(false);
  }

  async function cancelWarmup() {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "warmup:cancel" }));
    }
  }

  async function startAnyway() {
    // One-click: cancel the warmup loop and start listening right away. The
    // first turn may be slower (cold cache), but the user explicitly opted in.
    await cancelWarmup();
    await startListening();
  }

  async function startListening() {
    if (listening || starting) return;
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection not ready yet.");
      return;
    }
    setError("");
    setMicError(false);
    setSttError(false);
    setStarting(true);

    let media = null;
    let audio = null;
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (mic.deviceId) audioConstraints.deviceId = { exact: mic.deviceId };
      media = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      const audioSessionId = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "audio:start", sessionId: audioSessionId }));
      audio = await createAudioStreamer(media, (audioBase64) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", sessionId: audioSessionId, audio: audioBase64 }));
        }
      });
      setAnalyser(audio.analyser);
      audioSessionRef.current = { media, audio, id: audioSessionId };
      setListening(true);
      setStarting(false);
    } catch (err) {
      setError(err.message);
      setMicError(true);
      setStarting(false);
      media?.getTracks().forEach((track) => track.stop());
      await audio?.close();
    }
  }

  async function stopListening() {
    const session = audioSessionRef.current;
    audioSessionRef.current = null;
    if (!session) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop", sessionId: session.id }));
    }
    session.media.getTracks().forEach((track) => track.stop());
    await session.audio.close();
    setAnalyser(null);
    setListening(false);
    setCaptionText("");
    clearTimeout(captionTimerRef.current);
    setAgentStatus("idle");
  }

  function toggleListening() {
    if (listening) stopListening();
    else startListening();
  }

  async function startPreso() {
    if (presoStarting) return;
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) {
      setError("Canvas isn't ready yet.");
      return;
    }
    setError("");
    setPresoStarting(true);
    try {
      await flushAgentInstructionsSave();
      // Snapshot what the user has on the staging canvas right now.
      const stagingNative = excalidrawAPI
        .getSceneElements()
        .map((el) => ({ ...el }));
      stagingSceneRef.current = stagingNative;
      // Convert to the lean skeleton format before sending to the server. The
      // primer JSON is part of the cached prefix, so trimming volatile fields
      // (versionNonce, seed, internal binding details, etc.) shrinks the cold
      // turn footprint substantially without hurting the agent's understanding
      // of the staging layout.
      const stagingSkeleton = nativeElementsToSkeletonForSync(stagingNative);
      // Capture the full staging scene as an image so the primer carries it.
      let stagingScreenshot;
      try {
        stagingScreenshot = await captureStagingSceneAsImage(
          excalidrawAPI,
          stagingNative,
        );
      } catch (err) {
        console.warn(
          "Failed to capture staging screenshot, sending text-only primer:",
          err,
        );
      }

      const res = await fetch("/api/preso/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stagingElements: stagingSkeleton,
          stagingScreenshot,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Start preso failed (${res.status})`);
      }
      // Server broadcasts mode=live and whiteboard:update; the WS handler swaps the canvas.
    } catch (err) {
      setError(err.message);
    } finally {
      setPresoStarting(false);
    }
  }

  async function backToStaging() {
    setError("");
    if (listening) await stopListening();
    try {
      const res = await fetch("/api/preso/back-to-staging", { method: "POST" });
      if (!res.ok) throw new Error(`Back to staging failed (${res.status})`);
      // Server broadcasts mode=staging; the WS handler restores the staged scene.
    } catch (err) {
      setError(err.message);
    }
  }

  function handleResetClick() {
    if (resetting) return;
    if (!resetConfirming) {
      setResetConfirming(true);
      resetConfirmTimerRef.current = setTimeout(
        () => setResetConfirming(false),
        3000,
      );
      return;
    }
    clearTimeout(resetConfirmTimerRef.current);
    setResetConfirming(false);
    resetSession();
  }

  async function resetSession() {
    setResetting(true);
    setError("");
    try {
      if (modeRef.current === "staging") {
        // Staging board lives on the client - just reload the starter content.
        const fresh = convertToExcalidrawElements(STARTER_STAGING_ELEMENTS, {
          regenerateIds: false,
        });
        stagingSceneRef.current = fresh;
        applyScene(fresh);
      } else {
        if (listening) await stopListening();
        clearTimeout(captionTimerRef.current);
        setCaptionText("");
        const res = await fetch("/api/session/reset", { method: "POST" });
        if (!res.ok) throw new Error(`Reset failed (${res.status})`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  }

  function applyScene(elements, { recenter = false } = {}) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI || !Array.isArray(elements)) return;
    const looksNative =
      elements.length > 0 &&
      elements[0] &&
      typeof elements[0].versionNonce === "number";
    // CRITICAL: regenerateIds: false. Excalidraw's default is to throw away
    // user-provided ids and assign fresh nanoids. The agent references its
    // elements by stable ids (e.g. "openai-card") in whiteboard_viewport's
    // focus_ids; if we let Excalidraw rewrite them, the frontend's
    // scene.filter(el => focusIds.includes(el.id)) finds nothing and
    // scrollToContent silently fits the full canvas instead.
    const renderable = looksNative
      ? elements
      : convertToExcalidrawElements(elements, { regenerateIds: false });
    excalidrawAPI.updateScene({
      elements: renderable,
      appState: { viewBackgroundColor: "#fffdf8" },
    });
    if (recenter && renderable.length > 0) {
      // Defer so updateScene's commit is flushed before scrollToContent measures bounds.
      requestAnimationFrame(() =>
        excalidrawAPI.scrollToContent(undefined, { animate: false }),
      );
    }
    scheduleWhiteboardScreenshot();
  }

  function applyWhiteboardViewportCommand(command) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) return;

    const action = command.action;
    if (action === "scroll_to_content") {
      const focusIds = Array.isArray(command.focus_ids)
        ? command.focus_ids
        : null;
      let target;
      if (focusIds && focusIds.length > 0) {
        const scene = excalidrawAPI.getSceneElements();
        const matched = scene.filter((el) => focusIds.includes(el.id));
        if (matched.length > 0) target = matched;
      }
      excalidrawAPI.scrollToContent(target, { animate: true });
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
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const dataUrl = await captureCanvasDataUrl();
      if (!dataUrl) return;
      ws.send(
        JSON.stringify({ type: "whiteboard:screenshot", image: dataUrl }),
      );
    } catch (error) {
      console.warn("Failed to export whiteboard screenshot:", error);
    }
  }

  async function captureCanvasDataUrl() {
    const canvas = document.querySelector("canvas.excalidraw__canvas.static");
    if (!canvas) return null;
    const blob = await canvasToBlob(canvas);
    const downscaled = await downscaleBlobByHalf(blob);
    return await blobToDataUrl(downscaled);
  }

  async function captureStagingSceneAsImage(excalidrawAPI, elements) {
    if (!Array.isArray(elements) || elements.length === 0) {
      // Empty staging - no scene to render. Skip the image entirely; the
      // server's primer already drops the image part when this is falsy.
      return null;
    }
    try {
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles?.() ?? {};
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: "#fffdf8",
        },
        files,
        mimeType: "image/png",
      });
      const downscaled = await downscaleBlobByHalf(blob);
      return await blobToDataUrl(downscaled);
    } catch (error) {
      console.warn(
        "Failed to export staging scene, falling back to viewport canvas:",
        error,
      );
      return captureCanvasDataUrl();
    }
  }

  const isLive = mode === "live";
  const micState = micError ? "error" : listening ? "active" : "idle";
  const agentState = agentError
    ? "error"
    : agentStatus === "thinking"
      ? "active"
      : "idle";
  const sttState = sttError ? "error" : listening ? "active" : "idle";
  const agentLabel = settings ? agentModelLabel(settings) : "loading...";
  const sttLabel = settings ? sttModelLabel(settings) : transcriptionEngine;
  const micLabel = mic.label || "System default";

  return React.createElement(
    "main",
    { className: `shell mode-${mode}`, ref: shellRef },
    React.createElement(
      "section",
      { className: "canvas-wrap", ref: canvasWrapRef },
      React.createElement(Excalidraw, {
        excalidrawAPI: setApi,
        initialData: {
          elements: convertToExcalidrawElements(STARTER_STAGING_ELEMENTS, {
            regenerateIds: false,
          }),
          appState: { viewBackgroundColor: "#fffdf8" },
        },
        onChange: handleExcalidrawChange,
      }),
      React.createElement(
        "div",
        {
          className: `stage-overlay ${(captionText || listening) && isLive ? "visible" : ""}`,
          "aria-hidden": "true",
        },
        captionText
          ? React.createElement(
              "div",
              {
                className: "caption-pill",
                role: "status",
                "aria-live": "polite",
              },
              truncateCaption(captionText),
            )
          : null,
        React.createElement(Waveform, { analyser, active: listening }),
      ),
    ),
    React.createElement(
      "aside",
      { className: "panel" },
      React.createElement(
        "div",
        { className: "brand" },
        React.createElement(
          "div",
          { className: "brand-row" },
          React.createElement("h1", null, "Auto Preso"),
          React.createElement(
            "div",
            {
              className: `mode-toggle mode-toggle-${mode}`,
              role: "group",
              "aria-label": "Mode",
            },
            React.createElement(
              "button",
              {
                type: "button",
                className: `mode-toggle-option ${mode === "staging" ? "active" : ""}`,
                onClick: () => {
                  if (mode !== "staging") backToStaging();
                },
                disabled: presoStarting,
                title: "Staging mode",
                "aria-pressed": mode === "staging",
              },
              "Staging",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: `mode-toggle-option ${mode === "live" ? "active" : ""}`,
                onClick: () => {
                  if (mode !== "live") startPreso();
                },
                disabled: presoStarting,
                title: presoStarting ? "Starting..." : "Preso mode",
                "aria-pressed": mode === "live",
              },
              presoStarting && mode === "staging" ? "..." : "Preso",
            ),
          ),
        ),
        React.createElement(
          "p",
          null,
          mode === "staging"
            ? "Drop keywords, diagrams, or images on the canvas. They will be used as reference during the preso."
            : "Just talk through your ideas. Let the agent whiteboard for you.",
        ),
      ),
      React.createElement(
        "div",
        { className: "controls" },
        mode === "staging"
          ? React.createElement(
              "button",
              {
                className: "start-preso",
                onClick: startPreso,
                disabled: presoStarting,
              },
              presoStarting ? "Starting..." : "Start Preso →",
            )
          : null,
        isLive
          ? React.createElement(
              "div",
              { className: "listen-controls" },
              React.createElement(
                "div",
                { className: "listen-row" },
                React.createElement(
                  "button",
                  {
                    className: `record-toggle ${listening ? "recording" : ""}`,
                    onClick: toggleListening,
                    disabled:
                      starting ||
                      (warmupState.state === "running" && !listening),
                    title:
                      warmupState.state === "running"
                        ? "Waiting for prompt cache to warm up"
                        : warmupState.state === "exhausted"
                          ? "Cache didn't fully prime; first turn may be slower"
                          : undefined,
                  },
                  React.createElement(
                    "span",
                    { className: "record-icon" },
                    listening ? "■" : "●",
                  ),
                  " ",
                  listening
                    ? "Stop"
                    : starting
                      ? "Starting..."
                      : warmupState.state === "running"
                        ? `Warming up... (${warmupState.attempt} / ${warmupState.maxAttempts})`
                        : "Start Talking",
                ),
                React.createElement(
                  "button",
                  {
                    className: "fullscreen-toggle",
                    onClick: toggleFullscreen,
                    title: isFullscreen
                      ? "Exit fullscreen (Esc)"
                      : "Fullscreen for screen sharing",
                    "aria-label": isFullscreen
                      ? "Exit fullscreen"
                      : "Enter fullscreen",
                  },
                  fullscreenIcon(isFullscreen),
                ),
              ),
              warmupState.state === "running" && !listening
                ? React.createElement(
                    "button",
                    {
                      className: "warmup-skip",
                      onClick: startAnyway,
                      title:
                        "Skip warmup and start listening now. The first turn may be slower.",
                    },
                    "Start Anyway →",
                  )
                : null,
              warmupState.state === "exhausted" && !listening
                ? React.createElement(
                    "div",
                    { className: "warmup-warning" },
                    "Cache didn't fully prime. First turn may be slower.",
                  )
                : null,
            )
          : null,
        React.createElement(
          "button",
          {
            className: `reset-session ${resetConfirming ? "confirming" : ""}`,
            onClick: handleResetClick,
            disabled: resetting,
            title:
              mode === "staging"
                ? "Clear the staging area"
                : "Clear the whiteboard and start a new session",
          },
          resetting
            ? "Resetting..."
            : resetConfirming
              ? "Click again to reset"
              : mode === "staging"
                ? "Reset Staging"
                : "Reset Session",
        ),
      ),
      React.createElement(
        "div",
        { className: "status-card" },
        statusRow({
          dotState: micState,
          label: "Mic",
          value: micLabel,
          expanded: expandedRow === "mic",
          onToggle: () => setExpandedRow(expandedRow === "mic" ? null : "mic"),
          editor: React.createElement(MicEditor, {
            currentDeviceId: mic.deviceId,
            onSave: (next) => {
              setMic(next);
              saveStoredMic(next);
              setExpandedRow(null);
            },
            onCancel: () => setExpandedRow(null),
          }),
        }),
        statusRow({
          dotState: sttState,
          label: "Voice",
          value: sttLabel,
          expanded: expandedRow === "stt",
          onToggle: () => setExpandedRow(expandedRow === "stt" ? null : "stt"),
          editor: settings
            ? React.createElement(TranscriptionEditor, {
                settings,
                onSave: async (patch) => {
                  await saveSettings(patch);
                  setExpandedRow(null);
                },
                onCancel: () => setExpandedRow(null),
              })
            : null,
        }),
        statusRow({
          dotState: agentState,
          label: "Agent",
          value: agentLabel,
          expanded: expandedRow === "agent",
          onToggle: () =>
            setExpandedRow(expandedRow === "agent" ? null : "agent"),
          editor: settings
            ? React.createElement(AgentEditor, {
                settings,
                onSave: async (patch) => {
                  await saveSettings(patch);
                  setExpandedRow(null);
                },
                onCancel: () => setExpandedRow(null),
              })
            : null,
        }),
      ),
      isLive && cost ? React.createElement(CostCard, { cost }) : null,
      mode === "staging"
        ? React.createElement(
            "div",
            { className: "agent-instructions" },
            React.createElement(
              "label",
              {
                className: "agent-instructions-label",
                htmlFor: "agent-instructions-input",
              },
              "Agent instructions",
            ),
            React.createElement("textarea", {
              id: "agent-instructions-input",
              className: "agent-instructions-input",
              value: agentInstructions,
              onChange: (e) => handleAgentInstructionsChange(e.target.value),
              placeholder:
                "Optional. Tell the agent your preferences - e.g. 'Use a tight 4-color palette', 'Prefer drawings over text', 'Be funny'.",
              rows: 4,
              spellCheck: true,
            }),
            React.createElement(
              "p",
              { className: "agent-instructions-hint" },
              "Saved automatically. Takes effect on next Start Preso.",
            ),
          )
        : null,
      error ? React.createElement("div", { className: "error" }, error) : null,
    ),
  );
}

const CAPTION_MAX_CHARS = 70;

function truncateCaption(text) {
  if (!text || text.length <= CAPTION_MAX_CHARS) return text;
  const tail = text.slice(-CAPTION_MAX_CHARS);
  const space = tail.indexOf(" ");
  return space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
}

function Waveform({ analyser, active }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    let raf = 0;
    let resizeObserver;
    let lastWidth = 0;
    let lastHeight = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }
    resize();

    if (!analyser || !active) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return () => {
        if (resizeObserver) resizeObserver.disconnect();
      };
    }

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    const data = new Uint8Array(analyser.fftSize);

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      const amplitude = mid * 0.85;

      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "rgba(56, 189, 248, 0)");
      gradient.addColorStop(0.15, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(0.5, "rgba(168, 85, 247, 0.95)");
      gradient.addColorStop(0.85, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(1, "rgba(56, 189, 248, 0)");

      ctx.shadowColor = "rgba(56, 189, 248, 0.55)";
      ctx.shadowBlur = 22 * dpr;
      ctx.lineWidth = 2.4 * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = gradient;

      ctx.beginPath();
      const step = w / data.length;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        const x = i * step;
        const y = mid + v * amplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      if (resizeObserver) resizeObserver.disconnect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, active]);

  return React.createElement("canvas", {
    ref: canvasRef,
    className: "waveform-canvas",
  });
}

function CostCard({ cost }) {
  const agent = cost.agent ?? {};
  const stt = cost.transcription ?? {};
  const total = (agent.priced ? agent.cost : 0) + (stt.priced ? stt.cost : 0);
  return React.createElement(
    "div",
    { className: "cost-card" },
    React.createElement(
      "div",
      { className: "cost-card-header" },
      React.createElement(
        "span",
        { className: "cost-card-title" },
        "Session cost",
      ),
      React.createElement(
        "span",
        {
          className: "cost-card-total",
          title: "Sum of priced agent + transcription costs",
        },
        formatUsd(total),
      ),
    ),
    React.createElement(CostRow, {
      label: "Agent",
      sub: costSubtitle(agent),
      value: costValue(agent),
      title: agentTokenTooltip(agent),
    }),
    React.createElement(CostRow, {
      label: "Voice",
      sub: costSubtitle(stt),
      value: costValue(stt),
      title: transcriptionTooltip(stt),
    }),
  );
}

function CostRow({ label, sub, value, title }) {
  return React.createElement(
    "div",
    { className: "cost-row", title: title || undefined },
    React.createElement(
      "div",
      { className: "cost-row-left" },
      React.createElement("span", { className: "cost-row-label" }, label),
      sub
        ? React.createElement("span", { className: "cost-row-sub" }, sub)
        : null,
    ),
    React.createElement("span", { className: "cost-row-value" }, value),
  );
}

function costSubtitle(entry) {
  if (!entry?.provider) return "";
  if (entry.provider === "moonshine")
    return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "ollama") return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "codex")
    return `${entry.model ?? ""} (subscription)`.trim();
  return entry.model ?? "";
}

function costValue(entry) {
  if (!entry?.provider) return "$0.0000";
  if (!entry.priced) {
    if (entry.reason === "local") return "$0.0000";
    // Codex routes through the user's ChatGPT subscription, so there's no
    // per-token dollar cost we can report. Show usage volume instead so the
    // panel still surfaces "is the agent doing work?".
    if (entry.reason === "subscription") return formatTokenCount(entry.tokens);
    return "n/a";
  }
  return formatUsd(entry.cost ?? 0);
}

function formatUsd(value) {
  if (typeof value !== "number" || !isFinite(value)) return "$0.0000";
  if (value === 0) return "$0.0000";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function formatTokenCount(tokens) {
  const total =
    (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  if (total === 0) return "0 tok";
  if (total < 1000) return `${total} tok`;
  if (total < 1_000_000) {
    const k = total / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k tok`;
  }
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

function agentTokenTooltip(entry) {
  if (!entry?.tokens) return "";
  const t = entry.tokens;
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
  if (total === 0) return "";
  return `input ${t.input ?? 0} (cached ${t.cached ?? 0}) + output ${t.output ?? 0}${t.reasoning ? ` + reasoning ${t.reasoning}` : ""} tokens`;
}

function transcriptionTooltip(entry) {
  if (!entry?.seconds) return "";
  const seconds = entry.seconds;
  const minutes = seconds / 60;
  return `${minutes.toFixed(2)} minutes of audio sent`;
}

function statusRow({
  dotState,
  label,
  value,
  expanded = false,
  onToggle,
  editor,
}) {
  const clickable = Boolean(onToggle);
  return React.createElement(
    "div",
    { className: `status-row-wrap ${expanded ? "expanded" : ""}` },
    React.createElement(
      "div",
      {
        className: `status-row ${clickable ? "clickable" : ""} ${expanded ? "open" : ""}`,
        onClick: clickable ? onToggle : undefined,
        role: clickable ? "button" : undefined,
        tabIndex: clickable ? 0 : undefined,
        onKeyDown: clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }
          : undefined,
      },
      React.createElement("span", {
        className: `dot ${dotState}`,
        "aria-hidden": "true",
      }),
      React.createElement("span", { className: "label" }, label),
      React.createElement(
        "span",
        {
          className: "value",
          title: typeof value === "string" ? value : undefined,
        },
        value,
      ),
      clickable
        ? React.createElement(
            "span",
            { className: "chevron", "aria-hidden": "true" },
            "›",
          )
        : null,
    ),
    expanded && editor
      ? React.createElement("div", { className: "editor" }, editor)
      : null,
  );
}

function agentModelLabel(settings) {
  const provider = settings.agent.provider;
  if (provider === "ollama") return settings.agent.ollama.model || "(unset)";
  if (provider === "codex") return settings.agent.codex.model;
  return settings.agent.openai.model;
}

function sttModelLabel(settings) {
  if (settings.transcription.provider === "moonshine")
    return settings.transcription.moonshine.model;
  return settings.transcription.openai.model;
}

function MicEditor({ currentDeviceId, onSave, onCancel }) {
  const [devices, setDevices] = React.useState([]);
  const [selected, setSelected] = React.useState(currentDeviceId);
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const inputs = list.filter((d) => d.kind === "audioinput");
        if (cancelled) return;
        setDevices(inputs);
        setNeedsPermission(inputs.length > 0 && inputs.every((d) => !d.label));
      } catch (err) {
        if (!cancelled) setErrorText(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function grantPermission() {
    setBusy(true);
    setErrorText("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list.filter((d) => d.kind === "audioinput");
      setDevices(inputs);
      setNeedsPermission(false);
    } catch (err) {
      setErrorText(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const device = devices.find((d) => d.deviceId === selected);
    onSave({ deviceId: selected || "", label: device?.label || "" });
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    needsPermission
      ? React.createElement(
          "div",
          { className: "editor-hint" },
          "Grant microphone access to see device names.",
          React.createElement(
            "button",
            {
              className: "secondary",
              onClick: grantPermission,
              disabled: busy,
              style: { marginLeft: "8px" },
            },
            busy ? "..." : "Grant",
          ),
        )
      : null,
    field(
      "Device",
      React.createElement(
        "select",
        {
          value: selected,
          onChange: (e) => setSelected(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "" }, "System default"),
        devices.map((d) =>
          React.createElement(
            "option",
            { key: d.deviceId, value: d.deviceId },
            d.label || `Device ${d.deviceId.slice(0, 8)}`,
          ),
        ),
      ),
    ),
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: submit, disabled: busy },
        "Save",
      ),
    ),
  );
}

function AgentEditor({ settings, onSave, onCancel }) {
  const [provider, setProvider] = React.useState(settings.agent.provider);
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.agent.openai.model,
  );
  const [reasoningEffort, setReasoningEffort] = React.useState(
    settings.agent.openai.reasoningEffort,
  );
  const [openaiBaseURL, setOpenaiBaseURL] = React.useState(
    settings.agent.openai.baseURL,
  );
  const [codexModel, setCodexModel] = React.useState(
    settings.agent.codex.model,
  );
  const [ollamaModel, setOllamaModel] = React.useState(
    settings.agent.ollama.model,
  );
  const [ollamaBaseURL, setOllamaBaseURL] = React.useState(
    settings.agent.ollama.baseURL,
  );
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = { agent: { provider, openai: {}, codex: {}, ollama: {} } };
    if (provider === "openai") {
      patch.agent.openai.model = openaiModel;
      patch.agent.openai.reasoningEffort = reasoningEffort;
      patch.agent.openai.baseURL = openaiBaseURL;
    } else if (provider === "codex") {
      patch.agent.codex.model = codexModel;
    } else {
      patch.agent.ollama.model = ollamaModel;
      patch.agent.ollama.baseURL = ollamaBaseURL;
    }
    if (openaiKey) patch.apiKeys = { openai: openaiKey };
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => setProvider(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "openai" }, "OpenAI"),
        React.createElement("option", { value: "codex" }, "Codex"),
        React.createElement("option", { value: "ollama" }, "Ollama"),
      ),
    ),
    provider === "openai"
      ? field(
          "Model",
          select(openaiModel, setOpenaiModel, OPENAI_AGENT_MODELS, busy),
        )
      : null,
    provider === "openai"
      ? field(
          "Reasoning",
          select(reasoningEffort, setReasoningEffort, REASONING_EFFORTS, busy),
        )
      : null,
    provider === "codex"
      ? field(
          "Model",
          select(codexModel, setCodexModel, CODEX_AGENT_MODELS, busy),
        )
      : null,
    provider === "ollama"
      ? field(
          "Model",
          React.createElement("input", {
            type: "text",
            value: ollamaModel,
            onChange: (e) => setOllamaModel(e.target.value),
            placeholder: "e.g. llama3.2",
            disabled: busy,
          }),
        )
      : null,
    provider === "ollama"
      ? field(
          "Base URL",
          React.createElement("input", {
            type: "text",
            value: ollamaBaseURL,
            onChange: (e) => setOllamaBaseURL(e.target.value),
            disabled: busy,
          }),
        )
      : null,
    needsOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "sk-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai" && settings.hasOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "configured (enter to replace)",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai"
      ? field(
          "Base URL",
          React.createElement("input", {
            type: "text",
            value: openaiBaseURL,
            onChange: (e) => setOpenaiBaseURL(e.target.value),
            disabled: busy,
          }),
        )
      : null,
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: submit, disabled: busy || needsOpenAIKey },
        busy ? "Saving..." : "Save",
      ),
    ),
  );
}

function TranscriptionEditor({ settings, onSave, onCancel }) {
  const [provider, setProvider] = React.useState(
    settings.transcription.provider,
  );
  const [moonshineModel, setMoonshineModel] = React.useState(
    settings.transcription.moonshine.model,
  );
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.transcription.openai.model,
  );
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = { transcription: { provider, moonshine: {}, openai: {} } };
    if (provider === "moonshine")
      patch.transcription.moonshine.model = moonshineModel;
    if (provider === "openai") patch.transcription.openai.model = openaiModel;
    if (openaiKey) patch.apiKeys = { openai: openaiKey };
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => setProvider(e.target.value),
          disabled: busy,
        },
        React.createElement(
          "option",
          { value: "moonshine" },
          "Moonshine (local)",
        ),
        React.createElement("option", { value: "openai" }, "OpenAI Realtime"),
      ),
    ),
    provider === "moonshine"
      ? field(
          "Model",
          select(moonshineModel, setMoonshineModel, MOONSHINE_MODELS, busy),
        )
      : null,
    provider === "openai"
      ? field(
          "Model",
          select(
            openaiModel,
            setOpenaiModel,
            OPENAI_TRANSCRIPTION_MODELS,
            busy,
          ),
        )
      : null,
    needsOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "sk-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai" && settings.hasOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "configured (enter to replace)",
            disabled: busy,
          }),
        )
      : null,
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: submit, disabled: busy || needsOpenAIKey },
        busy ? "Saving..." : "Save",
      ),
    ),
  );
}

function field(label, control) {
  return React.createElement(
    "label",
    { className: "field" },
    React.createElement("span", { className: "field-label" }, label),
    control,
  );
}

function select(value, onChange, options, disabled) {
  return React.createElement(
    "select",
    { value, onChange: (e) => onChange(e.target.value), disabled },
    options.map((option) =>
      React.createElement("option", { key: option, value: option }, option),
    ),
  );
}

async function createAudioStreamer(media, onChunk) {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.85;
  let carry = new Float32Array(0);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resample(input, context.sampleRate, SAMPLE_RATE, carry);
    carry = resampled.carry;
    if (resampled.samples.length > 0) {
      onChunk(pcm16ToBase64(resampled.samples));
    }
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(context.destination);

  return {
    analyser,
    close: async () => {
      processor.disconnect();
      source.disconnect();
      analyser.disconnect();
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

// Convert Excalidraw native elements back into the simple "skeleton" shape the
// server stores. Critical: when the agent emits {rectangle, label: "X"},
// convertToExcalidrawElements expands that into a rectangle PLUS a separate
// bound text element. If we echo both back to the server verbatim, the server's
// state.elements doubles up - on the next agent turn the rectangle has lost its
// label, the agent re-adds it, Excalidraw creates ANOTHER bound text, and now
// the canvas renders the same label twice. Folding bound text back into the
// shape's label field on the way out keeps state.elements in the canonical form
// the agent expects.
function nativeElementsToSkeletonForSync(nativeElements) {
  const elements = nativeElements.filter((el) => el && !el.isDeleted);
  const byId = new Map(elements.map((el) => [el.id, el]));
  const consumedTextIds = new Set();
  const result = [];

  for (const el of elements) {
    // Bound text whose parent shape is in the scene: skip - it'll be folded
    // into the parent's label below.
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      consumedTextIds.add(el.id);
      continue;
    }

    const boundElements = Array.isArray(el.boundElements)
      ? el.boundElements
      : null;
    const textBinding =
      boundElements && boundElements.find((b) => b?.type === "text");
    const labelText = textBinding && byId.get(textBinding.id);

    if (labelText) {
      consumedTextIds.add(labelText.id);
      result.push({
        ...stripInternalFields(el),
        label: {
          text: labelText.text ?? "",
          fontSize: labelText.fontSize ?? 18,
        },
      });
      continue;
    }

    result.push(stripInternalFields(el));
  }

  return result.filter((el) => !consumedTextIds.has(el.id));
}

function stripInternalFields(el) {
  // Drop Excalidraw fields that change on every render (cache thrash) or that
  // we don't want the agent reasoning about (locking, grouping, etc.).
  const {
    versionNonce,
    version,
    updated,
    seed,
    index,
    link,
    locked,
    customData,
    frameId,
    groupIds,
    boundElements,
    containerId,
    isDeleted,
    ...rest
  } = el;
  return rest;
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

// Halve each dimension before sending to the agent. ~4x fewer pixels means
// ~4x fewer image tokens and a smaller WS payload, while shapes and labels
// stay legible enough for the model to do visual sanity checks.
async function downscaleBlobByHalf(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const w = Math.max(1, Math.floor(bitmap.width / 2));
    const h = Math.max(1, Math.floor(bitmap.height / 2));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await canvasToBlob(canvas);
  } catch (error) {
    console.warn("Image downscale failed, sending original:", error);
    return blob;
  }
}

createRoot(document.getElementById("app")).render(React.createElement(App));
