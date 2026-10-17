"""
Introduction Figure 1: Remote-to-visible readiness gap (Spark2.0).
Four separate PDFs (a–d). Data: phase_delivery_path_sanity, t0–t3, Local / Edge / GCS.

Run:
  python vrc-paper/paper/figures/gen_remote_readiness_gap.py
"""
from __future__ import annotations

import json
import statistics
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

REPO = Path(__file__).resolve().parents[3]
BATCH = (
    REPO
    / "paper_materials/ready_single_user_v1/runs"
    / "delivery_path_sanity_2026-05-28T00-19-46"
)
OUT_DIR = Path(__file__).resolve().parent

PATHS = [
    ("local_disk", "Local"),
    ("edge_server", "Edge"),
    ("remote_gcs", "GCS"),
]
TRIALS = ("t0", "t1", "t2", "t3")

# Font sizes (+8 from prior 26pt baseline)
FS = 34
FS_BAR_LABEL = 34

# Fixed canvas — all panels match First visible (inches)
FIG_SIZE = (10.0, 7.0)
FIG_MARGINS = {"left": 0.18, "right": 0.96, "top": 0.96, "bottom": 0.12}

# Colorblind-safe (Okabe–Ito)
C_LOCAL = "#0072B2"
C_EDGE = "#E69F00"
C_GCS = "#D55E00"
PATH_COLORS = [C_LOCAL, C_EDGE, C_GCS]
C_Q5 = "#56B4E9"
C_Q10 = "#009E73"
C_FETCH = "#0072B2"
C_PARSE = "#CC79A7"

def mean(xs: list[float]) -> float:
    return statistics.fmean(xs) if xs else float("nan")


def load_trial(delivery_key: str, trial: str) -> dict:
    stem = f"{delivery_key}__spark_od__phase_delivery_path_sanity__{trial}"
    with open(BATCH / "per_trial_json" / f"{stem}.json", encoding="utf-8") as f:
        trial_json = json.load(f)
    summary_path = BATCH / "per_trial_runs" / stem / "summary" / "experiment_summary.json"
    with open(summary_path, encoding="utf-8") as f:
        summary = json.load(f)
    return {**trial_json, **summary}


def collect() -> dict:
    data: dict = {}
    for dk, label in PATHS:
        rows = [load_trial(dk, t) for t in TRIALS]
        data[label] = {
            "fv_s": [r["first_visible_splat_ms"] / 1000.0 for r in rows],
            "q5_m": [r["quality_at_5s"] / 1e6 for r in rows],
            "q10_m": [r["quality_at_10s"] / 1e6 for r in rows],
            "t1m_s": [r["time_to_1M_visible_splats_ms"] / 1000.0 for r in rows],
            "fetch_p95": [r["measure_fetch_p95_ms"] for r in rows],
            "parse_p95": [r["measure_parse_p95_ms"] for r in rows],
        }
    return data


def apply_rc() -> None:
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": FS,
            "axes.labelsize": FS,
            "xtick.labelsize": FS,
            "ytick.labelsize": FS,
            "legend.fontsize": FS,
            "figure.dpi": 300,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def style_axes(ax: plt.Axes) -> None:
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(1.0)
        spine.set_color("black")
    ax.grid(axis="y", alpha=0.22, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(axis="both", which="major", labelsize=FS)


def label_bars(ax: plt.Axes, bars, values: list[float], fmt: str) -> None:
    for bar, val in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height(),
            fmt.format(val),
            ha="center",
            va="bottom",
            fontsize=FS_BAR_LABEL,
            fontweight="medium",
            color="#222222",
            clip_on=False,
        )


def save_panel(fig: plt.Figure, stem: str) -> None:
    fig.subplots_adjust(**FIG_MARGINS)
    pdf = OUT_DIR / f"remote_readiness_gap_{stem}.pdf"
    png = OUT_DIR / f"remote_readiness_gap_{stem}.png"
    # Fixed page size (no tight bbox) so all four PDFs share identical dimensions.
    fig.savefig(pdf, dpi=300, facecolor="white", bbox_inches=None, pad_inches=0)
    fig.savefig(png, dpi=300, facecolor="white", bbox_inches=None, pad_inches=0)
    plt.close(fig)
    print(f"Wrote {pdf}")
    print(f"Wrote {png}")


def new_figure() -> tuple[plt.Figure, plt.Axes]:
    fig, ax = plt.subplots(figsize=FIG_SIZE)
    return fig, ax


def panel_a(ax: plt.Axes, data: dict) -> None:
    labels = [p[1] for p in PATHS]
    x = np.arange(len(labels))
    means = [mean(data[l]["fv_s"]) for l in labels]

    bars = ax.bar(
        x,
        means,
        width=0.55,
        color=PATH_COLORS,
        edgecolor="black",
        linewidth=0.6,
        zorder=2,
    )
    label_bars(ax, bars, means, "{:.2f}")

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=FS)
    ax.set_ylabel("First visible (s)", fontsize=FS)
    style_axes(ax)
    ax.set_ylim(0, max(means) * 1.28)


def panel_b(ax: plt.Axes, data: dict) -> None:
    labels = [p[1] for p in PATHS]
    x = np.arange(len(labels))
    w = 0.32
    q5_means = [mean(data[l]["q5_m"]) for l in labels]
    q10_means = [mean(data[l]["q10_m"]) for l in labels]

    bars_q5 = ax.bar(
        x - w / 2,
        q5_means,
        width=w,
        color=C_Q5,
        edgecolor="black",
        linewidth=0.5,
        label="quality@5s",
        zorder=2,
    )
    bars_q10 = ax.bar(
        x + w / 2,
        q10_means,
        width=w,
        color=C_Q10,
        edgecolor="black",
        linewidth=0.5,
        label="quality@10s",
        zorder=2,
    )
    label_bars(ax, bars_q5, q5_means, "{:.2f}")
    label_bars(ax, bars_q10, q10_means, "{:.2f}")

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=FS)
    ax.set_ylabel("Visible splats (M)", fontsize=FS)
    ax.legend(frameon=False, loc="upper right")
    style_axes(ax)
    ax.set_ylim(0, max(q10_means) * 1.32)


def panel_c(ax: plt.Axes, data: dict) -> None:
    labels = [p[1] for p in PATHS]
    x = np.arange(len(labels))
    means = [mean(data[l]["t1m_s"]) for l in labels]

    bars = ax.bar(
        x,
        means,
        width=0.55,
        color=PATH_COLORS,
        edgecolor="black",
        linewidth=0.6,
        zorder=2,
    )
    label_bars(ax, bars, means, "{:.2f}")

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=FS)
    ax.set_ylabel("Time (s)", fontsize=FS)
    style_axes(ax)
    ax.set_ylim(0, max(means) * 1.28)


def panel_d(ax: plt.Axes, data: dict) -> None:
    labels = [p[1] for p in PATHS]
    x = np.arange(len(labels))
    w = 0.32
    fetch_means = [mean(data[l]["fetch_p95"]) for l in labels]
    parse_means = [mean(data[l]["parse_p95"]) for l in labels]

    bars_fetch = ax.bar(
        x - w / 2,
        fetch_means,
        width=w,
        color=C_FETCH,
        edgecolor="black",
        linewidth=0.5,
        label="fetch p95",
        zorder=2,
    )
    bars_parse = ax.bar(
        x + w / 2,
        parse_means,
        width=w,
        color=C_PARSE,
        edgecolor="black",
        linewidth=0.5,
        label="parse p95",
        zorder=2,
    )
    label_bars(ax, bars_fetch, fetch_means, "{:.0f}")
    label_bars(ax, bars_parse, parse_means, "{:.0f}")

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=FS)
    ax.set_ylabel("p95 latency (ms)", fontsize=FS)
    ax.legend(frameon=False, loc="upper left")
    style_axes(ax)
    ax.set_ylim(0, max(parse_means) * 1.28)


def main() -> None:
    apply_rc()
    data = collect()

    outputs = [
        ("a", "first_visible", panel_a),
        ("b", "early_quality", panel_b),
        ("c", "time_1m", panel_c),
        ("d", "pipeline_tail", panel_d),
    ]
    for letter, stem, draw in outputs:
        fig, ax = new_figure()
        draw(ax, data)
        save_panel(fig, f"{letter}_{stem}")

    for lab in [p[1] for p in PATHS]:
        d = data[lab]
        print(
            f"  {lab}: FV mean={mean(d['fv_s']):.2f}s, "
            f"q5={mean(d['q5_m']):.2f}M, q10={mean(d['q10_m']):.2f}M, "
            f"t1M={mean(d['t1m_s']):.2f}s"
        )


if __name__ == "__main__":
    main()
