import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

export function readCodexCliAuthSync(env = process.env) {
  const authPath = codexAuthPath(env);
  if (!existsSync(authPath)) return undefined;

  try {
    const payload = JSON.parse(readFileSync(authPath, "utf8"));
    return parseCodexAuthPayload(payload);
  } catch {
    return undefined;
  }
}

export async function resolveCodexCliCredentials(env = process.env, options = {}) {
  const authPath = codexAuthPath(env);
  const payload = JSON.parse(readFileSync(authPath, "utf8"));
  const auth = parseCodexAuthPayload(payload);
  if (!auth) {
    throw new Error(`Codex CLI auth is missing usable tokens at ${authPath}. Run \`codex\` and sign in with ChatGPT.`);
  }

  let tokens = { ...auth.tokens };
  if (codexAccessTokenIsExpiring(tokens.access_token, options.now ?? Date.now())) {
    tokens = await refreshCodexTokens(tokens, options.fetchFn ?? fetch);
    payload.tokens = { ...payload.tokens, ...tokens };
    writeCodexAuthPayload(authPath, payload);
  }

  return {
    provider: "codex",
    baseURL: cleanEnvValue(env.CODEX_BASE_URL) ?? DEFAULT_CODEX_BASE_URL,
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: auth.accountId,
  };
}

export function createCodexFetch(env = process.env) {
  return async (input, init = {}) => {
    const credentials = await resolveCodexCliCredentials(env);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${credentials.apiKey}`);
    if (credentials.accountId) {
      headers.set("ChatGPT-Account-Id", credentials.accountId);
    }
    return fetch(input, { ...init, headers });
  };
}

function codexAuthPath(env) {
  return join(cleanEnvValue(env.CODEX_HOME) ?? join(homedir(), ".codex"), "auth.json");
}

function parseCodexAuthPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const tokens = payload.tokens;
  if (!tokens || typeof tokens !== "object") return undefined;
  const accessToken = cleanEnvValue(tokens.access_token);
  const refreshToken = cleanEnvValue(tokens.refresh_token);
  if (!accessToken || !refreshToken) return undefined;
  return {
    tokens: { ...tokens, access_token: accessToken, refresh_token: refreshToken },
    accessToken,
    refreshToken,
    accountId: cleanEnvValue(payload.account_id) ?? extractAccountId(accessToken),
  };
}

function codexAccessTokenIsExpiring(accessToken, nowMs) {
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp !== "number") return false;
  return exp * 1000 <= nowMs + CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS;
}

async function refreshCodexTokens(tokens, fetchFn) {
  const response = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(`Codex token refresh failed with status ${response.status}. Run \`codex\` and sign in with ChatGPT.`);
  }

  const payload = await response.json();
  const accessToken = cleanEnvValue(payload.access_token);
  if (!accessToken) {
    throw new Error("Codex token refresh response was missing access_token.");
  }

  return {
    ...tokens,
    access_token: accessToken,
    refresh_token: cleanEnvValue(payload.refresh_token) ?? tokens.refresh_token,
  };
}

function writeCodexAuthPayload(authPath, payload) {
  const tmpPath = `${authPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, authPath);
}

function extractAccountId(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  return cleanEnvValue(claims?.chatgpt_account_id) ?? cleanEnvValue(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id);
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.split(".").length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function cleanEnvValue(value) {
  const trimmedValue = value?.trim();
  return trimmedValue || undefined;
}
