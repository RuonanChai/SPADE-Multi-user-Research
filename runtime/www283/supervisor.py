"""F:-resident single physical executor for the WWW development queue.

The scheduler is this process, not the chat session. It refuses a second
live owner, will not relaunch a succeeded cell, and will not mark a failed
cell VALID.
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CAP = 44
ORIGIN = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com"
PROTECTED_PIDS = {65108}
RUN_CELL = Path(r"D:\Program\NSDI_SPADE_HARNESS\research\www_n3_276\runtime\run_cell.js")
ANALYZE = Path(r"D:\Program\NSDI_SPADE_HARNESS\research\www_n3_276")


def pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    import ctypes
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    return False


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class Supervisor:
    def __init__(self, root: Path, launcher=None, scorer=None, alive=None, free_bytes=None, find_cell=None):
        self.root = Path(root)
        self.rc = self.root / "research_control"
        self.lock_path = self.rc / "SUPERVISOR_LOCK.json"
        self.queue_path = self.rc / "QUEUE.json"
        self.heart_path = self.rc / "SUPERVISOR_HEARTBEAT.json"
        self.ledger_path = self.rc / "PHYSICAL_ATTEMPT_LEDGER.csv"
        self.counter_path = self.root / "execution_count.json"
        self.launcher = launcher or self._launch
        self.scorer = scorer or self._score
        self.alive = alive or pid_alive
        self.free_bytes = free_bytes or (lambda: __import__("shutil").disk_usage(self.root).free)
        self.find_cell = find_cell or (lambda run_id: None)
        self.pid = os.getpid()

    def load_json(self, path: Path, default):
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def executions(self) -> int:
        data = self.load_json(self.counter_path, {"executions": 0, "attempts": []})
        return int(data.get("executions") or 0)

    def known_attempts(self) -> set[str]:
        data = self.load_json(self.counter_path, {"attempts": []})
        return {row.get("run_id") for row in data.get("attempts") or []}

    def heartbeat(self, phase: str, run_id: str | None = None) -> None:
        atomic_write(self.heart_path, json.dumps({
            "pid": self.pid,
            "phase": phase,
            "run_id": run_id,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }, indent=2) + "\n")

    def acquire(self) -> tuple[bool, str]:
        self.rc.mkdir(parents=True, exist_ok=True)
        lock = self.load_json(self.lock_path, {})
        owner = lock.get("pid")
        if owner and owner != self.pid and self.alive(owner):
            return False, f"LOCK_HELD pid={owner}"
        if lock.get("run_id") and lock.get("state") == "RUNNING":
            other = self.find_cell(lock["run_id"])
            if other and self.alive(other):
                return False, f"CELL_STILL_RUNNING {lock['run_id']} pid={other}"
        atomic_write(self.lock_path, json.dumps({
            "pid": self.pid,
            "state": "IDLE",
            "run_id": None,
            "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }, indent=2) + "\n")
        atomic_write(self.root / "checkpoints" / "exclusive_executor.json", json.dumps({
            "held": True,
            "epoch": "WWW283",
            "scientific_executor_pid": self.pid,
            "reason": "WWW283 supervisor owns the physical queue",
        }, indent=2) + "\n")
        self.heartbeat("ACQUIRED")
        return True, "ACQUIRED"

    def release(self) -> None:
        lock = self.load_json(self.lock_path, {})
        if lock.get("pid") == self.pid:
            atomic_write(self.lock_path, json.dumps({
                "pid": None,
                "state": "RELEASED",
                "run_id": None,
                "released_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }, indent=2) + "\n")
            atomic_write(self.root / "checkpoints" / "exclusive_executor.json", json.dumps({
                "held": False,
                "epoch": "WWW283",
                "scientific_executor_pid": None,
                "reason": "supervisor queue drained or probe finished",
                "released_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }, indent=2) + "\n")

    def authorize(self, cell: dict) -> tuple[bool, str]:
        run_id = str(cell.get("run_id") or "")
        if cell.get("kind") == "formal_288" or "confirmatory_288" in run_id:
            return False, "UNAUTHORIZED_FORMAL"
        if not run_id.startswith("nsdi_N") or cell.get("scheduler") not in {"LRU", "SPADE", "SPADE_V2"}:
            return False, "UNAUTHORIZED_CONTRACT"
        if cell.get("scheduler") == "SPADE_V2" and int(cell.get("slots") or 0) != 2:
            return False, "SPADE_V2_CAP"
        if self.executions() >= CAP and run_id not in self.known_attempts():
            return False, "BUDGET_EXHAUSTED"
        if self.free_bytes() < 5 * 1024 ** 3:
            return False, "DISK_FULL"
        return True, "AUTHORIZED_DEVELOPMENT"

    def succeeded(self, run_id: str) -> bool:
        score_path = self.root / "metrics" / run_id / "score.json"
        if not score_path.exists():
            return False
        score = json.loads(score_path.read_text(encoding="utf-8"))
        clients = score.get("clients") or {}
        if not clients or score.get("treatment_leak"):
            return False
        return all((row or {}).get("verdict") == "VALID" for row in clients.values())

    def append_ledger(self, row: dict) -> None:
        fields = ["at", "run_id", "status", "exit_code", "attempts_used", "reason", "executions"]
        exists = self.ledger_path.exists()
        with self.ledger_path.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            if not exists:
                writer.writeheader()
            writer.writerow(row)

    def commit_queue(self, queue: dict) -> None:
        atomic_write(self.queue_path, json.dumps(queue, indent=2) + "\n")

    def run(self, dry: bool = False) -> int:
        ok, reason = self.acquire()
        if not ok:
            self.heartbeat("REFUSED", reason)
            print(reason)
            return 2
        try:
            queue = self.load_json(self.queue_path, {"cells": []})
            for cell in queue.get("cells") or []:
                run_id = cell["run_id"]
                if cell.get("status") in {"COMMITTED", "FAILED_TERMINAL", "SKIPPED_SUCCEEDED"}:
                    continue
                if self.succeeded(run_id):
                    cell["status"] = "SKIPPED_SUCCEEDED"
                    self.commit_queue(queue)
                    continue
                allowed, why = self.authorize(cell)
                if not allowed:
                    cell["status"] = "BLOCKED"
                    cell["reason"] = why
                    self.commit_queue(queue)
                    self.append_ledger({
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "run_id": run_id,
                        "status": "BLOCKED",
                        "exit_code": "",
                        "attempts_used": cell.get("attempts_used") or 0,
                        "reason": why,
                        "executions": self.executions(),
                    })
                    if why in {"BUDGET_EXHAUSTED", "DISK_FULL", "UNAUTHORIZED_FORMAL"}:
                        print(why)
                        return 3
                    continue
                if dry:
                    cell["status"] = "DRY_RUN_ELIGIBLE"
                    self.commit_queue(queue)
                    self.heartbeat("DRY_RUN", run_id)
                    continue
                max_attempts = int(cell.get("max_attempts") or 1)
                while int(cell.get("attempts_used") or 0) < max_attempts and cell.get("status") != "COMMITTED":
                    cell["status"] = "RUNNING"
                    cell["attempts_used"] = int(cell.get("attempts_used") or 0) + 1
                    self.commit_queue(queue)
                    atomic_write(self.lock_path, json.dumps({
                        "pid": self.pid,
                        "state": "RUNNING",
                        "run_id": run_id,
                        "attempt": cell["attempts_used"],
                    }, indent=2) + "\n")
                    self.heartbeat("RUNNING", run_id)
                    code = int(self.launcher(cell))
                    score = self.scorer(run_id)
                    valid = bool(score.get("valid")) and code == 0
                    if valid:
                        cell["status"] = "COMMITTED"
                        recorded = "COMMITTED"
                    elif cell["attempts_used"] >= max_attempts:
                        cell["status"] = "FAILED_TERMINAL"
                        recorded = "FAILED_TERMINAL"
                    else:
                        cell["status"] = "PENDING"
                        recorded = "RETRY"
                    self.commit_queue(queue)
                    self.append_ledger({
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "run_id": run_id,
                        "status": recorded,
                        "exit_code": code,
                        "attempts_used": cell["attempts_used"],
                        "reason": score.get("reason") or "",
                        "executions": self.executions(),
                    })
                    self.heartbeat(recorded, run_id)
                    if recorded != "RETRY":
                        break
            self.heartbeat("QUEUE_DRAINED")
            return 0
        finally:
            self.release()

    def _launch(self, cell: dict) -> int:
        cmd = [
            "node", str(RUN_CELL), cell["run_id"], "LRU", ORIGIN,
            cell.get("hop") or "vite_h1", str(cell["slots"]), str(cell["n"]), cell["scheduler"],
        ]
        proc = subprocess.run(cmd, cwd=str(RUN_CELL.parent), timeout=900)
        return int(proc.returncode)

    def _score(self, run_id: str) -> dict:
        sys.path.insert(0, str(ANALYZE))
        from analyze_g1 import score_run
        score = score_run(run_id)
        clients = score.get("clients") or {}
        valid = bool(clients) and not score.get("treatment_leak") and all(
            (row or {}).get("verdict") == "VALID" for row in clients.values()
        )
        reason = "VALID" if valid else "NOT_VALID"
        metrics_builder = self.root / "runtime" / "www280" / "build_metric_contract.py"
        if metrics_builder.exists():
            subprocess.run([sys.executable, str(metrics_builder)], cwd=str(metrics_builder.parent), timeout=120)
        return {"valid": valid, "reason": reason, "score": score}


def main() -> int:
    root = Path(os.environ.get("WWW283_ROOT") or r"F:\WWW_N3_MUX")
    sup = Supervisor(root)
    dry = "--dry-run" in sys.argv
    if "--probe" in sys.argv:
        ok, reason = sup.acquire()
        print(reason)
        if ok:
            sup.heartbeat("PROBE")
            sup.release()
        return 0 if ok else 2
    return sup.run(dry=dry)


if __name__ == "__main__":
    raise SystemExit(main())
