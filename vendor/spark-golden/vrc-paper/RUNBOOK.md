# RUNBOOK.md — VRC Experiment Operations

## Prerequisites

```bash
node --version    # >= 18
python3 --version # >= 3.9
```

## Step 1 — Install dependencies

```bash
# Repo root
npm install

# Sync server
cd vrc-paper/server && npm install && cd ../..
```

## Step 2 — (Optional) Run analysis only with simulated data

If you want to verify figures without running browsers:

```bash
python3 vrc-paper/analysis/analyze.py --simulate
```

This generates all CSVs and figures using reproducible synthetic data.

## Step 3 — Full pipeline

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File vrc-paper\run_all.ps1
```

```bash
# Unix
bash vrc-paper/run_all.sh
```

## Step 4 — Quick subset run (faster)

```bash
VRC_METHODS="Spark-MU,VRC" VRC_SCENARIOS="nearby" VRC_TRIALS=1 \
VRC_TRIAL_DURATION_MS=15000 bash vrc-paper/run_all.sh
```

## Step 5 — Show browser windows

```bash
VRC_HEADLESS=false bash vrc-paper/run_all.sh
```

## Viewing results

```
vrc-paper/results/figures/fig3_p95_latency.png      ← main latency result
vrc-paper/results/figures/fig8_ablation.png          ← ablation
vrc-paper/results/summary/metrics_summary.csv        ← all aggregated numbers
vrc-paper/results/final_report.md                    ← paper-ready summary
```

## Troubleshooting

### Port already in use

The pipeline automatically kills processes on ports 9200/9201.
To use different ports:
```bash
VITE_PORT=9210 VRC_SYNC_PORT=9211 bash vrc-paper/run_all.sh
```

### Playwright browser not installed

```bash
npx playwright install chromium --with-deps
```

### Scene doesn't load (network error)

The streaming-lod scene fetches `.rad` files from Google Cloud Storage.
Ensure internet access is available. The scene URL is in `vrc_scene.html`.

### Python matplotlib missing

```bash
pip install matplotlib
```

### No real browser data

Run `analysis/analyze.py --simulate` to produce synthetic-but-realistic figures
for all 8 methods. This is the fallback if browser automation fails.

## File manifest

```
vrc-paper/
  CLAUDE.md              Project rules
  README.md              Quick start
  RUNBOOK.md             This file
  DEBUG_LOG.md           Error/fix log
  run_all.ps1            Windows one-command pipeline
  run_all.sh             Unix one-command pipeline
  server/
    sync_server.mjs      WebSocket sync + VRC coordinator
    package.json
  client_instrument/
    vrc_config.js        QoE weights + parameters
    vrc_scheduler.js     fetch() interceptor (all 8 methods)
    metric_collector.js  Metric accumulator + sync client
    avatar_overlay.js    Peer avatar canvas overlay
    vrc_scene.html       Instrumented Spark scene page
  experiments/
    run_experiment.mjs              Playwright 4-client (single OS) orchestration
    run_experiment_distributed.mjs  Two-machine: u0–u1 local + u2–u3 over SSH + merge
    vrc_distributed_merge.mjs       Merge shard outputs → final status / visual_check
    distributed_lab.example.json    Copy → distributed_lab.json for distributed runs
  analysis/
    analyze.py           CSV + figure generation
  results/
    raw/                 Per-session JSONL logs
    summary/             Aggregated CSVs
    figures/             PNG figures
    screenshots/         Per-trial screenshots
```

## Step 6 — Autonomous detached orchestrator (Windows)

Long-running gates (canaries, prefull, optional full 72-run) are driven by:

```powershell
powershell -ExecutionPolicy Bypass -File vrc-paper\run_autonomous_pipeline_detached.ps1
```

Set `VRC_RESULTS_ROOT` to an absolute path for outputs. See `VRC_MASTER_AUTORUN.md` for canary semantics and `NEXT_ACTION.md` / `RUN_STATE.json` under that results tree.

### Two-machine (2+2) default when `distributed_lab.json` exists

1. Copy `vrc-paper/experiments/distributed_lab.example.json` → `vrc-paper/experiments/distributed_lab.json` and set `controller_host`, `ssh_user`, `ssh_host`, `ssh_key_path`, `remote_repo_path`, `remote_results_root` (same meanings as in `CLAUDE.md`).
2. Ensure OpenSSH `ssh` / `scp` are on `PATH`, Worker2 can reach `http://<controller_host>:9200` and `ws://<controller_host>:9201`, and the key is authorized on Worker2.
3. With that file present, **detached orchestrator phases automatically invoke** `run_experiment_distributed.mjs` instead of `run_experiment.mjs` (no `--full` flag; the distributed script runs the full method/scenario/trial matrix from env).
4. To **force single-machine** four browsers on the controller only:

```powershell
$env:VRC_USE_DISTRIBUTED = "0"
powershell -ExecutionPolicy Bypass -File vrc-paper\run_autonomous_pipeline_detached.ps1
```

5. To **force distributed** even if you keep the config elsewhere:

```powershell
$env:VRC_USE_DISTRIBUTED = "1"
$env:VRC_DISTRIBUTED_CONFIG = "D:\path\to\my_distributed_lab.json"
```

### Direct distributed run (without detached orchestrator)

From **spark-main** repo root (same as `package.json`):

```powershell
$env:VRC_RESULTS_ROOT = "D:\...\vrc-paper\results_dist_20260513"
node vrc-paper/experiments/run_experiment_distributed.mjs
```

Optional: `VRC_METHODS`, `VRC_SCENARIOS`, `VRC_TRIALS`, `VITE_PORT`, `VRC_SYNC_PORT` — same as the single-machine runner.

## QoE formula

```
qoe = visible_quality - alpha * latency_norm - beta * stall_ratio
alpha = 0.4   (in vrc_config.js)
beta  = 0.2   (in vrc_config.js)
latency_norm = min(1, p95_ms / 1000)
```
