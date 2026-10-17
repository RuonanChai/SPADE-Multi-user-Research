"""Empty physical queue triggers one research decision. Never a second executor."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import validate_decision

WAVE = Path(os.environ.get("WWW285_ROOT") or r"F:\WWW_N3_MUX")
RC = WAVE / "research_control"
PROMPT = Path(__file__).with_name("research_prompt.txt")
AGENT = os.environ.get("WWW285_AGENT_CMD") or r"C:\Users\IoT\AppData\Local\cursor-agent\agent.cmd"


def atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def load(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def executions() -> int:
    return int(load(WAVE / "execution_count.json", {"executions": 0})["executions"])


def pending_cells() -> list:
    queue = load(RC / "QUEUE.json", {"cells": []})
    return [cell for cell in queue.get("cells", []) if cell.get("status") in {"PENDING", "RUNNING"}]


def run_model(prompt: str) -> tuple[int, str]:
    if AGENT.endswith(".py"):
        completed = subprocess.run([os.environ.get("WWW285_PYTHON") or "python", AGENT], input=prompt, text=True, capture_output=True, check=False)
    else:
        completed = subprocess.run(
            [AGENT, "-p", "--output-format", "text", "--mode", "ask", "--trust", "--workspace", str(WAVE), prompt],
            text=True,
            capture_output=True,
            check=False,
        )
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def tick(now: str | None = None) -> dict:
    stamp = now or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    before = executions()
    pause = (RC / "PAUSE.flag").exists()
    lock = load(RC / "SUPERVISOR_LOCK.json", {})
    pending = pending_cells()
    record = {
        "at": stamp,
        "executions_before": before,
        "task_account": os.environ.get("USERNAME") or os.environ.get("USER") or "",
        "physical": False,
        "second_executor": False,
    }
    if pause:
        record.update(state="PERMISSION_BLOCKED", reason="PAUSE.flag", model_called=False)
    elif lock.get("state") == "RUNNING":
        record.update(state="DO_NOT_START_SECOND_EXECUTOR", reason="WWW283 lock is RUNNING", model_called=False, run_id=lock.get("run_id"))
    elif pending:
        record.update(state="QUEUE_NONEMPTY", reason="pending physical cells remain with the sole executor", model_called=False, pending=[cell.get("run_id") for cell in pending])
    else:
        prompt = PROMPT.read_text(encoding="utf-8")
        code, raw = run_model(prompt)
        raw_path = RC / "www285_model_raw.txt"
        raw_path.write_text(raw, encoding="utf-8")
        record.update(model_called=True, model_exit=code, raw_path=str(raw_path))
        try:
            proposal = validate_decision.extract_json(raw)
            gate = validate_decision.validate(proposal, executions=before)
        except (ValueError, json.JSONDecodeError) as exc:
            gate = {"accepted": False, "physical": False, "reason": str(exc), "fallback_action_type": "OFFLINE_ANALYSIS"}
        record.update(state="EMPTY_QUEUE_CONTINUED", gate=gate, reason=gate.get("reason"))
        atomic(WAVE / "control" / "WWW285_RESEARCH_TICK.json", {
            "epoch": "WWW285",
            "at": stamp,
            "model_exit": code,
            "auth_status": "AUTHENTICATED_ONLY_AFTER_TASK_CONTEXT_SMOKE_PASS",
            "gate": gate,
            "physical_launched": False,
            "executions": before,
        })
    after = executions()
    record["executions_after"] = after
    record["ledger_unchanged"] = before == after
    if before != after:
        raise RuntimeError("research tick changed the physical ledger")
    decisions = RC / "WWW285_DECISIONS.jsonl"
    with decisions.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


if __name__ == "__main__":
    print(json.dumps(tick(), ensure_ascii=False))
