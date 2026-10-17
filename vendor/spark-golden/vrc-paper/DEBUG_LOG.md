# DEBUG_LOG.md

All build/runtime errors, fixes, and final status are recorded here.

---

## 2026-05-07 — Initial scaffolding

### Files created (no original Spark files modified)

| File | Description |
|------|-------------|
| `vrc-paper/CLAUDE.md` | Project rules and constraints |
| `vrc-paper/server/sync_server.mjs` | Lightweight WebSocket sync server + VRC coordinator |
| `vrc-paper/server/package.json` | Server package (only `ws` dependency) |
| `vrc-paper/client_instrument/vrc_config.js` | QoE weights + tunable parameters |
| `vrc-paper/client_instrument/vrc_scheduler.js` | Fetch interceptor implementing all 8 methods |
| `vrc-paper/client_instrument/metric_collector.js` | `window.__sparkExpEvent` hook + metrics collector |
| `vrc-paper/client_instrument/avatar_overlay.js` | Peer avatar + frustum canvas overlay |
| `vrc-paper/client_instrument/vrc_scene.html` | Instrumented page wrapping original streaming-lod |
| `vrc-paper/experiments/run_experiment.mjs` | Playwright multi-client orchestration |
| `vrc-paper/analysis/analyze.py` | CSV + figure generation (simulates if no real data) |
| `vrc-paper/run_all.ps1` | One-command PowerShell pipeline |
| `vrc-paper/run_all.sh` | One-command Bash pipeline |
| `vrc-paper/README.md` | Quick-start instructions |
| `vrc-paper/RUNBOOK.md` | Step-by-step operation guide |

### Original Spark files status

**NOT MODIFIED.** All instrumentation is via:
1. `window.__sparkExpEvent` hook already present in `src/SplatPager.ts:26`
2. `fetch()` interception in `vrc_scheduler.js`
3. Separate `vrc_scene.html` that imports original `dist/spark.module.js`

### Known requirements

- Node.js >= 18
- Python >= 3.9 (for analysis)
- `matplotlib` (auto-installed by analysis script)
- `ws` npm package (auto-installed in server/)
- Playwright chromium (auto-installed by experiment runner)

### Port assignments

| Service | Port |
|---------|------|
| Vite dev server | 9200 (default; override `VITE_PORT`) |
| VRC sync server | 9201 (default; override `VRC_SYNC_PORT`) |

If ports conflict, runner kills old process automatically and documents here.

## 2026-05-07 — Analysis smoke test

### Issue: matplotlib not available in MSYS2/MinGW Python

The default Python in the shell environment (`D:/Download/MinGW-W64/ucrt64/bin/python3.exe`)
has no pip and SSL issues.

**Fix**: Found working Python 3.9.21 with pip at:
`C:\Users\IoT\安装路径\环境名\python.exe`

Installed matplotlib:
```
C:\Users\IoT\安装路径\环境名\python.exe -m pip install matplotlib
```

Updated run_all.ps1 and run_all.sh to auto-detect this Python.

### Issue: Invalid matplotlib color code `#fa033` (3-char hex + alpha suffix)

`facecolor="#fa0"+"33"` produces 7-char hex `#fa033` which matplotlib rejects.

**Fix**: Expanded all 3-char hex colors to 6-char in analysis/analyze.py.
Changed `col+"33"` patterns to use pre-expanded 6-char colors.
Changed `FancyBboxPatch` edgecolor/facecolor to `#ffaa00`.

### Smoke test result: PASS

All 10 figures generated:
- fig1_demo_screenshot.png ✓
- fig2_vrc_workflow.png ✓
- fig3_p95_latency.png ✓
- fig4_fraction_over_50ms.png ✓
- fig5_duplicate_ratio.png ✓
- fig6_bytes_breakdown.png ✓
- fig7_completion_cdf.png ✓
- fig8_ablation.png ✓
- fig9_mtp_timeline.png ✓
- fig_appendix_all_methods_overview.png ✓

All 4 CSVs generated with 288/24/72/24 rows respectively.

### Status: Analysis pipeline verified with simulated data ✓


- run_all.ps1 started at 05/07/2026 22:01:15
- run_all.ps1 started at 05/07/2026 22:11:24

## 2026-05-09 — Real Experiment Rewrite

### Changes made (simulation fallback DISABLED)

| File | Change |
|------|--------|
| `vrc-paper/experiments/run_experiment.mjs` | Fully rewritten: smoke mode FATAL exit, all 4 user pages launched with real Playwright Chromium, per-run dir with config.json/client_logs.jsonl/request_logs.jsonl/vrc_decisions.jsonl/status.json/client_metrics.jsonl, also writes flat *_metrics.jsonl for analyze.py |
| `vrc-paper/analysis/analyze.py` | Fully rewritten: --simulate flag now exits(1), simulate_metrics() removed, generate_screenshots() removed, provenance check added (outputs must be newer than raw logs), fails hard if no raw data found |
| `vrc-paper/run_all.ps1` | Fully rewritten: default 3 trials, all 8 methods, 3 scenarios, VRC_SMOKE=0 set, no --simulate passed to analyze.py, backs up any existing results/raw before run |
| `vrc-paper/client_instrument/metric_collector.js` | Added __vrcDecisionLog accumulation array for per-run VRC decision capture |

### Invalid synthetic results

The directory `vrc-paper/results_synthetic_invalid_20260507/` contains all synthetic data from
the prior smoke-only run. It must NOT be used for paper figures or CSV. It remains as backup
reference only. Label: INVALID SYNTHETIC DATA.

### Hard requirements enforced

- Real Playwright/Chromium: YES (run_experiment.mjs exits 2 if smoke/VRC_SMOKE flags detected)
- Simulation fallback: DISABLED (analyze.py exits 1 on --simulate or missing data)
- Screenshot synthesis: DISABLED (analyze.py only composites real browser screenshots)
- Provenance check: ADDED (provenance_report.json, outputs must be newer than logs)
- Methods: Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC (8 methods)
- Scenarios: nearby,burst_turn,divergent (3 scenarios)
- Trials: 3 (expected 72 runs total)

### Chromium status

Playwright 1.59.1 installed at D:/Program/spark-main/spark-main/node_modules/playwright
Chromium browser cache: C:/Users/IoT/AppData/Local/ms-playwright/chromium-1217

### Spark scene URL

http://localhost:9200/vrc-paper/client_instrument/vrc_scene.html
Scene asset: https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad
(Spark 2.0 streaming-lod, 40M splats, Coit Tower SF — real Web3DGS scene)

### Remaining limitations (to address if metrics are zero)

1. window.__sparkExpEvent hook: Spark SplatPager.ts calls it only if it exists at the time
   chunks are loaded. The VRC client page injects metric_collector.js AFTER Spark loads —
   some chunk events may fire before the hook is installed.
   FIX: If p95_latency_ms is 0 for all methods, move metric_collector.js before the Spark module
   script tag (Steps 3→Step 6 swap), or hook via fetch interceptor timing.

2. Scene requires internet access (CDN URL). If offline, chunk events won't fire.
   FIX: Pre-cache or use local proxy if network unavailable.

3. FPS metric measured by our own RAF polling loop. May differ from Spark's internal FPS.

4. Chunk IDs derived from URL pattern lod-(\d+). If Spark uses different URL patterns,
   getPriority() returns 0 (no coordination) for all methods. Still produces timing data.
- run_all.ps1 REAL MODE started at 05/09/2026 16:31:19
- Old invalid synthetic results remain at: D:\Program\spark-main\spark-main\vrc-paper\results_synthetic_invalid_20260507 (DO NOT USE)

# Orchestrator run 20260509_183215 (pid=31180)


## 2026-05-09 18:50 — Visual validator overhaul

- Bug: old visual_check.json only checked file existence + bytes + suspicious_blank.
  Black PNGs (1280x720, ~20KB) passed. Canary 1 was wrongly accepted.
- Fix: added vrc-paper/experiments/visual_validator.mjs with pixel-level
  decode (pngjs). Computes black_ratio / blue_ratio / white_ratio /
  flat_color_ratio / non_background_ratio / mean_luma / luma_std.
  Fail thresholds: black>0.80, blue>0.80, non_background<0.10,
  luma_std<5, flat_color>0.90.
- run_experiment.mjs now uses buildVisualCheck(); runStatus becomes
  FAIL_VISUAL_BLACK_SCREEN if any user fails.
- Browser launch overhauled: launchPersistentContext per user with fresh
  os.tmpdir() userDataDir; Chrome flags --ignore-certificate-errors,
  --disable-web-security, --use-gl=angle, --use-angle=d3d11, --enable-webgl,
  --allow-running-insecure-content.
- Visual-ready gate added: poll for canvas+w+h>0, then 20 RAFs before screenshot.
- Browser viewport screenshot is preferred; canvas.toDataURL fallback only
  kept if pixel validation passes.
- Revalidation pass over existing 3 canary runs: all marked
  FAIL_VISUAL_BLACK_SCREEN (0/4 users valid).
- validate_real_experiment.ps1 now reads visual_check.json and emits
  VISUAL_FAIL:<reasons>.

# Orchestrator run 20260509_185659 (pid=15652)

## 2026-05-09T19:27:04 [canary1] timeout after 30 min
## 2026-05-09T19:57:17 [canary1] timeout after 30 min
## 2026-05-09T20:27:30 [canary1] timeout after 30 min
