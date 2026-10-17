"""Split loaded-scene display traversal wall time from draw-index build.

elapsed_ms is the worker round trip around traverseLodTrees, not a CPU profile.
"""

from __future__ import annotations

import json
from pathlib import Path

RID = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_lodtimeline_r1"
EV = Path(r"F:\WWW_N3_MUX\evidence") / RID


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def summarize(values: list[float]) -> dict:
    return {
        "n": len(values),
        "p50_ms": pct(values, 0.5),
        "p95_ms": pct(values, 0.95),
        "max_ms": max(values) if values else None,
    }


def analyze(client: str) -> dict:
    path = next((EV / client).rglob(f"{client}_spark_events.jsonl"))
    display = []
    raycast = []
    index = []
    splats = []
    pending = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if "traversal_" not in line and "draw_index_build_end" not in line:
                continue
            event = json.loads(line)
            kind = event.get("kind")
            if event.get("type") == "traversal_end" and isinstance(event.get("elapsed_ms"), (int, float)):
                elapsed = float(event["elapsed_ms"])
                if kind == "raycast":
                    raycast.append(elapsed)
                    pending = None
                else:
                    display.append(elapsed)
                    pending = float(event["mono_ms"]) if isinstance(event.get("mono_ms"), (int, float)) else None
            elif event.get("type") == "draw_index_build_end" and pending is not None and isinstance(event.get("mono_ms"), (int, float)):
                index.append(float(event["mono_ms"]) - pending)
                if isinstance(event.get("lod_splats"), int):
                    splats.append(event["lod_splats"])
                pending = None
    return {
        "client": client,
        "lod_splats_max": max(splats) if splats else 0,
        "display_worker_round_trip": summarize(display),
        "draw_index_build": summarize(index),
        "raycast_worker_round_trip": summarize(raycast),
        "clock": "performance.now around the awaited worker call; not a CPU counter and not added to queue wait",
    }


def main() -> None:
    report = [analyze(client) for client in ("C3", "C4")]
    out = Path(r"F:\WWW_N3_MUX\results\WWW288_LOD_TIMELINE.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
