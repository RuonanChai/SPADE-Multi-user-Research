#!/usr/bin/env python3
"""
论文用 B/C/D repeatability 汇总：读 260425_repeat10（或任意 root 下 rep-* run），输出 CSV/MD/PDF。
依赖：matplotlib（PDF 图），可选 pip install numpy（略快）；无 numpy 时仍可用。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timezone

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    _HAS_MPL = True
except ModuleNotFoundError:
    _HAS_MPL = False
    plt = None


def pctl(xs: list[float], p: float) -> float | None:
    ys = sorted(x for x in xs if x is not None and math.isfinite(x))
    n = len(ys)
    if not n:
        return None
    i = min(n - 1, max(0, math.ceil(p / 100.0 * n) - 1))
    return ys[i]


def mad_scores(vals: list[float]) -> list[float]:
    m = statistics.median(vals)
    return [abs(v - m) for v in vals]


def mad_median(vals: list[float]) -> float:
    ms = mad_scores(vals)
    return statistics.median(ms) if ms else 0.0


def outlier_mad_high(vals: list[float], v: float, k: float = 3.0) -> bool:
    """Outlier 若 v > median + k * MAD（单向上尾，用于 p99/延迟类）。"""
    if not vals or not math.isfinite(v):
        return False
    med = statistics.median(vals)
    m = mad_median(vals)
    if m == 0:
        return v > med
    return v > med + k * m


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2 or n != len(ys):
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    dxa = sum((a - mx) ** 2 for a in xs)
    dyb = sum((b - my) ** 2 for b in ys)
    if dxa == 0 or dyb == 0:
        return None
    return num / (math.sqrt(dxa) * math.sqrt(dyb))


def _avg_ranks(values: list[float]) -> list[float]:
    n = len(values)
    idx = list(range(n))
    idx.sort(key=lambda i: values[i])
    ranks = [0.0] * n
    t = 0
    while t < n:
        t2 = t
        v = values[idx[t]]
        while t2 < n and values[idx[t2]] == v:
            t2 += 1
        r = (t + t2 + 1) / 2.0
        for j in range(t, t2):
            ranks[idx[j]] = r
        t = t2
    return ranks


def spearman(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2 or n != len(ys):
        return None
    rx = _avg_ranks(list(xs))
    ry = _avg_ranks(list(ys))
    return pearson([float(x) for x in rx], [float(x) for x in ry])


def stat_block(vals: list[float]) -> dict:
    ys = [v for v in vals if v is not None and math.isfinite(v)]
    if not ys:
        return {k: None for k in ("n", "mean", "median", "std", "p25", "p75", "p95", "p99")}
    return {
        "n": len(ys),
        "mean": float(statistics.fmean(ys)),
        "median": float(statistics.median(ys)),
        "std": float(statistics.stdev(ys)) if len(ys) > 1 else 0.0,
        "p25": pctl(ys, 25),
        "p75": pctl(ys, 75),
        "p95": pctl(ys, 95),
        "p99": pctl(ys, 99),
    }


BOUNDS = (64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024)
BUCKET_LABELS = ("<=64KB", "64KB-256KB", "256KB-1MB", "1MB-4MB", ">4MB")


def bucket_of(b: int) -> str:
    if b <= BOUNDS[0]:
        return BUCKET_LABELS[0]
    if b <= BOUNDS[1]:
        return BUCKET_LABELS[1]
    if b <= BOUNDS[2]:
        return BUCKET_LABELS[2]
    if b <= BOUNDS[3]:
        return BUCKET_LABELS[3]
    return BUCKET_LABELS[4]


def is_debug_url(u: str) -> bool:
    return "debug-scene-probe" in (u or "")


def read_jsonl(p: Path) -> list[dict]:
    out = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def service_vs_bytes_points(root: Path, run_id: str) -> list[tuple[float, float]]:
    """与 analysis/analyze-service-vs-bytes.mjs 的过滤方式对齐：request_complete + 匹配 run_id。"""
    p = root / run_id / "proxy" / "proxy.jsonl"
    if not p.is_file():
        return []
    rows = read_jsonl(p)
    pts = []
    for row in rows:
        if row.get("event") and row.get("event") != "request_complete":
            continue
        if str(row.get("run_id", "")) and str(row.get("run_id", "")) != str(run_id):
            continue
        u = str(row.get("url", "") or "")
        if is_debug_url(u):
            continue
        ub = float(row.get("upstream_bytes", 0) or 0)
        ts = row.get("phase_timestamps", {}) or {}
        t0 = row.get("upstream_start_ts", ts.get("upstream_fetch_started", 0))
        t1 = row.get("upstream_end_ts", ts.get("upstream_finished", 0))
        if t0 and t1:
            d = max(0.0, (float(t1) - float(t0)))
        else:
            continue
        if math.isfinite(ub) and math.isfinite(d) and d >= 0:
            pts.append((ub, d))
    return pts


def map_scenario(name: str) -> str:
    if "B-lockstep" in name:
        return "B-lockstep"
    if "C-nearcohort" in name:
        return "C-nearcohort"
    if "D-divergent" in name:
        return "D-divergent"
    return "unknown"


def load_run_row(root: Path, run_id: str) -> dict:
    dsum = root / run_id / "summary" / "distributed-summary.json"
    brst = root / run_id / "summary" / "burst_queue.json"
    valf = root / run_id / "validate-run-coverage.json"
    row: dict = {"run_id": run_id, "scenario": "unknown", "valid": None}
    if dsum.is_file():
        data = json.loads(dsum.read_text(encoding="utf-8"))
        r0 = (data.get("runs") or [{}])[0]
        row["scenario"] = r0.get("scenario", map_scenario(run_id))
        row["valid"] = not (r0.get("validity") or {}).get("run_invalid", False)
        t = (r0.get("totals") or {})
        row["B_client_agg"] = t.get("total_B_client_agg")
        row["B_unique"] = t.get("total_B_unique")
        row["B_upstream"] = t.get("total_B_upstream")
        row["proxy_line_bytes"] = t.get("upstream_bytes_total_proxy")
        lat = (r0.get("latency") or {})
        row["client_p95"] = lat.get("client_p95")
        row["client_p99"] = lat.get("client_p99")
        row["upstream_p95"] = lat.get("upstream_p95")
        row["upstream_p99"] = lat.get("upstream_p99")
    if brst.is_file():
        bj = json.loads(brst.read_text(encoding="utf-8"))
        br0 = (bj.get("runs") or [{}])[0]
        lb = (br0.get("latency_breakdown") or {})
        row["queue_p95"] = lb.get("queue_p95")
        row["service_p95"] = lb.get("service_p95")
        row["downstream_tail_p95"] = lb.get("downstream_tail_p95")
    if valf.is_file():
        v = json.loads(valf.read_text(encoding="utf-8"))
        row["validate_upstream_bytes_total"] = v.get("upstream_bytes_total")
    return row


def collect_browser_max(root: Path, run_id: str) -> dict | None:
    out = None
    for p in (root / run_id / "local").glob("client-*-summary.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for ent in data if isinstance(data, list) else [data]:
            d = (ent or {}).get("browser_frame_diag")
            if d:
                if out is None:
                    out = d
                else:
                    for k, v in d.items():
                        if isinstance(v, (int, float)) and (not out.get(k) or v > (out.get(k) or 0)):
                            out[k] = v
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True, help="如 260425_repeat10 目录")
    args = ap.parse_args()
    root: Path = args.root.resolve()
    out_dir = root
    fig_dir = out_dir / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    run_dirs = sorted(
        d for d in root.iterdir() if d.is_dir() and d.name.startswith("rep-")
    )
    if not run_dirs:
        print(f"No rep-* under {root}")
        return

    rows = [load_run_row(root, d.name) for d in run_dirs]
    for r in rows:
        r["browser_diag"] = collect_browser_max(root, r["run_id"])

    by_sce = defaultdict(list)
    for r in rows:
        by_sce[r["scenario"]].append(r)

    # —— MAD outliers per scenario
    def mark_outliers(scenario: str) -> set[str]:
        sub = by_sce.get(scenario, [])
        if not sub:
            return set()
        cp = [float(r["client_p99"]) for r in sub if r.get("client_p99") is not None]
        up = [float(r["upstream_p99"]) for r in sub if r.get("upstream_p99") is not None]
        sp = [float(r["service_p95"]) for r in sub if r.get("service_p95") is not None]
        bad = set()
        for r in sub:
            rid = r["run_id"]
            c99 = r.get("client_p99")
            u99 = r.get("upstream_p99")
            s95 = r.get("service_p95")
            o = False
            if c99 is not None and cp and outlier_mad_high(cp, float(c99)):
                o = True
            if u99 is not None and up and outlier_mad_high(up, float(u99)):
                o = True
            if s95 is not None and sp and outlier_mad_high(sp, float(s95)):
                o = True
            if o:
                bad.add(rid)
        return bad

    all_out = set()
    for sce in by_sce:
        all_out |= mark_outliers(sce)

    # —— service vs bytes all
    all_pts: list[tuple[float, float]] = []
    for r in rows:
        all_pts.extend(service_vs_bytes_points(root, r["run_id"]))

    xs = [a for a, _ in all_pts]
    ys = [b for _, b in all_pts]
    p_all = pearson(xs, ys) if len(xs) > 1 else None
    s_all = spearman(xs, ys) if len(xs) > 1 else None

    # bucket stats
    buck: dict[str, list[float]] = {lb: [] for lb in BUCKET_LABELS}
    for a, b in all_pts:
        buck[bucket_of(int(a))].append(b)

    def bucket_rows():
        out = []
        for lb in BUCKET_LABELS:
            vals = buck[lb]
            st = stat_block([float(x) for x in vals]) if vals else {k: None for k in ("n", "mean", "p95")}
            out.append(
                {
                    "bucket": lb,
                    "n": st.get("n") or 0,
                    "mean": st.get("mean"),
                    "p95_service_delay": st.get("p95"),
                }
            )
        return out

    bucket_table = bucket_rows()

    # —— CSV
    sum_csv = out_dir / "paper_bcd_summary.csv"
    with sum_csv.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "subset",
                "scenario",
                "metric",
                "n",
                "mean",
                "median",
                "std",
                "p25",
                "p75",
                "p95",
                "p99",
            ]
        )
        for subset_name, run_filter in (
            ("with_outlier", None),
            ("without_outlier", lambda rid: rid not in all_out),
        ):
            for sce, rlist in sorted(by_sce.items()):
                filt = rlist
                if run_filter:
                    filt = [r for r in rlist if run_filter(r["run_id"])]
                for metric in (
                    "client_p95",
                    "client_p99",
                    "upstream_p95",
                    "upstream_p99",
                    "queue_p95",
                    "service_p95",
                ):
                    st = stat_block(
                        [float(r[metric]) for r in filt if r.get(metric) is not None]
                    )
                    w.writerow(
                        [
                            subset_name,
                            sce,
                            metric,
                            st["n"],
                            st["mean"],
                            st["median"],
                            st["std"],
                            st["p25"],
                            st["p75"],
                            st["p95"],
                            st["p99"],
                        ]
                    )
        w.writerow(
            [
                "global",
                "all",
                "service_vs_bytes_spearman",
                len(xs) if xs else 0,
                s_all,
                "",
                "",
                "",
                "",
                "",
                "",
            ]
        )
        w.writerow(
            [
                "global",
                "all",
                "service_vs_bytes_pearson",
                len(xs) if xs else 0,
                p_all,
                "",
                "",
                "",
                "",
                "",
                "",
            ]
        )

    # —— paper_bcd_summary.md
    md1 = out_dir / "paper_bcd_summary.md"
    lines: list[str] = [
        "# B/C/D repeatability paper summary",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Root: `{root}`",
        "",
        "## Pearson / Spearman (service delay vs `upstream_bytes`, proxy `request_complete` rows)",
        "",
        f"- n points: {len(all_pts)}",
        f"- Pearson: {p_all}",
        f"- Spearman: {s_all}",
        "",
        "See `paper_bcd_summary.csv` for per-metric n/mean/median/std/p25/p75/p95/p99 (with_outlier and without_outlier).",
        "",
    ]
    for label, use_filter in [
        (
            "### With all runs (outliers included)",
            False,
        ),
        (
            "### Without MAD-flagged outlier runs (union of client_p99, upstream_p99, service_p95 upper-tail)",
            True,
        ),
    ]:
        lines.append(label)
        lines.append("")
        lines.append("| scenario | n | client_p99 median | service_p95 median |")
        lines.append("| --- | --- | --- | --- |")
        for sce, rlist0 in sorted(by_sce.items()):
            rlist = [r for r in rlist0 if r["run_id"] not in all_out] if use_filter else rlist0
            c99v = [float(r["client_p99"]) for r in rlist if r.get("client_p99") is not None]
            s95v = [float(r["service_p95"]) for r in rlist if r.get("service_p95") is not None]
            c99m = float(statistics.median(c99v)) if c99v else None
            s95m = float(statistics.median(s95v)) if s95v else None
            lines.append(f"| {sce} | {len(rlist)} | {c99m} | {s95m} |")
        lines.append("")

    lines.append("## By size bucket (all runs merged; service = upstream end-start ms)")
    lines.append("")
    lines.append("| bucket | n | mean | p95 |")
    lines.append("| --- | --- | --- | --- |")
    for b in bucket_table:
        lines.append(
            f"| {b['bucket']} | {b['n']} | {b['mean']} | {b['p95_service_delay']} |"
        )
    lines.append("")
    md1.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # —— outliers
    omd = out_dir / "paper_bcd_outliers.md"
    ol = [f"# Outliers (median + 3*MAD, upper tail)", f"", f"## Flagged run_ids: {', '.join(sorted(all_out)) or 'none'}", f""]
    for sce in sorted(by_sce):
        oset = mark_outliers(sce)
        if oset:
            ol.append(f"### {sce}")
            for rid in sorted(oset):
                r = next(x for x in rows if x["run_id"] == rid)
                ol.append(
                    f"- **{rid}**: client_p99={r.get('client_p99')}, upstream_p99={r.get('upstream_p99')}, service_p95={r.get('service_p95')}"
                )
            ol.append("")

    # browser tail candidates: client_p99 > 1.5 * upstream_p99
    ol.append("## browser-side tail candidates (client_p99 >> upstream_p99)")
    ol.append("")
    ol.append("Rule: `client_p99 > 1.5 * upstream_p99` and/or large longtask/raf counts when `SPARK_BROWSER_FRAME_DIAG=1`.")
    ol.append("")
    for r in rows:
        c99 = r.get("client_p99")
        u99 = r.get("upstream_p99")
        if c99 is not None and u99 is not None and float(c99) > 1.5 * float(u99):
            bd = r.get("browser_diag") or {}
            ol.append(
                f"- **{r['run_id']}** ({r['scenario']}): ratio={float(c99) / max(float(u99), 1e-6):.2f}, longtask_count={bd.get('longtask_count')}, longFrame_gt50={bd.get('long_frame_count_gt_50ms')}"
            )
    omd.write_text("\n".join(ol) + "\n", encoding="utf-8")

    # —— metric consistency
    cons = out_dir / "paper_bcd_metric_consistency.md"
    t0 = rows[0]
    bc = t0.get("B_client_agg")
    bu = t0.get("B_unique")
    bup = t0.get("B_upstream")
    plb = t0.get("proxy_line_bytes")
    vup = t0.get("validate_upstream_bytes_total")
    ctext = f"""# Metric consistency and naming

- **`B_client_agg` / `B_unique` / `B_upstream`**: 来自 `distributed-summary.json` 的逻辑对象/页级计数字段（`totals`），为 **instrumentation 定义下的逻辑量**，在 B/C/D 场景下应 **一致**（同 workload/页大小假设）。
- **`upstream_bytes_total_proxy`（脚本中记为 `proxy_line_bytes`）**: 代理上观测到的 **线路上行字节**（`totals`），通常 **大于** 逻辑 `B_unique`/`B_upstream` 的压缩口径，与 wire 重传/响应头等有关；与 **`validate-run-coverage.json` 的 `upstream_bytes_total`** 应接近、但不必逐字节相同（见二者定义差异与 CDP/代理对账方式）。
- **`B_upstream` 与 `proxy_line_bytes` 非同一指标**：前者是逻辑/页对象层面的 `B_` 系字节下界口径；后者是 **wire** 行级累计。

## 本次样本检查（首 run 对照）

- B_client_agg: {bc}
- B_unique: {bu}
- B_upstream: {bup}
- upstream_bytes_total_proxy: {plb}
- validate upstream_bytes_total: {vup}
"""
    same_bc = all(
        r.get("B_client_agg") == bc and r.get("B_unique") == bu and r.get("B_upstream") == bup
        for r in rows
    )
    ctext += f"\n- 全 run 的 B 系三项与首 run 完全一致: **{same_bc}**"
    cons.write_text(ctext, encoding="utf-8")

    # —— figures
    if _HAS_MPL:
        plt.figure(figsize=(7, 4))
        sces = list(sorted(by_sce.keys()))
        data_sp = [
            [float(r["service_p95"]) for r in by_sce[s] if r.get("service_p95") is not None] for s in sces
        ]
        plt.boxplot(data_sp, labels=sces, showfliers=True)
        plt.ylabel("service_p95 (ms)")
        plt.title("Service p95 by scenario")
        plt.xticks(rotation=15, ha="right")
        plt.tight_layout()
        plt.savefig(fig_dir / "service_p95_by_scenario.pdf")
        plt.close()

        plt.figure(figsize=(7, 4))
        data_c99 = [ [float(r["client_p99"]) for r in by_sce[s] if r.get("client_p99") is not None] for s in sces ]
        plt.boxplot(data_c99, labels=sces, showfliers=True)
        plt.ylabel("client_p99 (ms)")
        plt.title("Client p99 by scenario")
        plt.xticks(rotation=15, ha="right")
        plt.tight_layout()
        plt.savefig(fig_dir / "client_p99_by_scenario.pdf")
        plt.close()

        qv = []
        sv = []
        for r in rows:
            if r.get("queue_p95") is not None and r.get("service_p95") is not None:
                qv.append(float(r["queue_p95"]))
                sv.append(float(r["service_p95"]))
        if qv:
            plt.figure(figsize=(4, 4))
            plt.scatter(qv, sv, alpha=0.6)
            plt.xlabel("queue_p95 (ms)")
            plt.ylabel("service_p95 (ms)")
            plt.title("Queue vs service p95 (per run)")
            plt.tight_layout()
            plt.savefig(fig_dir / "queue_vs_service_p95.pdf")
            plt.close()

        if all_pts:
            plt.figure(figsize=(5, 4))
            plt.scatter(xs, ys, s=4, alpha=0.4)
            plt.xlabel("upstream_bytes (proxy log)")
            plt.ylabel("service_time_ms (upstream_end - upstream_start)")
            plt.title("Service vs bytes (all runs)")
            plt.tight_layout()
            plt.savefig(fig_dir / "service_vs_bytes_scatter.pdf")
            plt.close()

        if buck:
            plt.figure(figsize=(7, 4))
            bs = BUCKET_LABELS
            mus = [statistics.fmean(buck[b]) if buck[b] else 0 for b in bs]
            plt.bar(bs, mus)
            plt.ylabel("mean service delay (ms)")
            plt.xticks(rotation=20, ha="right")
            plt.title("Mean service by size bucket (all points)")
            plt.tight_layout()
            plt.savefig(fig_dir / "service_vs_bytes_bucket.pdf")
            plt.close()
    else:
        note = (
            fig_dir / "README_no_matplotlib.txt"
        )
        note.write_text(
            "Install matplotlib to generate PDF figures: pip install matplotlib\n"
            f"Re-run: python scripts/analyze_bcd_repeatability_paper.py --root {root.name}\n",
            encoding="utf-8",
        )

    # —— paper_readiness_decision.md
    n_runs = len(rows)
    n_valid = len([r for r in rows if r.get("valid") is not False])
    can = "no"
    if n_runs >= 3 and n_valid == n_runs and same_bc:
        can = "partial" if n_runs < 30 else "yes"
    decision = f"""# Paper readiness decision

- **Can be used in paper: {can}**
- **Run count**: {n_runs} (expected 30 for full repeat10)
- **All rows valid (distributed-summary)**: {n_valid == n_runs}
- **B metric consistency (logical totals)**: {same_bc}

## Which claims are supported
- 重复 runs 在相同 B 系对象总量下展开（若 `same=True`）；
- 服务时间与字节的相关性可引用 Pearson/Spearman（见 `paper_bcd_summary.md` 与 `service_vs_bytes.json` 若已生成）；
- 代理解耦（queue 远小于 service 时）可引用 `queue_vs_service_p95` 与 burst 输出。

## Which claims are not supported without more runs
- 场景间**稳定排序**的统计显著性需更多重复或置信区间/假设检验，本脚本**未**做 p-value；
- 单次极端 client_p99 若占主导，**不得**用均值代替「典型尾延迟」表述。

## Main bottleneck interpretation (data-driven)
- 以 `service_p95` 与 `proxy_line_bytes` 的关联和代理分解为准：若 `service` 方差 ≫ `queue` 方差，则瓶颈更接近 **到源站/传输的服务时间**；若 browser tail candidate 多，则**浏览器侧/主线程**可解释部分 client 尾部。

## Outlier explanation
- 上尾采用 median + 3*MAD（各指标在场景内分别计算后取并集标红），见 `paper_bcd_outliers.md`。

## Minimum safe wording for the paper
- 「在固定 workload 与同一测量管线**下，我们观察到** B/C/D 的延迟分布**形态差异**，对象级计数字量**稳定**于 …」
- 「**代理分解显示** 排队时延的 p95 显著低于**服务/上游** 段时延（以本仓库 burst 与 summary 为证）。」

## Unsafe wording
- 避免无统计检验的「D 一定比 B 慢**最多**」；
- 避免将单次 **client_p99 尖刺** 概括为「**渲染瓶颈**」而不引用 browser 侧诊断；
- 避免混淆 `B_upstream`（逻辑）与 `proxy_line_bytes`（wire）。

---
Generated: {datetime.now(timezone.utc).isoformat()}
"""
    (out_dir / "paper_readiness_decision.md").write_text(decision, encoding="utf-8")
    print(f"Wrote outputs under {out_dir}")


if __name__ == "__main__":
    main()
