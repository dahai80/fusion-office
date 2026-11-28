# Golden corpus fidelity gate (issue #66 Leg 2). Every file in
# fixtures/office-corpus must parse without error, parse deterministically,
# and match its pinned SHA256 in SHA256SUMS. Offline only — the LibreOffice
# re-serialize oracle stays out until it can run somewhere with the engine.

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from office_api.docx import parse_document
from office_api.pptx import parse_deck
from office_api.xlsx import parse_workbook

CORPUS = Path(__file__).resolve().parents[3] / "fixtures" / "office-corpus"
PARSERS = {
    "docx": parse_document,
    "xlsx": parse_workbook,
    "pptx": parse_deck,
}


def corpus_files() -> list[Path]:
    files = sorted(
        path for kind in PARSERS for path in (CORPUS / kind).glob(f"*.{kind}") if path.is_file()
    )
    if not files:
        pytest.fail("golden corpus is missing; run scripts/build-office-corpus.py")
    return files


def _canonical(result: dict) -> str:
    return json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)


def test_corpus_matches_pinned_checksums() -> None:
    lines = (CORPUS / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    pinned: dict[str, str] = {}
    for line in lines:
        digest, _, rel = line.partition("  ")
        assert rel, f"malformed SHA256SUMS line: {line!r}"
        pinned[rel] = digest
    on_disk = {
        str(path.relative_to(CORPUS)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in corpus_files()
    }
    assert set(pinned) == set(on_disk), "SHA256SUMS and corpus files disagree"
    for rel, digest in pinned.items():
        assert on_disk[rel] == digest, f"corpus file drifted: {rel}"


@pytest.mark.parametrize("path", corpus_files(), ids=lambda p: p.name)
def test_corpus_file_parses_and_is_deterministic(path: Path) -> None:
    parser = PARSERS[path.suffix.lstrip(".")]
    content = path.read_bytes()

    first = parser(content)
    second = parser(content)

    assert _canonical(first) == _canonical(second), f"parse is nondeterministic: {path.name}"
