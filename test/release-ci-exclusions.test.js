import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule in firstmate's release-please CI
 * report: each package contributes its node/simple/go outputs, extra-files,
 * changelog, plus the shared manifest (and root package-lock.json when present).
 */
function expectedReleaseOutputs() {
  const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
  const packages = config.packages ?? { ".": config };
  const expected = [];
  let sawNode = false;

  for (const [packagePath, pkg] of Object.entries(packages)) {
    const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
    const changelogName = pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";
    const changelog =
      packagePath === "." || packagePath === ""
        ? changelogName
        : join(packagePath, changelogName).replaceAll("\\", "/");
    expected.push(changelog);

    switch (releaseType) {
      case "simple": {
        const versionFile = pkg["version-file"] ?? config["version-file"] ?? "version.txt";
        expected.push(
          packagePath === "." || packagePath === ""
            ? versionFile
            : join(packagePath, versionFile).replaceAll("\\", "/"),
        );
        break;
      }
      case "node": {
        sawNode = true;
        expected.push(
          packagePath === "." || packagePath === ""
            ? "package.json"
            : join(packagePath, "package.json").replaceAll("\\", "/"),
        );
        break;
      }
      case "go":
        break;
      default:
        throw new Error(
          `unsupported release-please release-type for ignore derivation: ${releaseType}`,
        );
    }

    const extra = pkg["extra-files"] ?? [];
    for (const entry of extra) {
      const path = typeof entry === "string" ? entry : entry?.path;
      if (path) expected.push(path);
    }
  }

  if (sawNode && existsSync(join(root, "package-lock.json"))) {
    expected.push("package-lock.json");
  }

  // Nested node packages may emit per-package changelogs; cover the monorepo
  // shape used by the sidecar component even before the file exists on disk.
  if (Object.keys(packages).some((path) => path.startsWith("packages/"))) {
    expected.push("packages/*/CHANGELOG.md");
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(join(workflowsDir, "release-please.yml"), "utf8");
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

/**
 * Minimal workflow `on` extractor. Avoids a YAML dependency: these workflows
 * only use the simple mapping/list shape GitHub Actions documents, and the
 * fleet drift check only needs pull_request path filters plus sibling triggers.
 */
function loadWorkflowOn(filePath) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^(on|true):\s*$/.test(lines[i])) i += 1;
  if (i >= lines.length) return null;
  i += 1;

  const on = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith("#") || line.startsWith(" ")) {
      // still inside on-block whitespace/comments; fall through
    } else if (!line.startsWith(" ") && line.endsWith(":")) {
      // next top-level key
      break;
    } else if (!line.startsWith(" ")) {
      break;
    }

    const eventMatch = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!eventMatch) {
      i += 1;
      continue;
    }

    const eventName = eventMatch[1];
    const inline = eventMatch[2].trim();
    i += 1;

    if (inline && inline !== "|" && inline !== ">") {
      on[eventName] = inline.replace(/^["']|["']$/g, "");
      continue;
    }

    const event = {};
    while (i < lines.length) {
      const body = lines[i];
      if (/^ {2}[A-Za-z_]/.test(body) || (/^[^ #\t]/.test(body) && body.trim() !== "")) {
        break;
      }
      if (body.trim() === "" || body.trimStart().startsWith("#")) {
        i += 1;
        continue;
      }

      const keyMatch = body.match(/^ {4}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!keyMatch) {
        i += 1;
        continue;
      }

      const key = keyMatch[1];
      const rest = keyMatch[2].trim();
      i += 1;

      if (rest.startsWith("[") && rest.endsWith("]")) {
        event[key] = rest
          .slice(1, -1)
          .split(",")
          .map((part) => part.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        continue;
      }

      if (rest !== "" && rest !== "|" && rest !== ">") {
        event[key] = rest.replace(/^["']|["']$/g, "");
        continue;
      }

      const values = [];
      while (i < lines.length) {
        const item = lines[i];
        const listMatch = item.match(/^ {6}-\s+(.+)$/);
        if (!listMatch) break;
        values.push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
        i += 1;
      }
      event[key] = values;
    }

    on[eventName] = event;
  }

  return on;
}

function pullRequestFilterCoverage(pr) {
  if (pr == null) return { kind: "unfiltered" };
  if (typeof pr !== "object" || Array.isArray(pr)) return { kind: "unfiltered" };

  if (Array.isArray(pr["paths-ignore"])) {
    return { kind: "paths-ignore", paths: pr["paths-ignore"].map(String) };
  }
  if (Array.isArray(pr.paths)) {
    return { kind: "paths", paths: pr.paths.map(String) };
  }
  return { kind: "unfiltered" };
}

function globMatch(pattern, path) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function pathIgnored(ignorePaths, releasePath) {
  return ignorePaths.some(
    (pattern) => pattern === releasePath || globMatch(pattern, releasePath),
  );
}

function isCovered(filter, releasePath) {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    // A glob pattern listed as an expected output (e.g. packages/*/CHANGELOG.md)
    // is covered when the same pattern is present, or when every concrete path
    // it could name is ignored individually.
    if (releasePath.includes("*")) {
      return filter.paths.includes(releasePath);
    }
    return pathIgnored(filter.paths, releasePath);
  }

  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (matched && (negated === releasePath || globMatch(negated, releasePath))) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  return !matched;
}

/** GitHub pull_request path filters: a run is created unless every path matches paths-ignore. */
function wouldCreatePullRequestRun(filter, changedPaths) {
  if (filter.kind === "unfiltered") return true;
  if (filter.kind === "paths-ignore") {
    return changedPaths.some((path) => !pathIgnored(filter.paths, path));
  }

  // paths allow-list: run if any changed path remains matched after negations.
  return changedPaths.some((path) => {
    let matched = false;
    for (const pattern of filter.paths) {
      if (pattern.startsWith("!")) {
        const negated = pattern.slice(1);
        if (matched && (negated === path || globMatch(negated, path))) {
          matched = false;
        }
        continue;
      }
      if (pattern === path || globMatch(pattern, path)) {
        matched = true;
      }
    }
    return matched;
  });
}

const expected = expectedReleaseOutputs();

const releaseIgnoreList = [
  ".release-please-manifest.json",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "packages/moonshine-darwin-arm64/package.json",
  "packages/moonshine-darwin-x64/package.json",
  "packages/*/CHANGELOG.md",
];

test("derives the monorepo node release-output set for this repository", () => {
  assert.deepEqual(
    [...expected].sort(),
    [
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package-lock.json",
      "package.json",
      "packages/*/CHANGELOG.md",
      "packages/moonshine-darwin-arm64/CHANGELOG.md",
      "packages/moonshine-darwin-arm64/package.json",
      "packages/moonshine-darwin-x64/package.json",
    ].sort(),
  );
});

test("every pull_request workflow ignores the full release-output set", () => {
  const files = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"));
  const prWorkflows = [];

  for (const name of files) {
    const filePath = join(workflowsDir, name);
    const on = loadWorkflowOn(filePath);
    if (!on || !("pull_request" in on)) continue;
    prWorkflows.push({ name, filter: pullRequestFilterCoverage(on.pull_request) });
  }

  assert.deepEqual(prWorkflows.map((w) => w.name).sort(), [
    "ci.yml",
    "guard-generated-files.yml",
    "no-mistakes-required.yml",
  ]);

  const failures = [];
  for (const { name, filter } of prWorkflows) {
    const missing = expected.filter((path) => !isCovered(filter, path));
    if (missing.length > 0) {
      failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
    }
  }

  assert.deepEqual(failures, []);
});

test("does not attach path filters to non-pull_request triggers on ci.yml", () => {
  const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
  assert.ok(on);
  assert.deepEqual(on.push, { branches: ["main"] });
  assert.deepEqual(on.pull_request.branches, ["main"]);
  assert.deepEqual(on.pull_request["paths-ignore"], releaseIgnoreList);
  assert.equal(on.release, undefined);
  assert.equal(on.workflow_dispatch, undefined);
});

test("keeps bot author exemptions on guard and no-mistakes jobs", () => {
  const guard = readFileSync(join(workflowsDir, "guard-generated-files.yml"), "utf8");
  const nmr = readFileSync(join(workflowsDir, "no-mistakes-required.yml"), "utf8");
  assert.match(guard, /github-actions\[bot\]/);
  assert.match(guard, /release-please\[bot\]/);
  assert.match(nmr, /github-actions\[bot\]/);
  assert.match(nmr, /dependabot\[bot\]/);
  assert.match(nmr, /release-please\[bot\]/);
});

test("release-please lockfile sync workflow is gone; publish jobs still regenerate the lockfile", () => {
  assert.equal(existsSync(join(workflowsDir, "release-please-lockfile.yml")), false);

  const releaseWorkflow = readFileSync(join(workflowsDir, "release-please.yml"), "utf8");
  const lockfileRegen = (releaseWorkflow.match(
    /npm install --package-lock-only --ignore-scripts --omit=optional/g,
  ) ?? []).length;
  // Both publish-sidecars and publish-autopreso regenerate the lockfile before npm ci.
  assert.equal(lockfileRegen, 2);
  assert.match(releaseWorkflow, /publish-sidecars:/);
  assert.match(releaseWorkflow, /publish-autopreso:/);
});

test("offline path filter: latest release PR creates zero runs; human PRs still run", () => {
  const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
  const filter = pullRequestFilterCoverage(on.pull_request);

  // autopreso #26 (latest merged release PR) and #8 (sidecar bump).
  const releasePr26 = [
    ".release-please-manifest.json",
    "CHANGELOG.md",
    "package-lock.json",
    "package.json",
  ];
  const releasePr8 = [
    ".release-please-manifest.json",
    "CHANGELOG.md",
    "package-lock.json",
    "package.json",
    "packages/moonshine-darwin-arm64/package.json",
    "packages/moonshine-darwin-x64/package.json",
  ];
  assert.equal(wouldCreatePullRequestRun(filter, releasePr26), false);
  assert.equal(wouldCreatePullRequestRun(filter, releasePr8), false);

  // Representative human PRs must still create runs.
  const humanPr25 = [
    ".github/workflows/no-mistakes-required.yml",
    ".no-mistakes/evidence/fm/nm-body-events-autopreso-r1/pr-body-compliance-event-matrix.md",
    "test/no-mistakes-required-workflow.test.js",
  ];
  const humanPr21 = ["public/app.js", "public/style.css"];
  const humanPr19 = [
    "AGENTS.md",
    "README.md",
    "public/app.js",
    "src/agent-provider.js",
    "src/cli.js",
    "src/settings-store.js",
    "test/agent-provider-settings.test.js",
    "test/agent-provider.test.js",
    "test/frontend-status.test.js",
    "test/settings-store.test.js",
  ];
  assert.equal(wouldCreatePullRequestRun(filter, humanPr25), true);
  assert.equal(wouldCreatePullRequestRun(filter, humanPr21), true);
  assert.equal(wouldCreatePullRequestRun(filter, humanPr19), true);
});
