from __future__ import annotations

from fastapi.testclient import TestClient

from office_api.graph import ENDPOINT_REGISTRY, derive_graph


def test_graph_is_deterministic_and_derivable_from_the_registry() -> None:
    first = derive_graph()
    second = derive_graph()

    assert first == second
    assert [node["id"] for node in first["nodes"]] == [
        endpoint["id"] for endpoint in ENDPOINT_REGISTRY
    ]


def test_edges_join_produced_artifacts_to_consumed_ones() -> None:
    graph = derive_graph()
    by_pair = {(edge["producer"], edge["consumer"]): edge for edge in graph["edges"]}

    # A generated document feeds the fill and the parse endpoints.
    assert by_pair[("docx/write", "docx/fill")]["artifacts"] == ["file:docx"]
    assert by_pair[("docx/write", "docx/parse")]["artifacts"] == ["file:docx"]
    # A filled document can be read back.
    assert by_pair[("docx/fill", "docx/parse")]["artifacts"] == ["file:docx"]
    # Markdown flows from blocks-style data into both write endpoints.
    assert ("docx/write", "pptx/write:ops") not in by_pair
    # Every edge is a stage-2 (cross-app) seat.
    assert all(edge["stage"] == 2 for edge in graph["edges"])
    # Every edge artifact is real: producer declares it, consumer consumes it.
    registry = {endpoint["id"]: endpoint for endpoint in ENDPOINT_REGISTRY}
    for edge in graph["edges"]:
        assert set(edge["artifacts"]) <= set(registry[edge["producer"]]["produces"])
        assert set(edge["artifacts"]) <= set(registry[edge["consumer"]]["consumes"])


def test_graph_endpoint_serves_the_derived_graph(client: TestClient) -> None:
    response = client.get("/v1/graph")

    assert response.status_code == 200
    body = response.json()
    assert body == derive_graph()
    assert any(node["path"] == "/v1/xlsx/parse" for node in body["nodes"])
