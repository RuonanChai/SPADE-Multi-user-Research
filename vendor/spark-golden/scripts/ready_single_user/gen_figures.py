#!/usr/bin/env python3
"""Generate Phase B–E PDF figures for READY single-user paper."""
import csv
import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
except ImportError:
    print("matplotlib required: pip install matplotlib")
    sys.exit(0)

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("paper_materials/ready_single_user")


def read_csv(name):
    p = OUT / name
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def bar_fig(rows, ykey, title, fname, baseline_key="baseline_name"):
    if not rows:
        return
    names = [r[baseline_key] for r in rows]
    vals = [float(r.get(ykey) or 0) for r in rows]
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.bar(names, vals, color="#4C72B0")
    ax.set_title(title)
    ax.set_ylabel(ykey)
    plt.xticks(rotation=30, ha="right")
    plt.tight_layout()
    fig.savefig(OUT / fname, format="pdf")
    plt.close(fig)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    b = read_csv("phaseB_main_results.csv")
    if b:
        bar_fig(b, "miss100", "Deadline Miss 100ms (Phase B)", "fig_main_deadline_miss.pdf")
        bar_fig(b, "first_visible_splat_ms", "First Visible Splat (ms)", "fig_main_first_visible.pdf")
        bar_fig(b, "useful_chunks_before_demand", "Useful Chunks Before Demand", "fig_main_useful_before.pdf")
        bar_fig(b, "wasted_prefetch_ratio", "Wasted Prefetch Ratio", "fig_main_efficiency.pdf")
    c = read_csv("phaseC_ablation_results.csv")
    if c:
        bar_fig(c, "miss100", "Ablation: Deadline Miss 100ms", "fig_ablation_deadline.pdf")
        bar_fig(c, "first_visible_splat_ms", "Ablation: First Visible", "fig_ablation_first_visible.pdf")
        bar_fig(c, "measure_fps", "Ablation: FPS", "fig_ablation_waste_fps.pdf")
    d = read_csv("phaseD_network_stress.csv")
    if d:
        bar_fig(d, "first_visible_splat_ms", "Network Stress: First Visible", "fig_network_stress.pdf")
        bar_fig(d, "fast_but_empty_detected", "Fast-but-Empty Rate", "fig_fast_but_empty.pdf", "baseline_name")
    e = read_csv("phaseE_trace_robustness.csv")
    if e:
        bar_fig(e, "miss100", "Trace Robustness: miss100", "fig_trace_robustness.pdf", "trace")
    print(f"Figures written to {OUT}")


if __name__ == "__main__":
    main()
