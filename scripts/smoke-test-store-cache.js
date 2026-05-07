#!/usr/bin/env node
// Smoke test: does store:true + previous_response_id produce reliable cache
// hits across turns on the Codex Responses API?
//
// Sends 4 sequential requests with a deliberately large stable prefix (>2k
// tokens of static instructions) and a small varying tail. Reports
// usage.input_tokens_details.cached_tokens for each turn so we can see
// whether the cache hits land where we expect.
//
// Two modes:
//   --mode=stored      store:true, chain via previous_response_id
//   --mode=stateless   store:false, send full message history each turn
//
// Run both and compare. Exit 0 if both modes complete without HTTP errors;
// the cache verdict is in the printed table.

import { resolveCodexCliCredentials, DEFAULT_CODEX_BASE_URL } from "../src/codex-auth.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const eq = arg.indexOf("=");
    return eq === -1 ? [arg.replace(/^--/, ""), true] : [arg.slice(2, eq), arg.slice(eq + 1)];
  }),
);

const mode = args.mode ?? "both";
const model = args.model ?? "gpt-5.5";
const turns = Number(args.turns ?? 4);

// Static instructions large enough to exceed the ~1024 token cache minimum.
// Repeating a paragraph gives us a stable prefix in the >2k token range.
const STATIC_INSTRUCTIONS = [
  "You are a test agent for prompt cache verification.",
  "Reply with exactly the single word OK and nothing else.",
  "Do not call tools. Do not explain.",
  "",
  "Background context (intentionally verbose to exceed the prompt cache minimum prefix length):",
  ...Array.from({ length: 60 }, (_, i) =>
    `Paragraph ${i + 1}: This is filler content used to inflate the static instructions block above the 1024-token threshold required for OpenAI prompt caching to engage. The same text is sent on every request, so the cache should match it after the first turn.`,
  ),
].join("\n");

async function callResponses({ baseURL, apiKey, accountId, body }) {
  const url = `${baseURL}/responses`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  // Codex Responses API requires SSE. Walk the stream and collect the final
  // response.completed event payload.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = dataLine.slice(6).trim();
      if (!json || json === "[DONE]") continue;
      let payload;
      try { payload = JSON.parse(json); } catch { continue; }
      if (payload.type === "response.completed") final = payload.response;
    }
  }
  if (!final) throw new Error("Stream ended without response.completed");
  return final;
}

function summarize(label, response) {
  const usage = response?.usage ?? {};
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cached =
    usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const output = usage.output_tokens ?? 0;
  const pct = input > 0 ? Math.round((cached / input) * 100) : 0;
  return { label, input, cached, output, pct, id: response?.id };
}

async function runStoredMode(creds) {
  console.log("\n=== mode: stored (store:true + previous_response_id) ===");
  const rows = [];
  let previousId;
  for (let i = 1; i <= turns; i += 1) {
    const body = {
      model,
      store: true,
      instructions: STATIC_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: previousId
                ? `Turn ${i}: ack.`
                : `Turn ${i}: this is the first message. Reply OK.`,
            },
          ],
        },
      ],
      ...(previousId ? { previous_response_id: previousId } : {}),
    };
    const res = await callResponses({ ...creds, body });
    const row = summarize(`turn${i}`, res);
    rows.push(row);
    previousId = res.id;
    console.log(`turn${i}: input=${row.input} cached=${row.cached} (${row.pct}%) output=${row.output} id=${row.id}`);
  }
  return rows;
}

async function runStatelessMode(creds) {
  console.log("\n=== mode: stateless (store:false, full history each turn) ===");
  const rows = [];
  // Build a chat-like input array that grows by one entry per turn, mirroring
  // how the autopreso server currently sends full agent history.
  const history = [];
  for (let i = 1; i <= turns; i += 1) {
    history.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            i === 1
              ? `Turn ${i}: this is the first message. Reply OK.`
              : `Turn ${i}: ack.`,
        },
      ],
    });
    if (i > 1) {
      // Insert a synthetic prior assistant reply so the cache prefix has
      // something stable on each turn (mimics how autopreso re-sends history
      // including the assistant UNDERSTOOD reply from warmup).
      history.splice(history.length - 1, 0, {
        role: "assistant",
        content: [{ type: "output_text", text: "OK" }],
      });
    }
    const body = {
      model,
      store: false,
      instructions: STATIC_INSTRUCTIONS,
      input: history,
    };
    const res = await callResponses({ ...creds, body });
    const row = summarize(`turn${i}`, res);
    rows.push(row);
    console.log(`turn${i}: input=${row.input} cached=${row.cached} (${row.pct}%) output=${row.output} id=${row.id}`);
  }
  return rows;
}

async function main() {
  const creds = await resolveCodexCliCredentials(process.env);
  console.log(`Using base ${creds.baseURL}, model ${model}, turns ${turns}`);

  const results = {};
  if (mode === "stored" || mode === "both") {
    results.stored = await runStoredMode(creds);
  }
  if (mode === "stateless" || mode === "both") {
    results.stateless = await runStatelessMode(creds);
  }

  console.log("\n=== summary ===");
  for (const [label, rows] of Object.entries(results)) {
    const cachedSum = rows.reduce((acc, r) => acc + r.cached, 0);
    const inputSum = rows.reduce((acc, r) => acc + r.input, 0);
    const pct = inputSum > 0 ? Math.round((cachedSum / inputSum) * 100) : 0;
    console.log(`${label.padEnd(10)} cached=${cachedSum}/${inputSum} (${pct}%) across ${rows.length} turns`);
  }
}

main().catch((err) => {
  console.error("smoke test failed:", err.message);
  process.exitCode = 1;
});
