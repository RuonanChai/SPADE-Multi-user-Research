"""Pair one outer worker round trip with durations measured on the worker clock.

Durations may be subtracted across time origins. Absolute timestamps may not.
A negative remainder beyond 1 ms rejects the pair. Stages are not added to queue wait.
"""

from __future__ import annotations


def split_round_trip(outer_ms: float, prep_ms: float, traverse_ms: float, pack_ms: float) -> dict:
    if min(outer_ms, prep_ms, traverse_ms, pack_ms) < 0:
        return {"status": "REJECTED", "reason": "NEGATIVE_DURATION"}
    worker_ms = prep_ms + traverse_ms + pack_ms
    remainder = outer_ms - worker_ms
    if remainder < -1:
        return {"status": "REJECTED", "reason": "WORKER_EXCEEDS_OUTER", "worker_ms": worker_ms, "outer_ms": outer_ms}
    return {
        "status": "PAIRED",
        "outer_ms": outer_ms,
        "worker_prep_ms": prep_ms,
        "worker_traverse_ms": traverse_ms,
        "worker_pack_ms": pack_ms,
        "worker_ms": worker_ms,
        "message_and_schedule_ms": max(0.0, remainder),
        "not_queue_wait": True,
        "not_cpu_counter": True,
    }
