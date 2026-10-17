import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

pdf_path = "background_pipeline.pdf"
png_path = "background_pipeline.png"
svg_path = "background_pipeline.svg"

fig = plt.figure(figsize=(23.0, 5.9), facecolor="white")
ax = fig.add_axes([0.02, 0.08, 0.96, 0.86])
ax.set_xlim(0, 21.5)
ax.set_ylim(0, 4.7)
ax.axis("off")

colors = {
    "camera": ("#F2F2F2", "#666666"),
    "pager": ("#EAEAEA", "#666666"),
    "request": ("#DCEEFF", "#1F77B4"),
    "network": ("#E7F2FB", "#3A7FB0"),
    "parse": ("#E8ECFB", "#4C72B0"),
    "ready": ("#E3F3E7", "#1B9E77"),
    "visible": ("#F6EFDB", "#A07A12"),
}

node_font = 27
gap_font = 36
formula_font = 27
legend_font = 27
text_color = "black"
gap_color = "#F78024"

nodes = [
    ("Camera\nmotion", 0.10, 2.00, 2.20, 1.08, *colors["camera"]),
    ("Spark pager\ndemand", 2.65, 2.00, 2.75, 1.08, *colors["pager"]),
    ("HTTP Range\nrequest", 5.80, 2.00, 2.75, 1.08, *colors["request"]),
    ("Network\ncompletion", 8.95, 2.00, 2.75, 1.08, *colors["network"]),
    ("Parse + GPU\npreparation", 12.10, 2.00, 3.35, 1.08, *colors["parse"]),
    ("Render-ready\nchunk", 15.90, 2.00, 2.75, 1.08, *colors["ready"]),
    ("Visible\ngeometry", 19.35, 2.00, 1.775, 1.08, *colors["visible"]),
]

for label, x, y, w, h, fc, ec in nodes:
    patch = FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02,rounding_size=0.08",
        linewidth=1.85, edgecolor=ec, facecolor=fc
    )
    ax.add_patch(patch)
    ax.text(x + w/2, y + h/2, label, ha="center", va="center",
            fontsize=node_font, color=text_color)

for i in range(len(nodes)-1):
    _, x1, y1, w1, h1, *_ = nodes[i]
    _, x2, y2, w2, h2, *_ = nodes[i+1]
    ax.annotate(
        "", xy=(x2-0.10, y2+h2/2), xytext=(x1+w1+0.10, y1+h1/2),
        arrowprops=dict(arrowstyle="-|>", lw=1.75, color="#555555", shrinkA=0, shrinkB=0)
    )

x_start = 2.78
x_end = 18.62
y_br = 3.92
cap = 0.46
ax.plot([x_start, x_end], [y_br, y_br], linestyle=(0, (4, 3)), color=gap_color, linewidth=2.25)
ax.plot([x_start, x_start], [y_br, y_br-cap], linestyle=(0, (4, 3)), color=gap_color, linewidth=2.25)
ax.plot([x_end, x_end], [y_br, y_br-cap], linestyle=(0, (4, 3)), color=gap_color, linewidth=2.25)
ax.text((x_start+x_end)/2, y_br+0.20, "readiness gap",
        color=gap_color, ha="center", va="bottom", fontsize=gap_font, fontweight="bold")

formula = r'On-time if $t_{\mathrm{r}}(c)-t_{\mathrm{d}}(c)\leq\Delta$'
ax.text(
    10.45, 1.02, formula, ha="center", va="center", fontsize=formula_font, color=text_color,
    bbox=dict(boxstyle="round,pad=0.28,rounding_size=0.08",
              facecolor="white", edgecolor="#B8B8B8", linewidth=1.05)
)

legend = [
    ("Spark state", "#F2F2F2", "#666666"),
    ("Requesting", "#DCEEFF", "#1F77B4"),
    ("Delivery", "#E7F2FB", "#3A7FB0"),
    ("Preparation", "#E8ECFB", "#4C72B0"),
    ("Ready", "#E3F3E7", "#1B9E77"),
    ("Visible output", "#F6EFDB", "#A07A12"),
]
x_positions = [0.25, 3.30, 6.85, 10.10, 14.15, 16.85]
leg_y = 0.12

for (label, fc, ec), x in zip(legend, x_positions):
    box = FancyBboxPatch(
        (x, leg_y), 0.28, 0.20,
        boxstyle="round,pad=0.01,rounding_size=0.02",
        linewidth=1.0, edgecolor=ec, facecolor=fc
    )
    ax.add_patch(box)
    ax.text(x + 0.38, leg_y + 0.10, label, va="center", ha="left",
            fontsize=legend_font, color=text_color)

fig.savefig(pdf_path, bbox_inches="tight", facecolor="white", pad_inches=0.08)
fig.savefig(png_path, dpi=300, bbox_inches="tight", facecolor="white", pad_inches=0.08)
fig.savefig(svg_path, bbox_inches="tight", facecolor="white", pad_inches=0.08)
plt.close(fig)
