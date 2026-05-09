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

  assert.match(appSource, /import\s*\{[^}]*\bExcalidraw\b[^}]*\bconvertToExcalidrawElements\b/s);
  assert.match(appSource, /type: "whiteboard:screenshot"/);
  // Live screenshot loop still uses the cheap static-canvas path, not
  // exportToBlob with hardcoded 1280x720 dims (the previous regression).
  assert.match(appSource, /canvas\.excalidraw__canvas\.static/);
  assert.match(appSource, /blobToDataUrl/);
  assert.doesNotMatch(appSource, /getDimensions: \(\) => \(\{ width: 1280, height: 720/);
  assert.doesNotMatch(appSource, /fitToContent/);
});

test("frontend downsizes screenshot images before sending them", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /async function downscaleBlobByHalf\(blob\)/);
  assert.match(appSource, /Math\.floor\(bitmap\.width \/ 2\)/);
  assert.match(appSource, /Math\.floor\(bitmap\.height \/ 2\)/);
  assert.match(appSource, /const downscaled = await downscaleBlobByHalf\(blob\);[\s\S]*return await blobToDataUrl\(downscaled\);/);
  assert.match(appSource, /captureStagingSceneAsImage[\s\S]*const downscaled = await downscaleBlobByHalf\(blob\);/);
});

test("frontend skips staging screenshot image when staging is empty", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /if \(!Array\.isArray\(elements\) \|\| elements\.length === 0\) \{[\s\S]*return null;[\s\S]*\}/);
  assert.doesNotMatch(appSource, /PLACEHOLDER_IMAGE/);
});

test("frontend pushes user-drawn live elements to the server", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /type: "whiteboard:user-elements"/);
  assert.match(appSource, /handleExcalidrawChange/);
});

test("frontend flushes pending agent instructions before starting preso", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /async function flushAgentInstructionsSave\(\)/);
  assert.match(appSource, /async function startPreso\(\)[\s\S]*await flushAgentInstructionsSave\(\)[\s\S]*fetch\("\/api\/preso\/start"/);
});

test("frontend handles viewport commands from the agent", () => {
  const appSource = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");

  assert.match(appSource, /message\.type === "whiteboard:viewport"/);
  assert.match(appSource, /applyWhiteboardViewportCommand/);
  assert.match(appSource, /action === "scroll_to_content"/);
  assert.match(appSource, /action === "set_zoom"/);
});
