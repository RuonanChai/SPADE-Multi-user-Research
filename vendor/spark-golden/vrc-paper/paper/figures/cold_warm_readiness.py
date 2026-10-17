import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

pdf_path = "cold_warm_readiness_default_spark2_v3.pdf"
png_path = "cold_warm_readiness_default_spark2_v3.png"

trials = ["t0\ncold", "t1\nwarm", "t2\nwarm"]
default_spark_miss = [99.5, 60.2, 49.6]
ready_miss = [65.1, 56.6, 65.9]
default_spark_useful = [0, 140, 178]
ready_useful = [119, 134, 109]

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

gray = "#7F7F7F"
blue = "#0072B2"

fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.4), constrained_layout=True)

ax = axes[0]
ax.plot(trials, default_spark_miss, marker="o", linestyle="--", color=gray,
        linewidth=1.6, markersize=4, label="Default Spark 2.0")
ax.plot(trials, ready_miss, marker="o", linestyle="-", color=blue,
        linewidth=1.8, markersize=4, label="READY")
ax.set_ylim(0, 110)
ax.set_ylabel("Deadline miss (%)")
ax.set_title("(a) Readiness deadline miss")
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.legend(loc="upper center", ncol=2, frameon=False, handlelength=2.4)

default_miss_offsets = {0: (0, 5), 1: (0, 5), 2: (0, -13)}
ready_miss_offsets = {0: (-4, -11), 1: (0, -11), 2: (0, 8)}

for i, (x, y) in enumerate(zip(trials, default_spark_miss)):
    dx, dy = default_miss_offsets[i]
    ax.annotate(f"{y:.1f}", (x, y), textcoords="offset points", xytext=(dx, dy),
                ha="center", color=gray, fontsize=7)
for i, (x, y) in enumerate(zip(trials, ready_miss)):
    dx, dy = ready_miss_offsets[i]
    ax.annotate(f"{y:.1f}", (x, y), textcoords="offset points", xytext=(dx, dy),
                ha="center", color=blue, fontsize=7)

ax = axes[1]
ax.plot(trials, default_spark_useful, marker="o", linestyle="--", color=gray,
        linewidth=1.6, markersize=4, label="Default Spark 2.0")
ax.plot(trials, ready_useful, marker="o", linestyle="-", color=blue,
        linewidth=1.8, markersize=4, label="READY")
ax.set_ylim(0, 200)
ax.set_ylabel("Useful chunks before demand")
ax.set_title("(b) Ready before demand")
ax.grid(axis="y", alpha=0.25, linewidth=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

default_useful_offsets = {0: (0, 5), 1: (0, 5), 2: (0, 5)}
ready_useful_offsets = {0: (-2, -11), 1: (0, -11), 2: (0, -11)}

for i, (x, y) in enumerate(zip(trials, default_spark_useful)):
    dx, dy = default_useful_offsets[i]
    ax.annotate(f"{y:.0f}", (x, y), textcoords="offset points", xytext=(dx, dy),
                ha="center", color=gray, fontsize=7)
for i, (x, y) in enumerate(zip(trials, ready_useful)):
    dx, dy = ready_useful_offsets[i]
    ax.annotate(f"{y:.0f}", (x, y), textcoords="offset points", xytext=(dx, dy),
                ha="center", color=blue, fontsize=7)

fig.savefig(pdf_path, bbox_inches="tight", facecolor="white")
fig.savefig(png_path, dpi=300, bbox_inches="tight", facecolor="white")
plt.close(fig)
