#!/usr/bin/env python
"""Convert bundled TTF fonts to WOFF2 (issue #12).

Pure lossless table-preserving conversion: no glyph subsetting, so all
metrics tables (hhea, OS/2, fvar/avar/MVAR) stay identical and the font
metrics unit tests keep reading the same values. OFL 1.1 permits the
conversion; PROVENANCE.md records the tool and parameters.

Usage: .venv python scripts/convert-fonts.py [--force]
Skips conversion when the .woff2 sibling is newer than the .ttf source.
"""

import argparse
import logging
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

log = logging.getLogger("convert-fonts")

REPO = Path(__file__).resolve().parent.parent


def convert(ttf: Path, force: bool) -> bool:
    woff2 = ttf.with_suffix(".woff2")
    if not force and woff2.exists() and woff2.stat().st_mtime >= ttf.stat().st_mtime:
        return False
    font = TTFont(str(ttf))
    font.flavor = "woff2"
    font.save(str(woff2))
    font.close()
    before = ttf.stat().st_size
    after = woff2.stat().st_size
    log.info("converted %s: %d -> %d bytes (%.0f%%)", ttf.relative_to(REPO), before, after, 100.0 * after / max(before, 1))
    return True


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    count = 0
    total_before = 0
    total_after = 0
    for public in sorted(REPO.glob("apps/*/public/fonts")):
        for ttf in sorted(public.rglob("*.ttf")):
            if ttf.name.startswith("."):
                continue
            convert(ttf, args.force)
            woff2 = ttf.with_suffix(".woff2")
            count += 1
            total_before += ttf.stat().st_size
            total_after += woff2.stat().st_size
    log.info("done: %d fonts, %d -> %d bytes (%.0f%%)", count, total_before, total_after, 100.0 * total_after / max(total_before, 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
