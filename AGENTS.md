# AGENTS.md

Guidance for coding agents in this repo. The README owns user-facing behavior, CONTRIBUTING.md owns workflow and release details, and source comments own implementation detail.

## Commands and CI

- Scripts live in `package.json`: `npm run dev`, `npm run typecheck`, `npm test`. Run one file with `node --test test/<file>.test.js`, filter with `--test-name-pattern`.
- There is no lint step. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24.
- Pass `--no-open` to the CLI to skip auto-launching the browser.

## Architecture invariants

- One Node process: `src/cli.js` -> `startServer` in `src/server.js`, which owns Express + WS, the transcription manager, and the whiteboard agent. Keep the agent system prompt, message construction, and `tool({...})` schemas colocated in `src/server.js`.
- `public/app.js` is plain ES modules via an esm.sh importmap. There is no frontend build step.
- Session modes are asymmetric (`src/whiteboard-session.js`): in `staging` the frontend owns the elements; in `live` the server's `state.elements` is the source of truth.
- Audio carries a browser `sessionId`. Stop, reset, back-to-staging, and Start Preso invalidate the session token so late frames, queued turns, stale tool calls, and history appends cannot touch the next session. Preserve this when adding session paths.
- The warmup loop exists for prompt-cache priming: every attempt sends identical prefix bytes, then `agentHistory` becomes `[warmup_user_msg, assistant("UNDERSTOOD")]`, and Agent instructions are snapshotted per preso. Do not change this pattern without understanding the cache implications (see comments near `WARMUP_USER_MESSAGE` in `src/server.js`).
- The agent edits a line-numbered text view of the scene, not Excalidraw JSON. When changing the edit contract, update the tool schema in `src/server.js`, the applier in `src/whiteboard-tools.js`, and add a test in `test/whiteboard-tools.test.js`.
- The system prompt is P1-P10 cross-cutting principles plus short per-genre stubs. Do not append verbose "When the talk is X..." paragraphs. Prompt experiments use `scripts/simulate-whiteboard-agent.md`.
- Settings (`src/settings-store.js`): always use `getSanitized()` for outbound payloads so API keys never reach the frontend. Env vars only seed `~/.config/autopreso/settings.json` on first run.

## Testing

- `node:test` + `node:assert/strict` with hand-rolled mocks in `test/*.test.js`. For server tests, inject fakes (`generateTextFn`, `streamTextFn`, `createTranscription`) through `startServer({...})` instead of touching the network.
- Use TDD for bug fixes and features: write the failing test first.

## Releases

- release-please manifest mode with two components, `autopreso` and `moonshine-sidecars`; see CONTRIBUTING.md "Releases" for which paths bump which.
- Never hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- Do not reintroduce a PR-time lockfile sync workflow; `test/release-ci-exclusions.test.js` guards the release-PR `paths-ignore` set.

## README

- The project is alpha. Keep the README's rough-edges framing rather than over-promising stability.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
