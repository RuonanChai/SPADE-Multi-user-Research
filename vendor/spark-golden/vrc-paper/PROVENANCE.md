# PROVENANCE

## Active output directory

`vrc-paper/results/`

## Isolated invalid batches

- `vrc-paper/results_synthetic_invalid_20260507/` — old synthetic
- `vrc-paper/results_debug_mixed_invalid_20260509_175741/` — mixed instrumentation, p95=0, viewport-to-visible aliased to p95, blank/blue screenshots, missing 4-user markers

## Code version at start of clean run

Will be captured by runner per-run as `code_version.json` (sha256 of run_experiment.mjs, metric_collector.js, vrc_scheduler.js, analyze.py, sync_server.mjs, vrc_scene.html).

## Hard rules enforced

- No simulation / smoke / synthetic / `_sim` session ids — verified by runner exit-2 on those flags.
- No `viewport_to_visible_latency_ms = p95` alias — code now emits `NA` with explicit `viewport_to_visible_latency_source = not_independently_measured`.
- No `p95_latency_ms = 0` accepted — validate script will FAIL the run.
- No mixed instrumentation — code_version.json hash must match across all 72 runs.
- No use of old debug results — analysis only reads from active output dir.
