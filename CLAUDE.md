---
doc_id: fusion-office/guide/claude
product: fusion-office
class: app
entry: guided-ui
doc_type: guide
title: { zh: "仓库工程规则", en: "CLAUDE.md" }
audience: developer
status: draft
version: 0.1.0
updated: 2026-11-07
owner: "@dahai"
source_of_truth:
  - CLAUDE.md
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Fusion Office is the local-first office suite of the Fusion monorepo. Five browser apps
(documents, spreadsheet, presentation, pdf, pm) run as static Vite builds, store real
files through the browser's File System Access API or OPFS, and call a local model only
through `fusion-gateway` on `127.0.0.1:11432`.

The code is migrated from HeyPuter/everything. Documents, presentation, pdf, and pm are
MIT. Spreadsheet is AGPL-3.0-only and the root MIT license does not cover it.

`services/office-api` is a Python FastAPI document-capability service (xlsx table
parsing, docx template fill + markdown parse/write per issue #35, pptx
parse/write incl. a `format=markdown` mode per issues #32/#36) consumed by other
Fusion projects. It implements the contract in issue #1, binds to
`127.0.0.1:11492`, and holds no business logic. Docx write/fill roundtrips are
anchor-checked against the office-bench fidelity semantics (issue #65,
fusion-bench#67/#68); the live office-bench gate (baseline 71.9%) runs
pre-release from the fusion-bench checkout — it needs the local engine. Large-sheet pattern (issue #45):
`/v1/xlsx/parse` takes `mode=sketch` (structure only) or `sheet`+`region`
(bounded region read, 200,000-cell cap, absolute range names); the high-level
action surface is the product — do not decompose it into primitive cell
operations. `GET /v1/rollouts/grep` is regex retrieval over the outcome sink.
Outcome records accept `schema_version` 2 (#48): optional `env_state`
(restorable environment snapshot) and `validator` (`{name, version, status}`
versioned checker for the trainer's audit gate); v1 stays valid. Records on
either version may carry an optional `outcome.task_id` (#59) — the office
task registry id, stamped by ai-client's reporter from an explicit `taskId`
or the `?task=` query param a task runner appends.
`GET /v1/graph` derives the entity-tool graph (#50) from a static endpoint
registry — deterministic producer→consumer artifact edges for the trainer's
cross-app task synthesis. Every document endpoint accepts an optional
`artifact_mode` form field (issue #53): `index+preview` makes write endpoints
answer `{"ok", "artifact": {kind, name, size, sha256, preview}}` instead of raw
bytes and parse endpoints add the same block describing the source upload; any
other value keeps the default raw behavior. fusion-link maps the block to
task-outcome `artifact_refs`.

## Repository Rules

`fusion-office/` is one of the `fusion-*` sub-projects in `/Users/dahai/fusion`. Root
rules apply, with these specifics:

- This directory is its own git repository. Commit, branch, and PR here, never at the
  monorepo root.
- Only change code in this repository. Report upstream bugs to HeyPuter/everything; do
  not maintain divergent patches that belong upstream.
- No secrets in commits. Gateway keys come from environment variables or ignored
  `.env.local` files.
- AI traffic goes to `fusion-gateway`, never directly to `fusion-mlx` or an external API.
- README.md is English; README_CN.md is Chinese.
- Code style: 4-space multiples, no docstrings, logging around failure paths that would
  otherwise be silent.
- After changing behavior, update this file, README.md, and README_CN.md as needed.

## Commands

All commands run from this directory. Node.js 22.18 or newer is required.

```bash
npm install                       # also patches presentation and links test deps
npm run build                     # sequential build of all five apps
npm test                          # sequential vitest run of all five apps
npm run build -w apps/pdf
npm test -w apps/pdf
npm test -w apps/pdf -- tests/ai-panel.test.js
npm run dev:documents             # also dev:spreadsheet, dev:presentation, dev:pdf, dev:pm
npm run verify:ai                 # live gateway + loaded model check
npm run shell:serve               # register built apps with the union shell
./start.sh start                  # same, on fixed ports 11485-11489; stop|restart|status|log
npm run shell:smoke               # register, request each module, unregister, exit

cd services/office-api
python -m pytest tests -q         # Python capability-service suite
./start.sh start                  # 127.0.0.1:11492; also stop|status|log
```

`verify:ai` needs `FUSION_GATEWAY_KEY`. `shell:serve` needs
`FUSION_ADMIN_KEY`. `shell:smoke` additionally needs
`FUSION_GATEWAY_MASTER_KEY`, which is used only to derive a short-lived shell session
secret. Never hardcode or commit these values.

Browser suites exist in all five apps:

```bash
npx playwright install
npm run test:browser -w apps/documents
npm run test:browser -w apps/spreadsheet
npm run test:e2e -w apps/presentation
npm run test:e2e -w apps/pdf
npm run test:browser -w apps/pm
```

Documents, spreadsheet, and pm default to ports 5189, 5190, and 5191 (`PLAYWRIGHT_PORT`)
and launch installed Chrome unless `PLAYWRIGHT_CHANNEL=chromium` is set.

## Architecture

npm workspaces: `apps/*` and `packages/*`.

- `packages/storage` owns local files. It resolves a writable root once per session:
  File System Access API directory picker first, OPFS fallback (including a dismissed or
  gesture-less aborted picker), IndexedDB as a best-effort listing index. Exports include `readFile`, `writeFile`, `readdir`,
  `deleteFile`, and KV helpers (`get`, `set`, `del`). Files remain real documents, not
  rows in a database.
- `packages/ai-client` owns model access. It is an installable package
  (issue #65: not `private`, published to npm as `@fusion-office/ai-client`;
  contract documented in `packages/ai-client/README.md`; downstream consumers
  extend the shell-served port set via `VITE_FUSION_SHELL_PORTS`). It defaults to
  `http://127.0.0.1:11432` (in dev, the same-origin `/__fusion_gateway` proxy from
  `dev/gateway-proxy.mjs`; when served by `scripts/shell-serve.cjs` on the fixed ports
  11485-11489, the same `/__fusion_gateway` path — relayed server-side by shell-serve,
  because the gateway's CORS allowlist covers neither),
  reads `VITE_FUSION_GATEWAY_URL`,
  `VITE_FUSION_GATEWAY_KEY`, and `VITE_FUSION_MODEL` at build time, and exposes
  `chat`, `chatStream`, `chatStreamEvents`, `jsonChat`, `listModels`, and
  `ensureModelLoaded`. `isConfigured()` reports whether a key is present.
  `createModelPicker()` builds the shared per-app model selector (gateway model list,
  persisted choice); calls without an explicit `model` use the picked model, then the
  build-time default. `VITE_FUSION_CUSTOMER_MODE=1` suppresses the picker entirely
  (issue #29); when the resolution chain yields no model, `chat`/`chatStream`/
  `chatStreamEvents` fail before the request with a customer-actionable message
  instead of sending `model: ""` (issue #28). The gateway key must be baked at build time for browser calls to
  authenticate (`scripts/build-all.mjs` loads the gitignored root `.env.local` into the
  environment; Vite reads `VITE_*` files from each app's own directory, so a root env
  file alone is not enough). `build-all.mjs` refuses the build when
  `VITE_FUSION_GATEWAY_KEY` equals `FUSION_ADMIN_KEY` (issue #23) — the admin key is
  unlimited on the gateway key plane and must never be baked into a client bundle.
  Standalone builds bake a dedicated scoped key; inside the shell no key is needed.
  The spreadsheet agent loop leaves the model to the chat adapter's resolution chain
  (picker, shell policy, build default) — no baked model id in the transcript loop
  (issue #22).
- Each app keeps the historical `puter.js` / `cloud.js` adapter name so call sites did
  not need to move. Those adapters now delegate to `@fusion-office/storage` and
  `@fusion-office/ai-client`. Do not reintroduce Puter globals.
- Model resolution (`packages/ai-client/src/index.js` `resolvedModel`): explicit
  `opts.model`, then the per-app picker (`fusion-office.ai-model`), then the shell's
  `fusion.shell.model` localStorage handoff (`src/shell-model.js`, read only under a
  `/shell/` pathname, at call time so shell-side changes apply without rebuild), then
  the gateway's policy-resolved model (`src/model-policy.js`, `GET
  /api/v1/shell/model-policy?module=<id>` under the shell session; success caches 5
  minutes, failure 60), then the build-time `VITE_FUSION_MODEL` default.
  Standalone/dev skips the policy fetch entirely and keeps the legacy chain. Inside
  the shell the policy plane is fail-closed (mirroring the gateway's tenant gate,
  which 403s any tenant without a non-empty allowlist): a policy that cannot be
  read, or one without a non-empty allowlist, offers no model at all — the picker
  empties and hides, and `resolvedModel()` returns empty so nothing outside the
  policy reaches the gateway. A non-empty allowlist pins the picker even when its
  models are absent from `GET /api/v1/shell/models` — missing entries render as
  unloaded options (issues #11, #13). The send path (`resolvedModel()`) clamps
  every non-explicit candidate (stored pick, shell pref, build default) against the
  allowlist and falls through to `policy.resolvedModel`; an explicit `opts.model`
  passes through untouched and the gateway stays the enforcement point (issue #14).
- Asset weight (issue #12): fonts ship as WOFF2 (lossless conversion by
  `scripts/convert-fonts.py`; TTF originals stay in `public/fonts/` for tests and
  provenance, stripped from dist by `dev/strip-ttf-dist.mjs`). `npm run build` emits
  `.gz` siblings for compressible dist files over 1 KB (`scripts/gzip-dist.mjs`), and
  `scripts/shell-serve.cjs` serves the `.gz` sibling when the client accepts gzip.
  `fixtures/`, `thesaurus/`, `dictionaries/`, and `ocr/` are fetched on feature use,
  never on first open.
- Shell traffic is session-gated (issue #10): inside the shell, `chat`/`chatStream`/
  `chatStreamEvents` POST `/api/v1/shell/chat/completions`, `listModels` reads
  `/api/v1/shell/models`, requests carry `credentials: "include"` and never an
  `Authorization` header (the HttpOnly `fusion_shell_session` cookie authenticates;
  a Bearer header would make `withShellSession` try to validate the static key as a
  session token). Outside the shell the static-key `/v1/*` path applies and a
  one-time warning is logged, since that key is extractable from the bundle.
  `isConfigured()` is true inside the shell even with no baked key.
  `ensureModelLoaded` cannot load models through the session-gated surface — it
  throws an actionable error when the model is not loaded and no key is present.
- Test-only compatibility: documents and spreadsheet use a stubbed `globalThis.puter`
  when `import.meta.env.MODE === 'test'`. Production code paths never touch it.
- Vite uses a relative `base` in every app so the same build runs standalone and behind
  the gateway's `/shell/<id>/` prefix.

### AI integration points

Documents, PDF, and PM assistants run the shared agent loop in
`packages/ai-client/src/agent.js` (`createAgent`): it streams, executes the tool calls,
feeds results back, and asks before destructive steps. Each app owns its tool schemas
and runner in a `*-tools` module; keep the two in step.

Prose-reply fallback (issues #16-#20): a small model often answers a change request in
plain text instead of calling a tool. When a turn changes nothing, each app offers to
apply the reply from `parseMarkdownTable` (`packages/ai-client/src/markdown-table.js`):
documents shows "Insert as table" / "Insert as text" in the pane, spreadsheet offers
"Write into cells" from the selected cell, presentation offers "Insert as table" /
"Insert as text" on the current slide, and pm offers "Create N tasks" from table rows or
bullet lines. Documents' system prompt also forbids describing a change without calling
the tools. The PDF panel is read-only by scope and says so (answers never change the
file; the only write is a bookmark).

- Stream resilience: when tools were sent but the stream ends with a short
  prose preface and no tool calls while the model spent tokens (Anthropic-protocol
  relays can drop tool-call deltas; tracked upstream as
  dahai80/fusion-gateway#580), `chatStreamEvents` replays the request once without
  streaming — the non-stream path returns `tool_calls` intact — and yields them;
  if the retry confirms the answer is prose, the text is kept once, not duplicated.
- Plan-consistency selection (issue #57, `packages/ai-client/src/consistency.js`):
  documents, spreadsheet, and pdf agent loops take `consistency: N` — write-class rounds
  (`changes` predicate true) get N extra chat samples at temperature 0.7, the
  proposed plans are compared with order-insensitive signatures (scalar strings
  are canonicalized first so `42` vs `"42"` and `=A1*2` vs `A1*2` count as
  agreement, issue #61), and the verdict
  (`selection` event + `consistency k=… samples=… agreement=…` folded into the
  turn's outcome detail) feeds the tap jsonl. The greedy plan always executes —
  no workspace sandbox exists, so this is plan-level consistency, not
  execution-level. Panels pass `consistency: 2`, gated off under
  `MODE === 'test'` (panel tests script multi-round chat sequences by call
  count); read-only rounds keep single-sample latency.
- Outcome signals (issue #33): `createOutcomeReporter`
  (`packages/ai-client/src/outcomes.js`) posts rollout-tap schema v1 records to
  office-api's `POST /v1/outcomes`, which appends them to the JSONL sink
  fusion-trainer's `rollout_ingest` consumes unchanged. The shared agent loop reports
  `user_accepted`/`user_rejected` on approvals and `task_success`/`error` at turn end
  (spreadsheet's `aiagent.js`/`aiplan.js` and presentation's `assistant.js` carry the
  same wiring in their own loops). Fire-and-forget, idempotent per rollout event,
  content redacted unless `contentMode: "raw"`. Rollout correlation (issue #38):
  each agent turn mints one `ro-<16 hex>` id and sends it as `X-Fusion-Rollout-Id`
  on every chat request (inert until the gateway adopts it — tracked upstream), so
  the gateway tap's records and the app-reported outcomes can be joined per turn;
  documents reports `user_edited` when the user undoes a turn's changes.
- Documents: the assistant pane (`src/views/assistant-pane.js`) drives
  `src/lib/assistant-tools.js` over the canvas engine: read, find, insert, replace the
  selection (asks approval), format, insert a table or page break, add a link. Each tool
  call is one undo step. The pane's visible step list is a presentation-layer
  filter (issue #55, `src/lib/assistant-steps.js`): empty `insert_text` calls are
  hidden and consecutive identical reads collapse into one entry with a ×N badge —
  the agent's step log keeps every step. `src/lib/puter.js` also carries the language tools, grammar
  checks, smart lookup, and drawing through `aiChat`; `assistantPrompt` /
  `readReply` in `src/lib/assistant.js` remain for those JSON-shaped calls. One-shot
  AI features live in `src/lib/thesaurus-ai.js` (thesaurus pane, static WordNet
  fallback), `src/lib/alt-text-ai.js` (alt-text suggestion), and
  `src/lib/summarize-ai.js` (Tools → Summarize with AI pane, 20,000-char cap).
- Spreadsheet: `src/lib/puter.js` `aiChat` / `aiChatStream`; used by the AI dialog,
  AI panel, translation, thesaurus, and `AI`/`TRANSLATE`/`DETECTLANGUAGE` sheet
  functions. `src/ui/error-smarttag.js` has an Explain-with-AI action (formula, error
  code, ~20 sampled cells) and `src/ui/chartdialog.js` a Suggest-with-AI action
  (50-cell sample, reply constrained to the supported chart types). Cross-session
  memory (issue #45/#47): the agent tool `grep_rollouts` (defined in `aitools.js`,
  dispatched in `src/core/rollouts.js` outside the synchronous runTool registry,
  intercepted in the panel's runTool wrapper) searches office-api's outcome sink
  via `GET /v1/rollouts/grep`; base URL `VITE_FUSION_OFFICE_API_URL`
  (default `http://127.0.0.1:11492`); unreachable service answers with actionable
  text so the model falls back to the workbook.
- Presentation: `src/cloud.js` `aiChat` and `aiChatStream` (tool-event stream); used by
  prompt-to-deck, the assistant panel, and slide review. `src/notes-ai.js` adds
  Generate-with-AI buttons in the speaker-notes pane (per slide and all slides,
  8,000-char batch cap, writes through the same mutateSlide path as the notes box).
- PDF: `src/ai-panel.js` is an assistant over the open file, backed by
  `src/ai-tools.js` and the command closure in `src/editor.js` (`info`, `readPages`,
  `find`, `goTo`, `zoom`, `bookmark`). It reads at most 20 pages per call; scanned
  documents require OCR first. The panel also has one-shot quick actions: Summarize
  document (bounded through the same caps, 60-page/40,000-char input cap) and
  Translate page (remembers the last language).
- PM: `src/ui/assistant.js` opens the project assistant over `src/lib/ai-tools.js` and
  the store (tasks, columns, checklist items, comments; delete asks approval).
  `src/ui/checklist.js` still calls `AI.jsonChat` for task breakdown.
  `src/ui/brief.js` has an AI standup action (overdue/near-due risks folded into the
  summary, 8,000-char payload cap) and `src/ui/quickadd.js` parses typed lines with the
  model when configured, falling back to the mechanical parse on any invalid reply.

When changing a prompt, a tool schema, or its runner, update the matching unit test.
Tests mock `@fusion-office/ai-client`; live verification is separate in
`scripts/verify-ai.mjs`.

Long-context discipline (all five apps, issue #7): the system prompt is always the
first message and the conversation head stays stable for the gateway's prompt prefix
cache; snapshots are summaries, never whole files, and content is read on demand through
capped tools (`read_document` 20,000-char selection cap, PDF 14,000-char page cap,
spreadsheet `read_range`, pm `list_tasks` 300-task cap with a `[N more tasks not shown]`
marker, presentation 100-slide listing cap); and each agent core keeps a rolling change
log (`requestMessages(..., { changelog })`) that injects `- Label (target)` lines right
behind the system prompt instead of replaying evicted history. When adding a read tool,
give it a cap and an actionable over-cap error; when adding a changing tool, the agent
cores pick it up through the tool result's `changed`/`target` fields.

### Deep-link hand-off

Other Fusion modules (first caller: fusion-design) open generated content through the
app URLs. Documents: `#/new?title=<name>&body=<urlencoded>&format=html|markdown|text&source=<module>`
creates a document through the file-import path (1,000,000-character cap; `format`
defaults to markdown; `name` = `title`; `source` is log-only). Presentation:
`#/home?prompt=<urlencoded>&source=<module>` prefills the describe-your-presentation
box (4,000-character cap) and does not auto-run generation. Payloads ride in the URL
fragment; parsing lives in `apps/documents/src/lib/deeplink.js` and
`apps/presentation/src/start/deeplink.js`.

### Union shell

Each app has `web/manifest.json` with id `fusion-office-<app>`, path `/office/<app>`,
and entry `/shell/fusion-office-<app>/`. All five carry `group` `fusion-office` with
`group_title` `Fusion Office` and `sort` 1 to 5, so schema-v2 shells show one grouped
menu; ids, paths, and entries stay unchanged. `scripts/shell-serve.cjs` serves each `dist`
on fixed ports 11485-11489 (registered in `architecture/port-registry.yaml`; entry
`fusion-office` is the supervised one, the other four are `supervise: false`), registers
manifests through the gateway admin API, heartbeats, and unregisters on exit. `start.sh`
wraps it for fusion-supervisor: `fusion-sv up fusion-office` starts and crash-restarts
it; the admin key (`FUSION_ADMIN_KEY`) resolves from the environment, `.env.local`, or
the gateway config's `web_shell.admin_key`. Before serving, `start` self-checks the
`fusion-office` entry in `port-registry.yaml` and refuses an unregistered port
(`FUSION_SKIP_REGISTRY_CHECK=1` bypasses). The gateway proxies `/shell/<id>/` and
requires a signed shell session, not an API key.

The same server ships as a standalone Node single executable: `npm run sea:build`
(Node >= 26.7) embeds the five dists and manifests as SEA assets via
`scripts/build-sea.mjs`; `shell-serve.cjs` reads them with `getRawAsset` when
running as a SEA (`node:sea`), from disk otherwise, and serves 11485-11489 even
when the gateway is unreachable (registration degrades to a warning). Pushing a
`v*` tag runs `.github/workflows/release.yml`, which builds linux-x64, win-x64,
darwin-arm64, and darwin-x64 executables (the darwin-x64 build runs the official
x64 Node binary under Rosetta; the postject injection path is avoided — it
segfaults on current macOS — in favor of the native `node --build-sea`) and
attaches them to the GitHub release.

## Verification Expectations

- Run the affected app's vitest suite after any change; run `npm test` before reporting
  completion. A failing test is fixed even if the failure predates the change.
- Run `npm run build` after changing source, manifests, or Vite config.
- Run `npm run verify:ai` only when a local gateway and model are available; it makes
  real model calls.
- Run `npm run shell:smoke` after building when changing manifests, gateway routing, or
  shell scripts.
- Clean up temporary servers, registered manifests, and scratch files after verification.
  Keep final logs such as `dev/verify-ai.log`.

## Licensing

- Root `LICENSE` is Apache-2.0 and covers first-party code: `packages/storage`,
  `packages/ai-client`, `services/office-api`, and the root tooling.
- `apps/documents`, `apps/presentation`, `apps/pdf`, and `apps/pm` are MIT-derived from
  HeyPuter/everything and each keeps its own `LICENSE` file.
- `apps/spreadsheet/LICENSE` is AGPL-3.0-only. Do not relicense it, remove notices, or
  fold it under the Apache root license; AGPL obligations apply to that app.
