import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureSherpaOnnxModel } from "../src/sherpa-model.js";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autopreso-sherpa-model-"));
}

test("ensureSherpaOnnxModel downloads and verifies missing model files", async () => {
  const modelDir = await tempDir();
  const content = Buffer.from("verified model bytes");
  const files = [{
    name: "encoder.int8.onnx",
    sha256: sha256(content),
    url: "https://models.example/encoder.int8.onnx",
  }];
  const requested = [];

  const resolved = await ensureSherpaOnnxModel({
    modelDir,
    files,
    fetchFn: async (url) => {
      requested.push(url);
      return new Response(content, { status: 200 });
    },
  });

  assert.equal(resolved, modelDir);
  assert.deepEqual(requested, [files[0].url]);
  assert.deepEqual(await fs.readFile(path.join(modelDir, files[0].name)), content);
});

test("ensureSherpaOnnxModel reuses files whose checksums already match", async () => {
  const modelDir = await tempDir();
  const content = Buffer.from("cached model bytes");
  const file = {
    name: "tokens.txt",
    sha256: sha256(content),
    url: "https://models.example/tokens.txt",
  };
  await fs.writeFile(path.join(modelDir, file.name), content);

  await ensureSherpaOnnxModel({
    modelDir,
    files: [file],
    fetchFn: async () => {
      throw new Error("valid cached files should not be downloaded");
    },
  });

  assert.deepEqual(await fs.readFile(path.join(modelDir, file.name)), content);
});

test("ensureSherpaOnnxModel rejects a download whose checksum is invalid", async () => {
  const modelDir = await tempDir();
  const file = {
    name: "joiner.int8.onnx",
    sha256: sha256("expected"),
    url: "https://models.example/joiner.int8.onnx",
  };

  await assert.rejects(
    ensureSherpaOnnxModel({
      modelDir,
      files: [file],
      fetchFn: async () => new Response("corrupt", { status: 200 }),
    }),
    /checksum mismatch/i,
  );
  await assert.rejects(fs.access(path.join(modelDir, file.name)));
});

test("ensureSherpaOnnxModel rejects model responses larger than the pinned size", async () => {
  const modelDir = await tempDir();
  const file = {
    name: "encoder.int8.onnx",
    size: 3,
    sha256: sha256("oversized"),
    url: "https://models.example/encoder.int8.onnx",
  };

  await assert.rejects(
    ensureSherpaOnnxModel({
      modelDir,
      files: [file],
      fetchFn: async () => new Response("oversized", { status: 200 }),
    }),
    /size mismatch/i,
  );
  await assert.rejects(fs.access(path.join(modelDir, file.name)));
});
