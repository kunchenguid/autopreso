import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function stripInlineComment(value) {
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === '"' && !singleQuoted && value[index - 1] !== "\\") {
      doubleQuoted = !doubleQuoted;
    }
    if (
      character === "#" &&
      !singleQuoted &&
      !doubleQuoted &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function parseScalar(source) {
  const value = stripInlineComment(source.trim());
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item));
  }
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  return value;
}

function parseWorkflow(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => ({
      indent: line.match(/^ */)[0].length,
      text: stripInlineComment(line.trim()),
    }))
    .filter((line) => line.text !== "");
  let index = 0;

  function parseBlock(indent) {
    if (lines[index]?.indent === indent && lines[index].text.startsWith("- ")) {
      const sequence = [];
      while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
        const itemText = lines[index].text.slice(2);
        index += 1;
        const separator = itemText.indexOf(":");
        if (separator < 0) {
          sequence.push(parseScalar(itemText));
          continue;
        }

        const item = {
          [itemText.slice(0, separator).trim()]: parseScalar(itemText.slice(separator + 1)),
        };
        if (index < lines.length && lines[index].indent > indent) {
          Object.assign(item, parseBlock(lines[index].indent));
        }
        sequence.push(item);
      }
      return sequence;
    }

    const mapping = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const line = lines[index];
      const separator = line.text.indexOf(":");
      assert.notEqual(separator, -1, `Invalid workflow line: ${line.text}`);
      const key = line.text.slice(0, separator).trim();
      const remainder = line.text.slice(separator + 1).trim();
      index += 1;

      if (remainder === ">-" || remainder === ">") {
        const parts = [];
        while (index < lines.length && lines[index].indent > indent) {
          parts.push(lines[index].text);
          index += 1;
        }
        mapping[key] = parts.join(" ");
      } else if (remainder === "" && index < lines.length && lines[index].indent > indent) {
        mapping[key] = parseBlock(lines[index].indent);
      } else {
        mapping[key] = parseScalar(remainder);
      }
    }
    return mapping;
  }

  return parseBlock(0);
}

const workflow = parseWorkflow(
  fs.readFileSync(
    new URL("../.github/workflows/no-mistakes-required.yml", import.meta.url),
    "utf8",
  ),
);

const expectedPathsIgnore = [
  ".release-please-manifest.json",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "packages/moonshine-darwin-arm64/package.json",
  "packages/moonshine-darwin-x64/package.json",
  "packages/*/CHANGELOG.md",
];

const expectedJobCondition = [
  "github.event.pull_request.user.login != 'github-actions[bot]' &&",
  "github.event.pull_request.user.login != 'dependabot[bot]' &&",
  "github.event.pull_request.user.login != 'release-please[bot]'",
].join(" ");

test("no-mistakes workflow preserves its pull request policy", () => {
  assert.equal(workflow.name, "Require no-mistakes");
  assert.equal(
    workflow["run-name"],
    "PR #${{ github.event.pull_request.number }} body compliance - ${{ github.event.action }} - event ${{ github.run_number }} (run ${{ github.run_id }})",
  );
  assert.deepEqual(Object.keys(workflow.on), ["pull_request"]);
  assert.deepEqual(workflow.on.pull_request, {
    types: ["opened", "edited", "synchronize", "reopened"],
    branches: ["main"],
    "paths-ignore": expectedPathsIgnore,
  });
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.deepEqual(workflow.concurrency, {
    group: "no-mistakes-required-${{ github.event.pull_request.number }}-${{ (github.event.action == 'opened' || github.event.action == 'edited') && github.run_id || 'head-change' }}",
    "cancel-in-progress": true,
  });
});

test("no-mistakes workflow delegates to the pinned shared action", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["check"]);
  assert.deepEqual(workflow.jobs.check, {
    name: "PR must be raised via no-mistakes",
    "runs-on": "ubuntu-latest",
    if: expectedJobCondition,
    steps: [
      {
        name: "Verify no-mistakes signature and pipeline attestation in PR body",
        uses: "kunchenguid/no-mistakes/.github/actions/require-no-mistakes@f6441c96c352a18b9cadcaef6b6c7017e9ac3970",
      },
    ],
  });
});
