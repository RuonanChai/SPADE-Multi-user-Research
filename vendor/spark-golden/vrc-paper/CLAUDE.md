# CLAUDE.md
For the current real experiment run, vrc-paper\VRC_MASTER_AUTORUN.md overrides this file whenever there is a conflict.

**Claude Code / Cursor orchestration:** Role pointer only in **`../.claude/主智能体提示词.md`**. All stage commands, acceptance gates, env, and Full-72 detached flow are in **§「Unattended agent mode」** and **§「Autonomous pipeline: Canary → Full 72」** below (plus **§「Claude Code: Dual-CDN distributed pipeline」** for H1–H6 detail). **Auto-Advance** + **Unattended** are mandatory; they do not waive log-first edits or anti–vibe-coding rules below.
Project: VRC = Viewport-aware Range Coordination for Multi-user Web 3DGS.

Repo root:
D:\Program\spark-main\spark-main

Only dataset / visual scene:
examples\streaming-lod

Do not introduce another dataset, glTF world, or game scene. Four avatars, camera frustums, tile/range grids, and visual overlays are allowed only for synchronization, debugging, and screenshots.

Research goal:
Build a SIGCOMM/NSDI-style experimental pipeline showing that existing multi-user Web 3DGS delivery lacks cross-user viewport/range coordination. Existing multiplayer layers can synchronize user state, but they do not coordinate viewport-driven 3DGS object/range demand. Without reuse, overlapping multi-user viewport demand causes duplicate range/object requests and tail viewport-to-visible-content latency. VRC coordinates shared and personalized range demand across users to reduce duplicate transfer and keep visible content updates within an interactive target.

Core claim to validate:
Without multi-user viewport/range reuse, independent viewport delivery creates duplicate demand and can push tail viewport-to-visible-content latency beyond 50 ms under overlapping multi-user demand. VRC reduces duplicate transfer, object/range completion time, and P95/P99 viewport-to-visible-content latency.

System:
- Spark 2.0 examples/streaming-lod renders the only 3DGS scene.
- Four browser users join the same scene.
- A sync server synchronizes user_id, avatar position, rotation, camera pose, viewport/frustum, and decision_step.
- VRC coordinator collects viewport demand and computes shared/personalized object/range demand.
- All baselines and ablations use the same Spark streaming-lod scene and the same derived object/range/chunk units.

## Local Multi-machine Setup

来源：`scripts/distributed-replay.config.json`（与 bench 分布式编排一致）。若实验室换机或改端口，请同步改该 JSON、`RUNBOOK.md`、`DEBUG_LOG.md`。

Worker1 / Controller（PC1 — 本机或编排机）:
- Role: Spark dev server, VRC coordinator, sync server, object proxy, user u1 and u2
- LAN IP: **10.4.158.143**（`client_server_url` 主机；PC2 / worker2 上的浏览器与其它客户端须用此地址访问 PC1 上的服务，勿用 `127.0.0.1`）
- 典型代理端口: **8092**（`proxy_port` / `client_server_url`）

Worker2（PC2 — SSH 远端 worker）:
- Role: browser users u3 and u4（Playwright / Chrome 跑在远端）
- LAN IP: **10.4.146.68**（`ssh_host`）
- SSH: **`Ruonan@10.4.146.68`**, port **22**
- 密钥（编排机侧路径）: **`C:/Users/IoT/.ssh/id_ed25519_spark_bench`**
- 远端仓库路径: **`D:/Program Files/Spark-main`**
- 远端输出根目录: **`D:/SparkRuns`**

从 Worker1 登录 Worker2 示例:

```bash
ssh -i "C:/Users/IoT/.ssh/id_ed25519_spark_bench" -p 22 Ruonan@10.4.146.68
```

Client access URLs（Worker2 浏览器指向 Worker1）:
- Spark / 示例页（经 instrumented 代理时，与 bench 一致）: `http://10.4.158.143:8092`
- Sync server URL: `ws://10.4.158.143:<SYNC_PORT>`（端口以 `vrc-paper` 实际启动为准；若与 HTTP 同域不同端口请分开写）
- Object / range proxy URL: `http://10.4.158.143:8092`（若 VRC 单独起代理，替换端口）

其它 bench 配置（非本机 LAN，仅作对照）:
- `upstream_origin`: `http://10.120.17.176:8090`
- `r2_public_origin`（直连 CDN 实验）: `https://sparkjs.dev`

HPC 直出（`VRC_HPC_ASSET_BASE`，默认 `http://10.120.17.176:8090`）与 **`python3 -m http.server`**：文档根必须是 **`spark-main/examples`**（`streaming-lod` 的父目录），这样 **`/streaming-lod/coit-40m-sh1-lod.rad`** 才与 runner/preflight 约定一致。若在仓库根起服，须将 **`VRC_HPC_ASSET_BASE`** 设为带 **`/examples`** 后缀的根，或改 `cd` 到 `examples` 再起 8090。详见 **`vrc-paper/benches/dual_origin_public/RUNBOOK_DUAL_ORIGIN.md`**「HPC 上直出 server」一节。

Rules:
- Bind servers to `0.0.0.0`, not only `localhost`.
- Worker2 浏览器必须连接 **Worker1 的 LAN IP（10.4.158.143）**，不得使用 **127.0.0.1** 访问 PC1 上的服务。
- If ports change, update `scripts/distributed-replay.config.json`, `RUNBOOK.md`, and `DEBUG_LOG.md`.

Distributed two-PC experiment (forced u0–u1 on controller, u2–u3 on Worker2):

- Copy `vrc-paper/experiments/distributed_lab.example.json` → `distributed_lab.json` and set `controller_host`, `ssh_*`, `remote_repo_path`, `remote_results_root`.
- Controller must run Vite (`0.0.0.0:vite_port`) and sync so Worker2 browsers can open `http://<controller_host>:<vite_port>/...` and `ws://<controller_host>:<sync_port>`.
- Run from **spark-main** repo root:  
  `set VRC_RESULTS_ROOT=D:\...\vrc-paper\results_dist_YYYYMMDD`  
  `node vrc-paper/experiments/run_experiment_distributed.mjs`  
  Optional: `VRC_DISTRIBUTED_CONFIG`, `VRC_METHODS`, `VRC_SCENARIOS`, `VRC_TRIALS` (same semantics as `run_experiment.mjs`).
- **Detached orchestrator** `run_autonomous_pipeline_detached.ps1` automatically uses this entry when `experiments/distributed_lab.json` exists; set `VRC_USE_DISTRIBUTED=0` to force the single-machine runner.
- Single-machine behaviour is unchanged: run `node vrc-paper/experiments/run_experiment.mjs` without the distributed script.

Naming:
Use short paper-style labels.

Main baselines:
- Full: full-scene preload for each user.
- Spark-MU: multi-user Spark 2.0 streaming-LoD default; each user independently streams the scene without cross-user coordination.
- VP-S: viewport-priority streaming; each user independently requests chunks/ranges by its own viewport priority, with no multi-user coordination and no network-aware pacing.
- NET-S: network-paced streaming; each user independently schedules requests using bandwidth, in-flight bytes, and recent completion time, but does not use multi-user viewport overlap.
- VRC: full method with multi-user viewport overlap, range/chunk reuse, and network-aware scheduling.

Ablations:
- VRC-V: viewport-only VRC; use multi-user viewport overlap and shared-demand priority, but disable network-aware scheduling.
- VRC-N: network-only VRC; use network-aware scheduling, but disable viewport-overlap priority and shared visible-demand priority.
- VRC-O: object-level VRC; use object-level coordination instead of range/chunk-level coordination.
- VRC: full method.

Figure grouping:
- Main result figures compare only: Full, Spark-MU, VP-S, NET-S, VRC.
- Ablation figures compare only: VRC-V, VRC-N, VRC-O, VRC.
- Also generate an appendix all-method overview with: Full, Spark-MU, VP-S, NET-S, VRC-V, VRC-N, VRC-O, VRC.
- Do not put all 8 methods into every main figure.

Scenarios:
- Nearby: four users view partially overlapping regions.
- Burst-Turn: users turn toward a shared target at close times.
- Divergent: users view mostly different regions.

Metrics:
- viewport_to_visible_latency_ms
- p50_latency_ms
- p95_latency_ms
- p99_latency_ms
- fraction_over_50ms
- object_or_range_completion_ms
- duplicate_request_ratio
- unique_bytes
- aggregate_client_bytes
- shared_bytes
- personalized_bytes
- upstream_or_origin_bytes if available
- cache_hit_ratio if available
- fps
- stall_time
- visible_quality
- qoe
- vrc_scheduling_delay_ms
- sync_delay_ms
- request_inflight_bytes
- recent_completion_ms

QoE:
Use a simple reproducible formula:
qoe = visible_quality - alpha * latency_norm - beta * stall_ratio
Keep alpha and beta in one config file.

Required outputs:
vrc-paper/
  CLAUDE.md
  README.md
  RUNBOOK.md
  DEBUG_LOG.md
  run_all.ps1
  run_all.sh
  server/
  client_instrument/
  experiments/
  analysis/
  results/
    raw/
    summary/
      metrics_summary.csv
      per_run_metrics.csv
      per_client_metrics.csv
      vrc_decisions.csv
      all_methods_overview.csv
    figures/
      fig1_demo_screenshot.png
      fig2_vrc_workflow.png
      fig3_p95_latency.png
      fig4_fraction_over_50ms.png
      fig5_duplicate_ratio.png
      fig6_bytes_breakdown.png
      fig7_completion_cdf.png
      fig8_ablation.png
      fig9_mtp_timeline.png
      fig_appendix_all_methods_overview.png
    screenshots/
    final_report.md

Figures:
- fig1_demo_screenshot.png: four users in the same Spark 3DGS scene with avatars, frustums, shared/personalized/late overlays, and a metric panel.
- fig2_vrc_workflow.png: demand overlap to shared/personalized chunks/ranges.
- fig3_p95_latency.png: main baselines only; include 50 ms red line.
- fig4_fraction_over_50ms.png: main baselines only.
- fig5_duplicate_ratio.png: main baselines only.
- fig6_bytes_breakdown.png: main baselines only.
- fig7_completion_cdf.png: key baselines and VRC.
- fig8_ablation.png: VRC-V, VRC-N, VRC-O, VRC only.
- fig9_mtp_timeline.png: baseline vs VRC timing intervals, such as 0 ms, 16.7 ms, 33.3 ms, 50 ms.
- fig_appendix_all_methods_overview.png: all 8 methods, supplementary sanity check only.

Implementation rules:
- Preserve original Spark files. Prefer wrappers and patches under vrc-paper/.
- If modification of original files is unavoidable, create backups first and document it in DEBUG_LOG.md.
- Automatically install missing packages.
- Automatically debug build/runtime/browser/port problems.
- If port is busy, kill old process or choose another port and document it.
- If Playwright fails, install browsers or fall back to system Chrome.
- If Colyseus is too heavy, use a lightweight ws server.
- If real Spark internal chunk IDs are hard to access, derive a deterministic manifest from streaming-lod assets and observed network requests, but still use examples/streaming-lod as the only scene.
- Do not introduce another dataset.
- Do not ask the user unless truly impossible.
- Keep DEBUG_LOG.md with errors, fixes, and final status.
- One-command pipeline: powershell -ExecutionPolicy Bypass -File vrc-paper\run_all.ps1.
- Bash fallback: bash vrc-paper/run_all.sh.
- Final outputs must include screenshots, CSVs, figures, final_report.md, README.md, RUNBOOK.md, and DEBUG_LOG.md.

## Distributed VRC Experiment Hard Rules

For any dual-machine VRC/Web3DGS experiment:

- Worker1/controller is 10.4.158.143.
- Worker2 remote clients are on 10.4.146.68 via SSH.
- Worker1 runs controller, Vite, Sync, VRC coordinator, u0/u1 only.
- Worker2 runs u2/u3 only.
- Never run all four users on Worker1.
- Never silently fallback to local 4-Chrome mode.
- If Worker2 SSH, remote repo path, remote Chrome, Vite connectivity, Sync connectivity, or endpoint preflight fails, stop and report the exact failing command.
- For distributed experiments, do not call run_experiment.mjs directly unless it is invoked through run_experiment_distributed.mjs or the approved distributed retest script.
- **Worker2 code vs Worker1:** the orchestrator **scp-pulls** shard results after each trial. To push code to Worker2, set **`VRC_DISTRIBUTED_PUSH_TO_WORKER2=1`** (alias **`VRC_DISTRIBUTED_PUSH_VRC_PAPER=1`**) — pushes **only** the manifest in **`experiments/worker2_push_manifest.mjs`** (`run_experiment.mjs`, `visual_validator.mjs`, `distributed_lab.json`, optional root `package.json`/lockfile). **Forbidden:** `scp -r vrc-paper/`. Worker2 browsers load **`client_instrument`/traces** from Worker1 Vite. Does **not** copy **`node_modules`**. Re-push after any manifest file edit. **`dual_cdn_hybrid_retest.ps1`** enables push on **H1** then clears flags. **One-shot:** `powershell -ExecutionPolicy Bypass -File vrc-paper\experiments\Push-Worker2ExperimentBundle.ps1` from **`spark-main`**.
- Use dual_cdn_hybrid_retest.ps1 for dual-machine + dual-CDN + one-HPC validation.
- VRC_CDN2_ASSET_BASE is required and must differ from VRC_CDN_ASSET_BASE.
- Optional **`VRC_CDN2_OBJECT_PATH`** / **`VRC_CDN2_OBJECT_PATH_HOBBITON`**: when CDN2 uses different object keys than flat `streaming-lod/…` (e.g. Google **`https://storage.googleapis.com/forge-dev-public`** with nested paths), set these so `dual_cdn_preflight.mjs` and the browser scheduler rewrite Coit/Hobbiton chunk URLs consistently.
- u2/u3 page_url must use http://10.4.158.143:9200, never localhost.
- u2/u3 sync_url must use ws://10.4.158.143:9201, never localhost.
- Logs must include user_id, worker_id, host_ip, browser_pid, delivery_profile, cdn_label, source_selected, original_url, final_url, fetch_plan_version.
- A distributed run is invalid if request_logs/per_client_metrics do not contain both host_ip=10.4.158.143 and host_ip=10.4.146.68.
- Do not launch full 72/216 until H1-H6 and mini 20-run pass.

## Unattended agent mode (fail → minimal fix → retry same stage → continue)

Applies whenever a Cursor / Claude agent acts as **Experiment-Orchestrator**. **Model name does not matter** (e.g. Opus 4.7 in this environment); **behavior does**: unattended = **this section**, implemented as **one continuous in-session tool loop**, not a background sub-agent daemon.

### Mandatory loop (strict)

1. **On failure** — any of: shell **non-zero** exit; orchestrator prints `FAIL_*`; merged `distributed_validation.ok === false`; optional `session_digest.gate_ok === false` when `VRC_SESSION_DIGEST_FAIL=1`; `status.json` not `PASS` when the stage was supposed to pass.  
   **Forbidden:** ending a turn with only a natural-language postmortem and **no** tool follow-up (no Read of artifacts, no fix, no retry).

2. **Evidence (smallest first)** — under `VRC_RESULTS_ROOT` / merged `raw/<session_id>/` when present:  
   `session_digest.json` → `source_validation.json` → `distributed_validation.json` → `status.json` → **short** tail of `client_logs.jsonl` / `request_logs.jsonl` (line counts / snippets only; never dump full jsonl into chat).

3. **Fix** — **smallest** change that addresses the proven root cause: `VRC_*` / `distributed_lab.json` / `vrc-paper/**/*.mjs` / `*.ps1` / `client_instrument/*`. One primary cause per iteration; avoid unrelated refactors.

4. **Verify edits** — after changing any orchestration `*.mjs`, run `node --check <path>` on touched files before re-running the pipeline.

5. **Retry immediately** — re-run **the exact same stage** that failed (preflight-only if the failure was CDN/HPC/CORS/URL; full `run_experiment_distributed.mjs` / trial only if the failure was merge/run/SSH). After changing bases or CORS-related config, **always** re-run **`dual_cdn_preflight.mjs`** before another distributed trial. **Forbidden:** applying a fix then stopping without a retry in-session (unless §「Stop retrying」 applies).

6. **Strict post-merge gate (optional)** — `VRC_SESSION_DIGEST_FAIL=1` on the orchestrator → `FAIL_SESSION_DIGEST:*` when `session_digest.gate_ok` is false (`experiments/session_post_digest.mjs`).

### Allowed fixes

- Repo: minimal diff under `vrc-paper/` (runners, merge, preflight, instrument), plus `experiments/distributed_lab.json` and bench copy per existing rules.
- Env: `VRC_*` vars documented in this file; align `VRC_HPC_ASSET_BASE` with actual `http.server` docroot (`/examples` suffix when serving from repo root).
- **Not** allowed as “fix”: `--disable-web-security`, weakening canary checks without user request, fabricating metrics, silent fallback to 4-local-Chrome distributed.

### Stop retrying (escalate to human)

- **Fatal external**: missing SSH key, wrong `ssh_host` / firewall you cannot change, R2/GCS CORS only fixable in cloud console (agent documents exact Origin + method to set; stop after one clear instruction).
- **Same root cause** ≥ **3** consecutive failures after documented code/config attempts: output diff summary + exact repro command + one minimal ask.

### Token discipline

Keep chat to decisions + paths; put long command logs in `DEBUG_LOG.md` or session notes.

## Autonomous pipeline: Canary → Full 72

End-to-end goal: **re-run dual-CDN canaries on current code** → **automated acceptance** → **only then** start **Full 72-run** via detached orchestrator. On any failure, follow **§「Unattended agent mode」** (fix + retry same stage in-session; do not ask the user to babysit).

**Conflict rule:** Canary / dual-CDN steps → this file. **Full matrix gate order** (1A → 1B → 2 → 3 → full) → **`VRC_MASTER_AUTORUN.md`** when it disagrees with generic sections here.

### Sub-agent acceptance (same session — simulate with tools, no approval stalls)

| Role | Agent doc | Responsibility |
|------|-----------|----------------|
| Architecture | `.claude/agents/01_architecture_agent.md` | `distributed_lab.json`, dual-machine IPs, SSH |
| CDN | `.claude/agents/02_cdn_agent.md` | preflight, `VRC_CDN2_*`, CORS, GCS hit on u2/u3 |
| Client-Replay | `.claude/agents/03_client_replay_agent.md` | Playwright shards, Worker2 reachability |
| Metrics | `.claude/agents/04_metrics_agent.md` | `summary/*.csv`, `session_digest.json`, A–N |
| Experiment-Runner | `.claude/agents/05_experiment_runner_agent.md` | Run preflight / `dual_cdn_hybrid_retest.ps1` / detached |
| Debug | `.claude/agents/06_debug_agent.md` | Root cause, minimal diff |
| Paper-Artifact | `.claude/agents/07_paper_artifact_agent.md` | CSV/figures **only after** all gates PASS |

After each major phase, output one line (五元组): **判断 | 证据路径 | 下一命令 | 改动文件 | 风险**.

### Phase 0 — Environment (PowerShell, repo root `spark-main`)

```powershell
cd D:\Program\spark-main\spark-main
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_rerun_$ts"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
$env:VRC_SESSION_DIGEST_FAIL = "1"
$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"
```

- Validate **`experiments/distributed_lab.json`**; copy to **`benches/dual_origin_public/config/distributed_lab.json`**.
- **`node experiments/dual_cdn_preflight.mjs --assets-only`** from `vrc-paper` — HPC/CDN1/CDN2 must be 2xx on `summary/endpoint_audit.csv`. On failure: fix env/lab/CORS → **retry preflight only**.

**Runner code expectations (current tree):** per-user **`resolveRadCdnForUser()`** sets `rad_asset_base` (cdn2 → GCS + nested keys); **`VRC_CAPTURE_MODE=metrics_then_visual`** = chunk-byte gate then screenshot; merged **`session_digest.json`** when `VRC_SESSION_DIGEST_FAIL=1`.

### Phase 1 — Dual-CDN canary rerun

From `vrc-paper`:

```powershell
.\dual_cdn_hybrid_retest.ps1
```

Runs H1–H4 + mini 12 (`VRC_DISTRIBUTED`). **No `static_cdn`** (all-CDN = second-server baseline). Delivery: `origin_only` + `vrc_guided_hybrid` only (hot/shared→CDN, cold/personal→HPC). H4 uses **`metrics_then_visual`**. H1 may push code to Worker2 via `VRC_DISTRIBUTED_PUSH_TO_WORKER2`. On failure: Unattended fix → retry failed segment (not “report only”).

**Phase 1 acceptance — all must pass before Phase 2:**

| Check | Source | Pass |
|-------|--------|------|
| Run table | `summary/run_pass_fail.csv` | Last **17** rows (H1–H4 + mini 12) all **`PASS`** |
| Canary rules | `node analysis/validate_canary.mjs` (cwd `vrc-paper`, `VRC_RESULTS_ROOT` set) | exit **0** |
| Dual machine | H1 / `per_client_metrics` | IPs **10.4.158.143** and **10.4.146.68** |
| Real CDN2 | u2/u3 in H3b / hybrid `cdn_label=cdn2` sessions, `request_logs.jsonl` | `.rad` URLs on **`storage.googleapis.com`**; **`cdn2_bytes > 0`** or `source_selected=cdn2` |
| Strict digest | `raw/<session>/session_digest.json` | **`gate_ok: true`** (when `VRC_SESSION_DIGEST_FAIL=1`) |
| H4 visual | H4 session screenshots | u0/u1 valid PNG OK; u2/u3 missing alone OK per merge rules |
| A–N summary | §「Claude Code: Dual-CDN distributed pipeline」§5 table | Chinese, dense, no full jsonl dump |

If any row fails → Debug → minimal fix → re-run from preflight or `dual_cdn_hybrid_retest.ps1` failure point.

### Phase 2 — Full 72-run (detached, not in chat foreground)

Only after Phase 1 acceptance passes:

```powershell
cd D:\Program\spark-main\spark-main\vrc-paper
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_full_$ts"
$env:VRC_RUN_FULL_PIPELINE = "1"
Start-Process powershell -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path (Get-Location) 'run_autonomous_pipeline_detached.ps1')
) -WindowStyle Normal
```

Monitor **`RUN_STATUS.md`**, **`RUN_STATE.json`**, **`NEXT_ACTION.md`**, **`runner_logs/orchestrator_*.out.log`**. Gates: **Canary 1A → 1B → 2 → 3 → full** per **`VRC_MASTER_AUTORUN.md`**. On gate FAIL: read phase logs → Unattended fix → **`resume_real_experiment.ps1`** or new `VRC_RESULTS_ROOT` + restart detached — **never skip canaries**. After full PASS: aggregation/figures per MASTER (if scripts present).

**Forbidden:** `--disable-web-security`, single-machine 4-Chrome as distributed, weakening canary without user request, jumping to full before Phase 1 table passes.

## Claude Code: Dual-CDN distributed pipeline (agent playbook)

Execute in order; on any hard failure, stop and report the exact command + stderr (no silent fallback to single-machine or single-CDN).

### 1. Config verification & sync

- Read `vrc-paper/experiments/distributed_lab.json`. Ensure `ssh_user` is **Ruonan**, `ssh_host` is **10.4.146.68**, and `ssh_key_path` points at the orchestrator-side private key (default **`C:/Users/IoT/.ssh/id_ed25519_spark_bench`** — key lives on the machine that runs `ssh`, not on Worker2).
- Verify `remote_repo_path` and `remote_results_root`. If they differ from **`D:/Program Files/Spark-main`** and **`D:/SparkRuns`**, set them to the **actual** Worker2 paths.
- **Crucial sync**: Copy the validated file to **`vrc-paper/benches/dual_origin_public/config/distributed_lab.json`** so bench tooling does not miss config (that tree may `.gitignore` the file locally; the copy must exist for runs that read that path).

### 2. Environment readiness

- If **`$env:VRC_CDN2_ASSET_BASE`** (PowerShell) / `VRC_CDN2_ASSET_BASE` is empty **or** equals `VRC_CDN_ASSET_BASE`, **stop** (never reuse CDN1 as CDN2).
- For the **documented public second origin** (GCS `forge-dev-public`), set **`VRC_CDN2_ASSET_BASE=https://storage.googleapis.com/forge-dev-public`** and **`VRC_CDN2_OBJECT_PATH=asundqui/rad/260217/coit-40m-sh1-lod.rad`** (and optional **`VRC_CDN2_OBJECT_PATH_HOBBITON=asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad`**). If CDN2 is another R2 mirror with the same flat keys as CDN1, omit the `VRC_CDN2_OBJECT_PATH*` variables.
- Alternatively, put the same values in **`experiments/distributed_lab.json`** as **`cdn2_asset_base`**, **`cdn2_object_path`**, **`cdn2_object_path_hobbiton`** (used only when the matching env var is unset; `dual_cdn_preflight.mjs`, `run_experiment_distributed.mjs`, and `dual_cdn_hybrid_retest.ps1` merge them).

### 3. Preflight

- From **`vrc-paper`**: `node experiments/dual_cdn_preflight.mjs --assets-only`
- Read **`summary/preflight_report.json`** and **`summary/endpoint_audit.csv`**. Asset probes must be **HTTP success (2xx)** for the representative `.rad` path on **HPC, CDN1, and CDN2** (ranged GET often returns **206 Partial Content**; **200** is also acceptable if the origin does not use 206). If any probe fails, halt and paste the failing row + error.

### 4. Main script

- From **`vrc-paper`**: `.\dual_cdn_hybrid_retest.ps1` (sets `VRC_DISTRIBUTED`; default `results_dualcdn_distributed_260513` unless `VRC_RESULTS_ROOT` overrides).
- H6 canary uses **`VRC_CAPTURE_MODE=metrics_then_visual`** (metrics gate then screenshot). Other canaries/mini use **`metrics_only`** unless you override.
- Set **`VRC_SESSION_DIGEST_FAIL=1`** on orchestrator to fail runs when `session_digest.gate_ok` is false (`experiments/session_post_digest.mjs`).
- H1 may set **`VRC_DISTRIBUTED_PUSH_TO_WORKER2=1`** once (manifest-only push, not full `vrc-paper/`). Re-push before Worker2 trials if **`run_experiment.mjs`**, **`visual_validator.mjs`**, or **`distributed_lab.json`** changed.
- After **H1**, connectivity preflight may be skipped when H1 already proved dual-machine reachability (see script comments).
- On SSH/Vite/port errors, capture **stderr**, identify path/host/port, and apply Unattended fix + retry.

### 5. A–N report (token-efficient)

When **H1–H6 + mini 20-run** all complete, open **`VRC_RESULTS_ROOT`** (default `vrc-paper/results_dualcdn_distributed_260513`).

**Read only what you need for A–N** (do not dump whole JSONLs into chat):

| Block | Minimal sources |
|--------|-------------------|
| A–B | `summary/preflight_report.json`, `summary/endpoint_audit.csv` (status + key headers only) |
| C | One line: Worker1 u0/u1; Worker2 u2/u3 + IPs from `distributed_lab.json` |
| D–E | `summary/run_pass_fail.csv` — tail 6 rows for canaries, then count PASS for last 20 mini rows; list any `status != PASS` with `session_id` |
| F | `summary/per_client_metrics.csv` — last 4 rows per final session or aggregate: `user_id`, `worker_id`, `host_ip` |
| G | `summary/source_breakdown.csv` — last few rows: `delivery_profile`, `cdn_label`, `hpc_request_count`, `cdn_request_count` / `cdn2`, `source_validation_ok` |
| H–I | For one H4 and one H5 session dir under `raw/<session_id>/`: note `vrc_decisions.jsonl` has `chunk_delivery`; cite **counts** from `source_breakdown.json`, not full logs |
| J–K | One line each: local 4-Chrome? (must be No). Silent CDN→HPC fallback? (only if `fallback_used` in aggregates; say Yes/No + evidence) |
| L | `figures/fig1_demo_screenshot.png` exists and non-zero size; optional: `raw/.../visual_check.json` → `summary.users_valid` for H6 |
| M–N | Ready for full 72/216 only if D–E all PASS; else smallest fix (file + one-line change) |

**Metrics (cite columns / aggregates, not raw streams):** from `summary/per_run_metrics.csv` and per-session `source_breakdown.json`: `p50_latency_ms`, `p95_latency_ms`, `p99_latency_ms`, `object_or_range_completion_p95_ms`, `fraction_over_50ms`, `duplicate_request_ratio`, `aggregate_client_bytes`, `unique_bytes`; from merged run artifacts when needed: `fps`, `stall_time`, `visible_quality`, `qoe` (from `client_metrics.jsonl` final rows — **counts / means only**).

**Screenshots:** confirm `screenshots/` has `*_u0..u3.png` for the visual canary session; mention `fig1_demo_screenshot.png` only; do **not** base64-embed PNGs in the report.

**Language:** deliver the A–N block in **Chinese** if the human prefers; keep prose **dense** (tables + bullets, no redundant narration) to save tokens.

