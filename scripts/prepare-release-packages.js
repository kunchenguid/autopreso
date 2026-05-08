#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const config = readJson("moonshine-sidecar.config.json");
const rootPackage = readJson("package.json");

for (const target of config.targets) {
  const sidecarPackage = readJson(path.join(target.packageDir, "package.json"));
  const optionalDepVersion = rootPackage.optionalDependencies?.[sidecarPackage.name];

  if (optionalDepVersion !== sidecarPackage.version) {
    throw new Error(
      `${sidecarPackage.name} version mismatch: ${target.packageDir}/package.json says ${sidecarPackage.version} but root optionalDependencies says ${optionalDepVersion}. release-please should keep these in sync; fix manually if drift was introduced.`,
    );
  }

  const binaryPath = path.join(rootDir, target.packageDir, "bin", "autopreso-moonshine");
  if (!existsSync(binaryPath)) {
    throw new Error(`Missing built sidecar binary: ${path.relative(rootDir, binaryPath)}. Run 'npm run build:moonshine-sidecars' first.`);
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}
