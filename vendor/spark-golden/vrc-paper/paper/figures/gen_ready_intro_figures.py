#!/usr/bin/env python3
"""
Generate READY paper Introduction figure assets.

Outputs (under vrc-paper/paper/figures/):
  - ready_cold_start_teaser.pdf / .png
  - fast_empty_motivation.pdf / .png

Graphviz (ready_design_overview.dot) is rendered separately via WSL:
  dot -Tpdf ready_design_overview.dot -o ready_design_overview.pdf
  dot -Tsvg ready_design_overview.dot -o ready_design_overview.svg

Data sources:
  Fig 3: chapter3 cold-start t0 (proactive_single_user_v2 batch 2026-05-24T16-06-30)
  Fig 1: measurement_motivation_24h audit (E3 single_user, n=3)
"""
from __future__ import annotations

import subprocess
import sys
import shutil
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica", "Arial", "DejaVu Sans"],
        "font.size": 8,
        "axes.labelsize": 8.5,
        "axes.titlesize": 9,
        "xtick.labelsize": 7.5,
        "ytick.labelsize": 7.5,
        "figure.dpi": 300,
        "savefig.dpi": 300,
        "axes.linewidth": 0.6,
        "axes.spines.top": False,
        "axes.spines.right": False,
    }
)


def _bar_labels(ax, bars, fmt="{:.1f}", dy=0.02):
    ymax = ax.get_ylim()[1]
    for bar in bars:
        h = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            h + ymax * dy,
            fmt.format(h),
            ha="center",
            va="bottom",
            fontsize=7,
        )


def fig_ready_cold_start_teaser(out: Path) -> None:
    """Figure 3: cold-start teaser (t0, origin_server / LAN proxy path)."""
    methods = ["Default\nSpark 2.0", "READY", "Oracle"]
    miss100 = [99.5, 65.1, 69.7]
    first_visible_s = [7.1106, 3.3523, 8.4998]
    useful_before = [0, 119, 94]
    colors = ["#7F7F7F", "#0072B2", "#E69F00"]
    x = np.arange(len(methods))

    fig, axes = plt.subplots(1, 3, figsize=(7.0, 2.2), constrained_layout=True)

    ax = axes[0]
    bars = ax.bar(x, miss100, color=colors, width=0.62, edgecolor="white", linewidth=0.4)
    ax.set_ylabel("Deadline miss (%)")
    ax.set_title("(a) 100 ms deadline miss")
    ax.set_xticks(x)
    ax.set_xticklabels(methods)
    ax.set_ylim(0, 110)
    ax.yaxis.grid(True, alpha=0.25, linewidth=0.5)
    ax.set_axisbelow(True)
    _bar_labels(ax, bars, fmt="{:.1f}")

    ax = axes[1]
    bars = ax.bar(x, first_visible_s, color=colors, width=0.62, edgecolor="white", linewidth=0.4)
    ax.set_ylabel("First visible (s)")
    ax.set_title("(b) First visible latency")
    ax.set_xticks(x)
    ax.set_xticklabels(methods)
    ax.set_ylim(0, 9.5)
    ax.yaxis.grid(True, alpha=0.25, linewidth=0.5)
    ax.set_axisbelow(True)
    _bar_labels(ax, bars, fmt="{:.2f}")

    ax = axes[2]
    bars = ax.bar(x, useful_before, color=colors, width=0.62, edgecolor="white", linewidth=0.4)
    ax.set_ylabel("Useful chunks")
    ax.set_title("(c) Ready before demand")
    ax.set_xticks(x)
    ax.set_xticklabels(methods)
    ax.set_ylim(0, 140)
    ax.yaxis.grid(True, alpha=0.25, linewidth=0.5)
    ax.set_axisbelow(True)
    _bar_labels(ax, bars, fmt="{:.0f}")

    fig.savefig(out / "ready_cold_start_teaser.pdf", bbox_inches="tight", facecolor="white")
    fig.savefig(out / "ready_cold_start_teaser.png", bbox_inches="tight", facecolor="white", dpi=200)
    plt.close(fig)
    print("  ready_cold_start_teaser.pdf/png")


def fig_fast_empty_motivation(out: Path) -> None:
    """Figure 1: fast-but-empty motivation (E3 single_user, 3-trial mean)."""
    delivery = ["Local", "Origin", "Remote"]
    p95_ms = [30, 499, 15872]
    fps = [86.9, 88.3, 156.3]
    chunks = [230, 277, 17]
    x = np.arange(len(delivery))

    fig, (ax_a, ax_b) = plt.subplots(1, 2, figsize=(7.0, 2.4), constrained_layout=True)

    bars = ax_a.bar(x, p95_ms, color="#D55E00", width=0.55, edgecolor="white", linewidth=0.4)
    ax_a.set_yscale("log")
    ax_a.set_ylabel("Chunk network p95 (ms)")
    ax_a.set_title("(a) Per-chunk network latency")
    ax_a.set_xticks(x)
    ax_a.set_xticklabels(delivery)
    ax_a.set_ylim(15, 30000)
    ax_a.yaxis.grid(True, alpha=0.25, linewidth=0.5, which="both")
    ax_a.set_axisbelow(True)
    for bar, val in zip(bars, p95_ms):
        ax_a.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() * 1.15,
            f"{val:,}",
            ha="center",
            va="bottom",
            fontsize=7,
        )

    bars = ax_b.bar(
        x,
        chunks,
        color="#0072B2",
        width=0.55,
        alpha=0.85,
        label="Chunks / 40 s",
        edgecolor="white",
        linewidth=0.4,
    )
    ax_b.set_ylabel("Completed chunks (40 s)")
    ax_b.set_ylim(0, 320)
    ax_b.set_title("(b) Throughput vs frame rate")
    ax_b.set_xticks(x)
    ax_b.set_xticklabels(delivery)
    ax_b.yaxis.grid(True, alpha=0.25, linewidth=0.5)
    ax_b.set_axisbelow(True)
    for bar, val in zip(bars, chunks):
        ax_b.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 6,
            str(val),
            ha="center",
            va="bottom",
            fontsize=7,
        )

    ax_fps = ax_b.twinx()
    ax_fps.plot(x, fps, "o-", color="#7F7F7F", linewidth=1.4, markersize=5, label="FPS")
    ax_fps.set_ylabel("Measure FPS", color="#7F7F7F")
    ax_fps.tick_params(axis="y", labelcolor="#7F7F7F", labelsize=7.5)
    ax_fps.set_ylim(70, 175)
    ax_fps.spines["top"].set_visible(False)

    ax_b.annotate(
        "fast but empty:\nhigh FPS, only 17 chunks",
        xy=(2, 17),
        xytext=(1.35, 120),
        fontsize=6.5,
        fontstyle="italic",
        color="#D55E00",
        arrowprops=dict(arrowstyle="->", color="#D55E00", lw=0.9),
    )

    fig.savefig(out / "fast_empty_motivation.pdf", bbox_inches="tight", facecolor="white")
    fig.savefig(out / "fast_empty_motivation.png", bbox_inches="tight", facecolor="white", dpi=200)
    plt.close(fig)
    print("  fast_empty_motivation.pdf/png")


def render_design_overview_matplotlib(out: Path) -> None:
    """Figure 2: READY design overview (matplotlib fallback when Graphviz absent)."""
    from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

    fig, ax = plt.subplots(figsize=(10.5, 3.6))
    ax.set_xlim(0, 10.5)
    ax.set_ylim(0, 3.6)
    ax.axis("off")

    def box(x, y, w, h, text, fill, edge, fs=8.5):
        patch = FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.03,rounding_size=0.08",
            linewidth=1.2,
            edgecolor=edge,
            facecolor=fill,
        )
        ax.add_patch(patch)
        ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs)

    def arrow(x1, y1, x2, y2, color="#404040", style="-", label=None, label_color="#333"):
        arr = FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=10,
            linewidth=1.1,
            color=color,
            linestyle=style,
            shrinkA=4,
            shrinkB=4,
        )
        ax.add_patch(arr)
        if label:
            ax.text(
                (x1 + x2) / 2,
                (y1 + y2) / 2 + 0.12,
                label,
                ha="center",
                va="bottom",
                fontsize=7,
                color=label_color,
            )

    spark_fill, spark_edge = "#E5E5E5", "#404040"
    ready_fill, ready_edge = "#D9ECFF", "#0072B2"
    track_fill, track_edge = "#DDF3E6", "#009E73"

    y_spark, y_ready = 2.05, 0.55
    bw, bh = 1.35, 0.72
    xs = [0.2, 1.75, 3.3, 4.85, 6.4]

    # Spark on-demand path (top)
    labels_spark = [
        "Camera\npose",
        "Spark 2.0\npager",
        "HTTP Range\nfetch",
        "Parser /\nGPU prep.",
        "Renderer",
    ]
    for i, lab in enumerate(labels_spark):
        box(xs[i], y_spark, bw, bh, lab, spark_fill, spark_edge)
        if i < len(labels_spark) - 1:
            arrow(xs[i] + bw, y_spark + bh / 2, xs[i + 1], y_spark + bh / 2)

    # READY proactive path (bottom)
    labels_ready = [
        "Camera\npose",
        "Future viewport\nprediction",
        "Chunk\nscoring",
        "Bounded worker\nprefetch",
    ]
    for i, lab in enumerate(labels_ready):
        box(xs[i], y_ready, bw, bh, lab, ready_fill if i else spark_fill, ready_edge if i else spark_edge)
        if i < len(labels_ready) - 1:
            arrow(
                xs[i] + bw,
                y_ready + bh / 2,
                xs[i + 1],
                y_ready + bh / 2,
                color=ready_edge,
            )
    # Prefetch -> HTTP Range fetch
    arrow(xs[2] + bw / 2, y_ready + bh, xs[2] + bw / 2, y_spark, color=ready_edge)

    # Readiness tracker
    tx, ty, tw, th = 5.05, 0.95, 1.55, 0.85
    box(tx, ty, tw, th, "Readiness\ntracker", track_fill, track_edge)

    arrow(xs[1] + bw / 2, y_spark, tx + tw / 2, ty + th, color=track_edge, label="demand time")
    arrow(xs[3] + bw / 2, y_spark, tx + tw / 2, ty + th, color=track_edge)
    arrow(
        tx + tw,
        ty + th / 2,
        xs[4],
        y_spark + bh / 2,
        color="#D55E00",
        style="--",
        label="ready before demand?",
        label_color="#D55E00",
    )

    ax.text(
        0.2,
        3.35,
        "READY design overview — Spark 2.0 on-demand path (gray) + readiness-aware prefetch (blue)",
        fontsize=10,
        fontweight="bold",
    )
    ax.text(
        0.2,
        0.08,
        "Goal: ready_time(chunk) < demand_time(chunk) + 100 ms",
        fontsize=8,
        color="#D55E00",
        fontstyle="italic",
    )

    # Legend
    for lx, lab, fc, ec in [
        (0.2, "Spark 2.0 module", spark_fill, spark_edge),
        (2.4, "READY module", ready_fill, ready_edge),
        (4.3, "Readiness tracker", track_fill, track_edge),
    ]:
        box(lx, 3.02, 0.28, 0.18, "", fc, ec, fs=1)
        ax.text(lx + 0.35, 3.11, lab, fontsize=7, va="center")

    fig.savefig(out / "ready_design_overview.pdf", bbox_inches="tight", facecolor="white")
    fig.savefig(out / "ready_design_overview.svg", bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("  ready_design_overview.pdf/svg (matplotlib)")


def render_graphviz(out: Path) -> None:
    dot = out / "ready_design_overview.dot"
    dot_bin = shutil.which("dot")
    if not dot_bin or not dot.exists():
        print("  skip graphviz: dot unavailable (matplotlib version already written)", file=sys.stderr)
        return
    for fmt in ("pdf", "svg"):
        dest = out / f"ready_design_overview.{fmt}"
        cmd = [dot_bin, f"-T{fmt}", str(dot), "-o", str(dest)]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True)
            print(f"  ready_design_overview.{fmt} (graphviz)")
        except (FileNotFoundError, PermissionError, subprocess.CalledProcessError) as e:
            print(f"  skip graphviz {fmt}: {e}", file=sys.stderr)
            return


def main() -> None:
    out = HERE
    print(f"Generating READY intro figures in {out}")
    fig_ready_cold_start_teaser(out)
    fig_fast_empty_motivation(out)
    render_design_overview_matplotlib(out)
    render_graphviz(out)
    print("Done.")


if __name__ == "__main__":
    main()
