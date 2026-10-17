"""Nonphysical acceptance checks for the research driver."""

from __future__ import annotations

import json
import os
from pathlib import Path

import research_tick


def fresh(tmp: Path) -> None:
    os.environ["WWW284_ROOT"] = str(tmp)
    research_tick.WAVE = tmp
    research_tick.RC = tmp / "research_control"
    (tmp / "research_control").mkdir(parents=True, exist_ok=True)
    (tmp / "execution_count.json").write_text(json.dumps({"executions": 33, "attempts": []}), encoding="utf-8")
    (tmp / "results").mkdir()
    (tmp / "results" / "DEVELOPMENT_MASTER.csv").write_text("run_id\n", encoding="utf-8")


def test_empty_queue_decides(tmp: Path) -> None:
    fresh(tmp / "empty")
    first = research_tick.tick("2026-10-17T08:00:00+0800")
    assert first["state"] == "DECIDE_NEXT"
    assert first["physical"] is False
    second = research_tick.tick("2026-10-17T08:05:00+0800")
    assert second.get("skipped_duplicate") is True
    lines = (tmp / "empty" / "research_control" / "DECISION_LOG.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1


def test_restart_no_duplicate(tmp: Path) -> None:
    root = tmp / "restart"
    fresh(root)
    research_tick.tick("2026-10-17T08:00:00+0800")
    # New process: reload module state by calling tick again after skip window is not met,
    # the duplicate guard must still keep one decision.
    research_tick.tick("2026-10-17T08:10:00+0800")
    lines = (root / "research_control" / "RESEARCH_QUEUE.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1


def test_pause_blocks_launch(tmp: Path) -> None:
    root = tmp / "pause"
    fresh(root)
    (root / "research_control" / "PAUSE.flag").write_text("pause\n", encoding="utf-8")
    action = research_tick.tick("2026-10-17T08:00:00+0800")
    assert action["state"] == "PERMISSION_BLOCKED"
    assert action["physical"] is False


def test_running_cell_not_duplicated(tmp: Path) -> None:
    root = tmp / "live"
    fresh(root)
    (root / "research_control" / "SUPERVISOR_LOCK.json").write_text(json.dumps({
        "state": "RUNNING", "run_id": "nsdi_live", "pid": 1
    }), encoding="utf-8")
    action = research_tick.tick("2026-10-17T08:00:00+0800")
    assert action["next_action"] == "DO_NOT_START_SECOND_EXECUTOR"
    assert action["physical"] is False


def test_disk_full_fails_closed(tmp: Path) -> None:
    root = tmp / "disk"
    fresh(root)
    real_atomic = research_tick.atomic

    def refuse(path, payload):
        if "RESEARCH_STATE" in path.name:
            raise OSError("disk full")
        real_atomic(path, payload)

    research_tick.atomic = refuse
    try:
        try:
            research_tick.tick("2026-10-17T08:00:00+0800")
            raised = False
        except OSError:
            raised = True
        assert raised
        assert not (root / "C_DRIVE_FALLBACK").exists()
    finally:
        research_tick.atomic = real_atomic


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        test_empty_queue_decides(base)
        test_restart_no_duplicate(base)
        test_pause_blocks_launch(base)
        test_running_cell_not_duplicated(base)
        test_disk_full_fails_closed(base)
    print("DRIVER_TESTS_OK")
