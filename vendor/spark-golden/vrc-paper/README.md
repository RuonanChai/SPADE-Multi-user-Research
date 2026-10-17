# VRC — Viewport-aware Range Coordination for Multi-user Web 3DGS

## One-command run

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File vrc-paper\run_all.ps1
```

```bash
# Linux / macOS / Git Bash
bash vrc-paper/run_all.sh
```

## What it does

1. Starts a Vite dev server serving the Spark streaming-lod scene (port 9200)
2. Starts the VRC sync server (port 9201)
3. Launches 4 browser clients per trial via Playwright
4. Runs all methods × scenarios × trials
5. Collects metrics, generates CSVs and figures

## Scene

`examples/streaming-lod` — Coit Tower, SF — 40M splats (Spark 2.0 streaming-LoD).
No other dataset is used.

## Methods

| Label | Description |
|-------|-------------|
| Full | Full-scene preload per user |
| Spark-MU | Independent Spark 2.0 streaming (no coordination) |
| VP-S | Viewport-priority ordering, no pacing |
| NET-S | Network-paced, no viewport coordination |
| VRC-V | Viewport overlap only |
| VRC-N | Network pacing only |
| VRC-O | Object-level coordination |
| VRC | Full method |

## Outputs

```
vrc-paper/results/
  summary/
    metrics_summary.csv
    per_run_metrics.csv
    per_client_metrics.csv
    vrc_decisions.csv
    all_methods_overview.csv
  figures/
    fig1_demo_screenshot.png  ... fig_appendix_all_methods_overview.png
  screenshots/
  final_report.md
```

## Requirements

- Node.js >= 18
- Python >= 3.9
- Internet access (scene assets are loaded from Google Cloud Storage)

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VRC_METHODS` | all 8 | Comma-separated method list |
| `VRC_SCENARIOS` | `nearby,burst_turn,divergent` | Scenarios to run |
| `VRC_TRIALS` | `1` | Trials per cell |
| `VRC_TRIAL_DURATION_MS` | `30000` | Duration per trial in ms |
| `VRC_HEADLESS` | `true` | `false` to see browser windows |
| `VITE_PORT` | `9200` | Vite port |
| `VRC_SYNC_PORT` | `9201` | Sync server port |
