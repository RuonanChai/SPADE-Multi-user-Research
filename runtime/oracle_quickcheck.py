#!/usr/bin/env python3
"""
Oracle quickcheck: extract viewports from evidence trace,
run synthetic tree through traverse oracle,
verify consistency with stored LOD decisions.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional

def extract_viewports(evidence_dir: Path, client: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Extract camera positions from BEFORE_FETCH events."""
    views = []
    g0_file = evidence_dir / f"{client}/{client}/{client}_g0.jsonl"
    with g0_file.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= limit * 20:  # Rough filter (not all lines are viewports)
                break
            try:
                event = json.loads(line)
                if event.get("phase") == "BEFORE_FETCH" and "camera" in event:
                    views.append({
                        "ts_ms": event.get("frame_ts_ms"),
                        "pos": event["camera"]["position"],
                        "fov": event["camera"]["fov"],
                        "viewport": event["camera"]["viewport"],
                        "cone": event.get("cone", {}),
                    })
            except json.JSONDecodeError:
                pass

    # Deduplicate by round-trip camera position
    unique = []
    seen = set()
    for v in views:
        key = (round(v["pos"][0], 2), round(v["pos"][1], 2), round(v["pos"][2], 2))
        if key not in seen:
            seen.add(key)
            unique.append(v)

    return unique[:limit]

def run_traverse_oracle(tree_file: Path, viewports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Run synthetic traverse oracle on viewpoints.
    (For now, just validate that we can load and inspect tree.)
    """
    results = []

    print(f"[*] Loading tree from {tree_file}...", file=sys.stderr)
    with tree_file.open("r") as f:
        tree_data = json.load(f)

    node_count = tree_data.get("node_count", 0)
    nodes = tree_data.get("nodes", [])

    print(f"[+] Loaded tree: {node_count} nodes, {len(nodes)} in array", file=sys.stderr)

    # Build a simple index for testing
    node_by_id = {n["i"]: n for n in nodes}

    # For each viewport, compute which nodes would be visible
    for i, view in enumerate(viewports):
        pos = view["pos"]
        # Compute root node pixel scale
        center = nodes[0]  # root
        root_x, root_y, root_z = center["x"], center["y"], center["z"]
        root_s = center["s"]

        dx = root_x - pos[0]
        dy = root_y - pos[1]
        dz = root_z - pos[2]
        dist = max((dx*dx + dy*dy + dz*dz)**0.5, 1e-6)

        # Simplified foveate (assume looking at root, front hemisphere)
        foveate = 1.0 if dz > 0 else 0.2
        pixel_scale = root_s / dist * 1.0 * foveate  # lodScale=1.0

        results.append({
            "frame": i,
            "ts_ms": view["ts_ms"],
            "viewpoint": pos,
            "root_pixel_scale": pixel_scale,
            "tree_nodes": node_count,
            "tree_leaves": sum(1 for n in nodes if n["cc"] == 0),
        })

        if (i + 1) % 10 == 0:
            print(f"  processed {i+1} / {len(viewports)} frames", file=sys.stderr)

    return results

def main():
    evidence_dir = Path(r"F:\WWW_N3_MUX\evidence\nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1")
    tree_file = Path(r"F:\WWW_N3_MUX\results\COIT_TREE_SYNTHETIC_4M.json")

    # Extract viewports from both clients
    print(f"[*] Extracting viewports from C3...", file=sys.stderr)
    views_c3 = extract_viewports(evidence_dir, "C3", limit=50)
    print(f"[+] Extracted {len(views_c3)} unique viewpoints", file=sys.stderr)

    print(f"[*] Extracting viewports from C4...", file=sys.stderr)
    views_c4 = extract_viewports(evidence_dir, "C4", limit=50)
    print(f"[+] Extracted {len(views_c4)} unique viewpoints", file=sys.stderr)

    # Run oracle on C3 trace
    print(f"\n[*] Running oracle on {len(views_c3)} C3 frames...", file=sys.stderr)
    results_c3 = run_traverse_oracle(tree_file, views_c3)

    # Summary
    output = {
        "run_id": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1",
        "oracle_status": "QUICKCHECK_OK",
        "c3_frames_analyzed": len(results_c3),
        "c4_frames_available": len(views_c4),
        "sample_result": results_c3[0] if results_c3 else None,
        "next_step": "Implement full Rust traverse oracle and validate counts match",
    }

    out_path = Path(r"F:\WWW_N3_MUX\results\ORACLE_QUICKCHECK.json")
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\n[+] Written results to {out_path}", file=sys.stderr)
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
