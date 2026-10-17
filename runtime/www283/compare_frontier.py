"""Compare development admission cells already on disk. Does not launch anything."""

from __future__ import annotations

import json
from pathlib import Path

METRICS = Path(r"F:\WWW_N3_MUX\metrics")
OUT = Path(r"F:\WWW_N3_MUX\research_control\BASELINE_PARETO.csv")

WANTED = [
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r1",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r2",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r2",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r1",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r2",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r5",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r6",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r1",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r2",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1",
    "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r2",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r1",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r2",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r3",
    "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r4",
]


def row(run_id: str) -> str | None:
    path = METRICS / run_id / "score.json"
    if not path.exists():
        return None
    score = json.loads(path.read_text(encoding="utf-8"))
    spec = score.get("spec") or {}
    clients = score.get("clients") or {}
    parts = []
    total_206 = 0
    for name, body in clients.items():
        if not body:
            parts.append(f"{name}:MISSING")
            continue
        parts.append(f"{name}:{body.get('verdict')}:{round(body.get('all_p50_ms') or -1)}:{body.get('rad_206')}")
        total_206 += int(body.get("rad_206") or 0)
    return ",".join([
        run_id,
        str(spec.get("client_scheduler") or ""),
        str(spec.get("n")),
        str(spec.get("slots")),
        str(total_206),
        "|".join(parts),
    ])


def main() -> None:
    lines = ["run_id,scheduler,n,slots,sum_206,clients"]
    for run_id in WANTED:
        built = row(run_id)
        if built:
            lines.append(built)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
