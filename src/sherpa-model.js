import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const SHERPA_ONNX_MODEL_NAME = "zipformer-bilingual-zh-en";
export const SHERPA_ONNX_MODEL_REVISION = "98590b7ed6443e77b714204da2757d75e1a642f4";
const MODEL_REPOSITORY = "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${SHERPA_ONNX_MODEL_REVISION}`;

export const SHERPA_ONNX_MODEL_FILES = Object.freeze([
  {
    name: "encoder-epoch-99-avg-1.int8.onnx",
    size: 181895032,
    sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
  },
  {
    name: "decoder-epoch-99-avg-1.onnx",
    size: 13876452,
    sha256: "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
  },
  {
    name: "joiner-epoch-99-avg-1.int8.onnx",
    size: 3228404,
    sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
  },
  {
    name: "tokens.txt",
    size: 56317,
    sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
  },
].map((file) => ({
  ...file,
  url: `${MODEL_BASE_URL}/${file.name}?download=true`,
})));

export function defaultSherpaOnnxModelDir({ env = process.env, homedir = os.homedir() } = {}) {
  if (env.AUTOPRESO_SHERPA_MODEL_DIR) return path.resolve(env.AUTOPRESO_SHERPA_MODEL_DIR);
  const cacheRoot = env.XDG_CACHE_HOME || path.join(homedir, ".cache");
  return path.join(cacheRoot, "autopreso", "sherpa-onnx", SHERPA_ONNX_MODEL_NAME);
}

export async function ensureSherpaOnnxModel({
  modelDir = defaultSherpaOnnxModelDir(),
  files = /** @type {readonly { name: string, size?: number, sha256: string, url: string }[]} */ (SHERPA_ONNX_MODEL_FILES),
  fetchFn = fetch,
  onStatus = /** @type {(message: string) => void} */ (() => {}),
} = {}) {
  await fs.mkdir(modelDir, { recursive: true });

  for (const [index, file] of files.entries()) {
    const destination = path.join(modelDir, file.name);
    if (await fileMatchesChecksum(destination, file.sha256)) continue;

    onStatus(`Downloading Sherpa-ONNX model file ${index + 1}/${files.length}: ${file.name}`);
    await downloadVerifiedFile({ file, destination, fetchFn });
  }

  return modelDir;
}

async function downloadVerifiedFile({ file, destination, fetchFn }) {
  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  try {
    const response = await fetchFn(file.url);
    if (!response?.ok || !response.body) {
      throw new Error(`Failed to download ${file.name}: HTTP ${response?.status ?? "unknown"}`);
    }

    const sizeGuard = createSizeGuard(file);
    await pipeline(
      Readable.fromWeb(response.body),
      sizeGuard,
      createWriteStream(temporary, { mode: 0o600 }),
    );
    if (Number.isSafeInteger(file.size) && sizeGuard.received !== file.size) {
      throw new Error(`Size mismatch for ${file.name}: expected ${file.size}, received ${sizeGuard.received}`);
    }

    const actual = await sha256File(temporary);
    if (actual !== file.sha256) {
      throw new Error(`Checksum mismatch for ${file.name}: expected ${file.sha256}, received ${actual}`);
    }

    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function createSizeGuard(file) {
  let received = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (Number.isSafeInteger(file.size) && received > file.size) {
        callback(new Error(`Size mismatch for ${file.name}: expected ${file.size}, received more than ${file.size}`));
        return;
      }
      callback(null, chunk);
    },
  });
  Object.defineProperty(stream, "received", { get: () => received });
  return /** @type {Transform & { readonly received: number }} */ (stream);
}

async function fileMatchesChecksum(filePath, expected) {
  try {
    return await sha256File(filePath) === expected;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
