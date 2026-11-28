from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from office_api import main
from office_api.outcomes import grep_sink, validate_record


@pytest.fixture()
def sink(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "rollout-outcomes.jsonl"
    monkeypatch.setattr(main, "OUTCOME_SINK", path)
    return path


def record() -> dict:
    return {
        "schema_version": 1,
        "rollout_id": "ro-abcd1234abcd1234:e1",
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
    assert response.json()["accepted"] == "ro-abcd1234abcd1234:e1"
    lines = sink.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["outcome"]["signal"] == "user_accepted"


def test_each_report_is_one_new_line(client: TestClient, sink: Path) -> None:
    client.post("/v1/outcomes", json=record())
    second = record()
    second["rollout_id"] = "ro-abcd1234abcd1234:e2"
    second["outcome"] = {"signal": "task_success", "score": 1.0}
    client.post("/v1/outcomes", json=second)

    lines = sink.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["outcome"]["signal"] for line in lines] == [
        "user_accepted",
        "task_success",
    ]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(schema_version=3),
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


def versioned_record() -> dict:
    payload = record()
    payload["schema_version"] = 2
    payload["env_state"] = {
        "working_dir": "/tmp/task-42",
        "files": {"report.docx": {"sha256": "ab" * 32}},
    }
    payload["validator"] = {"name": "table-check", "version": "3", "status": "passing"}
    return payload


def test_versioned_record_with_env_state_and_validator_is_accepted(
    client: TestClient, sink: Path
) -> None:
    assert validate_record(versioned_record()) is None
    response = client.post("/v1/outcomes", json=versioned_record())

    assert response.status_code == 202
    stored = json.loads(sink.read_text(encoding="utf-8").splitlines()[0])
    assert stored["validator"]["status"] == "passing"
    assert stored["env_state"]["working_dir"] == "/tmp/task-42"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(env_state="report.docx"),
        lambda r: r.update(validator="table-check"),
        lambda r: r.update(validator={"name": "", "version": "3", "status": "passing"}),
        lambda r: r.update(validator={"name": "check", "version": "", "status": "passing"}),
        lambda r: r.update(validator={"name": "check", "version": "3", "status": "green"}),
    ],
)
def test_invalid_versioned_fields_are_422_and_write_nothing(
    client: TestClient, sink: Path, mutate
) -> None:
    payload = versioned_record()
    mutate(payload)

    response = client.post("/v1/outcomes", json=payload)

    assert response.status_code == 422
    assert not sink.exists()


def write_sink(path: Path, lines: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
    return path


def task_record() -> dict:
    payload = record()
    payload["outcome"] = dict(payload["outcome"], task_id="office-t-42")
    return payload


def test_task_tagged_record_is_accepted_and_stored(client: TestClient, sink: Path) -> None:
    assert validate_record(task_record()) is None
    response = client.post("/v1/outcomes", json=task_record())

    assert response.status_code == 202
    stored = json.loads(sink.read_text(encoding="utf-8").splitlines()[0])
    assert stored["outcome"]["task_id"] == "office-t-42"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["outcome"].update(task_id=""),
        lambda r: r["outcome"].update(task_id="   "),
        lambda r: r["outcome"].update(task_id=42),
    ],
)
def test_invalid_task_tags_are_422_and_write_nothing(
    client: TestClient, sink: Path, mutate
) -> None:
    payload = task_record()
    mutate(payload)

    response = client.post("/v1/outcomes", json=payload)

    assert response.status_code == 422
    assert not sink.exists()


def test_record_without_task_tag_stays_valid(client: TestClient, sink: Path) -> None:
    assert validate_record(record()) is None
    response = client.post("/v1/outcomes", json=record())

    assert response.status_code == 202


def test_grep_sink_matches_json_lines_as_records(tmp_path: Path) -> None:
    sink = write_sink(
        tmp_path / "rollout-outcomes.jsonl",
        [
            json.dumps(record()),
            json.dumps({**record(), "rollout_id": "ro-ffff", "outcome": {"signal": "error"}}),
        ],
    )

    result = grep_sink(sink, "task_success|error")

    assert result["truncated"] is False
    assert [match["record"]["rollout_id"] for match in result["matches"]] == ["ro-ffff"]


def test_grep_sink_limits_and_flags_truncation(tmp_path: Path) -> None:
    sink = write_sink(
        tmp_path / "rollout-outcomes.jsonl",
        [json.dumps(record()) for _ in range(3)],
    )

    result = grep_sink(sink, "rollout_id", limit=2)

    assert len(result["matches"]) == 2
    assert [match["line"] for match in result["matches"]] == [1, 2]
    assert result["truncated"] is True


def test_grep_sink_matches_unparseable_lines_as_raw_text(tmp_path: Path) -> None:
    sink = write_sink(
        tmp_path / "rollout-outcomes.jsonl",
        ['{"schema_version": 1, "rollout_id": "ro-trunc', "unrelated"],
    )

    result = grep_sink(sink, "rollout_id")

    assert result["matches"] == [{"line": 1, "record": None}]


def test_grep_endpoint_reads_the_sink(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sink = write_sink(tmp_path / "rollout-outcomes.jsonl", [json.dumps(record())])
    monkeypatch.setattr(main, "default_sink", lambda: sink)

    response = client.get("/v1/rollouts/grep", params={"q": "user_accepted"})

    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["matches"][0]["record"]["outcome"]["signal"] == "user_accepted"


def test_grep_endpoint_reports_a_missing_sink(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "default_sink", lambda: Path("/nonexistent/sink.jsonl"))

    response = client.get("/v1/rollouts/grep", params={"q": "anything"})

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "matches": [],
        "pattern": "anything",
        "truncated": False,
        "sink": "/nonexistent/sink.jsonl",
        "exists": False,
    }


def test_grep_endpoint_rejects_a_bad_regex(client: TestClient) -> None:
    response = client.get("/v1/rollouts/grep", params={"q": "(unclosed"})

    assert response.status_code == 422
    assert "invalid regex" in response.json()["detail"]
