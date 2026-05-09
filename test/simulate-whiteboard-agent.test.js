// @ts-nocheck - hand-rolled EventEmitter is used as a fake Chrome child process; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { closeSimulationResources, estimateTranscriptChunkDelayMs } from "../scripts/simulate-whiteboard-agent.js";

test("simulation cleanup stops Chrome before waiting for the HTTP server to close", async () => {
  const events = [];
  const chrome = new EventEmitter();
  chrome.exitCode = null;
  chrome.kill = () => {
    events.push("chrome:kill");
    chrome.exitCode = 0;
    queueMicrotask(() => chrome.emit("exit"));
  };
  const httpServer = {
    close: (callback) => {
      events.push("http:close");
      assert.ok(events.includes("chrome:kill"));
      callback();
    },
  };

  await closeSimulationResources({ httpServer, chrome });

  assert.deepEqual(events, ["chrome:kill", "http:close"]);
});

test("transcript chunk delay scales linearly with spoken word count", () => {
  const options = { chunkIntervalMs: 0, speakingWordsPerMinute: 120 };

  assert.equal(estimateTranscriptChunkDelayMs("one two", options), 1000);
  assert.equal(estimateTranscriptChunkDelayMs("one two three four", options), 2000);
});

test("transcript chunk delay uses chunk interval as a minimum floor", () => {
  assert.equal(
    estimateTranscriptChunkDelayMs("short", {
      chunkIntervalMs: 750,
      speakingWordsPerMinute: 120,
    }),
    750,
  );
});
