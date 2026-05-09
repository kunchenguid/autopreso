# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
npm run dev                       # run the CLI from source (./src/cli.js)
npm run typecheck                 # tsc --noEmit
npm test                          # node --test, runs all tests in test/
node --test test/server-startup.test.js   # run a single test file
node --test --test-name-pattern="warmup" test/whiteboard-session.test.js  # filter by test name
npm run build:moonshine-sidecars  # build Python -> single-binary sidecars for macOS arm64+x64
node ./scripts/build-moonshine-sidecars.js darwin-arm64   # build only one target
```

There is no separate lint step. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24.

The `--no-open` flag suppresses auto-launching the browser, which is useful when iterating from a terminal.

## Architecture

The product is a single Node process that serves a static Excalidraw frontend, runs an STT pipeline, and orchestrates an LLM agent that edits the whiteboard via tool calls. The end-to-end loop is:

```
browser mic -> WS audio frames -> transcription provider -> turn queue ->
runWhiteboardAgent (in src/server.js) -> tool call ops -> apply to scene ->
broadcast whiteboard:update over WS -> frontend re-renders Excalidraw
```

### Entry points and wiring

- `src/cli.js` parses args, loads `~/.config/autopreso/settings.json` via `settings-store.js`, resolves an agent provider, then calls `startServer`.
- `src/server.js` is the central hub. It owns the Express + WebSocket server, mounts the static frontend in `public/`, instantiates a `WhiteboardSession`, builds a `TranscriptionManager`, and exposes `runWhiteboardAgent` / `runWhiteboardWarmupOnce` which contain the system prompt and the AI SDK `tool({...})` definitions. `server.js` is large (~1000 LOC) on purpose - keep the agent prompt, message construction, and tool schemas colocated.
- `public/app.js` is the React frontend. It renders Excalidraw, handles mic capture at 24 kHz, sends audio frames over WS, periodically pushes downscaled screenshots back to the server (`whiteboard:screenshot`), and reflects server-pushed scene updates back into Excalidraw. Frontend is plain ES modules loaded via `<script type="importmap">` from esm.sh - no build step.

### Two-mode session model (`src/whiteboard-session.js`)

The session has two modes that are NOT symmetric:

- **`staging`** - client-side scratchpad. The server does not track elements in this mode; the frontend owns them. Used to seed the canvas with reference content before going live.
- **`live`** - the server owns `state.elements` as the source of truth. Audio, screenshots, and user edits all flow into the server, which applies agent edits and broadcasts updates.

Transitions: `POST /api/preso/start` builds a "staging primer" message (current scene snapshot + downscaled screenshot when staging is non-empty), extracts staging text/labels as transcription keywords, and kicks off the warmup loop. `POST /api/preso/back-to-staging` returns to client-owned mode and clears the transcription keywords; `POST /api/session/reset` also clears them.

### Warmup loop

Before the user speaks, `startWarmupLoop` repeatedly fires the agent against the staging primer with exponential backoff (`DEFAULT_WARMUP_DELAYS`, max 8 attempts). Its purpose is **prompt cache priming**: after the loop ends, `agentHistory` is forced to `[warmup_user_msg, assistant("UNDERSTOOD")]` so every subsequent turn reuses the same prefix bytes. Do not change this primer-then-fixed-history pattern without understanding the cache implications.

### Transcript turn queue (`src/transcript-turn-queue.js`)

Transcript chunks are debounced (default 150 ms) and gated by an `isReady` predicate. While a turn is running, additional chunks are buffered and concatenated for the next turn. This means the agent never has more than one in-flight turn, but it always sees the most recent burst of speech in one shot. `isTrivialTranscript` in `whiteboard-session.js` filters out filler-only chunks ("uh", "okay", etc.) so they don't trigger turns on their own.

### Whiteboard edit model (`src/whiteboard-tools.js`)

The agent does not see Excalidraw JSON directly; it sees a **line-numbered text view** of the scene (`formatLineNumberedWhiteboard`) and emits `replace`, `insert_after`, or `delete` operations against line numbers. `applyWhiteboardEditOperations` validates and applies them in order. When changing the agent's contract, update both the tool schema in `server.js` and this applier, and add a test in `test/whiteboard-tools.test.js`.

### Agent providers (`src/agent-provider.js`, `src/codex-auth.js`)

Three providers, all routed through the `@ai-sdk/openai` adapter:

- **openai** - direct API key.
- **codex** - reads the user's Codex CLI auth from `~/.codex/auth.json`, then talks to the ChatGPT backend with that bearer token. No API key needed.
- **ollama** - OpenAI-compatible local endpoint (`http://localhost:11434/v1`).

`reasoningEffort` is validated against the set `{none, low, medium, high, xhigh}`.

### Transcription providers

- **Moonshine (default, local)** - `src/moonshine-transcription.js` spawns the platform-specific binary at `@autopreso/moonshine-<platform>/bin/autopreso-moonshine` (declared as **optional** dependencies; the install just skips on unsupported platforms). The binary is built from `scripts/moonshine-sidecar.py` via PyInstaller; only macOS arm64/x64 are currently packaged.
- **OpenAI Realtime** - `src/openai-transcription.js` opens a WSS connection to `wss://api.openai.com/v1/realtime?intent=transcription` and streams PCM frames.

The active provider is hot-swappable: `applyCurrent()` in `server.js`'s `createTranscriptionManager` rebuilds the underlying instance whenever settings change, without restarting the server. Any active session context is reapplied to the new provider.

### Settings store (`src/settings-store.js`)

Persists to `~/.config/autopreso/settings.json`. The store has a `getSanitized()` method that strips API keys before sending to the frontend - always use that for outbound payloads. Env vars (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_*`, `CODEX_*`) only **seed** the file on first run; once it exists, the file wins and env vars are ignored.

## Testing conventions

Tests use Node's built-in test runner (`node:test`) and live in `test/*.test.js`. They are not bundled into a framework - assertions are `node:assert/strict`, mocks are hand-rolled. Server tests in `test/server-startup.test.js`, `test/staging-mode.test.js`, etc. inject fakes for `generateTextFn`, `streamTextFn`, and `createTranscription` via `startServer({...})` options - prefer this pattern over network-touching tests. There is also a Chrome-driven smoke test (`test/browser-smoke.test.js`) that boots the real server.

Per the user's global instructions, use **TDD** for bug fixes and new features: write the failing test first.

## Whiteboard agent system prompt

The system prompt and tool schemas are defined inline in `src/server.js` (search for `buildWhiteboardAgentMessages` and the `tool({...})` calls). Its structure is `P1-P10` cross-cutting principles + short per-genre stubs. Do **not** append verbose "When the talk is X..." paragraphs - that bloat was already consolidated once. See `scripts/simulate-whiteboard-agent.md` for the full editing rubric and the `simulate-whiteboard-agent.js` harness used for prompt A/B experiments.

## Release process

This repo uses **release-please** in **monorepo manifest mode** (`.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`).

Two components version independently:

- **`autopreso`** (root, `.`) - the CLI npm package. Bumps on any conventional commit _except_ those touching the sidecar paths (`packages/moonshine-darwin-*`, `moonshine-sidecar.config.json`, `scripts/moonshine-sidecar.py`, `scripts/build-moonshine-sidecars.js`).
- **`moonshine-sidecars`** (`packages/moonshine-darwin-arm64`) - the platform sidecar npm packages. Bumps **only** when commits touch the sidecar paths above. The arm64 package is the release-please anchor; its version is mirrored into `packages/moonshine-darwin-x64/package.json` and into both `optionalDependencies` entries in the root `package.json` via `extra-files`. The two sidecar packages always share one version.

Workflow consequences:

- A typical change to `src/`, `public/`, or `test/` only bumps autopreso. The publish job for the sidecar group is skipped, so CI never runs the Python/PyInstaller build path on a regular release.
- A change to `moonshine-sidecar.config.json` (e.g. bumping `moonshineVoiceVersion`) bumps the sidecars. CI will then build the Python sidecar binaries on `macos-15` (required by recent `moonshine-voice` wheels, which target `macosx_15_0_universal2`) and publish both `@autopreso/moonshine-darwin-{arm64,x64}` packages.
- A commit that touches both kinds of paths bumps both components in a single release-please PR.

Other notes:

- `CHANGELOG.md` and `.release-please-manifest.json` are auto-generated. Per global rules, never hand-edit them.
- Sidecar binaries are produced by `scripts/build-moonshine-sidecars.js` and must be built on macOS (the script enforces this).
- `scripts/prepare-release-packages.js` is now a verification step: it confirms each sidecar's `package.json` version matches the root `optionalDependencies` entry and that the binary exists. Version writing is owned by release-please's `extra-files`, not this script.
- The published-on-npm sidecar version may lag autopreso; that's by design (pinning the same binary keeps users from re-downloading on every CLI patch).

## Project status (from README)

The project is in **alpha**. The README's prominent warning is intentional - keep the rough-edges framing rather than over-promising stability when editing it.
