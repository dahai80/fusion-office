# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Fusion Office is the local-first office suite of the Fusion monorepo. Five browser apps
(documents, spreadsheet, presentation, pdf, pm) run as static Vite builds, store real
files through the browser's File System Access API or OPFS, and call a local model only
through `fusion-gateway` on `127.0.0.1:11432`.

The code is migrated from HeyPuter/everything. Documents, presentation, pdf, and pm are
MIT. Spreadsheet is AGPL-3.0-only and the root MIT license does not cover it.

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
npm run shell:smoke               # register, request each module, unregister, exit
```

`verify:ai` needs `FUSION_GATEWAY_KEY`. `shell:serve` needs
`FUSION_GATEWAY_ADMIN_KEY`. `shell:smoke` additionally needs
`FUSION_GATEWAY_MASTER_KEY`, which is used only to derive a short-lived shell session
secret. Never hardcode or commit these values.

Browser suites exist in documents, presentation, and pdf:

```bash
npx playwright install
npm run test:browser -w apps/documents
npm run test:e2e -w apps/presentation
npm run test:e2e -w apps/pdf
```

## Architecture

npm workspaces: `apps/*` and `packages/*`.

- `packages/storage` owns local files. It resolves a writable root once per session:
  File System Access API directory picker first, OPFS fallback, IndexedDB as a
  best-effort listing index. Exports include `readFile`, `writeFile`, `readdir`,
  `deleteFile`, and KV helpers (`get`, `set`, `del`). Files remain real documents, not
  rows in a database.
- `packages/ai-client` owns model access. It defaults to
  `http://127.0.0.1:11432`, reads `VITE_FUSION_GATEWAY_URL`,
  `VITE_FUSION_GATEWAY_KEY`, and `VITE_FUSION_MODEL` at build time, and exposes
  `chat`, `chatStream`, `chatStreamEvents`, `jsonChat`, `listModels`, and
  `ensureModelLoaded`. `isConfigured()` reports whether a key is present.
- Each app keeps the historical `puter.js` / `cloud.js` adapter name so call sites did
  not need to move. Those adapters now delegate to `@fusion-office/storage` and
  `@fusion-office/ai-client`. Do not reintroduce Puter globals.
- Test-only compatibility: documents and spreadsheet use a stubbed `globalThis.puter`
  when `import.meta.env.MODE === 'test'`. Production code paths never touch it.
- Vite uses a relative `base` in every app so the same build runs standalone and behind
  the gateway's `/shell/<id>/` prefix.

### AI integration points

- Documents: `src/lib/puter.js` `aiChat` wraps `AI.chat`; used by the assistant pane,
  language tools, grammar checks, smart lookup, and drawing.
- Spreadsheet: `src/lib/puter.js` `aiChat` / `aiChatStream`; used by the AI dialog,
  AI panel, translation, thesaurus, and `AI`/`TRANSLATE`/`DETECTLANGUAGE` sheet functions.
- Presentation: `src/cloud.js` `aiChat` and `aiChatStream` (tool-event stream); used by
  prompt-to-deck, the assistant panel, and slide review.
- PDF: `src/ai-panel.js` streams answers from extracted page text in the Ask AI sidebar
  tab. Extracted text is capped; scanned documents require OCR first.
- PM: `src/ui/checklist.js` calls `AI.jsonChat` to turn a task into checklist items.

When changing a prompt or its parsing, update the matching unit test. Tests mock
`@fusion-office/ai-client`; live verification is separate in `scripts/verify-ai.mjs`.

### Union shell

Each app has `web/manifest.json` with id `fusion-office-<app>`, path `/office/<app>`,
and entry `/shell/fusion-office-<app>/`. `scripts/shell-serve.mjs` serves each `dist`
on an ephemeral port, registers manifests through the gateway admin API, heartbeats,
and unregisters on exit. The gateway proxies `/shell/<id>/` and requires a signed shell
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

- Root `LICENSE` is MIT and covers first-party code plus the MIT-derived apps.
- `apps/spreadsheet/LICENSE` is AGPL-3.0-only. Do not relicense it, remove notices, or
  publish the repository publicly without an explicit licensing decision.
