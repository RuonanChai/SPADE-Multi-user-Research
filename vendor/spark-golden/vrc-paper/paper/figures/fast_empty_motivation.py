import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# Output paths
pdf_path = "fast_empty_motivation.pdf"
png_path = "fast_empty_motivation.png"

# Data
delivery = ["Local", "Origin", "Remote"]
p95_ms = [30, 499, 15872]
fps = [86.9, 88.3, 156.3]
chunks = [230, 277, 17]

# Style
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 8.5,
    "axes.titlesize": 9,
    "axes.labelsize": 8.5,
    "legend.fontsize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
})

orange = "#D55E00"
blue = "#0072B2"
gray = "#7F7F7F"

x = np.arange(len(delivery))

fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.5), constrained_layout=True)

# (a) Per-chunk latency
ax = axes[0]
bars = ax.bar(x, p95_ms, color=orange, edgecolor="none", width=0.55)
ax.set_yscale("log")
ax.set_xticks(x)
ax.set_xticklabels(delivery)
ax.set_ylabel("Chunk network p95 (ms)")
ax.set_title("(a) Per-chunk network latency")
ax.grid(axis="y", alpha=0.25, linewidth=0.6, which="both")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

labels = ["30", "499", "15,872"]
for bar, val, label in zip(bars, p95_ms, labels):
    ax.text(bar.get_x() + bar.get_width() / 2, val * 1.18, label,
            ha="center", va="bottom", fontsize=7)

# (b) Throughput vs frame rate
ax = axes[1]
bars = ax.bar(x, chunks, color=blue, edgecolor="none", width=0.55, alpha=0.9)
ax.set_xticks(x)
ax.set_xticklabels(delivery)
ax.set_ylabel("Completed chunks (40 s)")
ax.set_title("(b) Throughput vs frame rate")
ax.set_ylim(0, 320)
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

for bar, val in zip(bars, chunks):
    ax.text(bar.get_x() + bar.get_width() / 2, val + 6, f"{val}",
            ha="center", va="bottom", fontsize=7)

ax2 = ax.twinx()
ax2.plot(x, fps, marker="o", color=gray, linewidth=1.8, markersize=4, label="Measure FPS")
ax2.set_ylabel("Measure FPS")
ax2.set_ylim(75, 165)
ax2.spines["top"].set_visible(False)

# Annotation
ax.annotate("fast but empty:\nhigh FPS, only 17 chunks",
            xy=(2, chunks[2]), xycoords="data",
            xytext=(1.45, 105), textcoords="data",
            arrowprops=dict(arrowstyle="->", color=orange, lw=1.0),
            ha="left", va="center", fontsize=7, color=orange)

# Legend for FPS line
line = ax2.lines[0]
ax2.legend([line], ["Measure FPS"], loc="upper left", frameon=False)

fig.savefig(pdf_path, bbox_inches="tight", facecolor="white")
fig.savefig(png_path, dpi=300, bbox_inches="tight", facecolor="white")
plt.close(fig)
