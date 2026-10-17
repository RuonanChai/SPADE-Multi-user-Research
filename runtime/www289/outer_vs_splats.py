"""Relate the loaded-scene outer traversal wall to the draw-index size.

The index buffer is transferred, so a large index does not by itself prove a copy cost.
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


def analyze(client: str) -> dict:
    path = next((EV / client).rglob(f"{client}_spark_events.jsonl"))
    rows = []
    pending = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if "traversal_end" not in line and "draw_index_build_end" not in line:
                continue
            event = json.loads(line)
            if event.get("type") == "traversal_end" and event.get("kind") == "display" and isinstance(event.get("elapsed_ms"), (int, float)):
                pending = float(event["elapsed_ms"])
            elif event.get("type") == "draw_index_build_end" and pending is not None and isinstance(event.get("lod_splats"), int):
                rows.append((event["lod_splats"], pending))
                pending = None
    rows.sort()
    third = max(1, len(rows) // 3)
    low = [elapsed for _splats, elapsed in rows[:third]]
    high = [elapsed for _splats, elapsed in rows[-third:]]
    return {
        "client": client,
        "n": len(rows),
        "lod_splats_min": rows[0][0] if rows else None,
        "lod_splats_max": rows[-1][0] if rows else None,
        "outer_p50_when_fewer_splats_ms": pct(low, 0.5),
        "outer_p50_when_more_splats_ms": pct(high, 0.5),
        "fewer_splats_max": rows[third - 1][0] if rows else None,
        "more_splats_min": rows[-third][0] if rows else None,
    }


def main() -> None:
    report = [analyze(client) for client in ("C3", "C4")]
    out = Path(r"F:\WWW_N3_MUX\results\WWW289_OUTER_VS_SPLATS.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
