"""N=2 HTTP/2 cells after the 18443 front returns 206."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(r"D:\Program\NSDI_SPADE_HARNESS")
RUNTIME = ROOT / "research" / "www_n3_276" / "runtime"
WAVE = Path(r"F:\WWW_N3_MUX")
ORIGIN = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com"
CELLS = [
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 5},
    {"n": 2, "hop": "rad_h2", "slots": 3, "rep": 6},
]


def run_id(cell: dict) -> str:
    return f"nsdi_N{cell['n']}_LRU_coit-40m-sh1-lod_stop_go_g1_radh2_s{cell['slots']}_r{cell['rep']}"


def main() -> int:
    failures = []
    for cell in CELLS:
        rid = run_id(cell)
        log = WAVE / "logs" / rid
        log.mkdir(parents=True, exist_ok=True)
        cmd = ["node", str(RUNTIME / "run_cell.js"), rid, "LRU", ORIGIN, cell["hop"], "3", str(cell["n"])]
        print(f"\n===== G1 {rid} =====", flush=True)
        with (log / "orchestrator.log").open("a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%dT%H:%M:%S ") + " ".join(cmd) + "\n")
            proc = subprocess.run(cmd, cwd=str(RUNTIME), stdout=fh, stderr=subprocess.STDOUT)
        print(f"exit={proc.returncode} {rid}", flush=True)
        subprocess.run([sys.executable, str(ROOT / "research" / "www_n3_276" / "analyze_g1.py")], cwd=str(ROOT), check=False)
        if proc.returncode != 0:
            failures.append(rid)
    print("G1_H2_FAILURES", failures, flush=True)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
