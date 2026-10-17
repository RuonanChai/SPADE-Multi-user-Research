import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Output paths
pdf_path = "ready_cold_start_teaser.pdf"
png_path = "ready_cold_start_teaser.png"

# Data
methods = ["Default\nSpark 2.0", "READY", "Oracle"]
miss100 = [99.5, 65.1, 69.7]
first_visible_s = [7.1106, 3.3523, 8.4998]
useful_before = [0, 119, 94]

# Style
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 8.5,
    "axes.titlesize": 9,
    "axes.labelsize": 8.5,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
})

colors = ["#7F7F7F", "#0072B2", "#E69F00"]

fig, axes = plt.subplots(1, 3, figsize=(7.0, 2.2), constrained_layout=True)

# (a) Deadline miss
ax = axes[0]
bars = ax.bar(methods, miss100, color=colors, edgecolor="none")
ax.set_ylabel("Deadline miss (%)")
ax.set_title("(a) 100 ms deadline miss")
ax.set_ylim(0, 110)
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
for bar, val in zip(bars, miss100):
    ax.text(bar.get_x() + bar.get_width() / 2, val + 2.5, f"{val:.1f}",
            ha="center", va="bottom", fontsize=7)

# (b) First visible latency
ax = axes[1]
bars = ax.bar(methods, first_visible_s, color=colors, edgecolor="none")
ax.set_ylabel("First visible (s)")
ax.set_title("(b) First visible latency")
ax.set_ylim(0, 9.5)
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
for bar, val in zip(bars, first_visible_s):
    ax.text(bar.get_x() + bar.get_width() / 2, val + 0.2, f"{val:.2f}",
            ha="center", va="bottom", fontsize=7)

# (c) Ready before demand
ax = axes[2]
bars = ax.bar(methods, useful_before, color=colors, edgecolor="none")
ax.set_ylabel("Useful chunks")
ax.set_title("(c) Ready before demand")
ax.set_ylim(0, 140)
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
for bar, val in zip(bars, useful_before):
    ax.text(bar.get_x() + bar.get_width() / 2, val + 3, f"{val:.0f}",
            ha="center", va="bottom", fontsize=7)

fig.savefig(pdf_path, bbox_inches="tight", facecolor="white")
fig.savefig(png_path, dpi=300, bbox_inches="tight", facecolor="white")
plt.close(fig)
