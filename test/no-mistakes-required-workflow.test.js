import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/no-mistakes-required.yml", import.meta.url),
  "utf8",
);

const expectedMarker =
  "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";

const ATTESTATION_PREFIX = "<!-- no-mistakes-pipeline-attestation:v1";

function concurrencyGroup({ action, pullRequestNumber, runId }) {
  const eventSuffix = action === "opened" || action === "edited" ? runId : "head-change";
  return `no-mistakes-required-${pullRequestNumber}-${eventSuffix}`;
}

function extractRunScript(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^\s+run:\s*\|/.test(line));
  if (start < 0) {
    throw new Error("workflow has no run script");
  }
  const body = [];
  let indent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (indent !== null) body.push("");
      continue;
    }
    const leading = line.match(/^(\s*)/)[1].length;
    if (indent === null) indent = leading;
    if (leading < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

function attestationComment({
  headSha = "0123456789abcdef0123456789abcdef01234567",
  steps = [
    { step: "review", status: "completed" },
    { step: "test", status: "completed" },
    { step: "document", status: "completed" },
  ],
} = {}) {
  return `${ATTESTATION_PREFIX} ${JSON.stringify({ head_sha: headSha, steps })} -->`;
}

function pipelineBody({ steps, extra = "" } = {}) {
  return [
    "## Pipeline",
    "",
    expectedMarker,
    "",
    attestationComment({ steps }),
    extra,
  ].join("\n");
}

function runGate({ body, author = "alice", number = "7" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-required-gate-"));
  const scriptPath = path.join(dir, "gate.sh");
  fs.writeFileSync(scriptPath, extractRunScript(workflow));
  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BODY: body,
        PR_AUTHOR: author,
        PR_NUMBER: String(number),
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("PR body compliance events use immutable run identities while head changes coalesce", () => {
  assert.match(
    workflow,
    /^run-name: "PR #\$\{\{ github\.event\.pull_request\.number \}\} body compliance - \$\{\{ github\.event\.action \}\} - event \$\{\{ github\.run_number \}\} \(run \$\{\{ github\.run_id \}\}\)"$/m,
  );
  assert.match(
    workflow,
    /^  group: no-mistakes-required-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ \(github\.event\.action == 'opened' \|\| github\.event\.action == 'edited'\) && github\.run_id \|\| 'head-change' \}\}$/m,
  );
  assert.match(workflow, /^  cancel-in-progress: true$/m);

  assert.notEqual(
    concurrencyGroup({ action: "opened", pullRequestNumber: 42, runId: 1001 }),
    concurrencyGroup({ action: "edited", pullRequestNumber: 42, runId: 1002 }),
  );
  assert.equal(
    concurrencyGroup({ action: "synchronize", pullRequestNumber: 42, runId: 1003 }),
    concurrencyGroup({ action: "reopened", pullRequestNumber: 42, runId: 1004 }),
  );
});

test("compliance workflow preserves the fork-safe boundary and existing policy contract", () => {
  assert.match(workflow, /^  pull_request:\n    types: \[opened, edited, synchronize, reopened\]$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    name: PR must be raised via no-mistakes$/m);
  assert.match(workflow, new RegExp(expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const bot of ["github-actions[bot]", "dependabot[bot]", "release-please[bot]"]) {
    assert.ok(workflow.includes(`github.event.pull_request.user.login != '${bot}'`));
  }
});

test("fails when the PR body has no no-mistakes signature", () => {
  const result = runGate({ body: "Please merge this change." });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /This PR was not raised through no-mistakes/);
  assert.match(result.stderr, /git push no-mistakes/);
  assert.match(result.stderr, /CONTRIBUTING\.md/);
  assert.doesNotMatch(result.stderr, /1\.46\.0/);
});

test("fails when the signature is present but structured attestation is missing", () => {
  const result = runGate({
    body: `## Pipeline\n\n${expectedMarker}\n`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-mistakes >= 1\.46\.0/);
  assert.match(result.stderr, /https:\/\/github\.com\/kunchenguid\/no-mistakes\/pull\/670/);
  assert.match(result.stderr, /Older no-mistakes that only writes the signature/);
  assert.match(result.stderr, /no-mistakes-pipeline-attestation:v1/);
});

test("fails when the attestation comment is not parseable JSON", () => {
  const result = runGate({
    body: [
      expectedMarker,
      "",
      `${ATTESTATION_PREFIX} {not-json} -->`,
    ].join("\n"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-mistakes >= 1\.46\.0/);
  assert.match(result.stderr, /https:\/\/github\.com\/kunchenguid\/no-mistakes\/pull\/670/);
  assert.match(result.stderr, /could not parse|not parseable|unparseable/i);
});

test("fails when required steps are skipped, failed, or missing", () => {
  const skipped = runGate({
    body: pipelineBody({
      steps: [
        { step: "review", status: "completed" },
        { step: "test", status: "skipped" },
        { step: "document", status: "completed" },
      ],
    }),
  });
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /test status=skipped/);
  assert.match(skipped.stderr, /Quota skips and agent skips are non-compliant/);
  assert.doesNotMatch(skipped.stderr, /1\.46\.0/);

  const failed = runGate({
    body: pipelineBody({
      steps: [
        { step: "review", status: "failed" },
        { step: "test", status: "pending" },
        { step: "document", status: "running" },
      ],
    }),
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /review status=failed/);
  assert.match(failed.stderr, /test status=pending/);
  assert.match(failed.stderr, /document status=running/);

  const missingDocument = runGate({
    body: pipelineBody({
      steps: [
        { step: "review", status: "completed" },
        { step: "test", status: "completed" },
      ],
    }),
  });
  assert.notEqual(missingDocument.status, 0);
  assert.match(missingDocument.stderr, /document status=missing/);
});

test("passes when signature and attestation show review, test, and document completed", () => {
  const result = runGate({
    body: pipelineBody({
      steps: [
        { step: "intent", status: "skipped" },
        { step: "review", status: "completed" },
        { step: "test", status: "completed" },
        { step: "document", status: "completed" },
        { step: "lint", status: "skipped" },
        { step: "pr", status: "running" },
        { step: "ci", status: "pending" },
      ],
    }),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Found no-mistakes signature/);
  assert.match(result.stdout, /attestation/);
});
