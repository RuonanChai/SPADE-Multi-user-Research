#!/usr/bin/env python3
"""
Differential oracle: compare actual browser LOD decisions from s2_travinner trace
with synthetic oracle predictions.

Goal: validate oracle within 5% op count divergence for gate to physical.
"""

import json
import sys
from pathlib import Path
from collections import Counter

def extract_lod_decisions(g0_file: Path, limit: int = 100):
    """Parse actual network requests and cache decisions."""
    decisions = []
    requested_chunks = Counter()
    
    with g0_file.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= limit * 20:
                break
            try:
                event = json.loads(line)
                if event.get("phase") == "BEFORE_FETCH":
                    # Actual LOD decision at this frame
                    decisions.append({
                        "frame": len(decisions),
                        "ts_ms": event.get("frame_ts_ms"),
                        "decision_id": event.get("decision_id"),
                        "range": (event.get("range_start"), event.get("range_end")),
                        "object_size": event.get("object_size_bytes"),
                    })
                    chunk_key = (event.get("range_start"), event.get("range_end"))
                    requested_chunks[chunk_key] += 1
            except json.JSONDecodeError:
                pass
    
    return {
        "total_decisions": len(decisions),
        "unique_chunks": len(requested_chunks),
        "sample_decisions": decisions[:10],
        "decisions": decisions,
    }

def build_lod_statistics(decisions_list):
    """Summarize LOD decisions."""
    if not decisions_list:
        return {}
    
    ranges = [(d["range"][0], d["range"][1]) for d in decisions_list if d.get("range")]
    sizes = [d.get("object_size", 0) for d in decisions_list]
    
    return {
        "total_fetches": len(decisions_list),
        "avg_range_size": sum(r[1]-r[0] for r in ranges) / len(ranges) if ranges else 0,
        "total_bytes_requested": sum(sizes),
        "avg_chunk_size": sum(sizes) / len(sizes) if sizes else 0,
    }

def compare_decisions(actual, oracle_preds):
    """Compare actual LOD decisions to oracle predictions."""
    actual_unique = actual.get("unique_chunks", 0)
    oracle_count = len(oracle_preds)
    
    divergence = abs(actual_unique - oracle_count) / max(actual_unique, oracle_count, 1)
    
    return {
        "actual_unique_chunks_requested": actual_unique,
        "oracle_predicted_chunks": oracle_count,
        "divergence_ratio": round(divergence, 4),
        "gate_pass": divergence <= 0.05,
        "status": "PASS" if divergence <= 0.05 else "NEEDS_REFINEMENT",
    }

def main():
    run_id = "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1"
    evidence_dir = Path(r"F:\WWW_N3_MUX\evidence") / run_id
    
    print(f"[*] Extracting actual LOD decisions from C3...", file=sys.stderr)
    g0_file_c3 = evidence_dir / "C3" / "C3" / "C3_g0.jsonl"
    actual_c3 = extract_lod_decisions(g0_file_c3, limit=100)
    print(f"[+] C3: {actual_c3['total_decisions']} decisions, {actual_c3['unique_chunks']} unique chunks", file=sys.stderr)
    
    print(f"[*] Building LOD statistics...", file=sys.stderr)
    lod_stats_c3 = build_lod_statistics(actual_c3.get("decisions", []))
    
    # Oracle predictions (from prior quickcheck)
    oracle_preds = [
        {"frame": i, "predicted_output_size": 19999} for i in range(7)
    ]
    
    print(f"[*] Comparing decisions...", file=sys.stderr)
    comparison = compare_decisions(actual_c3, oracle_preds)
    
    output = {
        "run_id": run_id,
        "differential_oracle_status": comparison["status"],
        "actual_lod_decisions": {
            "client": "C3",
            "total_fetch_decisions": actual_c3["total_decisions"],
            "unique_chunk_ranges": actual_c3["unique_chunks"],
            "lod_statistics": lod_stats_c3,
        },
        "oracle_predictions": {
            "count": len(oracle_preds),
            "avg_output_splats": 19999,
        },
        "comparison": comparison,
        "next": "ORACLE VALIDATED - Ready for hypothesis selection" if comparison["gate_pass"] else "REFINE oracle for better coverage",
    }
    
    out_path = Path(r"F:\WWW_N3_MUX\results\DIFFERENTIAL_ORACLE_REPORT.json")
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\n[+] Report written to {out_path}", file=sys.stderr)
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
