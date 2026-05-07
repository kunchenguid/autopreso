import { WebSocket } from "ws";

import { STARTER_ELEMENTS } from "../public/starter-elements.js";
import { createTranscriptTurnQueue } from "./transcript-turn-queue.js";

export function createWhiteboardSession({ options, wss, runAgent }) {
  const state = {
    elements: seedElements(),
    agentHistory: [],
    agentStatus: "idle",
    agentBusy: false,
    latestScreenshot: undefined,
  };

  const queue = createTranscriptTurnQueue({
    runTurn: async (transcript) => {
      state.agentBusy = true;
      state.agentStatus = "thinking";
      broadcast(wss, { type: "agent:status", status: "thinking" });
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
        state.agentStatus = "idle";
        broadcast(wss, { type: "agent:status", status: "idle" });
      }
    },
  });

  state.queueTranscript = (text) => queue.enqueue(text);
  state.idle = () => queue.idle();
  state.updateLatestScreenshot = (image) => {
    state.latestScreenshot = image;
  };
  return state;
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
  return structuredClone(STARTER_ELEMENTS);
}
