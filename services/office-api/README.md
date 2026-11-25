# fusion-office API

Document-capability HTTP service for fusion-office. It exposes the operations
from [issue #1](https://github.com/dahai80/fusion-office/issues/1) plus the pptx
leg from [issue #32](https://github.com/dahai80/fusion-office/issues/32) and
nothing else: business rules, extraction orchestration and permit templates stay
in the consuming application (`dahai80/envipermit` is the first consumer).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Liveness, returns the service version |
| GET | `/readyz` | Readiness |
| POST | `/v1/xlsx/parse` | Multipart `file` (.xlsx) → sheets, tables, merged cells, unparsed regions |
| POST | `/v1/docx/fill` | Multipart `file` (.docx) + `values` JSON → filled .docx |
| POST | `/v1/pptx/parse` | Multipart `file` (.pptx) → slides with title, body lines, speaker notes |
| POST | `/v1/pptx/write` | Optional multipart `file` (.pptx) + `slides` JSON → updated .pptx |

Responses:

- `/v1/xlsx/parse` returns
  `{"sheets": [{"name", "tables": [{"header_row", "headers", "rows", "merged_cells", "range"}], "unparsed_regions"}]}`.
  Tables are rectangular blocks split by fully empty rows and columns. Merged
  cells are flattened (every cell carries the anchor value). A block whose first
  row cannot serve as a unique, non-empty header lands in `unparsed_regions`
  instead of being guessed.
- `/v1/docx/fill` returns the filled binary with `X-Office-Doc-SHA256`
  (hex SHA-256 of the body) and, when a placeholder had no value,
  `X-Office-Unfilled` (comma-separated names). Unknown placeholders become an
  empty string. Placeholders are `{{name}}` in paragraphs, table cells, headers
  and footers, including markers split across Word runs.
- `/v1/pptx/parse` returns
  `{"slides": [{"index", "title", "body", "notes"}]}` with 1-based `index`,
  `body` as text lines in reading order (grouped shapes recursed one level,
  the title shape excluded), and speaker notes as `notes`. The content matches
  what fusion-rag's PPTX extraction produces, in structured form.
- `/v1/pptx/write` takes a `slides` JSON array where each entry is
  `{index?, title?, body?, notes?}`: with `index` (1-based) it modifies that
  slide in place (rewrites the title placeholder, clears and refills the first
  body placeholder or adds a textbox, sets the notes); without `index` it
  appends a new slide on a title+content layout. Omitted fields are left
  untouched; an empty `body` clears the text. Masters and layouts are
  preserved. Without a `file` part it creates a new deck. The response is the
  updated binary with `X-Office-Doc-SHA256`.
- Files over `FUSION_OFFICE_API_MAX_BYTES` (default 100 MB) get `413`. Malformed input
  gets `422` with FastAPI's `{"detail": ...}` shape. The uploaded template is
  never modified.
- `/v1/docx/snapshot` is deferred to v0.2; consumers ship preview-less.
- `/v1/pptx/*` round-trip is contract-tested: parse a deck, modify it, reparse
  and reopen it with python-pptx (`tests/test_pptx.py`).

## Run

```bash
cd /Users/dahai/fusion
source .venv/bin/activate
cd fusion-office/services/office-api
pip install -e ".[test]"

./start.sh start          # 127.0.0.1:11492, log in dev/office-api.log
./start.sh status
./start.sh stop

python -m pytest tests -q
```

Environment (resolved through `fusion_core.config`, per `architecture/config-conventions.md`):

- `FUSION_OFFICE_API_PORT` (default `11492`, registered as `fusion-office-api` in `architecture/port-registry.yaml`)
- `FUSION_OFFICE_API_MAX_BYTES` (default `104857600`)
- `FUSION_OFFICE_API_LOG_LEVEL` (default `INFO`)

The service binds to the loopback interface only. It makes no outbound calls.
The process titles itself `fusion-office-api serve :<port>` via `setproctitle`.

## Licensing

Apache-2.0, like the rest of the first-party code in fusion-office. The apps under
`apps/` keep their own licenses (`apps/spreadsheet` is AGPL-3.0-only).
