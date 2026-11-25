from __future__ import annotations

from io import BytesIO

from pptx import Presentation
from pptx.util import Inches

from office_api.pptx import parse_deck, write_deck


def deck_bytes(build) -> bytes:
    deck = Presentation()
    deck.slide_width = Inches(10)
    deck.slide_height = Inches(7.5)
    build(deck)
    buffer = BytesIO()
    deck.save(buffer)
    return buffer.getvalue()


def add_body_slide(deck, title: str, lines: list[str]) -> None:
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = title
    frame = slide.placeholders[1].text_frame
    frame.text = lines[0]
    for line in lines[1:]:
        frame.add_paragraph().text = line


def test_parse_extracts_title_body_and_notes() -> None:
    def build(deck) -> None:
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = "Quarterly review"
        frame = slide.placeholders[1].text_frame
        frame.text = "Revenue up 12%"
        frame.add_paragraph().text = "Churn down 3%"
        slide.notes_slide.notes_text_frame.text = "Mention the roadmap"

    parsed = parse_deck(deck_bytes(build))

    assert parsed["slides"] == [
        {
            "index": 1,
            "title": "Quarterly review",
            "body": ["Revenue up 12%", "Churn down 3%"],
            "notes": "Mention the roadmap",
        }
    ]


def test_parse_uses_reading_order_and_skips_the_title_shape_in_body() -> None:
    def build(deck) -> None:
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = "Title here"
        slide.shapes[1].text_frame.text = "First"
        box = slide.shapes.add_textbox(Inches(1), Inches(5), Inches(4), Inches(1))
        box.text_frame.text = "Second"

    parsed = parse_deck(deck_bytes(build))

    assert parsed["slides"][0]["body"] == ["First", "Second"]


def test_write_creates_a_new_deck_from_slide_ops() -> None:
    ops = [
        {"title": "Plan", "body": ["Ship pptx", "Ship docx"], "notes": "kickoff"},
        {"title": "Done"},
    ]

    written = write_deck(None, ops)

    parsed = parse_deck(written)
    assert [slide["title"] for slide in parsed["slides"]] == ["Plan", "Done"]
    assert parsed["slides"][0]["body"] == ["Ship pptx", "Ship docx"]
    assert parsed["slides"][0]["notes"] == "kickoff"


def test_write_modifies_existing_slide_and_leaves_others_untouched() -> None:
    def build(deck) -> None:
        add_body_slide(deck, "Keep me", ["untouched line"])
        add_body_slide(deck, "Old title", ["old body"])

    original = deck_bytes(build)
    snapshot = bytes(original)
    written = write_deck(
        original, [{"index": 2, "title": "New title", "body": ["new body"], "notes": "n"}]
    )

    assert original == snapshot
    parsed = parse_deck(written)
    assert parsed["slides"][0] == {
        "index": 1,
        "title": "Keep me",
        "body": ["untouched line"],
        "notes": "",
    }
    assert parsed["slides"][1]["title"] == "New title"
    assert parsed["slides"][1]["body"] == ["new body"]
    assert parsed["slides"][1]["notes"] == "n"


def test_write_clears_body_when_given_an_empty_list() -> None:
    def build(deck) -> None:
        add_body_slide(deck, "Title", ["line"])

    written = write_deck(deck_bytes(build), [{"index": 1, "body": []}])

    parsed = parse_deck(written)
    assert parsed["slides"][0]["title"] == "Title"
    assert parsed["slides"][0]["body"] == []


def test_write_index_beyond_deck_is_rejected() -> None:
    def build(deck) -> None:
        add_body_slide(deck, "Only", ["x"])

    try:
        write_deck(deck_bytes(build), [{"index": 5, "title": "nope"}])
    except ValueError as error:
        assert "beyond the deck" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_write_rejects_unknown_fields_and_bad_types() -> None:
    for ops in (
        [{"title": 5}],
        [{"body": "not a list"}],
        [{"index": True}],
        [{"unexpected": 1}],
    ):
        try:
            write_deck(None, ops)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {ops}")


def test_roundtrip_parse_write_parse_keeps_deck_openable() -> None:
    def build(deck) -> None:
        add_body_slide(deck, "Agenda", ["item one", "item two"])
        add_body_slide(deck, "Budget", ["total 100"])

    parsed = parse_deck(deck_bytes(build))
    ops = [
        {"index": 1, "title": parsed["slides"][0]["title"], "body": ["item one", "item three"]},
        {"title": "Appendix", "body": ["raw data"], "notes": "backup"},
    ]
    written = write_deck(deck_bytes(build), ops)
    reopened = parse_deck(written)

    assert reopened["slides"][0]["title"] == "Agenda"
    assert reopened["slides"][0]["body"] == ["item one", "item three"]
    assert reopened["slides"][1]["title"] == "Budget"
    assert reopened["slides"][2] == {
        "index": 3,
        "title": "Appendix",
        "body": ["raw data"],
        "notes": "backup",
    }
