# Artifact envelope (issue #53): the cloud artifact index consumes
# `response.artifact` (kind/name/size/sha256/preview) instead of raw bytes.
# Raw-byte responses stay the default; the envelope is only produced when a
# request explicitly carries artifact_mode="index+preview".

from __future__ import annotations

import hashlib
import logging
from typing import Any

log = logging.getLogger(__name__)

ENVELOPE_MODE = "index+preview"
PREVIEW_CHARS = 500


def wants_envelope(artifact_mode: str | None) -> bool:
    return (artifact_mode or "").strip() == ENVELOPE_MODE


def _preview_text(text: str) -> dict[str, str]:
    content = " ".join(text.split())[:PREVIEW_CHARS]
    return {"type": "text", "content": content}


def artifact_block(kind: str, name: str, content: bytes, preview: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "name": name,
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "preview": _preview_text(preview),
    }


def envelope(kind: str, name: str, content: bytes, preview: str) -> dict[str, Any]:
    return {"ok": True, "artifact": artifact_block(kind, name, content, preview)}


def docx_preview_text(parsed: dict[str, Any]) -> str:
    parts: list[str] = []
    for block in parsed.get("blocks", []):
        if block.get("kind") == "table":
            for row in block.get("rows", []):
                parts.extend(str(cell) for cell in row)
        else:
            parts.append(str(block.get("text", "")))
    return "\n".join(part for part in parts if part)


def pptx_preview_text(parsed: dict[str, Any]) -> str:
    parts: list[str] = []
    for slide in parsed.get("slides", []):
        parts.append(str(slide.get("title", "")))
        parts.extend(str(line) for line in slide.get("body", []))
        if slide.get("notes"):
            parts.append(str(slide["notes"]))
    return "\n".join(part for part in parts if part)


def xlsx_preview_text(parsed: dict[str, Any]) -> str:
    parts: list[str] = []
    for sheet in parsed.get("sheets", []):
        for table in sheet.get("tables", []):
            parts.append(" | ".join(str(header) for header in table.get("headers", [])))
            for row in table.get("rows", [])[:3]:
                parts.append(" | ".join("" if cell is None else str(cell) for cell in row))
    return "\n".join(part for part in parts if part)
