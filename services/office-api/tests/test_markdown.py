from __future__ import annotations

from io import BytesIO

from docx import Document

from office_api.docx import parse_document
from office_api.markdown import parse_blocks, write_docx_from_markdown


def test_parse_blocks_extracts_headings_paragraphs_and_tables() -> None:
    content = (
        "# Title\nIntro line one\nIntro line two\n\n| a | b |\n| 1 | 2 |\n| 3 |\nTail paragraph"
    )

    blocks = parse_blocks(content)

    assert blocks == [
        {"kind": "heading", "level": 1, "text": "Title"},
        {"kind": "para", "text": "Intro line one Intro line two"},
        {"kind": "table", "rows": [["a", "b"], ["1", "2"], ["3"]]},
        {"kind": "para", "text": "Tail paragraph"},
    ]


def test_parse_blocks_skips_table_separators_and_unescapes_pipes() -> None:
    content = "| name | value |\n|---|---|\n| pipe \\| here | 42 |"

    blocks = parse_blocks(content)

    assert blocks == [{"kind": "table", "rows": [["name", "value"], ["pipe | here", "42"]]}]


def test_write_docx_from_markdown_roundtrips_through_parse() -> None:
    content = "# Plan\nFirst paragraph\n## Details\n\n| item | cost |\n|---|---|\n| ship | 100 |\nClosing paragraph"

    written = write_docx_from_markdown(content)
    parsed = parse_document(BytesIO(written).read())

    assert parsed["blocks"] == [
        {"kind": "heading", "level": 1, "text": "Plan"},
        {"kind": "para", "text": "First paragraph"},
        {"kind": "heading", "level": 2, "text": "Details"},
        {"kind": "table", "rows": [["item", "cost"], ["ship", "100"]]},
        {"kind": "para", "text": "Closing paragraph"},
    ]


def test_write_docx_from_markdown_preserves_every_fidelity_anchor() -> None:
    # office-bench fidelity semantics (fusion-bench#67): every anchor string a
    # grader pins must survive the write->parse roundtrip verbatim.
    anchors = [
        "Executive summary",
        "Budget is approved for Q3",
        "line item",
        "compute",
        "Signed by the comptroller",
    ]
    content = (
        "# Executive summary\nBudget is approved for Q3\n\n"
        "| line item | amount |\n|---|---|\n| compute | 42 |\n\nSigned by the comptroller"
    )

    parsed = parse_document(BytesIO(write_docx_from_markdown(content)).read())
    text_parts: list[str] = []
    for block in parsed["blocks"]:
        if "text" in block:
            text_parts.append(block["text"])
        text_parts.extend(" ".join(row) for row in block.get("rows", []))
    text = "\n".join(text_parts)

    for anchor in anchors:
        assert anchor in text


def test_parse_document_reads_headings_paragraphs_and_tables_in_order() -> None:
    document = Document()
    document.add_heading("Overview", level=1)
    document.add_paragraph("A paragraph.")
    table = document.add_table(rows=2, cols=1)
    table.cell(0, 0).text = "row one"
    table.cell(1, 0).text = "row two"
    document.add_paragraph("Another paragraph.")
    buffer = BytesIO()
    document.save(buffer)

    parsed = parse_document(buffer.getvalue())

    assert parsed["blocks"] == [
        {"kind": "heading", "level": 1, "text": "Overview"},
        {"kind": "para", "text": "A paragraph."},
        {"kind": "table", "rows": [["row one"], ["row two"]]},
        {"kind": "para", "text": "Another paragraph."},
    ]


def test_parse_document_skips_empty_paragraphs() -> None:
    document = Document()
    document.add_paragraph("")
    document.add_paragraph("Only real line.")
    buffer = BytesIO()
    document.save(buffer)

    parsed = parse_document(buffer.getvalue())

    assert parsed["blocks"] == [{"kind": "para", "text": "Only real line."}]
