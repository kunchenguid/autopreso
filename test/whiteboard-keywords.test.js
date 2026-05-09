import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTranscriptionVocabularyPrompt,
  extractWhiteboardKeywords,
} from "../src/whiteboard-keywords.js";

test("extractWhiteboardKeywords returns [] for non-arrays", () => {
  assert.deepEqual(extractWhiteboardKeywords(null), []);
  assert.deepEqual(extractWhiteboardKeywords(undefined), []);
  assert.deepEqual(extractWhiteboardKeywords({}), []);
});

test("pulls text from text elements and label.text from shapes", () => {
  const elements = [
    { type: "text", text: "Kafka consumer group" },
    { type: "rectangle", label: { text: "Schema registry" } },
    { type: "ellipse", label: { text: "gRPC stub" } },
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.ok(keywords.includes("Kafka consumer group"));
  assert.ok(keywords.includes("Schema registry"));
  assert.ok(keywords.includes("gRPC stub"));
});

test("dedupes case-insensitively, keeping first-seen casing", () => {
  const elements = [
    { type: "text", text: "Kafka" },
    { type: "rectangle", label: { text: "kafka" } },
    { type: "text", text: "KAFKA" },
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.deepEqual(keywords, ["Kafka"]);
});

test("splits multi-line text elements into separate phrases", () => {
  const elements = [
    { type: "text", text: "Avro\nProtobuf\nThrift" },
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.deepEqual(keywords.sort(), ["Avro", "Protobuf", "Thrift"].sort());
});

test("drops short, numeric, and empty terms", () => {
  const elements = [
    { type: "text", text: "Hi" },             // too short
    { type: "text", text: "  " },             // whitespace only
    { type: "text", text: "12345" },          // pure digits
    { type: "text", text: "!!!" },            // pure punctuation
    { type: "text", text: "Avro" },           // keep
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.deepEqual(keywords, ["Avro"]);
});

test("ignores non-text, non-labeled elements", () => {
  const elements = [
    { type: "rectangle", id: "plain" },
    { type: "arrow", points: [[0, 0]] },
    null,
    "not-an-element",
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.deepEqual(keywords, []);
});

test("sorts longer phrases first so they survive a char cap", () => {
  const elements = [
    { type: "text", text: "API" },
    { type: "text", text: "distributed consensus" },
    { type: "text", text: "Raft" },
  ];
  const keywords = extractWhiteboardKeywords(elements);
  assert.equal(keywords[0], "distributed consensus");
});

test("buildTranscriptionVocabularyPrompt returns empty string for empty input", () => {
  assert.equal(buildTranscriptionVocabularyPrompt([]), "");
  assert.equal(buildTranscriptionVocabularyPrompt(null), "");
});

test("buildTranscriptionVocabularyPrompt formats keywords as a comma-separated phrase", () => {
  const prompt = buildTranscriptionVocabularyPrompt(["Kafka", "Avro", "schema registry"]);
  assert.match(prompt, /Kafka/);
  assert.match(prompt, /Avro/);
  assert.match(prompt, /schema registry/);
  // Comma-separated, single line.
  assert.ok(!prompt.includes("\n"));
});

test("buildTranscriptionVocabularyPrompt enforces a char cap, dropping later terms", () => {
  const prompt = buildTranscriptionVocabularyPrompt(
    ["alpha", "beta", "gamma"],
    { maxChars: 50 },
  );
  assert.ok(prompt.length <= 50, `prompt should fit in 50 chars, got ${prompt.length}: ${prompt}`);
  assert.match(prompt, /alpha/);
  assert.ok(!prompt.includes("gamma"), "trailing term should be dropped under cap");
});

test("buildTranscriptionVocabularyPrompt skips oversized terms and keeps fitting terms", () => {
  const prompt = buildTranscriptionVocabularyPrompt(
    ["a very long term that cannot fit", "Avro", "Raft"],
    { maxChars: 46 },
  );
  assert.ok(prompt.length <= 46, `prompt should fit in 46 chars, got ${prompt.length}: ${prompt}`);
  assert.ok(!prompt.includes("a very long term"));
  assert.match(prompt, /Avro/);
  assert.match(prompt, /Raft/);
});
