# VRC_AUTONOMOUS_EXPERIMENT_PROTOCOL

## Goal

Fully automate the real VRC Web3DGS experiment pipeline.

Claude must complete the whole workflow:
1. audit existing skills and scripts
2. fix invalid simulation/smoke paths
3. run canary gates
4. run the full real experiment
5. monitor progress
6. resume failed/missing runs
7. validate provenance
8. regenerate CSV and figures only from real logs
9. output final paper-readiness verdict

No paper writing until the experiment is validated.

## Required Skill

First read and follow:

D:\Program\spark-main\spark-main\.claude\skills\vrc-web3dgs-paper-pipeline\SKILL.md

Also inspect all available local skills under:

D:\Program\spark-main\spark-main\.claude\skills\

Borrow any useful patterns from existing skills, especially:
- artifact provenance
- experiment checkpointing
- figure regeneration
- validation gates
- reproducibility reports
- failure recovery

Do not copy irrelevant instructions blindly. The VRC real experiment protocol has priority.

## Hard Rules

- No simulation.
- No smoke mode.
- No synthetic metrics.
- No synthetic screenshots.
- No `_sim` session IDs.
- No `p95_latency_ms=0` accepted as PASS.
- No `viewport_to_visible_latency_ms = p95_latency_ms` alias.
- No mixed instrumentation batch as final result.
- No final figures before all validation gates pass.
- No old invalid/debug results used in summary.
- No paper claims beyond validated data.

## Current Known Problem

Previous runs were mixed/debug only:
- instrumentation was modified while the experiment was running
- earlier runs had `p95_latency_ms=0`
- request-log-derived latency was added after the runner already started
- screenshots sometimes showed blank/blue sky
- 4 avatars/peer markers were not clearly visible
- some metrics were previously synthetic or simulated

Therefore all current mixed/debug results must be isolated and must not be used as paper results.

## Autonomous State Files

Claude must maintain these files:

- `vrc-paper/RUN_STATE.json`
- `vrc-paper/RUN_STATUS.md`
- `vrc-paper/DEBUG_LOG.md`
- `vrc-paper/PROVENANCE.md`
- `vrc-paper/NEXT_ACTION.md`

After every major step, Claude must update these files.

`NEXT_ACTION.md` must always contain the exact next command to run if Claude stops.

## Required Scripts

Create or update these scripts:

- `vrc-paper/run_real_experiment_detached.ps1`
- `vrc-paper/monitor_real_experiment.ps1`
- `vrc-paper/resume_real_experiment.ps1`
- `vrc-paper/stop_vrc_experiment.ps1`
- `vrc-paper/validate_real_experiment.ps1`

## Process Management

Claude must not rely on long blocking `sleep` commands.

Use detached execution:
- Start the real experiment with `Start-Process`
- Redirect stdout and stderr to logs
- Write PID to `RUNNER_PID.txt`
- Return control after launch
- Monitor using `monitor_real_experiment.ps1`
- Resume using `resume_real_experiment.ps1`

## Output Directory

Use a clean real result directory:

`vrc-paper/results_real_<timestamp>/`

Move old debug or invalid results to:

`vrc-paper/results_debug_mixed_invalid_<timestamp>/`

Do not delete old logs.

## Canary Gates

Do not run the full 72-run experiment until all canaries pass.

### Canary 1: Visual and Logging

Run:

- method: `Full`
- scenario: `nearby`
- trial: `0`
- users: `4`
- full browser only

Pass conditions:
- 4 browser screenshots exist
- screenshots are not blank/blue
- real Spark2.0 Coit Tower scene visible in at least 3/4 screenshots
- peers or 4 user markers visible
- `request_logs.jsonl` exists
- request count > 0
- chunk/object request count > 0
- object/range p95 latency > 0
- no smoke
- no simulation
- no `_sim`

### Canary 2: Method Comparison

Run:

- `Full nearby t0`
- `Spark-MU nearby t0`
- `VRC nearby t0`

Pass conditions:
- all PASS
- all have nonzero object/range latency
- VRC has real `vrc_decisions.jsonl`
- no `_sim`
- no synthetic data
- screenshots pass visual check

### Canary 3: Scenario Coverage

Run:

- `VRC nearby t0`
- `VRC burst_turn t0`
- `VRC divergent t0`

Pass conditions:
- all scenarios load real scene
- all have request logs
- all have chunk/object requests
- all have nonzero latency
- all have screenshots
- all PASS

If any canary fails, fix the pipeline and rerun only the failing canary. Do not run the full experiment.

## Full Experiment

Only after Canary 1, 2, and 3 pass, run:

Methods:
- Full
- Spark-MU
- VP-S
- NET-S
- VRC-V
- VRC-N
- VRC-O
- VRC

Scenarios:
- nearby
- burst_turn
- divergent

Trials:
- 0
- 1
- 2

Users:
- 4

Expected total:
- 8 methods × 3 scenarios × 3 trials = 72 runs

## Per-Run Required Files

Every run directory must contain:

- `config.json`
- `code_version.json`
- `scenario.json`
- `status.json`
- `client_logs.jsonl`
- `client_metrics.jsonl`
- `request_logs.jsonl`
- `vrc_decisions.jsonl` for VRC-family methods where applicable
- `viewport_events.jsonl` if available
- screenshots for `u0`, `u1`, `u2`, `u3`
- `visual_check.json`
- `metric_source.json`

## Metric Rules

Use precise metric names.

### Allowed

`object_or_range_completion_ms`:
- derived from real browser request logs
- measured using `service_time_ms` or `request_start -> response_end`
- valid for p50, p95, p99, and fraction over 50 ms

`duplicate_request_ratio`:
- computed from real URL plus Range or object key

`aggregate_client_bytes`:
- computed from real browser transfer/request logs

### Not allowed

Do not call request-log-derived latency `viewport_to_visible_latency_ms`.

`viewport_to_visible_latency_ms` is valid only if independently measured from:
- viewport demand timestamp
to
- visible/render-ready chunk timestamp

If unavailable, write `NA`.

## Visual Check

Before accepting a screenshot:
- canvas exists
- FPS > 5 for at least 3 seconds
- request count > 0
- screenshot is not mostly blue/blank
- non-background pixel ratio passes threshold
- overlay shows method, user id, peers, request count, object/range p95
- 4 users or peer markers are visible in the demo view

## Validation

After full experiment:

Run validation and generate:

- `summary/metrics_summary.csv`
- `summary/per_run_metrics.csv`
- `summary/per_client_metrics.csv`
- `summary/vrc_decisions.csv`
- `summary/provenance_report.json`
- `figures/*.png`
- `RUN_STATUS.md`
- `PROVENANCE.md`
- `final_report.md`

Validation must fail if:
- fewer than 72 runs are PASS
- any required run is missing
- any run lacks request logs
- any run has zero object/range latency
- any screenshot fails visual check
- any `_sim` session id exists
- any summary or figure is older than source raw logs
- any output uses old debug/invalid directories

## Claims Guard

Do not claim:

- VRC has highest QoE unless data proves it
- VRC is faster than Full
- CDN naturally exploits viewport overlap
- request-log latency is viewport-to-visible latency
- Full is a practical baseline

Allowed only if validated:
- VRC reduces object/range completion latency versus practical baselines
- VRC reduces fraction over 50 ms
- VRC reduces duplicate requests or bytes
- VRC approaches Full-prefetch latency with lower traffic
- Full is a latency lower-bound reference

## Final Response Format

Claude must output only:

A. files changed  
B. canary pass/fail table  
C. detached runner PID and log path  
D. full 72-run pass/fail table  
E. validation summary  
F. provenance summary  
G. paper-ready or not paper-ready  
H. exact reproduce command  

No long explanations.