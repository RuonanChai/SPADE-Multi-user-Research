"""N=3 vite_h1 scale cells after proven XML launch is in run_cell.js."""

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

CELLS = [
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 5},
    {"n": 3, "hop": "vite_h1", "slots": 3, "rep": 6},
]


def run_id(cell: dict) -> str:
    hop = cell["hop"].replace("_", "")
    return f"nsdi_N{cell['n']}_LRU_coit-40m-sh1-lod_stop_go_g1_{hop}_s{cell['slots']}_r{cell['rep']}"


def main() -> int:
    failures = []
    for cell in CELLS:
        rid = run_id(cell)
        log = WAVE / "logs" / rid
        log.mkdir(parents=True, exist_ok=True)
        cmd = [
            "node", str(RUNTIME / "run_cell.js"), rid, "LRU", ORIGIN,
            cell["hop"], str(cell["slots"]), str(cell["n"]),
        ]
        print(f"\n===== G1 {rid} =====", flush=True)
        with (log / "orchestrator.log").open("a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {' '.join(cmd)}\n")
            proc = subprocess.run(cmd, cwd=str(RUNTIME), stdout=fh, stderr=subprocess.STDOUT)
        print(f"exit={proc.returncode} {rid}", flush=True)
        subprocess.run([sys.executable, str(ROOT / "research" / "www_n3_276" / "analyze_g1.py")], cwd=str(ROOT), check=False)
        if proc.returncode != 0:
            failures.append(rid)
    (WAVE / "metrics" / "G1_N3_VITE_FAILURES.json").write_text(json.dumps(failures, indent=2) + "\n", encoding="utf-8")
    print("G1_N3_VITE_FAILURES", failures, flush=True)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
