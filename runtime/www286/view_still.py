"""Join canary LOD batches to the 1 Hz camera samples.

A batch is still when the nearest samples on either side have not moved.
GO seconds follow the stop_go trace: the last 3 seconds of each 10 second block.
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


def load_batches(client: str) -> list[float]:
    path = next((EV / client).rglob(f"{client}_spark_events.jsonl"))
    times = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if '"type":"lod_worker_update_end"' not in line:
                continue
            event = json.loads(line)
            if isinstance(event.get("mono_ms"), (int, float)):
                times.append(float(event["mono_ms"]))
    return times


def load_cameras(client: str) -> list[dict]:
    path = next((EV / client).rglob("SDL_STATS.json"))
    stats = json.loads(path.read_text(encoding="utf-8"))
    samples = []
    for sample in (stats.get("draw_inclusion") or {}).get("samples") or []:
        camera = sample.get("camera") or {}
        if not all(isinstance(camera.get(axis), (int, float)) for axis in ("x", "y", "z")):
            continue
        if not isinstance(sample.get("mono_ms"), (int, float)):
            continue
        samples.append({
            "mono_ms": float(sample["mono_ms"]),
            "replay_elapsed_ms": sample.get("replay_elapsed_ms"),
            "camera": (float(camera["x"]), float(camera["y"]), float(camera["z"])),
            "lod_num_splats": sample.get("lod_num_splats"),
        })
    return samples


def nearest(samples: list[dict], mono: float) -> dict | None:
    if not samples:
        return None
    return min(samples, key=lambda sample: abs(sample["mono_ms"] - mono))


def moved(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5


def phase(replay_ms: object) -> str:
    if not isinstance(replay_ms, (int, float)):
        return "UNKNOWN"
    second = (float(replay_ms) / 1000.0) % 10.0
    return "GO" if second >= 7.0 else "STOP"


def analyze(client: str) -> dict:
    batches = load_batches(client)
    cameras = load_cameras(client)
    still = 0
    moving = 0
    unknown = 0
    phases = {"GO": 0, "STOP": 0, "UNKNOWN": 0}
    gaps = []
    for earlier, later in zip(batches, batches[1:]):
        left = nearest(cameras, earlier)
        right = nearest(cameras, later)
        if left is None or right is None or abs(left["mono_ms"] - earlier) > 1500 or abs(right["mono_ms"] - later) > 1500:
            unknown += 1
            phases["UNKNOWN"] += 1
            continue
        gaps.append(moved(left["camera"], right["camera"]))
        kind = phase(right["replay_elapsed_ms"])
        phases[kind] += 1
        if gaps[-1] < 1e-3:
            still += 1
        else:
            moving += 1
    return {
        "client": client,
        "lod_batches": len(batches),
        "camera_samples": len(cameras),
        "batch_gaps_with_camera": still + moving,
        "camera_unchanged_gaps": still,
        "camera_moved_gaps": moving,
        "camera_unknown_gaps": unknown,
        "unchanged_fraction_of_known": (still / (still + moving)) if still + moving else None,
        "move_distance_p50": pct(gaps, 0.5),
        "phase_of_later_batch": phases,
        "lod_num_splats_min": min((sample["lod_num_splats"] for sample in cameras if isinstance(sample["lod_num_splats"], int)), default=None),
        "lod_num_splats_max": max((sample["lod_num_splats"] for sample in cameras if isinstance(sample["lod_num_splats"], int)), default=None),
    }


def main() -> None:
    report = [analyze(client) for client in ("C3", "C4")]
    out = Path(r"F:\WWW_N3_MUX\results\WWW286_VIEW_STILL.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
