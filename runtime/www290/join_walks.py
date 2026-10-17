import json
from pathlib import Path

ROOT = Path(r"F:\WWW_N3_MUX\evidence")
RUN = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1"


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    index = round(q * (len(ordered) - 1))
    return ordered[index]


def summarize(rows):
    times = [row["worker_traverse_ms"] for row in rows]
    splats = [row["lod_splats"] for row in rows]
    return {
        "n": len(rows),
        "traverse_p50_ms": percentile(times, 0.5),
        "traverse_p95_ms": percentile(times, 0.95),
        "lod_splats_min": min(splats) if splats else None,
        "lod_splats_p50": percentile(splats, 0.5),
        "lod_splats_max": max(splats) if splats else None,
    }


def load_client(client):
    path = ROOT / RUN / client / client / f"{client}_spark_events.jsonl"
    pending = None
    closed = None
    rows = []
    unpaired_end = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            event = json.loads(line)
            kind = event.get("kind")
            if event.get("type") == "traversal_start" and kind == "display":
                pending = event
            elif event.get("type") == "traversal_end" and kind == "display" and pending is not None:
                closed = {
                    "max_splats": pending["max_splats"],
                    "pixel_scale_limit": pending["pixel_scale_limit"],
                    "view": pending.get("view"),
                    "worker_traverse_ms": event["worker_traverse_ms"],
                }
                pending = None
            elif event.get("type") == "draw_index_build_end" and kind == "display":
                if closed is None:
                    unpaired_end += 1
                    continue
                closed["lod_splats"] = event["lod_splats"]
                rows.append(closed)
                closed = None
    limits = sorted({round(row["pixel_scale_limit"], 6) for row in rows})
    caps = sorted({row["max_splats"] for row in rows})
    pinned = [row for row in rows if row["lod_splats"] >= 3_300_000]
    at_cap = [row for row in rows if row["lod_splats"] == 3_750_000]
    bins = []
    for low, high, label in (
        (0, 0, "empty"),
        (1, 100_000, "1_to_100k"),
        (100_000, 1_000_000, "100k_to_1m"),
        (1_000_000, 3_300_000, "1m_to_3_3m"),
        (3_300_000, 3_750_001, "at_least_3_3m"),
    ):
        if label == "empty":
            chosen = [row for row in rows if row["lod_splats"] == 0]
        elif label == "at_least_3_3m":
            chosen = [row for row in rows if row["lod_splats"] >= 3_300_000]
        else:
            chosen = [row for row in rows if low <= row["lod_splats"] < high]
        bins.append({"bin": label, **summarize(chosen)})
    return {
        "client": client,
        "paired": len(rows),
        "unpaired_draw": unpaired_end,
        "pixel_scale_limits": limits,
        "max_splats": caps,
        "pinned_3_3m": summarize(pinned),
        "exactly_3750000": len(at_cap),
        "bins": bins,
    }


report = {
    "run": RUN,
    "pairing": "display traversal_start, the following display traversal_end, then the following display draw_index_build_end",
    "clients": [load_client("C3"), load_client("C4")],
}
out = Path(r"F:\WWW_N3_MUX\results\WWW290_WALK_JOIN.json")
out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
