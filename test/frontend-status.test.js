import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.join(import.meta.dirname, "..");

test("frontend clears stale agent thinking status when the socket is closed", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /ws\.addEventListener\("close",[\s\S]*setAgentStatus\("idle"\)/);
  assert.match(appSource, /async function stopListening\(\)[\s\S]*setAgentStatus\("idle"\)/);
});

test("frontend exports and sends whiteboard screenshots over the websocket", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /import \{ Excalidraw, convertToExcalidrawElements/);
  assert.match(appSource, /type: "whiteboard:screenshot"/);
  // Live screenshot loop still uses the cheap static-canvas path, not
  // exportToBlob with hardcoded 1280x720 dims (the previous regression).
  assert.match(appSource, /canvas\.excalidraw__canvas\.static/);
  assert.match(appSource, /blobToDataUrl/);
  assert.doesNotMatch(appSource, /getDimensions: \(\) => \(\{ width: 1280, height: 720/);
  assert.doesNotMatch(appSource, /fitToContent/);
});

test("frontend pushes user-drawn live elements to the server", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /type: "whiteboard:user-elements"/);
  assert.match(appSource, /handleExcalidrawChange/);
});

test("frontend handles viewport commands from the agent", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /message\.type === "whiteboard:viewport"/);
  assert.match(appSource, /applyWhiteboardViewportCommand/);
  assert.match(appSource, /action === "scroll_to_content"/);
  assert.match(appSource, /action === "set_zoom"/);
});
