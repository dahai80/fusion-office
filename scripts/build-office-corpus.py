# Build the OOXML golden corpus for the fidelity roundtrip CI gate (issue #66
# Leg 2). Sources are Apache-2.0 test corpora cloned shallowly:
#   https://github.com/apache/poi        (poi/test-data)
#   https://github.com/plutext/docx4j   (docx4j/src/test/resources + docs)
# Usage: python scripts/build-office-corpus.py <poi-root> <docx4j-root> [out]
# Deterministic: sorted walk, sha256 dedupe, per-kind quota, size caps.

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

QUOTA = {"docx": 45, "xlsx": 45, "pptx": 30}
MAX_BYTES = 2_000_000
MIN_BYTES = 4_000
# OOXML is a zip package; OLE/CFB containers (password-protected workbooks
# saved pre-OOXML, legacy binaries) are not parseable by the service and
# stay out of the corpus.
ZIP_MAGIC = b"PK\x03\x04"

SOURCES = """\
# Golden corpus sources

Real-world OOXML files for the fidelity roundtrip gate (issue #66 Leg 2).
Both sources are Apache-2.0 licensed test corpora; files are copied verbatim
with their original names (prefixed by source to stay unique) and pinned by
SHA256 in SHA256SUMS.

- `poi-*` — https://github.com/apache/poi (Apache POI project test data), Apache-2.0
- `docx4j-*` — https://github.com/plutext/docx4j sample documents, Apache-2.0

Rebuild: `python scripts/build-office-corpus.py <poi-checkout> <docx4j-checkout>`
"""


def emit(out: Path, kind: str, quota: int, roots: list[tuple[str, Path]]) -> list[str]:
    target = out / kind
    target.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    picked: list[str] = []
    by_source: dict[str, list[Path]] = {}
    for label, root in roots:
        if root.is_dir():
            by_source[label] = sorted(p for p in root.rglob(f"*.{kind}") if p.is_file())
    # Interleave sources deterministically: alternate poi/docx4j so the quota
    # draws from both corpora rather than draining the first one.
    order: list[tuple[str, Path]] = []
    queues = [(label, by_source[label]) for label in sorted(by_source)]
    while queues:
        for label, queue in queues:
            if queue:
                order.append((label, queue.pop(0)))
        queues = [(label, q) for label, q in queues if q]
    for label, path in order:
        if len(picked) >= quota:
            break
        data = path.read_bytes()
        if not MIN_BYTES <= len(data) <= MAX_BYTES:
            continue
        if not data.startswith(ZIP_MAGIC):
            continue
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        name = f"{label}-{path.name}"
        shutil.copyfile(path, target / name)
        picked.append(f"{kind}/{name}")
    return picked


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: build-office-corpus.py <poi-root> <docx4j-root> [out]")
    poi_root = Path(sys.argv[1])
    docx4j_root = Path(sys.argv[2])
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("fixtures/office-corpus")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    all_picked: list[str] = []
    for kind, quota in QUOTA.items():
        picked = emit(out, kind, quota, [("poi", poi_root), ("docx4j", docx4j_root)])
        print(f"{kind}: {len(picked)} files")
        all_picked.extend(picked)
    lines = []
    for rel in sorted(all_picked):
        digest = hashlib.sha256((out / rel).read_bytes()).hexdigest()
        lines.append(f"{digest}  {rel}")
    (out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "SOURCES.md").write_text(SOURCES, encoding="utf-8")
    print(f"total: {len(all_picked)} files, checksums in SHA256SUMS")


if __name__ == "__main__":
    main()
