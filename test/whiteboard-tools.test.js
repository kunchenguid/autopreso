import assert from "node:assert/strict";
import { test } from "node:test";

import { applyWhiteboardEditOperations, formatLineNumberedWhiteboard } from "../src/whiteboard-tools.js";

test("formatLineNumberedWhiteboard prefixes each element with padded line numbers", () => {
  assert.equal(
    formatLineNumberedWhiteboard([
      { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
      { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
    ]),
    [
      '001: {"type":"text","id":"title","x":72,"y":68,"text":"AutoPreso"}',
      '002: {"type":"rectangle","id":"voice","x":80,"y":140,"width":220,"height":80}',
    ].join("\n"),
  );
});

test("applyWhiteboardEditOperations edits whiteboard elements by line number", () => {
  const elements = [
    { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ];

  assert.deepEqual(
    applyWhiteboardEditOperations(elements, [
      { type: "replace", line: 2, element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 260, height: 88 } },
      { type: "insert_after", line: 2, element: { type: "arrow", id: "voice-to-agent", x: 340, y: 184, width: 160, height: 0 } },
      { type: "delete", line: 1 },
    ]),
    [
      { type: "rectangle", id: "voice", x: 80, y: 140, width: 260, height: 88 },
      { type: "arrow", id: "voice-to-agent", x: 340, y: 184, width: 160, height: 0 },
    ],
  );
});

test("applyWhiteboardEditOperations can insert into an empty whiteboard", () => {
  assert.deepEqual(
    applyWhiteboardEditOperations([], [
      { type: "insert_after", line: 0, element: { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" } },
    ]),
    [{ type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" }],
  );
});

test("applyWhiteboardEditOperations rejects out-of-range line numbers", () => {
  assert.throws(
    () => applyWhiteboardEditOperations([], [{ type: "replace", line: 1, element: { type: "text", id: "title" } }]),
    /Cannot replace line 1/,
  );
});
