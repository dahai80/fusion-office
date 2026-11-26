# Entity-tool graph over the office-api endpoints (issue #50, fusion-trainer#111
# CrossEnv recipe). The registry is static and the graph derivation is a
# deterministic join: an endpoint that produces an artifact type and an endpoint
# that consumes it form an edge, and cross-app tasks are synthesized on edges.
# fusion-trainer / fusion-bench consume GET /v1/graph as their synthesis source.

from __future__ import annotations

from typing import Any

# Artifact types the endpoints exchange. One entry per (endpoint, mode) —
# the mode distinguishes /v1/pptx/write's ops and markdown paths.
# produces/consumes name artifact types; "record" entries describe what the
# endpoint yields in structured form, "binary" what it returns as a file.
ENDPOINT_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "xlsx/parse:full",
        "consumes": ["file:xlsx"],
        "produces": ["data:tables"],
        "summary": "Sheets, tables and unparsed regions from a workbook (mode=sketch or region reads for large sheets)",
    },
    {
        "id": "docx/parse",
        "consumes": ["file:docx"],
        "produces": ["data:blocks"],
        "summary": "Ordered heading/para/table blocks from a document",
    },
    {
        "id": "docx/fill",
        "consumes": ["file:docx", "data:values"],
        "produces": ["file:docx"],
        "summary": "Filled {{placeholder}} markers; returns the document binary",
    },
    {
        "id": "docx/write",
        "consumes": ["data:markdown"],
        "produces": ["file:docx"],
        "summary": "A .docx generated from markdown blocks",
    },
    {
        "id": "pptx/parse",
        "consumes": ["file:pptx"],
        "produces": ["data:slides"],
        "summary": "Slides with title, body lines and speaker notes",
    },
    {
        "id": "pptx/write:ops",
        "consumes": ["file:pptx", "data:slide_ops"],
        "produces": ["file:pptx"],
        "summary": "In-place slide edits or appends; returns the deck binary",
    },
    {
        "id": "pptx/write:markdown",
        "consumes": ["data:markdown"],
        "produces": ["file:pptx"],
        "summary": "A fresh deck generated from markdown headings, paragraphs and pipe tables",
    },
]

# Curriculum stage of an edge: every derived edge joins two endpoints, so it is
# a stage-2 (cross-app) task seat. Stage 1 (single-app) tasks live on the
# endpoints themselves; stage 3 (user clarification) needs underspecified
# prompts and is not derivable from the registry.
EDGE_STAGE = 2


def derive_graph() -> dict[str, Any]:
    """Nodes = registry entries; edges = produces-to-consumes artifact joins."""
    nodes = [
        {
            "id": endpoint["id"],
            "path": f"/v1/{endpoint['id'].split(':')[0]}",
            "summary": endpoint["summary"],
            "consumes": endpoint["consumes"],
            "produces": endpoint["produces"],
        }
        for endpoint in ENDPOINT_REGISTRY
    ]
    edges: list[dict[str, Any]] = []
    for producer in ENDPOINT_REGISTRY:
        for consumer in ENDPOINT_REGISTRY:
            if producer is consumer:
                continue
            shared = sorted(set(producer["produces"]) & set(consumer["consumes"]))
            if not shared:
                continue
            edges.append(
                {
                    "producer": producer["id"],
                    "consumer": consumer["id"],
                    "artifacts": shared,
                    "stage": EDGE_STAGE,
                }
            )
    edges.sort(key=lambda edge: (edge["producer"], edge["consumer"]))
    return {"nodes": nodes, "edges": edges}
