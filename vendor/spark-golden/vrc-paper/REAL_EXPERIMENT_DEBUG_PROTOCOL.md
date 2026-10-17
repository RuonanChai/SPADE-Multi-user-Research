You are Claude Code. Work in:

D:\Program\spark-main\spark-main

Strictly follow:
D:\Program\spark-main\spark-main\.claude\skills\vrc-web3dgs-paper-pipeline\SKILL.md

Goal:
Make the VRC Web3DGS experiment pipeline paper-valid in one rigorous debugging pass. Do not keep discovering one issue per run. Audit, fix, gate, canary, then run. The final experiment must use a real Spark2.0 Web3DGS scene opened by URL, with 4 users/avatars visible for demo, and all metrics generated only from real browser/client/server/request logs.

Important current state:
The current running batch is DEBUG/MIXED only because instrumentation was modified during execution. The active Node process does not pick up already-modified run_experiment.mjs. Earlier runs had p95_latency_ms=0. Do not use current results as paper results.

Immediate action:
1. Stop current background experiment.
2. Kill all Chrome, Playwright, Vite, Node sync-server processes started for VRC.
3. Do not delete logs. Rename current results/raw to:
   results/raw_debug_mixed_invalid_<timestamp>
4. Rename any current summary/figures from the mixed batch to:
   results_debug_mixed_invalid_<timestamp>
5. Start from a clean output directory:
   results_real_<timestamp>/

Hard bans:
- No simulation.
- No smoke mode.
- No synthetic metrics.
- No synthetic screenshots.
- No mock/demo-only values.
- No fallback that silently fabricates rows.
- No _sim session IDs.
- No p95_latency_ms=0 accepted as PASS.
- No viewport_to_visible_latency_ms = p95_latency_ms alias.
- No generating final figures before validation passes.
- No mixing runs produced by different code versions.

Static audit before running:
Check and fix all files below:
- vrc-paper/experiments/run_experiment.mjs
- vrc-paper/analysis/analyze.py
- vrc-paper/client_instrument/vrc_scene.html
- vrc-paper/client_instrument/metric_collector.js
- vrc-paper/client_instrument/vrc_scheduler.js
- vrc-paper/server/sync_server.mjs
- vrc-paper/run_all.ps1

Search and remove/disable for PAPER_REAL_RUN:
simulate, simulation, synthetic, smoke, mock, fake, demo-only, random metric generation, Math.random metrics, np.random metrics, _sim session ids, simulate_metrics(), generate_synthetic_screenshots(), --simulate, --smoke, VRC_SMOKE.

Fail-fast rules:
- If no real browser launched: fail.
- If no real Spark scene loaded: fail.
- If no request_logs.jsonl: fail.
- If no client_logs.jsonl: fail.
- If no client_metrics.jsonl: fail.
- If no server/vrc_decisions log for VRC-family methods: fail.
- If chunk/request count is zero: fail.
- If p95 object/range latency is zero or missing: fail.
- If viewport-to-visible latency is not independently measured: mark it unavailable, do not alias it to p95.
- If screenshot is mostly sky/blank/blue: fail visual gate.
- If 4 users/avatars/peer markers are not visible in demo screenshot: fail visual gate.
- If any method/scenario/trial is missing: fail.
- If summary/figures are older than raw logs: fail provenance.

Metric definitions:
1. object_or_range_completion_ms:
   real browser-observed request/chunk completion latency from request_logs.jsonl, using service_time_ms or request_start to response_end.
   This may be used for p50/p95/p99 and fraction_over_50ms.
2. viewport_to_visible_latency_ms:
   only valid if independently measured from viewport demand timestamp to visible/render-ready chunk timestamp.
   If not independently available, output NA and do not plot it.
3. p95_latency_ms:
   must clearly state source:
   - source=request_logs for object/range completion latency, or
   - source=viewport_to_visible if truly measured.
4. fraction_over_50ms:
   computed from the same latency source as p95.
5. duplicate_request_ratio:
   computed from real URL+Range or object keys.
6. aggregate_client_bytes:
   computed from real request logs or browser transfer sizes.

Instrumentation fixes required before canary:
1. Install __sparkExpEvent stub before Spark module loads.
2. Drain buffered events in metric_collector.js.
3. Support actual Spark event types:
   fetch_enqueue
   fetch_response
   scheduler_decision
   plus fallback events from fetch interceptor.
4. Add fetch/XHR interceptor before Spark loads.
5. Record URL, Range header, request_start, response_start, response_end, status, bytes, user_id, method, scenario, trial, session_id.
6. Do not require Range header only; Spark may use .rad URL or forge-dev-public URL without Range.
7. Detect chunks by .rad, .spz, .splat, forge-dev-public, or Spark asset request pattern.
8. Do not label fetch-derived latency as viewport-to-visible latency.
9. Overlay should show object/range p95 if viewport-to-visible is unavailable.

Visual readiness gate:
Before screenshot, wait until:
- canvas exists
- real scene URL loaded
- FPS > 5 for at least 3 seconds
- request_log_count > 0
- chunk_request_count > 0
- non-background pixel ratio passes threshold
- screenshot is not mostly sky/blank/blue
- 4 users/avatars/peer markers are visible as either 3D markers or clear 2D overlay
- overlay shows method, user_id, peers=3, request/chunk count, object/range p95

Canary sequence:
Do not run full 72 runs until all canaries pass.

Canary 1: visual + logging
- method=Full
- scenario=nearby
- trial=1
- users=4
- full browser only
- no smoke
- no simulation
Must pass:
- 4 screenshots exist
- all screenshots non-blank
- real Coit Tower scene visible in at least 3/4 users
- 4 user/peer markers visible in composite or overlay
- request_logs.jsonl exists and RequestCount > 0
- chunk_request_count > 0
- object/range p95 > 0
- status.json PASS

Canary 2: baseline comparison
Run only:
- Full nearby t0
- Spark-MU nearby t0
- VRC nearby t0
Must pass:
- all PASS
- all have request_logs
- all have nonzero object/range p95
- VRC has vrc_decisions
- no _sim session IDs
- no p95=0
- no blank screenshots

Canary 3: scenario coverage
Run only:
- VRC nearby t0
- VRC burst_turn t0
- VRC divergent t0
Must pass:
- all scenarios produce valid logs, screenshots, chunk requests, and nonzero latency.

Only after Canary 1–3 pass:
Run clean full experiment from empty results_real_<timestamp>:
methods = Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC
scenarios = nearby,burst_turn,divergent
trials = 3
users = 4
Expected runs = 72.

For every run directory, save:
- config.json
- code_version.json with git hash or file hashes of changed JS/Python/PS1 files
- scenario.json
- status.json
- client_logs.jsonl
- client_metrics.jsonl
- request_logs.jsonl
- vrc_decisions.jsonl where applicable
- viewport_events.jsonl if available
- screenshots for u0,u1,u2,u3
- visual_check.json
- metric_source.json

Analysis requirements:
1. Analyze only results_real_<timestamp>/raw.
2. Do not read old invalid/debug directories.
3. If a required run is missing, fail analysis.
4. Generate:
   summary/metrics_summary.csv
   summary/per_run_metrics.csv
   summary/per_client_metrics.csv
   summary/vrc_decisions.csv
   summary/provenance_report.json
   figures/*.png
   RUN_STATUS.md
   PROVENANCE.md
   final_report.md
5. Every CSV/figure must list source raw files.
6. Every output timestamp must be later than source raw logs.
7. Report metric source clearly:
   object/range completion latency from request_logs
   viewport-to-visible latency only if independently measured
8. Do not claim VRC has highest QoE unless data proves it.
9. Do not claim VRC is faster than Full.
10. Do not claim CDN naturally exploits viewport overlap.
11. Mark Full as full-prefetch / latency lower-bound reference only.

Final output format only:
A. files changed
B. synthetic/smoke paths disabled
C. canary pass/fail table
D. full 72-run pass/fail table
E. visual validation summary
F. metric validation summary
G. provenance summary
H. final verdict:
   paper-ready / not paper-ready
I. exact command to reproduce

Do not write paper text. Do not make claims beyond validated data. Do not continue if canary fails. Fix, rerun the failing canary, then continue.