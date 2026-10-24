# fusion-office API

Document-capability HTTP service for fusion-office. It exposes two operations
from [issue #1](https://github.com/dahai80/fusion-office/issues/1) and nothing
else: business rules, extraction orchestration and permit templates stay in the
consuming application (`dahai80/envipermit` is the first consumer).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Liveness, returns the service version |
| GET | `/readyz` | Readiness |
| POST | `/v1/xlsx/parse` | Multipart `file` (.xlsx) → sheets, tables, merged cells, unparsed regions |
| POST | `/v1/docx/fill` | Multipart `file` (.docx) + `values` JSON → filled .docx |

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
- Files over `OFFICE_API_MAX_BYTES` (default 100 MB) get `413`. Malformed input
  gets `422` with FastAPI's `{"detail": ...}` shape. The uploaded template is
  never modified.
- `/v1/docx/snapshot` is deferred to v0.2; consumers ship preview-less.

## Run

```bash
cd /Users/dahai/fusion
source .venv/bin/activate
cd fusion-office/services/office-api
pip install -e ".[test]"

./start.sh start          # 127.0.0.1:11520, log in dev/office-api.log
./start.sh status
./start.sh stop

python -m pytest tests -q
```

Environment:

- `OFFICE_API_PORT` (default `11520`)
- `OFFICE_API_MAX_BYTES` (default `104857600`)
- `OFFICE_API_LOG_LEVEL` (default `INFO`)

The service binds to the loopback interface only. It makes no outbound calls.

## Licensing

MIT, same as the rest of fusion-office except `apps/spreadsheet` (AGPL-3.0-only).
