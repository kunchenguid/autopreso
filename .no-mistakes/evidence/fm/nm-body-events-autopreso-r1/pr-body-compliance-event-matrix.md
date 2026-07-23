# PR body compliance event evidence

Focused local validation of `.github/workflows/no-mistakes-required.yml` for pull request
`#42`.

## Event identity and concurrency

| PR action | Rendered Actions run name | Rendered concurrency group | Observed policy |
| --- | --- | --- | --- |
| `opened` | `PR #42 body compliance - opened - event 77 (run 1001)` | `no-mistakes-required-42-1001` | Immutable event run |
| `edited` | `PR #42 body compliance - edited - event 78 (run 1002)` | `no-mistakes-required-42-1002` | Immutable event run |
| `synchronize` | `PR #42 body compliance - synchronize - event 79 (run 1003)` | `no-mistakes-required-42-head-change` | Coalesced head change |
| `reopened` | `PR #42 body compliance - reopened - event 80 (run 1004)` | `no-mistakes-required-42-head-change` | Coalesced head change |

The `opened` and `edited` events cannot replace one another as pending runs because
their concurrency groups contain distinct immutable `github.run_id` values.
`synchronize` and `reopened` retain their shared `head-change` group, with
`cancel-in-progress: true`.

## Compliance decision path

A PR body containing the canonical signature completed successfully:

```text
Found no-mistakes signature in PR #42 body.
exit status: 0
```

An unsigned PR body produced the contributor-facing failure:

```text
::error::This PR was not raised through no-mistakes.

Contributions to this repository must be submitted via 'git push no-mistakes'.
That pipeline runs the required review/test/lint/CI steps and writes a
deterministic '## Pipeline' section into the PR body containing:

    Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)

See CONTRIBUTING.md for setup and the full workflow.

PR author: example-contributor
exit status: 1
```

## Preserved contract

The focused executable contract test also verifies:

- `pull_request` actions remain `opened`, `edited`, `synchronize`, and `reopened`
- `pull_request_target` is absent
- permissions remain read-only (`contents: read`)
- the stable check name remains `PR must be raised via no-mistakes`
- the canonical signature marker is unchanged
- `github-actions[bot]`, `dependabot[bot]`, and `release-please[bot]` remain exempt
