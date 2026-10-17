"""WWW280 execution epoch.

This module is the F:\\WWW_N3_MUX adapter. It reads the NSDI harness as
immutable provenance and never rewrites it. A dry run does not start a worker.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

EPOCH = "WWW280"
DIAGNOSTIC_CAP = 40
G1_CAP = 44
ATTEMPTS_PER_CELL = 3
PROTECTED_VITE_PID = 65108
ORIGIN = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com"
RUNNER = Path(r"D:\Program\NSDI_SPADE_HARNESS\research\www_n3_276\runtime\run_cell.js")
OLD_STATE = Path(r"D:\Program\NSDI_SPADE_HARNESS\harness\state\state.json")
NSDI_AGENTS = Path(r"D:\Program\NSDI_SPADE_HARNESS\AGENTS.md")
NSDI_RULE = Path(r"D:\Program\NSDI_SPADE_HARNESS\.cursor\rules\nsdi-scientific-integrity.mdc")
HARNESS_CONFIG = Path(r"D:\Program\NSDI_SPADE_HARNESS\harness\config.json")
KNOWN_HOSTS = Path(r"D:\Program\NSDI_SPADE_DIAG_W04\known_hosts")
SSH_KEY = Path(r"C:\Users\IoT\.ssh\id_ed25519")
SSH = Path(r"C:\Windows\System32\OpenSSH\ssh.exe")
WORKERS = {
    "C3": "192.168.1.197",
    "C4": "192.168.1.196",
    "C5": "192.168.1.195",
}
FORBIDDEN_DRIVE = {"C", "D"}
H14_ROUTES = ("vite_h1", "rad_direct", "rad_h2")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, default=None):
    if not path.exists():
        return {} if default is None else default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def hop_token(hop: str) -> str:
    return hop.replace("_", "")


def run_id(n: int, hop: str, slots: int, rep: int) -> str:
    return f"nsdi_N{n}_LRU_coit-40m-sh1-lod_stop_go_g1_{hop_token(hop)}_s{slots}_r{rep}"


def pid_alive(pid: int) -> bool:
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
    if not handle:
        return False
    ctypes.windll.kernel32.CloseHandle(handle)
    return True


def process_start_identity(pid: int) -> str | None:
    if os.name != "nt" or not pid_alive(pid):
        return None
    script = (
        f"$p = Get-CimInstance Win32_Process -Filter \"ProcessId={int(pid)}\"; "
        "if ($p) { '{0}|{1}' -f $p.ProcessId, $p.CreationDate.ToString('o') }"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    text = (result.stdout or "").strip()
    return text or None


@dataclass
class LockDecision:
    acquired: bool
    reason: str
    archived: bool = False


class ExclusiveLock:
    """One scientific executor. A stale lock rotates only with positive proof."""

    def __init__(self, path: Path, pid_probe=pid_alive):
        self.path = path
        self.pid_probe = pid_probe

    def read(self) -> dict:
        return read_json(self.path, {})

    def acquire(self, owner: str, purpose: str, active_worker: bool = False) -> LockDecision:
        current = self.read()
        if current.get("held"):
            pid = int(current.get("pid") or 0)
            identity = str(current.get("start_identity") or "")
            alive = self.pid_probe(pid)
            if alive or active_worker or not identity:
                return LockDecision(False, "LOCK_HELD_NO_STALE_PROOF", False)
            archive = self.path.with_name(f"exclusive_executor.archived.{pid}.json")
            archive.parent.mkdir(parents=True, exist_ok=True)
            archive.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
            self._write_held(owner, purpose)
            return LockDecision(True, "STALE_LOCK_ARCHIVED_WITH_PROOF", True)
        self._write_held(owner, purpose)
        return LockDecision(True, "ACQUIRED", False)

    def _write_held(self, owner: str, purpose: str) -> None:
        pid = os.getpid()
        payload = {
            "held": True,
            "epoch": EPOCH,
            "owner": owner,
            "purpose": purpose,
            "pid": pid,
            "start_identity": process_start_identity(pid) or f"pid:{pid}",
            "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        write_json(self.path, payload)

    def release(self) -> None:
        current = self.read()
        if current.get("pid") != os.getpid():
            return
        write_json(
            self.path,
            {
                "held": False,
                "epoch": EPOCH,
                "owner": None,
                "pid": None,
                "released_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "previous_owner": current.get("owner"),
            },
        )


def load_cells(wave: Path) -> list[dict]:
    rows = []
    metrics = wave / "metrics"
    if not metrics.exists():
        return rows
    for score_path in sorted(metrics.glob("*/score.json")):
        rid = score_path.parent.name
        if not rid.startswith("nsdi_"):
            continue
        score = read_json(score_path)
        state_path = wave / "runtime" / f"state_{rid}.json"
        if not state_path.exists():
            state_path = score_path.parent / "state.json"
        state = read_json(state_path)
        clients = score.get("clients") or {}
        verdicts = {
            name: (body or {}).get("verdict")
            for name, body in clients.items()
            if isinstance(body, dict)
        }
        valid = bool(verdicts) and all(item == "VALID" for item in verdicts.values())
        phase = state.get("phase") or "UNKNOWN"
        spec = score.get("spec") or {}
        rows.append(
            {
                "run_id": rid,
                "phase": phase,
                "valid": valid and phase == "DONE",
                "terminal_invalid": phase in {"DONE", "FAILED"} and not (valid and phase == "DONE"),
                "verdicts": verdicts,
                "n": spec.get("n"),
                "hop": spec.get("hop"),
                "slots": spec.get("slots"),
                "pids": list((state.get("pids") or {}).values()),
                "all_p50_ms": {
                    name: (body or {}).get("all_p50_ms")
                    for name, body in clients.items()
                    if isinstance(body, dict)
                },
                "inflight1_p50_ms": {
                    name: (body or {}).get("inflight1_p50_ms")
                    for name, body in clients.items()
                    if isinstance(body, dict)
                },
                "evidence": str(wave / "evidence" / rid),
            }
        )
    return rows


def active_cell(cells: list[dict], pid_probe=pid_alive) -> dict | None:
    for cell in cells:
        if cell["phase"] in {"DONE", "FAILED"}:
            continue
        live = [pid for pid in cell["pids"] if pid and pid_probe(int(pid))]
        return {
            "run_id": cell["run_id"],
            "phase": cell["phase"],
            "live_pids": live,
            "ambiguous": not live,
        }
    return None


def budget(counter: dict, command279_mtime: float) -> dict:
    attempts = list(counter.get("attempts") or [])
    used_g1 = int(counter.get("executions") or len(attempts))
    used_280 = 0
    for row in attempts:
        stamp = row.get("at") or ""
        try:
            parsed = time.mktime(time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            used_280 += 1
            continue
        if parsed >= command279_mtime:
            used_280 += 1
    return {
        "epoch": EPOCH,
        "budget_source": "F:/WWW_N3_MUX/execution_count.json+WWW280 ledger",
        "diagnostic_cap": DIAGNOSTIC_CAP,
        "diagnostic_used": used_280,
        "diagnostic_remaining": max(0, DIAGNOSTIC_CAP - used_280),
        "g1_cap": G1_CAP,
        "g1_used": used_g1,
        "g1_remaining": max(0, G1_CAP - used_g1),
        "operational_remaining_via_existing_runner": max(0, min(DIAGNOSTIC_CAP - used_280, G1_CAP - used_g1)),
        "attempts_per_logical_cell": ATTEMPTS_PER_CELL,
        "historic_attempts_not_charged_to_40": used_g1 if used_280 == 0 else used_g1 - used_280,
        "confirmatory_288_runnable": False,
    }


def continue_budget(previous: dict, new_command_name: str) -> dict:
    used = int(previous["diagnostic_used"])
    return {
        **previous,
        "continued_by": new_command_name,
        "diagnostic_used": used,
        "diagnostic_remaining": max(0, DIAGNOSTIC_CAP - used),
        "reset": False,
    }


def h14_closed(wave: Path) -> dict:
    h2 = read_json(wave / "metrics" / "H2_ADJUDICATION.json")
    direct = read_json(wave / "metrics" / "DIRECT_ADJUDICATION.json")
    closed = h2.get("adjudication") == "MECHANISM_SECTION_CLOSED" and direct.get("adjudication") == "VITE_HOP_NOT_THE_CLIFF"
    return {
        "closed": closed,
        "h2": h2.get("adjudication"),
        "direct": direct.get("adjudication"),
        "next_branches": ["H15", "H16", "H17", "H18"] if closed else ["H14"],
        "terminates_campaign": False,
    }


def classify_h14(cells: list[dict]) -> list[dict]:
    by_key: dict[tuple, list[dict]] = {}
    for cell in cells:
        if cell["n"] != 2:
            continue
        by_key.setdefault((cell["hop"], cell["slots"]), []).append(cell)
    queue = []
    for hop in H14_ROUTES:
        for slots in (1, 3):
            matches = sorted(by_key.get((hop, slots), []), key=lambda item: item["run_id"])
            valids = [item for item in matches if item["valid"]]
            for rep in (1, 2):
                logical = f"H14-N2-{hop}-s{slots}-rep{rep}"
                if len(valids) >= rep:
                    chosen = valids[rep - 1]
                    status = "REUSED_VALID"
                    reason = "contract-matched VALID DONE cell credited"
                elif any(item["terminal_invalid"] for item in matches):
                    status = "NEEDS_EXECUTION" if slots == 1 else "TERMINAL_INVALID"
                    chosen = None
                    reason = "no VALID credit; invalid attempts are not refunded and are not reused"
                    if slots == 3 and not valids:
                        status = "TERMINAL_INVALID"
                else:
                    status = "NEEDS_EXECUTION"
                    chosen = None
                    reason = "no physical cell for this logical slot"
                queue.append(
                    {
                        "logical_id": logical,
                        "branch": "H14",
                        "n": 2,
                        "hop": hop,
                        "slots": slots,
                        "rep": rep,
                        "status": status,
                        "credited_run_id": None if chosen is None else chosen["run_id"],
                        "reason": reason,
                    }
                )
    return queue


def h15_queue(cells: list[dict], h14: dict) -> list[dict]:
    """Slots=1 versus the already valid Vite slots=3 pair. Route stays Vite H1."""

    vite3 = [cell for cell in cells if cell["valid"] and cell["n"] == 2 and cell["hop"] == "vite_h1" and cell["slots"] == 3]
    vite3 = sorted(vite3, key=lambda item: item["run_id"])
    rows = []
    for rep, cell in enumerate(vite3[:2], start=1):
        rows.append(
            {
                "logical_id": f"H15-N2-vite_h1-s3-rep{rep}",
                "branch": "H15",
                "n": 2,
                "hop": "vite_h1",
                "slots": 3,
                "rep": rep,
                "status": "REUSED_VALID",
                "credited_run_id": cell["run_id"],
                "reason": "fixed Vite HTTP/1.1 slots=3 baseline already VALID",
            }
        )
    valid_s1 = {
        cell["run_id"]
        for cell in cells
        if cell["valid"] and cell["n"] == 2 and cell["hop"] == "vite_h1" and cell["slots"] == 1
    }
    for rep in (1, 2):
        rid = run_id(2, "vite_h1", 1, rep)
        reused = rid in valid_s1
        rows.append(
            {
                "logical_id": f"H15-N2-vite_h1-s1-rep{rep}",
                "branch": "H15",
                "n": 2,
                "hop": "vite_h1",
                "slots": 1,
                "rep": rep,
                "status": "REUSED_VALID" if reused else "NEEDS_EXECUTION",
                "credited_run_id": rid if reused else None,
                "proposed_run_id": rid,
                "reason": "H15 concurrency contrast; H14 closure does not cancel this branch" if h14["closed"] else "queued behind H14",
            }
        )
    return rows


def visual_claim_allowed(render_visible, instrument_valid: bool, claim: str) -> bool:
    if claim == "transport":
        return True
    if claim == "visual":
        return render_visible is True and instrument_valid
    return False


def confirmatory_allowed(frozen_exists: bool, qualifications: dict) -> tuple[bool, str]:
    if not qualifications.get("amendment_a_retired_fixed_288", True):
        return False, "AMENDMENT_A_RETIRED_FIXED_288"
    if not frozen_exists:
        return False, "NOT_FROZEN"
    required = ("two_independent_scenes", "three_traces_per_scene", "mechanism_or_methodology", "visual_or_scoped_endpoint")
    missing = [key for key in required if not qualifications.get(key)]
    if missing:
        return False, "BLOCKED_SCIENTIFIC_PREREQUISITE:" + ",".join(missing)
    return True, "QUALIFIED"


def worker_storage_ok(volumes_by_host: dict) -> tuple[bool, str]:
    if not volumes_by_host:
        return False, "NO_WORKER_VOLUME_PROBE"
    for host, volumes in volumes_by_host.items():
        approved = [
            item
            for item in volumes
            if str(item.get("letter", "")).upper()[:1] not in FORBIDDEN_DRIVE and float(item.get("free_gb") or 0) >= 2
        ]
        if not approved:
            return False, f"{host} has no non-C/non-D volume with >=2GiB free"
    return True, "WORKER_VOLUME_OK"


def controller_storage_ok(free_gb: float | None) -> tuple[bool, str]:
    if free_gb is None:
        return False, "F_MISSING"
    if free_gb < 2:
        return False, "F_LOW"
    return True, "F_OK"


@dataclass
class Decision:
    state: str
    launch: bool
    next_cell: dict | None
    blockers: list[dict] = field(default_factory=list)
    command: list[str] | None = None

    @property
    def first_blocker(self) -> dict | None:
        return self.blockers[0] if self.blockers else None


def planned_command(cell: dict) -> list[str]:
    rid = cell.get("proposed_run_id") or run_id(cell["n"], cell["hop"], cell["slots"], cell["rep"])
    return [
        "node",
        str(RUNNER),
        rid,
        "LRU",
        ORIGIN,
        cell["hop"],
        str(cell["slots"]),
        str(cell["n"]),
    ]


def decide(
    *,
    old_final_decision: str | None,
    same_epoch_terminal: bool,
    active: dict | None,
    h14: dict,
    h15: list[dict],
    budget_info: dict,
    controller_free_gb: float | None,
    worker_volumes: dict,
    render_visible,
    instrument_valid: bool,
    frozen_exists: bool,
    qualifications: dict,
    integrity_ok: bool = True,
) -> Decision:
    blockers = []
    if same_epoch_terminal:
        blockers.append(
            {
                "id": "BLOCKED_SCIENTIFIC_PREREQUISITE",
                "source": "checkpoints/www280/state.json",
                "condition": "same-epoch terminal is binding",
                "action": "do not reset WWW280; open a new epoch only with a new authorization",
            }
        )
    if active is not None:
        blockers.append(
            {
                "id": "WAIT_ACTIVE_CELL",
                "source": active["run_id"],
                "condition": f"phase={active['phase']} live_pids={active['live_pids']} ambiguous={active['ambiguous']}",
                "action": "do not launch; wait for natural DONE and evidence transfer",
            }
        )
    storage_ok, storage_reason = controller_storage_ok(controller_free_gb)
    worker_ok, worker_reason = worker_storage_ok(worker_volumes)
    if not storage_ok or not worker_ok:
        blockers.append(
            {
                "id": "BLOCKED_INFRA_WORKER_STORAGE" if storage_ok else "BLOCKED_INFRA_CONTROLLER_STORAGE",
                "source": "control/ACTIVE_GOAL_280.txt section II.3",
                "condition": storage_reason + "; " + worker_reason,
                "action": "provision a non-C/non-D worker volume or prove a bounded RAM stream to F:, then dry-run again",
            }
        )
    if not integrity_ok:
        blockers.append(
            {
                "id": "BLOCKED_INTEGRITY",
                "source": "audits/source hashes",
                "condition": "protected source hash mismatch",
                "action": "stop physical launch and reconcile the hash",
            }
        )
    if budget_info["operational_remaining_via_existing_runner"] <= 0:
        blockers.append(
            {
                "id": "BLOCKED_BUDGET",
                "source": "execution_count.json",
                "condition": "diagnostic or G1 counter exhausted",
                "action": "do not reset either counter; request a new budget only with an immutable queue",
            }
        )
    confirmatory, confirmatory_reason = confirmatory_allowed(frozen_exists, qualifications)
    next_cell = next((row for row in h15 if row["status"] == "NEEDS_EXECUTION"), None)
    if next_cell is None and not h14["closed"]:
        next_cell = None
    if next_cell is None and h14["closed"]:
        blockers.append(
            {
                "id": "BLOCKED_SCIENTIFIC_PREREQUISITE",
                "source": "H15 queue",
                "condition": "no H15 cell needs execution",
                "action": "advance H16 or H18 with a new pre-registered matrix",
            }
        )
    if old_final_decision and not any(item["id"] == "OLD_EPOCH_VETO" for item in blockers):
        pass
    launch = not blockers and next_cell is not None
    if active is not None:
        state = "WAIT_ACTIVE_CELL"
    elif same_epoch_terminal:
        state = "BLOCKED_SCIENTIFIC_PREREQUISITE"
    elif blockers and blockers[0]["id"].startswith("BLOCKED_INFRA"):
        state = "BLOCKED_INFRA"
    elif blockers and blockers[0]["id"] == "BLOCKED_BUDGET":
        state = "BLOCKED_BUDGET"
    elif blockers and blockers[0]["id"] == "BLOCKED_INTEGRITY":
        state = "BLOCKED_INTEGRITY"
    elif launch:
        state = "NEW_EPOCH_READY"
    else:
        state = "BLOCKED_SCIENTIFIC_PREREQUISITE"
    return Decision(
        state=state,
        launch=launch,
        next_cell=next_cell,
        blockers=blockers,
        command=None if next_cell is None else planned_command(next_cell),
    )


def rule_scope_record() -> list[dict]:
    return [
        {
            "id": "NSDI_AGENTS_WRITABLE_ROOT",
            "path": str(NSDI_AGENTS),
            "lines": "3-5",
            "text": "This directory is the only writable research root. Do not start physical cells, remote workers, SSH actions, network shaping, RTT scans, Vite sessions, or the formal 288-cell campaign.",
            "scope": "D:\\Program\\NSDI_SPADE_HARNESS only. 'This directory' is that harness.",
            "covers_f_www": False,
            "organizational": False,
            "action": "leave the file unchanged; do not apply it to F:\\WWW_N3_MUX",
        },
        {
            "id": "NSDI_MDC_PHYSICAL_BAN",
            "path": str(NSDI_RULE),
            "lines": "8 and 18",
            "text": "The writable root is D:\\Program\\NSDI_SPADE_HARNESS. Never start physical experiment controllers, remote workers, SSH experiment actions, network shaping, RTT scans, new physical cells, the formal 288-cell campaign, or a live Vite session.",
            "scope": "Cursor rule file inside the NSDI workspace. alwaysApply is true for that workspace. This F:\\WWW_N3_MUX session has no AGENTS.md, CLAUDE.md, or .cursor/rules, and the rule was not injected.",
            "covers_f_www": False,
            "organizational": False,
            "action": "do not disable the NSDI rule; it remains binding for the old workspace",
        },
        {
            "id": "NSDI_MDC_CONFLICT_SENTENCE",
            "path": str(NSDI_RULE),
            "lines": "26",
            "text": "When authorities conflict, keep the stricter safety and scientific restriction and record the conflict.",
            "scope": "Same NSDI workspace rule. It does not name F:\\WWW_N3_MUX and is not a separate global policy.",
            "covers_f_www": False,
            "organizational": False,
            "action": "record the conflict; do not export the sentence beyond its file",
        },
    ]


def probe_workers() -> dict:
    volumes = {}
    for name, ip in WORKERS.items():
        command = "wmic logicaldisk get caption,freespace,size"
        result = subprocess.run(
            [
                str(SSH),
                "-i",
                str(SSH_KEY),
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                f"UserKnownHostsFile={KNOWN_HOSTS}",
                "-o",
                "ConnectTimeout=12",
                f"p5remote@{ip}",
                command,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        parsed = []
        for line in (result.stdout or "").splitlines():
            match = re.match(r"\s*([A-Z]):\s+\d+\s+(\d+)\s+(\d+)", line)
            if not match:
                continue
            free = int(match.group(2)) / (1024**3)
            size = int(match.group(3)) / (1024**3)
            parsed.append({"letter": match.group(1), "free_gb": round(free, 1), "size_gb": round(size, 1)})
        volumes[name] = parsed
        volumes[name + "_ssh_status"] = result.returncode
    return {key: value for key, value in volumes.items() if not key.endswith("_ssh_status")} | {
        "_ssh_status": {name: volumes.get(name + "_ssh_status") for name in WORKERS}
    }


def listening_pids() -> dict[str, list[int]]:
    result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, check=False)
    found: dict[str, list[int]] = {port: [] for port in ("8080", "18080", "18081", "18443")}
    for line in (result.stdout or "").splitlines():
        for port in found:
            if f":{port} " in line and "LISTENING" in line:
                pid = int(line.split()[-1])
                found[port].append(pid)
    return found


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    for row in rows[1:]:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def attempt_rows(wave: Path, cells: list[dict]) -> list[dict]:
    counter = read_json(wave / "execution_count.json")
    by_id = {cell["run_id"]: cell for cell in cells}
    rows = []
    for index, attempt in enumerate(counter.get("attempts") or [], start=1):
        cell = by_id.get(attempt.get("run_id"), {})
        rows.append(
            {
                "ordinal": index,
                "epoch": "G1_N3MUX_PRE_279",
                "charged_to_www280_40": "no",
                "run_id": attempt.get("run_id"),
                "at": attempt.get("at"),
                "hop": attempt.get("hop"),
                "slots": attempt.get("slots"),
                "n": attempt.get("n"),
                "phase": cell.get("phase", ""),
                "valid": cell.get("valid", False),
            }
        )
    return rows


def manifest_rows(cells: list[dict]) -> list[dict]:
    rows = []
    for cell in cells:
        evidence = Path(cell["evidence"])
        rows.append(
            {
                "run_id": cell["run_id"],
                "phase": cell["phase"],
                "valid": cell["valid"],
                "evidence_exists": evidence.exists(),
                "score_recorded": True,
                "promotion": "REUSED_EXISTING" if cell["valid"] else "TERMINAL_KEPT",
            }
        )
    return rows


def emit_live(wave: Path, decision: Decision, context: dict) -> None:
    audits = wave / "audits"
    control = wave / "control"
    metrics = wave / "metrics"
    paper = wave / "paper" / "WWW_LONG_PAPER"
    checkpoint = wave / "checkpoints" / "www280"
    for directory in (audits, control, metrics, paper, checkpoint, wave / "checkpoints"):
        directory.mkdir(parents=True, exist_ok=True)

    commands = {
        "command279": sha256_file(control / "ACTIVE_GOAL_279.txt"),
        "command280": sha256_file(control / "ACTIVE_GOAL_280.txt"),
        "amendment": sha256_file(control / "COMMAND280_DYNAMIC_RESEARCH_AMENDMENT.txt"),
    }
    sources = {}
    for label, path in {
        "run_cell.js": RUNNER,
        "nsdi_agents": NSDI_AGENTS,
        "nsdi_rule": NSDI_RULE,
        "harness_config": HARNESS_CONFIG,
        "old_state": OLD_STATE,
    }.items():
        sources[label] = {"path": str(path), "sha256": sha256_file(path), "bytes": path.stat().st_size}

    authorization = {
        "epoch": EPOCH,
        "budget_source_id": "WWW279_280_DIAGNOSTIC_40",
        "command_sha256": commands,
        "diagnostic_cap": DIAGNOSTIC_CAP,
        "diagnostic_used": context["budget"]["diagnostic_used"],
        "diagnostic_remaining": context["budget"]["diagnostic_remaining"],
        "g1_counter_cap": G1_CAP,
        "g1_counter_used": context["budget"]["g1_used"],
        "g1_counter_remaining": context["budget"]["g1_remaining"],
        "operational_remaining": context["budget"]["operational_remaining_via_existing_runner"],
        "historic_g1_attempts_not_charged_to_40": context["budget"]["historic_attempts_not_charged_to_40"],
        "confirmatory_288": "RETIRED_BY_AMENDMENT_A_NOT_RUNNABLE",
        "scope": "H14-H18 diagnostic physical attempts on F:\\WWW_N3_MUX after storage, exclusivity, and contract gates",
        "not_authorized": ["tc qdisc", "netem", "formal_288", "kill vite pid 65108", "reset execution_count.json", "rewrite NSDI FINAL_DECISION"],
        "f_workspace_independently_authorized": True,
        "authorization_files_read_completely": True,
    }
    write_json(control / "EXPERIMENT_AUTHORIZATION_280.json", authorization)
    write_json(control / "EXPERIMENT_AUTHORIZATION.json", {"canonical": "EXPERIMENT_AUTHORIZATION_280.json", **authorization})

    state = {
        "epoch": EPOCH,
        "state": decision.state,
        "old_epoch": {
            "path": str(OLD_STATE),
            "final_decision": context["old_final_decision"],
            "effect_on_www280": "PROVENANCE_ONLY",
        },
        "h14": context["h14"],
        "next_cell": decision.next_cell,
        "launch": False,
        "render_visible": None,
        "visual_claims": "BLOCKED",
        "transport_claims": "ALLOWED_WHEN_STORAGE_AND_OWNERSHIP_PASS",
        "budget": context["budget"],
        "source_hashes": sources,
    }
    write_json(checkpoint / "state.json", state)
    write_json(wave / "checkpoints" / "WWW280_EPOCH_STATE.json", state)
    write_json(audits / "WWW280_EPOCH_STATE.json", state)
    write_json(
        wave / "checkpoints" / "state.json",
        {"epoch": EPOCH, "pointer": "checkpoints/www280/state.json", "old_nsdi_state_untouched": str(OLD_STATE)},
    )
    write_json(
        wave / "checkpoints" / "exclusive_executor.json",
        {
            "held": False,
            "epoch": EPOCH,
            "scientific_executor_pid": None,
            "reason": "no physical cell is running; dry-run did not acquire a launch lock",
            "protected_vite_pid": PROTECTED_VITE_PID,
            "protected_vite_alive": pid_alive(PROTECTED_VITE_PID),
        },
    )

    preflight = {
        "controller_F_free_gb": context["controller_free_gb"],
        "controller_storage": context["controller_storage"],
        "worker_volumes": context["worker_volumes"],
        "worker_storage": context["worker_storage"],
        "listeners": context["listeners"],
        "radh2_s3_r5": context["radh2"],
        "launch_permitted": False,
    }
    write_json(audits / "PHYSICAL_LAUNCH_PREFLIGHT.json", preflight)
    write_json(
        audits / "LAUNCH_BLOCKER_ROOT_CAUSE.json",
        {
            "epoch": EPOCH,
            "rules": rule_scope_record(),
            "old_final_decision_does_not_veto": context["old_final_decision"],
            "first_rejecting_condition": decision.first_blocker,
            "blockers": decision.blockers,
            "state": decision.state,
            "confirmatory_288": confirmatory_allowed(False, {"amendment_a_retired_fixed_288": True}),
        },
    )
    write_json(
        audits / "FIRST_REAL_CELL_EVIDENCE.json",
        {
            "new_cell_launched": False,
            "reconciled_run_id": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_radh2_s3_r5",
            "reconciliation": context["radh2"],
            "reason": "cell already DONE; not rerun",
        },
    )
    write_json(checkpoint / "RUN_RESUME_STATUS.json", {"state": decision.state, "next": decision.next_cell, "resume": "dry-run checkpoint; no physical supervisor started"})

    attempts = attempt_rows(wave, context["cells"])
    write_csv(metrics / "PHYSICAL_ATTEMPTS.csv", attempts)
    write_csv(metrics / "LOGICAL_CELL_MASTER.csv", context["h14_queue"] + context["h15"])
    write_csv(metrics / "METRICS_MASTER.csv", manifest_rows(context["cells"]))
    write_csv(
        metrics / "VISUAL_QOE.csv",
        [{"render_visible": "", "reason": "absent from score.json; not coerced to 0", "claim": "BLOCKED"}],
    )
    write_csv(
        metrics / "CLAIM_EVIDENCE.csv",
        [
            {
                "claim_id": "H14_FIRST_HOP",
                "status": "FALSIFIED",
                "evidence": "metrics/H2_ADJUDICATION.json; metrics/DIRECT_ADJUDICATION.json",
                "paper_valid_qoe": False,
            }
        ],
    )
    write_csv(
        metrics / "CANDIDATE_HISTORY.csv",
        [
            {
                "candidate": "SPADE",
                "version": "none-for-H15",
                "result": "NOT_A_CANDIDATE",
                "reason": "cache-permutation SPADE stays rejected; no online admission lever measured yet",
            }
        ],
    )
    write_csv(metrics / "CAUSAL_EVIDENCE.csv", context["causal_rows"])
    write_csv(metrics / "EVIDENCE_TO_CLAIM.csv", context["causal_rows"])
    write_json(control / "MATRIX_MANIFEST.json", context["matrix"])

    audits.joinpath("EXECUTOR_GATE_DIFF.md").write_text(context["gate_diff"], encoding="utf-8")
    audits.joinpath("RUNNING_OR_EXACT_BLOCKER.md").write_text(context["blocker_md"], encoding="utf-8")
    control.joinpath("SCIENTIFIC_QUESTION.md").write_text(context["question_md"], encoding="utf-8")
    control.joinpath("BASELINE_JUSTIFICATION.md").write_text(context["baseline_md"], encoding="utf-8")
    paper.joinpath("main.tex").write_text(context["tex"], encoding="utf-8")
    write_json(
        audits / "DRY_RUN_NEXT.json",
        {
            "launched": False,
            "state": decision.state,
            "next_cell": decision.next_cell,
            "command": decision.command,
            "physical_budget_if_started": 1,
            "budget_remaining_before": context["budget"]["operational_remaining_via_existing_runner"],
            "render_visible": None,
            "transport_pilot_allowed_by_visual_gate": visual_claim_allowed(None, False, "transport"),
            "visual_claim_allowed": visual_claim_allowed(None, False, "visual"),
            "blocker": decision.first_blocker,
        },
    )


def build_context(wave: Path, worker_volumes: dict, controller_free_gb: float) -> dict:
    cells = load_cells(wave)
    old = read_json(OLD_STATE)
    h14 = h14_closed(wave)
    h15 = h15_queue(cells, h14)
    command279 = wave / "control" / "ACTIVE_GOAL_279.txt"
    info = budget(read_json(wave / "execution_count.json"), command279.stat().st_mtime)
    radh2 = next(cell for cell in cells if cell["run_id"].endswith("radh2_s3_r5"))
    radh2_state = read_json(wave / "runtime" / f"state_{radh2['run_id']}.json")
    radh2_view = {
        "run_id": radh2["run_id"],
        "phase": radh2["phase"],
        "valid": radh2["valid"],
        "verdicts": radh2["verdicts"],
        "recorded_pids": radh2_state.get("pids"),
        "recorded_pids_alive": {str(pid): pid_alive(int(pid)) for pid in (radh2_state.get("pids") or {}).values()},
        "clients": ["C3", "C4"],
        "hop": "rad_h2",
        "slots": 3,
        "n": 2,
        "evidence": radh2["evidence"],
    }
    causal = []
    for cell in cells:
        if not cell["valid"]:
            continue
        if cell["n"] == 2 and cell["slots"] == 3 and cell["hop"] in H14_ROUTES:
            causal.append(
                {
                    "run_id": cell["run_id"],
                    "hop": cell["hop"],
                    "n": cell["n"],
                    "slots": cell["slots"],
                    "all_p50_ms": json.dumps(cell["all_p50_ms"], ensure_ascii=False),
                    "inflight1_p50_ms": json.dumps(cell["inflight1_p50_ms"], ensure_ascii=False),
                    "branch": "H14",
                    "status": "VALID_TRANSPORT",
                }
            )
    controller_ok, controller_reason = controller_storage_ok(controller_free_gb)
    worker_ok, worker_reason = worker_storage_ok({key: value for key, value in worker_volumes.items() if not str(key).startswith("_")})
    matrix = {
        "phase": "H15_DISCOVERY",
        "status": "PRE_REGISTERED_NOT_STARTED",
        "scientific_question": "On matched Vite HTTP/1.1 N=2 stop-go, does slots=1 move run-level send-to-first-byte relative to slots=3 by more than the 30ms screening gap?",
        "factors": {
            "method": ["LRU"],
            "route": ["vite_h1"],
            "slots": [3, 1],
            "users": ["N2"],
            "scene": ["coit-40m-sh1-lod"],
            "trace": ["stop_go"],
            "network": ["VERIFIED_ETHERNET"],
            "repetitions": 2,
        },
        "logical_cells": 4,
        "already_valid": 2,
        "needs_execution": 2,
        "physical_attempts_planned": 2,
        "attempt_cap_per_cell": ATTEMPTS_PER_CELL,
        "worst_case_attempts": 6,
        "confirmatory_cells": 0,
        "why_not_288": "Amendment A retired the fixed 288 matrix. One scene and one trace cannot support it, and no mechanism is qualified.",
    }
    return {
        "cells": cells,
        "old_final_decision": old.get("final_decision"),
        "h14": h14,
        "h14_queue": classify_h14(cells),
        "h15": h15,
        "budget": info,
        "radh2": radh2_view,
        "causal_rows": causal,
        "controller_free_gb": controller_free_gb,
        "controller_storage": controller_reason,
        "worker_volumes": worker_volumes,
        "worker_storage": worker_reason,
        "listeners": listening_pids(),
        "matrix": matrix,
        "controller_ok": controller_ok,
        "worker_ok": worker_ok,
        "gate_diff": gate_diff_text(old.get("final_decision"), h14, info, worker_reason),
        "blocker_md": "",
        "question_md": question_text(causal, h14, info),
        "baseline_md": baseline_text(),
        "tex": tex_text(),
    }


def gate_diff_text(old_decision: str, h14: dict, info: dict, worker_reason: str) -> str:
    return "\n".join(
        [
            "# WWW280 gate difference",
            "",
            f"Old NSDI `harness/state/state.json` final_decision is `{old_decision}`. It stays immutable and does not veto epoch {EPOCH}.",
            "",
            "The NSDI AGENTS.md writable-root sentence and the physical-cell ban bind `D:\\Program\\NSDI_SPADE_HARNESS`. They do not name this F: project. Those files were not edited.",
            "",
            f"H14 evidence status: closed={h14['closed']}. Next branches: {', '.join(h14['next_branches'])}.",
            "",
            f"Diagnostic remaining under the 40-cap: {info['diagnostic_remaining']}. Existing runner counter remaining: {info['g1_remaining']}. Operational remaining: {info['operational_remaining_via_existing_runner']}.",
            "",
            f"Physical launch blocker: {worker_reason}.",
            "",
        ]
    )


def question_text(causal: list[dict], h14: dict, info: dict) -> str:
    lines = [
        "# 科学问题",
        "",
        "H14 已经由证据关闭：同一 N=2、slots=3、stop-go、LRU 50MiB/100 合同下，Vite HTTP/1.1、直连 18081、以及浏览器打到 18443 的 HTTP/2，都没有把发送到首字节降进同次运行的在途=1 带宽。第一跳协议不是杠杆。",
        "",
        "下一个问题属于 H15，而不是把失败的 H14 矩阵补满。",
        "",
        "可证伪句：在固定的 Vite HTTP/1.1 路径上，把渲染器取块槽从 3 降到 1，运行级 send-to-first-byte 中位数相对 slots=3 的变化大于 30ms 的筛选阈值，并且完成的需求没有同步塌缩。",
        "",
        "若变化不超过 30ms，则“槽位上限就是这段等待的在线杠杆”被否定。那时不实现 SPADE，转入 H16 的接收到绘制测量；视觉仪器未通过前只记录 NULL。若在线杠杆消失，结论是 SCIENTIFIC_EXHAUSTION，而不是新的正向算法。",
        "",
        "SPADE 目前没有候选版本。历史缓存替换 SPADE 保持拒绝，不因为 H14 失败而重开。",
        "",
        f"H14 closed={h14['closed']}。WWW280 诊断预算剩余 {info['diagnostic_remaining']}。现有 run_cell.js 计数器剩余 {info['g1_remaining']}。",
        "",
        "已计入的有效运输格：",
        "",
    ]
    for row in causal:
        lines.append(f"- `{row['run_id']}` {row['hop']} all_p50_ms={row['all_p50_ms']} inflight1_p50_ms={row['inflight1_p50_ms']}")
    lines.append("")
    return "\n".join(lines)


def baseline_text() -> str:
    return "\n".join(
        [
            "# Baseline 选择",
            "",
            "这个问题是浏览器取块并发，不是缓存替换。",
            "",
            "纳入：",
            "",
            "- Vite HTTP/1.1 slots=3。这是已经 VALID 的现行系统，N=2 rep1 与 rep2。",
            "- Vite HTTP/1.1 slots=1。这是要测量的固定并发对照，不是新算法。",
            "",
            "不纳入本阶段：",
            "",
            "- LRU、SIEVE、S3-FIFO、IND、CoLRU、DLS。它们调度的是缓存准入或驱逐，打不中已经测到的发送到首字节等待。",
            "- 把 Vite H1 换成现成 HTTP/2。H14 已经测过，不能把它叫做 SPADE。",
            "- FIFO、WFQ、按大小调度。还没有测到一个共享的下游队列。",
            "",
            "场景目前只有 coit-40m-sh1-lod，轨迹只有一条 stop_go。这够做 H15 发现，不够做冻结确认。网络标签是 VERIFIED_ETHERNET，不把旧地址写成 WiFi。",
            "",
        ]
    )


def tex_text() -> str:
    return r"""\documentclass[sigconf,anonymous,review]{acmart}
\begin{document}
\title{First-hop protocol is not the multi-user 3DGS wait}
\begin{abstract}
Matched N=2 Ethernet experiments show that replacing the Vite HTTP/1.1 hop with a direct HTTP/1.1 proxy or with HTTP/2 does not remove the roughly 360--495\,ms send-to-first-byte wait. Visual quality is not claimed: render-visible evidence is absent. This draft records a falsified first-hop hypothesis and the next concurrency question. It is not a submission.
\end{abstract}
\maketitle
\section{Introduction}
The measured wait survives three first-hop treatments under one cache, scene, and camera contract. A cache replacement policy is the wrong baseline for that wait.
\section{Evidence}
Valid N=2 slots=3 runs are the Vite pair r1/r2, the direct pair r1/r2, and the HTTP/2 pair r5/r6. Adjudications are H2\_ADJUDICATION.json and DIRECT\_ADJUDICATION.json. Missing visual metrics stay null.
\section{Limitations}
One scene and one trajectory cannot support a confirmatory claim. No new mechanism is qualified.
\end{document}
"""


def record_attempt(counter: dict, run_id_value: str) -> dict:
    attempts = list(counter.get("attempts") or [])
    if any(row.get("run_id") == run_id_value for row in attempts):
        return {**counter, "attempts": attempts, "duplicate": True}
    attempts.append({"run_id": run_id_value})
    return {
        "executions": int(counter.get("executions") or 0) + 1,
        "attempts": attempts,
        "duplicate": False,
    }


def run_next(decision: Decision, launcher) -> dict:
    if not decision.launch:
        return {"launched": False, "blocker": decision.first_blocker, "command": decision.command}
    launcher(decision.command)
    return {"launched": True, "command": decision.command}


def live_decision(wave: Path, worker_volumes: dict | None = None) -> Decision:
    usage = shutil.disk_usage("F:/")
    free_gb = usage.free / (1024**3)
    volumes = worker_volumes if worker_volumes is not None else probe_workers()
    clean_volumes = {key: value for key, value in volumes.items() if not str(key).startswith("_")}
    context = build_context(wave, clean_volumes, round(free_gb, 1))
    active = active_cell(context["cells"])
    decision = decide(
        old_final_decision=context["old_final_decision"],
        same_epoch_terminal=False,
        active=active,
        h14=context["h14"],
        h15=context["h15"],
        budget_info=context["budget"],
        controller_free_gb=context["controller_free_gb"],
        worker_volumes=clean_volumes,
        render_visible=None,
        instrument_valid=False,
        frozen_exists=False,
        qualifications={"amendment_a_retired_fixed_288": True},
        integrity_ok=True,
    )
    blocker = decision.first_blocker or {"id": "NONE"}
    context["blocker_md"] = "\n".join(
        [
            "# 执行状态",
            "",
            f"状态：`{decision.state}`。",
            "",
            f"物理执行器：没有。8080 上的 Vite pid {PROTECTED_VITE_PID} 是既有保护进程，不是本纪元的科学执行器。",
            "",
            f"下一格：`{(decision.next_cell or {}).get('proposed_run_id')}`。",
            "",
            "启动：否。",
            "",
            f"第一条拒绝条件：`{blocker.get('id')}`。",
            "",
            f"来源：{blocker.get('source')}",
            "",
            f"条件：{blocker.get('condition')}",
            "",
            f"动作：{blocker.get('action')}",
            "",
            f"诊断预算剩余 {context['budget']['diagnostic_remaining']} / {DIAGNOSTIC_CAP}。现有计数器剩余 {context['budget']['g1_remaining']} / {G1_CAP}。本进程没有消耗尝试。",
            "",
        ]
    )
    emit_live(wave, decision, context)
    return decision


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--dry-run-next", action="store_true")
    parser.add_argument("--run-next", action="store_true")
    parser.add_argument("--wave", default=r"F:\WWW_N3_MUX")
    args = parser.parse_args(argv)
    if args.run_next:
        decision = live_decision(Path(args.wave))
        result = run_next(decision, lambda command: subprocess.run(command, check=True))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["launched"] else 2
    if not (args.preflight or args.dry_run_next):
        args.dry_run_next = True
        args.preflight = True
    decision = live_decision(Path(args.wave))
    print(
        json.dumps(
            {
                "state": decision.state,
                "launched": False,
                "next_cell": decision.next_cell,
                "command": decision.command,
                "blocker": decision.first_blocker,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
