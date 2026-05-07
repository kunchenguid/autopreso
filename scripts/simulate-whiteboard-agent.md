# Whiteboard Agent System Prompt Tuning

This guide is for an orchestration agent running an end-to-end prompt tuning experiment against the whiteboard agent simulator.

## Goal

Evaluate whether a whiteboard agent system prompt change produces meaningfully better visualizations for a same transcript.

## Working Directory

Create a fresh temporary experiment directory outside the repo.
Prefer the system temp directory.

Example layout:

```text
/tmp/autopreso-whiteboard-experiment-<id>/
  transcript.txt
  baseline/
    prompt.txt
    trajectory.jsonl
    final-elements.json
    screenshots/
  candidate/
    prompt.txt
    trajectory.jsonl
    final-elements.json
    screenshots/
```

Do not write generated transcripts, screenshots, trajectories, or comparison notes into this repository unless a human explicitly asks for that.

## Experiment Steps

1. Create a synthetic transcript of a quick presentation - could be a tech talk, startup pitch, keynote presentation or similar - limited to <3000 words in total. Save it as `transcript.txt` inside the temporary experiment directory.
2. Run the whiteboard agent simulator script with the current product system prompt and put all artifacts under `baseline/`.
3. Inspect `baseline/trajectory.jsonl`, `baseline/final-elements.json`, and the screenshots.
4. Identify problems or opportunities to significantly improve the visuals. We care about ease of understanding, aesthetics, and helpfulness.
5. If there is significant room for improvement, modify the production system prompt in the product code to attempt the improvement.
6. Then run the simulator again with the same `transcript.txt` and write all artifacts under `candidate/`.
7. Compare baseline and candidate artifacts using the same criteria.
8. Report success=true only if the candidate run is clearly better.
9. If anything failed, or the candidate is worse or merely different but not clearly better than baseline, report success=false.
10. Make sure to include a concise summary of what your transcript idea is, so future experiments can avoid duplication

## Running The Simulator

Run all simulator commands from the repository root:

```sh
cd <repo-root>
```

The simulator script is:

```sh
./scripts/simulate-whiteboard-agent.js
```

It runs the whiteboard agent. Auth and everything has already been set up so you can just run it.

Baseline run:

```sh
./scripts/simulate-whiteboard-agent.js \
  --transcript "$EXP/transcript.txt" \
  --out "$EXP/baseline"
```

Candidate run, after editing the production system prompt in `src/server.js`:

```sh
./scripts/simulate-whiteboard-agent.js \
  --transcript "$EXP/transcript.txt" \
  --out "$EXP/candidate"
```

Use `$EXP` for the temporary experiment directory path.
For example:

```sh
EXP="$(mktemp -d /tmp/autopreso-whiteboard-experiment-XXXXXX)"
```

The script writes the artifacts itself.
Do not manually create trajectory or screenshot artifacts.

Each run writes:

- `prompt.txt`
- `chunks.json`
- `trajectory.jsonl`
- `final-elements.json`
- `screenshots/*.png`

Useful options:

- `--chunk-interval-ms 500` controls the minimum delay between queued transcript chunks.
- `--speaking-words-per-minute 160` controls the normal speaking-speed estimate used for length-based chunk delays.
  Actual chunk delay is the larger of the minimum interval and the estimated spoken duration of the chunk.
- `--agent-timeout-ms 90000` controls the per-turn model timeout.
- `--chrome-bin <path>` overrides the Chrome executable path if auto-detection fails.
- `--port 0` uses a random local server port. This is the default.

## Comparison Criteria

Prefer the candidate prompt only when it improves the visualization in concrete ways.

General rubric:

- The layout is clean, with no obvious overlap, clipping, cramped labels, or illegible arrow labels.
- The agent revises and reorganizes existing content, instead of endlessly appending notes.
- Each screenshot is easy to understand and great at visualizing the concepts being talked about.
- The final canvas is useful as a standalone visual explanation of the talk.
- Every screenshot is visually pleasing and aesthetic.

Specific structural pathologies to check for (these are the failure modes the existing P1-P10 principles in the system prompt address - if a baseline run shows one, the candidate should fix it):

- Arrows between independent peers (P1) - questions, themes, OKR objectives, competitors, risks, features chained left-to-right as if they were a sequence.
- Schema dimensions collapsed into paragraph labels (P2) - per-card fields like risk prob/indicator/owner or playbook real/ask/say/walk crammed into a multi-line paragraph instead of labeled lines.
- Severity / status / tier written as a word instead of encoded as fill color (P3) - "Red", "Yellow", "Green", "high threat" written inside the label when the card's fill could carry the tier.
- Paragraph-style multi-line labels (P4) - 5+ line text blobs inside a single shape; should split into multiple cards or drop detail.
- Chronologies collapsed into one card (P5) - 4+ dated events flattened into a single "rollout" or "timeline" paragraph card instead of a horizontal strip.
- Hero content given the same visual weight as supporting content (P6) - case-study lead metric or trial primary endpoint sized the same as secondaries.
- Meta content folded into the main grid or dropped (P7) - open questions, limitations, takeaways, recommendations, calibration rules either crammed into the title subtitle or absent entirely.
- Setup facts chained with arrows (P8) - "4 systems → unified engine → launch" or "method → question → themes" rendered as a flow when they are parallel context.
- Meta-explanation hub between title and peers (P9) - a "Themes from N interviews" or "Principles = shared vocabulary" card fanning arrows down to each peer.
- Multi-line wins-and-misses scoreboard paragraph (P10) - summary stats packed into a paragraph card instead of a one-line strip or count chips.

## Prompt guidelines

The whiteboard system prompt is structured as: cross-cutting structural principles (P1-P10, as of this writing) plus short per-genre stubs that reference the principles by number. When making changes, fit your fix into this structure rather than appending another verbose "When the talk is X..." paragraph - that pattern caused 50,000+ characters of bloat that we already consolidated once.

Fix-flowchart for an observed failure:

1. **Does the failure violate an existing principle (P1-P10)?** Strengthen the principle's wording, or add a short concrete example to it. Do not also add genre-specific re-statements of the same principle - the genre stub can just reference the P# by number.
2. **Is this a new genre not matching any existing stub?** Add a new short genre stub in the existing format: trigger phrases + which P# principles apply + per-card schema as labeled lines + only the genre-specific patches not already covered by principles. Cap the stub at ~10 lines / ~800 characters.
3. **Is this a new cross-cutting structural pattern not covered by P1-P10?** Add a new principle P11+ phrased generically (not in terms of one genre), then update the genre stubs that should reference it.

Hard rules:

- Avoid rules that overfit the specific transcript you're working on. If a fix only ever applies to one transcript, it does not belong in the system prompt.
- Never paste a verbose "When the talk is X (long parenthetical) ... do not do A; do not do B; do not do C; render the canvas as ..." paragraph. If a stub grows past ~10 lines, factor the cross-cutting parts up into a principle.
- Each genre stub should describe trigger phrases + per-card schema + genre-specific overrides only. Cross-cutting structural guidance (parallel-grid, schema-as-labeled-lines, severity-as-color, etc.) lives in the principles section, not duplicated per genre.
- Anti-pattern (do not do this):
  > "When the talk is a panel of perspectives, render each as its own same-size card in a parallel grid (3-5 cards), all same width and height, no arrows between them because the perspectives are independent peers, with the position as the headline (1-3 words) and the proponent name as a small subtitle, and at most one supporting phrase ..."
- Equivalent done right:
  > "Genre · Panel or perspectives roundup (3+ named perspectives answering the same question): per P1. Card schema = position headline (1-3 words) + proponent name subtitle + at most one 3-7 word supporting phrase. Secondary observations go in P7 bottom row or are dropped."

## Cleanup

Leave the temporary experiment directory in place because the human or another agent needs to inspect artifacts.
Never clean other unrelated temp directories.
