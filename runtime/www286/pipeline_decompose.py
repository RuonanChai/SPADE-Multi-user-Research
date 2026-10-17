"""Decompose saved runs into admission queue, network, decode, and upload.

Does not launch a cell. scheduler_decision is the first time a chunk is wanted.
fetch_enqueue is admission. parse_start is the first byte of the full body in memory.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

EV = Path(r"F:\WWW_N3_MUX\evidence")
OUT = Path(r"F:\WWW_N3_MUX\results\WWW286_PIPELINE.csv")

RUNS = [
    ("LRU", 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1"),
    ("LRU", 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r2"),
    ("LRU", 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1"),
    ("LRU", 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2"),
    ("LRU", 3, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r1"),
    ("LRU", 3, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r2"),
    ("SPADE", 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r1"),
    ("SPADE", 1, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spade_s1_r2"),
    ("SPADE_V2", 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r3"),
    ("SPADE_V2", 2, "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_spadev2_h1b1_r4"),
]


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(q * (len(ordered) - 1)))))
    return ordered[index]


def spark_path(run_id: str) -> Path:
    return next((EV / run_id).rglob("C3_spark_events.jsonl"))


def life_path(run_id: str) -> Path:
    return next((EV / run_id).rglob("C3_request_lifecycle.jsonl"))


def pipeline(run_id: str) -> dict:
    wanted: dict[int, float] = {}
    stage: dict[int, dict] = {}
    with spark_path(run_id).open(encoding="utf-8") as handle:
        for line in handle:
            if '"chunk":' not in line:
                continue
            kind = None
            for name in ("scheduler_decision", "fetch_enqueue", "parse_start", "parse_complete", "upload_start", "upload_complete"):
                if f'"type":"{name}"' in line:
                    kind = name
                    break
            if kind is None:
                continue
            row = json.loads(line)
            chunk = row.get("chunk")
            mono = row.get("mono_ms")
            if not isinstance(chunk, int) or not isinstance(mono, (int, float)):
                continue
            if kind == "scheduler_decision":
                prev = wanted.get(chunk)
                if prev is None or mono < prev:
                    wanted[chunk] = float(mono)
                continue
            item = stage.setdefault(chunk, {})
            item.setdefault(kind, float(mono))
    queue, network, parse, upload, admit_to_upload = [], [], [], [], []
    for chunk, item in stage.items():
        if "fetch_enqueue" not in item or "parse_start" not in item:
            continue
        if chunk in wanted:
            queue.append(item["fetch_enqueue"] - wanted[chunk])
        network.append(item["parse_start"] - item["fetch_enqueue"])
        if "parse_complete" in item:
            parse.append(item["parse_complete"] - item["parse_start"])
        if "upload_start" in item and "upload_complete" in item:
            upload.append(item["upload_complete"] - item["upload_start"])
        if "upload_complete" in item:
            admit_to_upload.append(item["upload_complete"] - item["fetch_enqueue"])
    header, body = [], []
    with life_path(run_id).open(encoding="utf-8") as handle:
        for line in handle:
            if ".rad" not in line:
                continue
            row = json.loads(line)
            sent, first, last = row.get("requestSent"), row.get("firstData"), row.get("lastData")
            if not all(isinstance(v, (int, float)) for v in (sent, first, last)):
                continue
            header.append((first - sent) * 1000)
            body.append((last - first) * 1000)
    return {
        "fetches": len(network),
        "queue_p50": pct(queue, 0.5),
        "queue_p95": pct(queue, 0.95),
        "network_p50": pct(network, 0.5),
        "network_p95": pct(network, 0.95),
        "header_p50": pct(header, 0.5),
        "header_p95": pct(header, 0.95),
        "body_p50": pct(body, 0.5),
        "body_p95": pct(body, 0.95),
        "parse_p50": pct(parse, 0.5),
        "parse_p95": pct(parse, 0.95),
        "upload_p50": pct(upload, 0.5),
        "upload_p95": pct(upload, 0.95),
        "admit_to_gpu_p50": pct(admit_to_upload, 0.5),
    }


def main() -> None:
    fields = [
        "scheduler", "slots", "run_id", "fetches",
        "queue_p50", "queue_p95", "network_p50", "network_p95",
        "header_p50", "header_p95", "body_p50", "body_p95",
        "parse_p50", "parse_p95", "upload_p50", "upload_p95", "admit_to_gpu_p50",
    ]
    rows = []
    for scheduler, slots, run_id in RUNS:
        row = pipeline(run_id)
        row.update(scheduler=scheduler, slots=slots, run_id=run_id)
        rows.append(row)
        print(scheduler, slots, run_id[-12:], {k: (None if row[k] is None else round(row[k], 1)) for k in ("fetches", "queue_p50", "network_p50", "header_p50", "body_p50", "parse_p50", "upload_p50")})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
