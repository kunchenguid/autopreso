import assert from "node:assert/strict";
import { test } from "node:test";

import { createTranscriptTurnQueue } from "../src/transcript-turn-queue.js";

test("queue sends a transcript immediately when the agent is idle", async () => {
  const turns = [];
  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
    },
  });

  await queue.enqueue("first point");
  await queue.idle();

  assert.deepEqual(turns, ["first point"]);
});

test("queue buffers incoming transcript while a turn is running", async () => {
  const turns = [];
  let releaseFirstTurn;
  const firstTurnDone = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });

  const queue = createTranscriptTurnQueue({
    runTurn: async (text) => {
      turns.push(text);
      if (text === "first") {
        await firstTurnDone;
      }
    },
  });

  queue.enqueue("first");
  queue.enqueue("second");
  queue.enqueue("third");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(turns, ["first"]);

  releaseFirstTurn();
  await queue.idle();

  assert.deepEqual(turns, ["first", "second\nthird"]);
});
