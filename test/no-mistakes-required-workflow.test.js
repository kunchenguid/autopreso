import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/no-mistakes-required.yml", import.meta.url),
  "utf8",
);

const expectedMarker =
  "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";

function concurrencyGroup({ action, pullRequestNumber, runId }) {
  const eventSuffix = action === "opened" || action === "edited" ? runId : "head-change";
  return `no-mistakes-required-${pullRequestNumber}-${eventSuffix}`;
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
