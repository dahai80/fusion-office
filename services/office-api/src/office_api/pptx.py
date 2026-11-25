# Parses .pptx decks into structured JSON and writes slides back (issue #32).
# The parse shape follows fusion-rag's PPTX extraction: reading-order text
# frames per slide plus speaker notes, kept here as title/body/notes fields so
# consumers get the same content in structured form.

from __future__ import annotations

import logging
from io import BytesIO
from typing import Any

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Inches, Pt

from .markdown import parse_blocks

log = logging.getLogger(__name__)

EMPTY_DECK_WIDTH = Inches(10)
EMPTY_DECK_HEIGHT = Inches(7.5)


def _paragraph_lines(text_frame: Any) -> list[str]:
    lines: list[str] = []
    for paragraph in text_frame.paragraphs:
        line = "".join(run.text for run in paragraph.runs).strip()
        if line:
            lines.append(line)
    return lines


def _collect_text(shapes: Any, lines: list[str], skip: Any) -> None:
    for shape in shapes:
        if shape is skip or shape.shape_id == getattr(skip, "shape_id", None):
            continue
        if shape.has_text_frame:
            lines.extend(_paragraph_lines(shape.text_frame))
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            _collect_text(shape.shapes, lines, None)


def parse_deck(content: bytes) -> dict[str, Any]:
    deck = Presentation(BytesIO(content))
    slides: list[dict[str, Any]] = []
    for index, slide in enumerate(deck.slides, start=1):
        title = ""
        title_shape = slide.shapes.title
        if title_shape is not None and title_shape.has_text_frame:
            title = title_shape.text_frame.text.strip()
        body: list[str] = []
        _collect_text(slide.shapes, body, title_shape)
        notes = ""
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
        slides.append({"index": index, "title": title, "body": body, "notes": notes})
        log.info(
            "slide %d: %d body lines, notes=%s",
            index,
            len(body),
            "yes" if notes else "no",
        )
    return {"slides": slides}


def _validate_slide_op(op: Any, position: int) -> None:
    if not isinstance(op, dict):
        # ValueError, not TypeError: the HTTP layer maps ValueError to a 422.
        raise ValueError(f"slides[{position}] must be a JSON object")  # noqa: TRY004
    if "index" in op and op["index"] is not None:
        index = op["index"]
        if not isinstance(index, int) or isinstance(index, bool) or index < 1:
            raise ValueError(f"slides[{position}].index must be a 1-based integer")
    for field in ("title", "notes"):
        if field in op and not isinstance(op[field], str):
            raise ValueError(f"slides[{position}].{field} must be a string")
    if "body" in op:
        body = op["body"]
        if not isinstance(body, list) or any(not isinstance(line, str) for line in body):
            raise ValueError(f"slides[{position}].body must be an array of strings")
    known = {"index", "title", "body", "notes"}
    unknown = set(op) - known
    if unknown:
        raise ValueError(f"slides[{position}] has unknown fields: {sorted(unknown)}")


def _pick_layout(deck: Presentation) -> Any:
    for layout in deck.slide_layouts:
        has_title = False
        has_body = False
        for placeholder in layout.placeholders:
            if not placeholder.has_text_frame:
                continue
            if placeholder.placeholder_format.idx == 0:
                has_title = True
            else:
                has_body = True
        if has_title and has_body:
            return layout
    return deck.slide_layouts[0]


def _set_title(slide: Any, title: str) -> None:
    title_shape = slide.shapes.title
    if title_shape is not None and title_shape.has_text_frame:
        title_shape.text_frame.text = title
        return
    box = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(9), Inches(1))
    box.text_frame.text = title
    box.text_frame.paragraphs[0].font.size = Pt(28)


def _set_body(slide: Any, body: list[str]) -> None:
    frame = None
    title_shape = slide.shapes.title
    for placeholder in slide.placeholders:
        if title_shape is not None and placeholder.shape_id == title_shape.shape_id:
            continue
        if placeholder.has_text_frame:
            frame = placeholder.text_frame
            break
    if frame is None:
        top = Inches(1.4)
        box = slide.shapes.add_textbox(Inches(0.5), top, Inches(9), Inches(5))
        frame = box.text_frame
    frame.clear()
    if not body:
        return
    frame.paragraphs[0].text = body[0]
    for line in body[1:]:
        frame.add_paragraph().text = line


def _apply_op(slide: Any, op: dict[str, Any]) -> None:
    if "title" in op:
        _set_title(slide, op["title"])
    if "body" in op:
        _set_body(slide, op["body"])
    if "notes" in op:
        slide.notes_slide.notes_text_frame.text = op["notes"]


def write_deck(content: bytes | None, slides: list[dict[str, Any]]) -> bytes:
    if content:
        deck = Presentation(BytesIO(content))
    else:
        deck = Presentation()
        deck.slide_width = EMPTY_DECK_WIDTH
        deck.slide_height = EMPTY_DECK_HEIGHT
    for position, op in enumerate(slides):
        _validate_slide_op(op, position)
        if op.get("index") is not None:
            index = op["index"]
            if index > len(deck.slides):
                raise ValueError(
                    f"slides[{position}].index {index} is beyond the deck ({len(deck.slides)} slides)"
                )
            _apply_op(deck.slides[index - 1], op)
        else:
            slide = deck.slides.add_slide(_pick_layout(deck))
            _apply_op(slide, op)
    output = BytesIO()
    deck.save(output)
    written = output.getvalue()
    log.info("wrote pptx: %d slide ops, %d bytes out", len(slides), len(written))
    return written


# Markdown write-back (#36): headings start slides, paragraphs fill the body,
# pipe tables render as pptx tables. Always regenerates a fresh deck, symmetric
# with fusion-artifacts-engine's markdown_to_pptx write-back path.
def write_deck_from_markdown(markdown: str) -> bytes:
    deck = Presentation()
    deck.slide_width = EMPTY_DECK_WIDTH
    deck.slide_height = EMPTY_DECK_HEIGHT
    slide = None
    body_frame = None
    body_used = False

    def new_slide(title_text: str) -> None:
        nonlocal slide, body_frame, body_used
        slide = deck.slides.add_slide(_pick_layout(deck))
        body_frame = None
        body_used = False
        _set_title(slide, title_text)
        title_shape = slide.shapes.title
        for placeholder in slide.placeholders:
            if title_shape is not None and placeholder.shape_id == title_shape.shape_id:
                continue
            if placeholder.has_text_frame:
                body_frame = placeholder.text_frame
                break

    def append_body(text: str) -> None:
        nonlocal body_used
        if body_frame is not None:
            if not body_used:
                body_frame.paragraphs[0].text = text
                body_used = True
            else:
                body_frame.add_paragraph().text = text
        elif slide is not None:
            box = slide.shapes.add_textbox(Inches(0.5), Inches(1.8), Inches(9), Inches(4.5))
            box.text_frame.text = text

    for block in parse_blocks(markdown):
        if block["kind"] == "heading":
            new_slide(block["text"])
        elif slide is None:
            new_slide("")
            if block["kind"] == "para":
                append_body(block["text"])
        elif block["kind"] == "para":
            append_body(block["text"])
        else:
            rows = block["rows"]
            columns = max(len(row) for row in rows)
            shape = slide.shapes.add_table(
                len(rows), columns, Inches(0.5), Inches(1.8), Inches(9), Inches(0.4 * len(rows))
            )
            for row_index, row in enumerate(rows):
                for column_index in range(columns):
                    shape.table.cell(row_index, column_index).text = (
                        row[column_index] if column_index < len(row) else ""
                    )
    if not deck.slides:
        new_slide("")
    output = BytesIO()
    deck.save(output)
    written = output.getvalue()
    log.info("wrote pptx from markdown: %d bytes out", len(written))
    return written
