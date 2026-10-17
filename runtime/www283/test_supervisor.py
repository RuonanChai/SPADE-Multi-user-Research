"""Nonphysical proofs for the single executor. No cell is launched."""

from __future__ import annotations

import json
import os
from pathlib import Path

import supervisor


def new_root(tmp: Path) -> supervisor.Supervisor:
    root = tmp
    root.mkdir(parents=True, exist_ok=True)
    (root / "execution_count.json").write_text(json.dumps({"executions": 27, "attempts": []}), encoding="utf-8")
    (root / "research_control").mkdir(parents=True)
    return root


def cell(run_id="nsdi_N3_LRU_coit_viteh1_s1_r1", scheduler="LRU", slots=1, n=3):
    return {
        "run_id": run_id,
        "hop": "vite_h1",
        "slots": slots,
        "n": n,
        "scheduler": scheduler,
        "max_attempts": 2,
        "status": "PENDING",
        "attempts_used": 0,
    }


def test_duplicate_rejected(tmp):
    root = new_root(tmp / "dup")
    first = supervisor.Supervisor(root, alive=lambda pid: pid == 111)
    first.pid = 111
    ok, _ = first.acquire()
    assert ok
    second = supervisor.Supervisor(root, alive=lambda pid: pid == 111)
    second.pid = 222
    ok2, reason = second.acquire()
    assert not ok2 and reason.startswith("LOCK_HELD")


def test_crashed_owner_can_resume(tmp):
    root = new_root(tmp / "crash")
    sup = supervisor.Supervisor(root, alive=lambda pid: False)
    (root / "research_control" / "SUPERVISOR_LOCK.json").write_text(json.dumps({
        "pid": 999001, "state": "RUNNING", "run_id": "nsdi_N3_LRU_coit_viteh1_s1_r1"
    }), encoding="utf-8")
    ok, reason = sup.acquire()
    assert ok and reason == "ACQUIRED"


def test_live_cell_preserved(tmp):
    root = new_root(tmp / "live")
    (root / "research_control" / "SUPERVISOR_LOCK.json").write_text(json.dumps({
        "pid": 50, "state": "RUNNING", "run_id": "nsdi_N3_LRU_coit_viteh1_s1_r1"
    }), encoding="utf-8")
    sup = supervisor.Supervisor(root, alive=lambda pid: pid == 77, find_cell=lambda run_id: 77)
    sup.pid = 88
    ok, reason = sup.acquire()
    assert not ok and "CELL_STILL_RUNNING" in reason


def test_idempotent_and_failed_not_valid(tmp):
    root = new_root(tmp / "idem")
    launched = []

    def launch(cell):
        launched.append(cell["run_id"])
        return 0

    def score(run_id):
        return {"valid": False, "reason": "NOT_VALID"}

    sup = supervisor.Supervisor(root, launcher=launch, scorer=score, alive=lambda pid: pid == os.getpid(), free_bytes=lambda: 10**12)
    queue = {"cells": [cell()]}
    (root / "research_control" / "QUEUE.json").write_text(json.dumps(queue), encoding="utf-8")
    assert sup.run(dry=False) == 0
    saved = json.loads((root / "research_control" / "QUEUE.json").read_text(encoding="utf-8"))
    assert saved["cells"][0]["status"] == "FAILED_TERMINAL"
    assert saved["cells"][0]["attempts_used"] == 2
    assert len(launched) == 2
    text = (root / "research_control" / "PHYSICAL_ATTEMPT_LEDGER.csv").read_text(encoding="utf-8")
    assert "VALID" not in text or "NOT_VALID" in text
    assert "COMMITTED" not in text


def test_success_not_rerun(tmp):
    root = new_root(tmp / "ok")
    run_id = "nsdi_N3_LRU_coit_viteh1_s1_r1"
    score_dir = root / "metrics" / run_id
    score_dir.mkdir(parents=True)
    (score_dir / "score.json").write_text(json.dumps({
        "treatment_leak": False,
        "clients": {"C3": {"verdict": "VALID"}},
    }), encoding="utf-8")
    launched = []
    sup = supervisor.Supervisor(
        root,
        launcher=lambda c: launched.append(c["run_id"]) or 0,
        scorer=lambda run_id: {"valid": True, "reason": "VALID"},
        alive=lambda pid: False,
        free_bytes=lambda: 10**12,
    )
    (root / "research_control" / "QUEUE.json").write_text(json.dumps({"cells": [cell(run_id)]}), encoding="utf-8")
    assert sup.run(dry=False) == 0
    assert launched == []
    saved = json.loads((root / "research_control" / "QUEUE.json").read_text(encoding="utf-8"))
    assert saved["cells"][0]["status"] == "SKIPPED_SUCCEEDED"


def test_unauthorized_and_disk(tmp):
    root = new_root(tmp / "deny")
    sup = supervisor.Supervisor(root, alive=lambda pid: False, free_bytes=lambda: 10**12)
    ok, why = sup.authorize({"run_id": "formal_288_x", "kind": "formal_288", "scheduler": "LRU"})
    assert not ok and why == "UNAUTHORIZED_FORMAL"
    sup.free_bytes = lambda: 100
    ok, why = sup.authorize(cell())
    assert not ok and why == "DISK_FULL"
    (root / "execution_count.json").write_text(json.dumps({"executions": 44, "attempts": []}), encoding="utf-8")
    sup.free_bytes = lambda: 10**12
    ok, why = sup.authorize(cell())
    assert not ok and why == "BUDGET_EXHAUSTED"


def test_atomic_dry_run(tmp):
    root = new_root(tmp / "dry")
    sup = supervisor.Supervisor(root, alive=lambda pid: False, free_bytes=lambda: 10**12)
    (root / "research_control" / "QUEUE.json").write_text(json.dumps({"cells": [cell()]}), encoding="utf-8")
    assert sup.run(dry=True) == 0
    saved = json.loads((root / "research_control" / "QUEUE.json").read_text(encoding="utf-8"))
    assert saved["cells"][0]["status"] == "DRY_RUN_ELIGIBLE"
    assert saved["cells"][0]["attempts_used"] == 0


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        test_duplicate_rejected(tmp)
        test_crashed_owner_can_resume(tmp)
        test_live_cell_preserved(tmp)
        test_idempotent_and_failed_not_valid(tmp)
        test_success_not_rerun(tmp)
        test_unauthorized_and_disk(tmp)
        test_atomic_dry_run(tmp)
    print("SUPERVISOR_TESTS_OK")
