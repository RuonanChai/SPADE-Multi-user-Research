"""Refuse a LOD conclusion when the timeline has no resident splats."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def check(evidence: Path) -> dict:
    report = {"run_id": evidence.name, "clients": {}}
    ok = True
    for client in ("C3", "C4"):
        ready = evidence / client / "READY"
        spark = next((evidence / client).rglob(f"{client}_spark_events.jsonl"), None) if (evidence / client).exists() else None
        row = {"ready": ready.exists(), "spark": spark is not None, "lod_splats_max": None, "display_traverse_n": 0}
        if ready.exists():
            doc = json.loads(ready.read_text(encoding="utf-8"))
            row["ready_run"] = doc.get("runId") == evidence.name
            row["trace_loaded"] = doc.get("trace_loaded") is True
            ok = ok and row["ready_run"] and row["trace_loaded"]
        else:
            ok = False
        if spark is not None:
            maximum = 0
            count = 0
            with spark.open(encoding="utf-8") as handle:
                for line in handle:
                    if '"draw_index_build_end"' not in line:
                        continue
                    event = json.loads(line)
                    if event.get("kind") not in (None, "display"):
                        continue
                    count += 1
                    splats = event.get("lod_splats")
                    if isinstance(splats, int):
                        maximum = max(maximum, splats)
            row["display_traverse_n"] = count
            row["lod_splats_max"] = maximum
            if maximum <= 0 or count == 0:
                ok = False
        else:
            ok = False
        report["clients"][client] = row
    report["nonempty_lod"] = ok
    return report


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_lod_timeline.py <evidence_dir>")
    report = check(Path(sys.argv[1]))
    print(json.dumps(report, indent=2))
    if not report["nonempty_lod"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
