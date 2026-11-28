# @fusion-office/ai-client

LLM client for Fusion Office apps: OpenAI-compatible calls to the local
[fusion-gateway](https://github.com/dahai80/fusion-gateway) with streaming,
tool-call events, JSON mode, model management, a shared agent loop, and
rollout-tap outcome reporting. No cloud traffic — the gateway is the only AI
entry point.

## Install

```bash
npm install @fusion-office/ai-client
```

**Consumption path (decision, issue #65):** the package is published to npm
as a public scoped package. Version bumps land with fusion-office releases;
consumers (first: fusion-doc, fusion-doc#90) pin the registry version. A git
dependency was rejected because the package lives in a workspace subdirectory
(`packages/ai-client`), which npm git deps do not resolve; a workspace link
only works inside this monorepo.

## Gateway contract

- Base URL: `http://127.0.0.1:11432` by default. In Vite dev mode the client
  uses the same-origin `/__fusion_gateway` proxy (the gateway's CORS
  allowlist does not cover arbitrary localhost ports); behind the union shell
  the page origin is the gateway itself, so requests are relative.
- Auth: `Authorization: Bearer <VITE_FUSION_GATEWAY_KEY>` outside the shell.
  Inside a signed shell session (`/shell/` pathname) no Authorization header
  is sent — the HttpOnly session cookie authenticates.
- Chat endpoints: OpenAI-compatible `/v1/chat/completions` (streaming via
  SSE, tools supported) and `/v1/models`.

## Configuration (build-time env, Vite `VITE_*`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_FUSION_GATEWAY_URL` | `http://127.0.0.1:11432` | Gateway base URL |
| `VITE_FUSION_GATEWAY_KEY` | — | Static gateway key (never the admin key) |
| `VITE_FUSION_MODEL` | `mlx-community/Qwen3.8-27B-8bit` | Fallback model id |
| `VITE_FUSION_MAX_INPUT_CHARS` | `4000` | Per-message input cap |
| `VITE_FUSION_SHELL_PORTS` | — | Extra fixed ports treated as shell-served (comma-separated) |
| `VITE_FUSION_CUSTOMER_MODE` | — | `1` suppresses the model picker entirely |

## API surface

- `chat(opts)` — one completion, JSON in / JSON out.
- `chatStream(opts, onDelta)` — streaming text deltas.
- `chatStreamEvents(opts)` — async iterator of `{ type: 'text', text }` and
  `{ type: 'tool', id, name, input }` events; falls back to one non-streaming
  request when the relay drops tool-call deltas.
- `jsonChat(opts, retries)` — JSON-mode chat with parse retries.
- `listModels()`, `ensureModelLoaded(modelId)` — gateway model plane.
- `isConfigured()`, `configure(overrides)`, `getConfig()`.
- `createModelPicker(options)` — shared per-app model selector (gateway
  model list, persisted choice, policy allowlist clamping).
- `createAgent(...)` — the shared tool-calling agent loop: streams, executes
  tools, asks before destructive steps, reports outcomes. See
  `src/agent.js` and the office apps' `*-tools` modules for schemas.
- `createOutcomeReporter({ app, endpoint, taskId, contentMode })` —
  fire-and-forget rollout-tap outcome records (schema v1, optional
  `outcome.task_id`) to office-api's `POST /v1/outcomes`
  (default endpoint `http://127.0.0.1:11492/v1/outcomes`).
- `resolvedModel` chain: explicit `opts.model`, per-app picker
  (`fusion-office.ai-model` localStorage), shell handoff
  (`fusion.shell.model`), gateway model policy (`/api/v1/shell/model-policy`,
  fail-closed inside the shell), then the build-time default.

Model resolution and policy behavior are fail-closed inside a shell session:
a policy that cannot be read, or one with an empty allowlist, offers no model
at all. The gateway remains the enforcement point for explicit models.

## License

MIT. Part of the [Fusion Office](https://github.com/dahai80/fusion-office)
monorepo (`packages/ai-client`); root tooling and storage live there.
