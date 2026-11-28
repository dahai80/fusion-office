# HTTP surface for the fusion-office capability service. Contract:
# https://github.com/dahai80/fusion-office/issues/1. Business logic stays in
# the consuming application.

from __future__ import annotations

import hashlib
import json
import logging
import re
import zipfile
from pathlib import Path
from typing import Annotated

import uvicorn
from docx.opc.exceptions import PackageNotFoundError
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fusion_core.config import get_env, service_port
from openpyxl.utils.exceptions import InvalidFileException
from pptx.exc import PackageNotFoundError as PptxPackageNotFoundError

from . import __version__
from .artifact import (
    artifact_block,
    docx_preview_text,
    envelope,
    pptx_preview_text,
    wants_envelope,
    xlsx_preview_text,
)
from .docx import fill_document, parse_document
from .graph import derive_graph
from .markdown import parse_blocks, write_docx_from_markdown
from .outcomes import append_record, default_sink, grep_sink, validate_record
from .pptx import parse_deck, write_deck, write_deck_from_markdown
from .xlsx import parse_workbook, sketch_workbook

logging.basicConfig(
    level=get_env("FUSION_OFFICE_API_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("office_api")

MAX_BYTES = get_env("FUSION_OFFICE_API_MAX_BYTES", 100 * 1024 * 1024, cast=int)
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

app = FastAPI(title="fusion-office", version=__version__)

# The outcome endpoint (#33) is called from the browser apps, which run on
# other loopback ports (5189-5191 in dev, 11485-11489 in the shell). Loopback
# origins only; the service itself still binds to 127.0.0.1.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


async def _read_limited(upload: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BYTES:
            log.warning("upload %s exceeded %d bytes", upload.filename, MAX_BYTES)
            raise HTTPException(status_code=413, detail="file too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _invalid(kind: str, error: Exception) -> HTTPException:
    log.warning("invalid %s upload: %s", kind, error)
    return HTTPException(status_code=422, detail=f"invalid {kind}: {error}")


@app.get("/v1/graph")
def graph() -> dict[str, object]:
    # Issue #50 (CrossEnv): deterministic entity-tool graph over the endpoint
    # registry — cross-app task synthesis consumes this, not an LLM.
    return derive_graph()


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    return {"status": "ready"}


@app.post("/v1/xlsx/parse")
async def xlsx_parse(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str, Form()] = "full",
    sheet: Annotated[str, Form()] = "",
    region: Annotated[str, Form()] = "",
    artifact_mode: Annotated[str, Form()] = "",
) -> JSONResponse:
    content = await _read_limited(file)
    if not content:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        # Issue #45, region-wise pattern: mode=sketch answers structure only
        # (dimensions, block ranges, headers); mode=full with sheet+region
        # reads one localized region, capped, with absolute range names.
        if mode == "sketch":
            parsed = sketch_workbook(content)
        else:
            parsed = parse_workbook(content, sheet=sheet or None, region=region or None)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, ValueError) as error:
        raise _invalid("xlsx", error) from error
    if wants_envelope(artifact_mode):
        # Issue #53: describe the source document for the artifact index.
        parsed["artifact"] = artifact_block(
            "xlsx", file.filename or "workbook.xlsx", content, xlsx_preview_text(parsed)
        )
    log.info("parsed xlsx %s (mode=%s): %d sheets", file.filename, mode, len(parsed["sheets"]))
    return JSONResponse(parsed)


@app.get("/v1/rollouts/grep")
def rollouts_grep(
    q: Annotated[str, Query(min_length=1)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, object]:
    # Issue #45 (GrepMem pattern): regex retrieval over the append-only
    # outcome sink — exact facts across sessions, no new storage.
    try:
        re.compile(q)
    except re.error as error:
        raise HTTPException(status_code=422, detail=f"invalid regex: {error}") from error
    sink = default_sink()
    if not sink.exists():
        return {"matches": [], "pattern": q, "truncated": False, "sink": str(sink), "exists": False}
    result = grep_sink(sink, q, limit=limit)
    result["sink"] = str(sink)
    result["exists"] = True
    return result


@app.post("/v1/docx/fill")
async def docx_fill(
    file: Annotated[UploadFile, File()],
    values: Annotated[str, Form()],
    artifact_mode: Annotated[str, Form()] = "",
) -> Response:
    try:
        replacements = json.loads(values)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail=f"values is not JSON: {error}") from error
    if not isinstance(replacements, dict):
        raise HTTPException(status_code=422, detail="values must be a JSON object")
    content = await _read_limited(file)
    if not content:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        filled, unfilled = fill_document(content, replacements)
    except (PackageNotFoundError, zipfile.BadZipFile, KeyError, ValueError) as error:
        raise _invalid("docx", error) from error
    if wants_envelope(artifact_mode):
        # Issue #53: the artifact index consumes the envelope, not the bytes.
        preview = docx_preview_text(parse_document(filled))
        log.info(
            "filled docx %s: %d bytes, unfilled=%s (envelope)",
            file.filename,
            len(filled),
            ",".join(unfilled) or "-",
        )
        return JSONResponse(envelope("docx", file.filename or "filled.docx", filled, preview))
    headers: dict[str, str] = {
        "X-Office-Doc-SHA256": hashlib.sha256(filled).hexdigest(),
        "Content-Disposition": 'attachment; filename="filled.docx"',
    }
    if unfilled:
        headers["X-Office-Unfilled"] = ",".join(unfilled)
    log.info(
        "filled docx %s: %d bytes, unfilled=%s",
        file.filename,
        len(filled),
        ",".join(unfilled) or "-",
    )
    return Response(content=filled, media_type=DOCX_MIME, headers=headers)


@app.post("/v1/docx/parse")
async def docx_parse(
    file: Annotated[UploadFile, File()],
    artifact_mode: Annotated[str, Form()] = "",
) -> JSONResponse:
    content = await _read_limited(file)
    if not content:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        parsed = parse_document(content)
    except (PackageNotFoundError, zipfile.BadZipFile, KeyError, ValueError) as error:
        raise _invalid("docx", error) from error
    if wants_envelope(artifact_mode):
        parsed["artifact"] = artifact_block(
            "docx", file.filename or "document.docx", content, docx_preview_text(parsed)
        )
    log.info("parsed docx %s: %d blocks", file.filename, len(parsed["blocks"]))
    return JSONResponse(parsed)


@app.post("/v1/docx/write")
async def docx_write(
    markdown: Annotated[str, Form()],
    artifact_mode: Annotated[str, Form()] = "",
) -> Response:
    try:
        written = write_docx_from_markdown(markdown)
    except (KeyError, ValueError) as error:
        raise _invalid("docx", error) from error
    if wants_envelope(artifact_mode):
        # Issue #53: the artifact index consumes the envelope, not the bytes.
        preview = docx_preview_text(parse_document(written))
        log.info("wrote docx from markdown: %d bytes (envelope)", len(written))
        return JSONResponse(envelope("docx", "document.docx", written, preview))
    headers: dict[str, str] = {
        "X-Office-Doc-SHA256": hashlib.sha256(written).hexdigest(),
        "Content-Disposition": 'attachment; filename="document.docx"',
    }
    log.info("wrote docx from markdown: %d bytes", len(written))
    return Response(content=written, media_type=DOCX_MIME, headers=headers)


@app.post("/v1/pptx/parse")
async def pptx_parse(
    file: Annotated[UploadFile, File()],
    artifact_mode: Annotated[str, Form()] = "",
) -> JSONResponse:
    content = await _read_limited(file)
    if not content:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        parsed = parse_deck(content)
    except (
        PackageNotFoundError,
        PptxPackageNotFoundError,
        zipfile.BadZipFile,
        KeyError,
        ValueError,
    ) as error:
        raise _invalid("pptx", error) from error
    if wants_envelope(artifact_mode):
        parsed["artifact"] = artifact_block(
            "pptx", file.filename or "deck.pptx", content, pptx_preview_text(parsed)
        )
    log.info("parsed pptx %s: %d slides", file.filename, len(parsed["slides"]))
    return JSONResponse(parsed)


@app.post("/v1/pptx/write")
async def pptx_write(
    file: Annotated[UploadFile | None, File()] = None,
    slides: Annotated[str, Form()] = "",
    format: Annotated[str, Form()] = "ops",
    artifact_mode: Annotated[str, Form()] = "",
) -> Response:
    if format == "markdown":
        # Markdown mode regenerates a fresh deck (#36); the file part is not read.
        try:
            written = write_deck_from_markdown(slides)
        except (KeyError, ValueError) as error:
            raise _invalid("pptx", error) from error
        slide_count = sum(1 for block in parse_blocks(slides) if block["kind"] == "heading")
    elif format == "ops":
        try:
            ops = json.loads(slides)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=422, detail=f"slides is not JSON: {error}") from error
        if not isinstance(ops, list) or any(not isinstance(op, dict) for op in ops):
            raise HTTPException(status_code=422, detail="slides must be a JSON array of objects")
        content = b""
        if file is not None and file.filename:
            content = await _read_limited(file)
        try:
            written = write_deck(content or None, ops)
        except (
            PackageNotFoundError,
            PptxPackageNotFoundError,
            zipfile.BadZipFile,
            KeyError,
            ValueError,
        ) as error:
            raise _invalid("pptx", error) from error
        slide_count = len(ops)
    else:
        raise HTTPException(status_code=422, detail="format must be 'ops' or 'markdown'")
    if wants_envelope(artifact_mode):
        # Issue #53: the artifact index consumes the envelope, not the bytes.
        preview = pptx_preview_text(parse_deck(written))
        log.info("wrote pptx: %d bytes, %d slides (envelope)", len(written), slide_count)
        return JSONResponse(envelope("pptx", "deck.pptx", written, preview))
    headers: dict[str, str] = {
        "X-Office-Doc-SHA256": hashlib.sha256(written).hexdigest(),
        "Content-Disposition": 'attachment; filename="deck.pptx"',
        "X-Office-Slide-Count": str(slide_count),
    }
    return Response(content=written, media_type=PPTX_MIME, headers=headers)


# App-reported outcome sink (#33): one JSONL file in the rollout-tap schema
# fusion-trainer's rollout_ingest already reads.
OUTCOME_SINK = Path(get_env("FUSION_OFFICE_API_OUTCOME_SINK", str(default_sink())))


@app.post("/v1/outcomes", status_code=202)
async def outcomes_report(request: Request) -> dict[str, str]:
    try:
        record = await request.json()
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"body is not JSON: {error}") from error
    invalid = validate_record(record)
    if invalid:
        log.warning("rejected outcome record: %s", invalid)
        raise HTTPException(status_code=422, detail=invalid)
    try:
        append_record(OUTCOME_SINK, record)
    except OSError as error:
        log.error("outcome sink write failed (%s): %s", OUTCOME_SINK, error)
        raise HTTPException(status_code=500, detail="outcome sink write failed") from error
    log.info("recorded outcome %s: %s", record["rollout_id"], record["outcome"]["signal"])
    return {"accepted": record["rollout_id"]}


# Registered as fusion-office-api in architecture/port-registry.yaml (issue #3:
# 11520 collided with ai-apparelmockup; never default onto another service's port).
DEFAULT_PORT = 11492


def run() -> None:
    port = service_port("office-api", default=DEFAULT_PORT)
    try:
        import setproctitle

        setproctitle.setproctitle(f"fusion-office-api serve :{port}")
    except Exception:
        log.debug("setproctitle unavailable, process title stays default", exc_info=True)
    log.info("starting fusion-office-api on 127.0.0.1:%d", port)
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    run()
