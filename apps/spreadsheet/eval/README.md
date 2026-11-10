# Spreadsheet Ask AI golden-set eval

Recorded-replay evaluation for the agent loop: real model transcripts captured
from live runs (see `record.mjs`) are replayed against the engine with the
model stubbed, and the final workbook state is asserted. This is the "what
proves the result correct" layer from `docs/ask-ai-review.md` §4: the replies
are what a real model actually produced, so every fix to the loop or the tool
layer is checked against reality, not against invented model behavior.

## Layout

- `cases/*.json` — one case each: `name`, `prompt`, `fixture` (tool calls that
  build the starting workbook), `replies` (per-round stream parts as the client
  yields them), `expect` (cell assertions), `run_meta` (how the live run went).
- `record.mjs` — records a case from a live run through the gateway (needs the
  shell-session proxy or a static key): `node eval/record.mjs <case-input.json>`
  where the input holds `name`, `prompt`, `fixture`, `expect`.
- `tests/eval-golden.test.js` — replays every case and asserts `expect` plus
  loop invariants (no error, transcript well formed).

## Adding a case

Write an input file, record it against the live model you want in the corpus,
inspect the resulting `.case.json` (edit `expect` to the state you actually
want to pin), and move it into `cases/`. Keep the recorded replies verbatim:
the point is replaying real behavior, including its encoding quirks.

## Pass@k over live models

Replay is deterministic; stochastic pass rates need live runs. `run-live.mjs`
re-runs each case N times against the gateway and reports the pass rate per
case and model — the capability-gating measurement from the review. It makes
real model calls; run it manually, never in CI.

## Plan-then-apply comparison

`../src/core/aiplan.js` is the alternative architecture from the review: the
model commits the whole change as one `apply_plan` call that is validated
whole, asked about once, and applied in order. The same cases run through both
cores (`createAgent` vs `createPlanner`) measure whether the architecture, not
just the model, changes the pass rate. `run-live.mjs` takes a `--planner` flag
for this.
