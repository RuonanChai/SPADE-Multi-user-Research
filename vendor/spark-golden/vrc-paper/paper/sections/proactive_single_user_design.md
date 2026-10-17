# Proactive Single-User Delivery (Design)

## Problem

Prior measurement (`measurement_motivation_24h`) shows on-demand large Range fetching on **origin** and **remote** servers yields **chunk completion p95 ≫ 50ms**, while **render FPS stays high** — a timing problem, not a pure render-cap problem.

## Hypothesis

**Prediction + prefetch + priority** can place *useful* chunks in a near-client cache before `chunk_needed_time`, reducing:

- `deadline_miss_ratio_50ms` / `deadline_miss_ratio_100ms`
- improving `useful_chunks_before_demand` and `useful_bytes / total_received_bytes`

without relying on “download more bytes” alone.

## Experiment (single user only)

- Same camera trace: `orbitCamera` in ablation cell (warmup + measure duration fixed).
- Deliveries: `origin_server` (10.120.17.176:8090), `remote_server` (cdn1_r2).
- Baselines B0–B4 (B4 = oracle upper bound, not deployable).

## Metrics

| Metric | Role |
|--------|------|
| `deadline_miss_ratio_50/100ms` | Primary timing outcome |
| `useful_chunks_before_demand` | Proactive benefit |
| `useful_bytes_ratio`, `wasted_prefetch_bytes` | Fairness / waste |
| `first_visible_splat_ms` | QoE |
| `measure_fps` + `fast_but_empty_detected` | Reject “high FPS, no content” |

## Claims we do **not** make here

- Multi-user overlap/dedup (deferred).
- VRC dual-machine coordination results.
- “CDN slower than campus” as a surprise (topology confound).

## Results (Phase 0 canary only)

See `paper_materials/proactive_single_user/proactive_single_user_audit.md`.

| baseline | miss50% | useful_before | measure_fps |
|----------|---------|---------------|-------------|
| B0 | 0.0 | 148 | ~107 |
| B3 | 98.2 | 1 | ~1 |
| B4* | 59.4 | 167 | ~88 |

**Interpretation:** Canary does **not** show B3 beating B0. B3 prefetch starves the main thread (FPS≈1). Metric calibration: CDP-based `chunk_ready_time` may understate B0 misses until parse-aligned ready times are merged.

Phase 1 (origin full, 15 trials) pending.

## Failure analysis template

If B3 ≈ B0: report wasted bytes, low useful ratio, or demand trace mismatch — do not claim proactive success.
