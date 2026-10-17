"""Outer duration minus worker durations is message and scheduling, not queue wait."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from round_trip import split_round_trip


def main() -> None:
    paired = split_round_trip(830, 2, 790, 8)
    assert paired["status"] == "PAIRED"
    assert paired["worker_ms"] == 800
    assert abs(paired["message_and_schedule_ms"] - 30) < 1e-6
    assert paired["not_queue_wait"] is True
    rejected = split_round_trip(100, 0, 120, 0)
    assert rejected["status"] == "REJECTED"
    assert rejected["reason"] == "WORKER_EXCEEDS_OUTER"
    assert split_round_trip(10, -1, 1, 1)["reason"] == "NEGATIVE_DURATION"
    print("ROUND_TRIP_OK")


if __name__ == "__main__":
    main()
