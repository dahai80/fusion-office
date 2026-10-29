# Fusion Office

Local-first office suite for the Fusion ecosystem. Five browser applications share one
storage layer and one AI client, run entirely on your machine, and mount into the Fusion
union web shell through `fusion-gateway`.

## What is included

| App | Purpose | Source |
| --- | --- | --- |
| `apps/documents` | Word processor with `.docx` open/save, track changes, comments, spellcheck | MIT, migrated from HeyPuter/everything |
| `apps/spreadsheet` | Spreadsheet with formulas, charts, pivot tables, `.xlsx` | AGPL-3.0-only, migrated from HeyPuter/everything |
| `apps/presentation` | Slide editor with `.pptx` support and AI deck generation | MIT, migrated from HeyPuter/everything |
| `apps/pdf` | PDF viewer, annotation, form filling, OCR, AI assistant | MIT, migrated from HeyPuter/everything |
| `apps/pm` | Local project management with tasks, boards, timeline | MIT, migrated from HeyPuter/everything |
| `packages/storage` | Local-first file storage: File System Access API, OPFS fallback, IndexedDB index | First-party |
| `packages/ai-client` | OpenAI-compatible client for `fusion-gateway` with streaming, tools, JSON helpers, and the shared agent loop | First-party |

Every application runs as a static Vite build. There is no server component, no account
system, and no cloud dependency. Files live in a folder you pick or in the browser's
origin-private file system.

## Architecture

```text
apps/documents  apps/spreadsheet  apps/presentation  apps/pdf  apps/pm
        |                |                |             |         |
        +----------------+----------------+-------------+---------+
                                   |
                         packages/storage   packages/ai-client
                                   |                |
                        FSA / OPFS / IndexedDB     |
                                                   |
                                          fusion-gateway :11432
                                                   |
                                            fusion-mlx :11434
```

- Each app is an independent Vite entry point. Vite uses a relative `base`, so the same
  build works standalone and behind the gateway's `/shell/<id>/` prefix.
- `packages/storage` resolves a writable root once per session: the File System Access
  API directory picker when available, otherwise OPFS. A dismissed picker, or a browser
  that aborts it without a user gesture, falls back to OPFS so the app keeps working. A
  best-effort IndexedDB index tracks path, size, and modification time for listings.
- `packages/ai-client` is the only path to a model. It calls an OpenAI-compatible
  `/v1/chat/completions` endpoint, defaults to `http://127.0.0.1:11432`, and never
  embeds model logic. `createAgent` in the same package runs the tool loop shared by the
  documents, PDF, and project assistants.
- AI traffic is gated by the gateway API key. Browser builds read the key at build time
  from `VITE_FUSION_GATEWAY_KEY`. PDF and project AI surfaces check `isConfigured()` and
  explain what is missing before sending anything; the other apps surface the gateway's
  error in their own UI.

## Requirements

- Node.js 22.18 or newer and npm 10 or newer.
- A modern Chromium-based browser for the File System Access API. Safari and Firefox
  fall back to OPFS.
- Optional: `fusion-gateway` on `127.0.0.1:11432` with a loaded chat model, for AI
  features.

## Quick start

```bash
npm install
npm run build
npm run dev:documents
```

Swap `dev:documents` for `dev:spreadsheet`, `dev:presentation`, `dev:pdf`, or `dev:pm`.
Each dev server prints its own URL. Data stays in the browser profile used to open it.

To place a production build behind the union shell, see [Union shell integration](#union-shell-integration).

## AI through fusion-gateway

AI calls use the shared `@fusion-office/ai-client` package. Configure it with environment
variables before starting a dev server or build:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_FUSION_GATEWAY_URL` | `http://127.0.0.1:11432` | Gateway base URL |
| `VITE_FUSION_GATEWAY_KEY` | empty | API key sent as `Authorization: Bearer` |
| `VITE_FUSION_MODEL` | `mlx-community/Qwen3.5-9B-4bit` | Default chat model |

Copy `.env.example` to `.env.local` in the app directory (or export the variables in the
shell) and put a gateway API key in `VITE_FUSION_GATEWAY_KEY`. Keys are compiled into the
browser bundle, so use a scoped key, never the master key, and never commit `.env.local`.

During `npm run dev`, `@fusion-office/ai-client` talks to `/__fusion_gateway` on the app's
own origin, and each Vite config proxies that prefix to the gateway
(`dev/gateway-proxy.mjs`). The gateway's CORS allowlist does not include arbitrary dev
ports, so a direct cross-origin call would fail the preflight and surface as
`Failed to fetch`. Production builds still call `VITE_FUSION_GATEWAY_URL` directly.

### Choosing a model

Each assistant panel shows a model picker that lists the models the gateway offers
(`GET /v1/models`, loaded models first). Picking one stores it per app and every call
that does not name a model uses it; the choice survives a reload. Which models appear —
and which each API key may use — is decided on the gateway side (`allowed_models` per
key, backend routing in `fusion-gateway`), not in this repository. Without a gateway key
the picker is absent and `VITE_FUSION_MODEL` applies.

AI surfaces by app:

- Documents: an assistant pane that works the open document through tools: read it, find
  text, insert or replace text, format a selection, insert a table or a page break, and
  add a link. Replacing the selection asks before it runs, and every change is a single
  undo step. Grammar checks, translation, smart lookup, and image prompts remain.
- Spreadsheet: formula generation and explanation, data questions, translation, and
  sheet functions such as `AI` and `TRANSLATE`.
- Presentation: prompt-to-deck generation, assistant panel, and slide review.
- PDF: the **Ask AI** sidebar tab is an assistant over the open file. It reads pages and
  finds text through tools, moves to a page, changes the zoom, and adds a bookmark (the
  one change, undoable). Scanned documents need OCR first.
- Projects: a project assistant in the board header reads the project and changes it:
  create, update, move, archive and delete tasks, add checklist items and comments, and
  add columns. Deleting a task asks before it runs. **Break down with AI** on a task
  still turns it into a checklist through a JSON reply.

The three agentic surfaces share the loop in `packages/ai-client/src/agent.js`: it sends
the conversation with the tool schemas, runs the calls the model asks for, feeds the
results back, and stops after a bounded number of rounds. Each app owns its tools, which
describe themselves for the step list and declare which calls change the file.

Verify end-to-end connectivity with a real loaded model:

```bash
FUSION_GATEWAY_KEY=<scoped-key> node scripts/verify-ai.mjs
```

The script checks model registration, plain chat, streaming chat, tool-event streaming,
the PDF and project JSON paths, and the real adapter paths in documents, spreadsheet,
presentation, and the PDF assistant panel. It uses jsdom only to load those browser
modules and exits non-zero if any step fails.

## Union shell integration

Each app ships `web/manifest.json` and registers with `fusion-gateway` at
`POST /api/v1/shell/manifests`. The gateway proxies `/shell/<id>/` to the app's upstream
static server and requires a shell session token, not an API key.

The five manifests share `"group": "fusion-office"` with `group_title` `Fusion Office`,
so the union shell renders one top-level menu with Documents, Spreadsheet, Presentation,
PDF, and Projects beneath it in `sort` order 1 to 5. Module ids, paths, and entries stay
unchanged wire contracts. The grouped menu appears in shells that support manifest schema
v2 (`group`); older shells still list the modules flat.

`scripts/shell-serve.mjs` starts a static server per built app on fixed ports
11485-11489 (registered in `architecture/port-registry.yaml`), registers all five
manifests, heartbeats them, and unregisters on exit. `start.sh` wraps it with the
fusion-supervisor lifecycle contract and resolves the admin key from the
environment, `.env.local`, or the gateway config:

```bash
./start.sh start | stop | restart | status | log
```

Before serving, `start` verifies its `fusion-office` entry exists in
`architecture/port-registry.yaml` (register-then-start self-check) and refuses an
unregistered port. `FUSION_REGISTRY` points at another registry copy,
`FUSION_SKIP_REGISTRY_CHECK=1` bypasses the check, and a missing registry file only
warns (standalone deployments).

Run directly (same fixed ports):

```bash
FUSION_ADMIN_KEY=<admin-key> node scripts/shell-serve.mjs
```

With fusion-supervisor running, `fusion-sv up fusion-office` starts and supervises
it: crash auto-restart, health history, and the web console. `fusion-sv down
fusion-office` stops it.

For a one-shot route check, add `--smoke` and provide the master key used to derive the
shell session secret:

```bash
FUSION_ADMIN_KEY=<admin-key> \
FUSION_GATEWAY_MASTER_KEY=<master-key> \
node scripts/shell-serve.mjs --smoke
```

The smoke run registers each module, requests `/shell/fusion-office-<app>/` with a minted
short-lived session, verifies the HTML app root and one hashed asset, then unregisters
everything and exits. Both keys stay in environment variables and are never written to
the repository.

## Build and test

```bash
npm run build            # build all five apps sequentially
npm test                 # run all five vitest suites sequentially
npm run build -w apps/pdf
npm test -w apps/pdf
npm test -w apps/pdf -- tests/ai-panel.test.js
```

`npm install` runs `patch-package` for the presentation app and links shared test
dependencies. Browser end-to-end suites exist in all five apps and require Playwright
browsers:

```bash
npx playwright install
npm run test:browser -w apps/documents
npm run test:browser -w apps/spreadsheet
npm run test:e2e -w apps/presentation
npm run test:e2e -w apps/pdf
npm run test:browser -w apps/pm
```

Documents, spreadsheet, and pm use `PLAYWRIGHT_PORT` (defaults 5189, 5190, 5191) and
launch the installed Chrome unless `PLAYWRIGHT_CHANNEL=chromium` selects Playwright's
bundled build.

Each app has an `assistant-tools` browser spec that drives every AI assistant tool
through the real UI. The specs answer the model's requests from a mocked gateway in the
page, so they need no API key, gateway, or loaded model. Documents uses its dev mock;
the other apps route the gateway's completion endpoint to a scripted event stream.

The document-capability service has its own Python suite:

```bash
cd services/office-api
python -m pytest tests -q
./start.sh start          # 127.0.0.1:11492
./start.sh stop
```

## Document-capability service

`services/office-api` is a small FastAPI service that exposes file operations to
other Fusion projects (first consumer: `dahai80/envipermit`). It implements the
contract in issue #1:

- `POST /v1/xlsx/parse` — multipart `file`; returns sheets, tables, flattened merged
  cells, and `unparsed_regions` for blocks whose header cannot be inferred.
- `POST /v1/docx/fill` — multipart `file` plus a `values` JSON object; fills
  `{{placeholder}}` markers in paragraphs, table cells, headers and footers and returns
  the filled binary with `X-Office-Doc-SHA256` and `X-Office-Unfilled`.
- `GET /healthz`, `GET /readyz`.
- Uploads over 100 MB return `413`; malformed input returns `422`. The service binds to
  loopback only and makes no outbound calls. `/v1/docx/snapshot` is deferred to v0.2.

See `services/office-api/README.md`.

## Project layout

```text
apps/<app>/src        application code
apps/<app>/tests      vitest suites
apps/<app>/web        shell manifest
apps/<app>/dist       production build output (ignored)
packages/ai-client    gateway client
packages/storage      local-first storage
scripts/              build, test, AI verification, shell serving
dev/                  local development helpers and verification logs
```

## Configuration

| File | Purpose |
| --- | --- |
| `.env.example` | Template for gateway URL, key, and model |
| `.env.local` | Local overrides, ignored by git |
| `apps/<app>/web/manifest.json` | Module identity used by the union shell |

Applications have no runtime configuration endpoint. Values are read from `import.meta.env`
at build time and from the browser environment at runtime.

## Storage model

- The first write prompts for a workspace directory through the File System Access API.
  The handle is remembered for the session.
- When the directory picker is unavailable, dismissed by the user, or aborted by the
  browser without a user gesture, storage falls back to OPFS under the page origin.
- File contents are real `.docx`, `.xlsx`, `.pptx`, `.pdf`, JSON, and image files. Nothing
  is stored in a proprietary database.
- An IndexedDB store keeps a best-effort path/size/time index for listings. Loss of the
  index does not lose files.
- Tests use a stub `globalThis.puter` object only when `import.meta.env.MODE === 'test'`.
  Production builds never touch that global.

## Licenses and provenance

- `packages/storage`, `packages/ai-client`, `services/office-api`, and the root tooling:
  Apache-2.0, first-party. See `LICENSE`.
- `apps/documents`, `apps/presentation`, `apps/pdf`, and `apps/pm`: MIT, migrated from
  [HeyPuter/everything](https://github.com/HeyPuter/everything). See the `LICENSE` file
  in each app directory.
- `apps/spreadsheet`: AGPL-3.0-only, migrated from HeyPuter/everything. See
  `apps/spreadsheet/LICENSE`. The root Apache license does not cover this app.
  Distributing a combined binary or hosted service that includes it triggers AGPL
  obligations for that app.

Upstream fixes belong upstream; report them to HeyPuter/everything instead of patching a
divergent copy here.

## Status

Milestones M0 through M5 of the migration plan are implemented: workspace setup, storage
extraction, AI client, per-app AI integration, and union-shell manifests. The suite runs
offline except for live AI verification, which requires a local gateway and a loaded model.
