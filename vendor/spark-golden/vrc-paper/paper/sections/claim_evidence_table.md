# Claim–Evidence Table: Measurement-Driven Motivation (Origin 3-Trial Revision)

**口径**: 单用户 3 trials 均值（多用户标注为 trace-based sequential）。

| # | Claim | Metric | Value | Source | Caveat |
|---|-------|--------|-------|--------|--------|
| 1 | Local baseline: client pipeline is functional | FPS, chunks in 40s | 86.9 fps, 230 chunks, p95=30ms | `arm_comparison_e3_e5_e8.csv`: local_loopback, single_user, E3 (n=3) | Localhost/loopback reference path; includes MAS monitoring overhead |
| 2 | Pure rendering is not the primary bottleneck under this setup | FPS gap normal vs pure render | 86.9 vs 115.5 fps (local) | local_loopback single_user E3 vs E8 (n=3 each) | Gap includes decode+upload interleaving; cannot decompose further without per-frame profiling |
| 3 | Origin server: chunk p95 = 499 ms (17× local) | chunk completion p95 | 499 ms mean (range 303–740) | `origin_repeat_runs/origin_repeat_results.json`: E3 trials t0–t2 (n=3) | Variability: 303–740 ms across 3 trials |
| 4 | Origin server: normal streaming throughput comparable to local | FPS, chunks | 88.3 fps, 277 chunks | `origin_repeat_runs/`: E3 mean (n=3) | Pipeline sustains throughput via request overlap despite higher per-chunk latency |
| 5 | Origin server: fetch-only reveals network as dominant cost | chunk p95, count | 991 ms, 140 chunks | `origin_repeat_runs/`: E5 mean (n=3) | Same chunk count as local (140) but 6× higher p95 |
| 6 | Origin cold start = 1,178 ms | first_visible_splat_ms | 1,178 ms mean (range 948–1,657) | `origin_repeat_runs/`: cold_start t2,t3,t4 (n=3) | High variability (948–1,657 ms) |
| 7 | Remote server: "fast but empty" — 156.3 fps but only 17 chunks | FPS, chunks | 156.3 fps, 17 chunks | `arm_comparison_e3_e5_e8.csv`: cdn1_r2, single_user, E3 (n=3) | Unthrottled edge; actual throughput varies |
| 8 | Remote server: chunk p95 = 15,872 ms (529× local, 32× origin) | chunk p95 | 15,872 ms | `arm_comparison_e3_e5_e8.csv`: cdn1_r2, single_user, E3 (n=3) | Varies by time of day and edge PoP |
| 9 | Remote cold start = 6,703 ms (5.7× origin) | first_visible_splat_ms | 6,703 ms | `distributed_network_report.md` §Per profile: cdn1_r2 (n=2) | Only 2 cold-start trials |
| 10 | Remote 4-user: 12 chunks, p95=21,141 ms | chunks, p95 | 12 chunks, 21,141 ms | `arm_comparison_e3_e5_e8.csv`: cdn1_r2, lockstep_4users, E3 (n=8) | Trace-based sequential on single machine; 8 trials (4 clients × 2 reps) |
| 11 | p95 increases across all tiers | p95 progression | 30 → 499 → 15,872 ms | Claims #1, #3, #8 combined | Monotonic increase local→origin→remote |
| 12 | On-demand Range fetching incompatible with interactive 3DGS | Structural | origin 17×, remote 529× above local | Derived from measured data | Architectural argument |

## Limitations

| Limitation | Disclosure |
|-----------|-----------|
| Origin E8 fps: 1 of 3 trials had timeout artifact (fps=0) | Mean uses 2 valid trials (95.1, 89.4); noted in audit |
| Origin cold_start: 2 of 5 attempts failed (HPC momentarily unreachable) | Retried; final n=3 all valid |
| Remote server = Cloudflare R2 edge (unthrottled) | Described as "geographically distributed edge" |
| 4-user = trace-based sequential, not concurrent | Stated in paper |
| VRC not yet validated | Only motivation established |

## LaTeX Mapping

| Claim # | Paragraph | Table/Figure |
|---------|-----------|--------------|
| 1, 2 | Layer 1 | Table 1 (local rows) |
| 3, 4, 5, 6 | Layer 2 | Table 1 (origin rows) |
| 7, 8, 9, 10, 11 | Layer 3 | Table 1 (remote rows) + Figure 1 |
| 12 | "Fundamental mismatch" | — |
