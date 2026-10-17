"""A shared LOD batch is not a sum of stage medians, and traversal elapsed stays separate."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lod_batch import report_events


def event(name, mono, **payload):
    return {"type": name, "mono_ms": mono, **payload}


def main() -> None:
    events = [
        event("new_uploads", 0, chunk=7, page=3),
        event("ready_uploads", 800, chunk=7, page=3),
        event("lod_worker_update_end", 810, chunks=[{"chunk": 7, "page": 3}, {"chunk": 1, "page": 1}]),
        event("traversal_end", 2210, kind="display", elapsed_ms=1400),
        event("draw_index_build_end", 2220, kind="display"),
        event("upload_start", 2222, chunk=7, page=3),
    ]
    report = report_events(events, "fixture")
    assert report["queue_wait_p50_ms"] == 800
    assert report["in_callback_wall_p50_ms"] == 1412
    assert report["display_traverse_elapsed_p50_ms"] == 1400
    assert report["index_build_p50_ms"] == 10
    assert report["update_entries_without_ready_upload"] == 1
    assert report["queue_wait_p50_ms"] + report["in_callback_wall_p50_ms"] != report["display_traverse_elapsed_p50_ms"]
    print("LOD_BATCH_OK")


if __name__ == "__main__":
    main()
