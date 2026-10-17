"""Generate proactive single-user figures A/B/C (PDF via matplotlib, else SVG fallback)."""
import json
import sys
from pathlib import Path

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    HAS_MPL = True
    plt.rcParams.update({"font.size": 8, "figure.dpi": 300})
except ImportError:
    HAS_MPL = False
    np = None

BASELINES = ["B0_on_demand", "B1_naive_prefetch", "B2_priority_prefetch", "B3_vrc_single", "B4_oracle_prefetch"]
LABELS = ["B0", "B1", "B2", "B3", "B4*"]
COLORS = ["#4477AA", "#66CCEE", "#228833", "#CCBB44", "#AA3377"]


def load_trials(batch_dir: Path):
    rows = []
    for p in (batch_dir / "per_trial_json").glob("*.json"):
        rows.append(json.loads(p.read_text(encoding="utf-8")))
    return [r for r in rows if r.get("hard_gate_passed")]


def agg(trials, delivery, field):
    xs = [
        t[field]
        for t in trials
        if t.get("delivery_key") == delivery and t.get(field) is not None
    ]
    return float(np.mean(xs)) if xs else 0.0


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


def write_svg_bar(path, title, labels, series, ylabel):
    w, h = 400, 260
    n = len(labels)
    bw = 28
    gap = 48
    ox, oy = 50, 220
    maxv = max(max(s) for s in series) or 1
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">',
        f'<text x="10" y="16" font-size="12">{title}</text>',
    ]
    for si, vals in enumerate(series):
        for i, v in enumerate(vals):
            bh = int((v / maxv) * 160)
            x = ox + i * gap + si * (bw // 2)
            y = oy - bh
            lines.append(f'<rect x="{x}" y="{y}" width="{bw//2}" height="{bh}" fill="#4477AA" opacity="{0.9 - si*0.4}"/>')
    for i, lab in enumerate(labels):
        lines.append(f'<text x="{ox + i*gap}" y="{oy+14}" font-size="9">{lab}</text>')
    lines.append(f'<text x="4" y="{oy//2}" font-size="9" transform="rotate(-90 12,{oy//2})">{ylabel}</text>')
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    batch = Path(sys.argv[1].split("=", 1)[1] if len(sys.argv) > 1 else ".")
    out = Path("vrc-paper/paper/figures/proactive_single_user")
    out.mkdir(parents=True, exist_ok=True)
    trials = load_trials(batch)
    if not trials:
        print("No gate-passed trials — skip figures")
        return

    delivery = "origin_server"
    if not any(t.get("delivery_key") == delivery for t in trials):
        delivery = trials[0].get("delivery_key", "origin_server")

    if not HAS_MPL:
        m50, m100, labels_used = [], [], []
        useful, ratio = [], []
        for bid, lab in zip(BASELINES, LABELS):
            sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery]
            if not sub:
                continue
            labels_used.append(lab)
            m50.append(_mean([t.get("deadline_miss_ratio_50ms", 0) * 100 for t in sub]))
            m100.append(_mean([t.get("deadline_miss_ratio_100ms", 0) * 100 for t in sub]))
            useful.append(_mean([t.get("useful_chunks_before_demand", 0) for t in sub]))
            ratio.append(_mean([t.get("useful_bytes_ratio", 0) for t in sub]))
        write_svg_bar(out / "fig_a_deadline_miss.svg", f"Figure A — {delivery}", labels_used, [m50, m100], "miss %")
        write_svg_bar(out / "fig_b_useful_chunks.svg", "Figure B — useful chunks", labels_used, [useful], "count")
        print(f"matplotlib unavailable — wrote SVG fallbacks to {out}")
        return

    # Figure A
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    x = np.arange(len(BASELINES))
    w = 0.35
    m50 = [agg(trials, delivery, "deadline_miss_ratio_50ms") * 100 for _ in BASELINES]
    m100 = [agg(trials, delivery, "deadline_miss_ratio_100ms") * 100 for _ in BASELINES]
    for i, bid in enumerate(BASELINES):
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery]
        if sub:
            m50[i] = np.mean([t.get("deadline_miss_ratio_50ms", 0) for t in sub]) * 100
            m100[i] = np.mean([t.get("deadline_miss_ratio_100ms", 0) for t in sub]) * 100
    ax.bar(x - w / 2, m50, w, label="miss +50ms", color=COLORS, alpha=0.9)
    ax.bar(x + w / 2, m100, w, label="miss +100ms", color=COLORS, alpha=0.45)
    ax.set_xticks(x)
    ax.set_xticklabels(LABELS, fontsize=7)
    ax.set_ylabel("Deadline miss ratio (%)")
    ax.set_title(f"Figure A — {delivery}")
    ax.legend(fontsize=6)
    fig.tight_layout()
    fig.savefig(out / "fig_a_deadline_miss.pdf")
    plt.close(fig)

    # Figure B
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    useful = []
    ratio = []
    for bid in BASELINES:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery]
        useful.append(np.mean([t.get("useful_chunks_before_demand", 0) or 0 for t in sub]) if sub else 0)
        ratio.append(np.mean([t.get("useful_bytes_ratio", 0) or 0 for t in sub]) if sub else 0)
    ax2 = ax.twinx()
    ax.bar(x, useful, 0.55, color=COLORS, alpha=0.85)
    ax2.plot(x, ratio, "k--o", markersize=4, label="useful_bytes/total")
    ax.set_xticks(x)
    ax.set_xticklabels(LABELS, fontsize=7)
    ax.set_ylabel("Useful chunks before demand")
    ax2.set_ylabel("Useful / total bytes")
    ax.set_title("Figure B — usefulness vs waste")
    fig.tight_layout()
    fig.savefig(out / "fig_b_useful_chunks.pdf")
    plt.close(fig)

    # Figure C — visible splat timeline (first trial B0/B3 with timeline)
    fig, ax = plt.subplots(figsize=(4, 2.5))
    for bid, color, label in [
        ("B0_on_demand", COLORS[0], "B0"),
        ("B3_vrc_single", COLORS[3], "B3"),
    ]:
        sub = [t for t in trials if t.get("baseline_id") == bid and t.get("delivery_key") == delivery]
        if not sub:
            continue
        tl = sub[0].get("visible_splat_timeline") or []
        if not tl:
            continue
        ts = [p["t"] / 1000 for p in tl]
        vs = [p["visible_splat_count"] for p in tl]
        ax.plot(ts, vs, color=color, label=label, linewidth=1.2)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Visible splat count")
    ax.set_title("Figure C — visibility timeline")
    ax.legend(fontsize=6)
    fig.tight_layout()
    fig.savefig(out / "fig_c_visible_splats.pdf")
    plt.close(fig)

    print(f"Figures written to {out}")


if __name__ == "__main__":
    main()
