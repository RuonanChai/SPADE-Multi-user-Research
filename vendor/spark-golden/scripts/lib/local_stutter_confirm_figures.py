#!/usr/bin/env python3
"""Generate confirm batch figures from confirm_summary_by_arm.csv"""
import csv
import sys
from pathlib import Path

import matplotlib.pyplot as plt


def load_by_arm(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append({k: (float(v) if v not in ("", None) and k not in ("arm_id", "arm_name") else v) for k, v in r.items()})
    return rows


def main(batch_dir):
    batch = Path(batch_dir)
    by_arm_path = batch / "confirm_summary_by_arm.csv"
    rows = load_by_arm(by_arm_path)
    fig_dir = batch / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    arms = [r["arm_id"] for r in rows]
    fps = [float(r["measure_fps_mean"] or 0) for r in rows]
    p95 = [float(r["frame_p95_mean"] or 0) for r in rows]
    f33 = [float(r["frames_over_33ms_mean"] or 0) for r in rows]
    f100 = [float(r["frames_over_100ms_mean"] or 0) for r in rows]

    def bar_plot(y, ylabel, title, fname):
        plt.figure(figsize=(10, 5))
        plt.bar(range(len(arms)), y, color="#2563eb")
        plt.xticks(range(len(arms)), arms, rotation=25, ha="right")
        plt.ylabel(ylabel)
        plt.title(title)
        plt.tight_layout()
        plt.savefig(fig_dir / fname, dpi=150)
        plt.close()

    bar_plot(fps, "measure_fps (mean)", "Measure FPS by arm", "fps_by_arm.png")
    bar_plot(p95, "frame_p95 (ms)", "Frame p95 by arm", "frame_p95_by_arm.png")
    bar_plot(f33, ">33ms frames (mean)", "Long frames >33ms by arm", "long_frames_by_arm.png")

    focus = ["E3_normal", "E4_normal_dpr05", "E8_render_only_pure", "E9_static_pure_render", "E10_moving_pure_render"]
    fr = [r for r in rows if r["arm_id"] in focus]
    plt.figure(figsize=(10, 5))
    plt.bar(range(len(fr)), [float(r["measure_fps_mean"] or 0) for r in fr], color="#16a34a")
    plt.xticks(range(len(fr)), [r["arm_id"].replace("_", "\n") for r in fr], rotation=0, fontsize=8)
    plt.ylabel("measure_fps")
    plt.title("E3 vs E4 vs E8 vs E9 vs E10")
    plt.tight_layout()
    plt.savefig(fig_dir / "e3_vs_e4_vs_e8_vs_e9_vs_e10.png", dpi=150)
    plt.close()

    print(f"figures written to {fig_dir}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
