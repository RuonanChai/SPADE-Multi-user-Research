"""Separate queue wait from in-callback wall time on the draw canary.

Chunk medians are not added together. A shared LOD update is one batch.
"""

from __future__ import annotations

import json
from pathlib import Path

RID = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_drawcanary_r1"
EV = Path(r"F:\WWW_N3_MUX\evidence") / RID


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def load(client: str) -> list[dict]:
    path = next(EV.rglob(f"{client}_spark_events.jsonl"))
    wanted = (
        "new_uploads",
        "ready_uploads",
        "lod_worker_update_start",
        "lod_worker_update_end",
        "upload_start",
        "lod_exclusive_busy",
        "page_allocated",
    )
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not any(f'"type":"{name}"' in line for name in wanted):
                continue
            rows.append(json.loads(line))
    return rows


def analyze(client: str) -> dict:
    return report_events(load(client), client)


def report_events(events: list[dict], client: str) -> dict:
    queue_waits = []
    pending: dict[tuple[int, int], float] = {}
    ready: dict[tuple[int, int], float] = {}
    batch_walls = []
    batch_sizes = []
    spreads = []
    eviction_only = 0
    upload_matched = 0
    current_ready: list[tuple[int, int]] = []
    end_mono = None
    for event in events:
        kind = event.get("type")
        mono = event.get("mono_ms")
        if not isinstance(mono, (int, float)):
            continue
        mono = float(mono)
        if kind == "new_uploads":
            key = (event.get("chunk"), event.get("page"))
            if isinstance(key[0], int) and isinstance(key[1], int):
                pending[key] = mono
        elif kind == "ready_uploads":
            key = (event.get("chunk"), event.get("page"))
            if key in pending:
                queue_waits.append(mono - pending.pop(key))
            if isinstance(key[0], int) and isinstance(key[1], int):
                ready[key] = mono
                current_ready.append(key)
        elif kind == "lod_worker_update_end":
            listed = {(item.get("chunk"), item.get("page")) for item in (event.get("chunks") or [])}
            accepted = [key for key in current_ready if key in listed or key in ready]
            eviction_only += len(listed - set(current_ready))
            end_mono = mono
            current_ready = []
            batch_walls.append({"end": mono, "keys": accepted})
        elif kind == "upload_start" and end_mono is not None and batch_walls:
            key = (event.get("chunk"), event.get("page"))
            batch = batch_walls[-1]
            if key in batch["keys"] and "deltas" not in batch:
                batch["deltas"] = []
            if key in batch.get("keys", []) and "deltas" in batch:
                batch["deltas"].append(mono - batch["end"])
                upload_matched += 1
                batch["keys"].remove(key)
    walls = []
    ends = []
    chunk_walls = []
    for batch in batch_walls:
        ends.append(batch["end"])
        deltas = batch.get("deltas") or []
        if not deltas:
            continue
        walls.append(min(deltas))
        chunk_walls.extend(deltas)
        batch_sizes.append(float(len(deltas)))
        spreads.append(max(deltas) - min(deltas))
    gaps = [ends[index] - ends[index - 1] for index in range(1, len(ends))]
    traverse_elapsed = []
    index_build = []
    traverse_end = None
    for event in events:
        if event.get("kind") not in (None, "display"):
            continue
        if event.get("type") == "traversal_end" and isinstance(event.get("elapsed_ms"), (int, float)):
            traverse_elapsed.append(float(event["elapsed_ms"]))
            if isinstance(event.get("mono_ms"), (int, float)):
                traverse_end = float(event["mono_ms"])
        elif event.get("type") == "draw_index_build_end" and traverse_end is not None and isinstance(event.get("mono_ms"), (int, float)):
            index_build.append(float(event["mono_ms"]) - traverse_end)
            traverse_end = None
    return {
        "client": client,
        "queue_wait_n": len(queue_waits),
        "queue_wait_p50_ms": pct(queue_waits, 0.5),
        "queue_wait_p95_ms": pct(queue_waits, 0.95),
        "accepted_batches_with_upload": len(walls),
        "same_accept_chunk_wall_p50_ms": pct(chunk_walls, 0.5),
        "in_callback_wall_p50_ms": pct(walls, 0.5),
        "in_callback_wall_p95_ms": pct(walls, 0.95),
        "in_callback_wall_max_ms": max(walls) if walls else None,
        "in_callback_wall_sum_ms": sum(walls),
        "lod_end_spacing_p50_ms": pct(gaps, 0.5),
        "lod_end_spacing_sum_ms": sum(gaps),
        "uploads_in_batch_p50": pct(batch_sizes, 0.5),
        "same_batch_upload_spread_p95_ms": pct(spreads, 0.95),
        "upload_matched_to_same_accept": upload_matched,
        "update_entries_without_ready_upload": eviction_only,
        "not_added_to_queue_wait": True,
        "display_traverse_elapsed_p50_ms": pct(traverse_elapsed, 0.5),
        "display_traverse_n": len(traverse_elapsed),
        "index_build_p50_ms": pct(index_build, 0.5),
        "index_build_n": len(index_build),
        "traverse_events": "MEASURED" if traverse_elapsed else "ABSENT",
    }


def main() -> None:
    report = [analyze(client) for client in ("C3", "C4")]
    out = Path(r"F:\WWW_N3_MUX\results\WWW286_LOD_BATCH.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
