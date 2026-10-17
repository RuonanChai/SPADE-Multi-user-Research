#!/usr/bin/env python3
"""
Production-grade differential oracle framework.

Phase 2 implementation: extract real LOD decisions from browser trace,
build oracle comparison interface.

Key: match input parameters (tree, viewpoint, residency, maxSplats, pixelLimit),
run both traverse implementations, verify complete set + order + budget adherence.
"""

import json
from pathlib import Path
from typing import List, Dict, Any, Tuple
from collections import defaultdict

def extract_lod_frames_with_metadata(g0_file: Path) -> List[Dict[str, Any]]:
    """
    Extract one LOD frame per unique camera position from browser decision stream.
    Frame = (camera pose, LOD indices fetched, chunks needed).
    """
    frames = []
    seen_poses = set()

    with g0_file.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            try:
                event = json.loads(line)
                if event.get("phase") == "BEFORE_FETCH":
                    pose = (
                        round(event["camera"]["position"][0], 3),
                        round(event["camera"]["position"][1], 3),
                        round(event["camera"]["position"][2], 3),
                    )

                    if pose not in seen_poses:
                        seen_poses.add(pose)
                        frames.append({
                            "frame_id": len(frames),
                            "camera_pos": event["camera"]["position"],
                            "camera_quat": event["camera"]["quaternion"],
                            "fov": event["camera"]["fov"],
                            "viewport": event["camera"]["viewport"],
                            "range": (event.get("range_start"), event.get("range_end")),
                            "cone": event.get("cone", {}),
                            "ts_ms": event.get("frame_ts_ms"),
                        })

                        if len(frames) >= 20:  # Limit for testing
                            break
            except json.JSONDecodeError:
                pass

    return frames

def build_oracle_metadata(frames: List[Dict], run_id: str) -> Dict[str, Any]:
    """Build metadata about real LOD decisions for oracle input."""

    # Infer tree properties from chunk distribution
    all_ranges = [(f["range"][0], f["range"][1]) for f in frames if f.get("range")]
    if not all_ranges:
        return {}

    # Tree properties (to be filled from true source)
    metadata = {
        "run_id": run_id,
        "frames_sampled": len(frames),
        "camera_positions": [f["camera_pos"] for f in frames],
        "chunk_ranges": all_ranges,

        # TODO: These must come from real tree
        "tree_node_count": None,  # Unknown - need real Coit source
        "tree_type": "quaternary (assumed)",
        "tree_version_sha": None,
        "max_splats": 3750000,  # From paper
        "pixel_limit": 0.002131,  # From paper
        "lod_scale": 1.0,
        "cone": {
            "fov0": 70,
            "fov": 120,
            "behind": 0.2,
            "foveate": 0.4,
        },

        # Residency (from evidence)
        "residency_at_frame": {},  # chunks resident at each frame
    }

    # Extract which chunks appear in each frame
    for frame in frames:
        fid = frame["frame_id"]
        chunk_key = frame["range"]
        if chunk_key[0] is not None:
            if fid not in metadata["residency_at_frame"]:
                metadata["residency_at_frame"][fid] = []
            metadata["residency_at_frame"][fid].append(chunk_key)

    return metadata

def oracle_input_contract() -> Dict[str, str]:
    """Define what an oracle must accept and produce."""
    return {
        "inputs": {
            "tree": "Node[] with parent/child pointers, splat positions, sizes",
            "viewpoint": "[pos_x, pos_y, pos_z]",
            "camera_forward": "[dir_x, dir_y, dir_z]",
            "max_splats": "budget in splats",
            "pixel_limit": "lod threshold",
            "residency_snapshot": "Set[ChunkId] currently resident",
            "tree_version": "version identifier",
        },
        "outputs": {
            "lod_indices": "Vec<SplatIndex> selected for rendering (order matters)",
            "op_counts": {
                "heap_pops": "count",
                "heap_pushes": "count",
                "pixel_tests": "count",
                "node_expansions": "count",
                "below_limit_emits": "count",
            },
            "frontier_max": "peak heap size",
            "wall_time_ns": "microseconds for traversal",
        },
        "correctness_invariants": [
            "Output length <= max_splats",
            "All indices are valid splat IDs",
            "LOD indices form contiguous subset (no interleaving)",
            "Output order matches traversal order (BFS from frontier)",
            "No duplicate indices",
            "Invisible splats (behind or below pixel_limit) not included",
        ],
    }

def main():
    run_id = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1"
    evidence_dir = Path(r"F:\WWW_N3_MUX\evidence") / run_id

    print(f"[*] Extracting LOD frames from {run_id}...")
    g0_file = evidence_dir / "C3" / "C3" / "C3_g0.jsonl"
    frames = extract_lod_frames_with_metadata(g0_file)
    print(f"[+] Sampled {len(frames)} unique camera frames")

    print(f"\n[*] Building oracle metadata...")
    metadata = build_oracle_metadata(frames, run_id)

    print(f"\n[*] Oracle input/output contract:")
    contract = oracle_input_contract()

    output = {
        "status": "PHASE_2_FRAMEWORK_READY",
        "run_id": run_id,
        "frames_extracted": len(frames),
        "sample_frame_0": frames[0] if frames else None,
        "oracle_metadata": metadata,
        "oracle_contract": contract,
        "next_step": "RECOVER_REAL_COIT_TREE_FROM_SOURCE_OR_REBUILD",
        "blocker": "Tree node structure NOT found in evidence; must recover from RAD assets or rebuild deterministically",
    }

    out_path = Path(r"F:\WWW_N3_MUX\results\PRODUCTION_ORACLE_FRAMEWORK.json")
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\n[+] Framework written to {out_path}")
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
