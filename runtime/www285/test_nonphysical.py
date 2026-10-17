"""Nonphysical restart and empty-queue tests. The fake agent never launches a cell."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = Path(__file__).resolve().parent
FAKE = RUNTIME / "_fake_agent.py"


def write_fake(text: str) -> None:
    FAKE.write_text(
        "import sys\n"
        "sys.stdin.read()\n"
        f"sys.stdout.write({text!r})\n",
        encoding="utf-8",
    )


def main() -> None:
    scratch = ROOT / "research_control" / "_www285_test"
    if scratch.exists():
        shutil.rmtree(scratch)
    wave = scratch / "wave"
    (wave / "research_control").mkdir(parents=True)
    (wave / "control").mkdir()
    (wave / "execution_count.json").write_text(json.dumps({"executions": 33, "attempts": [1] * 33}), encoding="utf-8")
    (wave / "research_control" / "QUEUE.json").write_text(json.dumps({"cells": [{"run_id": "old", "status": "COMMITTED"}]}), encoding="utf-8")
    (wave / "research_control" / "SUPERVISOR_LOCK.json").write_text(json.dumps({"state": "RELEASED"}), encoding="utf-8")
    env = os.environ.copy()
    env["WWW285_ROOT"] = str(wave)
    env["WWW285_AGENT_CMD"] = str(FAKE)
    env["WWW285_PYTHON"] = sys.executable
    write_fake(json.dumps({
        "hypothesis_id": "H-header-overlap",
        "supporting_runs": ["slots2", "spade_v2_r3"],
        "scientific_question": "why slots=2 completes more 206s",
        "competing_explanation": "body overlap",
        "proposed_action_type": "WRITING",
        "contract": "development only",
        "falsifier": "a fixture gap above 15 percent",
        "budget": {"executions": 33, "cap": 44, "remaining": 11},
        "duplicate_lookup": "ledger 33",
        "safety_gate": "no physical cell",
    }))
    for _ in range(2):
        completed = subprocess.run([sys.executable, str(RUNTIME / "empty_queue_tick.py")], cwd=str(RUNTIME), env=env, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise SystemExit(completed.stderr)
    lines = (wave / "research_control" / "WWW285_DECISIONS.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    for line in lines:
        row = json.loads(line)
        assert row["physical"] is False
        assert row["ledger_unchanged"] is True
        assert row["state"] == "EMPTY_QUEUE_CONTINUED"
    assert json.loads((wave / "execution_count.json").read_text(encoding="utf-8"))["executions"] == 33
    write_fake(json.dumps({
        "hypothesis_id": "adaptive_second_header",
        "supporting_runs": [],
        "scientific_question": "q",
        "competing_explanation": "c",
        "proposed_action_type": "DEVELOPMENT_PHYSICAL_CELL",
        "contract": "adaptive_second_header",
        "falsifier": "f",
        "budget": {"executions": 33, "cap": 44, "remaining": 11},
        "duplicate_lookup": "d",
        "safety_gate": "g",
    }))
    completed = subprocess.run([sys.executable, str(RUNTIME / "empty_queue_tick.py")], cwd=str(RUNTIME), env=env, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr)
    gate = json.loads((wave / "control" / "WWW285_RESEARCH_TICK.json").read_text(encoding="utf-8"))["gate"]
    assert gate["physical"] is False and gate["accepted"] is False
    (wave / "research_control" / "SUPERVISOR_LOCK.json").write_text(json.dumps({"state": "RUNNING", "run_id": "live"}), encoding="utf-8")
    completed = subprocess.run([sys.executable, str(RUNTIME / "empty_queue_tick.py")], cwd=str(RUNTIME), env=env, text=True, capture_output=True, check=False)
    row = json.loads(completed.stdout)
    assert row["state"] == "DO_NOT_START_SECOND_EXECUTOR"
    assert row["model_called"] is False
    assert json.loads((wave / "execution_count.json").read_text(encoding="utf-8"))["executions"] == 33
    print("WWW285_NONEMPHYSICAL_TESTS_OK")


if __name__ == "__main__":
    main()
