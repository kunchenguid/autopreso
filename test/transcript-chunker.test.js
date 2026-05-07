import assert from "node:assert/strict";
import { test } from "node:test";

import { chunkTranscriptAtPunctuation } from "../src/transcript-chunker.js";

test("chunks transcript at punctuation boundaries", () => {
  const chunks = chunkTranscriptAtPunctuation("First idea, then the second. Is this useful? Yes!");

  assert.deepEqual(chunks, ["First idea,", "then the second.", "Is this useful?", "Yes!"]);
});

test("keeps trailing text without punctuation as a final chunk", () => {
  const chunks = chunkTranscriptAtPunctuation("Draw a pipeline. Then add the evaluator");

  assert.deepEqual(chunks, ["Draw a pipeline.", "Then add the evaluator"]);
});

test("ignores empty transcript chunks", () => {
  const chunks = chunkTranscriptAtPunctuation("  Wait...  now continue.  ");

  assert.deepEqual(chunks, ["Wait.", ".", ".", "now continue."]);
});
