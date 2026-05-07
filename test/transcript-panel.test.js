import assert from "node:assert/strict";
import { test } from "node:test";

import { appendCommittedTranscript, scrollTranscriptToBottom } from "../public/transcript-panel.js";

test("appendCommittedTranscript adds newer transcript text at the bottom", () => {
  assert.deepEqual(appendCommittedTranscript(["first", "second"], "third"), ["first", "second", "third"]);
});

test("appendCommittedTranscript keeps the newest 20 transcript entries", () => {
  const entries = Array.from({ length: 20 }, (_, index) => `turn ${index + 1}`);

  assert.deepEqual(appendCommittedTranscript(entries, "turn 21"), [...entries.slice(1), "turn 21"]);
});

test("scrollTranscriptToBottom scrolls the transcript container downward", () => {
  const container = { scrollTop: 0, scrollHeight: 1200 };

  scrollTranscriptToBottom(container);

  assert.equal(container.scrollTop, 1200);
});
