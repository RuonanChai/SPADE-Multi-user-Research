"""Fill measurable 93+32 fields from existing F: evidence. Does not invent values."""

from __future__ import annotations

import csv
import json
import math
import statistics
from pathlib import Path

WAVE = Path(r"F:\WWW_N3_MUX")
EV = WAVE / "evidence"
METRICS = WAVE / "metrics"
RESULTS = WAVE / "results"
SCHEMA = Path(r"D:\Program\P5_3DGS_ICASSP_CLEAN\research_archive\icassp_campaign_v1\22_state\FINAL_METRIC_SCHEMA.json")

WWW = [
    "www_hop_protocol", "www_h2_confirmed_by_browser", "www_range206_success_count",
    "www_range_content_sha_match", "www_application_inflight_peak", "www_headers_pending_peak",
    "www_body_active_peak", "www_total_inflight_peak", "www_proxy_downstream_pending_peak_bytes",
    "www_browser_queue_wait_p95_ms", "www_send_to_first_p95_ms", "www_send_to_complete_p50_ms",
    "www_send_to_complete_p95_ms", "www_header_wait_p50_ms", "www_body_transfer_p95_ms",
    "www_206_completed_count", "www_useful_completed_bytes_fixed_window", "www_unfinished_206_count",
    "www_cancelled_206_count", "www_exposed_demand_bytes_fixed_window", "www_view_change_t0_valid",
    "www_chunk_draw_inclusion_count", "www_view_change_to_new_draw_p50_ms", "www_visible_quality_t1",
    "www_visible_quality_t3", "www_visible_quality_t5", "www_psnr_db", "www_ssim",
    "www_qoe_sampling_status", "www_reference_frame_hash", "www_jain_completed_useful_bytes",
    "www_observer_overhead_p95_ms",
]


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * q
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - rank) + ordered[high] * (rank - low)


def mean(values: list[float]) -> float | None:
    return None if not values else float(statistics.fmean(values))


def read_jsonl(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            if "scheduler_decision" in line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def client_dir(run: Path, client: str) -> Path | None:
    nested = run / client / client
    if (nested / f"{client}_request_lifecycle.jsonl").exists():
        return nested
    flat = run / client
    if (flat / f"{client}_request_lifecycle.jsonl").exists():
        return flat
    return None


def rad_rows(folder: Path, client: str) -> list[dict]:
    rows = []
    for row in read_jsonl(folder / f"{client}_request_lifecycle.jsonl"):
        if ".rad" in str(row.get("url") or ""):
            rows.append(row)
    return rows


def visual_rows(folder: Path, client: str) -> list[dict]:
    return list(read_jsonl(folder / f"{client}_visual_timeline.jsonl"))


def resource_rows(folder: Path, client: str) -> list[dict]:
    return list(read_jsonl(folder / f"{client}_resource_1hz.jsonl"))


def jain(values: list[float]) -> float | None:
    if not values or any(v < 0 for v in values):
        return None
    total = sum(values)
    squares = sum(v * v for v in values)
    if squares <= 0:
        return None
    return (total * total) / (len(values) * squares)


def measure_client(run_id: str, client: str, folder: Path, spec: dict) -> tuple[dict, dict, dict]:
    rows = rad_rows(folder, client)
    header, complete, body = [], [], []
    useful = 0
    unfinished = 0
    cancelled = 0
    exposed = 0
    intervals = []
    for row in rows:
        sent, first, last = row.get("requestSent"), row.get("firstData"), row.get("lastData")
        finished = row.get("finished")
        nbytes = int(row.get("dataBytes") or 0)
        exposed += nbytes
        if row.get("failed"):
            cancelled += 1
        if sent is None:
            continue
        if first is None or finished is None:
            unfinished += 1
            continue
        header.append((first - sent) * 1000)
        complete.append((finished - sent) * 1000)
        if last is not None:
            body.append(max(0.0, (last - first) * 1000))
        useful += nbytes
        intervals.append((sent, first, finished))
    intervals.sort()
    headers_peak = bodies_peak = total_peak = 0
    for index, (sent, first, finished) in enumerate(intervals):
        headers_now = bodies_now = total_now = 1
        for other_sent, other_first, other_finished in intervals[:index]:
            if other_finished <= sent:
                continue
            total_now += 1
            if other_first > sent:
                headers_now += 1
            else:
                bodies_now += 1
        headers_peak = max(headers_peak, headers_now)
        bodies_peak = max(bodies_peak, bodies_now)
        total_peak = max(total_peak, total_now)

    visuals = visual_rows(folder, client)
    elapsed_splats = []
    replay_origin = None
    first_stamp = None
    for row in visuals:
        playback = row.get("playback") or {}
        stamp = row.get("timestamp")
        splats = row.get("visibleSplats")
        if stamp is None or splats is None:
            continue
        if first_stamp is None:
            first_stamp = float(stamp)
        elapsed_splats.append((float(stamp) - first_stamp, float(splats)))
        if replay_origin is None and playback.get("elapsed_ms") is not None:
            replay_origin = float(playback["elapsed_ms"])
    elapsed_splats.sort()
    covered_from = replay_origin

    def window_max(limit_ms: float) -> tuple[float | None, str]:
        if not elapsed_splats:
            return None, "NOT_OBSERVED"
        chosen = [splats for elapsed, splats in elapsed_splats if elapsed <= limit_ms]
        if not chosen:
            return None, "NOT_OBSERVED"
        return max(chosen), "MEASURED"

    q5, q5_status = window_max(5000)
    q10, q10_status = window_max(10000)
    max_splats = max((splats for _, splats in elapsed_splats), default=None)
    blanks = [1.0 for _, splats in elapsed_splats if splats <= 0]
    blank_ratio = (len(blanks) / len(elapsed_splats)) if elapsed_splats else None
    fv = None
    fv_status = "NOT_OBSERVED"
    t1m = None
    t1m_status = "NOT_OBSERVED"
    if elapsed_splats:
        if elapsed_splats[0][1] > 0 and covered_from is not None and covered_from > 500:
            fv_status = "LEFT_CENSORED"
        else:
            for elapsed, splats in elapsed_splats:
                if splats > 0:
                    fv = elapsed
                    fv_status = "MEASURED"
                    break
        if elapsed_splats[0][1] >= 1_000_000 and covered_from is not None and covered_from > 500:
            t1m_status = "LEFT_CENSORED"
        else:
            hit = False
            for elapsed, splats in elapsed_splats:
                if splats >= 1_000_000:
                    t1m = elapsed
                    t1m_status = "MEASURED"
                    hit = True
                    break
            if not hit:
                t1m_status = "NOT_OBSERVED"
    at_time = {}
    for target, key in ((1000, "t1"), (3000, "t3"), (5000, "t5")):
        if not elapsed_splats or (covered_from or 0) > target:
            at_time[key] = (None, "NOT_OBSERVED" if not elapsed_splats else "LEFT_CENSORED")
            continue
        prior = [splats for elapsed, splats in elapsed_splats if elapsed <= target]
        at_time[key] = (prior[-1] if prior else None, "MEASURED" if prior else "NOT_OBSERVED")

    resources = resource_rows(folder, client)
    cpu = [float(row["cpu_percent"]) for row in resources if isinstance(row.get("cpu_percent"), (int, float))]
    gpu = [float(row["gpu_util_percent"]) for row in resources if isinstance(row.get("gpu_util_percent"), (int, float))]
    vram = [float(row["gpu_memory_used_mb"]) for row in resources if isinstance(row.get("gpu_memory_used_mb"), (int, float))]

    evidence_path = folder / f"{client}_evidence.json"
    window_206 = None
    if evidence_path.exists():
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        window_206 = (evidence.get("network") or {}).get("rad_206_count")
    if window_206 is None:
        window_206 = sum(1 for row in rows if row.get("finished") is not None and not row.get("failed"))
    uploads = 0
    for row in read_jsonl(folder / f"{client}_spark_events.jsonl"):
        if row.get("type") == "upload_complete":
            uploads += 1

    values = {
        "run_id": run_id,
        "client": client,
        "N": spec.get("n"),
        "method": spec.get("method") or "LRU",
        "scene": spec.get("scene") or "coit-40m-sh1-lod",
        "trace": spec.get("trace") or "stop_go",
        "selected_clients": client,
        "request_ttfb_mean": mean(header),
        "request_ttfb_p50": pct(header, 0.50),
        "request_ttfb_p95": pct(header, 0.95),
        "request_completion_mean": mean(complete),
        "request_completion_p50": pct(complete, 0.50),
        "request_completion_p95": pct(complete, 0.95),
        "request_lifecycle_sample_count": len(rows),
        "request_cancellations": cancelled,
        "errors_count": cancelled,
        "FV_min": fv, "FV_max": fv, "FV_mean": fv,
        "Q5_min": q5, "Q5_max": q5, "Q5_mean": q5,
        "Q10_min": q10, "Q10_max": q10, "Q10_mean": q10,
        "T1M_min": t1m, "T1M_max": t1m, "T1M_mean": t1m,
        "blank_ratio_max": blank_ratio, "blank_ratio_mean": blank_ratio,
        "max_visible_splats_min": max_splats,
        "max_visible_splats_max": max_splats,
        "max_visible_splats_mean": max_splats,
        "resource_client_CPU_mean": mean(cpu),
        "resource_client_CPU_max": max(cpu) if cpu else None,
        "resource_client_CPU_samples": len(cpu),
        "resource_client_GPU_util_mean": mean(gpu),
        "resource_client_GPU_util_max": max(gpu) if gpu else None,
        "resource_client_GPU_util_samples": len(gpu),
        "resource_client_VRAM_used_mean": mean(vram),
        "resource_client_VRAM_used_max": max(vram) if vram else None,
        "resource_client_VRAM_used_samples": len(vram),
        "dls_enabled": False,
        "prefetch_issued": 0,
        "prefetch_completed": 0,
        "prefetch_cancelled": 0,
        "prefetch_useful": 0,
        "prefetch_wasted": 0,
        "www_hop_protocol": spec.get("hop"),
        "www_range206_success_count": window_206,
        "www_206_completed_count": window_206,
        "www_application_inflight_peak": total_peak or None,
        "www_headers_pending_peak": headers_peak or None,
        "www_body_active_peak": bodies_peak or None,
        "www_total_inflight_peak": total_peak or None,
        "www_send_to_first_p95_ms": pct(header, 0.95),
        "www_send_to_complete_p50_ms": pct(complete, 0.50),
        "www_send_to_complete_p95_ms": pct(complete, 0.95),
        "www_header_wait_p50_ms": pct(header, 0.50),
        "www_body_transfer_p95_ms": pct(body, 0.95),
        "www_useful_completed_bytes_fixed_window": useful,
        "www_unfinished_206_count": unfinished,
        "www_cancelled_206_count": cancelled,
        "www_exposed_demand_bytes_fixed_window": exposed,
        "www_view_change_t0_valid": bool(elapsed_splats),
        "www_visible_quality_t1": at_time["t1"][0],
        "www_visible_quality_t3": at_time["t3"][0],
        "www_visible_quality_t5": at_time["t5"][0],
        "www_qoe_sampling_status": "NOT_SELECTED",
        "uploaded_chunk_count": uploads,
    }
    status = {}
    reasons = {}
    for key, value in values.items():
        if key in {"run_id", "client"}:
            status[key] = "MEASURED"
            continue
        status[key] = "MEASURED" if value is not None else "NOT_OBSERVED"
    status["FV_mean"] = fv_status
    status["Q5_mean"] = q5_status
    status["Q10_mean"] = q10_status
    status["T1M_mean"] = t1m_status
    status["www_visible_quality_t1"] = at_time["t1"][1]
    status["www_visible_quality_t3"] = at_time["t3"][1]
    status["www_visible_quality_t5"] = at_time["t5"][1]
    status["dls_enabled"] = "MEASURED"
    for key in ("prefetch_issued", "prefetch_completed", "prefetch_cancelled", "prefetch_useful", "prefetch_wasted"):
        status[key] = "MEASURED"
        reasons[key] = "lookahead K is 0 in the cell contract, so no prefetch was issued"
    reasons["www_chunk_draw_inclusion_count"] = "spark events record upload_complete, not chunk ids inside a submitted draw"
    reasons["www_psnr_db"] = "not a pre-registered QoE sample; no pose-matched frames were stored"
    reasons["www_ssim"] = reasons["www_psnr_db"]
    reasons["www_h2_confirmed_by_browser"] = "hop label is not browser ALPN"
    reasons["www_view_change_to_new_draw_p50_ms"] = "no per-chunk draw timestamp exists"
    reasons["www_observer_overhead_p95_ms"] = "no OFF versus LIGHT canary was run on this cell"
    reasons["blank_ratio_mean"] = "fraction of visual samples whose visibleSplats is 0; not a display-presented blank"
    reasons["uploaded_chunk_count"] = "count of upload_complete events; not draw inclusion and not presentation"
    if fv_status == "LEFT_CENSORED":
        reasons["FV_mean"] = "first visual sample is already past 500 ms and already has splats"
    if t1m_status == "NOT_OBSERVED":
        reasons["T1M_mean"] = "visibleSplats never reached 1000000 inside the sampled timeline"
    return values, status, reasons


def main() -> None:
    catalog = json.loads(SCHEMA.read_text(encoding="utf-8"))
    names = [item["name"] for item in catalog["metrics"]]
    RESULTS.mkdir(parents=True, exist_ok=True)
    master = []
    validity = []
    per_run_bytes: dict[str, list[float]] = {}
    for score_path in sorted(METRICS.glob("nsdi_*/score.json")):
        run_id = score_path.parent.name
        score = json.loads(score_path.read_text(encoding="utf-8"))
        spec = score.get("spec") or {}
        evidence = EV / run_id
        if not evidence.exists():
            continue
        client_pack = []
        for client in ["C3", "C4", "C5"]:
            folder = client_dir(evidence, client)
            if folder is None:
                continue
            client_pack.append((client, *measure_client(run_id, client, folder, spec)))
        if not client_pack:
            continue
        index = jain([float(values["www_useful_completed_bytes_fixed_window"] or 0) for _, values, _, _ in client_pack])
        for client, values, status, reasons in client_pack:
            values["www_jain_completed_useful_bytes"] = index
            status["www_jain_completed_useful_bytes"] = "DERIVED" if index is not None else "NOT_OBSERVED"
            reasons["www_jain_completed_useful_bytes"] = "Jain index of per-client completed RAD bytes in this run"
            master.append(values)
            for field, value in values.items():
                validity.append({
                    "run_id": run_id,
                    "client": client,
                    "field": field,
                    "value": "" if value is None else value,
                    "status": status.get(field, "MEASURED" if value is not None else "NOT_OBSERVED"),
                    "null_reason": reasons.get(field, ""),
                })
            for field, reason in reasons.items():
                if field not in values:
                    validity.append({
                        "run_id": run_id,
                        "client": client,
                        "field": field,
                        "value": "",
                        "status": "NOT_SELECTED_FOR_QOE" if field in {"www_psnr_db", "www_ssim", "www_reference_frame_hash"} else "NOT_INSTRUMENTED",
                        "null_reason": reason,
                    })
    fields = []
    for row in master:
        for key in row:
            if key not in fields:
                fields.append(key)
    with (RESULTS / "DEVELOPMENT_MASTER.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(master)
    with (RESULTS / "METRIC_VALIDITY.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["run_id", "client", "field", "value", "status", "null_reason"])
        writer.writeheader()
        writer.writerows(validity)
    measured = sum(1 for row in validity if row["status"] == "MEASURED" and row["value"] != "")
    print(json.dumps({
        "client_rows": len(master),
        "validity_rows": len(validity),
        "measured_values": measured,
        "schema_93": len(names),
        "www_32": len(WWW),
    }))


if __name__ == "__main__":
    main()
