"""Draw-visibility canary.

A chunk is counted only when a submitted draw names that chunk.
GPU upload, READY, and residency do not become a zero or a visible count.
"""

from __future__ import annotations


def classify(event: dict) -> dict:
    kind = event.get("type")
    if kind == "draw_submitted":
        chunk_ids = event.get("chunk_ids")
        if isinstance(chunk_ids, list) and all(isinstance(item, str) and item for item in chunk_ids):
            return {"status": "MEASURED", "included_chunk_ids": list(chunk_ids)}
        return {"status": "NOT_INSTRUMENTED", "included_chunk_ids": None}
    if kind in {"upload_complete", "gpu_upload", "ready", "resident"}:
        return {"status": "NOT_VISIBLE_SIGNAL", "included_chunk_ids": None}
    return {"status": "NOT_INSTRUMENTED", "included_chunk_ids": None}


def main() -> None:
    upload = classify({"type": "upload_complete", "chunk_id": "c1"})
    ready = classify({"type": "ready", "chunk_id": "c1"})
    unnamed = classify({"type": "draw_submitted"})
    named = classify({"type": "draw_submitted", "chunk_ids": ["c1", "c2"]})
    assert upload["included_chunk_ids"] is None
    assert ready["included_chunk_ids"] is None
    assert unnamed["status"] == "NOT_INSTRUMENTED"
    assert unnamed["included_chunk_ids"] is None
    assert named["status"] == "MEASURED"
    assert named["included_chunk_ids"] == ["c1", "c2"]
    assert classify({"type": "upload_complete"})["status"] != "MEASURED"
    print("DRAW_CANARY_OK")


if __name__ == "__main__":
    main()
