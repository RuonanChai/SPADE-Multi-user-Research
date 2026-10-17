"""Join one chunk and page on a single monotonic clock.

upload_complete with gpu_transfer false is a CPU texture registration.
It is not a completed GPU transfer and not draw inclusion.
"""

from __future__ import annotations

import json
from pathlib import Path

STAGES = (
    "parse_complete",
    "fetched_queue",
    "page_allocated",
    "new_uploads",
    "ready_uploads",
    "lod_worker_update_end",
    "upload_start",
)


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def chains(events: list[dict]) -> list[dict]:
    open_by_chunk: dict[int, dict] = {}
    done: list[dict] = []
    for event in events:
        kind = event.get("type")
        mono = event.get("mono_ms")
        if not isinstance(mono, (int, float)):
            continue
        if kind == "lod_worker_update_end":
            for item in event.get("chunks") or []:
                chunk = item.get("chunk")
                page = item.get("page")
                row = open_by_chunk.get(chunk)
                if row and row.get("page") == page and "lod_worker_update_end" not in row:
                    row["lod_worker_update_end"] = float(mono)
            continue
        chunk = event.get("chunk")
        if not isinstance(chunk, int) or kind not in STAGES:
            continue
        if kind == "parse_complete":
            open_by_chunk[chunk] = {"chunk": chunk, "parse_complete": float(mono)}
            continue
        row = open_by_chunk.get(chunk)
        if row is None or kind in row:
            continue
        page = event.get("page")
        if kind == "page_allocated":
            if not isinstance(page, int):
                continue
            row["page"] = page
            row["page_source"] = event.get("page_source")
            row["previous_chunk"] = event.get("previous_chunk")
            row[kind] = float(mono)
            continue
        if row.get("page") != page:
            row.setdefault("rejected_pages", []).append(page)
            continue
        row[kind] = float(mono)
        if event.get("gpu_transfer") is False:
            row["upload_is_cpu_registration"] = True
        if kind == "upload_start":
            done.append(row)
            open_by_chunk.pop(chunk, None)
    return done


def gaps(row: dict) -> dict:
    out = {}
    for left, right in zip(STAGES, STAGES[1:]):
        if left in row and right in row:
            out[f"{left}_to_{right}_ms"] = row[right] - row[left]
        else:
            out[f"{left}_to_{right}_ms"] = None
    out["texture_update_effective_ms"] = None
    out["texture_update_effective_reason"] = "CPU_NEEDS_UPDATE_IS_NOT_GPU_COMPLETION"
    return out


def summarize(rows: list[dict]) -> dict:
    summary = {"matched_upload_start": len(rows)}
    for left, right in zip(STAGES, STAGES[1:]):
        key = f"{left}_to_{right}_ms"
        values = [row[key] for row in (gaps(item) for item in rows) if row[key] is not None]
        summary[key] = {
            "n": len(values),
            "p50": percentile(values, 0.5),
            "p95": percentile(values, 0.95),
        }
    summary["texture_update_effective"] = "NOT_INSTRUMENTED"
    return summary


def main() -> None:
    events = [
        {"type": "parse_complete", "chunk": 7, "mono_ms": 0},
        {"type": "fetched_queue", "chunk": 7, "mono_ms": 1},
        {"type": "page_allocated", "chunk": 7, "page": 3, "page_source": "free", "mono_ms": 2},
        {"type": "new_uploads", "chunk": 7, "page": 3, "mono_ms": 3},
        {"type": "ready_uploads", "chunk": 7, "page": 9, "mono_ms": 50},
        {"type": "ready_uploads", "chunk": 7, "page": 3, "mono_ms": 2400},
        {"type": "lod_worker_update_end", "mono_ms": 2500, "chunks": [{"chunk": 7, "page": 3}]},
        {"type": "upload_start", "chunk": 7, "page": 3, "mono_ms": 2510, "gpu_transfer": False},
        {"type": "upload_complete", "chunk": 7, "page": 3, "mono_ms": 2511, "gpu_transfer": False},
    ]
    rows = chains(events)
    assert len(rows) == 1
    assert rows[0]["page"] == 3
    assert rows[0]["rejected_pages"] == [9]
    gap = gaps(rows[0])
    assert gap["new_uploads_to_ready_uploads_ms"] == 2397
    assert gap["texture_update_effective_ms"] is None
    assert rows[0]["upload_is_cpu_registration"] is True
    print("CHAIN_JOIN_OK")
    print(json.dumps(summarize(rows)))


if __name__ == "__main__":
    main()
