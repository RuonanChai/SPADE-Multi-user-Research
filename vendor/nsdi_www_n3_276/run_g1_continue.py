"""Resume remaining G1 cells into F:\\WWW_N3_MUX. Skip DONE. N=3 is N=2 scale."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(r"D:\Program\NSDI_SPADE_HARNESS")
RUNTIME = ROOT / "research" / "www_n3_276" / "runtime"
WAVE = Path(r"F:\WWW_N3_MUX")
ORIGIN = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com"
NODE = "node"

# New run_ids so FAILED+workers cells are not blocked. Names stay under one F: tree.
REMAINING = [
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 3},
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 4},
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 3},
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 4},
    {"n": 3, "hop": "rad_h2", "slots": 3, "rep": 3},
    {"n": 3, "hop": "rad_h2", "slots": 3, "rep": 4},
    {"n": 1, "hop": "vite_h1", "slots": 3, "rep": 3},
    {"n": 1, "hop": "rad_h2", "slots": 3, "rep": 3},
    {"n": 1, "hop": "rad_h2", "slots": 3, "rep": 4},
]


def run_id(cell: dict) -> str:
    hop = cell["hop"].replace("_", "")
    return f"nsdi_N{cell['n']}_LRU_coit-40m-sh1-lod_stop_go_g1_{hop}_s{cell['slots']}_r{cell['rep']}"


def is_done(rid: str) -> bool:
    state_path = WAVE / "runtime" / f"state_{rid}.json"
    if not state_path.exists():
        return False
    try:
        return json.loads(state_path.read_text(encoding="utf-8")).get("phase") == "DONE"
    except (OSError, json.JSONDecodeError):
        return False


def analyze() -> None:
    subprocess.run(
        [sys.executable, str(ROOT / "research" / "www_n3_276" / "analyze_g1.py")],
        cwd=str(ROOT),
        check=False,
    )


def run_cell(cell: dict) -> int:
    rid = run_id(cell)
    if is_done(rid):
        print(f"SKIP_DONE {rid}", flush=True)
        return 0
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
    WAVE.mkdir(parents=True, exist_ok=True)
    (WAVE / "logs").mkdir(exist_ok=True)
    (WAVE / "metrics").mkdir(exist_ok=True)
    failures = []
    for cell in REMAINING:
        code = run_cell(cell)
        if code != 0:
            failures.append(run_id(cell))
    analyze()
    (WAVE / "metrics" / "G1_CONTINUE_FAILURES.json").write_text(
        json.dumps(failures, indent=2) + "\n", encoding="utf-8"
    )
    print("G1_CONTINUE_FAILURES", failures, flush=True)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
