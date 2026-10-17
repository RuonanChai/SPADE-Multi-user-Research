"""Read-only reuse of Ethernet N=3 LRU staging. Writes scores into this directory."""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(r"D:\Program\P5_3DGS_ICASSP_CLEAN\research_archive\icassp_campaign_v1\05_staging")
RUN = "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_synchronized_rep3105_1792032224255"
OUT = Path(r"D:\Program\NSDI_SPADE_HARNESS\research\www_n3_276\N3_REUSE_SCORES.json")
USERS = {"user_C3_0": "C3", "user_C4_1": "C4", "user_C5_2": "C5"}


def rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def median(values: list[float]) -> float | None:
    return None if not values else float(statistics.median(values))


def jaccard(a: set, b: set) -> float | None:
    if not a and not b:
        return None
    return len(a & b) / len(a | b)


def inflight_send(life: list[dict]) -> dict[int, list[float]]:
    rad = [
        row
        for row in life
        if ".rad" in str(row.get("url") or "") and row.get("requestSent") is not None
    ]
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


def main() -> None:
    base = ROOT / RUN
    proxy = rows(base / "S_runtime" / "proxy.jsonl")
    by_user: dict[str, set[tuple[int, int]]] = defaultdict(set)
    by_decision = defaultdict(int)
    n_decision = defaultdict(int)
    origin = 0
    demand = 0
    for row in proxy:
        key = (int(row["range_start"]), int(row["range_end"]))
        user = USERS.get(str(row.get("user_id") or ""), str(row.get("user_id") or ""))
        by_user[user].add(key)
        dec = "cache_hit" if row.get("cache_hit") else "origin_or_merge"
        # prefer explicit decision if present
        if "decision" in row:
            dec = str(row["decision"])
        n_decision[dec] += 1
        by_decision[dec] += int(row.get("bytes_to_client") or 0)
        origin += int(row.get("bytes_from_origin") or 0)
        demand += int(row.get("bytes_to_client") or 0)
    sets = {name: by_user.get(name, set()) for name in ("C3", "C4", "C5")}
    union = sets["C3"] | sets["C4"] | sets["C5"]
    inter = sets["C3"] & sets["C4"] & sets["C5"]
    c5_new = sets["C5"] - (sets["C3"] | sets["C4"])
    clients = {}
    for name in ("C3", "C4", "C5"):
        folder = base / f"{name}_evidence"
        evidence = json.loads((folder / f"{name}_evidence.json").read_text(encoding="utf-8"))
        buckets = inflight_send(rows(folder / f"{name}_request_lifecycle.jsonl"))
        clients[name] = {
            "verdict": evidence.get("verdict"),
            "frames": (evidence.get("trace_replay") or {}).get("frames_replayed_final"),
            "rad_206": (evidence.get("network") or {}).get("rad_206_count"),
            "range_keys": len(sets[name]),
            "inflight": {
                str(key): {"n": len(values), "send_to_first_p50_ms": median(values)}
                for key, values in sorted(buckets.items())
            },
            "all_p50_ms": median([item for values in buckets.values() for item in values]),
        }
    metrics = json.loads((base / "S_runtime" / "scheduler_final_metrics.json").read_text(encoding="utf-8"))
    unique_origin = int(metrics["origin_bytes"])
    report = {
        "run_id": RUN,
        "source": str(base),
        "labeled": "NONPAPER_ETHERNET_LRU_N3 in run_manifest",
        "requests": len(proxy),
        "demand_bytes": demand,
        "proxy_sum_bytes_from_origin": origin,
        "origin_bytes_unique": unique_origin,
        "saved_fraction": None if not demand else (demand - unique_origin) / demand,
        "scheduler": {
            "cache_hits": metrics.get("cache_hits"),
            "cache_misses": metrics.get("cache_misses"),
            "inflight_merges": metrics.get("inflight_merges"),
            "client_bytes": metrics.get("client_bytes"),
        },
        "decision_counts": dict(n_decision),
        "decision_bytes": dict(by_decision),
        "jaccard": {
            "C3_C4": jaccard(sets["C3"], sets["C4"]),
            "C3_C5": jaccard(sets["C3"], sets["C5"]),
            "C4_C5": jaccard(sets["C4"], sets["C5"]),
            "triple": None if not union else len(inter) / len(union),
        },
        "c5_new_keys": len(c5_new),
        "c5_new_over_c5": None if not sets["C5"] else len(c5_new) / len(sets["C5"]),
        "union_keys": len(union),
        "triple_keys": len(inter),
        "clients": clients,
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
