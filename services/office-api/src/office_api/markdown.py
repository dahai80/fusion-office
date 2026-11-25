# Markdown block model shared by the document write endpoints (#35, #36).
# The shape mirrors fusion-artifacts-engine's office_ingest._blocks: headings,
# paragraphs, and pipe tables — so consumers can round-trip patched markdown
# through office-api instead of carrying python-pptx/python-docx in-process.

from __future__ import annotations

import logging
import re
from io import BytesIO
from typing import Any

from docx import Document

log = logging.getLogger(__name__)

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
TABLE_ROW_RE = re.compile(r"^\|.*\|$")


def parse_blocks(content: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []
    table: list[list[str]] = []

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append({"kind": "para", "text": " ".join(paragraph)})
            paragraph.clear()

    def flush_table() -> None:
        if table:
            blocks.append({"kind": "table", "rows": [row[:] for row in table]})
            table.clear()

    for line in content.split("\n"):
        stripped = line.strip()
        heading = HEADING_RE.match(stripped)
        if heading:
            flush_paragraph()
            flush_table()
            blocks.append(
                {"kind": "heading", "level": len(heading.group(1)), "text": heading.group(2)}
            )
        elif TABLE_ROW_RE.match(stripped) and "---" in stripped:
            flush_paragraph()
        elif TABLE_ROW_RE.match(stripped):
            flush_paragraph()
            # Split on unescaped pipes only, so "\|" stays inside a cell
            # (plain split("|") would break the cell apart before unescaping).
            cells = [
                cell.replace("\\|", "|").strip()
                for cell in re.split(r"(?<!\\)\|", stripped.strip("|"))
            ]
            table.append(cells)
        elif stripped:
            flush_table()
            paragraph.append(stripped)
        else:
            flush_paragraph()
            flush_table()
    flush_paragraph()
    flush_table()
    log.info("parsed markdown: %d blocks", len(blocks))
    return blocks


def _fill_table(table: Any, rows: list[list[str]]) -> None:
    columns = max(len(row) for row in rows)
    for row_index, row in enumerate(rows):
        for column_index in range(columns):
            table.cell(row_index, column_index).text = (
                row[column_index] if column_index < len(row) else ""
            )


def write_docx_from_markdown(content: str) -> bytes:
    document = Document()
    for block in parse_blocks(content):
        if block["kind"] == "heading":
            # Markdown level N maps to the Heading N style directly (Title is
            # not used), so parse -> write -> parse round-trips levels exactly.
            document.add_heading(block["text"], level=block["level"])
        elif block["kind"] == "para":
            document.add_paragraph(block["text"])
        else:
            rows = block["rows"]
            table = document.add_table(rows=len(rows), cols=max(len(row) for row in rows))
            _fill_table(table, rows)
    output = BytesIO()
    document.save(output)
    written = output.getvalue()
    log.info("wrote docx from markdown: %d bytes out", len(written))
    return written
