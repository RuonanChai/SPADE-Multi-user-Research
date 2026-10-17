"""Paired development comparison and a fixture for header admission.

Uses saved scores only. Does not launch a cell.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

METRICS = Path(r"F:\WWW_N3_MUX\metrics")
OUT = Path(r"F:\WWW_N3_MUX\results\WWW285_NEXT_COMPARISON.csv")

PAIRS = [
    ("LRU", 2, 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1"),
    ("LRU", 2, 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r2"),
    ("LRU", 2, 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1"),
    ("LRU", 2, 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2"),
    ("LRU", 2, 3, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r1"),
    ("LRU", 2, 3, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r2"),
    ("SPADE", 2, 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r1"),
    ("SPADE", 2, 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r2"),
    ("SPADE_V2", 2, 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r3"),
    ("SPADE_V2", 2, 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r4"),
    ("LRU", 3, 1, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1"),
    ("LRU", 3, 1, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r2"),
    ("LRU", 3, 2, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1"),
    ("LRU", 3, 2, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2"),
    ("LRU", 3, 3, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r5"),
    ("LRU", 3, 3, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r6"),
    ("SPADE", 3, 1, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r1"),
    ("SPADE", 3, 1, "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r2"),
]


def main() -> None:
    master = {}
    path = Path(r"F:\WWW_N3_MUX\results\DEVELOPMENT_MASTER.csv")
    if path.exists():
        for row in csv.DictReader(path.open(encoding="utf-8")):
            master[(row["run_id"], row["client"])] = row
    fields = [
        "run_id", "scheduler", "n", "slots", "client", "verdict",
        "send_to_first_p50_ms", "send_to_first_p95_ms", "send_to_complete_p50_ms",
        "send_to_complete_p95_ms", "rad_206", "useful_bytes", "headers_pending_peak",
        "body_active_peak", "jain_useful_bytes", "q5_visible_splats", "gpu_util_mean",
    ]
    out_rows = []
    for scheduler, n, slots, run_id in PAIRS:
        score_path = METRICS / run_id / "score.json"
        if not score_path.exists():
            continue
        score = json.loads(score_path.read_text(encoding="utf-8"))
        for client, body in (score.get("clients") or {}).items():
            if not body:
                continue
            extra = master.get((run_id, client), {})
            out_rows.append({
                "run_id": run_id,
                "scheduler": scheduler,
                "n": n,
                "slots": slots,
                "client": client,
                "verdict": body.get("verdict"),
                "send_to_first_p50_ms": body.get("all_p50_ms"),
                "send_to_first_p95_ms": extra.get("request_ttfb_p95"),
                "send_to_complete_p50_ms": extra.get("request_completion_p50"),
                "send_to_complete_p95_ms": extra.get("request_completion_p95"),
                "rad_206": body.get("rad_206"),
                "useful_bytes": extra.get("www_useful_completed_bytes_fixed_window"),
                "headers_pending_peak": extra.get("www_headers_pending_peak"),
                "body_active_peak": extra.get("www_body_active_peak"),
                "jain_useful_bytes": extra.get("www_jain_completed_useful_bytes"),
                "q5_visible_splats": extra.get("Q5_mean"),
                "gpu_util_mean": extra.get("resource_client_GPU_util_mean"),
            })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(out_rows)
    print(json.dumps({"rows": len(out_rows), "path": str(OUT)}))


if __name__ == "__main__":
    main()
