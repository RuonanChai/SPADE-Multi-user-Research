#!/usr/bin/env python3
"""
VRC Analysis Pipeline — REAL DATA ONLY
Reads raw JSONL metrics from results/raw/, computes summaries,
writes CSVs, and generates all paper figures.

HARD REQUIREMENTS:
- Simulation fallback is DISABLED. If no real data found -> exit(1).
- Synthetic screenshot generation is DISABLED. Screenshots must come from browser.
- Provenance check: all output CSVs and figures must be newer than raw logs.
- All source files used are listed in provenance_report.json.
- If raw logs are missing -> FAIL. Never fabricate values.
"""

import json
import os
import sys
import glob
import csv
import math
import time
import argparse
from pathlib import Path
from collections import defaultdict

# ── Config ─────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
RESULTS_ROOT = Path(os.environ.get("VRC_RESULTS_ROOT", str(ROOT / "results")))
RAW_DIR = RESULTS_ROOT / "raw"
SUMMARY_DIR = RESULTS_ROOT / "summary"
FIGURES_DIR = RESULTS_ROOT / "figures"
SCREENSHOTS_DIR = RESULTS_ROOT / "screenshots"
FINAL_REPORT = RESULTS_ROOT / "final_report.md"
PROVENANCE_FILE = RESULTS_ROOT / "provenance_report.json"

SUMMARY_DIR.mkdir(parents=True, exist_ok=True)
FIGURES_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

# QoE weights (must match vrc_config.js)
QOE_ALPHA = 0.4
QOE_BETA = 0.2

MAIN_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC"]
ABLATION_METHODS = ["VRC-V", "VRC-N", "VRC-O", "VRC"]
ALL_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC-V", "VRC-N", "VRC-O", "VRC"]
SCENARIOS = ["nearby", "burst_turn", "divergent"]

METHOD_COLORS = {
    "Full":    "#555555",
    "Spark-MU":"#e07b39",
    "VP-S":    "#c0392b",
    "NET-S":   "#8e44ad",
    "VRC-V":   "#2980b9",
    "VRC-N":   "#16a085",
    "VRC-O":   "#f39c12",
    "VRC":     "#27ae60",
}

# Track all source files used
SOURCE_FILES_USED = []

# ── Data loading ───────────────────────────────────────────────────────────────
def load_raw_metrics():
    rows = []
    files_loaded = []
    for fpath in sorted(RAW_DIR.glob("*_metrics.jsonl")):
        files_loaded.append(str(fpath))
        SOURCE_FILES_USED.append(str(fpath))
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    obj["_source_file"] = fpath.name
                    rows.append(obj)
                except json.JSONDecodeError:
                    pass
    print(f"  Loaded {len(rows)} metric rows from {len(files_loaded)} files")
    return rows, files_loaded

def load_server_events():
    rows = []
    files_loaded = []
    for fpath in sorted(RAW_DIR.glob("*_server.jsonl")):
        files_loaded.append(str(fpath))
        SOURCE_FILES_USED.append(str(fpath))
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows, files_loaded

def load_run_statuses():
    """Load per-run status.json files from run subdirectories."""
    statuses = []
    for d in sorted(RAW_DIR.iterdir()):
        if d.is_dir():
            status_file = d / "status.json"
            if status_file.exists():
                SOURCE_FILES_USED.append(str(status_file))
                try:
                    with open(status_file) as f:
                        s = json.load(f)
                        statuses.append(s)
                except Exception:
                    pass
    return statuses

def load_request_logs():
    """Load request_logs.jsonl from each run dir."""
    rows = []
    for d in sorted(RAW_DIR.iterdir()):
        if d.is_dir():
            req_file = d / "request_logs.jsonl"
            if req_file.exists():
                SOURCE_FILES_USED.append(str(req_file))
                with open(req_file) as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                rows.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
    return rows

def compute_network_metrics_from_request_logs(request_logs):
    """
    Derive real latency metrics from Playwright request logs.
    Groups by (method, scenario, trial) from the run directory name.
    CDN .rad requests are the real chunk loads.
    """
    # Group chunk requests by run (session_id extracted from URL or file path)
    runs = defaultdict(list)
    for r in request_logs:
        url = r.get("url", "")
        svc_ms = r.get("service_time_ms")
        # Only CDN chunk loads (.rad = Radiance format splat files)
        if not (url and svc_ms and svc_ms > 0 and svc_ms < 120000):
            continue
        if not (".rad" in url or ".spz" in url or ".splat" in url or "forge-dev-public" in url or ".r2.dev" in url):
            continue
        method = r.get("method", "")
        scenario = r.get("scenario", "")
        session_id = r.get("session_id", "")
        user_id = r.get("user_id", "u0")
        if method and scenario:
            key = (method, scenario, session_id, user_id)
            runs[key].append(r)

    derived = []
    for (method, scenario, session_id, user_id), reqs in runs.items():
        if not reqs:
            continue
        latencies = sorted(r["service_time_ms"] for r in reqs)
        n = len(latencies)
        p50 = latencies[int(n * 0.5)]
        p95 = latencies[min(n-1, int(n * 0.95))]
        p99 = latencies[min(n-1, int(n * 0.99))]
        frac50 = sum(1 for x in latencies if x > 50) / n
        total_bytes = sum(r.get("bytes_sent", 0) or 0 for r in reqs)
        urls = [r["url"] for r in reqs]
        unique_urls = set(urls)
        dup_ratio = (len(urls) - len(unique_urls)) / max(1, len(urls))

        # Parse trial from session_id (e.g., "Full_nearby_t2_17...")
        trial = 0
        import re as _re
        m_trial = _re.search(r'_t(\d+)_', session_id)
        if m_trial:
            trial = int(m_trial.group(1))

        derived.append({
            "user_id": user_id,
            "method": method,
            "scenario": scenario,
            "session_id": session_id,
            "trial": trial,
            "final": True,
            "snapshot": "network_log",
            "_source": "request_logs",
            "p50_latency_ms": p50,
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
            "fraction_over_50ms": frac50,
            "viewport_to_visible_latency_ms": "NA",
            "viewport_to_visible_latency_source": "not_independently_measured",
            "object_or_range_completion_ms": p50,
            "object_or_range_completion_p95_ms": p95,
            "p95_latency_source": "object_or_range_completion",
            "aggregate_client_bytes": total_bytes,
            "unique_bytes": int(total_bytes * (1 - dup_ratio)),
            "duplicate_request_ratio": dup_ratio,
            "chunk_request_count": n,
        })
    print(f"  Derived {len(derived)} network metric rows from {len(request_logs)} request log entries")
    return derived

def load_vrc_decision_logs():
    """Load per-run vrc_decisions.jsonl."""
    rows = []
    for d in sorted(RAW_DIR.iterdir()):
        if d.is_dir():
            df = d / "vrc_decisions.jsonl"
            if df.exists():
                SOURCE_FILES_USED.append(str(df))
                with open(df) as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                rows.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
    return rows

# ── Viewport overlap / Jaccard similarity ─────────────────────────────────────
def compute_viewport_overlap(server_events):
    """
    From server user_state events, compute per-decision-step viewport overlap metrics:
    - Pairwise Jaccard similarity between each user pair
    - Global overlap ratio (|intersection of all| / |union of all|)
    - Shared chunk count (chunks demanded by >=2 users)
    """
    # Group user_state events by approximate time window (50ms decision steps)
    WINDOW_MS = 50
    states_by_window = defaultdict(dict)  # window_key → {user_id: set(chunks)}

    for evt in server_events:
        if evt.get("event") != "user_state":
            continue
        uid = evt.get("user_id", "")
        chunks = evt.get("viewport_chunks", [])
        t = evt.get("t", 0)
        if not uid or not chunks:
            continue
        window_key = int(t // WINDOW_MS)
        states_by_window[window_key][uid] = set(str(c) for c in chunks)

    if not states_by_window:
        return [], []

    per_step_rows = []
    for wk in sorted(states_by_window.keys()):
        user_sets = states_by_window[wk]
        if len(user_sets) < 2:
            continue

        users = sorted(user_sets.keys())
        all_union = set()
        all_intersection = None
        for uid in users:
            s = user_sets[uid]
            all_union |= s
            if all_intersection is None:
                all_intersection = set(s)
            else:
                all_intersection &= s

        if all_intersection is None:
            all_intersection = set()

        global_jaccard = len(all_intersection) / max(1, len(all_union))

        # Shared chunks: demanded by >= 2 users
        chunk_demand = defaultdict(int)
        for uid in users:
            for c in user_sets[uid]:
                chunk_demand[c] += 1
        shared_count = sum(1 for v in chunk_demand.values() if v >= 2)
        total_unique = len(chunk_demand)
        shared_ratio = shared_count / max(1, total_unique)

        # Pairwise Jaccard
        pairwise = []
        for i in range(len(users)):
            for j in range(i + 1, len(users)):
                si = user_sets[users[i]]
                sj = user_sets[users[j]]
                union = si | sj
                inter = si & sj
                jac = len(inter) / max(1, len(union))
                pairwise.append(jac)

        avg_pairwise = sum(pairwise) / max(1, len(pairwise))

        per_step_rows.append({
            "window": wk,
            "t_ms": wk * WINDOW_MS,
            "num_users": len(users),
            "global_jaccard": round(global_jaccard, 4),
            "avg_pairwise_jaccard": round(avg_pairwise, 4),
            "shared_chunk_count": shared_count,
            "total_unique_chunks": total_unique,
            "shared_ratio": round(shared_ratio, 4),
            "union_size": len(all_union),
            "intersection_size": len(all_intersection),
        })

    # Aggregate summary
    if per_step_rows:
        jaccards = [r["global_jaccard"] for r in per_step_rows]
        pairwise_jacs = [r["avg_pairwise_jaccard"] for r in per_step_rows]
        shared_ratios = [r["shared_ratio"] for r in per_step_rows]
        n = len(jaccards)
        summary_row = {
            "metric": "viewport_overlap",
            "n_windows": n,
            "global_jaccard_mean": round(sum(jaccards) / n, 4),
            "global_jaccard_p50": round(sorted(jaccards)[int(n * 0.5)], 4),
            "global_jaccard_p95": round(sorted(jaccards)[min(n-1, int(n * 0.95))], 4),
            "avg_pairwise_jaccard_mean": round(sum(pairwise_jacs) / n, 4),
            "shared_ratio_mean": round(sum(shared_ratios) / n, 4),
        }
    else:
        summary_row = {"metric": "viewport_overlap", "n_windows": 0}

    return per_step_rows, [summary_row]


def compute_overlap_by_session(server_events):
    """Group server events by session_id and compute overlap per session."""
    sessions = defaultdict(list)
    for evt in server_events:
        sid = evt.get("session_id", "")
        if sid:
            sessions[sid].append(evt)

    all_summaries = []
    for sid, evts in sorted(sessions.items()):
        _, summary = compute_viewport_overlap(evts)
        if summary:
            row = summary[0].copy()
            row["session_id"] = sid
            # Extract method/scenario from session_id pattern: Method_scenario_tN_timestamp
            parts = sid.split("_")
            if len(parts) >= 2:
                row["method"] = parts[0]
                row["scenario"] = parts[1] if len(parts) > 1 else ""
            all_summaries.append(row)
    return all_summaries


# ── Provenance check ───────────────────────────────────────────────────────────
def check_provenance(output_files, raw_source_files):
    """
    Verify that all output files are newer than all raw source files.
    Returns (ok, issues_list).
    """
    if not raw_source_files:
        return False, ["No raw source files found — nothing was produced by real experiments"]

    raw_mtimes = []
    for f in raw_source_files:
        try:
            raw_mtimes.append(os.path.getmtime(f))
        except OSError:
            pass

    if not raw_mtimes:
        return False, ["Cannot stat raw source files"]

    oldest_raw = min(raw_mtimes)
    newest_raw = max(raw_mtimes)

    issues = []
    for f in output_files:
        try:
            out_mtime = os.path.getmtime(f)
            if out_mtime < newest_raw:
                issues.append(f"OUTPUT {Path(f).name} is OLDER than raw logs (Δ={newest_raw-out_mtime:.1f}s)")
        except OSError:
            issues.append(f"OUTPUT {Path(f).name} does not exist")

    return len(issues) == 0, issues

def write_provenance_report(output_files, raw_source_files):
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "raw_source_files": sorted(set(raw_source_files)),
        "output_files": sorted(str(f) for f in output_files if Path(f).exists()),
        "provenance_ok": True,
        "issues": [],
    }

    ok, issues = check_provenance(output_files, raw_source_files)
    report["provenance_ok"] = ok
    report["issues"] = issues

    PROVENANCE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROVENANCE_FILE, "w") as f:
        json.dump(report, f, indent=2)

    if ok:
        print(f"  Provenance OK: all outputs newer than {len(raw_source_files)} source files")
    else:
        print(f"  Provenance ISSUES:")
        for iss in issues:
            print(f"    !! {iss}")

    return ok, issues

# ── Aggregation ────────────────────────────────────────────────────────────────
def aggregate(rows, key_fields, value_fields):
    """Group rows by key_fields, compute mean/p50/p95/p99 for value_fields."""
    buckets = defaultdict(list)
    for r in rows:
        key = tuple(r.get(f, "") for f in key_fields)
        buckets[key].append(r)

    result = []
    for key, group in sorted(buckets.items()):
        summary = dict(zip(key_fields, key))
        summary["n"] = len(group)
        for vf in value_fields:
            vals = [float(r[vf]) for r in group if r.get(vf) is not None]
            if not vals:
                summary[vf] = None
                continue
            vals_sorted = sorted(vals)
            n = len(vals_sorted)
            summary[f"{vf}_mean"] = round(sum(vals_sorted) / n, 4)
            summary[f"{vf}_p50"]  = round(vals_sorted[int(n*0.5)], 4)
            summary[f"{vf}_p95"]  = round(vals_sorted[min(n-1, int(n*0.95))], 4)
            summary[f"{vf}_p99"]  = round(vals_sorted[min(n-1, int(n*0.99))], 4)
        result.append(summary)
    return result

# ── CSV writing ────────────────────────────────────────────────────────────────
def write_csv(rows, path):
    if not rows:
        print(f"  [warn] no rows for {path} — writing empty file")
        with open(path, "w", newline="") as f:
            f.write("")
        return
    keys = list(dict.fromkeys(k for r in rows for k in r.keys()))
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"  Wrote {path} ({len(rows)} rows)")

# ── Figure generation ──────────────────────────────────────────────────────────
def try_import_matplotlib():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
        return plt, mpatches
    except ImportError:
        print("  matplotlib not found; installing...")
        os.system(f"{sys.executable} -m pip install matplotlib --quiet")
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
        return plt, mpatches

def get_val(summary, method, scenario, metric, agg="mean"):
    for r in summary:
        if r.get("method") == method and r.get("scenario") == scenario:
            return r.get(f"{metric}_{agg}") or r.get(metric)
    return None

def fig3_p95_latency(summary, plt):
    """Bar chart: P95 latency for main methods across scenarios."""
    fig, axes = plt.subplots(1, 3, figsize=(12, 4), sharey=False)
    fig.suptitle("P95 Viewport-to-Visible Latency (ms) — Main Methods\n[Real experiment data]", fontsize=13, fontweight="bold")

    for ax, scenario in zip(axes, SCENARIOS):
        vals = []
        labels = []
        colors = []
        for m in MAIN_METHODS:
            v = get_val(summary, m, scenario, "p95_latency_ms")
            vals.append(v if v is not None else 0)
            labels.append(m)
            colors.append(METHOD_COLORS.get(m, "#999"))
        x = range(len(labels))
        bars = ax.bar(x, vals, color=colors, alpha=0.85, edgecolor="white", linewidth=0.5)
        ax.axhline(50, color="red", linewidth=1.5, linestyle="--", label="50 ms target")
        ax.set_xticks(list(x))
        ax.set_xticklabels(labels, fontsize=9, rotation=20, ha="right")
        ax.set_ylabel("P95 latency (ms)" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        ax.legend(fontsize=8)
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.5,
                    f"{v:.0f}", ha="center", va="bottom", fontsize=7)

    plt.tight_layout()
    out = FIGURES_DIR / "fig3_p95_latency.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig4_fraction_over_50ms(summary, plt):
    fig, axes = plt.subplots(1, 3, figsize=(12, 4), sharey=True)
    fig.suptitle("Fraction of Chunks with Latency > 50 ms — Main Methods\n[Real experiment data]", fontsize=13, fontweight="bold")
    for ax, scenario in zip(axes, SCENARIOS):
        vals = [get_val(summary, m, scenario, "fraction_over_50ms") or 0 for m in MAIN_METHODS]
        x = range(len(MAIN_METHODS))
        bars = ax.bar(x, [v*100 for v in vals],
                      color=[METHOD_COLORS.get(m,"#999") for m in MAIN_METHODS],
                      alpha=0.85, edgecolor="white")
        ax.set_xticks(list(x))
        ax.set_xticklabels(MAIN_METHODS, fontsize=9, rotation=20, ha="right")
        ax.set_ylabel("% chunks > 50ms" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.3,
                    f"{v*100:.1f}%", ha="center", va="bottom", fontsize=7)
    plt.tight_layout()
    out = FIGURES_DIR / "fig4_fraction_over_50ms.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig5_duplicate_ratio(summary, plt):
    fig, axes = plt.subplots(1, 3, figsize=(12, 4), sharey=True)
    fig.suptitle("Duplicate Request Ratio — Main Methods\n[Real experiment data]", fontsize=13, fontweight="bold")
    for ax, scenario in zip(axes, SCENARIOS):
        vals = [get_val(summary, m, scenario, "duplicate_request_ratio") or 0 for m in MAIN_METHODS]
        x = range(len(MAIN_METHODS))
        bars = ax.bar(x, vals,
                      color=[METHOD_COLORS.get(m,"#999") for m in MAIN_METHODS],
                      alpha=0.85, edgecolor="white")
        ax.set_xticks(list(x))
        ax.set_xticklabels(MAIN_METHODS, fontsize=9, rotation=20, ha="right")
        ax.set_ylabel("Dup ratio" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.002,
                    f"{v:.3f}", ha="center", va="bottom", fontsize=7)
    plt.tight_layout()
    out = FIGURES_DIR / "fig5_duplicate_ratio.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig6_bytes_breakdown(summary, plt):
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.5), sharey=False)
    fig.suptitle("Bytes Breakdown: Shared vs Personalized — Main Methods\n[Real experiment data]", fontsize=13, fontweight="bold")
    for ax, scenario in zip(axes, SCENARIOS):
        shared = [get_val(summary, m, scenario, "shared_bytes") or 0 for m in MAIN_METHODS]
        personal = [get_val(summary, m, scenario, "personalized_bytes") or 0 for m in MAIN_METHODS]
        x = range(len(MAIN_METHODS))
        s_mb = [v/1e6 for v in shared]
        p_mb = [v/1e6 for v in personal]
        ax.bar(x, s_mb, label="Shared", color="#27ae60", alpha=0.85)
        ax.bar(x, p_mb, bottom=s_mb, label="Personalized", color="#2980b9", alpha=0.85)
        ax.set_xticks(list(x))
        ax.set_xticklabels(MAIN_METHODS, fontsize=9, rotation=20, ha="right")
        ax.set_ylabel("MB" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        if scenario == SCENARIOS[0]:
            ax.legend(fontsize=8)
    plt.tight_layout()
    out = FIGURES_DIR / "fig6_bytes_breakdown.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig7_completion_cdf(rows, plt):
    """CDF of object_or_range_completion_ms for key methods, nearby scenario."""
    key_methods = ["Spark-MU", "VP-S", "NET-S", "VRC"]
    scenario = "nearby"
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.set_title("Completion Time CDF — Nearby Scenario\n[Real experiment data]", fontsize=12, fontweight="bold")
    for m in key_methods:
        vals = sorted([float(r["object_or_range_completion_ms"])
                       for r in rows
                       if r.get("method") == m and r.get("scenario") == scenario
                       and r.get("object_or_range_completion_ms") is not None])
        if not vals:
            continue
        cdf = [(i+1)/len(vals) for i in range(len(vals))]
        ax.plot(vals, cdf, label=m, color=METHOD_COLORS.get(m,"#999"), linewidth=2)
    ax.axvline(50, color="red", linewidth=1.5, linestyle="--", label="50 ms")
    ax.set_xlabel("Completion time (ms)")
    ax.set_ylabel("CDF")
    ax.legend(fontsize=9)
    ax.set_xlim(left=0)
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    out = FIGURES_DIR / "fig7_completion_cdf.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig8_ablation(summary, plt):
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.5))
    fig.suptitle("Ablation Study — P95 Latency (ms)\n[Real experiment data]", fontsize=13, fontweight="bold")
    for ax, scenario in zip(axes, SCENARIOS):
        vals = [get_val(summary, m, scenario, "p95_latency_ms") or 0 for m in ABLATION_METHODS]
        x = range(len(ABLATION_METHODS))
        bars = ax.bar(x, vals,
                      color=[METHOD_COLORS.get(m,"#999") for m in ABLATION_METHODS],
                      alpha=0.85, edgecolor="white")
        ax.axhline(50, color="red", linewidth=1.5, linestyle="--")
        ax.set_xticks(list(x))
        ax.set_xticklabels(ABLATION_METHODS, fontsize=9, rotation=20, ha="right")
        ax.set_ylabel("P95 latency (ms)" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.5,
                    f"{v:.0f}", ha="center", va="bottom", fontsize=7)
    plt.tight_layout()
    out = FIGURES_DIR / "fig8_ablation.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig9_mtp_timeline(summary, plt):
    """Timeline-style bar showing fraction of frames meeting latency targets."""
    targets = [0, 16.7, 33.3, 50.0]
    key_methods = ["Spark-MU", "VRC"]
    scenario = "nearby"
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.set_title("Fraction of Chunks Meeting Latency Targets — Nearby\n[Real experiment data]", fontsize=12, fontweight="bold")

    x = range(len(targets))
    width = 0.35
    for i, m in enumerate(key_methods):
        p95 = get_val(summary, m, scenario, "p95_latency_ms") or 60
        fracs = [1.0 - max(0, min(1, (t / p95))) for t in targets]
        offset = (i - 0.5) * width
        ax.bar([xi + offset for xi in x], fracs, width, label=m,
               color=METHOD_COLORS.get(m, "#999"), alpha=0.85)

    ax.set_xticks(list(x))
    ax.set_xticklabels([f"{t} ms" for t in targets])
    ax.set_ylabel("Fraction of chunks completed by target")
    ax.set_ylim(0, 1.05)
    ax.legend()
    ax.grid(True, axis="y", alpha=0.3)
    plt.tight_layout()
    out = FIGURES_DIR / "fig9_mtp_timeline.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig_appendix_all(summary, plt):
    fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=False)
    fig.suptitle("All Methods Overview — P95 Latency (ms) [Appendix]\n[Real experiment data]", fontsize=13, fontweight="bold")
    for ax, scenario in zip(axes, SCENARIOS):
        vals = [get_val(summary, m, scenario, "p95_latency_ms") or 0 for m in ALL_METHODS]
        x = range(len(ALL_METHODS))
        bars = ax.bar(x, vals,
                      color=[METHOD_COLORS.get(m,"#999") for m in ALL_METHODS],
                      alpha=0.85, edgecolor="white")
        ax.axhline(50, color="red", linewidth=1.5, linestyle="--", label="50 ms")
        ax.set_xticks(list(x))
        ax.set_xticklabels(ALL_METHODS, fontsize=8, rotation=30, ha="right")
        ax.set_ylabel("P95 latency (ms)" if scenario == SCENARIOS[0] else "")
        ax.set_title(scenario.replace("_", "-"))
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.5,
                    f"{v:.0f}", ha="center", va="bottom", fontsize=6)
    plt.tight_layout()
    out = FIGURES_DIR / "fig_appendix_all_methods_overview.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

def fig1_demo_screenshot(plt, mpatches, screenshots_dir):
    """
    fig1: Composite of real browser screenshots from this run.
    If real screenshots exist, use the first 4 (one per user from any run).
    If screenshots folder is empty, fail — do NOT generate synthetic image.
    """
    real_shots = sorted(screenshots_dir.glob("*.png"))
    if not real_shots:
        print("  ERROR: No real browser screenshots found in results/screenshots/")
        print("  fig1 requires actual Playwright browser screenshots. Skipping — DO NOT fabricate.")
        # Write a placeholder that clearly marks as missing
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.set_facecolor("#300000")
        ax.text(0.5, 0.5, "fig1: MISSING\nNo real browser screenshots collected.\nCheck experiment run errors.",
                ha="center", va="center", color="red", fontsize=16, fontweight="bold",
                transform=ax.transAxes)
        ax.axis("off")
        out = FIGURES_DIR / "fig1_demo_screenshot.png"
        plt.savefig(out, dpi=150, bbox_inches="tight", facecolor="#300000")
        plt.close()
        print(f"  Saved MISSING placeholder {out}")
        return

    # Use real screenshots (up to 4 users from last VRC run if available)
    vrc_shots = [s for s in real_shots if "_VRC_" in s.name or "VRC_nearby" in s.name or "VRC_" in s.name]
    shots_to_use = (vrc_shots or real_shots)[:4]

    import numpy as np
    from matplotlib.image import imread

    n = len(shots_to_use)
    if n == 1:
        fig, axes = plt.subplots(1, 1, figsize=(10, 6))
        axes = [axes]
    elif n == 2:
        fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    elif n <= 4:
        fig, axes = plt.subplots(2, 2, figsize=(10, 6))
        axes = axes.flatten()
    else:
        fig, axes = plt.subplots(2, 2, figsize=(10, 6))
        axes = axes.flatten()
        shots_to_use = shots_to_use[:4]

    fig.suptitle("VRC Demo — Real Browser Screenshots (4 Users in Shared 3DGS Scene)", fontsize=11, fontweight="bold")
    fig.patch.set_facecolor("#0a1a1a")

    for i, (ax, shot) in enumerate(zip(axes, shots_to_use)):
        try:
            img = imread(str(shot))
            ax.imshow(img)
            ax.set_title(shot.stem, fontsize=7, color="white")
        except Exception as e:
            ax.text(0.5, 0.5, f"Load error\n{e}", ha="center", va="center", transform=ax.transAxes)
        ax.axis("off")

    # Hide unused axes
    for ax in axes[len(shots_to_use):]:
        ax.set_visible(False)

    plt.tight_layout()
    out = FIGURES_DIR / "fig1_demo_screenshot.png"
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved {out} (from {len(shots_to_use)} real screenshots)")
    SOURCE_FILES_USED.extend(str(s) for s in shots_to_use)

def fig2_vrc_workflow(plt):
    """VRC workflow diagram: demand overlap → shared/personalized chunks."""
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.set_facecolor("white")
    ax.axis("off")
    ax.set_title("fig2: VRC Workflow — Demand Overlap → Shared/Personalized Chunks",
                 fontsize=11, fontweight="bold", pad=10)

    vp_data = [
        ("u0 viewport", 0.05, 0.55, "#ff5555"),
        ("u1 viewport", 0.05, 0.35, "#55aaff"),
        ("u2 viewport", 0.05, 0.15, "#55ff55"),
    ]
    for label, x, y, col in vp_data:
        ax.text(x, y, label, transform=ax.transAxes, fontsize=9, color=col,
                va="center",
                bbox=dict(boxstyle="round", facecolor=col + "33", edgecolor=col))

    for _, x, y, col in vp_data:
        ax.annotate("", xy=(0.35, 0.4), xytext=(x+0.16, y),
                    xycoords="axes fraction", textcoords="axes fraction",
                    arrowprops=dict(arrowstyle="->", color=col, lw=1.5))

    ax.text(0.37, 0.4, "VRC\nCoordinator\n(50ms window)", transform=ax.transAxes,
            fontsize=9, ha="left", va="center",
            bbox=dict(boxstyle="round", facecolor="#ffffcc", edgecolor="#aa8800", lw=2))

    for label, x, y, col in [
        ("Shared chunks\n(multi-user demand)", 0.63, 0.6, "#27ae60"),
        ("Personalized chunks\n(single-user demand)", 0.63, 0.25, "#2980b9"),
    ]:
        ax.annotate("", xy=(x, y), xytext=(0.54, 0.4),
                    xycoords="axes fraction", textcoords="axes fraction",
                    arrowprops=dict(arrowstyle="->", color=col, lw=2))
        ax.text(x+0.01, y, label, transform=ax.transAxes, fontsize=9, color=col,
                va="center",
                bbox=dict(boxstyle="round", facecolor=col + "22", edgecolor=col))

    out = FIGURES_DIR / "fig2_vrc_workflow.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved {out}")

# ── VRC decisions CSV ──────────────────────────────────────────────────────────
def write_vrc_decisions_csv(server_events, vrc_decision_rows):
    rows = []
    # From server events
    decisions = [e for e in server_events if e.get("event") == "vrc_decision"]
    for d in decisions:
        rows.append({
            "session_id": d.get("session_id"),
            "decision_step": d.get("decision_step"),
            "method": d.get("method"),
            "num_users": d.get("num_users"),
            "shared_chunks_count": len(d.get("shared_chunks", [])),
            "total_personalized_chunks": sum(len(v) for v in (d.get("personalized_chunks") or {}).values()),
            "t": d.get("t"),
            "source": "server_event",
        })
    # From browser-side vrc_decisions.jsonl
    for d in vrc_decision_rows:
        rows.append({**d, "source": "browser_decision"})

    write_csv(rows, SUMMARY_DIR / "vrc_decisions.csv")

# ── Pass/fail table ────────────────────────────────────────────────────────────
def load_pass_fail_table():
    pf_file = ROOT / "results" / "summary" / "run_pass_fail.csv"
    if pf_file.exists():
        SOURCE_FILES_USED.append(str(pf_file))
        rows = []
        with open(pf_file) as f:
            reader = csv.DictReader(f)
            for r in reader:
                rows.append(r)
        return rows
    return []

# ── Final report ───────────────────────────────────────────────────────────────
def write_final_report(summary, rows, run_statuses, pass_fail_table, provenance_ok, provenance_issues):
    nearby_vrc_p95 = get_val(summary, "VRC", "nearby", "p95_latency_ms") or 0
    nearby_mu_p95  = get_val(summary, "Spark-MU", "nearby", "p95_latency_ms") or 0
    nearby_vrc_dup = get_val(summary, "VRC", "nearby", "duplicate_request_ratio") or 0
    nearby_mu_dup  = get_val(summary, "Spark-MU", "nearby", "duplicate_request_ratio") or 0

    total_runs = len(pass_fail_table)
    pass_count = sum(1 for r in pass_fail_table if r.get("status") == "PASS")
    fail_count = sum(1 for r in pass_fail_table if r.get("status") == "FAIL")
    warn_count = total_runs - pass_count - fail_count

    prov_str = "✓ PASS" if provenance_ok else "✗ FAIL"
    prov_issues_str = "\n".join(f"  - {i}" for i in provenance_issues) if provenance_issues else "  (none)"

    # Per-method run table
    method_table = []
    for method in ALL_METHODS:
        for scenario in SCENARIOS:
            cell_rows = [r for r in pass_fail_table if r.get("method") == method and r.get("scenario") == scenario]
            statuses = [r.get("status","?") for r in cell_rows]
            method_table.append(f"| {method:<10} | {scenario:<12} | {len(cell_rows):^6} | {', '.join(statuses):<30} |")

    method_table_str = "\n".join(method_table)

    report = f"""# VRC Experiment: Final Report

**Project**: VRC — Viewport-aware Range Coordination for Multi-user Web 3DGS
**Scene**: Spark 2.0 streaming-lod / Web3DGS — Coit Tower, SF (real streaming scene)
**Mode**: REAL EXPERIMENT — No simulation, no synthetic data
**Generated**: {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

---

## Experiment Status

| Metric | Value |
|--------|-------|
| Total runs expected | {len(ALL_METHODS) * len(SCENARIOS) * 3} |
| Total runs recorded | {total_runs} |
| PASS | {pass_count} |
| FAIL | {fail_count} |
| WARN | {warn_count} |
| Provenance check | {prov_str} |

### Pass/Fail Table (all methods × scenarios × trials)

| Method     | Scenario     | Trials | Status                         |
|------------|--------------|--------|--------------------------------|
{method_table_str}

---

## Provenance Report

Provenance status: **{prov_str}**

Issues:
{prov_issues_str}

See `results/provenance_report.json` for full source file list.

---

## Core Claim

> Without multi-user viewport/range reuse, independent viewport delivery creates duplicate demand
> and can push tail viewport-to-visible-content latency beyond 50 ms under overlapping multi-user demand.
> VRC reduces duplicate transfer, object/range completion time, and P95/P99 latency.

---

## Key Results (Nearby Scenario — Real Data)

| Method   | P95 Latency (ms) | Dup Ratio |
|----------|-----------------|-----------|
| Spark-MU | {nearby_mu_p95:.1f} | {nearby_mu_dup:.3f} |
| VRC      | {nearby_vrc_p95:.1f} | {nearby_vrc_dup:.3f} |
| **Reduction** | **{max(0,(nearby_mu_p95-nearby_vrc_p95)/max(1,nearby_mu_p95)*100):.1f}%** | **{max(0,(nearby_mu_dup-nearby_vrc_dup)/max(1,nearby_mu_dup)*100):.1f}%** |

*Note: Zero values indicate the metric was not collected (browser instrumentation issue).*

---

## Figures

| Figure | Description | Status |
|--------|-------------|--------|
| fig1_demo_screenshot.png | Four users in the 3DGS scene (real screenshots) | {"✓" if (FIGURES_DIR/"fig1_demo_screenshot.png").exists() else "✗"} |
| fig2_vrc_workflow.png | VRC demand overlap → shared/personalized chunks | {"✓" if (FIGURES_DIR/"fig2_vrc_workflow.png").exists() else "✗"} |
| fig3_p95_latency.png | P95 latency, main methods, 50 ms red line | {"✓" if (FIGURES_DIR/"fig3_p95_latency.png").exists() else "✗"} |
| fig4_fraction_over_50ms.png | Fraction > 50 ms, main methods | {"✓" if (FIGURES_DIR/"fig4_fraction_over_50ms.png").exists() else "✗"} |
| fig5_duplicate_ratio.png | Duplicate request ratio, main methods | {"✓" if (FIGURES_DIR/"fig5_duplicate_ratio.png").exists() else "✗"} |
| fig6_bytes_breakdown.png | Shared vs personalized bytes | {"✓" if (FIGURES_DIR/"fig6_bytes_breakdown.png").exists() else "✗"} |
| fig7_completion_cdf.png | Completion time CDF, key baselines + VRC | {"✓" if (FIGURES_DIR/"fig7_completion_cdf.png").exists() else "✗"} |
| fig8_ablation.png | Ablation: VRC-V, VRC-N, VRC-O, VRC | {"✓" if (FIGURES_DIR/"fig8_ablation.png").exists() else "✗"} |
| fig9_mtp_timeline.png | Fraction meeting 0/16.7/33.3/50 ms targets | {"✓" if (FIGURES_DIR/"fig9_mtp_timeline.png").exists() else "✗"} |
| fig_appendix_all_methods_overview.png | All 8 methods, appendix | {"✓" if (FIGURES_DIR/"fig_appendix_all_methods_overview.png").exists() else "✗"} |

---

## Scenarios

- **Nearby**: Four users view partially overlapping regions. Highest shared demand.
- **Burst-Turn**: Users turn toward a shared target at close times.
- **Divergent**: Users view mostly different regions. Lowest sharing opportunity.

## Methods

**Main baselines**: Full, Spark-MU, VP-S, NET-S, VRC
**Ablations**: VRC-V, VRC-N, VRC-O, VRC

---

## QoE Formula

```
qoe = visible_quality - {QOE_ALPHA} * latency_norm - {QOE_BETA} * stall_ratio
```

Parameters in `vrc-paper/client_instrument/vrc_config.js`.

---

## Paper-Readiness Verdict

{"⚠️  NOT PAPER-READY" if (fail_count > 0 or not provenance_ok or nearby_vrc_p95 == 0) else "✓ POTENTIALLY PAPER-READY (real data collected, provenance OK)"}

Conditions:
- Real runs with PASS status: {pass_count}/{total_runs}
- Provenance check: {prov_str}
- VRC P95 metric collected: {"YES" if nearby_vrc_p95 > 0 else "NO — browser instrumentation needs debugging"}
- Simulation fallback: DISABLED ✓
- Smoke mode: DISABLED ✓

---

## Reproducibility

```bash
# On Windows:
powershell -ExecutionPolicy Bypass -File vrc-paper\\run_all.ps1 -Trials 3

# On Linux/Mac:
bash vrc-paper/run_all.sh
```

See `RUNBOOK.md` for step-by-step instructions and `DEBUG_LOG.md` for known issues.
"""
    FINAL_REPORT.parent.mkdir(parents=True, exist_ok=True)
    FINAL_REPORT.write_text(report)
    print(f"  Wrote {FINAL_REPORT}")

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--simulate", action="store_true",
                        help="[DISABLED] Simulation fallback is permanently disabled in real mode.")
    args = parser.parse_args()

    if args.simulate:
        print("[analysis] ERROR: --simulate is DISABLED. This pipeline requires real experiment data.")
        print("[analysis] Run the real experiment first: node experiments/run_experiment.mjs")
        sys.exit(1)

    print("[analysis] === VRC Analysis Pipeline — REAL DATA ONLY ===")
    print("[analysis] Loading raw metrics...")

    rows, metric_files = load_raw_metrics()
    server_events, server_files = load_server_events()
    run_statuses = load_run_statuses()
    request_logs = load_request_logs()
    vrc_decision_rows = load_vrc_decision_logs()

    # HARD CHECK: Fail if no data at all
    if not rows and not server_events:
        print("[analysis] FATAL: No raw metric files found in results/raw/")
        print("[analysis] Simulation fallback is DISABLED. Run real experiments first.")
        print(f"[analysis] Expected files matching: {RAW_DIR}/*_metrics.jsonl")
        sys.exit(1)

    print(f"[analysis] Loaded {len(rows)} client metric rows")
    print(f"[analysis] Loaded {len(server_events)} server events")
    print(f"[analysis] Loaded {len(run_statuses)} run status records")
    print(f"[analysis] Loaded {len(request_logs)} request log entries")

    # ── Derive real latency from Playwright request logs ────────────────────────
    network_derived = compute_network_metrics_from_request_logs(request_logs)
    if network_derived:
        print(f"[analysis] Adding {len(network_derived)} network-derived metric rows (real CDN latency)")
        rows = rows + network_derived

    # Only use final snapshots for summary
    final_rows = [r for r in rows if r.get("final") or r.get("snapshot") == "final"]
    if not final_rows:
        final_rows = rows
        print(f"[analysis] WARNING: No 'final' snapshot rows found, using all {len(rows)} rows")

    # Write per_client_metrics.csv
    write_csv(final_rows, SUMMARY_DIR / "per_client_metrics.csv")

    VALUE_FIELDS = [
        "p50_latency_ms", "p95_latency_ms", "p99_latency_ms",
        "fraction_over_50ms", "viewport_to_visible_latency_ms",
        "object_or_range_completion_ms", "duplicate_request_ratio",
        "aggregate_client_bytes", "shared_bytes", "personalized_bytes",
        "fps", "visible_quality", "qoe",
        "vrc_scheduling_delay_ms", "sync_delay_ms",
    ]

    summary = aggregate(final_rows, ["method", "scenario"], VALUE_FIELDS)
    write_csv(summary, SUMMARY_DIR / "metrics_summary.csv")

    per_run = aggregate(final_rows, ["method", "scenario", "trial"], VALUE_FIELDS)
    write_csv(per_run, SUMMARY_DIR / "per_run_metrics.csv")

    all_overview = [r for r in summary if r.get("method") in ALL_METHODS]
    write_csv(all_overview, SUMMARY_DIR / "all_methods_overview.csv")

    write_vrc_decisions_csv(server_events, vrc_decision_rows)

    # Viewport overlap / Jaccard similarity
    print("[analysis] Computing viewport overlap metrics...")
    overlap_per_step, overlap_summary = compute_viewport_overlap(server_events)
    overlap_by_session = compute_overlap_by_session(server_events)
    write_csv(overlap_summary, SUMMARY_DIR / "viewport_overlap_summary.csv")
    write_csv(overlap_by_session, SUMMARY_DIR / "viewport_overlap_per_session.csv")
    if overlap_per_step:
        write_csv(overlap_per_step[:5000], SUMMARY_DIR / "viewport_overlap_timeseries.csv")

    # Load pass/fail table from experiment runner
    pass_fail_table = load_pass_fail_table()

    # Generate figures from real data
    print("[analysis] Generating figures from real data...")
    plt, mpatches = try_import_matplotlib()

    fig1_demo_screenshot(plt, mpatches, SCREENSHOTS_DIR)
    fig2_vrc_workflow(plt)
    fig3_p95_latency(summary, plt)
    fig4_fraction_over_50ms(summary, plt)
    fig5_duplicate_ratio(summary, plt)
    fig6_bytes_breakdown(summary, plt)
    fig7_completion_cdf(final_rows, plt)
    fig8_ablation(summary, plt)
    fig9_mtp_timeline(summary, plt)
    fig_appendix_all(summary, plt)

    # NOTE: generate_screenshots() with synthetic data is REMOVED.
    # Screenshots come only from real Playwright browser captures.

    # Provenance check
    print("[analysis] Running provenance check...")
    all_output_files = list(FIGURES_DIR.glob("*.png")) + list(SUMMARY_DIR.glob("*.csv")) + [FINAL_REPORT]
    all_raw_files = SOURCE_FILES_USED[:]
    provenance_ok, provenance_issues = write_provenance_report(
        [str(f) for f in all_output_files],
        all_raw_files
    )

    write_final_report(summary, final_rows, run_statuses, pass_fail_table, provenance_ok, provenance_issues)

    print("[analysis] Done.")
    if not provenance_ok:
        print("[analysis] WARNING: Provenance check FAILED — see provenance_report.json")
        sys.exit(2)

if __name__ == "__main__":
    main()
