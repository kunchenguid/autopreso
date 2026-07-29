import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  SHERPA_ONNX_MODEL_FILES,
  SHERPA_ONNX_MODEL_NAME,
  SHERPA_ONNX_MODEL_REVISION,
} from "../src/sherpa-model.js";

const rootDir = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

test("root package ships the Sherpa-ONNX runtime without private sidecar packages", () => {
  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.files, ["assets/", "LICENSE", "public/", "src/"]);
  assert.equal(rootPackage.bin["autopreso"], "src/cli.js");
  assert.equal(rootPackage.scripts.dev, "node ./src/cli.js");
  assert.equal(rootPackage.workspaces, undefined);
  assert.equal(rootPackage.optionalDependencies, undefined);
  assert.equal(rootPackage.dependencies["sherpa-onnx-node"], "^1.13.4");
});

test("bilingual Zipformer model files are revision-pinned and checksum-pinned", () => {
  assert.equal(SHERPA_ONNX_MODEL_NAME, "zipformer-bilingual-zh-en");
  assert.match(SHERPA_ONNX_MODEL_REVISION, /^[0-9a-f]{40}$/);
  assert.equal(SHERPA_ONNX_MODEL_FILES.length, 4);

  for (const file of SHERPA_ONNX_MODEL_FILES) {
    assert.equal(Number.isSafeInteger(file.size) && file.size > 0, true);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(file.url.includes(`/resolve/${SHERPA_ONNX_MODEL_REVISION}/`), true);
  }
});

test("release-please has a single autopreso component", () => {
  const releasePlease = readJson("release-please-config.json");

  assert.equal(releasePlease.packages["."]["release-type"], "node");
  assert.equal(releasePlease.packages["."].component, "autopreso");
  assert.deepEqual(Object.keys(releasePlease.packages), ["."]);
});

test("release workflow uses current actions and npm trusted publishing", () => {
  const releaseWorkflow = readFileSync(path.join(rootDir, ".github/workflows/release-please.yml"), "utf8");
  const ciWorkflow = readFileSync(path.join(rootDir, ".github/workflows/ci.yml"), "utf8");

  assert.equal(releaseWorkflow.includes("autopreso_released: ${{ steps.release.outputs.release_created }}"), true);
  assert.equal(releaseWorkflow.includes(".--release_created"), false);
  assert.equal(releaseWorkflow.includes("npm install --package-lock-only --ignore-scripts --omit=optional"), true);
  assert.equal(releaseWorkflow.includes("NODE_AUTH_TOKEN"), false);
  assert.equal(releaseWorkflow.includes("NPM_TOKEN"), false);
  assert.equal(releaseWorkflow.includes("id-token: write"), true);
  assert.equal(releaseWorkflow.includes("googleapis/release-please-action@v5"), true);
  assert.equal(releaseWorkflow.includes("actions/checkout@v6"), true);
  assert.equal(releaseWorkflow.includes("actions/setup-node@v6"), true);
  assert.equal(releaseWorkflow.includes("actions/setup-python"), false);
  assert.equal(ciWorkflow.includes("actions/checkout@v6"), true);
  assert.equal(ciWorkflow.includes("actions/setup-node@v6"), true);
});
