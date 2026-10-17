"""Replay saved slots=3 arrival times through one and two servers.

Service time is the slots=1 send-to-complete p50 for the same client.
This uses development evidence only and does not launch a cell.
"""

from __future__ import annotations

import json
from pathlib import Path

EV = Path(r"F:\WWW_N3_MUX\evidence")

CASES = [
    {
        "name": "N2_C3",
        "demand_run": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r1",
        "client": "C3",
        "service_ms": None,
        "measured_ratio": 384 / 273,
    },
    {
        "name": "N3_C5",
        "demand_run": "nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s3_r5",
        "client": "C5",
        "service_ms": None,
        "measured_ratio": 363 / 334,
    },
]


def arrivals(run_id: str, client: str) -> list[float]:
    folder = EV / run_id / client / client
    path = folder / f"{client}_request_lifecycle.jsonl"
    if not path.exists():
        path = EV / run_id / client / f"{client}_request_lifecycle.jsonl"
    times = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if ".rad" not in line:
                continue
            row = json.loads(line)
            sent = row.get("requestSent")
            if isinstance(sent, (int, float)):
                times.append(float(sent))
    times.sort()
    origin = times[0]
    scale = 1000.0 if times[-1] - origin < 1000 else 1.0
    return [(item - origin) * scale for item in times]


def serve(arrivals_ms: list[float], servers: int, service_ms: float, horizon_ms: float = 70000.0) -> int:
    free_at = [0.0] * servers
    completed = 0
    for arrival in arrivals_ms:
        if arrival > horizon_ms:
            break
        slot = min(range(servers), key=lambda index: free_at[index])
        start = max(arrival, free_at[slot])
        done = start + service_ms
        free_at[slot] = done
        if done <= horizon_ms:
            completed += 1
    return completed


def slots1_service(client: str) -> float:
    import csv
    rows = list(csv.DictReader(Path(r"F:\WWW_N3_MUX\results\WWW285_NEXT_COMPARISON.csv").open(encoding="utf-8")))
    values = []
    for row in rows:
        if row["scheduler"] == "LRU" and row["slots"] == "1" and row["client"] == client and row["send_to_complete_p50_ms"]:
            values.append(float(row["send_to_complete_p50_ms"]))
    if not values:
        raise RuntimeError("no slots=1 completion p50 for " + client)
    return sum(values) / len(values)


def main() -> None:
    report = []
    for case in CASES:
        demand = arrivals(case["demand_run"], case["client"])
        service = case["service_ms"] or slots1_service(case["client"])
        one = serve(demand, 1, service)
        two = serve(demand, 2, service)
        ratio = two / one if one else None
        report.append({
            "name": case["name"],
            "arrivals": len(demand),
            "service_ms": service,
            "slots1_completed": one,
            "slots2_completed": two,
            "replay_ratio": None if ratio is None else round(ratio, 3),
            "measured_ratio": round(case["measured_ratio"], 3),
        })
    print(json.dumps(report, indent=2))
    c3 = report[0]["replay_ratio"]
    c5 = report[1]["replay_ratio"]
    assert c3 is not None and c5 is not None
    assert c3 < 1.85
    assert c5 <= c3
    print("STOPGO_REPLAY_OK")


if __name__ == "__main__":
    main()
