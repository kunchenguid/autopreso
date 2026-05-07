import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../src/cli-options.js";

test("parseCliArgs returns safe defaults", () => {
  assert.deepEqual(parseCliArgs([], {}), {
    host: "127.0.0.1",
    port: 3210,
    openBrowser: true,
  });
});

test("parseCliArgs reads port from PORT", () => {
  assert.equal(parseCliArgs([], { PORT: "4567" }).port, 4567);
});

test("parseCliArgs accepts --no-open", () => {
  assert.deepEqual(
    parseCliArgs(["--no-open"], { PORT: "4567" }),
    {
      host: "127.0.0.1",
      port: 4567,
      openBrowser: false,
    },
  );
});

test("parseCliArgs rejects --host because the server is loopback-only", () => {
  assert.throws(
    () => parseCliArgs(["--host", "0.0.0.0"], {}),
    /Unknown argument "--host"/,
  );
});

test("parseCliArgs rejects unknown flags so model selection only happens in the UI", () => {
  for (const arg of ["--moonshine-model", "--transcription-provider", "--openai-transcription-model"]) {
    assert.throws(
      () => parseCliArgs([arg, "value"], {}),
      new RegExp(`Unknown argument "${arg}"`),
    );
  }
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
