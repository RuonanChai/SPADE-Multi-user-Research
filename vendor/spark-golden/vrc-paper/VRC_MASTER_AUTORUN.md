# VRC_MASTER_AUTORUN.md

## Goal

Autonomously finish the real VRC Web3DGS experiment end-to-end.

Claude must not stop after one failed canary. Claude must automatically debug, fix, rerun, and continue until the clean real experiment is validated, unless hardware/network access is impossible.

Required skill:

D:\Program\spark-main\spark-main\.claude\skills\vrc-web3dgs-paper-pipeline\SKILL.md

## Hard Rules

1. No simulation.
2. No smoke mode.
3. No synthetic metrics.
4. No synthetic screenshots.
5. No `_sim` session IDs.
6. No old debug/mixed results for final CSV or figures.
7. No `P95=0` accepted as PASS.
8. No `chunk_request_count=0` accepted as PASS.
9. No black/blue/blank screenshots accepted as PASS.
10. No `viewport_to_visible_latency_ms = p95_latency_ms` alias.
11. Request-log latency must be named `object_or_range_completion_latency`.
12. `viewport_to_visible_latency_ms` is valid only if independently measured from viewport demand timestamp to visible/render-ready timestamp. Otherwise write `NA`.
13. Do not generate final CSV or figures until all canaries and validation pass.
14. Do not run the long experiment in Claude foreground.
15. Use detached/resumable PowerShell runners.

## Current Known Problems

Claude must automatically handle these problems:

- Current or previous batches may be mixed/debug and invalid.
- Screenshot can be black, blue, blank, or timeout.
- `canvas.toDataURL()` can save black images.
- `page.goto` can timeout.
- `page.screenshot` can timeout.
- Chrome profile/certificate/cache can fail.
- Stale Chrome/Node/Vite/sync-server processes can remain.
- Git Bash can corrupt Windows commands such as `taskkill /F`.
- P95 can be zero.
- Chunk/request count can be zero.
- Visual gate may incorrectly accept saved-but-invalid PNGs.
- Full experiment must not start before all canaries pass.

## Required Scripts

Create or update:

- `run_autonomous_pipeline_detached.ps1`
- `monitor_real_experiment.ps1`
- `resume_real_experiment.ps1`
- `stop_vrc_experiment.ps1`
- `validate_real_experiment.ps1`

The master script must be:

`run_autonomous_pipeline_detached.ps1`

It must run the whole pipeline automatically:

1. Stop and isolate current debug/mixed batch.
2. Kill only VRC-related Chrome/Node/Vite/sync-server processes.
3. Create clean `results_real_<timestamp>` directory.
4. Run Phase 0 audit.
5. Run Canary **1A** (metrics-only) then Canary **1B** (visual), in order.
6. If Canary 1A or 1B fails, debug, fix, rerun from a clean `VRC_RESULTS_ROOT`.
7. Run Canary 2 only after Canary 1A and 1B pass.
8. If Canary 2 fails, debug, fix, rerun Canary 2.
9. Run Canary 3 only after Canary 2 passes.
10. If Canary 3 fails, debug, fix, rerun Canary 3.
11. Run full 72-run experiment only after Canary **1A, 1B, 2, and 3** all pass.
12. Validate all 72 runs.
13. Regenerate CSV, figures, screenshots, final report only from clean real logs.
14. Write final provenance and paper-readiness verdict.

## Orchestrator gate sequence (authoritative)

`run_autonomous_pipeline_detached.ps1` runs this order **only after the previous gate passes** (each gate also runs `validate_real_experiment.ps1` on the same matrix):

| Gate | Name | What it proves | Screenshot / visual |
|------|------|------------------|----------------------|
| **Canary 1A** | `canary1a_metrics` | 4 real users, Full + nearby, request/client metrics, object-range P95 &gt; 0 (per validator) | **No** — `VRC_CAPTURE_MODE=metrics_only` |
| **Canary 1B** | `canary1b_visual` | Same matrix with full capture; PNGs valid; supports fig1 / demo path in analysis | **Yes** — strategy ladder (parallel headless → sequential headless → sequential headful) |
| **Canary 2** | `canary2` | Methods **Full, Spark-MU, VRC** on **nearby** | **Yes** — same visual ladder |
| **Canary 3** | `canary3` | Method **VRC** on **nearby, burst_turn, divergent** | **Yes** — same visual ladder |
| **Full** | `full` | **72 runs** — 8 methods × 3 scenarios × 3 trials, 4 users each | Per `VRC_CAPTURE_MODE` default for full runs |

After the full matrix validates, the script runs aggregation (`aggregate_metrics.py`, `plot_figures.py`, `generate_report.py`) when present.

### RunPhase / ExitCode (Windows)

Child `node` is started with `Start-Process` on either `experiments/run_experiment.mjs` (single-machine) or `experiments/run_experiment_distributed.mjs` (when `experiments/distributed_lab.json` exists — see `RUNBOOK.md` § Step 6). On some hosts `Process.ExitCode` stays unset until `WaitForExit` and a short flush delay; `$null -ne 0` in PowerShell used to mark **false failures**. `RunPhase` waits, refreshes, and if needed parses stdout for **`Experiment runner complete: … non-PASS`** (single runner) or **`Done: M/N PASS`** (distributed) so a successful run is not rejected when the OS exit code is late.

### How to re-test after a fix

1. Pick a **fresh** results directory (or delete the halted run tree if you intentionally reuse it):
   - `$env:VRC_RESULTS_ROOT = "D:\...\vrc-paper\results_YYMMDD"` (absolute path recommended on Windows).
2. Kill strays (or let phase 0 do it): only node/chrome tied to `vrc-paper`, ports 9200/9201, `run_experiment`, `run_experiment_distributed`, `sync_server`, `vite`, Playwright.
3. Launch master **detached** from `vrc-paper` (PowerShell):

```powershell
cd D:\Program\spark-main\spark-main\vrc-paper
$env:VRC_RESULTS_ROOT = "$(Resolve-Path .\results_retest_$(Get-Date -Format yyyyMMdd_HHmmss))"
Start-Process powershell -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path (Get-Location) 'run_autonomous_pipeline_detached.ps1')
) -WindowStyle Normal
```

4. Watch `RUN_STATUS.md`, `RUN_STATE.json`, `NEXT_ACTION.md`, and `runner_logs\orchestrator_*.out.log`. Expect **`canary1a_metrics` PASS** before **1B** starts; then 2, 3, then `full_experiment`.
5. If a gate fails for a **real** reason (validation, black screenshots, P95=0), fix code or env per `REAL_EXPERIMENT_DEBUG_PROTOCOL.md`, then re-launch with a new `VRC_RESULTS_ROOT` (or follow `NEXT_ACTION.md`).

### Claude Code: auto-debug then continue full pipeline

1. Read `NEXT_ACTION.md` and the latest `runner_logs\orchestrator_*.out.log` and the failing phase `runner_logs\<phase>_*.out.log` / `.err.log`.
2. If the failure is **orchestrator / validation / browser / metrics** — patch, then **restart the master script** (do not ask the user to babysit long runs in chat).
3. Do **not** skip canaries to jump to the 72-run full matrix; the script enforces order.
4. After all gates green, confirm `VALIDATION_REPORT.md` and `summary\run_pass_fail.csv` for the full matrix before treating paper outputs as final.

## State Files

Maintain and update after every phase:

- `RUN_STATE.json`
- `RUN_STATUS.md`
- `DEBUG_LOG.md`
- `PROVENANCE.md`
- `NEXT_ACTION.md`
- `RUNNER_PID.txt`

If interrupted, resume from `RUN_STATE.json` and `NEXT_ACTION.md`.

## Detached Execution

Use `Start-Process` to launch the master orchestrator.

Write logs to:

- `runner_logs\orchestrator_<timestamp>.out.log`
- `runner_logs\orchestrator_<timestamp>.err.log`

Claude must return immediately after launching the master orchestrator.

Do not keep Claude waiting with long blocking `sleep` commands.

From **spark-main** repository root, use `scripts/README_VRC_EXPERIMENT.md` and npm scripts `vrc:paper:*` (orchestrator detached, 24h autopilot, paper bundle).

## Environment Rules

Use PowerShell for Windows process/path operations.

Do not use raw `taskkill /F` inside Git Bash.

Correct process cleanup should use PowerShell, for example:

```powershell
Get-CimInstance Win32_Process |
Where-Object {
  $_.Name -match "node.exe|chrome.exe" -and
  $_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server"
} |
ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
```
Fake Path Audit

Before canaries, search and hard-disable active paths containing:

simulate
simulation
synthetic
smoke
mock
fake
demo-only
random metric generation
Math.random metrics
np.random metrics
_sim
simulate_metrics()
generate_synthetic_screenshots()
--simulate
--smoke
VRC_SMOKE

Do not delete documentation comments unless needed. Disable executable fake paths.

Metric Rules

Allowed:

object_or_range_completion_p50_ms
object_or_range_completion_p95_ms
object_or_range_completion_p99_ms
fraction_over_50ms
duplicate_request_ratio
aggregate_client_bytes

These must come from real browser/request logs.

Not allowed:

request-log latency labeled as viewport_to_visible_latency_ms
viewport_to_visible_latency_ms = p95_latency_ms
P95=0 accepted as valid

If viewport-to-visible is not independently measured, write:

"viewport_to_visible_latency_ms": "NA",
"viewport_to_visible_latency_source": "not_independently_measured"
Visual Validation

Every saved screenshot must be validated by pixel statistics.

Compute:

black_ratio
blue_ratio
white_ratio
flat_color_ratio
non_background_ratio
screenshot_valid
failure_reason

Fail screenshot if:

black_ratio > 0.80
blue_ratio > 0.80
non_background_ratio < 0.10
image is mostly one flat color
canvas exists but image is black
overlay or peer/user marker is missing when required

Saving a PNG is not enough. Saved black/blue images are FAIL.

Visual Debug Strategy

If visual canary fails, automatically fix and rerun:

Use fresh isolated userDataDir per run/user.
Add Chromium flags:
--ignore-certificate-errors
--disable-web-security
--use-gl=angle
--use-angle=d3d11
--disable-dev-shm-usage
--no-sandbox
Add visual-ready gate:
canvas exists
canvas width/height > 0
real request logs exist
.rad, .spz, .splat, or forge-dev-public requests exist
object/chunk request count > 0
FPS > 5 for at least 3 seconds
non-background pixel ratio passes threshold
overlay shows method, user id, peers, request count, object/range p95
Prefer browser viewport screenshot.
Use canvas.toDataURL() only as fallback and only if pixel validation passes.
If 4-user visual canary fails, run 1-user visual canary first, fix, then rerun 4-user canary.
Canary Phases
Phase 0: Audit

Pass conditions:

old debug/mixed results isolated
stale VRC processes killed
clean real result directory active
fake/smoke/simulation paths disabled
state files created
detached scripts created
Phase 1: 1-user visual canary

Run:

method: Full
scenario: nearby
trial: 0
users: 1

Pass conditions:

real browser launched
real Spark2.0 page loaded
request logs exist
object/chunk request count > 0
object/range P95 > 0
screenshot valid, not black/blue/blank
no _sim
status PASS
Phase 2: 4-user visual canary

Run:

method: Full
scenario: nearby
trial: 0
users: 4

Pass conditions:

4 users connect
4 screenshots exist
at least 3/4 screenshots show real scene
peer/avatar markers visible or overlay clearly shows 4 users/peers
request logs valid
object/range P95 > 0
no _sim
status PASS
Phase 3: method canary

Run:

Full nearby t0
Spark-MU nearby t0
VRC nearby t0
users: 4

Pass conditions:

all PASS
request logs valid
object/range P95 > 0
VRC has real vrc_decisions.jsonl
screenshots valid
no _sim
Phase 4: scenario canary

Run:

VRC nearby t0
VRC burst_turn t0
VRC divergent t0
users: 4

Pass conditions:

all scenarios load
request logs valid
screenshots valid
object/range P95 > 0
no _sim
Full Experiment

Only after all canaries pass:

Methods:

Full
Spark-MU
VP-S
NET-S
VRC-V
VRC-N
VRC-O
VRC

Scenarios:

nearby
burst_turn
divergent

Trials:

0
1
2

Users:

4

Expected runs:

72
Per-Run Required Files

Every run must contain:

config.json
code_version.json
scenario.json
status.json
client_logs.jsonl
client_metrics.jsonl
request_logs.jsonl
vrc_decisions.jsonl where applicable
screenshots
visual_check.json
metric_source.json
Full Validation

Fail and auto-debug/resume if:

fewer than 72 PASS runs
any run missing status
any run missing request logs
any run missing client logs
any run missing metrics
any run has object/chunk request count = 0
any run has object/range P95 <= 0
any screenshot invalid
any _sim session id exists
any old/debug directory is used
any output timestamp older than raw logs
any request-log p95 is aliased as viewport-to-visible latency

Resume behavior:

valid PASS runs are skipped
missing/failed/warn/invalid runs are rerun
never delete valid completed runs
Final Outputs

After validation:

summary/metrics_summary.csv
summary/per_run_metrics.csv
summary/per_client_metrics.csv
summary/vrc_decisions.csv
figures/*.png
screenshots/*
RUN_STATUS.md
PROVENANCE.md
final_report.md
reproduce command
Claims Guard

Do not claim:

VRC has highest QoE unless data proves it
VRC is faster than Full
CDN naturally exploits viewport overlap
request-log latency is viewport-to-visible latency
Full is a practical baseline

Allowed if validated:

VRC reduces object/range completion latency versus practical baselines
VRC reduces fraction over 50 ms
VRC reduces duplicate requests or bytes
VRC approaches Full-prefetch latency with lower traffic
Full is a latency lower-bound reference
Final Claude Output

After launching the master orchestrator, output only:

A. orchestrator PID
B. stdout log path
C. stderr log path
D. monitor command
E. resume command
F. stop command
G. NEXT_ACTION.md content
H. safe-to-leave yes/no

Do not only launch Canary 1.
Do not wait in Claude foreground.
The master orchestrator must continue through debug, canaries, full 72 runs, validation, and report generation automatically.

## Demo / Paper Evidence Requirements

The experiment must generate real 4-user visual evidence, not only metrics.

Save these outputs under:

D:\Program\spark-main\spark-main\vrc-paper\results_260512

Required demo outputs:

1. `demo_urls.json`
   Must include the real browser URL for each user:
   - u0
   - u1
   - u2
   - u3

   Each URL must include:
   - method
   - scenario
   - user_id
   - run_id/session_id
   - sync server URL or port
   - scene/world identifier

2. Per-user screenshots:
   - `screenshots\<session_id>_u0.png`
   - `screenshots\<session_id>_u1.png`
   - `screenshots\<session_id>_u2.png`
   - `screenshots\<session_id>_u3.png`

   Each screenshot must pass pixel-level visual validation.

3. Demo composite figure:
   - `figures\fig1_demo_screenshot.png`

   This figure must show:
   - real Spark2.0 streaming-lod scene
   - four synchronized users
   - user/peer markers or avatars
   - camera frustums
   - shared/personalized/late range overlays if available
   - metric panel with method, scenario, request count, object/range P95, duplicate ratio, bytes

4. Avatar / peer marker rule:
   The scene dataset must remain `examples\streaming-lod`.
   Avatars, frustums, and markers may be rendered only as overlay or Three.js helper objects.
   Do not introduce a new glTF world, game scene, or external dataset.

5. Visual proof rule:
   A run is not presentation-ready unless:
   - all four user screenshots exist
   - at least 3/4 show real non-background scene content
   - peer/avatar markers are visible
   - visual_check.json passes
   - demo_urls.json exists
   - fig1_demo_screenshot.png exists

6. Metric completeness rule:
   The final results must include:
   - `summary\per_run_metrics.csv`
   - `summary\per_client_metrics.csv`
   - `summary\metrics_summary.csv`
   - `summary\vrc_decisions.csv`
   - `summary\run_pass_fail.csv`

   Required metric columns:
   - method
   - scenario
   - trial
   - user_id
   - session_id
   - p50_latency_ms
   - p95_latency_ms
   - p99_latency_ms
   - p95_latency_source
   - object_or_range_completion_p95_ms
   - fraction_over_50ms
   - duplicate_request_ratio
   - aggregate_client_bytes
   - unique_bytes
   - shared_bytes
   - personalized_bytes
   - fps
   - stall_time
   - visible_quality
   - qoe
   - request_count
   - chunk_request_count
   - visual_status
   - screenshot_valid
   - run_status

7. Metric source rule:
   Every metric CSV must include a metric source or provenance field.
   If viewport-to-visible latency is not independently measured, keep:
   `viewport_to_visible_latency_ms = NA`
   and do not plot it as real viewport-to-visible latency.

8. Paper-readiness rule:
   Final status can be `paper-ready` only if:
   - all 72 runs PASS
   - all required CSVs exist
   - all required figures exist
   - fig1_demo_screenshot.png is visually valid
   - demo_urls.json exists
   - no run uses debug/invalid/synthetic data