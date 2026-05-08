import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("agent debug and cache logs create nested log directories", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autopreso-logs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const previousCacheLog = process.env.AUTOPRESO_CACHE_LOG;
  const previousDebugLog = process.env.AUTOPRESO_DEBUG_LOG;
  process.env.AUTOPRESO_CACHE_LOG = path.join(tmp, "nested", "cache", "cache.log");
  process.env.AUTOPRESO_DEBUG_LOG = path.join(tmp, "nested", "debug", "debug.log");
  t.after(() => {
    if (previousCacheLog === undefined) delete process.env.AUTOPRESO_CACHE_LOG;
    else process.env.AUTOPRESO_CACHE_LOG = previousCacheLog;
    if (previousDebugLog === undefined) delete process.env.AUTOPRESO_DEBUG_LOG;
    else process.env.AUTOPRESO_DEBUG_LOG = previousDebugLog;
  });

  const { dumpAgentRequest, logAgentUsage } = await import(`../src/server.js?logging-test=${Date.now()}`);

  logAgentUsage("turn", { usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } });
  dumpAgentRequest("turn", { system: "system", messages: [{ role: "user", content: "hello" }] });

  assert.equal(existsSync(process.env.AUTOPRESO_CACHE_LOG), true);
  assert.equal(existsSync(process.env.AUTOPRESO_DEBUG_LOG), true);

  const cacheRecord = JSON.parse(readFileSync(process.env.AUTOPRESO_CACHE_LOG, "utf8").trim());
  assert.equal(cacheRecord.label, "turn");
  assert.equal(cacheRecord.cachePct, 40);

  const debugLog = readFileSync(process.env.AUTOPRESO_DEBUG_LOG, "utf8");
  const debugRecord = JSON.parse(debugLog.slice(debugLog.indexOf("{")));
  assert.equal(debugRecord.label, "turn");
  assert.equal(debugRecord.systemLength, 6);
});
