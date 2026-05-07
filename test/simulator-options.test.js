import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSimulatorArgs } from "../src/simulator-options.js";

test("parseSimulatorArgs requires transcript and out paths", () => {
  assert.throws(() => parseSimulatorArgs([]), /--transcript is required/);
  assert.throws(() => parseSimulatorArgs(["--transcript", "talk.txt"]), /--out is required/);
});

test("parseSimulatorArgs accepts simulator timing and browser options", () => {
  const options = parseSimulatorArgs([
    "--transcript",
    "talk.txt",
    "--out",
    "/tmp/run",
    "--chunk-interval-ms",
    "25",
    "--speaking-words-per-minute",
    "150",
    "--chrome-bin",
    "/Applications/Chrome",
    "--agent-timeout-ms",
    "120000",
  ]);

  assert.equal(options.transcriptPath, "talk.txt");
  assert.equal(options.outDir, "/tmp/run");
  assert.equal(options.chunkIntervalMs, 25);
  assert.equal(options.speakingWordsPerMinute, 150);
  assert.equal(options.chromeBin, "/Applications/Chrome");
  assert.equal(options.agentTimeoutMs, 120000);
});

test("parseSimulatorArgs rejects custom system prompt overrides", () => {
  assert.throws(
    () =>
      parseSimulatorArgs([
        "--transcript",
        "talk.txt",
        "--out",
        "/tmp/run",
        "--system-prompt",
        "prompt.txt",
      ]),
    /Unknown option: --system-prompt/,
  );
});

test("parseSimulatorArgs rejects invalid numeric options", () => {
  assert.throws(
    () =>
      parseSimulatorArgs([
        "--transcript",
        "talk.txt",
        "--out",
        "/tmp/run",
        "--chunk-interval-ms",
        "nope",
      ]),
    /--chunk-interval-ms must be a non-negative integer/,
  );
  assert.throws(
    () =>
      parseSimulatorArgs([
        "--transcript",
        "talk.txt",
        "--out",
        "/tmp/run",
        "--speaking-words-per-minute",
        "0",
      ]),
    /--speaking-words-per-minute must be a positive integer/,
  );
});
