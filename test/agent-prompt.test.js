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

  assert.match(prompt, /ALWAYS use a shape's "label" field for any text that belongs INSIDE a shape/);
  assert.match(prompt, /NEVER place a standalone "text" element on top of or overlapping a shape/);
  assert.match(prompt, /Standalone text elements are reserved for/);
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

test("whiteboard prompt explains the combined whiteboard_apply tool", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /Use whiteboard_apply for normal incremental changes/);
  assert.match(prompt, /Use whiteboard_overwrite only when you need to clear, reset, or start fresh/);
  assert.match(prompt, /whiteboard_apply takes optional operations \(edit ops\) and an optional viewport command/);
  assert.match(prompt, /Combine all edits and the viewport move into a single whiteboard_apply call per turn/);
  assert.match(prompt, /Do NOT make multiple back-to-back whiteboard_apply calls/);
  assert.doesNotMatch(prompt, /call updateWhiteboard/);
  assert.doesNotMatch(prompt, /whiteboard_edit/);
  assert.doesNotMatch(prompt, /whiteboard_viewport/);
});

test("whiteboard prompt explains viewport control via whiteboard_apply", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /screenshot of the audience's CURRENT VIEWPORT/);
  assert.match(prompt, /pass viewport with action "scroll_to_content"/);
  assert.match(prompt, /Available viewport actions: scroll_to_content, set_zoom, zoom_in, zoom_out, reset_zoom/);
});

test("whiteboard prompt tells the agent to keep summary diagrams inside one readable viewport", () => {
  const prompt = whiteboardSystemPrompt();

  assert.match(prompt, /For summary-style talks, prefer a single-screen composition/);
  assert.match(prompt, /Keep important content inside an approximate 1000 px wide by 780 px tall frame/);
  assert.match(prompt, /If the diagram grows beyond that frame, consolidate or replace details/);
  assert.match(prompt, /Use set_zoom or zoom_out when needed so the audience can see the complete diagram/);
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
  assert.match(messages[3].content, /use whiteboard_apply for targeted changes/);
});

test("whiteboard agent canvas-task message references the active-talking-point viewport rule", () => {
  const messages = buildWhiteboardAgentMessages({
    agentHistory: [],
    elements: [{ type: "text", id: "existing", x: 10, y: 20, text: "Old note" }],
    transcript: "Fix the layout",
  });

  // Without a screenshot, canvas task is plain text.
  assert.equal(messages[1].role, "user");
  assert.equal(typeof messages[1].content, "string");
  assert.match(messages[1].content, /Current line-numbered whiteboard content/);
  assert.match(messages[1].content, /scroll_to_content/);
  assert.match(messages[1].content, /active talking point/);
});

test("whiteboard agent canvas-task message includes the latest screenshot when one is present", () => {
  const messages = buildWhiteboardAgentMessages({
    agentHistory: [],
    elements: [{ type: "text", id: "existing", x: 10, y: 20, text: "Old note" }],
    latestScreenshot: "data:image/png;base64,test-image",
    transcript: "Fix the layout",
  });

  assert.equal(messages[1].role, "user");
  assert.ok(Array.isArray(messages[1].content), "with screenshot, canvas task is multimodal");
  assert.equal(messages[1].content.find((p) => p.type === "image")?.image, "data:image/png;base64,test-image");
  const textPart = messages[1].content.find((p) => p.type === "text");
  assert.match(textPart.text, /Current line-numbered whiteboard content/);
});

test("whiteboard agent history appends transcript only", () => {
  const history = appendWhiteboardAgentHistory([], { transcript: "The transcript goes to an agent" });

  assert.deepEqual(history, [
    { role: "user", content: "Speaker turn:\nThe transcript goes to an agent" },
  ]);
  assert.doesNotMatch(JSON.stringify(history), /Current line-numbered whiteboard content/);
  assert.doesNotMatch(JSON.stringify(history), /"type":"rectangle"/);
});

import { extractAgentUsage } from "../src/server.js";

test("extractAgentUsage handles AI SDK shape with cachedInputTokens", () => {
  const usage = extractAgentUsage({
    usage: { inputTokens: 5000, outputTokens: 30, cachedInputTokens: 4500 },
  });
  assert.equal(usage.input, 5000);
  assert.equal(usage.cached, 4500);
  assert.equal(usage.output, 30);
});

test("extractAgentUsage handles OpenAI Chat Completions shape", () => {
  const usage = extractAgentUsage({
    usage: {
      prompt_tokens: 5200,
      completion_tokens: 28,
      prompt_tokens_details: { cached_tokens: 4800 },
    },
  });
  assert.equal(usage.input, 5200);
  assert.equal(usage.cached, 4800);
  assert.equal(usage.output, 28);
});

test("extractAgentUsage handles OpenAI Responses API shape", () => {
  const usage = extractAgentUsage({
    usage: {
      input_tokens: 6000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 5800 },
      reasoning_tokens: 50,
    },
  });
  assert.equal(usage.input, 6000);
  assert.equal(usage.cached, 5800);
  assert.equal(usage.output, 100);
  assert.equal(usage.reasoning, 50);
});

test("extractAgentUsage tolerates missing usage", () => {
  assert.deepEqual(extractAgentUsage({}), { input: 0, cached: 0, output: 0, reasoning: 0 });
  assert.deepEqual(extractAgentUsage(null), { input: 0, cached: 0, output: 0, reasoning: 0 });
});

import { extractPrimerText, reshapeMessagesForCodex } from "../src/server.js";

test("extractPrimerText pulls all text parts from the multimodal primer", () => {
  const primer = {
    role: "user",
    content: [
      { type: "text", text: "Reference context line 1" },
      { type: "text", text: "Reference context line 2" },
      { type: "image", image: "data:image/png;base64,abc" },
    ],
  };
  assert.equal(
    extractPrimerText(primer),
    "Reference context line 1\n\nReference context line 2",
  );
});

test("extractPrimerText handles string content (new text-only primer shape)", () => {
  assert.equal(extractPrimerText({ role: "user", content: "primer text" }), "primer text");
});

test("extractPrimerText returns empty string for null or unrecognized content", () => {
  assert.equal(extractPrimerText(null), "");
  assert.equal(extractPrimerText({ role: "user", content: 42 }), "");
});

test("reshapeMessagesForCodex strips text from primer, keeps image", () => {
  const primer = {
    role: "user",
    content: [
      { type: "text", text: "primer text" },
      { type: "image", image: "data:image/png;base64,abc" },
    ],
  };
  const speaker = { role: "user", content: "Speaker turn:\nhello" };
  const reshaped = reshapeMessagesForCodex([primer, speaker]);
  assert.equal(reshaped.length, 2);
  assert.deepEqual(reshaped[0].content, [{ type: "image", image: "data:image/png;base64,abc" }]);
  assert.equal(reshaped[1], speaker);
});

test("reshapeMessagesForCodex drops the primer entirely if it has no non-text parts", () => {
  const primer = { role: "user", content: [{ type: "text", text: "primer text" }] };
  const speaker = { role: "user", content: "speaker" };
  const reshaped = reshapeMessagesForCodex([primer, speaker]);
  assert.deepEqual(reshaped, [speaker]);
});

test("reshapeMessagesForCodex drops a string-content user primer (text now lives in instructions)", () => {
  const messages = [
    { role: "user", content: "primer text" },
    { role: "user", content: "Speaker turn:\nhello" },
  ];
  const reshaped = reshapeMessagesForCodex(messages);
  assert.equal(reshaped.length, 1);
  assert.equal(reshaped[0].content, "Speaker turn:\nhello");
});

test("reshapeMessagesForCodex leaves messages alone when first is not a user message", () => {
  const messages = [{ role: "system", content: "ignored" }];
  assert.equal(reshapeMessagesForCodex(messages), messages);
});
