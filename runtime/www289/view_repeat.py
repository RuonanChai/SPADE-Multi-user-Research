"""Ask whether expensive wasm traversals repeat an unchanged view and tree."""

from __future__ import annotations

import json
from pathlib import Path

RID = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1"
EV = Path(r"F:\WWW_N3_MUX\evidence") / RID


def token(event: dict) -> str | None:
    view, quat = event.get("view"), event.get("quat")
    if not isinstance(view, list) or not isinstance(quat, list):
        return None
    rounded = [round(float(value), 3) for value in view + quat]
    return json.dumps([rounded, round(float(event.get("pixel_scale_limit") or 0), 5), event.get("max_splats")])


def analyze(client: str) -> dict:
    path = next((EV / client).rglob(f"{client}_spark_events.jsonl"))
    pending = None
    tree_updates = 0
    expensive = 0
    same_view = 0
    same_view_no_tree = 0
    changed_view = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if "traversal_" not in line and "lod_worker_update_end" not in line:
                continue
            event = json.loads(line)
            kind = event.get("type")
            if kind == "lod_worker_update_end":
                tree_updates += 1
            elif kind == "traversal_start" and event.get("kind") == "display":
                pending = {"token": token(event), "trees": tree_updates}
            elif kind == "traversal_end" and event.get("kind") == "display" and pending is not None:
                elapsed = event.get("worker_traverse_ms")
                if isinstance(elapsed, (int, float)) and elapsed >= 500 and pending["token"] is not None:
                    expensive += 1
                    # compared by the caller after the list is built
                pending["elapsed"] = elapsed
                pending["trees_now"] = tree_updates
                if not hasattr(analyze, "prev"):
                    pass
                # store on the function via a list closed over below
                pending = pending
                # handled after; keep last on the client dict by appending outside
                analyze.rows.append(pending)  # type: ignore[attr-defined]
                pending = None
    rows = analyze.rows  # type: ignore[attr-defined]
    previous = None
    for row in rows:
        elapsed = row.get("elapsed")
        if not isinstance(elapsed, (int, float)) or elapsed < 500 or row.get("token") is None:
            previous = row
            continue
        expensive += 1
        if previous and previous.get("token") == row["token"]:
            same_view += 1
            if row["trees_now"] == previous.get("trees_now"):
                same_view_no_tree += 1
        else:
            changed_view += 1
        previous = row
    return {
        "client": client,
        "expensive_traversals_ge_500ms": expensive,
        "same_rounded_view_as_previous": same_view,
        "same_view_and_no_tree_update": same_view_no_tree,
        "view_changed": changed_view,
    }


def main() -> None:
    report = []
    for client in ("C3", "C4"):
        analyze.rows = []  # type: ignore[attr-defined]
        # The first loop also appends; analyze() both appends and counts. Rebuild cleanly.
        report.append(run(client))
    out = Path(r"F:\WWW_N3_MUX\results\WWW289_VIEW_REPEAT.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


def run(client: str) -> dict:
    path = next((EV / client).rglob(f"{client}_spark_events.jsonl"))
    rows = []
    pending = None
    tree_updates = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if "traversal_" not in line and "lod_worker_update_end" not in line:
                continue
            event = json.loads(line)
            kind = event.get("type")
            if kind == "lod_worker_update_end":
                tree_updates += 1
            elif kind == "traversal_start" and event.get("kind") == "display":
                pending = {"token": token(event), "trees": tree_updates}
            elif kind == "traversal_end" and event.get("kind") == "display" and pending is not None:
                pending["elapsed"] = event.get("worker_traverse_ms")
                pending["trees_after"] = tree_updates
                rows.append(pending)
                pending = None
    expensive = same = still_tree = changed = 0
    previous = None
    for row in rows:
        elapsed = row.get("elapsed")
        if not isinstance(elapsed, (int, float)) or elapsed < 500 or row.get("token") is None:
            previous = row
            continue
        expensive += 1
        if previous and previous.get("token") == row["token"]:
            same += 1
            if row["trees_after"] == previous.get("trees_after"):
                still_tree += 1
        else:
            changed += 1
        previous = row
    return {
        "client": client,
        "display_traversals": len(rows),
        "expensive_ge_500ms": expensive,
        "same_rounded_view_as_previous_expensive": same,
        "same_view_and_no_new_tree_update": still_tree,
        "view_or_first_changed": changed,
    }


if __name__ == "__main__":
    main()
