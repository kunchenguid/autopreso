import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeWhiteboardElements } from "../src/whiteboard-elements.js";

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
