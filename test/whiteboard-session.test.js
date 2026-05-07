import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardSession } from "../src/whiteboard-session.js";

test("whiteboard session queues transcript turns with production batching", async () => {
  const turns = [];
  let releaseFirstTurn;
  const firstTurnDone = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });

  const session = createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async ({ transcript }) => {
      turns.push(transcript);
      if (transcript === "first") await firstTurnDone;
    },
  });

  session.queueTranscript("first");
  session.queueTranscript("second");
  session.queueTranscript("third");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(turns, ["first"]);

  releaseFirstTurn();
  await session.idle();

  assert.deepEqual(turns, ["first", "second\nthird"]);
});

test("whiteboard session stores latest browser screenshot for later agent turns", async () => {
  const screenshots = [];
  const session = createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async ({ state }) => screenshots.push(state.latestScreenshot),
  });

  session.updateLatestScreenshot("data:image/png;base64,latest");
  await session.queueTranscript("inspect current canvas");
  await session.idle();

  assert.deepEqual(screenshots, ["data:image/png;base64,latest"]);
});
