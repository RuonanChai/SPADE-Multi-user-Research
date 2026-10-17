#!/usr/bin/env python3
"""
Generate publication-quality figures for READY paper evaluation.
Uses scientific color palette (colorblind-safe) and ACM/IEEE formatting.

Output: PDF figures in overleaf/figures/
"""

import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# Scientific color palette (colorblind-safe, Nature/SIGCOMM style)
COLORS = {
    'Spark-OD':    '#4C72B0',  # steel blue
    'Naive-PF':    '#8DA0CB',  # light blue
    'PRoGS-style': '#66C2A5',  # teal
    'SGSS-style':  '#FC8D62',  # coral
    'READY-P':     '#E78AC3',  # pink
    'READY-E':     '#A6D854',  # lime (will show as degraded)
    'READY-G':     '#FFD92F',  # gold (will show as degraded)
    'READY':       '#E41A1C',  # red (proposed system)
    'Oracle':      '#999999',  # gray (upper bound)
}

# Shorter display names for figures
SHORT_NAMES = {
    'Spark-OD': 'Spark-OD',
    'Naive-PF': 'Naive-PF',
    'PRoGS-style': 'PRoGS',
    'SGSS-style': 'SGSS',
    'READY-P': 'READY-P',
    'READY-E': 'READY-E',
    'READY-G': 'READY-G',
    'READY': 'READY',
    'Oracle': 'Oracle',
}

# Figure style
plt.rcParams.update({
    'font.family': 'serif',
    'font.serif': ['Times New Roman', 'DejaVu Serif'],
    'font.size': 9,
    'axes.labelsize': 10,
    'axes.titlesize': 10,
    'xtick.labelsize': 8,
    'ytick.labelsize': 8,
    'legend.fontsize': 8,
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'savefig.pad_inches': 0.02,
    'axes.linewidth': 0.8,
    'grid.linewidth': 0.4,
    'lines.linewidth': 1.5,
    'patch.linewidth': 0.5,
})


def load_trial_data(trial_dir):
    """Load all trial JSONs from a directory."""
    trials = []
    for f in sorted(Path(trial_dir).glob('*.json')):
        with open(f) as fp:
            trials.append(json.load(fp))
    return trials


def group_by_baseline(trials):
    """Group trials by baseline_name, compute median."""
    grouped = {}
    for t in trials:
        b = t['baseline_name']
        if b not in grouped:
            grouped[b] = []
        grouped[b].append(t)
    return grouped


def median(values):
    """Compute median of a list, filtering None/NaN."""
    v = sorted([x for x in values if x is not None and np.isfinite(x)])
    if not v:
        return 0
    return v[len(v) // 2]


def compute_stats(grouped):
    """Compute median stats per baseline."""
    stats = {}
    for b, trials in grouped.items():
        stats[b] = {
            'q5s': median([t.get('quality_at_5s', 0) for t in trials]),
            'q10s': median([t.get('quality_at_10s', 0) for t in trials]),
            't1m': median([t.get('time_to_1M_visible_splats_ms', 0) for t in trials]),
            'blank': median([t.get('blank_ratio', 0) for t in trials]),
            'fv': median([t.get('first_visible_splat_ms', 0) for t in trials]),
            'tp': median([t.get('throughput_Mbps', 0) for t in trials]),
            'fps': median([t.get('measure_fps', 0) for t in trials]),
            'chunks': median([t.get('completed_chunks', 0) for t in trials]),
            'n': len(trials),
        }
    return stats


def fig_main_comparison(stats, output_dir):
    """
    Figure: Main comparison bar chart (4 primary metrics).
    Layout: 2x2 subplots, grouped bars.
    """
    # Order for display
    order = ['Spark-OD', 'Naive-PF', 'PRoGS-style', 'SGSS-style', 'READY-P', 'READY', 'Oracle']
    # Map baseline names (handle PRoGS/SGSS naming)
    name_map = {}
    for b in stats:
        if 'PRoGS' in b:
            name_map[b] = 'PRoGS-style'
        elif 'SGSS' in b:
            name_map[b] = 'SGSS-style'
        else:
            name_map[b] = b

    # Rekey stats
    mapped_stats = {}
    for b, s in stats.items():
        key = name_map.get(b, b)
        mapped_stats[key] = s

    # Filter to available baselines in order
    baselines = [b for b in order if b in mapped_stats]
    n = len(baselines)

    fig, axes = plt.subplots(2, 2, figsize=(7, 4.5))

    metrics = [
        ('q5s', 'Quality@5s (K splats)', 1000, True),
        ('t1m', 'Time-to-1M (seconds)', 1000, False),
        ('blank', 'Blank Ratio (%)', 0.01, False),
        ('fv', 'First Visible (seconds)', 1000, False),
    ]

    for idx, (key, ylabel, divisor, higher_better) in enumerate(metrics):
        ax = axes[idx // 2][idx % 2]
        values = [mapped_stats[b][key] / divisor for b in baselines]
        colors = [COLORS.get(b, '#333333') for b in baselines]
        labels = [SHORT_NAMES.get(b, b) for b in baselines]

        bars = ax.bar(range(n), values, color=colors, edgecolor='white', linewidth=0.5)

        # Highlight READY bar
        for i, b in enumerate(baselines):
            if b == 'READY':
                bars[i].set_edgecolor('#E41A1C')
                bars[i].set_linewidth(1.5)

        ax.set_xticks(range(n))
        ax.set_xticklabels(labels, rotation=35, ha='right', fontsize=7)
        ax.set_ylabel(ylabel)
        ax.grid(axis='y', alpha=0.3, linestyle='--')
        ax.set_axisbelow(True)

        # Add value labels on top
        for i, v in enumerate(values):
            ax.text(i, v * 1.02, f'{v:.1f}' if v < 100 else f'{v:.0f}',
                    ha='center', va='bottom', fontsize=6.5)

    plt.tight_layout(pad=0.5)
    out_path = os.path.join(output_dir, 'eval_main_comparison.pdf')
    plt.savefig(out_path)
    plt.close()
    print(f'  Saved: {out_path}')


def fig_ablation(stats, output_dir):
    """
    Figure: Ablation bar chart showing READY variants.
    Highlights that READY-E and READY-G degrade on remote.
    """
    order = ['Spark-OD', 'READY-P', 'READY-E', 'READY-G', 'READY']
    name_map = {}
    for b in stats:
        name_map[b] = b

    mapped_stats = {name_map.get(b, b): s for b, s in stats.items()}
    baselines = [b for b in order if b in mapped_stats]
    n = len(baselines)

    fig, axes = plt.subplots(1, 2, figsize=(6, 2.8))

    # Left: quality@5s
    ax = axes[0]
    values = [mapped_stats[b]['q5s'] / 1000 for b in baselines]
    colors = [COLORS.get(b, '#333333') for b in baselines]
    labels = [SHORT_NAMES.get(b, b) for b in baselines]
    bars = ax.bar(range(n), values, color=colors, edgecolor='white', linewidth=0.5)
    ax.set_xticks(range(n))
    ax.set_xticklabels(labels, rotation=25, ha='right', fontsize=8)
    ax.set_ylabel('Quality@5s (K splats)')
    ax.grid(axis='y', alpha=0.3, linestyle='--')
    ax.set_axisbelow(True)
    # Spark-OD reference line
    spark_val = mapped_stats.get('Spark-OD', {}).get('q5s', 0) / 1000
    ax.axhline(spark_val, color=COLORS['Spark-OD'], linestyle='--', linewidth=0.8, alpha=0.7)
    ax.text(n - 0.5, spark_val * 1.02, 'Spark-OD', fontsize=7, color=COLORS['Spark-OD'], ha='right')

    # Right: time-to-1M
    ax = axes[1]
    values = [mapped_stats[b]['t1m'] / 1000 for b in baselines]
    bars = ax.bar(range(n), values, color=colors, edgecolor='white', linewidth=0.5)
    ax.set_xticks(range(n))
    ax.set_xticklabels(labels, rotation=25, ha='right', fontsize=8)
    ax.set_ylabel('Time-to-1M (seconds)')
    ax.grid(axis='y', alpha=0.3, linestyle='--')
    ax.set_axisbelow(True)
    spark_val = mapped_stats.get('Spark-OD', {}).get('t1m', 0) / 1000
    ax.axhline(spark_val, color=COLORS['Spark-OD'], linestyle='--', linewidth=0.8, alpha=0.7)
    ax.text(n - 0.5, spark_val * 1.02, 'Spark-OD', fontsize=7, color=COLORS['Spark-OD'], ha='right')

    plt.tight_layout(pad=0.5)
    out_path = os.path.join(output_dir, 'eval_ablation.pdf')
    plt.savefig(out_path)
    plt.close()
    print(f'  Saved: {out_path}')


def fig_visible_timeline(grouped, output_dir):
    """
    Figure: Visible splat count over time (quality growth curve).
    Shows how READY fills the scene faster than baselines.
    """
    fig, ax = plt.subplots(1, 1, figsize=(4.5, 3))

    plot_order = ['Spark-OD', 'PRoGS', 'SGSS', 'READY-P', 'READY', 'Oracle']
    name_map = {}
    for b in grouped:
        if 'PRoGS' in b:
            name_map[b] = 'PRoGS'
        elif 'SGSS' in b:
            name_map[b] = 'SGSS'
        else:
            name_map[b] = b

    # For each baseline, pick the median trial (by q5s) and plot its timeline
    for b_orig, trials in grouped.items():
        b = name_map.get(b_orig, b_orig)
        if b not in plot_order:
            continue

        # Pick median trial
        sorted_trials = sorted(trials, key=lambda t: t.get('quality_at_5s', 0))
        median_trial = sorted_trials[len(sorted_trials) // 2]

        timeline = median_trial.get('visible_splat_timeline', [])
        if not timeline:
            continue

        times = [e.get('t', 0) / 1000 for e in timeline]  # convert to seconds
        counts = [e.get('visible_splat_count', 0) / 1_000_000 for e in timeline]  # convert to M

        color_key = b + '-style' if b in ('PRoGS', 'SGSS') else b
        color = COLORS.get(color_key, COLORS.get(b, '#333333'))
        linestyle = '--' if b == 'Oracle' else '-'
        linewidth = 2.0 if b == 'READY' else 1.2

        ax.plot(times, counts, color=color, linestyle=linestyle,
                linewidth=linewidth, label=SHORT_NAMES.get(b, b))

    # Reference lines
    ax.axhline(1.0, color='gray', linestyle=':', linewidth=0.6, alpha=0.5)
    ax.text(0.5, 1.02, '1M splats', fontsize=7, color='gray', alpha=0.7)

    ax.set_xlabel('Time (seconds)')
    ax.set_ylabel('Visible Splats (millions)')
    ax.set_xlim(0, 40)
    ax.set_ylim(0, None)
    ax.legend(loc='lower right', framealpha=0.9, edgecolor='none')
    ax.grid(alpha=0.2, linestyle='--')
    ax.set_axisbelow(True)

    plt.tight_layout(pad=0.3)
    out_path = os.path.join(output_dir, 'eval_visible_timeline.pdf')
    plt.savefig(out_path)
    plt.close()
    print(f'  Saved: {out_path}')


def fig_paired_delta(grouped, output_dir):
    """
    Figure: Paired delta (READY - Spark-OD) per trial.
    Shows consistency of improvement.
    """
    ready_trials = sorted(grouped.get('READY', []), key=lambda t: t.get('trial_index', 0))
    spark_trials = sorted(grouped.get('Spark-OD', []), key=lambda t: t.get('trial_index', 0))

    if not ready_trials or not spark_trials:
        print('  Skipping paired delta: missing READY or Spark-OD trials')
        return

    n_pairs = min(len(ready_trials), len(spark_trials))

    fig, axes = plt.subplots(1, 4, figsize=(7, 2.2))

    metrics = [
        ('quality_at_5s', 'ΔQ@5s (K)', 1000),
        ('time_to_1M_visible_splats_ms', 'ΔT-1M (s)', 1000),
        ('blank_ratio', 'ΔBlank (pp)', 0.01),
        ('first_visible_splat_ms', 'ΔFV (s)', 1000),
    ]

    for idx, (key, ylabel, divisor) in enumerate(metrics):
        ax = axes[idx]
        deltas = []
        for i in range(n_pairs):
            r_val = ready_trials[i].get(key, 0)
            s_val = spark_trials[i].get(key, 0)
            if key == 'quality_at_5s':
                delta = (r_val - s_val) / divisor  # positive = READY better
            else:
                delta = (s_val - r_val) / divisor  # positive = READY better (lower is better)
            deltas.append(delta)

        colors_bar = ['#2ca02c' if d > 0 else '#d62728' for d in deltas]
        ax.bar(range(n_pairs), deltas, color=colors_bar, edgecolor='white', linewidth=0.5)
        ax.axhline(0, color='black', linewidth=0.5)
        ax.set_xticks(range(n_pairs))
        ax.set_xticklabels([f't{i}' for i in range(n_pairs)], fontsize=7)
        ax.set_ylabel(ylabel, fontsize=8)
        ax.grid(axis='y', alpha=0.2, linestyle='--')
        ax.set_axisbelow(True)

    plt.tight_layout(pad=0.4)
    out_path = os.path.join(output_dir, 'eval_paired_delta.pdf')
    plt.savefig(out_path)
    plt.close()
    print(f'  Saved: {out_path}')


def fig_throughput_fps(stats, output_dir):
    """
    Figure: Throughput and FPS comparison (diagnostic).
    """
    order = ['Spark-OD', 'Naive-PF', 'PRoGS-style', 'SGSS-style', 'READY-P', 'READY', 'Oracle']
    name_map = {}
    for b in stats:
        if 'PRoGS' in b:
            name_map[b] = 'PRoGS-style'
        elif 'SGSS' in b:
            name_map[b] = 'SGSS-style'
        else:
            name_map[b] = b

    mapped_stats = {name_map.get(b, b): s for b, s in stats.items()}
    baselines = [b for b in order if b in mapped_stats]
    n = len(baselines)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(6, 2.5))

    # Throughput
    values = [mapped_stats[b]['tp'] for b in baselines]
    colors = [COLORS.get(b, '#333333') for b in baselines]
    labels = [SHORT_NAMES.get(b, b) for b in baselines]
    ax1.bar(range(n), values, color=colors, edgecolor='white', linewidth=0.5)
    ax1.set_xticks(range(n))
    ax1.set_xticklabels(labels, rotation=35, ha='right', fontsize=7)
    ax1.set_ylabel('Throughput (Mbps)')
    ax1.grid(axis='y', alpha=0.3, linestyle='--')
    ax1.set_axisbelow(True)

    # FPS
    values = [mapped_stats[b]['fps'] for b in baselines]
    ax2.bar(range(n), values, color=colors, edgecolor='white', linewidth=0.5)
    ax2.axhline(60, color='red', linestyle='--', linewidth=0.6, alpha=0.5)
    ax2.text(n - 0.5, 62, '60 FPS', fontsize=7, color='red', alpha=0.7, ha='right')
    ax2.set_xticks(range(n))
    ax2.set_xticklabels(labels, rotation=35, ha='right', fontsize=7)
    ax2.set_ylabel('Frame Rate (FPS)')
    ax2.grid(axis='y', alpha=0.3, linestyle='--')
    ax2.set_axisbelow(True)

    plt.tight_layout(pad=0.5)
    out_path = os.path.join(output_dir, 'eval_throughput_fps.pdf')
    plt.savefig(out_path)
    plt.close()
    print(f'  Saved: {out_path}')


def main():
    # Paths
    script_dir = Path(__file__).parent
    project_root = script_dir.parent.parent
    trial_dir = project_root / 'paper_materials' / 'ready_single_user_v1' / 'runs' / '2026-05-28T03-03-28' / 'per_trial_json'
    output_dir = project_root.parent / 'spark-main-writing' / 'overleaf' / 'figures'

    if not trial_dir.exists():
        print(f'ERROR: Trial directory not found: {trial_dir}')
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f'Loading trials from: {trial_dir}')
    trials = load_trial_data(trial_dir)
    print(f'  Loaded {len(trials)} trials')

    grouped = group_by_baseline(trials)
    print(f'  Baselines: {list(grouped.keys())}')

    stats = compute_stats(grouped)

    print('\nGenerating figures...')
    fig_main_comparison(stats, str(output_dir))
    fig_ablation(stats, str(output_dir))
    fig_visible_timeline(grouped, str(output_dir))
    fig_paired_delta(grouped, str(output_dir))
    fig_throughput_fps(stats, str(output_dir))

    print('\nDone. All figures saved to:', output_dir)


if __name__ == '__main__':
    main()
