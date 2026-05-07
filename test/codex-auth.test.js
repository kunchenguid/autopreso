import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveCodexCliCredentials } from "../src/codex-auth.js";

test("resolveCodexCliCredentials reads Codex CLI auth from CODEX_HOME", async () => {
  const codexHome = writeCodexAuth({ accessToken: jwtWithExp(Date.now() + 300_000), refreshToken: "refresh-token" });

  const credentials = await resolveCodexCliCredentials({ CODEX_HOME: codexHome });

  assert.equal(credentials.apiKey.split(".").length, 3);
  assert.equal(credentials.refreshToken, "refresh-token");
  assert.equal(credentials.baseURL, "https://chatgpt.com/backend-api/codex");
});

test("resolveCodexCliCredentials refreshes expiring Codex CLI auth in place", async () => {
  const codexHome = writeCodexAuth({ accessToken: jwtWithExp(Date.now() - 60_000), refreshToken: "old-refresh" });

  const credentials = await resolveCodexCliCredentials(
    { CODEX_HOME: codexHome },
    {
      fetchFn: async (url, init) => {
        assert.equal(url, "https://auth.openai.com/oauth/token");
        assert.equal(init.method, "POST");
        assert.match(init.body.toString(), /refresh_token=old-refresh/);
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
      },
    },
  );

  assert.equal(credentials.apiKey, "new-access");
  assert.equal(credentials.refreshToken, "new-refresh");

  const saved = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
  assert.equal(saved.tokens.access_token, "new-access");
  assert.equal(saved.tokens.refresh_token, "new-refresh");
});

function writeCodexAuth({ accessToken, refreshToken }) {
  const codexHome = mkdtempSync(join(tmpdir(), "autopreso-codex-"));
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken } }),
  );
  return codexHome;
}

function jwtWithExp(expMs) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}
