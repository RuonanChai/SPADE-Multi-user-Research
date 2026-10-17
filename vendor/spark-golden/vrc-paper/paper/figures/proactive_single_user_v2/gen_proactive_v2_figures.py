#!/usr/bin/env python3
"""v2 figures (deadline miss + useful_before + first_visible + wasted + ready-event mix)."""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent

BASELINES = ["B0_on_demand", "B3_ready", "B4_ready_oracle"]
LABELS = ["B0", "B3-ready", "B4-ready*"]
COLORS = ["#4477AA", "#CCBB44", "#AA3377"]


def load_trials(batch_dir: Path):
    rows = []
    for p in (batch_dir / "per_trial_json").glob("*.json"):
        try:
            rows.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception as e:
            print(f"skip {p}: {e}", file=sys.stderr)
    return rows


def mean(xs):
    v = [x for x in xs if x is not None and isinstance(x, (int, float)) and x == x]
    return sum(v) / len(v) if v else 0.0


def agg(trials, delivery, baseline, field):
    sub = [
        t for t in trials
        if t.get("delivery_key") == delivery
        and t.get("baseline_id") == baseline
        and t.get("hard_gate_passed")
    ]
    return mean([t.get(field) for t in sub]), len(sub)


def try_matplotlib(batch_dir: Path, trials, delivery: str):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        return False

    present = [(bid, lab) for bid, lab in zip(BASELINES, LABELS)
               if any(t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed") for t in trials)]
    if not present:
        return False

    # Fig v2.1 — deadline miss 50/100 ms (mean)
    fig, ax = plt.subplots(figsize=(4.4, 2.9))
    labs, m50, m100 = [], [], []
    for bid, lab in present:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        labs.append(lab)
        m50.append(mean([t.get("deadline_miss_ratio_50ms", 0) for t in sub]) * 100)
        m100.append(mean([t.get("deadline_miss_ratio_100ms", 0) for t in sub]) * 100)
    xi = np.arange(len(labs))
    ax.bar(xi - 0.18, m50, 0.34, label="miss +50ms", color="#4477AA")
    ax.bar(xi + 0.18, m100, 0.34, label="miss +100ms", color="#AA3377", alpha=0.7)
    ax.set_xticks(xi); ax.set_xticklabels(labs, fontsize=8)
    ax.set_ylabel("Deadline miss (%)")
    ax.set_title(f"Fig v2.1 — ready-aware deadline miss ({delivery})")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / f"fig_v2_deadline_miss_{delivery}.pdf")
    fig.savefig(OUT / f"fig_v2_deadline_miss_{delivery}.png", dpi=200)
    plt.close(fig)
    if delivery == "origin_server":
        fig, ax = plt.subplots(figsize=(4.4, 2.9))
        ax.bar(xi - 0.18, m50, 0.34, label="miss +50ms", color="#4477AA")
        ax.bar(xi + 0.18, m100, 0.34, label="miss +100ms", color="#AA3377", alpha=0.7)
        ax.set_xticks(xi); ax.set_xticklabels(labs, fontsize=8)
        ax.set_ylabel("Deadline miss (%)")
        ax.set_title("Fig v2.1 — ready-aware deadline miss (origin)")
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(OUT / "fig_v2_deadline_miss.pdf")
        fig.savefig(OUT / "fig_v2_deadline_miss.png", dpi=200)
        plt.close(fig)

    # Fig v2.2 — useful_chunks_before_demand
    fig, ax = plt.subplots(figsize=(4.4, 2.9))
    useful, ratio = [], []
    for bid, lab in present:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        useful.append(mean([t.get("useful_chunks_before_demand", 0) for t in sub]))
        ratio.append(mean([t.get("useful_bytes_ratio", 0) for t in sub]))
    ax.bar(xi, useful, 0.5, color=COLORS[:len(labs)])
    ax2 = ax.twinx()
    ax2.plot(xi, ratio, "k--o", ms=4)
    ax2.set_ylabel("useful_bytes_ratio")
    ax.set_xticks(xi); ax.set_xticklabels(labs, fontsize=8)
    ax.set_ylabel("useful_chunks_before_demand")
    ax.set_title(f"Fig v2.2 — usefulness ({delivery})")
    fig.tight_layout()
    fig.savefig(OUT / f"fig_v2_useful_{delivery}.pdf")
    fig.savefig(OUT / f"fig_v2_useful_{delivery}.png", dpi=200)
    plt.close(fig)

    # Fig v2.3 — visibility timeline B0 vs B3 (first matching trial each)
    fig, ax = plt.subplots(figsize=(4.6, 2.9))
    for bid, lab, color in zip(BASELINES, LABELS, COLORS):
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        if not sub:
            continue
        tl = sub[0].get("visible_splat_timeline") or []
        if not tl:
            continue
        ax.plot([p.get("t", 0)/1000 for p in tl], [p.get("visible_splat_count", 0) for p in tl], color=color, label=lab, lw=1.2)
    ax.set_xlabel("Time (s)"); ax.set_ylabel("Visible splats")
    ax.set_title(f"Fig v2.3 — visibility timeline ({delivery})")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / f"fig_v2_visible_{delivery}.pdf")
    fig.savefig(OUT / f"fig_v2_visible_{delivery}.png", dpi=200)
    plt.close(fig)

    # Fig v2.4 — first_visible_ms vs wasted_prefetch_ratio
    fig, ax = plt.subplots(figsize=(4.4, 2.9))
    fvis, waste_r = [], []
    for bid, lab in present:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        fvis.append(mean([t.get("first_visible_splat_ms") or 0 for t in sub]) / 1000.0)
        waste_r.append(mean([t.get("wasted_prefetch_ratio") or 0 for t in sub]) * 100.0)
    ax.bar(xi - 0.18, fvis, 0.34, label="first_visible (s)", color="#228833")
    ax2 = ax.twinx()
    ax2.bar(xi + 0.18, waste_r, 0.34, label="wasted ratio (%)", color="#AA3377", alpha=0.7)
    ax.set_xticks(xi); ax.set_xticklabels(labs, fontsize=8)
    ax.set_ylabel("first_visible (s)")
    ax2.set_ylabel("wasted_prefetch_ratio (%)")
    ax.set_title(f"Fig v2.4 — QoE vs wasted ({delivery})")
    fig.tight_layout()
    fig.savefig(OUT / f"fig_v2_qoe_waste_{delivery}.pdf")
    fig.savefig(OUT / f"fig_v2_qoe_waste_{delivery}.png", dpi=200)
    plt.close(fig)

    return True


def main():
    if len(sys.argv) < 2 or not sys.argv[1].startswith("--batchDir="):
        print("usage: gen_proactive_v2_figures.py --batchDir=<path>")
        sys.exit(2)
    batch = Path(sys.argv[1].split("=", 1)[1])
    trials = load_trials(batch)
    if not trials:
        print("no trials")
        return
    for delivery in ("origin_server", "remote_server"):
        if not any(t.get("delivery_key") == delivery for t in trials):
            continue
        try_matplotlib(batch, trials, delivery)
    print(f"figures -> {OUT}")


if __name__ == "__main__":
    main()
