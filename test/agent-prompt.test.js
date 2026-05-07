import assert from "node:assert/strict";
import { test } from "node:test";

import { appendWhiteboardAgentHistory, buildWhiteboardAgentMessages, whiteboardSystemPrompt } from "../src/server.js";

test("whiteboard prompt defines the canvas drawing object contract without relying on library jargon", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /simple drawing objects/);
  assert.match(prompt, /complete replacement array/);
  assert.match(prompt, /type: "rectangle", "ellipse", "diamond", "arrow", or "text"/);
  assert.match(prompt, /id: stable unique string/);
  assert.match(prompt, /x, y: top-left canvas coordinates/);
  assert.match(prompt, /The app will convert these simple drawing objects into Excalidraw elements/);
});

test("whiteboard prompt tells the agent to execute direct canvas commands", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /direct command to perform an action on the canvas/);
  assert.match(prompt, /execute the requested canvas action/);
  assert.match(prompt, /clear the canvas/);
  assert.match(prompt, /add a rectangle/);
  assert.match(prompt, /draw a line chart/);
});

test("whiteboard prompt tells the agent to create visual presentations instead of transcript dumps", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /visual presentation that complements the speaker/);
  assert.match(prompt, /transcript may contain slight inaccuracies/);
  assert.match(prompt, /Use surrounding context/);
  assert.match(prompt, /Do not mirror the transcript/);
  assert.match(prompt, /Reorganize the whole canvas/);
  assert.match(prompt, /concept map/);
  assert.match(prompt, /process diagram/);
});

test("whiteboard prompt tells the agent to avoid text and label overlap", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Use shape labels instead of separate text elements for node names/);
  assert.match(prompt, /Standalone text is only for the canvas title, top-level section headers, and axis labels on charts/);
  assert.match(prompt, /Keep at least 24 px of internal padding between label text and the shape border/);
  assert.match(prompt, /Make each labeled shape large enough for its label text plus padding/);
  assert.match(prompt, /Leave at least 60 px of empty space/);
  assert.match(prompt, /Do not place text over arrows/);
  assert.match(prompt, /Keep arrow labels to 1-2 words/);
});

test("whiteboard prompt makes the agent responsible for final canvas geometry", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Your coordinates and sizes are used directly/);
  assert.match(prompt, /The app does not automatically fix spacing, resize shapes, wrap labels, or reroute arrows/);
  assert.match(prompt, /Before editing the whiteboard, mentally check the rendered scene/);
});

test("whiteboard prompt explains overwrite and edit tool usage", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Use whiteboard_edit for normal incremental changes/);
  assert.match(prompt, /Use whiteboard_overwrite only when you need to clear, reset, or start fresh/);
  assert.match(prompt, /Both tools return the latest full whiteboard as line-numbered content/);
  assert.match(prompt, /Line numbers are references for editing and are not part of the drawing objects/);
  assert.doesNotMatch(prompt, /call updateWhiteboard/);
});

test("whiteboard prompt explains viewport control tool usage", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Use whiteboard_viewport to give the viewer the best readable view of the whiteboard/);
  assert.match(prompt, /The screenshot shows the current viewport, not the entire infinite canvas/);
  assert.match(prompt, /After important whiteboard updates, adjust the viewport so the viewer can see the relevant content clearly/);
  assert.match(prompt, /Available viewport actions: scroll_to_content, set_zoom, zoom_in, zoom_out, reset_zoom/);
});

test("whiteboard prompt tells the agent to keep summary diagrams inside one readable viewport", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /For summary-style talks, prefer a single-screen composition/);
  assert.match(prompt, /Keep important content inside an approximate 1000 px wide by 780 px tall frame/);
  assert.match(prompt, /If the diagram grows beyond that frame, consolidate or replace details/);
  assert.match(prompt, /Use set_zoom or zoom_out when needed so the final screenshot shows the complete diagram/);
});

test("whiteboard prompt tells the agent to finish with DONE only", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /After all useful whiteboard updates are complete, respond with exactly DONE/);
  assert.match(prompt, /Do not summarize what changed/);
});

test("whiteboard prompt discourages cramped arrow labels", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Prefer unlabeled arrows when the meaning is obvious from nearby node labels/);
  assert.match(prompt, /Only label an arrow when the arrow segment is long enough to leave clear space around the label/);
  assert.match(prompt, /Never place an arrow label inside a shape or touching a shape border/);
});

test("whiteboard prompt explains newline escaping for multiline text", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /For multiline text:/);
  assert.match(prompt, /represent a newline with a single JSON newline escape: "\\n"/);
  assert.match(prompt, /Do not double-escape newlines as "\\\\n"/);
  assert.match(prompt, /Correct: \{"label":\{"text":"Moonshine\\nTranscription"\}\}/);
  assert.match(prompt, /Incorrect: \{"label":\{"text":"Moonshine\\\\nTranscription"\}\}/);
});

test("whiteboard agent messages keep stable history before the volatile canvas snapshot", () => {
  const agentHistory = [
    { role: "user", content: "Speaker turn:\nThe app records voice" },
    { role: "assistant", content: "Canvas update summary:\nStarted an architecture diagram" },
  ];
  const messages = buildWhiteboardAgentMessages({
    agentHistory,
    elements: [{ type: "text", id: "existing", x: 10, y: 20, text: "Old note" }],
    transcript: "The agent should visualize the architecture",
  });

  assert.deepEqual(messages.slice(0, 2), agentHistory);
  assert.deepEqual(messages[2], {
    role: "user",
    content: "Speaker turn:\nThe agent should visualize the architecture",
  });
  assert.equal(messages[3].role, "user");
  assert.match(messages[3].content, /Current line-numbered whiteboard content/);
  assert.match(messages[3].content, /001: /);
  assert.match(messages[3].content, /"id":"existing"/);
  assert.match(messages[3].content, /use whiteboard_edit for targeted changes/);
});

test("whiteboard agent messages include the latest screenshot when available", () => {
  const messages = buildWhiteboardAgentMessages({
    agentHistory: [],
    elements: [{ type: "text", id: "existing", x: 10, y: 20, text: "Old note" }],
    latestScreenshot: "data:image/png;base64,test-image",
    transcript: "Fix the layout",
  });

  assert.equal(messages[1].role, "user");
  assert.deepEqual(messages[1].content, [
    {
      type: "text",
      text: 'Current line-numbered whiteboard content:\n001: {"type":"text","id":"existing","x":10,"y":20,"text":"Old note"}\n\nTask:\nUse the latest speaker turn and prior context to decide whether the canvas should change. If updating, use whiteboard_edit for targeted changes. Use whiteboard_overwrite only when you need to clear, reset, or start fresh. Keep the canvas organized around the core concepts, not the transcript sequence.',
    },
    { type: "image", image: "data:image/png;base64,test-image" },
  ]);
});

test("whiteboard agent history appends transcript only", () => {
  const history = appendWhiteboardAgentHistory([], { transcript: "The transcript goes to an agent" });

  assert.deepEqual(history, [
    { role: "user", content: "Speaker turn:\nThe transcript goes to an agent" },
  ]);
  assert.doesNotMatch(JSON.stringify(history), /Current line-numbered whiteboard content/);
  assert.doesNotMatch(JSON.stringify(history), /"type":"rectangle"/);
});
