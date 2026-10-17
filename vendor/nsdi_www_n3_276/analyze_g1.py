"""G1 scores: inflight send-to-first, hop leak, origin reuse. Missing Vite join stays null."""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

EV = Path(r"F:\WWW_N3_MUX\evidence")
METRICS = Path(r"F:\WWW_N3_MUX\metrics")
OUT = Path(r"D:\Program\NSDI_SPADE_HARNESS\research\www_n3_276")
STOP_MS = 30.0


def rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def median(values: list[float]) -> float | None:
    return None if not values else float(statistics.median(values))


def ledger(run_id: str) -> dict:
    proxy = rows(EV / run_id / "S_runtime" / "proxy.jsonl")
    by = defaultdict(int)
    n = defaultdict(int)
    keys_by_user: dict[str, set[str]] = defaultdict(set)
    for row in proxy:
        by[row["decision"]] += int(row["bytes_to_client"])
        n[row["decision"]] += 1
        user = str(row.get("user_id") or "")
        key = f"{row.get('url')}:{row.get('range_start')}-{row.get('range_end')}"
        keys_by_user[user].add(key)
    demand = sum(by.values())
    origin = sum(int(row["bytes_from_origin"]) for row in proxy)
    sets = list(keys_by_user.values())
    jaccard: dict[str, float | None] = {}
    names = sorted(keys_by_user)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            sa, sb = keys_by_user[a], keys_by_user[b]
            union = len(sa | sb)
            jaccard[f"{a}∩{b}"] = None if not union else len(sa & sb) / union
    triple = None
    if len(sets) >= 3:
        inter = set.intersection(*sets)
        union = set.union(*sets)
        triple = None if not union else len(inter) / len(union)
    return {
        "requests": len(proxy),
        "demand_bytes": demand,
        "origin_bytes": origin,
        "counts": dict(n),
        "bytes": dict(by),
        "saved_fraction": None if not demand else (demand - origin) / demand,
        "jaccard_pairwise": jaccard,
        "jaccard_triple": triple,
    }


def inflight_send(life: list[dict]) -> dict[int, list[float]]:
    rad = [row for row in life if ".rad" in str(row.get("url") or "") and row.get("requestSent") is not None]
    rad.sort(key=lambda row: row["requestSent"])
    buckets: dict[int, list[float]] = defaultdict(list)
    for index, row in enumerate(rad):
        sent = row["requestSent"]
        first = row.get("firstData")
        inflight = 1
        for other in rad[:index]:
            other_first = other.get("firstData")
            if other["requestSent"] <= sent and (other_first is None or other_first > sent):
                inflight += 1
        if first is not None:
            buckets[inflight].append((first - sent) * 1000)
    return buckets


def hop_check(run_id: str, hop: str | None, life_urls: list[str]) -> dict:
    n = len(life_urls)
    n_18443 = sum(1 for url in life_urls if ":18443" in url)
    n_18081 = sum(1 for url in life_urls if ":18081" in url)
    n_p5rad = sum(1 for url in life_urls if "/_p5rad/" in url)
    leak = False
    if hop == "rad_h2":
        leak = n == 0 or n_18443 / n < 0.8
    elif hop == "vite_h1":
        leak = n == 0 or n_p5rad / n < 0.8
    elif hop == "rad_direct":
        leak = n == 0 or n_18081 / n < 0.8
    return {
        "n_rad_urls": n,
        "n_18443": n_18443,
        "n_18081": n_18081,
        "n_p5rad": n_p5rad,
        "treatment_leak": leak,
    }


def client_summary(run_id: str, client: str, hop: str | None) -> dict | None:
    folder = EV / run_id / client / client
    if not folder.exists():
        folder = EV / run_id / client
    ev_path = folder / f"{client}_evidence.json"
    life_path = folder / f"{client}_request_lifecycle.jsonl"
    if not ev_path.exists() or not life_path.exists():
        return None
    evidence = json.loads(ev_path.read_text(encoding="utf-8"))
    life = rows(life_path)
    urls = [str(row.get("url") or "") for row in life if ".rad" in str(row.get("url") or "")]
    buckets = inflight_send(life)
    return {
        "verdict": evidence.get("verdict"),
        "frames": (evidence.get("trace_replay") or {}).get("frames_replayed_final"),
        "camera_changed": (evidence.get("trace_replay") or {}).get("camera_changed"),
        "rad_206": (evidence.get("network") or {}).get("rad_206_count"),
        "inflight": {
            str(key): {"n": len(values), "send_to_first_p50_ms": median(values)}
            for key, values in sorted(buckets.items())
        },
        "inflight3_p50_ms": median(buckets.get(3, [])),
        "inflight1_p50_ms": median(buckets.get(1, [])),
        "all_p50_ms": median([item for values in buckets.values() for item in values]),
        "hop": hop_check(run_id, hop, urls),
        "send_to_vite_p50_ms": None,
        "send_to_vite_reason": "no join from browser requestSent to vite accept_ms",
    }


def vite_stage_summary(stages: list[dict]) -> dict:
    gaps = []
    missing = 0
    for row in stages:
        accept = row.get("accept_ms")
        headers = row.get("headers_ms")
        if accept is None or headers is None:
            missing += 1
            continue
        gaps.append(float(headers) - float(accept))
    return {
        "rows": len(stages),
        "missing_timestamp_rows": missing,
        "accept_to_headers_p50_ms": median(gaps),
    }


def spec_of(run_id: str) -> dict:
    path = METRICS / run_id / "cell_spec.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def score_run(run_id: str) -> dict:
    spec = spec_of(run_id)
    hop = spec.get("hop")
    n = int(spec.get("n") or (3 if "_N3_" in run_id else 2 if "_N2_" in run_id else 1))
    clients = ["C3", "C4", "C5"][:n]
    client_rows = {client: client_summary(run_id, client, hop) for client in clients}
    leak = any((row or {}).get("hop", {}).get("treatment_leak") for row in client_rows.values() if row)
    vite_stages = rows(EV / run_id / "S_runtime" / "vite_rad_stages.jsonl")
    stage = vite_stage_summary(vite_stages)
    out = {
        "spec": spec,
        "ledger": ledger(run_id),
        "clients": client_rows,
        "treatment_leak": leak,
        "vite_stage_rows": stage["rows"],
        "vite_accept_to_headers_p50_ms": stage["accept_to_headers_p50_ms"],
        "vite_stage_missing_timestamp_rows": stage["missing_timestamp_rows"],
        "send_to_vite_p50_ms": None,
        "send_to_vite_reason": "no join from browser requestSent to vite accept_ms",
    }
    METRICS.joinpath(run_id).mkdir(parents=True, exist_ok=True)
    (METRICS / run_id / "score.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return out


def inflight3_median(score: dict) -> float | None:
    values = []
    for row in (score.get("clients") or {}).values():
        if not row:
            continue
        p50 = row.get("inflight3_p50_ms")
        if p50 is not None:
            values.append(p50)
    return median(values)


def stop_rule(report: dict) -> dict:
    pairs = []
    for run_id, score in report.items():
        spec = score.get("spec") or {}
        if spec.get("n") != 2 or spec.get("slots") != 3:
            continue
        if score.get("treatment_leak"):
            continue
        pairs.append((spec.get("hop"), inflight3_median(score), run_id))
    h1 = [p50 for hop, p50, _ in pairs if hop == "vite_h1" and p50 is not None]
    h2 = [p50 for hop, p50, _ in pairs if hop == "rad_h2" and p50 is not None]
    drop = None
    if h1 and h2:
        drop = float(statistics.median(h1) - statistics.median(h2))
    mux_works = drop is not None and drop > STOP_MS
    return {
        "h1_inflight3_p50_ms": median(h1),
        "h2_inflight3_p50_ms": median(h2),
        "drop_ms": drop,
        "stop_threshold_ms": STOP_MS,
        "range_mux_works": mux_works,
        "cancel_slot_expansion": drop is not None and not mux_works,
        "cancel_burst_turn": drop is not None and not mux_works,
    }


def main() -> None:
    if not EV.exists():
        report = {}
    else:
        runs = sorted(path.name for path in EV.iterdir() if path.is_dir() and path.name.startswith("nsdi_"))
        report = {run_id: score_run(run_id) for run_id in runs}
    decision = stop_rule(report)
    blob = {"runs": report, "stop_rule": decision}
    METRICS.mkdir(parents=True, exist_ok=True)
    (METRICS / "G1_SCORES.json").write_text(json.dumps(blob, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (OUT / "G1_SCORES.json").write_text(json.dumps(blob, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(decision, ensure_ascii=False, indent=2))
    if len(sys.argv) > 1:
        run_id = sys.argv[1]
        print(json.dumps(report.get(run_id, {}), ensure_ascii=False, indent=2)[:4000])


if __name__ == "__main__":
    main()
