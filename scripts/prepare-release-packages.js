#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const config = readJson("moonshine-sidecar.config.json");
const rootPackage = readJson("package.json");
const version = rootPackage.version;

for (const target of config.targets) {
  const packagePath = path.join(target.packageDir, "package.json");
  const sidecarPackage = readJson(packagePath);
  sidecarPackage.version = version;
  writeJson(packagePath, sidecarPackage);

  const binaryPath = path.join(rootDir, target.packageDir, "bin", "autopreso-moonshine");
  if (!existsSync(binaryPath)) {
    throw new Error(`Missing built sidecar binary: ${path.relative(rootDir, binaryPath)}`);
  }

  rootPackage.optionalDependencies[sidecarPackage.name] = version;
}

writeJson("package.json", rootPackage);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(path.join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}
