---
doc_id: fusion-office/changelog
product: fusion-office
class: app
entry: guided-ui
doc_type: changelog
title: { zh: "变更日志", en: "Changelog" }
audience: end-user
status: draft
version: 0.1.0
updated: 2026-11-07
owner: @dahai
source_of_truth:
  - CHANGELOG.md
---

# Changelog

All notable changes to fusion-office are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Adopted the fusion docs-system v1.0 contract (P1 pilot, grid position app x guided-ui):
  `docs/product-page.md`, `docs/get-started.md` (with real screenshots from the running
  documents app), `docs/troubleshooting.md`, and CI validation via `ci/validate_docs.py`
  gating markdown PRs.

## [0.1.0]

### Added
- Five local-first browser apps: documents, spreadsheet, presentation, pdf, pm
  (migrated from HeyPuter/everything per README sourcing table).
- Shared `packages/storage`: File System Access API primary, OPFS fallback,
  IndexedDB index.
- Shared `packages/ai-client`: OpenAI-compatible client for fusion-gateway with
  streaming, tools, JSON helpers, and the shared agent loop.
- Fail-closed model policy handling: with no tenant allowlist the model picker
  is hidden and no model may be used (gateway-enforced, client fail-closed).
- `start.sh` lifecycle: registers ports 11485-11489 then serves the five built
  apps, with register-then-start self-check.
