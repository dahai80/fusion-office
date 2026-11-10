# Ask AI review: an expert audit of the assistant loop

Date: 2026-11-10. Scope: the AI assistant surface of all five apps (documents,
spreadsheet, presentation, pdf, pm) — the agent loops, the tool layer, the model
resolution chain, and the failure record accumulated since the feature shipped.
This document answers four questions posed as a first-principles review, then
turns them into a defect catalog and a fix plan.

## 1. What would a top expert in this domain do that we never asked for

- **Define acceptance before capability.** An expert would not judge the
  assistant by whether a reply "sounds good" (the original bug report said
  exactly that: "回答挺好的但没干活"). They would hold a golden set of prompts
  per app and assert the final artifact state — cells written, ranges cleared,
  formulas recomputing — not the prose.
- **Close the loop on every write.** The model claims a write happened; the
  engine knows whether it did. An expert wires the two together: every write
  result carries what the engine actually computed afterwards, so the model can
  self-correct against reality instead of its own claims.
- **Treat the model as an unreliable component.** Schema-validate every tool
  call, repair known encoding mistakes mechanically, reject with an actionable
  error, and cap repetition. Hope is not a strategy; we shipped three bugs
  (prose-only replies, fenced values, stringified rows) that are all the same
  disease: trusting the model's serialization.
- **Instrument the whole path.** One correlation id per agent run joining the
  client log, the tool results, and the gateway route decision. Without it,
  every incident starts with "which model actually answered?" — which is
  exactly what happened when the gateway fell back from glm-5 to a local 4B
  model and the panel kept showing the selected model.
- **Gate features by measured model capability.** A 4B local model and a large
  cloud model do not have the same tool-use reliability. An expert measures
  each tier against the golden set and degrades the feature set (fewer
  free-form tools, more mechanical fallbacks) instead of shipping the same
  loop to both.
- **Honest UX about failure.** A failed step that says "failed" with the raw
  tool error is for developers. The panel should translate: what failed, what
  it means for the sheet, what to do next.

## 2. The raw material an expert would start from (not the polished artifacts)

- **The failure corpus itself.** Gateway route decisions and stream summaries,
  client-side tool-call logs, and the verbatim user prompts that failed. Every
  bug fixed so far (#16-#20 prose replies, #22 model bypass, #24 fenced
  values, #25 stringified rows) was found by reading live traffic, not by
  designing in the abstract.
- **The engine's semantics as ground truth.** The workbook engine already
  guarantees recalculation, validation rules, spill handling, and protection.
  These are the independent oracle the assistant's writes must be checked
  against — no model opinion involved.
- **Model capability profiles, measured.** The same prompt battery run across
  the model tiers the product actually serves (local 4B, glm-5, larger cloud)
  to learn what each reliably does with the tool schemas we ship.
- **Upstream protocol traces.** SSE dumps of the relays in play, to
  characterize the dropped tool-call deltas that motivated the non-stream
  fallback (tracked upstream as dahai80/fusion-gateway#580).
- **The existing test corpus as behavioral spec.** The engine suites encode
  what the sheet must do; the AI layer should be tested against the same
  invariants, not a parallel invented set.

## 3. The concrete methods and tools an expert would use

- **Golden-set eval harness**: scripted agent runs against fixture workbooks,
  asserting final sheet state; runnable against recorded responses in CI and
  against live models behind a flag (`verify:ai` is the seed of this — it needs
  per-app prompt batteries and state assertions).
- **Trace logging with correlation ids** per agent run, joining client tool
  logs and gateway route decisions.
- **Write verification blocks**: every changing tool returns what the engine
  computed after the write (computed values preview, formula error scan,
  spill/protection notes) so the model sees reality, not its claim.
- **Repetition circuit breakers**: an agent that re-issues the identical call
  with identical arguments is broken by definition; break it early with a
  message that says what to do instead.
- **Stream watchdogs**: a stream that goes silent must time out and replay
  non-stream (the tool-delta fallback exists; a hung stream with no completion
  still shows an endless typing indicator — needs a client-side deadline).
- **Boundary fuzzing as first-class tests**: double-encoded args, fenced
  payloads, string rows, over-cap reads — every model-serialization mistake
  seen in the wild becomes a permanent test.
- **Failure taxonomy in metrics**: count prose-only turns, tool-encode
  failures, stream drops, hung streams, loop breaks, per model tier.

## 4. What proves the result correct, beyond the user and the assistant

1. **The engine's own recalculation.** After a write, the computed cell values
   and the formula error scan are facts produced by the engine, not by the
   model. They are the primary oracle.
2. **Replayable eval suites.** A golden set asserting final sheet state runs
   identically on every commit and every model; pass/fail is mechanical.
3. **Auditable traces.** Request/response logs on both sides (client tool log,
   gateway route + stream summary) make any outcome reconstructable after the
   fact.
4. **Shape validation at every boundary.** Tool schema, JSON parse, engine
   validation rules, and write preflight (protection, spill, size) each reject
   independently — correctness does not rest on one check.
5. **Undo and the change history.** Every tool call is one undo step; the
   user's own diff review is a safety net the assistant cannot talk its way
   around.
6. **Cross-model convergence.** The same prompt battery converging to the same
   final state across model tiers is evidence the loop, not one lucky model,
   carries the capability.

## Defect catalog (from the live record, 2026-11-06 → 11-10)

| # | Defect | Status |
|---|--------|--------|
| 1 | Prose-only replies that change nothing (#16-#20) | fixed, v0.1.19 |
| 2 | Agent loop bypassed the model picker / tenant policy (#22) | fixed, v0.1.20 |
| 3 | Admin key could be baked into bundles (#23) | fixed, v0.1.20 |
| 4 | `write_cells` values wrapped in a markdown code fence never unwrapped (#24) | fixed, cf1bcdc2 |
| 5 | Rows double-encoded as strings rejected wholesale (#25) | fixed, ca4b2b24 |
| 6 | Dropped tool-call deltas on stream (loop symptom before the fallback) | mitigated client-side; upstream dahai80/fusion-gateway#580 |
| 7 | Hung stream: typing indicator animates forever, no client-side deadline | open — needs watchdog |
| 8 | Route fallback hides the answering model: panel shows glm-5 while a local 4B answers | open — needs surfacing (gateway-side data + UI) |
| 9 | No repetition circuit breaker: identical call re-issued until MAX_ROUNDS | fixed with this review |
| 10 | Write results carry no computed values: model cannot self-verify | fixed with this review |
| 11 | Model tier not gated: feature set identical for a 4B local model and a cloud model | open — needs golden set + policy |

## Fix plan

In this repository, now: the circuit breaker (9) and the write verification
preview (10), both with tests.

Next, tracked issues: the stream watchdog (7), model transparency (8, with the
gateway team), the golden-set eval harness (1/2/3/6/11 as one workstream).

Upstream (report only, per repo rules): the dropped tool-delta relay bug stays
with dahai80/fusion-gateway#580; the model-policy visibility gap needs a
gateway response field before any client can show the true answering model.

## Workstreams landed 2026-11-10

- **Golden-set eval harness** (`apps/spreadsheet/eval/`): `record.mjs` records
  real model runs into `cases/*.json`; `tests/eval-golden.test.js` replays
  every case with the model stubbed and asserts the final workbook state
  (defects 1/2/3/6/11's precondition — capability is now measured against
  recorded reality, not invented model behavior).
- **Live pass@k runner** (`apps/spreadsheet/eval/run-live.mjs`): re-runs each
  case N times against the gateway, per model, manually. `--planner` runs the
  same cases through the plan-then-apply core for an architecture comparison.
- **Plan-then-apply prototype** (`src/core/aiplan.js`): the model reads with
  the read tools, then commits the whole change as one `apply_plan` call —
  validated whole before anything is written, asked about once, applied in
  order; a failing edit stops the plan and reports what applied. Tests in
  `tests/aiplan.test.js`; not yet wired into the panel.
- **Task corpus** (`src/core/aitelemetry.js`): every prompt the user sends is
  recorded in that browser's localStorage (200 newest, attachments counted
  never stored); console helpers `fusionOffice.promptLog()` /
  `exportPromptLog()` / `clearPromptLog()` feed the eval set with real task
  distribution. Tests in `tests/aitelemetry.test.js`.
- **Stream watchdog** (defect 7): keepalive comments no longer rearm the idle
  timer, so a stream that produces nothing real aborts and the non-stream
  fallback replays it (packages/ai-client, #26).
