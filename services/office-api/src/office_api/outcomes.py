# App-reported outcome records for the rollout-tap training plane (issue #33).
# The gateway tap never writes outcomes (fusion-gateway internal/rollout/tap.go:
# "backfilled by app-observable producers"), so the office apps report them here
# and the service appends them to a sink file in the same JSONL schema
# fusion-trainer's rollout_ingest consumes — no format changes on its side.

from __future__ import annotations

import json
import logging
import re
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

# Validator records (#48, fusion-trainer#111): a generated OOXML-level checker
# rides with the trajectory as a versioned, re-runnable record instead of
# staying ephemeral. Status is the validator's own test status against the
# known-valid corpus (issue #49); the trainer's audit gate reads it.
VALIDATOR_STATUSES = ("untested", "passing", "failing")


def default_sink() -> Path:
    return Path.home() / ".fusion-office" / "rollout-outcomes.jsonl"


def validate_record(record: Any) -> str | None:
    """The one invalid shape worth naming, or None when the record can be appended."""
    if not isinstance(record, dict):
        return "record must be a JSON object"
    if record.get("schema_version") not in (1, 2):
        return "schema_version must be 1 or 2"
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
    # schema_version 2 additive fields (#48); tolerated as absent on version 1.
    env_state = record.get("env_state")
    if env_state is not None and not isinstance(env_state, dict):
        return "env_state must be an object (file paths, hashes, working dir)"
    validator = record.get("validator")
    if validator is not None:
        if not isinstance(validator, dict):
            return "validator must be an object with name, version and status"
        for key in ("name", "version"):
            value = validator.get(key)
            if not isinstance(value, str) or not value.strip():
                return f"validator.{key} must be a non-empty string"
        if validator.get("status") not in VALIDATOR_STATUSES:
            return f"validator.status must be one of {list(VALIDATOR_STATUSES)}"
    return None


def append_record(path: Path, record: dict[str, Any]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with open(path, "a", encoding="utf-8") as sink:
        sink.write(line)
    return len(line.encode("utf-8"))


def grep_sink(path: Path, pattern: str, limit: int = 20) -> dict[str, Any]:
    """Grep-style retrieval over the append-only rollout sink (issue #45, GrepMem).

    Office tasks are strongly cross-session; the sink is a lossless log of
    what the apps actually did, so a regex over its lines recovers exact
    facts (model, rollout ids, signals, redacted transcript shapes) without
    any new storage. Lines that fail to parse still match as raw text.
    """
    regex = re.compile(pattern)
    matches: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as sink:
        for line_number, line in enumerate(sink, 1):
            if not regex.search(line):
                continue
            try:
                record: Any = json.loads(line)
            except json.JSONDecodeError:
                record = None
                log.warning("sink line %d is not valid JSON; matched as raw text", line_number)
            matches.append({"line": line_number, "record": record})
            if len(matches) >= limit:
                break
    return {"matches": matches, "pattern": pattern, "truncated": len(matches) >= limit}
