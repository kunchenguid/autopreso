import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../src/cli-options.js";

test("parseCliArgs returns safe defaults", () => {
  assert.deepEqual(parseCliArgs([], {}), {
    host: "127.0.0.1",
    port: 3210,
    moonshineModel: "medium",
    openBrowser: true,
  });
});

test("parseCliArgs reads port from PORT", () => {
  assert.equal(parseCliArgs([], { PORT: "4567" }).port, 4567);
});

test("parseCliArgs accepts host and Moonshine model", () => {
  assert.deepEqual(
    parseCliArgs([
      "--host",
      "0.0.0.0",
      "--moonshine-model",
      "small",
      "--no-open",
    ], { PORT: "4567" }),
    {
      host: "0.0.0.0",
      port: 4567,
      moonshineModel: "small",
      openBrowser: false,
    },
  );
});

test("parseCliArgs rejects --port because PORT is the only port configuration", () => {
  assert.throws(
    () => parseCliArgs(["--port", "4567"], {}),
    /Unknown argument "--port"/,
  );
});

test("parseCliArgs rejects invalid PORT", () => {
  assert.throws(
    () => parseCliArgs([], { PORT: "nope" }),
    /Invalid PORT "nope"/,
  );
});

test("parseCliArgs rejects --transcribe-model because Moonshine is the only transcriber", () => {
  assert.throws(
    () => parseCliArgs(["--transcribe-model", "gpt-4o-transcribe"], {}),
    /Unknown argument "--transcribe-model"/,
  );
});

test("parseCliArgs rejects unsupported Moonshine models", () => {
  assert.throws(
    () => parseCliArgs(["--moonshine-model", "large"], {}),
    /Unsupported Moonshine model/,
  );
});
