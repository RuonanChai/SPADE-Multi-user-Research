#!/usr/bin/env python3
"""
根因分析：从各 run 的 proxy.jsonl 拆解 TTFB / body transfer / throughput，并与场景、对象大小桶、
client p99 对照。兼容仅含旧字段的日志（由时间戳推导 ttfb_ms 等）。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    _HAS_MPL = True
except ModuleNotFoundError:
    _HAS_MPL = False
    plt = None

SCENARIO_RE = re.compile(r"rep-(B-lockstep|C-nearcohort|D-divergent)-")


def is_debug_url(u: str) -> bool:
    return "debug-scene-probe" in (u or "")


def scenario_from_run_id(rid: str | None) -> str | None:
    if not rid or rid == "unknown":
        return None
    m = SCENARIO_RE.search(str(rid))
    return m.group(1) if m else None


def pctl(xs: list[float], p: float) -> float | None:
    ys = sorted(x for x in xs if x is not None and math.isfinite(x))
    n = len(ys)
    if not n:
        return None
    i = min(n - 1, max(0, math.ceil(p / 100.0 * n) - 1))
    return ys[i]


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


def rank_avg(vals: list[float]) -> list[float]:
    n = len(vals)
    idx = list(range(n))
    idx.sort(key=lambda i: vals[i])
    ranks = [0.0] * n
    t = 0
    while t < n:
        t2 = t
        v = vals[idx[t]]
        while t2 < n and vals[idx[t2]] == v:
            t2 += 1
        r = (t + t2 + 1) / 2.0
        for j in range(t, t2):
            ranks[idx[j]] = r
        t = t2
    return ranks


def spearman(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    return pearson(rank_avg(list(xs)), rank_avg(list(ys)))


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


def parse_metrics(row: dict) -> dict | None:
    if row.get("event") != "request_complete":
        return None
    u = str(row.get("url", "") or "")
    if is_debug_url(u):
        return None
    rid = str(row.get("run_id", "") or "")
    if not rid or rid == "unknown":
        return None

    t0 = row.get("t_request_start_ms")
    t1 = row.get("t_first_byte_ms")
    t2 = row.get("t_last_byte_ms")
    if t0 is None:
        t0 = row.get("upstream_start_ts")
    if t1 is None:
        t1 = row.get("upstream_first_byte_ts")
    if t2 is None:
        t2 = row.get("upstream_end_ts")
    if t0 is None or t1 is None or t2 is None:
        ph = row.get("phase_timestamps") or {}
        t0 = t0 or ph.get("upstream_fetch_started")
        t1 = t1 or ph.get("upstream_first_byte")
        t2 = t2 or ph.get("upstream_finished")
    if t0 is None or t1 is None or t2 is None:
        return None

    t0, t1, t2 = float(t0), float(t1), float(t2)
    ttfb = row.get("ttfb_ms")
    btr = row.get("body_transfer_ms")
    svc = row.get("service_ms")
    if ttfb is None:
        ttfb = max(0.0, t1 - t0)
    if btr is None:
        btr = max(0.0, t2 - t1)
    if svc is None:
        svc = max(0.0, t2 - t0)
    ub = float(row.get("upstream_bytes", 0) or 0)
    eff = row.get("effective_mbps")
    if eff is None and btr and btr > 0:
        eff = (ub * 8.0) / float(btr) / 1000.0
    sc = row.get("scenario") or scenario_from_run_id(rid)
    path = row.get("pathname") or row.get("object_id")
    if not path:
        try:
            from urllib.parse import urlparse

            path = urlparse("http://x" + (u if u.startswith("/") else "/" + u)).path
        except Exception:
            path = u.split("?")[0] if u else ""
    return {
        "run_id": rid,
        "scenario": sc,
        "url": u,
        "pathname": path,
        "upstream_bytes": ub,
        "ttfb_ms": float(ttfb),
        "body_transfer_ms": float(btr),
        "service_ms": float(svc),
        "effective_mbps": float(eff) if eff is not None else None,
        "protocol_version": row.get("protocol_version"),
        "connection_reused": row.get("connection_reused"),
        "status_code": row.get("status_code", row.get("status")),
        "content_length_header": row.get("content_length_header"),
        "content_type_header": row.get("content_type_header"),
        "cache_headers": row.get("cache_headers") or {},
    }


def load_run_latencies(root: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for d in root.iterdir():
        if not d.is_dir() or not d.name.startswith("rep-"):
            continue
        p = d / "summary" / "distributed-summary.json"
        if not p.is_file():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        r0 = (data.get("runs") or [{}])[0]
        rid = r0.get("run_id") or d.name
        lat = r0.get("latency") or {}
        out[rid] = {
            "client_p99": lat.get("client_p99"),
            "upstream_p99": lat.get("upstream_p99"),
            "scenario": r0.get("scenario"),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True)
    args = ap.parse_args()
    root: Path = args.root.resolve()
    out_dir = root
    fig_dir = out_dir / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    has_proto = 0
    has_reuse = 0
    has_cache = 0
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not d.name.startswith("rep-"):
            continue
        pl = d / "proxy" / "proxy.jsonl"
        if not pl.is_file():
            continue
        for line in read_jsonl(pl):
            m = parse_metrics(line)
            if m:
                rows.append(m)
            if line.get("event") == "request_complete" and line.get("run_id") not in (None, "unknown"):
                if line.get("protocol_version"):
                    has_proto += 1
                if line.get("connection_reused") is not None:
                    has_reuse += 1
                if line.get("cache_headers"):
                    has_cache += 1

    run_lat = load_run_latencies(root)

    ttfb = [r["ttfb_ms"] for r in rows]
    btr = [r["body_transfer_ms"] for r in rows]
    svc = [r["service_ms"] for r in rows]
    ubs = [r["upstream_bytes"] for r in rows]

    def stat3(name: str, arr: list[float]) -> dict:
        return {
            "metric": name,
            "n": len(arr),
            "median": statistics.median(arr) if arr else None,
            "p95": pctl(arr, 95),
            "p99": pctl(arr, 99),
        }

    st_global = [stat3("ttfb_ms", ttfb), stat3("body_transfer_ms", btr), stat3("service_ms", svc)]

    p_t_u = pearson(ubs, ttfb)
    s_t_u = spearman(ubs, ttfb)
    p_b_u = pearson(ubs, btr)
    s_b_u = spearman(ubs, btr)

    share_ttfb = [r["ttfb_ms"] / r["service_ms"] if r["service_ms"] and r["service_ms"] > 0 else 0 for r in rows]
    share_bod = [r["body_transfer_ms"] / r["service_ms"] if r["service_ms"] and r["service_ms"] > 0 else 0 for r in rows]

    by_sc: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        sc = r["scenario"] or "unknown"
        by_sc[sc].append(r)

    # by scenario csv
    csv1 = out_dir / "upstream_root_cause_by_scenario.csv"
    with csv1.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "scenario",
                "n_req",
                "ttfb_median",
                "ttfb_p95",
                "body_transfer_median",
                "body_transfer_p95",
                "service_median",
                "service_p95",
                "median_ttfb_share_of_service",
                "median_body_share_of_service",
                "pearson_bytes_ttfb",
                "spearman_bytes_ttfb",
                "pearson_bytes_body",
                "spearman_bytes_body",
            ]
        )
        for sc in sorted(by_sc):
            sub = by_sc[sc]
            uu = [x["upstream_bytes"] for x in sub]
            tt = [x["ttfb_ms"] for x in sub]
            bb = [x["body_transfer_ms"] for x in sub]
            ss = [x["service_ms"] for x in sub]
            sh_t = [a / b for a, b in zip(tt, ss) if b and b > 0]
            sh_b = [a / b for a, b in zip(bb, ss) if b and b > 0]
            w.writerow(
                [
                    sc,
                    len(sub),
                    statistics.median(tt) if tt else None,
                    pctl(tt, 95),
                    statistics.median(bb) if bb else None,
                    pctl(bb, 95),
                    statistics.median(ss) if ss else None,
                    pctl(ss, 95),
                    statistics.median(sh_t) if sh_t else None,
                    statistics.median(sh_b) if sh_b else None,
                    pearson(uu, tt),
                    spearman(uu, tt),
                    pearson(uu, bb),
                    spearman(uu, bb),
                ]
            )

    # by bucket
    by_buck: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_buck[bucket_of(int(r["upstream_bytes"]))].append(r)

    csv2 = out_dir / "upstream_root_cause_by_size_bucket.csv"
    with csv2.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "size_bucket",
                "n",
                "ttfb_median",
                "ttfb_p95",
                "body_transfer_median",
                "body_transfer_p95",
                "service_median",
                "effective_mbps_median",
            ]
        )
        for bname in BUCKET_LABELS:
            sub = by_buck[bname]
            if not sub:
                w.writerow([bname, 0, "", "", "", "", "", ""])
                continue
            em = [r["effective_mbps"] for r in sub if r.get("effective_mbps") is not None]
            w.writerow(
                [
                    bname,
                    len(sub),
                    statistics.median([x["ttfb_ms"] for x in sub]),
                    pctl([x["ttfb_ms"] for x in sub], 95),
                    statistics.median([x["body_transfer_ms"] for x in sub]),
                    pctl([x["body_transfer_ms"] for x in sub], 95),
                    statistics.median([x["service_ms"] for x in sub]),
                    statistics.median(em) if em else None,
                ]
            )

    # outliers: high service on small object
    svc_p95 = pctl(svc, 95) or 0
    small_threshold = 64 * 1024
    ol: list[str] = []
    for r in rows:
        if r["upstream_bytes"] <= small_threshold and r["service_ms"] > svc_p95 * 0.5 and r["service_ms"] > 200:
            ol.append(
                f"- small (<64KB) high service: `{r['pathname'][:60]}...` service_ms={r['service_ms']:.1f} (global p95 service≈{svc_p95:.1f})"
            )
    for rid, L in run_lat.items():
        cp = L.get("client_p99")
        up = L.get("upstream_p99")
        if (
            cp is not None
            and up is not None
            and float(cp) > 1.5 * float(up)
        ):
            ol.append(
                f"- browser-side tail candidate run `{rid}`: client_p99={cp} >> upstream_p99={up}"
            )
    (out_dir / "upstream_root_cause_outliers.md").write_text(
        "# Upstream / tail outliers\n\n"
        + "\n".join(ol)
        + "\n",
        encoding="utf-8",
    )

    # logic flags for summary
    abs_p_b = abs(p_b_u or 0)
    abs_s_b = abs(s_b_u or 0)
    abs_p_t = abs(p_t_u or 0)
    abs_s_t = abs(s_t_u or 0)
    size_dom = bool(abs_p_b > 0.25 and abs_s_b > 0.4 and abs_p_t < 0.35 and abs_s_t < 0.5)
    small_ttfb_arr = [r["ttfb_ms"] for r in rows if r["upstream_bytes"] <= small_threshold]
    small_high_ttfb = pctl(small_ttfb_arr, 95) or 0.0
    _protocol_candidate = bool(
        (small_high_ttfb > 100)
        and (p_t_u is None or abs(p_t_u) < 0.25)
    )
    _bw_candidate = bool(p_b_u and abs(p_b_u) > 0.4)

    def _median(xs: list[float]) -> float:
        return float(statistics.median(xs)) if xs else 0.0

    med_sh_t = _median(share_ttfb)
    med_sh_b = _median(share_bod)

    summary_lines = [
        f"# Upstream service time root cause (proxy.jsonl)",
        f"",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Root: `{root}`",
        f"Request rows (request_complete, valid run_id, non-debug): **{len(rows)}**",
        f"",
        f"## 日志字段覆盖（相对新版 proxy）",
        f"- 含 `protocol_version` 的完成行: **{has_proto}**",
        f"- 含 `connection_reused` 的完成行: **{has_reuse}**",
        f"- 含 `cache_headers` 非空: **{has_cache}**",
        f"",
    ]
    if has_proto == 0:
        summary_lines += [
            "> **说明**：当前 `--root` 下日志多为**旧版** proxy 产物；`t_request_start` / 首末字节时间戳**已存在**（`upstream_start_ts` 等），"
            "故 **ttfb_ms / body_transfer_ms / service_ms 均由脚本推导**。"
            "若要 **protocol / connection / cache 响应头** 的逐请求字段，请用**新版** `proxy/instrumented-reverse-proxy.mjs` 再跑一次**单次**干跑。",
            f"",
        ]

    summary_lines += [
        f"## 全局 ttfb / body / service（ms）",
        f"",
        f"| metric | n | median | p95 | p99 |",
        f"| --- | --- | --- | --- | --- |",
    ]
    for s in st_global:
        md, p5, p9 = s.get("median"), s.get("p95"), s.get("p99")
        summary_lines.append(
            f"| {s['metric']} | {s['n']} | {md} | {p5} | {p9} |"
        )
    summary_lines += [
        f"",
        f"- **service 内 TTFB 中位占比**（ttfb_ms/service_ms）: {med_sh_t:.3f}",
        f"- **service 内 body 传输占比**（body_transfer_ms/service_ms）: {med_sh_b:.3f}",
        f"",
        f"## 相关性（`upstream_bytes` 为横轴）",
        f"",
        f"| pair | Pearson | Spearman |",
        f"| --- | --- | --- |",
        f"| bytes vs ttfb_ms | {p_t_u} | {s_t_u} |",
        f"| bytes vs body_transfer_ms | {p_b_u} | {s_b_u} |",
        f"",
        f"**解读（启发式，非形式检验）**：",
    ]
    if size_dom:
        summary_lines.append(
            "- 字节与 **body_transfer_ms** 相关更强、与 **ttfb_ms** 更弱 → 偏向 **对象体积/正文传输** 主导时延方差成分。"
        )
    else:
        summary_lines.append(
            "- 若 |ρ(bytes, body)| 明显高于 |ρ(bytes, ttfb)|，可支持 **传输段** 与体积的耦合；若两者都不弱，为 **混合**。"
        )
    if _protocol_candidate:
        summary_lines.append(
            f"- 小对象（≤64KB）的 TTFB p95 仍较高（~{small_high_ttfb:.0f} ms）→ **协议/源站/连接建立** 类开销候选；需结合新日志中的 `protocol_version` / `connection_reused`。"
        )
    if _bw_candidate:
        summary_lines.append(
            "- 字节与 body_transfer 强正相关 → 大对象上 **带宽/正文体传输** 是主要拉伸因素之一。"
        )
    summary_lines += [
        f"",
        f"## 论文用判断（Yes/No 级）",
        f"",
        f"- **Is it protocol dominated?** — **{ 'Unclear / mix' if not has_proto else 'See per-request protocol' }**（旧日志无逐条 protocol；小对象高 TTFB 提示**连接/源站/HTTP** 成分，但不足以单独署名为「协议」）。",
        f"- **Is it object-size / transfer (body) dominated?** — **{ 'Likely component' if size_dom or (abs_s_b and abs_s_b > 0.5) else 'Partially' }**（Spearman bytes–body = {s_b_u}，bytes–ttfb = {s_t_u}）。",
        f"- **Is it TTFB dominated?** — **{ 'No as sole story' if med_sh_b > med_sh_t else 'Mixed' }**（中位 ttfb 占 service 比例 {med_sh_t:.2f}，body 占 {med_sh_b:.2f}）。",
        f"- **Is it body-transfer dominated?** — **{ 'Substantial' if med_sh_b > 0.4 else 'Mixed' }** 按中位占比。",
        f"- **Is it browser-side dominated?** — **No at proxy layer**；若 `upstream_root_cause_outliers.md` 中 client_p99>>upstream_p99，则**端到端**存在 **browser tail amplification** 候选项。",
        f"",
        f"## Safe claims for the paper",
        f"- 代理侧可客观陈述：**TTFB 与正文体传输在 service_ms 中的分解比例**、**字节与两段的 Spearman 相关**、**分桶体量的中位时延**（见 CSV）。",
        f"- 可写：在**当前上游与 workload** 下，**大对象**上 body 段与**体积**更同向，支持「传输/体」是主要**拉伸项之一**（非唯一）。",
        f"",
        f"## Unsafe or overstated claims",
        f"- 勿在**无**逐跳 RTT/队列测量时，将 **service_ms** 全归为「网络带宽」；",
        f"- 勿将 **TTFB** 直接等于「源站慢」；可能含**连接/ TLS / HTTP1 队头**等（新日志中的 `connection_reused` 才可辅助讨论）；",
        f"- 勿忽略 **client_p99** 与 **upstream** 的分离（见 outliers）。",
        f"",
    ]
    (out_dir / "upstream_root_cause_summary.md").write_text("\n".join(summary_lines) + "\n", encoding="utf-8")

    if _HAS_MPL and rows:
        ub_a = ubs
        ttfb_a = ttfb
        btr_a = btr
        plt.figure(figsize=(5, 4))
        plt.scatter(ub_a, ttfb_a, s=4, alpha=0.3)
        plt.xlabel("upstream_bytes")
        plt.ylabel("ttfb_ms")
        plt.title("TTFB vs object bytes")
        plt.tight_layout()
        plt.savefig(fig_dir / "ttfb_vs_bytes.pdf")
        plt.close()
        plt.figure(figsize=(5, 4))
        plt.scatter(ub_a, btr_a, s=4, alpha=0.3)
        plt.xlabel("upstream_bytes")
        plt.ylabel("body_transfer_ms")
        plt.title("Body transfer vs object bytes")
        plt.tight_layout()
        plt.savefig(fig_dir / "body_transfer_vs_bytes.pdf")
        plt.close()
        # effective mbps by bucket
        med_em = []
        for bname in BUCKET_LABELS:
            sub = by_buck[bname]
            em = [r["effective_mbps"] for r in sub if r.get("effective_mbps") is not None]
            med_em.append(statistics.median(em) if em else 0.0)
        plt.figure(figsize=(6, 4))
        plt.bar(BUCKET_LABELS, med_em)
        plt.ylabel("median effective_mbps (as logged)")
        plt.xticks(rotation=20, ha="right")
        plt.tight_layout()
        plt.savefig(fig_dir / "effective_mbps_by_size_bucket.pdf")
        plt.close()
        # stacked: median ttfb vs body as fraction
        by_scn = [s for s in sorted(by_sc) if s != "unknown"]
        fr_t = []
        fr_b = []
        for sc in by_scn:
            sub = by_sc[sc]
            tmed = statistics.median([x["ttfb_ms"] for x in sub]) if sub else 0
            bmed = statistics.median([x["body_transfer_ms"] for x in sub]) if sub else 0
            ssum = tmed + bmed or 1.0
            fr_t.append(tmed / ssum)
            fr_b.append(bmed / ssum)
        plt.figure(figsize=(6, 4))
        plt.bar(by_scn, fr_t, label="TTFB share of (TTFB+body)")
        plt.bar(by_scn, fr_b, bottom=fr_t, label="body share")
        plt.legend()
        plt.ylim(0, 1.05)
        plt.tight_layout()
        plt.savefig(fig_dir / "service_breakdown_stacked.pdf")
        plt.close()
    else:
        (fig_dir / "README_figures.txt").write_text(
            "Matplotlib 未安装或无可绘数据。安装: pip install matplotlib\n", encoding="utf-8"
        )

    print(f"Wrote upstream root cause under {out_dir}")


if __name__ == "__main__":
    main()
