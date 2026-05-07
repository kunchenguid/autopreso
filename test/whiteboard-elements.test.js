import assert from "node:assert/strict";
import { test } from "node:test";

import { detectMalformedLayoutWarnings, normalizeWhiteboardElements } from "../src/whiteboard-elements.js";

test("normalizeWhiteboardElements returns an empty array for non-array input", () => {
  assert.deepEqual(normalizeWhiteboardElements(undefined), []);
});

test("normalizeWhiteboardElements leaves labeled shapes unchanged", () => {
  const elements = [
    {
      type: "rectangle",
      id: "idea",
      x: 100,
      y: 80,
      width: 40,
      height: 20,
      label: { text: "Customer onboarding", fontSize: 18 },
    },
  ];

  assert.equal(normalizeWhiteboardElements(elements), elements);
  assert.deepEqual(normalizeWhiteboardElements(elements), elements);
});

test("normalizeWhiteboardElements leaves arrows unchanged", () => {
  const elements = [
    {
      type: "arrow",
      id: "edge",
      x: 300,
      y: 180,
      width: 48,
      height: 0,
      points: [
        [0, 0],
        [48, 0],
      ],
      label: { text: " transcription ", fontSize: 14 },
    },
  ];

  assert.equal(normalizeWhiteboardElements(elements), elements);
  assert.deepEqual(normalizeWhiteboardElements(elements), elements);
});

test("normalizeWhiteboardElements leaves text unchanged", () => {
  const elements = [{ type: "text", id: "note", x: 0, y: 0, text: "Hello", fontSize: 18 }];

  assert.equal(normalizeWhiteboardElements(elements), elements);
  assert.deepEqual(normalizeWhiteboardElements(elements), elements);
});

test("detectMalformedLayoutWarnings flags a standalone text overlapping a shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    { type: "rectangle", id: "card", x: 100, y: 100, width: 300, height: 100 },
    { type: "text", id: "loose-text", x: 110, y: 110, text: "OpenAI", fontSize: 24 },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /standalone text "OpenAI"/);
  assert.match(warnings[0], /id "loose-text"/);
  assert.match(warnings[0], /shape "card"/);
  assert.match(warnings[0], /label/);
});

test("detectMalformedLayoutWarnings does NOT flag standalone text placed clearly outside any shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    { type: "rectangle", id: "card", x: 100, y: 100, width: 300, height: 100 },
    { type: "text", id: "title", x: 0, y: 0, text: "Section title", fontSize: 24 },
  ]);
  assert.equal(warnings.length, 0);
});

test("detectMalformedLayoutWarnings flags a labeled shape that is too narrow for its label", () => {
  const warnings = detectMalformedLayoutWarnings([
    {
      type: "rectangle",
      id: "narrow",
      x: 0,
      y: 0,
      width: 80,
      height: 100,
      label: { text: "Realtime-2 voice generation", fontSize: 18 },
    },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /shape "narrow" is 80px wide/);
  assert.match(warnings[0], /shorten the label/);
});

test("detectMalformedLayoutWarnings is silent on a properly-sized labeled shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    {
      type: "rectangle",
      id: "ok",
      x: 0,
      y: 0,
      width: 400,
      height: 90,
      label: { text: "OpenAI", fontSize: 18 },
    },
  ]);
  assert.equal(warnings.length, 0);
});
