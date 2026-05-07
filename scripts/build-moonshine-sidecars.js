#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const config = readJson("moonshine-sidecar.config.json");
const requestedTarget = readTargetArg();
const targets = requestedTarget === "all" ? config.targets : config.targets.filter((target) => target.name === requestedTarget);

if (targets.length === 0) {
  throw new Error(`Unknown target '${requestedTarget}'. Expected one of: all, ${config.targets.map((target) => target.name).join(", ")}`);
}

for (const target of targets) {
  buildTarget(target);
}

function buildTarget(target) {
  if (process.platform !== "darwin") {
    throw new Error("Moonshine sidecar release binaries must be built on macOS.");
  }

  const buildRoot = path.join(rootDir, ".autopreso-dev", "release-build", target.name);
  const venvDir = path.join(buildRoot, "venv");
  const binDir = path.join(rootDir, target.packageDir, "bin");
  const outputPath = path.join(binDir, "autopreso-moonshine");
  const archPrefix = target.arch === "x64" ? ["arch", "-x86_64"] : [];
  const python = process.env.PYTHON || "python3";

  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(outputPath, { force: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(buildRoot, { recursive: true });

  run([...archPrefix, python], ["-m", "venv", venvDir], `creating ${target.name} venv`);
  const venvPython = path.join(venvDir, "bin", "python");
  run([...archPrefix, venvPython], ["-m", "pip", "install", "--upgrade", "pip"], `upgrading ${target.name} pip`);
  run(
    [...archPrefix, venvPython],
    ["-m", "pip", "install", `moonshine-voice==${config.moonshineVoiceVersion}`, "pyinstaller"],
    `installing ${target.name} build dependencies`,
  );

  const sitePackages = pythonSitePackages(archPrefix, venvPython);
  const moonshinePackage = path.join(sitePackages, "moonshine_voice");
  const moonshineDylib = path.join(moonshinePackage, "libmoonshine.dylib");
  const onnxDylib = path.join(moonshinePackage, "libonnxruntime.1.23.2.dylib");

  if (target.arch === "x64") {
    ensureX64MoonshineDylib(moonshineDylib, buildRoot);
  }

  const pyinstallerArgs = [
    "-m",
    "PyInstaller",
    "--onefile",
    "--clean",
    "--noconfirm",
    "--name",
    "autopreso-moonshine",
    "--hidden-import",
    "moonshine_voice.transcriber",
    "--add-binary",
    `${moonshineDylib}:moonshine_voice`,
  ];

  if (existsSync(onnxDylib) && target.arch === "arm64") {
    pyinstallerArgs.push("--add-binary", `${onnxDylib}:moonshine_voice`);
  }
  if (target.arch === "x64") {
    pyinstallerArgs.splice(2, 0, "--target-arch", "x86_64");
  }

  pyinstallerArgs.push(
    "--add-data",
    `${path.join(moonshinePackage, "assets")}:moonshine_voice/assets`,
    "--distpath",
    binDir,
    "--workpath",
    path.join(buildRoot, "pyinstaller-build"),
    "--specpath",
    path.join(buildRoot, "pyinstaller-spec"),
    path.join(rootDir, "scripts", "moonshine-sidecar.py"),
  );

  run([...archPrefix, venvPython], pyinstallerArgs, `building ${target.name} sidecar`);
  chmodSync(outputPath, 0o755);
  const smoke = run([outputPath], ["--model", "medium", "--language", "en"], `smoke testing ${target.name} medium model`, { capture: true });
  if (!smoke.stdout.includes('"type":"ready"')) {
    throw new Error(`${target.name} sidecar did not emit a ready event.`);
  }
}

function ensureX64MoonshineDylib(outputPath, buildRoot) {
  const currentArch = fileOutput(outputPath);
  if (currentArch.includes("x86_64")) return;

  const archivePath = path.join(buildRoot, "macos-BasicTranscription.tar.gz");
  const extractDir = path.join(buildRoot, "moonshine-release");
  const staticLib = path.join(
    extractDir,
    "BasicTranscription/.build/index-build/artifacts/moonshine-swift/Moonshine/Moonshine.xcframework/macos-arm64_x86_64/libmoonshine.a",
  );

  run(
    ["curl"],
    ["-L", "--fail", "-o", archivePath, `https://github.com/moonshine-ai/moonshine/releases/download/${config.moonshineReleaseTag}/macos-BasicTranscription.tar.gz`],
    "downloading Moonshine macOS release archive",
  );
  mkdirSync(extractDir, { recursive: true });
  run(
    ["tar"],
    [
      "-xzf",
      archivePath,
      "-C",
      extractDir,
      "BasicTranscription/.build/index-build/artifacts/moonshine-swift/Moonshine/Moonshine.xcframework/macos-arm64_x86_64/libmoonshine.a",
    ],
    "extracting universal Moonshine static library",
  );
  run(
    ["clang++"],
    [
      "-arch",
      "x86_64",
      "-dynamiclib",
      "-all_load",
      staticLib,
      "-o",
      outputPath,
      "-framework",
      "CoreML",
      "-framework",
      "Foundation",
      "-framework",
      "Accelerate",
      "-framework",
      "Metal",
      "-framework",
      "CoreVideo",
      "-framework",
      "CoreGraphics",
      "-framework",
      "Security",
      "-framework",
      "SystemConfiguration",
      "-framework",
      "CoreFoundation",
      "-lz",
      "-lbz2",
      "-liconv",
    ],
    "linking x64 Moonshine dynamic library",
  );
}

function pythonSitePackages(archPrefix, venvPython) {
  const result = run(
    [...archPrefix, venvPython],
    ["-c", "import site; print(site.getsitepackages()[0])"],
    "locating Python site-packages",
    { capture: true },
  );
  return result.stdout.trim();
}

function fileOutput(filePath) {
  const result = run(["file"], [filePath], `checking architecture for ${path.basename(filePath)}`, { capture: true });
  return result.stdout;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function readTargetArg() {
  const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
  return targetArg ? targetArg.slice("--target=".length) : "all";
}

function run(commandParts, args, description, options = {}) {
  const [command, ...prefixArgs] = commandParts;
  const result = spawnSync(command, [...prefixArgs, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Failed while ${description}.`);
  }
  return result;
}
