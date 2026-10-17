"""Drive G1 Range-mux cells. Stop-rule cancels slot expansion and burst-turn only."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(r"D:\Program\NSDI_SPADE_HARNESS")
RUNTIME = ROOT / "research" / "www_n3_276" / "runtime"
DIAG = Path(r"D:\Program\NSDI_SPADE_DIAG_W04")
WAVE = Path(r"F:\WWW_N3_MUX")
ORIGIN = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com"
NODE = "node"
SSH = Path(r"C:\Windows\System32\OpenSSH\ssh.exe")
KEY = Path(r"C:\Users\IoT\.ssh\id_ed25519")
KNOWN = DIAG / "known_hosts"

HOSTS = {
    "C3": "192.168.1.197",
    "C4": "192.168.1.196",
    "C5": "192.168.1.195",
}

# Distinct names: nsdi_N{n}_LRU_coit-40m-sh1-lod_stop_go_g1_{hop}_s{slots}_r{rep}
CORE = [
    {"n": 2, "hop": "vite_h1", "slots": 3, "rep": 1},
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 1},
    {"n": 2, "hop": "vite_h1", "slots": 3, "rep": 2},
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 2},
]
IF_MUX = [
    {"n": 2, "hop": "rad_direct", "slots": 3, "rep": 1},
    {"n": 2, "hop": "rad_direct", "slots": 3, "rep": 2},
    {"n": 2, "hop": "vite_h1", "slots": 1, "rep": 1},
    {"n": 2, "hop": "rad_h2", "slots": 1, "rep": 1},
    {"n": 2, "hop": "vite_h1", "slots": 1, "rep": 2},
    {"n": 2, "hop": "rad_h2", "slots": 1, "rep": 2},
]
MEASUREMENT = [
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 1},
    {"n": 3, "hop": "rad_h2", "slots": 3, "rep": 1},
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 2},
    {"n": 3, "hop": "rad_h2", "slots": 3, "rep": 2},
    {"n": 1, "hop": "vite_h1", "slots": 3, "rep": 1},
    {"n": 1, "hop": "rad_h2", "slots": 3, "rep": 1},
    {"n": 1, "hop": "vite_h1", "slots": 3, "rep": 2},
    {"n": 1, "hop": "rad_h2", "slots": 3, "rep": 2},
]


def run_id(cell: dict) -> str:
    hop = cell["hop"].replace("_", "")
    return f"nsdi_N{cell['n']}_LRU_coit-40m-sh1-lod_stop_go_g1_{hop}_s{cell['slots']}_r{cell['rep']}"


def ssh(ip: str, command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SSH), "-i", str(KEY), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
         "-o", f"UserKnownHostsFile={KNOWN}", "-o", "ConnectTimeout=12", f"p5remote@{ip}", command],
        capture_output=True, text=True, timeout=40,
    )


def preflight() -> dict:
    WAVE.mkdir(parents=True, exist_ok=True)
    (WAVE / "logs").mkdir(exist_ok=True)
    (WAVE / "metrics").mkdir(exist_ok=True)
    (WAVE / "evidence").mkdir(exist_ok=True)
    out = {}
    for name, ip in HOSTS.items():
        r = ssh(ip, "hostname")
        host = (r.stdout or "").strip().splitlines()[0] if r.stdout else ""
        sess = ssh(ip, "query session")
        out[name] = {
            "ip": ip,
            "status": 0 if host.startswith("P5-") else r.returncode,
            "hostname": host,
            "session": (sess.stdout or "")[-800:],
            "stderr": ((r.stderr or "") + (sess.stderr or ""))[-400:],
        }
    path = WAVE / "metrics" / "preflight.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({k: {"status": v["status"], "hostname": v.get("hostname")} for k, v in out.items()}, ensure_ascii=False, indent=2))
    return out


def analyze() -> dict:
    r = subprocess.run([sys.executable, str(ROOT / "research" / "www_n3_276" / "analyze_g1.py")], cwd=str(ROOT), capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr)
    scores = WAVE / "metrics" / "G1_SCORES.json"
    if scores.exists():
        return json.loads(scores.read_text(encoding="utf-8"))
    return {}


def run_cell(cell: dict) -> int:
    rid = run_id(cell)
    log = WAVE / "logs" / rid
    log.mkdir(parents=True, exist_ok=True)
    cmd = [NODE, str(RUNTIME / "run_cell.js"), rid, "LRU", ORIGIN, cell["hop"], str(cell["slots"]), str(cell["n"])]
    print(f"\n===== G1 {rid} =====", flush=True)
    with (log / "orchestrator.log").open("a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {' '.join(cmd)}\n")
        proc = subprocess.run(cmd, cwd=str(RUNTIME), stdout=fh, stderr=subprocess.STDOUT)
    print(f"exit={proc.returncode} {rid}", flush=True)
    analyze()
    return proc.returncode


def main() -> int:
    (WAVE / "metrics").mkdir(parents=True, exist_ok=True)
    pf = preflight()
    c3c4_ok = pf["C3"]["status"] == 0 and pf["C4"]["status"] == 0
    if not c3c4_ok:
        print("PREFLIGHT_C3C4_FAIL", flush=True)
        return 2
    failures = []
    for cell in CORE:
        code = run_cell(cell)
        if code != 0:
            failures.append(run_id(cell))
    blob = analyze()
    stop = blob.get("stop_rule") or {}
    (WAVE / "metrics" / "STOP_RULE.json").write_text(json.dumps(stop, indent=2) + "\n", encoding="utf-8")
    print("STOP_RULE", json.dumps(stop, ensure_ascii=False), flush=True)
    rest = list(MEASUREMENT)
    if stop.get("range_mux_works"):
        rest = IF_MUX + MEASUREMENT
        if pf["C5"]["status"] != 0:
            print("C5_PREFLIGHT_FAIL keep N=2 mux expansion only", flush=True)
            rest = [c for c in rest if c["n"] != 3]
    else:
        print("Range-mux failed or incomplete; skip slots=1 and burst-turn", flush=True)
        if pf["C5"]["status"] != 0:
            rest = [c for c in rest if c["n"] != 3]
    for cell in rest:
        code = run_cell(cell)
        if code != 0:
            failures.append(run_id(cell))
    analyze()
    (WAVE / "metrics" / "G1_FAILURES.json").write_text(json.dumps(failures, indent=2) + "\n", encoding="utf-8")
    print("G1_FAILURES", failures, flush=True)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
