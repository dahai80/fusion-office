from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from office_api import main
from office_api.outcomes import validate_record


@pytest.fixture()
def sink(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "rollout-outcomes.jsonl"
    monkeypatch.setattr(main, "OUTCOME_SINK", path)
    return path


def record() -> dict:
    return {
        "schema_version": 1,
        "rollout_id": "ro-abcd1234abcd1234",
        "event_id": "ro-abcd1234abcd1234:e1",
        "source": "fusion-office/documents",
        "model": "mlx-community--Qwen3.5-4B-MLX-4bit",
        "created_at": "2026-11-25T12:00:00Z",
        "messages": [
            {"role": "user", "content": "[redacted:24]"},
            {"role": "assistant", "content": "[redacted:8]"},
        ],
        "outcome": {"signal": "user_accepted", "score": 1.0, "detail": "Replace selection"},
    }


def test_valid_record_is_appended_to_the_sink(client: TestClient, sink: Path) -> None:
    response = client.post("/v1/outcomes", json=record())

    assert response.status_code == 202
    assert response.json()["accepted"] == "ro-abcd1234abcd1234"
    lines = sink.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["outcome"]["signal"] == "user_accepted"


def test_each_report_is_one_new_line(client: TestClient, sink: Path) -> None:
    client.post("/v1/outcomes", json=record())
    second = record()
    second["event_id"] = "ro-abcd1234abcd1234:e2"
    second["outcome"] = {"signal": "task_success", "score": 1.0}
    client.post("/v1/outcomes", json=second)

    lines = sink.read_text(encoding="utf-8").splitlines()
    assert {json.loads(line)["rollout_id"] for line in lines} == {second["rollout_id"]}
    assert len({json.loads(line)["event_id"] for line in lines}) == 2
    assert [json.loads(line)["outcome"]["signal"] for line in lines] == [
        "user_accepted",
        "task_success",
    ]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(schema_version=2),
        lambda r: r.update(rollout_id=""),
        lambda r: r.pop("model"),
        lambda r: r.update(messages=[]),
        lambda r: r.update(messages=[{"role": "intruder", "content": "x"}]),
        lambda r: r.update(outcome={"signal": "not_a_signal"}),
        lambda r: r.update(outcome=None),
    ],
)
def test_invalid_record_is_422_and_writes_nothing(client: TestClient, sink: Path, mutate) -> None:
    payload = record()
    mutate(payload)

    response = client.post("/v1/outcomes", json=payload)

    assert response.status_code == 422
    assert not sink.exists()


def test_non_json_body_is_422(client: TestClient) -> None:
    response = client.post(
        "/v1/outcomes", content=b"not json", headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422


def test_validate_record_accepts_the_documented_shape() -> None:
    assert validate_record(record()) is None
    assert validate_record("nope") == "record must be a JSON object"
