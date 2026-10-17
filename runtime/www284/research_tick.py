"""One research tick. Does not launch a physical cell by itself."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

WAVE = Path(os.environ.get("WWW284_ROOT") or r"F:\WWW_N3_MUX")
RC = WAVE / "research_control"


def atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def load(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def executions() -> int:
    data = load(WAVE / "execution_count.json", {"executions": 0})
    return int(data.get("executions") or 0)


def tick(now: str | None = None) -> dict:
    stamp = now or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    prior = load(RC / "RESEARCH_STATE.json", {})
    pause = (RC / "PAUSE.flag").exists()
    lock = load(RC / "SUPERVISOR_LOCK.json", {})
    if (
        not pause
        and lock.get("state") != "RUNNING"
        and prior.get("next_action") == "KEEP_ANALYZING_HEADER_OVERLAP_AND_VISIBLE_SPLATS"
        and prior.get("updated_at")
    ):
        atomic(RC / "LOCKS_AND_HEARTBEATS.json", {
            "driver_at": stamp,
            "driver_state": prior.get("state"),
            "supervisor": lock,
            "pause": pause,
            "skipped_duplicate": True,
        })
        return {"id": prior.get("last_decision_id"), "state": prior.get("state"), "next_action": prior.get("next_action"), "skipped_duplicate": True, "physical": False}
    queue_path = RC / "RESEARCH_QUEUE.jsonl"
    seen = set()
    if queue_path.exists():
        for line in queue_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                seen.add(json.loads(line).get("id"))
    decision_id = f"D{executions()}-{stamp.replace(':', '').replace('+', '')}"
    if decision_id in seen:
        decision_id = decision_id + "b"
    if pause:
        action = {
            "id": decision_id,
            "state": "PERMISSION_BLOCKED",
            "reason": "PAUSE.flag is present; no new cell will be launched",
            "next_action": "WAIT_FOR_PAUSE_CLEAR",
            "physical": False,
        }
    elif lock.get("state") == "RUNNING":
        action = {
            "id": decision_id,
            "state": "EXECUTE_PHYSICAL",
            "reason": "physical executor already owns a cell",
            "next_action": "DO_NOT_START_SECOND_EXECUTOR",
            "physical": False,
            "run_id": lock.get("run_id"),
        }
    elif not (WAVE / "results" / "DEVELOPMENT_MASTER.csv").exists():
        action = {
            "id": decision_id,
            "state": "ANALYZE",
            "reason": "required latency, completion, resource and visible-splat fields are not yet materialized",
            "next_action": "RUN_MEASURE_EXISTING",
            "physical": False,
        }
    else:
        action = {
            "id": decision_id,
            "state": "DECIDE_NEXT",
            "reason": "SPADE v1 matches slots=1 and header-release v2 did not restore completions. Empty physical queue is not a final decision.",
            "hypothesis": "two header-pending requests raise completions because header wait is about 160-270 ms while the body after the first byte is about 30 ms",
            "baseline": "Vite LRU slots=2",
            "next_action": "KEEP_ANALYZING_HEADER_OVERLAP_AND_VISIBLE_SPLATS",
            "physical": False,
            "executions": executions(),
            "remaining": 44 - executions(),
        }
    action["at"] = stamp
    action["input"] = "execution_count.json"
    append_jsonl(RC / "DECISION_LOG.jsonl", action)
    if action["id"] not in seen:
        append_jsonl(queue_path, action)
    new_state = {
        "epoch": "WWW284",
        "state": action["state"],
        "next_action": action["next_action"],
        "executions": executions(),
        "remaining": 44 - executions(),
        "active_cell": lock.get("run_id") if lock.get("state") == "RUNNING" else None,
        "physical_executor": "WWW283_SPADE_SUPERVISOR",
        "research_driver": "WWW284_RESEARCH_DRIVER",
        "confirmation_matrix": "NOT_FROZEN",
        "updated_at": stamp,
        "last_decision_id": action["id"],
    }
    atomic(RC / "RESEARCH_STATE.json", new_state)
    atomic(RC / "LOCKS_AND_HEARTBEATS.json", {
        "driver_at": stamp,
        "driver_state": action["state"],
        "supervisor": lock,
        "pause": pause,
    })
    return action


if __name__ == "__main__":
    print(json.dumps(tick(), ensure_ascii=False))
