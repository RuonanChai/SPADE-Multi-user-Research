#!/usr/bin/env python3
"""
Publication-quality figures for Chapter 3: Single-User Proactive Delivery (v2).
Generates PDF + PNG at 300 DPI. Nature-style formatting.

Usage (from WSL):
  python3 /mnt/d/Program/spark-main/spark-main/vrc-paper/paper/figures/proactive_single_user_v2/gen_v2_figures_wsl.py

Data source: paper_materials/proactive_single_user_v2/runs/2026-05-24T16-06-30
"""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import MaxNLocator

# --- Paths ---
REPO = Path("/mnt/d/Program/spark-main/spark-main")
BATCH = REPO / "paper_materials" / "proactive_single_user_v2" / "runs" / "2026-05-24T16-06-30"
OUT = REPO / "vrc-paper" / "paper" / "figures" / "proactive_single_user_v2"
OUT.mkdir(parents=True, exist_ok=True)

# --- Style ---
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 8,
    "axes.labelsize": 9,
    "axes.titlesize": 10,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "legend.fontsize": 7.5,
    "figure.dpi": 300,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.05,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.5,
    "ytick.major.width": 0.5,
    "lines.linewidth": 1.2,
    "axes.spines.top": False,
    "axes.spines.right": False,
})

COLORS = {
    "B0": "#2166AC",      # blue
    "B3": "#B2182B",      # red
    "B4": "#762A83",      # purple
}
LABELS = {"B0": "B0 On-demand", "B3": "B3-ready (VRC-Single v2)", "B4": "B4-ready-oracle"}

# --- Load data ---
def load_trials():
    rows = []
    for p in (BATCH / "per_trial_json").glob("*.json"):
        rows.append(json.loads(p.read_text(encoding="utf-8")))
    return sorted(rows, key=lambda t: (t["baseline_id"], t.get("trial_index", 0)))

trials = load_trials()
assert len(trials) == 9, f"Expected 9 trials, got {len(trials)}"

# Per-trial data organized by baseline
data = {}
for t in trials:
    bid = t["baseline_id"]
    if bid not in data:
        data[bid] = []
    data[bid].append(t)

# --- Helper ---
def get_vals(baseline_id, field):
    return [t.get(field, 0) or 0 for t in data[baseline_id]]

def mean_std(vals):
    a = np.array(vals, dtype=float)
    return a.mean(), a.std(ddof=1) if len(a) > 1 else 0.0


# ============================================================
# Figure 3.1: Deadline Miss Ratio (per-trial + mean bar)
# ============================================================
fig, ax = plt.subplots(figsize=(3.5, 2.4))

baselines = ["B0_on_demand", "B3_ready", "B4_ready_oracle"]
short = ["B0", "B3", "B4"]
x = np.arange(3)
width = 0.25

for i, (bid, label) in enumerate(zip(baselines, short)):
    vals = [v * 100 for v in get_vals(bid, "deadline_miss_ratio_100ms")]
    m, s = mean_std(vals)
    bar = ax.bar(x[i], m, width * 2.2, yerr=s, capsize=3,
                 color=COLORS[label], alpha=0.85, edgecolor="none",
                 label=LABELS[label], error_kw={"linewidth": 0.8})
    # Individual trial dots
    for j, v in enumerate(vals):
        ax.scatter(x[i] + (j - 1) * 0.08, v, s=12, color="k", alpha=0.5, zorder=5)

ax.set_ylabel("Deadline miss ratio (%)\n(ready > needed + 100 ms)")
ax.set_xticks(x)
ax.set_xticklabels(["B0\nOn-demand", "B3-ready\n(VRC-Single v2)", "B4-ready\n(Oracle)"])
ax.set_ylim(0, 110)
ax.axhline(50, color="gray", ls="--", lw=0.5, alpha=0.5)
ax.legend(loc="upper right", frameon=False)
ax.set_title("a", fontweight="bold", loc="left", fontsize=11)
fig.tight_layout()
fig.savefig(OUT / "fig_v2_deadline_miss.pdf")
fig.savefig(OUT / "fig_v2_deadline_miss.png")
plt.close(fig)
print(f"  fig_v2_deadline_miss.pdf")


# ============================================================
# Figure 3.2: First Visible Splat Latency
# ============================================================
fig, ax = plt.subplots(figsize=(3.5, 2.4))

for i, (bid, label) in enumerate(zip(baselines, short)):
    vals = [v / 1000.0 for v in get_vals(bid, "first_visible_splat_ms")]
    m, s = mean_std(vals)
    ax.bar(x[i], m, width * 2.2, yerr=s, capsize=3,
           color=COLORS[label], alpha=0.85, edgecolor="none",
           label=LABELS[label], error_kw={"linewidth": 0.8})
    for j, v in enumerate(vals):
        ax.scatter(x[i] + (j - 1) * 0.08, v, s=12, color="k", alpha=0.5, zorder=5)

ax.set_ylabel("First visible splat (s)")
ax.set_xticks(x)
ax.set_xticklabels(["B0\nOn-demand", "B3-ready\n(VRC-Single v2)", "B4-ready\n(Oracle)"])
ax.set_ylim(0, None)
ax.legend(loc="upper right", frameon=False)
ax.set_title("b", fontweight="bold", loc="left", fontsize=11)
fig.tight_layout()
fig.savefig(OUT / "fig_v2_first_visible.pdf")
fig.savefig(OUT / "fig_v2_first_visible.png")
plt.close(fig)
print(f"  fig_v2_first_visible.pdf")


# ============================================================
# Figure 3.3: Useful Chunks Before Demand
# ============================================================
fig, ax = plt.subplots(figsize=(3.5, 2.4))

for i, (bid, label) in enumerate(zip(baselines, short)):
    vals = get_vals(bid, "useful_chunks_before_demand")
    m, s = mean_std(vals)
    ax.bar(x[i], m, width * 2.2, yerr=s, capsize=3,
           color=COLORS[label], alpha=0.85, edgecolor="none",
           label=LABELS[label], error_kw={"linewidth": 0.8})
    for j, v in enumerate(vals):
        ax.scatter(x[i] + (j - 1) * 0.08, v, s=12, color="k", alpha=0.5, zorder=5)

ax.set_ylabel("Useful chunks ready\nbefore demand")
ax.set_xticks(x)
ax.set_xticklabels(["B0\nOn-demand", "B3-ready\n(VRC-Single v2)", "B4-ready\n(Oracle)"])
ax.set_ylim(0, None)
ax.legend(loc="upper left", frameon=False)
ax.set_title("c", fontweight="bold", loc="left", fontsize=11)
fig.tight_layout()
fig.savefig(OUT / "fig_v2_useful_before.pdf")
fig.savefig(OUT / "fig_v2_useful_before.png")
plt.close(fig)
print(f"  fig_v2_useful_before.pdf")


# ============================================================
# Figure 3.4: Cold-Start vs Warm-State Comparison (B0 vs B3)
# ============================================================
fig, axes = plt.subplots(1, 2, figsize=(5.5, 2.4))

# Panel (d): miss100 per trial round
ax = axes[0]
rounds = ["t0\n(cold)", "t1\n(warm)", "t2\n(warm)"]
b0_miss = [v * 100 for v in get_vals("B0_on_demand", "deadline_miss_ratio_100ms")]
b3_miss = [v * 100 for v in get_vals("B3_ready", "deadline_miss_ratio_100ms")]
xr = np.arange(3)
ax.plot(xr, b0_miss, "o-", color=COLORS["B0"], label="B0 On-demand", markersize=5)
ax.plot(xr, b3_miss, "s-", color=COLORS["B3"], label="B3-ready", markersize=5)
ax.set_xticks(xr)
ax.set_xticklabels(rounds)
ax.set_ylabel("Deadline miss (%)")
ax.set_ylim(0, 110)
ax.axhline(50, color="gray", ls="--", lw=0.5, alpha=0.5)
ax.legend(loc="upper right", frameon=False)
ax.set_title("d", fontweight="bold", loc="left", fontsize=11)
ax.set_xlabel("Trial round (interleaved)")

# Panel (e): useful_before per trial round
ax = axes[1]
b0_useful = get_vals("B0_on_demand", "useful_chunks_before_demand")
b3_useful = get_vals("B3_ready", "useful_chunks_before_demand")
ax.plot(xr, b0_useful, "o-", color=COLORS["B0"], label="B0 On-demand", markersize=5)
ax.plot(xr, b3_useful, "s-", color=COLORS["B3"], label="B3-ready", markersize=5)
ax.set_xticks(xr)
ax.set_xticklabels(rounds)
ax.set_ylabel("Useful chunks before demand")
ax.set_ylim(0, None)
ax.legend(loc="lower right", frameon=False)
ax.set_title("e", fontweight="bold", loc="left", fontsize=11)
ax.set_xlabel("Trial round (interleaved)")

fig.tight_layout()
fig.savefig(OUT / "fig_v2_cold_warm_dynamics.pdf")
fig.savefig(OUT / "fig_v2_cold_warm_dynamics.png")
plt.close(fig)
print(f"  fig_v2_cold_warm_dynamics.pdf")


# ============================================================
# Figure 3.5: FPS + Wasted Prefetch (efficiency)
# ============================================================
fig, axes = plt.subplots(1, 2, figsize=(5.5, 2.4))

# Panel (f): FPS
ax = axes[0]
for i, (bid, label) in enumerate(zip(baselines, short)):
    vals = get_vals(bid, "measure_fps")
    m, s = mean_std(vals)
    ax.bar(x[i], m, width * 2.2, yerr=s, capsize=3,
           color=COLORS[label], alpha=0.85, edgecolor="none",
           error_kw={"linewidth": 0.8})
    for j, v in enumerate(vals):
        ax.scatter(x[i] + (j - 1) * 0.08, v, s=12, color="k", alpha=0.5, zorder=5)
ax.set_ylabel("Render FPS")
ax.set_xticks(x)
ax.set_xticklabels(["B0", "B3-ready", "B4-ready"])
ax.axhline(60, color="green", ls="--", lw=0.5, alpha=0.6, label="60 FPS target")
ax.legend(loc="lower right", frameon=False)
ax.set_title("f", fontweight="bold", loc="left", fontsize=11)

# Panel (g): Wasted prefetch ratio
ax = axes[1]
for i, (bid, label) in enumerate(zip(baselines, short)):
    vals = [v * 100 for v in get_vals(bid, "wasted_prefetch_ratio")]
    m, s = mean_std(vals)
    ax.bar(x[i], m, width * 2.2, yerr=s, capsize=3,
           color=COLORS[label], alpha=0.85, edgecolor="none",
           error_kw={"linewidth": 0.8})
ax.set_ylabel("Wasted prefetch (%)")
ax.set_xticks(x)
ax.set_xticklabels(["B0", "B3-ready", "B4-ready"])
ax.axhline(30, color="red", ls="--", lw=0.5, alpha=0.6, label="30% threshold")
ax.set_ylim(0, 35)
ax.legend(loc="upper right", frameon=False)
ax.set_title("g", fontweight="bold", loc="left", fontsize=11)

fig.tight_layout()
fig.savefig(OUT / "fig_v2_efficiency.pdf")
fig.savefig(OUT / "fig_v2_efficiency.png")
plt.close(fig)
print(f"  fig_v2_efficiency.pdf")


# ============================================================
# Figure 3.6: Visibility Timeline (B0 t0 vs B3 t0 — cold start)
# ============================================================
fig, ax = plt.subplots(figsize=(4.5, 2.4))

for bid, label, color in [("B0_on_demand", "B0", COLORS["B0"]),
                           ("B3_ready", "B3-ready", COLORS["B3"]),
                           ("B4_ready_oracle", "B4-oracle", COLORS["B4"])]:
    t0 = data[bid][0]  # cold-start trial
    tl = t0.get("visible_splat_timeline") or []
    if not tl:
        continue
    ts = [p.get("t", 0) / 1000.0 for p in tl]
    vs = [p.get("visible_splat_count", 0) for p in tl]
    ax.plot(ts, vs, color=color, label=label, lw=1.0, alpha=0.85)

ax.set_xlabel("Time since page load (s)")
ax.set_ylabel("Visible splat count")
ax.set_xlim(0, None)
ax.set_ylim(0, None)
ax.legend(loc="lower right", frameon=False)
ax.set_title("h", fontweight="bold", loc="left", fontsize=11)
fig.tight_layout()
fig.savefig(OUT / "fig_v2_visibility_timeline.pdf")
fig.savefig(OUT / "fig_v2_visibility_timeline.png")
plt.close(fig)
print(f"  fig_v2_visibility_timeline.pdf")


# ============================================================
# Summary table data (for paper LaTeX table verification)
# ============================================================
print("\n=== Summary Table Data (for LaTeX) ===")
print(f"{'Baseline':<20} {'miss100%':>8} {'useful':>7} {'first_vis':>10} {'FPS':>6} {'wasted%':>8} {'demanded':>8}")
for bid, label in zip(baselines, ["B0", "B3-ready", "B4-oracle"]):
    miss = mean_std([v * 100 for v in get_vals(bid, "deadline_miss_ratio_100ms")])
    useful = mean_std(get_vals(bid, "useful_chunks_before_demand"))
    fvis = mean_std(get_vals(bid, "first_visible_splat_ms"))
    fps = mean_std(get_vals(bid, "measure_fps"))
    wasted = mean_std([v * 100 for v in get_vals(bid, "wasted_prefetch_ratio")])
    demanded = mean_std(get_vals(bid, "demanded_chunks"))
    print(f"{label:<20} {miss[0]:5.1f}±{miss[1]:4.1f} {useful[0]:5.0f}±{useful[1]:3.0f} {fvis[0]:7.0f}±{fvis[1]:4.0f} {fps[0]:5.1f}±{fps[1]:3.1f} {wasted[0]:5.1f}±{wasted[1]:3.1f} {demanded[0]:5.0f}±{demanded[1]:3.0f}")

print("\n=== Per-Trial Data (for supplementary) ===")
print(f"{'Baseline':<20} {'trial':>5} {'miss100%':>8} {'useful':>7} {'first_vis':>10} {'FPS':>6} {'demanded':>8}")
for bid, label in zip(baselines, ["B0", "B3-ready", "B4-oracle"]):
    for i, t in enumerate(data[bid]):
        print(f"{label:<20} t{i:<4} {t.get('deadline_miss_ratio_100ms',0)*100:5.1f}% {t.get('useful_chunks_before_demand',0):>7} {t.get('first_visible_splat_ms',0):>10.1f} {t.get('measure_fps',0):>6.1f} {t.get('demanded_chunks',0):>8}")

print(f"\nFigures saved to: {OUT}")
print("Done.")
