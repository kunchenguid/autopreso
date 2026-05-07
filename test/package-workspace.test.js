import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

test("root package keeps platform sidecars as optional published packages, not local workspaces", () => {
  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.files, ["LICENSE", "public/", "src/"]);
  assert.equal(rootPackage.bin["autopreso"], "src/cli.js");
  assert.equal(rootPackage.scripts.dev, "node ./src/cli.js");
  assert.equal(rootPackage.scripts["build:moonshine-sidecars"], "node ./scripts/build-moonshine-sidecars.js");
  assert.equal(rootPackage.scripts["prepare:release-packages"], "node ./scripts/prepare-release-packages.js");
  assert.equal(rootPackage.workspaces, undefined);
  assert.equal(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-arm64"], rootPackage.version);
  assert.equal(rootPackage.optionalDependencies["@autopreso/moonshine-darwin-x64"], rootPackage.version);
});

test("Moonshine sidecar packages expose the resolver binary contract", () => {
  const packages = [
    {
      dir: "packages/moonshine-darwin-arm64",
      name: "@autopreso/moonshine-darwin-arm64",
      cpu: "arm64",
    },
    {
      dir: "packages/moonshine-darwin-x64",
      name: "@autopreso/moonshine-darwin-x64",
      cpu: "x64",
    },
  ];

  for (const sidecarPackage of packages) {
    const packageJson = readJson(`${sidecarPackage.dir}/package.json`);
    const rootPackage = readJson("package.json");

    assert.equal(packageJson.name, sidecarPackage.name);
    assert.equal(packageJson.version, rootPackage.version);
    assert.deepEqual(packageJson.os, ["darwin"]);
    assert.deepEqual(packageJson.cpu, [sidecarPackage.cpu]);
    assert.deepEqual(packageJson.files, ["bin/autopreso-moonshine"]);
    assert.equal(packageJson.bin["autopreso-moonshine"], "bin/autopreso-moonshine");
  }
});

test("Moonshine sidecars are built from a pinned release recipe", () => {
  const sidecarConfig = readJson("moonshine-sidecar.config.json");
  const releasePlease = readJson("release-please-config.json");

  assert.equal(sidecarConfig.moonshineVoiceVersion, "0.0.59");
  assert.equal(sidecarConfig.moonshineReleaseTag, "v0.0.59");
  assert.deepEqual(sidecarConfig.targets.map((target) => target.packageDir), [
    "packages/moonshine-darwin-arm64",
    "packages/moonshine-darwin-x64",
  ]);
  assert.equal(releasePlease.packages["."]["release-type"], "node");
});

test("release workflow uses current actions and npm trusted publishing", () => {
  const releaseWorkflow = readFileSync(path.join(rootDir, ".github/workflows/release-please.yml"), "utf8");
  const ciWorkflow = readFileSync(path.join(rootDir, ".github/workflows/ci.yml"), "utf8");

  assert.equal(releaseWorkflow.includes("NODE_AUTH_TOKEN"), false);
  assert.equal(releaseWorkflow.includes("NPM_TOKEN"), false);
  assert.equal(releaseWorkflow.includes("id-token: write"), true);
  assert.equal(releaseWorkflow.includes("googleapis/release-please-action@v5"), true);
  assert.equal(releaseWorkflow.includes("actions/checkout@v6"), true);
  assert.equal(releaseWorkflow.includes("actions/setup-node@v6"), true);
  assert.equal(releaseWorkflow.includes("actions/setup-python@v6"), true);
  assert.equal(ciWorkflow.includes("actions/checkout@v6"), true);
  assert.equal(ciWorkflow.includes("actions/setup-node@v6"), true);
});
