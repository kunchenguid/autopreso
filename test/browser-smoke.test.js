import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WebSocket } from "ws";

import { startServer } from "../src/server.js";

const CHROME_BIN = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_DEBUG_PORT = 9333;

test("browser renders the app shell", async (t) => {
  if (!existsSync(CHROME_BIN)) {
    t.skip("Chrome is not installed. Set CHROME_BIN to enable this smoke test.");
    return;
  }

  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 3229,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  t.after(() => {
    httpServer.close();
  });

  const userDataDir = await mkdtemp(path.join(tmpdir(), "autopreso-chrome-"));
  const chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: "ignore" },
  );

  t.after(async () => {
    if (chrome.exitCode === null) {
      chrome.kill();
      await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(2000)]);
    }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const tab = await waitForChromeTab(url);
  const text = await waitForRenderedText(tab.webSocketDebuggerUrl, "Start listening");

  assert.match(text, /Start listening/);

  const controls = await evaluateInTab(tab.webSocketDebuggerUrl, `Array.from(document.querySelectorAll(".controls button")).map((button) => button.textContent.trim())`);
  assert.deepEqual(controls, ["● Start listening"]);
});

async function waitForChromeTab(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const tabs = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`).then((res) => res.json());
      const tab = tabs.find((item) => item.url === url || item.url === `${url}/`);
      if (tab) return tab;
    } catch {
      // Chrome can take a moment to start its debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for Chrome debug tab.");
}

function waitForRenderedText(webSocketDebuggerUrl, expectedText) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for ${expectedText}.`));
    }, 20000);

    const request = (method, params = {}) => {
      const requestId = ++id;
      ws.send(JSON.stringify({ id: requestId, method, params }));
      return new Promise((requestResolve, requestReject) => {
        pending.set(requestId, { resolve: requestResolve, reject: requestReject });
      });
    };

    ws.on("open", async () => {
      try {
        await request("Runtime.enable");
        const deadline = Date.now() + 15000;
        let lastText = "";

        while (Date.now() < deadline) {
          const response = await request("Runtime.evaluate", {
            expression: "document.body.innerText",
            returnByValue: true,
          });
          lastText = response.result?.result?.value ?? "";
          if (lastText.includes(expectedText)) {
            clearTimeout(timeout);
            ws.close();
            resolve(lastText);
            return;
          }
          await sleep(250);
        }

        throw new Error(`Text did not render: ${lastText}`);
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    });

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const deferred = pending.get(message.id);
      if (deferred) {
        pending.delete(message.id);
        if (message.error) deferred.reject(new Error(message.error.message));
        else deferred.resolve(message);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function evaluateInTab(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const request = (method, params = {}) => {
    const requestId = ++id;
    ws.send(JSON.stringify({ id: requestId, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
  };

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    if (message.error) deferred.reject(new Error(message.error.message));
    else deferred.resolve(message);
  });

  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const response = await request("Runtime.evaluate", { expression, returnByValue: true });
    return response.result?.result?.value;
  } finally {
    ws.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
