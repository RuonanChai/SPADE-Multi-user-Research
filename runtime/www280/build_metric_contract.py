"""Recover the frozen 93-field catalog and attach the 32 WWW fields.

Does not invent measurements. Uninstrumented fields stay NULL with a status.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

SCHEMA_PATH = Path(r"D:\Program\P5_3DGS_ICASSP_CLEAN\research_archive\icassp_campaign_v1\22_state\FINAL_METRIC_SCHEMA.json")
WAVE = Path(r"F:\WWW_N3_MUX")

WWW_FIELDS = [
    ("www_hop_protocol", "string", "label", "browser telemetry plus server proof"),
    ("www_h2_confirmed_by_browser", "bool", "none", "true only for actual browser RAD HTTP/2"),
    ("www_range206_success_count", "int", "count", "valid RAD HTTP 206 responses"),
    ("www_range_content_sha_match", "bool", "none", "content parity; unknown without reference bytes"),
    ("www_application_inflight_peak", "int", "count", "peak application-admitted RAD requests"),
    ("www_headers_pending_peak", "int", "count", "peak requests waiting for first response byte"),
    ("www_body_active_peak", "int", "count", "peak responses with body started and not complete"),
    ("www_total_inflight_peak", "int", "count", "peak requests from dispatch until body completion"),
    ("www_proxy_downstream_pending_peak_bytes", "int", "bytes", "peak unsent proxy downstream bytes"),
    ("www_browser_queue_wait_p95_ms", "float", "ms", "p95 browser queue wait"),
    ("www_send_to_first_p95_ms", "float", "ms", "p95 send to first byte"),
    ("www_send_to_complete_p50_ms", "float", "ms", "p50 send to complete"),
    ("www_send_to_complete_p95_ms", "float", "ms", "p95 send to complete"),
    ("www_header_wait_p50_ms", "float", "ms", "p50 dispatch to first byte"),
    ("www_body_transfer_p95_ms", "float", "ms", "p95 first byte to body end"),
    ("www_206_completed_count", "int", "count", "completed RAD 206 in the fixed window"),
    ("www_useful_completed_bytes_fixed_window", "int", "bytes", "useful demanded payload completed in window"),
    ("www_unfinished_206_count", "int", "count", "started RAD requests unfinished at window end"),
    ("www_cancelled_206_count", "int", "count", "RAD requests cancelled before complete"),
    ("www_exposed_demand_bytes_fixed_window", "int", "bytes", "browser-exposed demanded RAD bytes"),
    ("www_view_change_t0_valid", "bool", "none", "valid T0 and continuous light observation"),
    ("www_chunk_draw_inclusion_count", "int", "count", "newly demanded chunks included in submitted draws"),
    ("www_view_change_to_new_draw_p50_ms", "float", "ms", "T0 to submitted draw, not display presentation"),
    ("www_visible_quality_t1", "float", "none", "non-image visible progress at +1 s"),
    ("www_visible_quality_t3", "float", "none", "non-image visible progress at +3 s"),
    ("www_visible_quality_t5", "float", "none", "non-image visible progress at +5 s"),
    ("www_psnr_db", "float", "dB", "pose-matched PSNR on QoE-sampled cells only"),
    ("www_ssim", "float", "none", "pose-matched SSIM on QoE-sampled cells only"),
    ("www_qoe_sampling_status", "string", "label", "NOT_SELECTED, SELECTED_VALID, or SELECTED_FAILED"),
    ("www_reference_frame_hash", "string", "sha256", "reference frame recipe hash"),
    ("www_jain_completed_useful_bytes", "float", "none", "Jain index of useful completed bytes"),
    ("www_observer_overhead_p95_ms", "float", "ms", "p95 observer cost"),
]


def cell_of(score: dict, run_id: str, client: str) -> dict:
    spec = score.get("spec") or {}
    ledger = score.get("ledger") or {}
    body = (score.get("clients") or {}).get(client) or {}
    counts = ledger.get("counts") or {}
    inflight = body.get("inflight") or {}
    peak = max((int(key) for key in inflight), default=None)
    hop = spec.get("hop")
    scheduler = spec.get("client_scheduler") or ("SPADE" if "_spade_" in run_id else "LRU")
    values = {
        "cell_id": run_id,
        "run_id": run_id,
        "logical_id": f"{scheduler}-N{spec.get('n')}-{hop}-s{spec.get('slots')}-{client}",
        "N": spec.get("n"),
        "method": spec.get("method") or "LRU",
        "scene": "coit-40m-sh1-lod",
        "trace": "stop_go",
        "rep": run_id.rsplit("_r", 1)[-1],
        "selected_clients": client,
        "origin_bytes": ledger.get("origin_bytes"),
        "client_bytes_total": ledger.get("demand_bytes"),
        "total_requests": ledger.get("requests"),
        "cache_hits": counts.get("cache_hit"),
        "inflight_merges": counts.get("inflight_merge"),
        "request_ttfb_p50": body.get("all_p50_ms"),
        "www_hop_protocol": hop,
        "www_h2_confirmed_by_browser": None,
        "www_range206_success_count": body.get("rad_206"),
        "www_application_inflight_peak": peak,
        "www_206_completed_count": body.get("rad_206"),
        "www_qoe_sampling_status": "NOT_SELECTED",
        "www_view_change_t0_valid": None,
        "www_psnr_db": None,
        "www_ssim": None,
    }
    status = {name: "DERIVED" if values.get(name) is not None else "NOT_INSTRUMENTED" for name in values}
    status["www_qoe_sampling_status"] = "NOT_SELECTED_FOR_QOE"
    status["www_psnr_db"] = "NOT_SELECTED_FOR_QOE"
    status["www_ssim"] = "NOT_SELECTED_FOR_QOE"
    status["www_h2_confirmed_by_browser"] = "NOT_INSTRUMENTED"
    status["www_view_change_t0_valid"] = "NOT_INSTRUMENTED"
    if body.get("verdict") == "VALID" and body.get("all_p50_ms") is not None:
        status["request_ttfb_p50"] = "MEASURED"
    if body.get("rad_206") is not None:
        status["www_range206_success_count"] = "MEASURED"
        status["www_206_completed_count"] = "MEASURED"
    if peak is not None:
        status["www_application_inflight_peak"] = "MEASURED"
    reasons = {
        "www_h2_confirmed_by_browser": "URL or hop label is not browser ALPN or nextHopProtocol",
        "www_psnr_db": "cell was not pre-registered for QoE sampling; LIGHT mode stores no frames",
        "www_ssim": "cell was not pre-registered for QoE sampling; LIGHT mode stores no frames",
        "www_view_change_t0_valid": "no view-change T0 observer was installed before the camera move",
        "www_chunk_draw_inclusion_count": "submitted draw inclusion is not instrumented; GPU upload is not a substitute",
    }
    return {"values": values, "status": status, "reasons": reasons, "verdict": body.get("verdict")}


def main() -> None:
    raw = SCHEMA_PATH.read_bytes()
    catalog = json.loads(raw)
    original = catalog["metrics"]
    names = [item["name"] for item in original]
    if len(names) != 93 or len(set(names)) != 93:
        raise SystemExit(f"SCHEMA_93_SOURCE_MISSING count={len(names)} unique={len(set(names))}")
    www_names = [item[0] for item in WWW_FIELDS]
    overlap = sorted(set(names) & set(www_names))
    if overlap:
        raise SystemExit(f"WWW names collide with the frozen catalog: {overlap}")
    control = WAVE / "control"
    metrics = WAVE / "metrics"
    control.mkdir(exist_ok=True)
    frozen = {
        "schema_id": "exact93",
        "source_path": str(SCHEMA_PATH),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "source_schema_version": catalog.get("schema_version"),
        "authority": catalog.get("authority"),
        "field_count": 93,
        "names": names,
        "metrics": original,
        "mutated": False,
    }
    (control / "FINAL_METRIC_SCHEMA_93.json").write_text(json.dumps(frozen, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    contract = {
        "schema_id": "www-125-v1",
        "original_93_sha256": frozen["source_sha256"],
        "field_count": 125,
        "original_names": names,
        "www_fields": [
            {"name": name, "type": kind, "unit": unit, "denominator": denominator, "missing": "NULL"}
            for name, kind, unit, denominator in WWW_FIELDS
        ],
        "qoe_rule": "PSNR and SSIM are NOT_SELECTED_FOR_QOE unless the frozen sampling manifest selects the cell",
        "light_mode": "no per-cell screenshots",
        "note": "125 columns are not 125 measured quantities",
    }
    (control / "METRIC_CONTRACT_125.json").write_text(json.dumps(contract, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (control / "SCHEMA_DIFF.json").write_text(json.dumps({
        "original_count": 93,
        "added_count": 32,
        "removed": [],
        "renamed": [],
        "added": www_names,
        "collision": overlap,
    }, indent=2) + "\n", encoding="utf-8")
    (control / "QOE_SAMPLING_MANIFEST.json").write_text(json.dumps({
        "status": "DEVELOPMENT_NONE_SELECTED",
        "reason": "No confirmation matrix is frozen. Every current physical cell is LIGHT mode.",
        "selected_run_ids": [],
        "checkpoints_s": [0.5, 1, 2, 5],
        "psnr_ssim": "offline only after a pre-registered sampled cell",
        "render_visible": None,
        "draw_inclusion_is_not_presentation": True,
    }, indent=2) + "\n", encoding="utf-8")

    ledger_rows = []
    run_rows = []
    for score_path in sorted((metrics).glob("*/score.json")):
        score = json.loads(score_path.read_text(encoding="utf-8"))
        run_id = score_path.parent.name
        for client in (score.get("clients") or {}):
            built = cell_of(score, run_id, client)
            row = {"run_id": run_id, "client": client, "run_verdict": built["verdict"] or ""}
            present = 0
            for name in names + www_names:
                value = built["values"].get(name)
                field_status = built["status"].get(name, "NOT_INSTRUMENTED")
                if value is not None and field_status not in {"NOT_SELECTED_FOR_QOE"}:
                    present += 1
                row[name] = "" if value is None else value
                ledger_rows.append({
                    "run_id": run_id,
                    "client": client,
                    "field": name,
                    "value": "" if value is None else value,
                    "status": field_status,
                    "provenance": "score.json" if value is not None else SCHEMA_PATH.name,
                    "unit": next((item[2] for item in WWW_FIELDS if item[0] == name), "see exact93"),
                    "denominator": next((item[3] for item in WWW_FIELDS if item[0] == name), "frozen exact93 definition"),
                    "null_reason": built["reasons"].get(name, "" if value is not None else "not present in the G1 score.json extraction"),
                })
            row["fields_with_values"] = present
            row["canonical_columns"] = 125
            run_rows.append(row)
    write_csv(metrics / "RUN_METRICS.csv", run_rows)
    write_csv(metrics / "METRIC_VALIDITY_LEDGER.csv", ledger_rows)
    summary = {
        "runs": len({row["run_id"] for row in run_rows}),
        "client_rows": len(run_rows),
        "ledger_rows": len(ledger_rows),
        "canonical_columns": 125,
        "measured_claim": "headers exist; non-null counts are per row in RUN_METRICS.csv and are not 125 measured quantities",
    }
    (metrics / "SCHEMA_VALIDATION.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary))


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = list(rows[0].keys())
    for row in rows[1:]:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
