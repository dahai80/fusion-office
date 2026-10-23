# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

New project — no code yet. This file contains only verified monorepo context. Replace placeholders once code exists.

## What This Project Is

<!-- Fill in: purpose, tech stack, relation to other fusion-* projects. -->

## Monorepo Context (verified)

`fusion-office/` is one of the `fusion-*` sub-projects in the Fusion monorepo (`/Users/dahai/fusion`). Rules from the root `/Users/dahai/fusion/CLAUDE.md` apply here.

- No root `.git`. Each `fusion-*` sub-project is its own independent git repository — commit, branch, PR inside this directory, never at the repo root.
- Shared `.venv/` at the repo root. Before any Python work:

```bash
cd /Users/dahai/fusion
source .venv/bin/activate
```

- Python version pinned repo-wide via `.python-version` (3.12). Rebuild with `scripts/sync-deps.sh --rebuild-venv`.

## If This Is a Python Project (monorepo conventions)

- Build: `pip install -e ".[test]"` — install `fusion-core` first (`pip install -e fusion-core`); most projects depend on it (LLM client / JSON parse / config / logging / FastAPI factory).
- Test: `pytest tests/` (projects configure `asyncio_mode=auto` + `testpaths=["tests"]`).
- Single test: `pytest tests/test_foo.py::test_bar -v`
- Lint: `ruff check .` / `ruff format .` — add `[tool.ruff]` to pyproject.toml.
- setuptools backend with `[tool.setuptools.packages.find]`.
- Domain apps use MLXClient dependency injection and `_parse_json()` for LLM output parsing.
- LLM inference goes through HTTP to `fusion-mlx` (`localhost:11434`) or via `fusion-gateway` (`:11432`) — never embed model logic.
- If the project runs a service: add its `start.sh`, and register any port in `architecture/port-registry.yaml` (CI fails on unregistered/duplicate ports). Run `python scripts/check-ports.py` after editing.
- Model downloads via mirror `https://hf-mirror.com`; cache at `~/.fusion-mlx/models`.
- Code style: 4-space multiples indentation, no docstrings, always include logging.

## README Conventions

README.md in English only; README_CN.md for Chinese. GitHub operations in English.

## Update This File When

- First code lands: fill "What This Project Is", add real build/test/lint commands, document architecture.
