from __future__ import annotations

import hashlib
import json
from io import BytesIO

from docx import Document
from fastapi.testclient import TestClient
from openpyxl import Workbook
from pptx import Presentation

from office_api import main

MODE = {"artifact_mode": "index+preview"}


def docx_bytes() -> bytes:
    document = Document()
    document.add_paragraph("Site: Plant A")
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def xlsx_bytes() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Monitoring"
    sheet.append(["pollutant", "conc_mg_l"])
    sheet.append(["COD", 42.5])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def pptx_bytes() -> bytes:
    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = "Kickoff"
    slide.placeholders[1].text_frame.text = "Agenda item"
    buffer = BytesIO()
    deck.save(buffer)
    return buffer.getvalue()


def assert_envelope(body: dict, kind: str, name: str, content_hint: str) -> None:
    assert body["ok"] is True
    artifact = body["artifact"]
    assert artifact["kind"] == kind
    assert artifact["name"] == name
    assert artifact["size"] > 0
    assert len(artifact["sha256"]) == 64
    assert artifact["sha256"] == artifact["sha256"].lower()
    assert content_hint in artifact["preview"]["content"]
    assert len(artifact["preview"]["content"]) <= 500
    assert artifact["preview"]["type"] == "text"


def test_docx_write_envelope_mode_returns_artifact_json(client: TestClient) -> None:
    response = client.post("/v1/docx/write", data={"markdown": "# Plan\n\nShip it.", **MODE})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert_envelope(response.json(), "docx", "document.docx", "Ship it.")


def test_docx_write_default_still_raw_bytes(client: TestClient) -> None:
    response = client.post("/v1/docx/write", data={"markdown": "# Plan\n\nShip it."})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(main.DOCX_MIME)
    assert "X-Office-Doc-SHA256" in response.headers


def test_docx_fill_envelope_mode_describes_the_filled_document(
    client: TestClient,
) -> None:
    response = client.post(
        "/v1/docx/fill",
        files={"file": ("template.docx", docx_bytes())},
        data={"values": json.dumps({"site": "Plant B"}), **MODE},
    )

    assert response.status_code == 200
    body = response.json()
    assert_envelope(body, "docx", "template.docx", "Plant A")
    assert body["artifact"]["sha256"] != hashlib.sha256(docx_bytes()).hexdigest()


def test_pptx_write_envelope_mode_returns_artifact_json(client: TestClient) -> None:
    response = client.post(
        "/v1/pptx/write",
        data={
            "slides": "# Kickoff\n\nAgenda item\n\n## Wrap",
            "format": "markdown",
            **MODE,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert_envelope(response.json(), "pptx", "deck.pptx", "Kickoff")


def test_xlsx_parse_envelope_mode_describes_the_source(client: TestClient) -> None:
    response = client.post(
        "/v1/xlsx/parse",
        files={"file": ("monitoring.xlsx", xlsx_bytes())},
        data=MODE,
    )

    assert response.status_code == 200
    body = response.json()
    # Parse responses stay content-bearing; the artifact block rides along.
    assert body["sheets"][0]["name"] == "Monitoring"
    assert body["artifact"]["kind"] == "xlsx"
    assert body["artifact"]["name"] == "monitoring.xlsx"
    assert body["artifact"]["sha256"] == hashlib.sha256(xlsx_bytes()).hexdigest()
    assert "pollutant" in body["artifact"]["preview"]["content"]


def test_docx_parse_envelope_mode_describes_the_source(client: TestClient) -> None:
    response = client.post(
        "/v1/docx/parse",
        files={"file": ("report.docx", docx_bytes())},
        data=MODE,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["blocks"][0]["text"] == "Site: Plant A"
    assert body["artifact"]["kind"] == "docx"
    assert body["artifact"]["name"] == "report.docx"
    assert "Plant A" in body["artifact"]["preview"]["content"]


def test_pptx_parse_envelope_mode_describes_the_source(client: TestClient) -> None:
    response = client.post(
        "/v1/pptx/parse",
        files={"file": ("kickoff.pptx", pptx_bytes())},
        data=MODE,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["slides"][0]["title"] == "Kickoff"
    assert body["artifact"]["kind"] == "pptx"
    assert "Agenda item" in body["artifact"]["preview"]["content"]


def test_unknown_artifact_mode_keeps_default_behavior(client: TestClient) -> None:
    response = client.post(
        "/v1/docx/write", data={"markdown": "# Plan\n\nShip it.", "artifact_mode": "raw"}
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(main.DOCX_MIME)

    response = client.post(
        "/v1/xlsx/parse",
        files={"file": ("m.xlsx", xlsx_bytes())},
        data={"artifact_mode": "index"},
    )

    assert response.status_code == 200
    assert "artifact" not in response.json()
