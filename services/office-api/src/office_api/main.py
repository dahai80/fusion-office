# HTTP surface for the fusion-office capability service. Contract:
# https://github.com/dahai80/fusion-office/issues/1. Business logic stays in
# the consuming application.

from __future__ import annotations

import hashlib
import json
import logging
import os
import zipfile
from typing import Annotated

import uvicorn
from docx.opc.exceptions import PackageNotFoundError
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from openpyxl.utils.exceptions import InvalidFileException

from . import __version__
from .docx import fill_document
from .xlsx import parse_workbook

logging.basicConfig(
    level=os.environ.get("OFFICE_API_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("office_api")

MAX_BYTES = int(os.environ.get("OFFICE_API_MAX_BYTES", str(100 * 1024 * 1024)))
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

app = FastAPI(title="fusion-office", version=__version__)


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


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    return {"status": "ready"}


@app.post("/v1/xlsx/parse")
async def xlsx_parse(file: Annotated[UploadFile, File()]) -> JSONResponse:
    content = await _read_limited(file)
    if not content:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        parsed = parse_workbook(content)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, ValueError) as error:
        raise _invalid("xlsx", error) from error
    log.info("parsed xlsx %s: %d sheets", file.filename, len(parsed["sheets"]))
    return JSONResponse(parsed)


@app.post("/v1/docx/fill")
async def docx_fill(
    file: Annotated[UploadFile, File()],
    values: Annotated[str, Form()],
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


def run() -> None:
    port = int(os.environ.get("OFFICE_API_PORT", "11520"))
    log.info("starting fusion-office-api on 127.0.0.1:%d", port)
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    run()
