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
parsing, docx template filling) consumed by other Fusion projects. It implements the
contract in issue #1, binds to `127.0.0.1:11520`, and holds no business logic.

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
./start.sh start                  # 127.0.0.1:11520; also stop|status|log
```

`verify:ai` needs `FUSION_GATEWAY_KEY`. `shell:serve` needs
`FUSION_GATEWAY_ADMIN_KEY`. `shell:smoke` additionally needs
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
- `packages/ai-client` owns model access. It defaults to
  `http://127.0.0.1:11432` (in dev, the same-origin `/__fusion_gateway` proxy from
  `dev/gateway-proxy.mjs`, because the gateway's CORS allowlist excludes dev ports),
  reads `VITE_FUSION_GATEWAY_URL`,
  `VITE_FUSION_GATEWAY_KEY`, and `VITE_FUSION_MODEL` at build time, and exposes
  `chat`, `chatStream`, `chatStreamEvents`, `jsonChat`, `listModels`, and
  `ensureModelLoaded`. `isConfigured()` reports whether a key is present.
  `createModelPicker()` builds the shared per-app model selector (gateway model list,
  persisted choice); calls without an explicit `model` use the picked model, then the
  build-time default.
- Each app keeps the historical `puter.js` / `cloud.js` adapter name so call sites did
  not need to move. Those adapters now delegate to `@fusion-office/storage` and
  `@fusion-office/ai-client`. Do not reintroduce Puter globals.
- Test-only compatibility: documents and spreadsheet use a stubbed `globalThis.puter`
  when `import.meta.env.MODE === 'test'`. Production code paths never touch it.
- Vite uses a relative `base` in every app so the same build runs standalone and behind
  the gateway's `/shell/<id>/` prefix.

### AI integration points

Documents, PDF, and PM assistants run the shared agent loop in
`packages/ai-client/src/agent.js` (`createAgent`): it streams, executes the tool calls,
feeds results back, and asks before destructive steps. Each app owns its tool schemas
and runner in a `*-tools` module; keep the two in step.

- Documents: the assistant pane (`src/views/assistant-pane.js`) drives
  `src/lib/assistant-tools.js` over the canvas engine: read, find, insert, replace the
  selection (asks approval), format, insert a table or page break, add a link. Each tool
  call is one undo step. `src/lib/puter.js` also carries the language tools, grammar
  checks, smart lookup, and drawing through `aiChat`; `assistantPrompt` /
  `readReply` in `src/lib/assistant.js` remain for those JSON-shaped calls.
- Spreadsheet: `src/lib/puter.js` `aiChat` / `aiChatStream`; used by the AI dialog,
  AI panel, translation, thesaurus, and `AI`/`TRANSLATE`/`DETECTLANGUAGE` sheet functions.
- Presentation: `src/cloud.js` `aiChat` and `aiChatStream` (tool-event stream); used by
  prompt-to-deck, the assistant panel, and slide review.
- PDF: `src/ai-panel.js` is an assistant over the open file, backed by
  `src/ai-tools.js` and the command closure in `src/editor.js` (`info`, `readPages`,
  `find`, `goTo`, `zoom`, `bookmark`). It reads at most 20 pages per call; scanned
  documents require OCR first.
- PM: `src/ui/assistant.js` opens the project assistant over `src/lib/ai-tools.js` and
  the store (tasks, columns, checklist items, comments; delete asks approval).
  `src/ui/checklist.js` still calls `AI.jsonChat` for task breakdown.

When changing a prompt, a tool schema, or its runner, update the matching unit test.
Tests mock `@fusion-office/ai-client`; live verification is separate in
`scripts/verify-ai.mjs`.

### Union shell

Each app has `web/manifest.json` with id `fusion-office-<app>`, path `/office/<app>`,
and entry `/shell/fusion-office-<app>/`. All five carry `group` `fusion-office` with
`group_title` `Fusion Office` and `sort` 1 to 5, so schema-v2 shells show one grouped
menu; ids, paths, and entries stay unchanged. `scripts/shell-serve.mjs` serves each `dist`
on fixed ports 11485-11489 (registered in `architecture/port-registry.yaml`; entry
`fusion-office` is the supervised one, the other four are `supervise: false`), registers
manifests through the gateway admin API, heartbeats, and unregisters on exit. `start.sh`
wraps it for fusion-supervisor: `fusion-sv up fusion-office` starts and crash-restarts
it; the admin key resolves from the environment, `.env.local`, or the gateway config's
`web_shell.admin_key`. The gateway proxies `/shell/<id>/` and requires a signed shell
session, not an API key.

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
