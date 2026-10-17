"""
Intro Figure 1: Remote-to-visible milestone timeline.
Thin horizontal track + markers only (no duration blocks).

Run:
  python vrc-paper/paper/figures/gen_remote_readiness_gap_timeline.py
"""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.lines as mlines
import numpy as np

OUT_DIR = Path(__file__).resolve().parent
PDF_PATH = OUT_DIR / "remote_readiness_gap_timeline.pdf"
PNG_PATH = OUT_DIR / "remote_readiness_gap_timeline.png"

FS = 28
FS_MARKER = 24
FS_LEGEND = 26

ROW_COLORS = {
    "Local": "#0072B2",
    "Edge": "#E69F00",
    "GCS": "#D55E00",
}

DATA = {
    "Local": {
        "first_visible": 1.80,
        "quality_5s": 1.36,
        "quality_10s": 3.23,
        "time_to_1M": 8.13,
    },
    "Edge": {
        "first_visible": 1.97,
        "quality_5s": 1.22,
        "quality_10s": 2.69,
        "time_to_1M": 8.75,
    },
    "GCS": {
        "first_visible": 3.18,
        "quality_5s": 0.62,
        "quality_10s": 1.20,
        "time_to_1M": 13.25,
    },
}

ROW_ORDER = ["Local", "Edge", "GCS"]
ROW_LABEL_FLIP = {"Local": 1, "Edge": -1, "GCS": 1}
X_MAX = 15.0
EARLY_END = 10.0

def label_offsets(xs: list[float]) -> list[int]:
    """Return vertical pixel offsets (+above / -below) to separate nearby labels."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    slots = [22, -26, 30, -30]
    offsets = [0] * len(xs)
    for rank, idx in enumerate(order):
        offsets[idx] = slots[rank % len(slots)]
        if rank > 0:
            prev_idx = order[rank - 1]
            if xs[idx] - xs[prev_idx] < 2.2:
                offsets[idx] = -offsets[prev_idx] if offsets[prev_idx] > 0 else 28
    return offsets


def apply_rc() -> None:
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": FS,
            "axes.labelsize": FS,
            "xtick.labelsize": FS,
            "ytick.labelsize": FS,
            "figure.dpi": 300,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def draw_row(ax: plt.Axes, y: float, name: str, d: dict) -> None:
    color = ROW_COLORS[name]

    ax.hlines(y, 0, X_MAX, colors=color, linewidth=1.8, alpha=0.45, zorder=2)

    milestones = [
        ("fv", d["first_visible"], "o", f"FV {d['first_visible']:.2f}s"),
        ("q5", 5.0, "s", f"q@5s {d['quality_5s']:.2f}M"),
        ("t1m", d["time_to_1M"], "D", f"1M @ {d['time_to_1M']:.2f}s"),
        ("q10", 10.0, "s", f"q@10s {d['quality_10s']:.2f}M"),
    ]
    y_offs = label_offsets([m[1] for m in milestones])
    flip = ROW_LABEL_FLIP[name]

    for i, (_key, x_pos, marker, label) in enumerate(milestones):
        y_off = y_offs[i] * flip
        if marker == "o":
            ax.scatter(
                [x_pos],
                [y],
                s=280,
                marker="o",
                facecolors="white",
                edgecolors=color,
                linewidths=2.8,
                zorder=4,
                clip_on=False,
            )
        elif marker == "s":
            ax.scatter(
                [x_pos],
                [y],
                s=240,
                marker="s",
                facecolors=color,
                edgecolors="black",
                linewidths=1.0,
                alpha=0.95,
                zorder=4,
                clip_on=False,
            )
        else:
            ax.scatter(
                [x_pos],
                [y],
                s=300,
                marker="D",
                facecolors=color,
                edgecolors="black",
                linewidths=1.0,
                zorder=5,
                clip_on=False,
            )

        ha = "center"
        if x_pos < 2.5:
            ha = "left"
        elif x_pos > 12.5:
            ha = "right"

        ax.annotate(
            label,
            (x_pos, y),
            textcoords="offset points",
            xytext=(0, y_off),
            ha=ha,
            va="bottom" if y_off > 0 else "top",
            fontsize=FS_MARKER,
            color="#222222" if marker == "s" else color,
            fontweight="medium" if _key in ("fv", "t1m") else "normal",
            zorder=6,
            clip_on=False,
        )


def draw_timeline(ax: plt.Axes) -> None:
    y_pos = {name: float(i) for i, name in enumerate(reversed(ROW_ORDER))}

    ax.axvspan(0, EARLY_END, color="#ECEFF3", alpha=0.85, zorder=0)
    ax.text(
        EARLY_END / 2,
        len(ROW_ORDER) + 0.15,
        "early interaction window (0–10s)",
        ha="center",
        va="bottom",
        fontsize=FS - 2,
        color="#555555",
        style="italic",
        zorder=1,
    )

    for x_line in (5.0, 10.0):
        ax.axvline(x_line, color="#CCCCCC", linestyle=":", linewidth=0.9, zorder=1)

    for name in ROW_ORDER:
        draw_row(ax, y_pos[name], name, DATA[name])

    ax.set_yticks([y_pos[n] for n in ROW_ORDER])
    ax.set_yticklabels(ROW_ORDER, fontsize=FS)
    ax.set_xlim(-0.2, X_MAX + 0.3)
    ax.set_ylim(-0.85, len(ROW_ORDER) + 0.65)
    ax.set_xlabel("Time (s)", fontsize=FS, labelpad=12)
    ax.set_xticks(np.arange(0, X_MAX + 1, 2.5))
    ax.grid(axis="x", alpha=0.15, linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)

    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(1.0)
        spine.set_color("black")


def main() -> None:
    apply_rc()

    fig, ax = plt.subplots(figsize=(14, 6.2))
    draw_timeline(ax)

    legend_handles = [
        mlines.Line2D(
            [],
            [],
            marker="o",
            color="w",
            markerfacecolor="white",
            markeredgecolor="#333333",
            markeredgewidth=2.2,
            markersize=14,
            label="first visible (FV)",
        ),
        mlines.Line2D(
            [],
            [],
            marker="s",
            color="w",
            markerfacecolor="#888888",
            markeredgecolor="black",
            markersize=13,
            label="visible quality checkpoint",
        ),
        mlines.Line2D(
            [],
            [],
            marker="D",
            color="w",
            markerfacecolor="#888888",
            markeredgecolor="black",
            markersize=14,
            label="1M visible splats reached",
        ),
        mlines.Line2D([], [], color="#ECEFF3", linewidth=12, label="early window (0–10s)"),
    ]
    ax.legend(
        handles=legend_handles,
        loc="upper center",
        bbox_to_anchor=(0.5, -0.11),
        ncol=4,
        frameon=False,
        fontsize=FS_LEGEND,
        handlelength=1.8,
        columnspacing=1.6,
    )

    fig.subplots_adjust(left=0.08, right=0.99, top=0.90, bottom=0.22)

    fig.savefig(PDF_PATH, dpi=300, facecolor="white", bbox_inches="tight", pad_inches=0.08)
    fig.savefig(PNG_PATH, dpi=300, facecolor="white", bbox_inches="tight", pad_inches=0.08)
    plt.close(fig)

    print(f"Wrote {PDF_PATH}")
    print(f"Wrote {PNG_PATH}")


if __name__ == "__main__":
    main()
