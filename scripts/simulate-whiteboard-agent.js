#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { resolveSimulatorAgentProvider } from "../src/simulator-agent-provider.js";
import { parseSimulatorArgs } from "../src/simulator-options.js";
import { startServer, whiteboardSystemPrompt } from "../src/server.js";
import { chunkTranscriptAtPunctuation } from "../src/transcript-chunker.js";

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const options = parseSimulatorArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const agentProvider = resolveSimulatorAgentProvider(process.env);

  if (!existsSync(options.chromeBin)) {
    printStructuredError(`Chrome binary not found: ${options.chromeBin}`, "Pass --chrome-bin <path> or set CHROME_BIN.");
    process.exitCode = 1;
    return;
  }

  await runSimulation(options, agentProvider);
}

export async function runSimulation(options, agentProvider) {
  const outDir = path.resolve(options.outDir);
  const screenshotsDir = path.join(outDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const transcript = await readFile(options.transcriptPath, "utf8");
  const chunks = chunkTranscriptAtPunctuation(transcript);
  const systemPrompt = whiteboardSystemPrompt();
  const recorder = new TrajectoryRecorder(path.join(outDir, "trajectory.jsonl"));
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex");

  await writeFile(path.join(outDir, "prompt.txt"), systemPrompt);
  await writeFile(path.join(outDir, "chunks.json"), `${JSON.stringify(chunks, null, 2)}\n`);

  let screenshotIndex = 0;
  let cdp;
  let chrome;
  let observer;
  let httpServer;
  let chromeUserDataDir;
  let screenshotChain = Promise.resolve();

  const record = (event) => recorder.write({ ...event, timestamp: event.timestamp ?? new Date().toISOString() });
  const scheduleScreenshot = (label) => {
    screenshotChain = screenshotChain.then(async () => {
      if (!cdp) return;
      const fileName = `${String(screenshotIndex++).padStart(3, "0")}-${sanitizeLabel(label)}.png`;
      await capturePageScreenshot(cdp, path.join(screenshotsDir, fileName));
      record({ type: "screenshot", label, file: path.join("screenshots", fileName) });
    });
  };

  try {
    record({ type: "run:start", transcriptPath: path.resolve(options.transcriptPath), outDir, chunks: chunks.length, promptHash, provider: agentProvider.provider, model: agentProvider.requestedModel ?? agentProvider.model });

    const server = await startServer({
      host: options.host,
      port: options.port,
      moonshineModel: "medium",
      agentProvider,
      agentTimeoutMs: options.agentTimeoutMs,
      onAgentEvent: (event) => record(event),
      createTranscription: () => ({
        ready: async () => {},
        sendAudio: () => {},
        stop: () => {},
        close: () => {},
      }),
    });
    httpServer = server.httpServer;

    chromeUserDataDir = await mkdtemp(path.join(tmpdir(), "autopreso-sim-chrome-"));
    const chromeDebugPort = await getAvailablePort();
    chrome = launchChrome(options.chromeBin, chromeDebugPort, chromeUserDataDir, server.url);
    const tab = await waitForChromeTab(chromeDebugPort, server.url);
    cdp = await CdpClient.connect(tab.webSocketDebuggerUrl);
    await cdp.request("Page.enable");
    await cdp.request("Runtime.enable");
    await cdp.request("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitForRenderedText(cdp, "Start listening");
    await evaluateInPage(cdp, `document.querySelector(".record-toggle").click()`);
    await waitForRenderedText(cdp, "Connected");
    scheduleScreenshot("initial");

    observer = await connectObserver(server.url, (message) => {
      record({ type: "websocket", message });
      if (message.type === "whiteboard:update") scheduleScreenshot("whiteboard-update");
      if (message.type === "whiteboard:viewport") scheduleScreenshot(`viewport-${message.action}`);
    });

    for (const [index, chunk] of chunks.entries()) {
      record({ type: "transcript:chunk", index, text: chunk });
      server.state.queueTranscript(chunk);
      const chunkDelayMs = estimateTranscriptChunkDelayMs(chunk, options);
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
    }

    await server.state.idle();
    await sleep(750);
    await screenshotChain;
    scheduleScreenshot("final");
    await screenshotChain;

    await writeFile(path.join(outDir, "final-elements.json"), `${JSON.stringify(server.state.elements, null, 2)}\n`);
    record({ type: "run:end", elements: server.state.elements.length, screenshots: screenshotIndex });
    await recorder.close();

    printSuccess({ outDir, chunks: chunks.length, turns: server.state.agentHistory.length, screenshots: screenshotIndex, finalElements: server.state.elements.length, promptHash });
  } finally {
    await closeSimulationResources({ observer, cdp, httpServer, chrome, chromeUserDataDir });
  }
}

class TrajectoryRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.closed = false;
  }

  write(event) {
    if (this.closed) return;
    const line = `${JSON.stringify(event)}\n`;
    this.pending = (this.pending ?? Promise.resolve()).then(() => writeFile(this.filePath, line, { flag: "a" }));
  }

  async close() {
    await this.pending;
    this.closed = true;
  }
}

function launchChrome(chromeBin, debugPort, userDataDir, url) {
  console.error(`Launching headless Chrome on debug port ${debugPort}.`);
  return spawn(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,1000",
      url,
    ],
    { stdio: "ignore" },
  );
}

async function connectObserver(url, onMessage) {
  const wsUrl = url.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  ws.on("message", (raw) => onMessage(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function capturePageScreenshot(cdp, filePath) {
  await evaluateInPage(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250))))`, { awaitPromise: true });
  const response = await cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(filePath, Buffer.from(response.result.data, "base64"));
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const deferred = this.pending.get(message.id);
      if (!deferred) return;
      this.pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message));
      else deferred.resolve(message);
    });
  }

  static async connect(webSocketDebuggerUrl) {
    const client = new CdpClient(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      client.ws.once("open", resolve);
      client.ws.once("error", reject);
    });
    return client;
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

async function waitForChromeTab(debugPort, url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json`).then((res) => res.json());
      const tab = tabs.find((item) => item.url === url || item.url === `${url}/`);
      if (tab?.webSocketDebuggerUrl) return tab;
    } catch {
      // Chrome can take a moment to expose the debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for Chrome debug tab.");
}

async function waitForRenderedText(cdp, expectedText) {
  const deadline = Date.now() + 20_000;
  let lastText = "";
  while (Date.now() < deadline) {
    const response = await evaluateInPage(cdp, "document.body.innerText");
    lastText = response.result.result.value ?? "";
    if (lastText.includes(expectedText)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for rendered text: ${expectedText}. Last text: ${lastText}`);
}

function evaluateInPage(cdp, expression, options = {}) {
  return cdp.request("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: Boolean(options.awaitPromise),
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => httpServer.close(resolve));
}

export async function closeSimulationResources({ observer, cdp, httpServer, chrome, chromeUserDataDir }) {
  observer?.close();
  cdp?.close();
  if (chrome) await stopChrome(chrome);
  if (httpServer) await closeHttpServer(httpServer);
  if (chromeUserDataDir) await rm(chromeUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function estimateTranscriptChunkDelayMs(chunk, { chunkIntervalMs = 0, speakingWordsPerMinute = 160 } = {}) {
  const words = chunk.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) ?? [];
  const spokenDurationMs = Math.round((words.length / speakingWordsPerMinute) * 60_000);
  return Math.max(chunkIntervalMs, spokenDurationMs);
}

async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return;
  chrome.kill();
  await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(2000)]);
}

function sanitizeLabel(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "screenshot";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSuccess({ outDir, chunks, turns, screenshots, finalElements, promptHash }) {
  console.log(`status: ok
out: ${outDir}
chunks: ${chunks}
turns: ${turns}
screenshots: ${screenshots}
finalElements: ${finalElements}
promptHash: ${promptHash}
artifacts[5]: ${[
    path.join(outDir, "prompt.txt"),
    path.join(outDir, "chunks.json"),
    path.join(outDir, "trajectory.jsonl"),
    path.join(outDir, "final-elements.json"),
    path.join(outDir, "screenshots"),
  ].join(",")}`);
}

function printStructuredError(message, help) {
  console.log(`error: ${message}\nhelp: ${help}`);
}

function printHelp() {
  console.log(`bin: ${__filename.replace(process.env.HOME ?? "", "~")}
description: Simulate the AutoPreso whiteboard agent with Codex non-fast mode and capture trajectory artifacts.
usage: node scripts/simulate-whiteboard-agent.js --transcript <path> --out <dir> [options]
options[6|]{flag,default,description}:
  --transcript||Full transcript text file
  --out||Output artifact directory
  --chunk-interval-ms|500|Minimum delay between queued punctuation chunks
  --speaking-words-per-minute|160|Estimated speaking speed for length-based chunk delays
  --agent-timeout-ms|90000|Per-agent-turn timeout
  --chrome-bin|CHROME_BIN or Google Chrome|Headless Chrome executable
  --port|0|Server port where 0 means random`);
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    printStructuredError(error.message, "Run with --help for usage, then retry with valid options.");
    process.exitCode = 1;
  });
}
