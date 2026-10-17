"""Apply paired worker durations from a loaded-scene spark log."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from round_trip import split_round_trip


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def stats(values: list[float]) -> dict:
    return {"n": len(values), "p50_ms": pct(values, 0.5), "p95_ms": pct(values, 0.95), "max_ms": max(values) if values else None}


def analyze(path: Path) -> dict:
    outer = []
    traverse = []
    prep = []
    pack = []
    message = []
    rejected = 0
    missing = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if '"traversal_end"' not in line:
                continue
            event = json.loads(line)
            if event.get("kind") != "display":
                continue
            if not isinstance(event.get("worker_traverse_ms"), (int, float)):
                missing += 1
                continue
            split = split_round_trip(
                float(event["elapsed_ms"]),
                float(event["worker_prep_ms"]),
                float(event["worker_traverse_ms"]),
                float(event["worker_pack_ms"]),
            )
            if split["status"] != "PAIRED":
                rejected += 1
                continue
            outer.append(split["outer_ms"])
            prep.append(split["worker_prep_ms"])
            traverse.append(split["worker_traverse_ms"])
            pack.append(split["worker_pack_ms"])
            message.append(split["message_and_schedule_ms"])
    return {
        "outer": stats(outer),
        "worker_prep": stats(prep),
        "worker_traverse": stats(traverse),
        "worker_pack": stats(pack),
        "message_and_schedule": stats(message),
        "rejected": rejected,
        "missing_worker_timing": missing,
    }


def main() -> None:
    evidence = Path(sys.argv[1])
    report = {}
    for client in ("C3", "C4"):
        path = next((evidence / client).rglob(f"{client}_spark_events.jsonl"))
        report[client] = analyze(path)
    out = Path(r"F:\WWW_N3_MUX\results\WWW289_ROUND_TRIP.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
