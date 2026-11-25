# App-reported outcome records for the rollout-tap training plane (issue #33).
# The gateway tap never writes outcomes (fusion-gateway internal/rollout/tap.go:
# "backfilled by app-observable producers"), so the office apps report them here
# and the service appends them to a sink file in the same JSONL schema
# fusion-trainer's rollout_ingest consumes — no format changes on its side.

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Signal -> default reward; mirrors fusion-trainer dataset/rollout_ingest.py SIGNAL_SCORES.
SIGNAL_SCORES: dict[str, float] = {
    "task_success": 1.0,
    "user_accepted": 1.0,
    "user_edited": 0.5,
    "user_rejected": 0.0,
    "error": 0.0,
}

VALID_ROLES = ("user", "assistant", "system", "tool")


def default_sink() -> Path:
    return Path.home() / ".fusion-office" / "rollout-outcomes.jsonl"


def validate_record(record: Any) -> str | None:
    """The one invalid shape worth naming, or None when the record can be appended."""
    if not isinstance(record, dict):
        return "record must be a JSON object"
    if record.get("schema_version") != 1:
        return "schema_version must be 1"
    for key in ("rollout_id", "model"):
        value = record.get(key)
        if not isinstance(value, str) or not value.strip():
            return f"{key} must be a non-empty string"
    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        return "messages must be a non-empty array"
    for index, message in enumerate(messages):
        if (
            not isinstance(message, dict)
            or message.get("role") not in VALID_ROLES
            or not isinstance(message.get("content"), str)
        ):
            return f"messages[{index}] must be an object with a valid role and string content"
    outcome = record.get("outcome")
    if not isinstance(outcome, dict) or outcome.get("signal") not in SIGNAL_SCORES:
        return f"outcome.signal must be one of {sorted(SIGNAL_SCORES)}"
    return None


def append_record(path: Path, record: dict[str, Any]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with open(path, "a", encoding="utf-8") as sink:
        sink.write(line)
    return len(line.encode("utf-8"))
