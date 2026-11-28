# Golden corpus sources

Real-world OOXML files for the fidelity roundtrip gate (issue #66 Leg 2).
Both sources are Apache-2.0 licensed test corpora; files are copied verbatim
with their original names (prefixed by source to stay unique) and pinned by
SHA256 in SHA256SUMS.

- `poi-*` — https://github.com/apache/poi (Apache POI project test data), Apache-2.0
- `docx4j-*` — https://github.com/plutext/docx4j sample documents, Apache-2.0

Rebuild: `python scripts/build-office-corpus.py <poi-checkout> <docx4j-checkout>`
