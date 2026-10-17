"""
Generate motivation figures for VRC paper (PDF via matplotlib).
Run: wsl python3 /mnt/d/Program/spark-main/spark-main/vrc-paper/paper/figures/gen_motivation_figures.py
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update({
    'font.size': 8,
    'font.family': 'sans-serif',
    'axes.linewidth': 0.6,
    'xtick.major.width': 0.5,
    'ytick.major.width': 0.5,
    'lines.linewidth': 1.2,
    'figure.dpi': 300,
    'pdf.fonttype': 42,
    'ps.fonttype': 42,
})

COLORS = {'local': '#4477AA', 'origin': '#228833', 'remote': '#EE6677'}
OUT = '/mnt/d/Program/spark-main/spark-main/vrc-paper/paper/figures'

# ============================================================
# Figure 1: Three-tier chunk completion + p95 latency
# ============================================================
fig, ax1 = plt.subplots(figsize=(3.33, 2.5))

scenarios = ['Normal\nstreaming', 'Fetch-\nonly', 'Pure\nrender']
tiers = ['Local baseline', 'Origin server', 'Remote server']
colors = [COLORS['local'], COLORS['origin'], COLORS['remote']]

# Data: [local, origin, remote] x [normal, fetch-only, pure-render]
chunks = np.array([
    [230, 140, 0],    # local
    [277, 140, 0],    # origin (3-trial mean)
    [17, 5, 0],       # remote
])
p95_normal = np.array([30, 499, 15872])  # normal streaming chunk p95

x = np.arange(3)
width = 0.22

for i, (tier, color) in enumerate(zip(tiers, colors)):
    offset = (i - 1) * width
    bars = ax1.bar(x + offset, chunks[i], width * 0.9,
                   color=color, alpha=0.85, label=tier,
                   edgecolor='white', linewidth=0.3)
    # Value labels on bars > 0
    for bar, val in zip(bars, chunks[i]):
        if val > 0:
            ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 5,
                     str(val), ha='center', va='bottom', fontsize=6)

ax1.set_xticks(x)
ax1.set_xticklabels(scenarios, fontsize=7)
ax1.set_ylabel('Chunks completed (40 s)', fontsize=7.5)
ax1.set_ylim(0, 330)
ax1.legend(fontsize=6.5, loc='upper right', framealpha=0.9, edgecolor='none')
ax1.spines['top'].set_visible(False)
ax1.spines['right'].set_visible(False)

# Secondary axis: chunk p95 (log) for normal streaming
ax2 = ax1.twinx()
x_p95 = x[:1]  # Only plot for normal streaming group
x_markers = np.array([-width, 0, width])  # positions within normal streaming group
ax2.plot(x_markers, p95_normal, 's-', color='#333333', markersize=4, linewidth=1.0, zorder=5)
ax2.set_ylabel('Chunk p95 (ms, log)', fontsize=7.5, color='#444')
ax2.set_yscale('log')
ax2.set_ylim(10, 50000)
ax2.tick_params(axis='y', labelcolor='#444', labelsize=6.5)
ax2.spines['top'].set_visible(False)

# p95 value labels
for xp, val in zip(x_markers, p95_normal):
    label = f'{val:,}' if val < 1000 else f'{val/1000:.0f}k'
    ax2.annotate(f'{label} ms', (xp, val), textcoords='offset points',
                 xytext=(0, 8), ha='center', fontsize=5.5, color='#333')

# "fast but empty" annotation
ax1.annotate('"fast but empty"', xy=(width, 17), xytext=(0.7, 120),
             fontsize=6.5, fontstyle='italic', color=COLORS['remote'],
             arrowprops=dict(arrowstyle='->', color=COLORS['remote'], lw=0.8))

plt.tight_layout(pad=0.4)
fig.savefig(f'{OUT}/motivation_bottleneck.pdf', bbox_inches='tight')
fig.savefig(f'{OUT}/motivation_bottleneck.png', bbox_inches='tight', dpi=200)
print('Figure 1 saved: motivation_bottleneck.pdf')
plt.close()

# ============================================================
# Figure 2: Cold-start + Multi-user (two panels)
# ============================================================
fig, (ax_a, ax_b) = plt.subplots(1, 2, figsize=(6.5, 2.0), gridspec_kw={'width_ratios': [1, 1.2]})

# Panel A: Cold-start horizontal bars
cold_labels = ['Local baseline', 'Origin server', 'Remote server']
cold_ms = [1440, 1178, 6703]
cold_colors = [COLORS['local'], COLORS['origin'], COLORS['remote']]

bars_a = ax_a.barh(cold_labels, cold_ms, height=0.5, color=cold_colors, alpha=0.85,
                   edgecolor='white', linewidth=0.3)
ax_a.set_xlabel('Time to first visible splat (ms)', fontsize=7.5)
ax_a.set_title('(a) Cold-start latency', fontsize=8, fontweight='bold', loc='left')
ax_a.axvline(2000, color='gray', linestyle=':', linewidth=0.7, alpha=0.6)
ax_a.text(2100, 2.35, '2 s', fontsize=6, color='gray')
for bar, val in zip(bars_a, cold_ms):
    ax_a.text(bar.get_width() + 100, bar.get_y() + bar.get_height()/2,
              f'{val:,} ms', va='center', fontsize=6.5)
ax_a.set_xlim(0, 8500)
ax_a.spines['top'].set_visible(False)
ax_a.spines['right'].set_visible(False)
# 5.7x annotation
ax_a.annotate('5.7×', xy=(6703, 2), xytext=(5500, 1.2),
              fontsize=7, color=COLORS['remote'], fontstyle='italic',
              arrowprops=dict(arrowstyle='->', color=COLORS['remote'], lw=0.7))

# Panel B: Multi-user (4-user trace-based sequential)
labels_b = ['Local\nbaseline', 'Remote\nserver']
chunks_b = [288, 12]
p95_b = [80, 21141]
colors_b = [COLORS['local'], COLORS['remote']]

x_b = np.arange(2)
w = 0.3
bars_chunk = ax_b.bar(x_b - w/2, chunks_b, w, color=colors_b, alpha=0.85, label='Chunks/client')
ax_b.set_ylabel('Chunks / client (40 s)', fontsize=7.5)
ax_b.set_ylim(0, 350)
ax_b.set_xticks(x_b)
ax_b.set_xticklabels(labels_b, fontsize=7)
ax_b.set_title('(b) 4-user trace-based sequential', fontsize=8, fontweight='bold', loc='left')

ax_b2 = ax_b.twinx()
bars_p95 = ax_b2.bar(x_b + w/2, p95_b, w, color=colors_b, alpha=0.3, edgecolor=colors_b,
                     linewidth=0.8, label='Chunk p95 (ms)')
ax_b2.set_ylabel('Chunk p95 (ms)', fontsize=7.5, color='#555')
ax_b2.set_ylim(0, 25000)
ax_b2.tick_params(axis='y', labelcolor='#555', labelsize=6.5)

# Value labels
for bar, val in zip(bars_chunk, chunks_b):
    ax_b.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 5,
              str(val), ha='center', fontsize=6.5)
for bar, val in zip(bars_p95, p95_b):
    label = f'{val:,}' if val < 1000 else f'{val/1000:.0f}k'
    ax_b2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 300,
               f'{label} ms', ha='center', fontsize=6, color='#555')

# Amplification annotation
ax_b.text(0.5, 310, '24× fewer chunks\n265× higher latency',
          fontsize=6.5, ha='center', color=COLORS['remote'], fontstyle='italic',
          transform=ax_b.get_xaxis_transform())

ax_b.spines['top'].set_visible(False)
ax_b2.spines['top'].set_visible(False)

# Legend
lines1, labels1 = ax_b.get_legend_handles_labels()
lines2, labels2 = ax_b2.get_legend_handles_labels()
ax_b.legend(lines1 + lines2, labels1 + labels2, fontsize=6, loc='upper center', framealpha=0.9)

plt.subplots_adjust(left=0.12, right=0.88, wspace=0.45)
fig.savefig(f'{OUT}/motivation_coldstart_multiuser.pdf', bbox_inches='tight')
print('Figure 2 saved: motivation_coldstart_multiuser.pdf')
plt.close()

print('All figures generated as PDF.')
