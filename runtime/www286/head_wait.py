"""Head-of-queue wait on matched chunk events. Two saved runs only."""

from __future__ import annotations

import json
from pathlib import Path

EV = Path(r"F:\WWW_N3_MUX\evidence")
RUNS = {
    "slots1_r1": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s1_r1",
    "slots2_r1": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r1",
    "slots2_r2": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_r2",
    "slots3_r1": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r1",
}


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def analyze(run_id: str) -> dict:
    path = next((EV / run_id).rglob("C3_spark_events.jsonl"))
    admitted: set[int] = set()
    resident: set[int] = set()
    stages: dict[int, dict[str, float]] = {}
    head = None
    head_since = None
    marked = False
    last_decision = None
    waits: list[float] = []
    parse_intervals: list[tuple[float, float]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
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
            mono = float(mono)
            if kind == "scheduler_decision":
                if last_decision is None or mono - last_decision > 5:
                    marked = False
                last_decision = mono
                if chunk in admitted or chunk in resident or marked:
                    continue
                marked = True
                if head != chunk:
                    head = chunk
                    head_since = mono
                continue
            item = stages.setdefault(chunk, {})
            item.setdefault(kind, mono)
            if kind == "fetch_enqueue":
                admitted.add(chunk)
                if head == chunk and head_since is not None:
                    waits.append(mono - head_since)
                    head = None
                    head_since = None
                    marked = False
            elif kind == "upload_complete":
                resident.add(chunk)
    network, decode, gpu, after_decode = [], [], [], []
    for item in stages.values():
        if "fetch_enqueue" in item and "parse_start" in item:
            network.append(item["parse_start"] - item["fetch_enqueue"])
        if "parse_start" in item and "parse_complete" in item:
            decode.append(item["parse_complete"] - item["parse_start"])
            parse_intervals.append((item["parse_start"], item["parse_complete"]))
        if "upload_start" in item and "upload_complete" in item:
            gpu.append(item["upload_complete"] - item["upload_start"])
        if "parse_complete" in item and "upload_complete" in item:
            after_decode.append(item["upload_complete"] - item["parse_complete"])
    overlapped = 0
    ordered = sorted(parse_intervals)
    for index, (start, end) in enumerate(ordered):
        if any(other_start < end and other_end > start for other_start, other_end in ordered[max(0, index - 4) : index]):
            overlapped += 1
    positive = [value for value in waits if value > 1]
    return {
        "admitted": len(admitted),
        "head_waits": len(waits),
        "head_wait_p50_ms": pct(waits, 0.5),
        "head_wait_p95_ms": pct(waits, 0.95),
        "head_wait_over_1ms": len(positive),
        "network_p50_ms": pct(network, 0.5),
        "decode_p50_ms": pct(decode, 0.5),
        "gpu_p50_ms": pct(gpu, 0.5),
        "decode_to_gpu_p10_ms": pct(after_decode, 0.1),
        "decode_to_gpu_p50_ms": pct(after_decode, 0.5),
        "decode_to_gpu_p90_ms": pct(after_decode, 0.9),
        "decode_overlap_fraction": overlapped / len(ordered) if ordered else None,
    }


if __name__ == "__main__":
    saved = {}
    for name, run_id in RUNS.items():
        row = analyze(run_id)
        payload = {key: (round(value, 2) if isinstance(value, float) else value) for key, value in row.items()}
        saved[name] = payload
        print(name, json.dumps(payload))
    Path(r"F:\WWW_N3_MUX\results\WWW286_HEAD_WAIT.json").write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
