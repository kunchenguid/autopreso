import test from "node:test";
import assert from "node:assert/strict";

import { computeAgentCost, computeTranscriptionCost, createSessionCostTracker } from "../src/session-cost.js";

test("computeAgentCost prices uncached input, cached input, and output separately", () => {
  // gpt-5.5: $5.00 input, $0.50 cached, $30.00 output per 1M tokens
  const cost = computeAgentCost({
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 10_000, cached: 8_000, output: 1_000, reasoning: 500 },
  });
  // 2k uncached @ $5/M = $0.01
  // 8k cached @ $0.5/M = $0.004
  // 1k output @ $30/M = $0.03
  // 0.5k reasoning @ $30/M = $0.015 (reasoning billed at output rate)
  assert.ok(cost.priced);
  assert.equal(cost.cost.toFixed(6), (0.01 + 0.004 + 0.03 + 0.015).toFixed(6));
});

test("computeAgentCost returns priced=false for unknown OpenAI model", () => {
  const cost = computeAgentCost({
    provider: "openai",
    model: "gpt-zzz-unknown",
    usage: { input: 10_000, cached: 0, output: 1_000, reasoning: 0 },
  });
  assert.equal(cost.priced, false);
  assert.equal(cost.cost, 0);
});

test("computeAgentCost returns priced=false for ollama (local)", () => {
  const cost = computeAgentCost({
    provider: "ollama",
    model: "llama3.2",
    usage: { input: 100_000, cached: 0, output: 1_000, reasoning: 0 },
  });
  assert.equal(cost.priced, false);
  assert.equal(cost.cost, 0);
  assert.equal(cost.reason, "local");
});

test("computeAgentCost returns priced=false for codex (subscription)", () => {
  const cost = computeAgentCost({
    provider: "codex",
    model: "gpt-5.5",
    usage: { input: 100_000, cached: 0, output: 1_000, reasoning: 0 },
  });
  assert.equal(cost.priced, false);
  assert.equal(cost.cost, 0);
  assert.equal(cost.reason, "subscription");
});

test("computeTranscriptionCost prices per minute for OpenAI models", () => {
  // gpt-4o-transcribe: $0.006 / minute
  const cost = computeTranscriptionCost({
    provider: "openai",
    model: "gpt-4o-transcribe",
    seconds: 120,
  });
  assert.ok(cost.priced);
  assert.equal(cost.cost.toFixed(6), (0.006 * 2).toFixed(6));
});

test("computeTranscriptionCost returns priced=false for moonshine (local)", () => {
  const cost = computeTranscriptionCost({
    provider: "moonshine",
    model: "small",
    seconds: 600,
  });
  assert.equal(cost.priced, false);
  assert.equal(cost.cost, 0);
  assert.equal(cost.reason, "local");
});

test("createSessionCostTracker accumulates agent usage across turns", () => {
  const tracker = createSessionCostTracker();
  tracker.recordAgentUsage({
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 5_000, cached: 4_000, output: 100, reasoning: 0 },
  });
  tracker.recordAgentUsage({
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 6_000, cached: 5_500, output: 50, reasoning: 0 },
  });
  const summary = tracker.getSummary();
  assert.equal(summary.agent.tokens.input, 11_000);
  assert.equal(summary.agent.tokens.cached, 9_500);
  assert.equal(summary.agent.tokens.output, 150);
  assert.ok(summary.agent.priced);
  // 1500 uncached @ $5/M + 9500 cached @ $0.5/M + 150 output @ $30/M
  const expected = (1500 * 5 + 9500 * 0.5) / 1_000_000 + 150 * 30 / 1_000_000;
  assert.equal(summary.agent.cost.toFixed(6), expected.toFixed(6));
});

test("createSessionCostTracker tracks PCM16 24kHz audio seconds from base64", () => {
  const tracker = createSessionCostTracker();
  // 24000 samples * 2 bytes = 48000 bytes of PCM = 1 second
  const oneSecondPcm = Buffer.alloc(48000).toString("base64");
  tracker.recordTranscriptionAudio({
    provider: "openai",
    model: "gpt-4o-transcribe",
    base64Audio: oneSecondPcm,
  });
  tracker.recordTranscriptionAudio({
    provider: "openai",
    model: "gpt-4o-transcribe",
    base64Audio: oneSecondPcm,
  });
  const summary = tracker.getSummary();
  assert.equal(Math.round(summary.transcription.seconds), 2);
  assert.ok(summary.transcription.priced);
  assert.equal(summary.transcription.cost.toFixed(6), (0.006 * 2 / 60).toFixed(6));
});

test("createSessionCostTracker.reset clears agent and transcription state", () => {
  const tracker = createSessionCostTracker();
  tracker.recordAgentUsage({
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 5_000, cached: 0, output: 100, reasoning: 0 },
  });
  tracker.recordTranscriptionAudio({
    provider: "openai",
    model: "gpt-4o-transcribe",
    base64Audio: Buffer.alloc(48000).toString("base64"),
  });
  tracker.reset();
  const summary = tracker.getSummary();
  assert.equal(summary.agent.tokens.input, 0);
  assert.equal(summary.agent.tokens.output, 0);
  assert.equal(summary.agent.cost, 0);
  assert.equal(summary.transcription.seconds, 0);
  assert.equal(summary.transcription.cost, 0);
});

test("createSessionCostTracker remembers the last seen model and provider", () => {
  const tracker = createSessionCostTracker();
  tracker.recordAgentUsage({
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: { input: 1_000, cached: 0, output: 10, reasoning: 0 },
  });
  tracker.recordTranscriptionAudio({
    provider: "openai",
    model: "whisper-1",
    base64Audio: Buffer.alloc(48000).toString("base64"),
  });
  const summary = tracker.getSummary();
  assert.equal(summary.agent.provider, "openai");
  assert.equal(summary.agent.model, "gpt-5.4-mini");
  assert.equal(summary.transcription.provider, "openai");
  assert.equal(summary.transcription.model, "whisper-1");
});
