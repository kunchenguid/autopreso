import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateText, stepCountIs, streamText, tool } from "ai";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import {
  createWhiteboardAgentModel,
  defaultWhiteboardAgentProvider,
  resolveAgentProviderFromSettings,
} from "./agent-provider.js";
import { createMoonshineTranscription as createDefaultMoonshineTranscription } from "./moonshine-transcription.js";
import { createOpenAITranscription as createDefaultOpenAITranscription } from "./openai-transcription.js";
import { audioSecondsFromBase64Pcm16 } from "./session-cost.js";
import { validateAgentInstructions } from "./settings-store.js";
import { broadcast, createWhiteboardSession } from "./whiteboard-session.js";
import { detectMalformedLayoutWarnings, normalizeWhiteboardElements } from "./whiteboard-elements.js";
import { extractWhiteboardKeywords } from "./whiteboard-keywords.js";
import { applyWhiteboardEditOperations, formatLineNumberedWhiteboard } from "./whiteboard-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
export const DEFAULT_AGENT_TIMEOUT_MS = 90_000;

export async function startServer(options) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));

  const httpServer = createHttpServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const state = createWhiteboardSession({
    options,
    wss,
    runAgent: ({ transcript, state, wss, options }) =>
      runWhiteboardAgent({
        transcript,
        state,
        wss,
        options,
        generateTextFn: options.generateTextFn ?? generateText,
        streamTextFn: options.streamTextFn ?? streamText,
      }),
  });

  const transcription = await createTranscriptionManager({
    options,
    wss,
    queueTranscript: (transcript) => state.queueTranscript(transcript),
    state,
  });

  app.get("/api/config", async (_req, res) => {
    const sanitized = options.settingsStore ? await options.settingsStore.getSanitized() : null;
    res.json({
      transcriptionEngine: transcription.getLabel(),
      settings: sanitized,
    });
  });

  app.get("/api/settings", async (_req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    res.json(await options.settingsStore.getSanitized());
  });

  app.post("/api/session/reset", (_req, res) => {
    state.reset();
    transcription.setSessionContext({ keywords: [] });
    broadcast(wss, { type: "whiteboard:update", elements: state.elements });
    broadcastCost(wss, state);
    res.json({ ok: true });
  });

  app.post("/api/preso/start", async (req, res) => {
    const { stagingElements, stagingScreenshot } = req.body ?? {};
    if (!Array.isArray(stagingElements)) {
      return res.status(400).json({ error: "stagingElements (array) is required." });
    }
    // Snapshot the user's free-form Agent instructions at start so the cached
    // system-prompt prefix stays stable for the whole preso. Edits made to
    // the textarea after Start Preso land on disk but only take effect on the
    // next Start Preso.
    let settings;
    try {
      settings = options.settingsStore ? await options.settingsStore.load() : null;
      validateAgentInstructions(settings?.agentInstructions);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const agentInstructions = typeof settings?.agentInstructions === "string" ? settings.agentInstructions : "";
    const primerMessage = buildStagingPrimerMessage({ stagingElements, stagingScreenshot });
    const keywords = extractWhiteboardKeywords(stagingElements);
    console.log(`[autopreso] preso/start: ${keywords.length} staging keyword(s) for transcription bias`);
    transcription.setSessionContext({ keywords });
    state.startPreso({ primerMessage, agentInstructions });
    state.startWarmupLoop({
      runOnce: ({ attempt }) =>
        runWhiteboardWarmupOnce({
          state,
          options,
          wss,
          attempt,
          generateTextFn: options.generateTextFn ?? generateText,
          streamTextFn: options.streamTextFn ?? streamText,
        }).catch((error) => {
          console.error(`Whiteboard warmup attempt ${attempt} failed:`, error);
          options.onAgentEvent?.({ type: "warmup:error", attempt, error: error.message, timestamp: new Date().toISOString() });
          return { usage: { input: 0, cached: 0, output: 0, reasoning: 0 } };
        }),
      delays: options.warmupDelays,
      maxAttempts: options.warmupMaxAttempts,
      // After the loop ends, append [warmup_user_msg, assistant("UNDERSTOOD")]
      // to agentHistory so every subsequent turn's request prefix starts with
      // exactly the bytes warmup wrote to cache.
      primingMessages: WARMUP_PRIMING_MESSAGES,
    });
    broadcast(wss, { type: "mode", mode: state.mode });
    broadcast(wss, { type: "whiteboard:update", elements: state.elements });
    broadcastCost(wss, state);
    res.json({ ok: true });
  });

  app.post("/api/preso/warmup/cancel", (_req, res) => {
    state.cancelWarmup();
    res.json({ ok: true });
  });

  app.post("/api/preso/back-to-staging", (_req, res) => {
    state.backToStaging();
    transcription.setSessionContext({ keywords: [] });
    broadcast(wss, { type: "mode", mode: state.mode });
    res.json({ ok: true });
  });

  app.put("/api/settings", async (req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    try {
      await options.settingsStore.save(req.body ?? {});
      await transcription.applyCurrent();
      const sanitized = await options.settingsStore.getSanitized();
      res.json({ settings: sanitized, transcriptionEngine: transcription.getLabel() });
      broadcast(wss, { type: "settings", settings: sanitized });
      broadcast(wss, { type: "config", transcriptionEngine: transcription.getLabel() });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  httpServer.on("close", () => transcription.close());

  wss.on("connection", async (client) => {
    let activeAudioSessionId = null;
    client.send(JSON.stringify({ type: "config", transcriptionEngine: transcription.getLabel() }));
    if (options.settingsStore) {
      const sanitized = await options.settingsStore.getSanitized();
      client.send(JSON.stringify({ type: "settings", settings: sanitized }));
    }
    client.send(JSON.stringify({ type: "agent:status", status: state.agentStatus }));
    client.send(JSON.stringify({ type: "mode", mode: state.mode }));
    client.send(JSON.stringify({ type: "warmup", ...state.warmupState }));
    client.send(JSON.stringify({ type: "cost", ...state.cost.getSummary() }));
    if (state.mode === "live") {
      client.send(JSON.stringify({ type: "whiteboard:update", elements: state.elements }));
    }

    client.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "audio:start") {
        if (state.mode === "live" && typeof message.sessionId === "string") activeAudioSessionId = message.sessionId;
      }

      if (message.type === "audio") {
        const hasSessionId = typeof message.sessionId === "string";
        const matchesActiveSession = hasSessionId ? message.sessionId === activeAudioSessionId : activeAudioSessionId === null;
        if (state.mode === "live" && matchesActiveSession) transcription.sendAudio(message.audio);
      }

      if (message.type === "stop") {
        const hasSessionId = typeof message.sessionId === "string";
        const matchesActiveSession = hasSessionId ? message.sessionId === activeAudioSessionId : activeAudioSessionId === null;
        if (matchesActiveSession) {
          transcription.stop();
          activeAudioSessionId = null;
          state.endSession();
        }
      }

      if (message.type === "whiteboard:screenshot" && typeof message.image === "string") {
        if (state.mode === "live") state.updateLatestScreenshot(message.image);
      }

      if (message.type === "warmup:cancel") {
        state.cancelWarmup();
      }

      if (message.type === "whiteboard:user-elements" && Array.isArray(message.elements)) {
        // The user can draw on the live canvas before clicking Start listening
        // (and during it). Frontend pushes the current scene here so the next
        // transcript turn has fresh elements available to the agent.
        if (state.mode === "live") {
          state.elements = message.elements;
        }
      }

      if (message.type === "settings:update" && options.settingsStore) {
        try {
          await options.settingsStore.save(message.patch ?? {});
          await transcription.applyCurrent();
          const sanitized = await options.settingsStore.getSanitized();
          broadcast(wss, { type: "settings", settings: sanitized });
          broadcast(wss, { type: "config", transcriptionEngine: transcription.getLabel() });
        } catch (error) {
          client.send(JSON.stringify({ type: "error", message: `Failed to apply settings: ${error.message}` }));
        }
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(options.port, options.host, () => resolve(undefined)));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    app,
    httpServer,
    state,
    url: `http://${options.host}:${port}`,
  };
}

async function createTranscriptionManager({ options, wss, queueTranscript, state }) {
  let current = null;
  let label = "";
  let sessionContext = null;
  let hasSessionContext = false;
  let activeProvider = null;
  let activeModel = null;
  let lastCostBroadcastAt = 0;

  const sendTranscript = (message) => broadcast(wss, message);

  function buildOptionsForFactory(settings) {
    if (!settings) return options;
    return {
      ...options,
      moonshineModel: settings.transcription.moonshine.model,
      openaiTranscriptionModel: settings.transcription.openai.model,
      env: { ...(options.env ?? process.env), OPENAI_API_KEY: settings.apiKeys?.openai || (options.env ?? process.env).OPENAI_API_KEY },
    };
  }

  function pickFactory(settings) {
    if (options.createTranscription) return options.createTranscription;
    const provider = settings ? settings.transcription.provider : options.transcriptionProvider;
    if (provider === "openai") return createDefaultOpenAITranscription;
    return createDefaultMoonshineTranscription;
  }

  function describeLabel(settings) {
    if (settings) {
      if (settings.transcription.provider === "openai") return `OpenAI ${settings.transcription.openai.model}`;
      return `Moonshine ${settings.transcription.moonshine.model}`;
    }
    if (options.transcriptionProvider === "openai") return `OpenAI ${options.openaiTranscriptionModel}`;
    return `Moonshine ${options.moonshineModel}`;
  }

  async function applyCurrent() {
    const settings = options.settingsStore ? await options.settingsStore.load() : null;
    const newLabel = describeLabel(settings);
    activeProvider = settings ? settings.transcription.provider : (options.transcriptionProvider ?? "moonshine");
    activeModel = activeProvider === "openai"
      ? (settings?.transcription.openai.model ?? options.openaiTranscriptionModel ?? null)
      : (settings?.transcription.moonshine.model ?? options.moonshineModel ?? null);

    if (current && newLabel === label) return;

    if (current) current.close();

    const factoryOptions = buildOptionsForFactory(settings);
    const factory = pickFactory(settings);
    label = newLabel;
    options.onStatus?.(`Preparing ${label} transcription model...`);
    current = factory({
      sendTranscript,
      queueTranscript,
      options: factoryOptions,
      env: factoryOptions.env,
    });
    if (hasSessionContext) current.setSessionContext?.(sessionContext);
    await current.ready();
    options.onStatus?.(`${label} transcription model ready.`);
  }

  await applyCurrent();

  return {
    sendAudio: (audio) => {
      current?.sendAudio(audio);
      if (state?.cost && activeProvider) {
        state.cost.recordTranscriptionAudio({
          provider: activeProvider,
          model: activeModel,
          seconds: audioSecondsFromBase64Pcm16(audio),
        });
        // Throttle cost broadcast to ~once per second; audio frames arrive
        // every ~170ms and we don't want to flood the WS with cost updates.
        const now = Date.now();
        if (now - lastCostBroadcastAt >= 1000) {
          lastCostBroadcastAt = now;
          broadcastCost(wss, state);
        }
      }
    },
    stop: () => current?.stop(),
    close: () => current?.close(),
    setSessionContext: (ctx) => {
      sessionContext = ctx;
      hasSessionContext = true;
      current?.setSessionContext?.(ctx);
    },
    getLabel: () => label,
    applyCurrent,
  };
}

export async function runWhiteboardAgent({ transcript, state, wss, options, generateTextFn = generateText, streamTextFn = streamText }) {
  // Capture the session at turn start. If the user clicks Stop / Back to
  // staging / Reset / Start preso while we're in flight, mySession.active
  // flips to false. Tool execute and the post-turn agentHistory update both
  // check this and become no-ops, so late LLM responses can't mutate the
  // canvas or contaminate the next session's history. Cost recording does
  // NOT consult this - we paid for the tokens regardless.
  // (Tests/scaffolds without a session token are treated as always-active.)
  const mySession = state.session ?? { active: true };
  // Only attach the live screenshot when the canvas has been edited since the
  // last attach. On DONE-only turns nothing changed, so the screenshot adds
  // ~7-10k tokens of noise without giving the agent new visual info.
  const screenshotForAgent = state.canvasDirtyForAgent ? state.latestScreenshot : undefined;
  state.canvasDirtyForAgent = false;
  const rawMessages = buildWhiteboardAgentMessages({
    elements: state.elements,
    agentHistory: state.agentHistory,
    latestScreenshot: screenshotForAgent,
    transcript,
  });
  const whiteboardElementSchema = z.record(z.string(), z.any());
  const editOperationSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("replace"),
      line: z.number().int().positive().describe("Current 1-based line number to replace."),
      element: whiteboardElementSchema.describe("Replacement drawing object for this line."),
    }),
    z.object({
      type: z.literal("insert_after"),
      line: z.number().int().min(0).describe("Current line number to insert after. Use 0 to insert at the start."),
      element: whiteboardElementSchema.describe("Drawing object to insert after this line."),
    }),
    z.object({
      type: z.literal("delete"),
      line: z.number().int().positive().describe("Current 1-based line number to delete."),
    }),
  ]);

  const baseSystem = whiteboardSystemPrompt();

  const agentProvider = options.agentProvider
    ?? (options.settingsStore
      ? resolveAgentProviderFromSettings({ settings: await options.settingsStore.load(), env: options.env ?? process.env })
      : defaultWhiteboardAgentProvider(options));
  // Fold the primer text into the system prompt for both openai and codex
  // providers. The primer image (if any) stays in messages[0] - system prompts
  // are text-only across these APIs. This keeps the staging context as a
  // first-class system instruction rather than a stale early user message.
  const primerText = extractPrimerText(state.agentHistory?.[0]);
  const effectiveSystem = buildEffectiveSystemPrompt(baseSystem, primerText, state.agentInstructions);
  const messages = primerText ? reshapeMessagesForCodex(rawMessages) : rawMessages;
  options.onAgentEvent?.({ type: "model:start", transcript, system: effectiveSystem, messages, timestamp: new Date().toISOString() });
  const codexInstructions = agentProvider.provider === "codex" ? effectiveSystem : null;
  dumpAgentRequest("turn", { system: effectiveSystem, messages, instructions: codexInstructions, primerText });
  const agentCallOptions = {
    model: createWhiteboardAgentModel(agentProvider),
    providerOptions: createWhiteboardAgentProviderOptions(agentProvider, effectiveSystem),
    stopWhen: stepCountIs(4),
    system: effectiveSystem,
    messages,
    tools: {
      whiteboard_overwrite: tool({
        description: "Replace the entire whiteboard with a complete drawing object array. Use only for clearing, resetting, or starting fresh.",
        inputSchema: z.object({
          elements: z.array(whiteboardElementSchema).describe("Complete replacement drawing object array."),
        }),
        execute: async ({ elements }) => {
          if (!mySession.active) return STALE_SESSION_TOOL_RESULT;
          options.onAgentEvent?.({ type: "tool:start", tool: "whiteboard_overwrite", input: { elements }, timestamp: new Date().toISOString() });
          const normalizedElements = normalizeWhiteboardElements(elements);
          state.elements = normalizedElements;
          state.canvasDirtyForAgent = true;
          broadcast(wss, { type: "whiteboard:update", elements: normalizedElements });
          const result = appendLayoutWarnings(formatLineNumberedWhiteboard(normalizedElements), normalizedElements);
          dumpToolCall("whiteboard_overwrite", { elementCount: elements.length, ids: elements.map((el) => el.id) }, normalizedElements.map((el) => el.id), result);
          options.onAgentEvent?.({ type: "tool:end", tool: "whiteboard_overwrite", result, elements: normalizedElements, timestamp: new Date().toISOString() });
          return result;
        },
      }),
      whiteboard_apply: tool({
        description: "Apply edits and/or move the viewport in a SINGLE call. Combine everything you want to do this turn into one whiteboard_apply call - do not split into back-to-back calls. Either operations, viewport, or both must be provided. operations applies edits in line-number order; viewport scrolls/zooms after edits land. For scroll_to_content, ALWAYS pass focus_ids.",
        inputSchema: z.object({
          operations: z.array(editOperationSchema).optional().describe("Edit operations applied in order. Omit (or pass empty) when you only want to move the viewport."),
          viewport: z.object({
            action: z.enum(["scroll_to_content", "set_zoom", "zoom_in", "zoom_out", "reset_zoom"]),
            zoom: z.number().min(0.1).max(3).optional().describe("Zoom value for set_zoom. 1 is 100%."),
            focus_ids: z.array(z.string()).optional().describe("For scroll_to_content: stable element IDs the audience should look at right now (typically the elements you just edited or the cluster the speaker is currently discussing). Pass 1-5 IDs - the active talking point, not the whole diagram."),
          }).optional().describe("Optional viewport command applied AFTER any edits. Omit when no viewport change is needed."),
        }),
        execute: async ({ operations, viewport }) => {
          if (!mySession.active) return STALE_SESSION_TOOL_RESULT;
          const hasOps = Array.isArray(operations) && operations.length > 0;
          const hasViewport = viewport && typeof viewport === "object";
          if (!hasOps && !hasViewport) {
            const msg = "whiteboard_apply: Provide at least one of operations or viewport. Empty calls are not allowed - if there's nothing to do, don't call this tool.";
            dumpToolCall("whiteboard_apply", { operations, viewport }, state.elements.map((el) => el.id), msg);
            return msg;
          }
          options.onAgentEvent?.({ type: "tool:start", tool: "whiteboard_apply", input: { operations, viewport }, timestamp: new Date().toISOString() });

          let canvasResult = "";
          if (hasOps) {
            const nextElements = normalizeWhiteboardElements(applyWhiteboardEditOperations(state.elements, operations));
            state.elements = nextElements;
            state.canvasDirtyForAgent = true;
            broadcast(wss, { type: "whiteboard:update", elements: nextElements });
            canvasResult = appendLayoutWarnings(formatLineNumberedWhiteboard(nextElements), nextElements);
          }

          let viewportResult = "";
          if (hasViewport) {
            const { action, zoom, focus_ids } = viewport;
            const broadcastPayload = {
              action,
              ...(zoom === undefined ? {} : { zoom }),
              ...(Array.isArray(focus_ids) && focus_ids.length > 0 ? { focus_ids } : {}),
            };
            broadcast(wss, { type: "whiteboard:viewport", ...broadcastPayload });
            if (action === "scroll_to_content") {
              if (!focus_ids || focus_ids.length === 0) {
                viewportResult = "Viewport scrolled to fit ALL content. Next time, pass focus_ids so the audience sees the active talking point, not the whole canvas.";
              } else {
                const sceneIds = new Set(state.elements.map((el) => el.id));
                const known = focus_ids.filter((id) => sceneIds.has(id));
                const unknown = focus_ids.filter((id) => !sceneIds.has(id));
                if (known.length === 0) {
                  viewportResult = `Viewport WARNING: none of focus_ids ${JSON.stringify(focus_ids)} match any element in the current scene (scene has ids: ${JSON.stringify([...sceneIds].slice(0, 12))}${sceneIds.size > 12 ? ", ..." : ""}). The frontend fell back to fitting the entire canvas. Use IDs from the line-numbered whiteboard content above.`;
                } else if (unknown.length > 0) {
                  viewportResult = `Viewport command sent. NOTE: ${unknown.length} of your focus_ids did not match any scene element and were ignored: ${JSON.stringify(unknown)}. The viewport scrolled to: ${JSON.stringify(known)}.`;
                } else {
                  viewportResult = `Viewport scrolled to ${known.length} element${known.length === 1 ? "" : "s"}: ${JSON.stringify(known)}.`;
                }
              }
            } else {
              viewportResult = "Viewport command sent.";
            }
          }

          const result = [canvasResult, viewportResult].filter(Boolean).join("\n\n");
          dumpToolCall("whiteboard_apply", { operations, viewport }, state.elements.map((el) => el.id), result);
          options.onAgentEvent?.({ type: "tool:end", tool: "whiteboard_apply", result, elements: state.elements, timestamp: new Date().toISOString() });
          return result;
        },
      }),
    },
  };

  const result = await withTimeout(
    runWhiteboardAgentGeneration(agentProvider, agentCallOptions, { generateTextFn, streamTextFn }),
    options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    "Whiteboard agent timed out",
  );
  logAgentUsage("turn", result, {
    transcript: transcript?.slice(0, 80),
    fingerprints: {
      system: fingerprint(effectiveSystem),
      primer: fingerprint(state.agentHistory[0]),
      tools: fingerprint(toolDefinitionFingerprintInput(agentCallOptions.tools)),
    },
  });
  recordAgentCost(state, wss, agentProvider, result);
  options.onAgentEvent?.({ type: "model:end", transcript, result: summarizeAgentResult(result), timestamp: new Date().toISOString() });

  if (mySession.active) {
    state.agentHistory = appendWhiteboardAgentHistory(state.agentHistory, {
      transcript,
    });
  }
  return result;
}

// Returned to the model when a tool is called after the user has ended the
// session (clicked Stop, etc). The model sees this as the tool result, which
// usually causes it to stop without further tool calls. State is unchanged
// either way - what matters is that we did not mutate state.elements or
// broadcast a whiteboard:update for the late edit.
const STALE_SESSION_TOOL_RESULT = "Session has ended; the requested edit was not applied.";

function appendLayoutWarnings(formattedBoard, elements) {
  const warnings = detectMalformedLayoutWarnings(elements);
  if (warnings.length === 0) return formattedBoard;
  return `${formattedBoard}\n\n${warnings.map((w, i) => `WARNING ${i + 1}: ${w}`).join("\n")}\n\nFix the warnings above on your next edit so the rendered scene actually looks right.`;
}

async function runWhiteboardAgentGeneration(agentProvider, agentCallOptions, { generateTextFn, streamTextFn }) {
  if (agentProvider.provider !== "codex") return generateTextFn(agentCallOptions);
  const stream = streamTextFn(agentCallOptions);
  await stream.consumeStream();
  // streamText exposes the final values as promise-properties on the result.
  // After consumeStream resolves they resolve too. Read them defensively so
  // older SDK versions or test mocks without these fields don't throw.
  const safeGet = async (key) => {
    try {
      const value = stream?.[key];
      if (value && typeof value.then === "function") return await value;
      return value;
    } catch {
      return undefined;
    }
  };
  return {
    text: await safeGet("text"),
    finishReason: await safeGet("finishReason"),
    usage: await safeGet("usage"),
    toolCalls: await safeGet("toolCalls"),
    toolResults: await safeGet("toolResults"),
    steps: await safeGet("steps"),
  };
}

// Identical warmup message across attempts AND identical to the priming pair
// appended to agentHistory after warmup. Once warmup writes a cache entry for
// [primer, WARMUP_USER_MESSAGE], every subsequent turn whose prefix starts with
// [primer, WARMUP_USER_MESSAGE, assistant("UNDERSTOOD"), ...] hits that cache.
export const WARMUP_USER_MESSAGE = {
  role: "user",
  content: "Speaker turn:\n(cache warmup - no spoken content yet, confirm readiness by responding UNDERSTOOD without calling tools)",
};
export const WARMUP_ASSISTANT_REPLY = { role: "assistant", content: "UNDERSTOOD" };
export const WARMUP_PRIMING_MESSAGES = [WARMUP_USER_MESSAGE, WARMUP_ASSISTANT_REPLY];

export async function runWhiteboardWarmupOnce({ state, options, wss = null, attempt = 1, generateTextFn = generateText, streamTextFn = streamText }) {
  if (!Array.isArray(state.agentHistory) || state.agentHistory.length === 0) return undefined;

  const baseSystem = whiteboardSystemPrompt();
  const agentProvider = options.agentProvider
    ?? (options.settingsStore
      ? resolveAgentProviderFromSettings({ settings: await options.settingsStore.load(), env: options.env ?? process.env })
      : defaultWhiteboardAgentProvider(options));
  const primerText = extractPrimerText(state.agentHistory[0]);
  const effectiveSystem = buildEffectiveSystemPrompt(baseSystem, primerText, state.agentInstructions);

  // Each warmup attempt sends the IDENTICAL prefix [primer, WARMUP_USER_MESSAGE]
  // so attempt N hits the cache that attempt N-1 wrote. We must NOT mutate
  // state.agentHistory until the loop ends - otherwise attempt 2's prefix
  // would differ from attempt 1's and cache wouldn't share.
  const all = [...state.agentHistory, WARMUP_USER_MESSAGE];
  const messages = primerText ? reshapeMessagesForCodex(all) : all;

  options.onAgentEvent?.({ type: "warmup:start", attempt, system: effectiveSystem, timestamp: new Date().toISOString() });

  // Same tool definitions as the live agent so the request prefix matches and
  // automatic prompt cache fires on subsequent transcript turns.
  const whiteboardElementSchema = z.record(z.string(), z.any());
  const editOperationSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("replace"),
      line: z.number().int().positive().describe("Current 1-based line number to replace."),
      element: whiteboardElementSchema.describe("Replacement drawing object for this line."),
    }),
    z.object({
      type: z.literal("insert_after"),
      line: z.number().int().min(0).describe("Current line number to insert after. Use 0 to insert at the start."),
      element: whiteboardElementSchema.describe("Drawing object to insert after this line."),
    }),
    z.object({
      type: z.literal("delete"),
      line: z.number().int().positive().describe("Current 1-based line number to delete."),
    }),
  ]);
  const noop = async () => "warmup-noop";

  const callOptions = {
    model: createWhiteboardAgentModel(agentProvider),
    providerOptions: createWhiteboardAgentProviderOptions(agentProvider, effectiveSystem),
    stopWhen: stepCountIs(1),
    system: effectiveSystem,
    messages,
    tools: {
      whiteboard_overwrite: tool({
        description: "Replace the entire whiteboard with a complete drawing object array. Use only for clearing, resetting, or starting fresh.",
        inputSchema: z.object({
          elements: z.array(whiteboardElementSchema).describe("Complete replacement drawing object array."),
        }),
        execute: noop,
      }),
      whiteboard_apply: tool({
        description: "Apply edits and/or move the viewport in a SINGLE call. Combine everything you want to do this turn into one whiteboard_apply call - do not split into back-to-back calls. Either operations, viewport, or both must be provided. operations applies edits in line-number order; viewport scrolls/zooms after edits land. For scroll_to_content, ALWAYS pass focus_ids.",
        inputSchema: z.object({
          operations: z.array(editOperationSchema).optional().describe("Edit operations applied in order. Omit (or pass empty) when you only want to move the viewport."),
          viewport: z.object({
            action: z.enum(["scroll_to_content", "set_zoom", "zoom_in", "zoom_out", "reset_zoom"]),
            zoom: z.number().min(0.1).max(3).optional().describe("Zoom value for set_zoom. 1 is 100%."),
            focus_ids: z.array(z.string()).optional().describe("For scroll_to_content: stable element IDs the audience should look at right now (typically the elements you just edited or the cluster the speaker is currently discussing). Pass 1-5 IDs - the active talking point, not the whole diagram."),
          }).optional().describe("Optional viewport command applied AFTER any edits. Omit when no viewport change is needed."),
        }),
        execute: noop,
      }),
    },
  };

  const fingerprints = {
    system: fingerprint(effectiveSystem),
    primer: fingerprint(state.agentHistory[0]),
    tools: fingerprint(toolDefinitionFingerprintInput(callOptions.tools)),
  };

  const codexInstructionsForWarmup = agentProvider.provider === "codex" ? effectiveSystem : null;
  const label = `warmup#${attempt}`;
  dumpAgentRequest(label, { system: effectiveSystem, messages, instructions: codexInstructionsForWarmup, primerText });
  const result = await withTimeout(
    runWhiteboardAgentGeneration(agentProvider, callOptions, { generateTextFn, streamTextFn }),
    options.warmupTimeoutMs ?? options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    "Whiteboard warmup timed out",
  );
  logAgentUsage(label, result, { fingerprints });
  recordAgentCost(state, wss, agentProvider, result);

  options.onAgentEvent?.({ type: "warmup:end", attempt, result: summarizeAgentResult(result), timestamp: new Date().toISOString() });
  return { usage: extractAgentUsage(result), result };
}

function recordAgentCost(state, wss, agentProvider, result) {
  if (!state?.cost || !agentProvider) return;
  const usage = extractAgentUsage(result);
  // Codex maps requested model "gpt-5.5-fast" -> model "gpt-5.5" + priority
  // tier. For display, prefer the user's chosen string. (Codex isn't priced
  // per-token here anyway; the tracker just shows it for context.)
  const model = agentProvider.requestedModel ?? agentProvider.model;
  state.cost.recordAgentUsage({ provider: agentProvider.provider, model, usage });
  if (wss) broadcastCost(wss, state);
}

export function broadcastCost(wss, state) {
  if (!wss || !state?.cost) return;
  broadcast(wss, { type: "cost", ...state.cost.getSummary() });
}

function summarizeAgentResult(result) {
  if (!result || typeof result !== "object") return result;

  return Object.fromEntries(
    ["text", "finishReason", "usage", "toolCalls", "toolResults", "steps"]
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]]),
  );
}

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".config", "autopreso", "logs");
const CACHE_USAGE_LOG_PATH = process.env.AUTOPRESO_CACHE_LOG ?? path.join(DEFAULT_LOG_DIR, "cache.log");
const DEBUG_LOG_PATH = process.env.AUTOPRESO_DEBUG_LOG ?? path.join(DEFAULT_LOG_DIR, "debug.log");

let logDirsEnsured = false;
function ensureLogDirs() {
  if (logDirsEnsured) return;
  for (const file of [CACHE_USAGE_LOG_PATH, DEBUG_LOG_PATH]) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Best effort; the appendFileSync call below will surface a real failure.
    }
  }
  logDirsEnsured = true;
}

function summarizeMessageForDump(message) {
  if (typeof message?.content === "string") {
    return { role: message.role, contentType: "text", text: message.content };
  }
  if (Array.isArray(message?.content)) {
    return {
      role: message.role,
      contentType: "multimodal",
      parts: message.content.map((part) => {
        if (part?.type === "text") return { type: "text", text: part.text ?? "" };
        if (part?.type === "image") {
          const image = typeof part.image === "string" ? part.image : "";
          return {
            type: "image",
            note: image.startsWith("data:") ? `data URL, ${image.length} chars` : "image",
          };
        }
        return { type: part?.type ?? "unknown" };
      }),
    };
  }
  return { role: message?.role, content: message?.content };
}

export function dumpAgentRequest(label, args) {
  const { system, messages, instructions, primerText } = args ?? {};
  ensureLogDirs();
  try {
    const record = {
      ts: new Date().toISOString(),
      label,
      systemFingerprint: fingerprint(system),
      systemLength: typeof system === "string" ? system.length : 0,
      instructionsFingerprint: fingerprint(instructions ?? null),
      instructionsLength: typeof instructions === "string" ? instructions.length : 0,
      // Primer text now lives in the system prompt for both providers, plus
      // codex's `instructions` field which mirrors system. Dumping it directly
      // lets you verify the user's staging content reached the agent without
      // having to parse the (huge) full system prompt.
      primerText: typeof primerText === "string" ? primerText : null,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      messages: Array.isArray(messages) ? messages.map(summarizeMessageForDump) : null,
    };
    appendFileSync(DEBUG_LOG_PATH, "\n" + "=".repeat(80) + "\n" + JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    console.warn("[debug] failed to append to debug log:", error.message);
  }
}

export function dumpToolCall(toolName, input, sceneIds, result) {
  ensureLogDirs();
  try {
    const record = {
      ts: new Date().toISOString(),
      tool: toolName,
      input,
      sceneIds: Array.isArray(sceneIds) ? sceneIds : null,
      resultPreview: typeof result === "string" ? result.slice(0, 600) : result,
    };
    appendFileSync(DEBUG_LOG_PATH, "\n" + "-".repeat(80) + "\nTOOL CALL: " + JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    console.warn("[debug] failed to append tool call to debug log:", error.message);
  }
}

export function extractAgentUsage(result) {
  const usage = result?.usage ?? {};
  const input = usage.inputTokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.outputTokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cached = usage.cachedInputTokens
    ?? usage.cached_input_tokens
    ?? usage.promptTokensDetails?.cachedTokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? 0;
  const reasoning = usage.reasoningTokens ?? usage.reasoning_tokens ?? 0;
  return { input, cached, output, reasoning };
}

function fingerprint(value) {
  try {
    return createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 10);
  } catch {
    return "n/a";
  }
}

function toolDefinitionFingerprintInput(tools) {
  // The execute callbacks are closures and can't be JSON-stringified. For cache
  // parity we only care about the parts the model sees: name, description, and
  // input schema. Zod schemas don't serialize cleanly so we read shape via _def
  // when present; this is a best-effort fingerprint, not a JSON-Schema dump.
  if (!tools || typeof tools !== "object") return null;
  const out = {};
  for (const [name, def] of Object.entries(tools)) {
    let keys = [];
    try {
      const shape = def?.inputSchema?._def?.shape;
      const resolved = typeof shape === "function" ? shape() : (shape ?? def?.inputSchema?.shape ?? {});
      keys = Object.keys(resolved).sort();
    } catch {
      keys = [];
    }
    out[name] = {
      description: def?.description ?? null,
      schemaShape: def?.inputSchema?._def?.typeName ?? typeof def?.inputSchema,
      schemaKeys: keys,
    };
  }
  return out;
}

export function logAgentUsage(label, result, extras = {}) {
  const { input, cached, output, reasoning } = extractAgentUsage(result);
  const cachePct = input > 0 ? Math.round((cached / input) * 100) : 0;
  ensureLogDirs();
  try {
    const record = {
      ts: new Date().toISOString(),
      label,
      input,
      cached,
      cachePct,
      output,
      reasoning,
      rawUsage: result?.usage ?? null,
      ...extras,
    };
    appendFileSync(CACHE_USAGE_LOG_PATH, JSON.stringify(record) + "\n");
  } catch (error) {
    // Don't let logging break the agent flow.
    console.warn("[cache] failed to append to log file:", error.message);
  }
}

function createWhiteboardAgentProviderOptions(agentProvider, effectiveSystem) {
  if (!["openai", "codex"].includes(agentProvider.provider)) return undefined;
  return {
    openai: {
      reasoningEffort: agentProvider.reasoningEffort,
      ...(agentProvider.serviceTier ? { serviceTier: agentProvider.serviceTier } : {}),
      // Codex's Responses API uses `instructions` instead of a system message.
      // We pass the same effective system (base + primer text) here so codex
      // gets the primer too. `store: false` disables server-side conversation
      // storage; we send full history each turn.
      ...(agentProvider.provider === "codex" ? { store: false, instructions: effectiveSystem } : {}),
    },
  };
}

export function buildEffectiveSystemPrompt(systemPrompt, primerText, userInstructions = "") {
  let result = systemPrompt;
  const trimmedUserInstructions = typeof userInstructions === "string" ? userInstructions.trim() : "";
  if (trimmedUserInstructions) {
    result = `${result}\n\nUser instructions:\n${trimmedUserInstructions}`;
  }
  if (primerText) {
    result = `${result}\n\n${primerText}`;
  }
  return result;
}

export function extractPrimerText(primerMessage) {
  if (!primerMessage) return "";
  if (typeof primerMessage.content === "string") return primerMessage.content;
  if (Array.isArray(primerMessage.content)) {
    return primerMessage.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n\n");
  }
  return "";
}

export function reshapeMessagesForCodex(messages) {
  // The primer text now lives entirely in codex's `instructions` field for
  // cache reasons, so drop the primer message from the messages array. If a
  // primer happens to carry non-text parts (legacy or future image use), keep
  // those parts as a stripped-down user message.
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const first = messages[0];
  if (first?.role !== "user") return messages;
  if (typeof first.content === "string") return messages.slice(1);
  if (Array.isArray(first.content)) {
    const nonTextParts = first.content.filter((part) => part?.type !== "text");
    if (nonTextParts.length === 0) return messages.slice(1);
    return [{ role: "user", content: nonTextParts }, ...messages.slice(1)];
  }
  return messages;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms.`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

export function buildWhiteboardAgentMessages({ agentHistory, elements, latestScreenshot = null, transcript }) {
  return [
    ...agentHistory,
    { role: "user", content: formatSpeakerTurn(transcript) },
    { role: "user", content: formatCurrentCanvasTask(elements, latestScreenshot) },
  ];
}

export function appendWhiteboardAgentHistory(agentHistory, { transcript }) {
  const nextHistory = [...agentHistory];
  const transcriptText = transcript.trim();

  if (transcriptText) {
    nextHistory.push({ role: "user", content: formatSpeakerTurn(transcriptText) });
  }

  return nextHistory;
}

function formatSpeakerTurn(transcript) {
  return `Speaker turn:\n${transcript.trim()}`;
}

export function buildStagingPrimerMessage({ stagingElements, stagingScreenshot }) {
  const elementsText = formatLineNumberedWhiteboard(stagingElements);
  const text = `Reference context for this presentation:

The user prepared this staging area before starting. Use it as a strong reference for two things:

1. Content / vocabulary: names, terms, facts, numbers, and relationships the speaker is likely to refer to. Prefer the staging's wording over your own paraphrases.
2. Structure / layout: if the staging contains a diagram (positioned shapes, arrows, columns, groupings, or any visible spatial relationships), treat it as the user's chosen visualization for that topic. When the speaker reaches the related topic, roughly follow that structure on the live canvas - same overall arrangement, similar relative positions, same connections and groupings - rather than inventing a different layout. You can swap shape types if a different one fits better (rectangle vs ellipse vs diamond, etc.); the structure matters more than the specific shapes. Reuse the staging's color encoding if it has one.

You may simplify, relabel, drop, or rearrange pieces that don't apply to what the speaker is currently saying, and you may add new content the staging didn't anticipate. But when the speaker is talking about something the staging clearly diagrams, lean into that diagram instead of starting from scratch.

Don't dump the entire staging onto the live canvas before the speaker brings a topic up. The live canvas should still grow with the talk - the staging just biases what it grows into.

Staging elements:
${elementsText}

${stagingScreenshot ? "An image of the full staging area is attached so you can see the layout visually as well." : ""}

This message arrives before any spoken content. Respond with the single word UNDERSTOOD and take no further action - do not call any tools - until an actual speaker transcript turn arrives. When transcript turns do arrive in subsequent messages, behave normally per your system instructions.`;
  if (typeof stagingScreenshot === "string" && stagingScreenshot) {
    return {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", image: stagingScreenshot },
      ],
    };
  }
  return { role: "user", content: text };
}

function formatCurrentCanvasTask(elements, latestScreenshot) {
  const text = `Current line-numbered whiteboard content:\n${formatLineNumberedWhiteboard(elements)}\n\nTask:\nUse the latest speaker turn and prior context to decide whether the canvas should change.\n\nBEFORE choosing a layout, check the "Reference context for this presentation" section in your system instructions: it contains the staging area the user prepared, including any diagrams. If the speaker has just reached a topic that the staging diagrams already cover, REUSE that staging structure on the live canvas - same shapes, same labels, same arrangement, same colors - rather than inventing a different layout. The staging is the user's pre-approved visualization for those topics; only invent something new when staging doesn't cover the topic at all.\n\nIf updating, use whiteboard_apply for targeted changes (operations + viewport in ONE call). Use whiteboard_overwrite only when you need to clear, reset, or start fresh. Keep the canvas organized around the core concepts, not the transcript sequence. In the same whiteboard_apply call, also include viewport with action "scroll_to_content" AND focus_ids naming the elements the speaker is currently talking about, so the viewport centers exactly on the active talking point - never call scroll_to_content without focus_ids. Make ONE whiteboard_apply call per turn whenever possible; do not split edits and viewport into back-to-back calls. The attached screenshot (when present) shows the audience's current viewport - use it to verify your edits actually look good and that the right region is visible.`;
  if (typeof latestScreenshot === "string" && latestScreenshot) {
    return [
      { type: "text", text },
      { type: "image", image: latestScreenshot },
    ];
  }
  return text;
}

export function whiteboardSystemPrompt() {
  return `You are AutoPreso, a real-time visual note-taking agent.

You listen to transcript chunks and maintain a visual presentation that complements the speaker.
The transcript may contain slight inaccuracies, especially for names, product terms, and short phrases.
Use surrounding context and prior turns to take your best guess at what the speaker really means instead of copying suspicious wording literally.
There are two kinds of useful input.

1. Visual notes: durable talking points, relationships, decisions, contrasts, and flows.
For visual notes, update the canvas only when there is concrete content worth preserving.
Ignore filler, self-corrections, and incomplete thoughts.
Do not mirror the transcript, create subtitles, or list the speaker's sentences as separate text blocks.
Use short labels, diagrams, groupings, and relationships that add structure beyond the voiceover.
Extract the core concepts and choose the best visual form: concept map, process diagram, system architecture, comparison, hierarchy, timeline, or chart.
Reorganize the whole canvas as your understanding improves.
Move, rewrite, group, or replace existing objects instead of appending one note per transcript chunk.
If the current canvas is turning into a transcript list, replace it with a clearer conceptual diagram.

2. Direct canvas commands: the user may give a direct command to perform an action on the canvas.
Examples include "clear the canvas", "add a rectangle", "draw an arrow from A to B", and "draw a line chart".
When intent is a direct canvas command, execute the requested canvas action instead of visualizing the command as a talking point.

Reference context (staging area):
Sessions often begin with a "reference context" message describing material the user prepared in advance: notes, key terms, and frequently a partial or full diagram for one or more upcoming topics.
Treat that reference context as the user's preferred answer for those topics. When the speaker reaches a topic that the reference context already diagrams, REUSE it - same overall structure, same labels, same groupings, same connections, same color encoding. Don't invent a slightly different layout when a workable one is already there. You may swap shape types if a different one fits better and you may simplify or omit pieces that don't apply to the current moment, but the structural skeleton should be recognizable from the staging.
Only build something new from scratch when the speaker's topic isn't covered by the reference context at all.
Use the reference context's vocabulary verbatim where you can - the user has already chosen the wording they want their audience to see.
Never dump the entire reference context onto the canvas at the start. Surface relevant pieces only when the speaker brings them up; the canvas should still grow with the talk.

When updating the canvas:
- Use whiteboard_apply for normal incremental changes.
- Use whiteboard_overwrite only when you need to clear, reset, or start fresh.
- whiteboard_apply takes optional operations (edit ops) and an optional viewport command, and runs them together: edits land first, then the viewport moves.
- whiteboard_overwrite accepts a complete replacement array of simple drawing objects.
- Both tools return the latest full whiteboard as line-numbered content (and whiteboard_apply also returns the viewport result).
- Line numbers are references for editing and are not part of the drawing objects.
- After a tool returns, use the returned line-numbered content as the authoritative latest whiteboard state.

CRITICAL: one tool call per turn.
- Combine all edits and the viewport move into a single whiteboard_apply call per turn. Plan all the operations you want, plus the viewport you want to land on, and emit them together.
- Do NOT make multiple back-to-back whiteboard_apply calls in the same turn. Each tool call is a separate model roundtrip and adds noticeable latency for the audience. Think through the full edit upfront, then send it once.
- The only situation where a second call is acceptable is if the FIRST tool call returns a layout warning that you must fix; otherwise stick to one call.
- If you only need to move the viewport (no edits), pass just viewport. If you only need to edit (no viewport change), pass just operations. If you need both, pass both.

You receive a screenshot of the audience's CURRENT VIEWPORT (not the entire infinite canvas) on each turn. Use it to verify your edits actually rendered well: look for clipped labels, overlapping shapes, arrows that miss their targets, and check that the right region is visible. The line-numbered text content is authoritative for positions; the screenshot is for visual sanity checking.
Attached images (both the staging primer and the per-turn viewport screenshot) are downscaled 2x in each dimension (4x fewer pixels) to save tokens. Do NOT read pixel dimensions off the image as if they were the canvas's real size; trust the line-numbered text for coordinates and only use the image for visual sanity checks.
The audience's viewport is whatever you last set it to. They cannot see anything outside it. So:
- After every meaningful canvas update, pass viewport with action "scroll_to_content" AND a focus_ids list naming the 1-5 elements that represent the active talking point. The viewport will center on exactly those IDs. Pass the IDs of what the speaker is talking about RIGHT NOW, not the whole diagram.
- When the speaker shifts topic to a different region of the canvas, send a new whiteboard_apply with viewport scroll_to_content and the new region's focus_ids.
- Calling scroll_to_content WITHOUT focus_ids fits the entire scene and is almost always the wrong move - the audience ends up looking at a tiny zoomed-out overview instead of the active subject. Use it only on the rare occasion you genuinely want a full-canvas summary view.
- If the relevant region won't be readable even when centered (too dense, or labels are tiny), use set_zoom (or zoom_in/zoom_out) instead of, or together with, scroll_to_content.
- Treat moving the viewport to follow the speaker as a first-class part of your job, not an afterthought.
The app will convert these simple drawing objects into Excalidraw elements after your tool call.
Your coordinates and sizes are used directly.
The app does not automatically fix spacing, resize shapes, wrap labels, or reroute arrows.

whiteboard_apply operations:
- replace: replace one existing line with one drawing object.
- insert_after: insert one drawing object after a line. Use line 0 to insert at the start.
- delete: delete one existing line.
- Operations are applied in order to the current line numbers after previous operations in the same call.

Available viewport actions: scroll_to_content, set_zoom, zoom_in, zoom_out, reset_zoom.

Supported drawing objects:
- type: "rectangle", "ellipse", "diamond", "arrow", or "text"
- id: stable unique string
- x, y: top-left canvas coordinates
- width, height: size for shapes and arrows
- text: required for text objects
- label: optional for shapes and arrows, as { "text": "...", "fontSize": 18 }
- backgroundColor: optional fill color such as "#a5d8ff"
- fillStyle: optional, usually "solid"
- roundness: optional for rectangles, usually { "type": 3 }

For color and visual hierarchy:
- Use a tight palette of at most 2 to 3 background colors across the entire canvas. Do not give every shape a unique color.
- Color must encode meaning: same color = same role or category (for example, all problems pink, all solutions blue, all metrics yellow). If you cannot articulate what a color means, do not use it.
- A safe default is one neutral color (such as #e7f5ff or #f8f9fa) for most shapes and one accent color for the single most important node. When in doubt, use one color for everything.
- Never assign a different color to each shape just to differentiate them. Position, label, and shape type already differentiate them.
- The center or origin node of a hub-and-spoke, the conclusion of a flow, or the "headline" concept should get the accent color. Supporting nodes share the neutral color.

For text and labels:
- ALWAYS use a shape's "label" field for any text that belongs INSIDE a shape (node names, card titles, button labels, anything inside a rectangle/ellipse/diamond). NEVER place a standalone "text" element on top of or overlapping a shape - Excalidraw renders standalone text by literal coordinates with no auto-centering or wrapping, so it will bleed outside the shape and look broken. Use the shape's label and Excalidraw will center and wrap correctly.
- Standalone text elements are reserved for: the canvas title, top-level section headers placed CLEARLY OUTSIDE any shape, axis labels on charts, and arrow labels (use the arrow's label field, not a free-floating text element).
- If you find yourself wanting a text element near or over a shape, stop - that text should be the shape's label instead.
- Do not create paragraph-style text blocks of details, sub-bullets, examples, or explanatory notes hanging beside a shape. If the detail does not fit inside the shape label in 3-7 words, drop the detail or replace the shape with a tighter concept.
- Do not pair a labeled shape with a detail text block describing the same concept. One concept is one element, not two.
- Count standalone text blocks toward the 8-10 element budget. A board with 8 boxes and 6 caption blocks is 14 elements, which is too many.
- Keep labels short enough to fit inside their shape, or make the shape wider and taller.
- Treat shape labels as centered inside their shape.
- Make each labeled shape large enough for its label text plus padding.
- Keep at least 24 px of internal padding between label text and the shape border.
- Do not place text over arrows, shape borders, or another object's label.

For multiline text:
- You may use newlines in text and label strings.
- In tool arguments, represent a newline with a single JSON newline escape: "\\n".
- Do not double-escape newlines as "\\\\n"; that renders as the literal characters backslash and n on the canvas.
- Correct: {"label":{"text":"Moonshine\\nTranscription"}}
- Incorrect: {"label":{"text":"Moonshine\\\\nTranscription"}}

For arrows:
- Use type: "arrow"
- Use points: [[0, 0], [width, height]]
- Use endArrowhead: "arrow" when direction matters
- Prefer unlabeled arrows when the meaning is obvious from nearby node labels.
- Only label an arrow when the relationship needs a short verb or phrase.
- Keep arrow labels to 1-2 words.
- Only label an arrow when the arrow segment is long enough to leave clear space around the label.
- Never place an arrow label inside a shape or touching a shape border.
- An arrow must connect two visually adjacent shapes only. The straight segment between its endpoints must not pass through, clip, or overlap the body of any other shape, label, or text element on the canvas.
- Before adding an arrow, mentally draw the line from start to end and check whether it crosses any rectangle, ellipse, or diamond bounds. If it does, do not add that arrow. Either move one of the shapes so the two are adjacent, drop the arrow entirely, or replace the relationship with proximity and shared color instead.
- Prefer purely horizontal or purely vertical arrows aligned to the connected shapes' centers. Avoid diagonal arrows that span more than one row or column of nodes.
- Each arrow's endpoints should sit just outside the source and target shape borders (a small gap of 5-15 px). Do not start or end an arrow inside a shape.
- If two related concepts cannot be made adjacent without a long or crossing arrow, restructure the layout (reflow the rows/columns) before resorting to a long arrow.

For charts:
- Build simple charts from basic objects.
- Use text for the title and labels.
- Use arrows or lines for axes.
- Use rectangles, arrows, or connected line segments for data marks.

Layout rules:
- Prefer labeled rectangles, diamonds, ellipses, arrows, and text.
- Use stable ids when an object keeps the same conceptual role, but change positions and labels when a better overall layout is available.
- Keep the layout readable with generous spacing and font sizes >= 16.
- Leave at least 60 px of empty space between adjacent shape bounds, and at least 80 px between columns of nodes. 32 px is the absolute minimum and only acceptable for tightly grouped elements.
- Aim for at most 8 to 10 primary nodes on the final canvas. If you find yourself creating an 11th node, first consolidate or remove a less essential one.
- Prefer a small clear diagram over a crowded canvas.
- Favor short labels of 3-7 words per node. Keep node text to at most 2 lines. If a node needs more detail, drop the detail or split into a separate clearly grouped sub-region.
- Build one dominant flow or structure (left-to-right, top-to-bottom, or hub-and-spoke) rather than a grid of loosely connected boxes. The viewer should be able to trace the main story in one path.
- The chosen structure must be visible through explicit connectors, not just positioning. If you use a hub-and-spoke layout, draw a short arrow or line from the hub to each spoke. If you use a left-to-right or top-to-bottom flow, draw arrows between consecutive nodes. A reader should be able to see the relationship at a glance without inferring it from layout alone.
- The canvas must hold ONE structure, not two stacked ones. If the talk suggests two independent structural lenses (for example, a decomposition into parts AND a timeline of phases, or pillars AND a roadmap), pick the single lens that best summarizes the talk and drop the other, or compress it into one inline annotation, a single small row of labels, or one summary shape. Do not place a hub-and-spoke above a vertical timeline (or any analogous pairing) connected by one bridging arrow; that pattern reads as two diagrams glued together rather than one coherent picture. If you catch yourself starting a second diagram below or beside the first, delete one of the two.
- Common patterns to draw from when the talk fits one:
- · Parallel peers (independent items at the same level: features, risks, themes, OKRs, perspectives, competitors, principles): same-size grid of cards (single row of 3-4, 2x2 for 4, 3x2 for 5-6). NO arrows between peer cards - arrows imply ordering. Cap at 3-5 cards; fold extras into a single "watch list" card.
- · Schema dimensions: when each card has the same fixed structure (e.g. risk = prob + indicator + owner + mitigation), render each dimension as its own labeled line ("Real:", "Ask:", "Owner:", "Move:") inside the card. Don't collapse to paragraph text - it hides the comparison.
- · Severity / status / tier: encode as fill color, NOT as a written word. high/red = #ffc9c9, medium/orange = #ffd8a8, low/yellow = #fff3bf, on-track/green = #d3f9d8, neutral = #f8f9fa. Don't write "Red" or "Yellow" in the label - the color IS the tier.
- · Card label hierarchy: 1-3 word headline (largest) + 4-8 word subtitle + at most one or two further short lines. Never write 5+ line paragraph labels.
- · Chronology (4+ dated events): single horizontal row of compact shapes connected by short rightward arrows. Each label leads with the date/time on its own line + 2-4 word event below.
- · Hero content: the headline result/metric/outcome of the talk gets ~2x area and the strongest accent color, reserved for that one element so the audience sees it unmistakably.
- · Meta content (open questions, takeaways, action items, gotchas, limitations, asks): separate bottom row in a distinct color, one item per card with 1-3 word handle + short clarifying line. Don't fold into the main grid; don't collapse into one banner.
- · Setup / context: single short banner under the title - one line, comma-separated facts. Don't chain context facts with arrows.
- · No meta-explanation hub between title and content. The title alone provides framing. Don't insert a hub card that fans arrows down to peer cards.
- · Scoreboard: when there are aggregate counts (e.g. "12 KRs · 3 green · 7 yellow · 2 red"), render as a one-line strip under the title.
- · Comparison / before-after: header above two equal-width side-by-side columns; verdict centered below both.
- · Benchmark / scorecard with 3+ entities × 2+ metrics: render as a TABLE (entities as rows, metrics as columns); highlight the winner per metric. Overrides parallel peers.
- · Hiring rubric / process-with-criteria: column-per-stage matrix (header / signals row / anti-signals row / pass-bar row). Color-encode rows by content type.
- · Long ordered list (6+ steps): never one shape per step (causes serpentine that overflows). Either group into 3-4 phase shapes with sub-steps in multi-line labels, OR keep only 4-5 highest-leverage items as shapes.
- After placing the shapes for a layout, before finishing, audit the canvas: do the connectors actually convey the structure you intended? If a peripheral node has no connector to anything, either add one or remove the node.
- Avoid long-distance arrows that cross the canvas. Keep arrows under ~250 px and connect adjacent nodes. If two nodes need a connection that requires a long arrow, restructure the layout so they end up adjacent instead.
- Avoid arrow labels longer than two words; if you cannot make the relationship obvious without a long phrase, restructure the diagram instead.
- For summary-style talks, prefer a single-screen composition over a sprawling board.
- Keep important content inside an approximate 1000 px wide by 780 px tall frame so it can be read in one viewport.
- If the diagram grows beyond that frame, consolidate or replace details instead of extending farther right or down.
- Use both axes of the frame, not just one. A diagram that runs as a single horizontal row across the full 1000 px width while using only ~100 px of vertical space (or the analogous tall-thin column) is underdeveloped: it wastes half the canvas, tends to overshoot 1000 px wide because shapes get compressed, and turns rich content into overly abstract labels. When a primary flow has 4 or more nodes, either (a) fold it into a two-row top-bottom serpentine so each shape can be larger and the diagram fills both axes, or (b) keep only 3 nodes on the main axis and expand the most concept-rich node perpendicular to the flow into 2-3 concrete sub-points (the specific examples, sub-effects, or breakdown the speaker named). The goal is a 2D composition that uses the full frame, not a one-dimensional chain.
- Use set_zoom or zoom_out when needed so the audience can see the complete diagram in one viewport, and scroll_to_content to recenter on the speaker's current focus.
- Before editing the whiteboard, mentally check the rendered scene for clipped labels, overlapping labels, arrow labels touching shapes, cramped spacing, and arrows that cross over other shapes or labels. The attached viewport screenshot is the most reliable signal that something looks wrong - if it does, fix it on the next edit.
- When the canvas already conveys the speaker's main points, prefer NOT updating over adding another node. Each new node should earn its place by carrying a distinct concept.
- If no update is useful, do not call a tool.
- After all useful whiteboard updates are complete, respond with exactly DONE.
- Do not summarize what changed or say anything else after the updates.

Examples:
{"type":"rectangle","id":"node-1","x":100,"y":100,"width":220,"height":80,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"label":{"text":"Main idea","fontSize":18}}
{"type":"arrow","id":"edge-1","x":320,"y":140,"width":160,"height":0,"points":[[0,0],[160,0]],"endArrowhead":"arrow","label":{"text":"leads to","fontSize":14}}
{"type":"text","id":"title","x":100,"y":40,"text":"Live Talking Points","fontSize":24}`;
}
