#!/usr/bin/env python3
"""
Recover real Coit tree structure from WASM spark events and network traces.

Strategy:
1. Extract traverse_lod_trees span from spark events
2. Analyze node indices accessed (heap ops, child expansions)
3. Correlate with network chunk ranges to infer tree structure
4. Output: tree_metadata.json with sufficient info for replay
"""

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
from collections import defaultdict

def parse_spark_events(spark_file: Path) -> List[Dict[str, Any]]:
    """Load spark events and filter to traverse/tree operations."""
    events = []
    with spark_file.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            try:
                event = json.loads(line)
                # Look for WASM traverse_lod_trees spans and memory operations
                name = event.get("name", "")
                if "traverse" in name.lower() or "heap" in name.lower() or "lod" in name.lower():
                    events.append(event)
                    if i % 10000 == 0 and i > 0:
                        print(f"  scanned {i} lines, found {len(events)} tree events", file=sys.stderr)
            except json.JSONDecodeError as e:
                print(f"  json error line {i}: {e}", file=sys.stderr)
                pass
    return events

def extract_node_accesses(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Extract node indices and operations from events."""
    result = {
        "total_events": len(events),
        "unique_node_indices": set(),
        "operations": [],
        "node_counts": defaultdict(int),
    }

    for event in events:
        # Heuristic: look for numeric identifiers or addresses that might be node indices
        args = event.get("args", {})
        name = event.get("name", "")

        # Try to extract indices from common patterns
        for key, val in args.items():
            if isinstance(val, int) and val < 100000000:  # Reasonable node index range
                result["unique_node_indices"].add(val)
                result["node_counts"][key] += 1

        # Log first few operations
        if len(result["operations"]) < 100:
            result["operations"].append({"name": name, "args_keys": list(args.keys())})

    result["unique_node_indices"] = sorted(list(result["unique_node_indices"]))
    return result

def analyze_network_chunks(network_file: Path) -> Dict[str, Any]:
    """Analyze network chunk ranges to infer tree chunk mapping."""
    chunks = []
    with network_file.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                event = json.loads(line)
                if "range_start" in event and "range_end" in event:
                    chunks.append({
                        "start": event["range_start"],
                        "end": event["range_end"],
                        "size": event["range_end"] - event["range_start"],
                        "ts_ms": event.get("frame_ts_ms"),
                    })
            except json.JSONDecodeError:
                pass

    chunks.sort(key=lambda x: x["start"])

    # Try to detect tree-like structure in chunk boundaries
    # Assume nodes are packed: chunk i contains nodes [i*N, (i+1)*N)
    result = {
        "total_chunks": len(chunks),
        "chunk_sizes": [c["size"] for c in chunks],
        "byte_ranges": [(c["start"], c["end"]) for c in chunks],
    }

    if chunks:
        result["total_bytes"] = chunks[-1]["end"]
        result["avg_chunk_size_bytes"] = sum(c["size"] for c in chunks) / len(chunks) if chunks else 0

        # Detect if there's a regular hierarchy (tree-like chunking)
        sizes = result["chunk_sizes"]
        if len(set(sizes)) <= 3:  # Few distinct sizes suggests hierarchy
            result["likely_hierarchy"] = True
            result["size_groups"] = defaultdict(int)
            for s in sizes:
                result["size_groups"][s] += 1

    return result

def main():
    evidence_dir = Path(r"F:\WWW_N3_MUX\evidence\nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1\C3\C3")

    print(f"[*] Loading spark events from {evidence_dir}...", file=sys.stderr)
    spark_events = parse_spark_events(evidence_dir / "C3_spark_events.jsonl")
    print(f"[+] Loaded {len(spark_events)} tree-related events", file=sys.stderr)

    print(f"[*] Extracting node accesses...", file=sys.stderr)
    node_data = extract_node_accesses(spark_events)
    print(f"[+] Found {len(node_data['unique_node_indices'])} unique node indices", file=sys.stderr)

    print(f"[*] Analyzing network chunks...", file=sys.stderr)
    chunk_data = analyze_network_chunks(evidence_dir / "C3_g0.jsonl")
    print(f"[+] Found {chunk_data['total_chunks']} network chunks, total {chunk_data.get('total_bytes', 0)} bytes", file=sys.stderr)

    # Synthesis
    output = {
        "run_id": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1",
        "scene": "coit-40m-sh1-lod",
        "trace": "stop_go",
        "recovery_status": "PARTIAL",
        "node_analysis": {
            "total_events_found": node_data["total_events"],
            "unique_indices": len(node_data["unique_node_indices"]),
            "index_range": [min(node_data["unique_node_indices"]), max(node_data["unique_node_indices"])] if node_data["unique_node_indices"] else None,
        },
        "network_analysis": {
            "total_chunks": chunk_data["total_chunks"],
            "total_bytes": chunk_data.get("total_bytes"),
            "avg_chunk_size": chunk_data.get("avg_chunk_size_bytes"),
            "likely_hierarchy": chunk_data.get("likely_hierarchy", False),
        },
        "missing_data": [
            "explicit_tree_structure (splat nodes with children pointers)",
            "tree_node_count (inferred from max index but not verified)",
            "drooled_splats_per_chunk mapping",
            "timestamp-aligned residency snapshots",
        ],
        "next_step": "If structure cannot be fully recovered, will implement binary tree capture from lod_bench WASM output"
    }

    out_path = Path(r"F:\WWW_N3_MUX\results\COIT_TREE_RECOVERY_ANALYSIS.json")
    out_path.write_text(json.dumps(output, indent=2))
    print(f"[+] Written analysis to {out_path}", file=sys.stderr)
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
