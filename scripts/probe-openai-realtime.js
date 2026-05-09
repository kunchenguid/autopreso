#!/usr/bin/env node
// End-to-end smoke: drive the real openai-transcription module against
// OpenAI Realtime, streaming a PCM speech sample. Verify that:
//   - delta events arrive
//   - delta-quiet flush queues the agent turn (without waiting for completed)
//   - the queued text is the accumulated partial

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createOpenAITranscription } from "../src/openai-transcription.js";

const settingsPath = path.join(os.homedir(), ".config", "autopreso", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const env = { OPENAI_API_KEY: settings.apiKeys.openai };
const PCM_PATH = process.argv[2] ?? "/tmp/probe.pcm";

async function probe(model) {
  console.log(`\n=== ${model} ===`);
  const queued = [];
  const messages = [];
  const transcription = createOpenAITranscription({
    sendTranscript: (m) => {
      messages.push(m);
      if (m.type === "transcript:committed") console.log(`[committed] "${m.text.slice(0, 80)}"`);
    },
    queueTranscript: (t) => {
      queued.push({ at: Date.now(), text: t });
      console.log(`[queue] turn fired with: "${t.slice(0, 80)}"`);
    },
    options: { openaiTranscriptionModel: model },
    env,
  });
  await transcription.ready();

  const pcm = fs.readFileSync(PCM_PATH);
  const FRAME_BYTES = 24000 * 2 * 0.1; // 100ms
  const start = Date.now();
  console.log(`[stream] ${pcm.length} bytes in 100ms frames`);
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const slice = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    transcription.sendAudio(slice.toString("base64"));
    await sleep(100);
  }
  const audioEndedAt = Date.now();
  console.log(`[stream] audio sent (${audioEndedAt - start}ms total)`);

  // Wait long enough for delta-quiet (1500ms default) plus some slack.
  await sleep(2500);

  const turnLatency = queued.length > 0 ? queued[0].at - audioEndedAt : null;
  console.log(`[result] turns: ${queued.length}, latency-after-audio-end: ${turnLatency}ms`);
  transcription.close();
  await sleep(300);
  return { queued, turnLatency };
}

await probe("gpt-realtime-whisper");
await probe("gpt-4o-mini-transcribe");
console.log("\n--- done ---");
process.exit(0);
