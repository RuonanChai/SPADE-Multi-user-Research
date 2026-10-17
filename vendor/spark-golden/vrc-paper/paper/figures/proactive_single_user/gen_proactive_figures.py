#!/usr/bin/env python3
"""Figures 3.1–3.5 for Chapter 3 (PDF + PNG)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent

BASELINES = [
    "B0_on_demand",
    "B1_naive_prefetch",
    "B2_priority_prefetch",
    "B3_vrc_single",
    "B4_oracle_prefetch",
]
LABELS = ["B0", "B1", "B2", "B3", "B4*"]
COLORS = ["#4477AA", "#66CCEE", "#228833", "#CCBB44", "#AA3377"]


def load_trials(batch_dir: Path):
    rows = []
    for p in (batch_dir / "per_trial_json").glob("*.json"):
        rows.append(json.loads(p.read_text(encoding="utf-8")))
    return rows


def mean(xs):
    v = [x for x in xs if x is not None and x == x]
    return sum(v) / len(v) if v else 0.0


def agg(trials, delivery, baseline, field):
    sub = [
        t
        for t in trials
        if t.get("delivery_key") == delivery
        and t.get("baseline_id") == baseline
        and t.get("hard_gate_passed")
    ]
    return mean([t.get(field) for t in sub]), len(sub)


def write_svg_bar(path, title, labels, series, ylabel, series_labels=None):
    w, h = 480, 300
    n = max(len(labels), 1)
    gap = 72
    ox, oy = 56, 240
    maxv = max(max(s) for s in series) if series else 1
    maxv = max(maxv, 0.01)
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">',
        f'<text x="12" y="18" font-size="13" font-family="Arial">{title}</text>',
    ]
    for si, vals in enumerate(series):
        for i, v in enumerate(vals):
            bh = int((v / maxv) * 170)
            x = ox + i * gap + si * 14
            y = oy - bh
            c = COLORS[i % len(COLORS)]
            lines.append(
                f'<rect x="{x}" y="{y}" width="22" height="{bh}" fill="{c}" opacity="{0.85 - si * 0.35}"/>'
            )
    for i, lab in enumerate(labels):
        lines.append(f'<text x="{ox + i * gap}" y="{oy + 16}" font-size="10">{lab}</text>')
    if series_labels:
        for si, sl in enumerate(series_labels):
            lines.append(f'<text x="{w - 120}" y="{30 + si * 14}" font-size="9">{sl}</text>')
    lines.append(f'<text x="8" y="{oy // 2}" font-size="10" transform="rotate(-90 10,{oy // 2})">{ylabel}</text>')
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_svg_line(path, title, series):
    w, h = 520, 280
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">',
        f'<text x="12" y="18" font-size="13">{title}</text>',
    ]
    maxy = max((p[1] for _, pts, _ in series for p in pts), default=1) or 1
    maxx = max((p[0] for _, pts, _ in series for p in pts), default=1) or 1
    for label, pts, color in series:
        if len(pts) < 2:
            continue
        d = "M " + " L ".join(
            f"{40 + (t / maxx) * 440},{240 - (v / maxy) * 200}" for t, v in pts
        )
        lines.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.5"/>')
        lines.append(f'<text x="{w - 80}" y="{30 + len(lines) % 80}" font-size="9" fill="{color}">{label}</text>')
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def svg_to_png(svg_path: Path, png_path: Path):
    try:
        import cairosvg

        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path), scale=2)
        return True
    except Exception:
        pass
    try:
        from PIL import Image
        import io

        import cairosvg

        png_data = cairosvg.svg2png(url=str(svg_path), scale=2)
        Image.open(io.BytesIO(png_data)).save(png_path)
        return True
    except Exception:
        return False


def try_matplotlib_figures(batch_dir: Path, trials, delivery: str):
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        return False

    x = np.arange(len(BASELINES))
    present = [bid for bid in BASELINES if any(t.get("baseline_id") == bid for t in trials)]

    # 3.1
    fig, ax = plt.subplots(figsize=(4.2, 2.8))
    m50, m100, labs = [], [], []
    for bid, lab in zip(BASELINES, LABELS):
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        if not sub:
            continue
        labs.append(lab)
        m50.append(np.mean([t.get("deadline_miss_ratio_50ms", 0) for t in sub]) * 100)
        m100.append(np.mean([t.get("deadline_miss_ratio_100ms", 0) for t in sub]) * 100)
    xi = np.arange(len(labs))
    ax.bar(xi - 0.15, m50, 0.3, label="miss +50ms")
    ax.bar(xi + 0.15, m100, 0.3, label="miss +100ms", alpha=0.55)
    ax.set_xticks(xi)
    ax.set_xticklabels(labs, fontsize=8)
    ax.set_ylabel("Deadline miss (%)")
    ax.set_title(f"Fig 3.1 — {delivery}")
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(OUT / "fig_3_1_deadline_miss.pdf")
    fig.savefig(OUT / "fig_3_1_deadline_miss.png", dpi=200)
    plt.close(fig)

    # 3.2
    fig, ax = plt.subplots(figsize=(4.2, 2.8))
    useful, ratio = [], []
    for bid, lab in zip(BASELINES, LABELS):
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        if not sub:
            continue
        useful.append(np.mean([t.get("useful_chunks_before_demand", 0) for t in sub]))
        ratio.append(np.mean([t.get("useful_bytes_ratio", 0) for t in sub]))
    xi = np.arange(len(useful))
    ax.bar(xi, useful, 0.5, color=COLORS[: len(useful)])
    ax2 = ax.twinx()
    ax2.plot(xi, ratio, "k--o", ms=4)
    ax.set_xticks(xi)
    ax.set_xticklabels([LABELS[BASELINES.index(b)] for b in BASELINES if any(t.get("baseline_id") == b for t in trials)][: len(useful)], fontsize=8)
    ax.set_title("Fig 3.2 — usefulness")
    fig.tight_layout()
    fig.savefig(OUT / "fig_3_2_useful_chunks.pdf")
    fig.savefig(OUT / "fig_3_2_useful_chunks.png", dpi=200)
    plt.close(fig)

    # 3.3
    fig, ax = plt.subplots(figsize=(4.5, 2.8))
    for bid, color, lab in [("B0_on_demand", COLORS[0], "B0"), ("B3_vrc_single", COLORS[3], "B3")]:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        if not sub:
            continue
        tl = sub[0].get("visible_splat_timeline") or []
        if tl:
            ax.plot([p["t"] / 1000 for p in tl], [p["visible_splat_count"] for p in tl], color=color, label=lab, lw=1.2)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Visible splats")
    ax.set_title("Fig 3.3 — visibility timeline")
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(OUT / "fig_3_3_visible_splats.pdf")
    fig.savefig(OUT / "fig_3_3_visible_splats.png", dpi=200)
    plt.close(fig)

    # 3.4
    fig, ax = plt.subplots(figsize=(4.2, 2.8))
    fvis, waste, labs2 = [], [], []
    for bid, lab in zip(BASELINES, LABELS):
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
        if not sub:
            continue
        labs2.append(lab)
        fvis.append(np.mean([t.get("first_visible_splat_ms") or 0 for t in sub]) / 1000)
        waste.append(np.mean([t.get("wasted_prefetch_bytes", 0) for t in sub]) / 1e6)
    xi = np.arange(len(labs2))
    ax.bar(xi, fvis, 0.4, label="first_visible (s)")
    ax2 = ax.twinx()
    ax2.bar(xi + 0.4, waste, 0.4, color="#AA3377", alpha=0.6, label="wasted MB")
    ax.set_xticks(xi + 0.2)
    ax.set_xticklabels(labs2, fontsize=8)
    ax.set_title("Fig 3.4 — QoE vs waste")
    fig.tight_layout()
    fig.savefig(OUT / "fig_3_4_first_visible_waste.pdf")
    fig.savefig(OUT / "fig_3_4_first_visible_waste.png", dpi=200)
    plt.close(fig)

    # 3.5 gap B3 vs B4
    m3 = agg(trials, delivery, "B3_vrc_single", "deadline_miss_ratio_50ms")[0] * 100
    m4 = agg(trials, delivery, "B4_oracle_prefetch", "deadline_miss_ratio_50ms")[0] * 100
    fig, ax = plt.subplots(figsize=(3.2, 2.5))
    ax.bar([0, 1], [m3, m4], color=[COLORS[3], COLORS[4]])
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["B3", "B4*"])
    ax.set_ylabel("miss50 %")
    ax.set_title(f"Fig 3.5 — oracle gap ({m4 - m3:+.1f} pp)")
    fig.tight_layout()
    fig.savefig(OUT / "fig_3_5_oracle_gap.pdf")
    fig.savefig(OUT / "fig_3_5_oracle_gap.png", dpi=200)
    plt.close(fig)
    return True


def main():
    batch = Path(sys.argv[1].split("=", 1)[1])
    trials = load_trials(batch)
    if not trials:
        print("no trials")
        return

    for delivery in ("origin_server", "remote_server"):
        if not any(t.get("delivery_key") == delivery for t in trials):
            continue
        suffix = "origin" if delivery == "origin_server" else "remote"
        labs, m50, m100 = [], [], []
        useful, ratio = [], []
        for bid, lab in zip(BASELINES, LABELS):
            v50, n = agg(trials, delivery, bid, "deadline_miss_ratio_50ms")
            if n == 0:
                continue
            labs.append(lab)
            m50.append(v50 * 100)
            m100.append(agg(trials, delivery, bid, "deadline_miss_ratio_100ms")[0] * 100)
            useful.append(agg(trials, delivery, bid, "useful_chunks_before_demand")[0])
            ratio.append(agg(trials, delivery, bid, "useful_bytes_ratio")[0])

        write_svg_bar(OUT / f"fig_3_1_deadline_miss_{suffix}.svg", f"Fig 3.1 {delivery}", labs, [m50, m100], "miss %", ["+50ms", "+100ms"])
        write_svg_bar(OUT / f"fig_3_2_useful_{suffix}.svg", f"Fig 3.2 {delivery}", labs, [useful], "chunks")

        series = []
        for bid, color, lab in [("B0_on_demand", COLORS[0], "B0"), ("B3_vrc_single", COLORS[3], "B3")]:
            sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery and t.get("hard_gate_passed")]
            if sub and sub[0].get("visible_splat_timeline"):
                tl = sub[0]["visible_splat_timeline"]
                series.append((lab, [(p["t"] / 1000, p["visible_splat_count"]) for p in tl], color))
        write_svg_line(OUT / f"fig_3_3_visible_{suffix}.svg", f"Fig 3.3 {delivery}", series)

    if try_matplotlib_figures(batch, trials, "origin_server"):
        print(f"matplotlib PDF/PNG -> {OUT}")
    else:
        for svg in OUT.glob("fig_3_*.svg"):
            png = svg.with_suffix(".png")
            if svg_to_png(svg, png):
                print(f"png: {png}")
        print(f"SVG figures -> {OUT} (install matplotlib for PDF)")


if __name__ == "__main__":
    main()
