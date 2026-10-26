# SPADE Multi-user Research

Reproduction-oriented artifact for **SPADE**: verified cross-viewer residual reuse after proxy eviction for Web 3D Gaussian Splatting (3DGS) delivery.

This repository keeps the **frozen runtime**, **experiment contracts**, and **sealed metrics**.
It does **not** include paper figures, screenshot packs, or plotting scripts.

Start here for the step-by-step protocol: [`experiments/EXPERIMENT_STEPS.md`](experiments/EXPERIMENT_STEPS.md).

---

## 1. Experiment design

### Topology

| Role | Count | Notes |
| --- | --- | --- |
| Controller / proxy server `S` | 1 | Serves Vite + SPADE proxy. Never runs experiment Chrome. |
| Browser clients | 3 (`C3`, `C4`, `C5`) | Each runs the worker under a Scheduled Task. |
| Allowed concurrency `N` | `{1,2,3}` | Canonical sealed physical campaign uses `N=3`. |

Scenes used in sealed runs:

- Coit: `coit-40m-sh1-lod.rad`
- Poland: `poland-lod.rad`
- Hobbiton: `tijerin_w6_hobbiton-lod.rad` (scenario expansion; post-window screenshots only)

Camera path: frozen `stop_go` trajectory. Multiple seeds are **demand replicates of one path**, not independent camera paths.

### Shared budgets (do not retune for reproduction)

| Knob | Value |
| --- | --- |
| Proxy cache | `50 MiB`, `100` entries |
| Verified handoff hold | `15 s` |
| Per-client residual cap | `160 MiB` |
| Peer probe timeout | `1500 ms` |
| Trust rule | SHA-256 of origin body before admit/send; fail closed to origin |

### Arms

| Arm | Proxy policy | Client residual |
| --- | --- | --- |
| **A** | S3-FIFO only | off |
| **B** | S3-FIFO or SPADE-BYTE (campaign-specific) | verified peer handoff on |

SPADE’s adaptive SpadeByte knob changes small-queue promotion thresholds from cross-user repeat rate. The **mechanism claim** under test is short-lived, digest-checked residual reuse after eviction—not “a better replacement policy at equal total DRAM.”

### Campaign stages

1. **P0 protocol** — bad peer never delivered/cached; concurrent good/bad peer race stays fail-closed.
2. **P1 fixed-demand offline** — same sealed request logs, cold start, compare policies ± residual.
3. **P2 physical N=3** — live synchronized clients; Arm A vs Arm B; seal only after validator + DATA_SANITY + exact-RunId audit.
4. **Equal-storage offline** — `50 MiB`, `50 MiB+residual`, and fair ~`530 MiB` central proxy (entry cap = distinct keys). The 100-entry large proxy is diagnostic only.
5. **Post-eviction proof** — every sealed `peer_handoff` must reconstruct to a prior eviction + digest match from another viewer.
6. **Visual A/B** — Coit/Poland in-window checkpoints vs per-client full-view references; Hobbiton keeps measurement-window free of WebGL readPixels and captures one post-window frame.

---

## 2. How code maps to the design

All reproduction-critical sources live under `experiments/runtime_frozen/`.
Identity hashes are locked in `experiments/protocol/SOURCE_LOCK.json`.

| File | Role in the pipeline |
| --- | --- |
| `proxy.js` | Origin-facing Range proxy, cache admission, decision ledger (`proxy.jsonl`). |
| `matched_cache.js` | S3-FIFO (and related) byte/entry cache used by both arms. |
| `spade_byte_cache.js` | SPADE-BYTE adaptive layer on top of the same data plane. |
| `verified_peer.js` | SHA-256 verify before peer body is admitted or forwarded. |
| `client_handoff_buffer.js` | Per-client residual buffer (`19081`, 15 s / 160 MiB). |
| `request_trace.js` | Versioned cache-key construction after repeated Range sightings. |
| `remote_worker_bundle.next.js` | Browser worker: page load, trace replay, handoff route, READY/DONE. |
| `isolated_run_cell.next.js` | Cell launcher / remote task orchestration helper. |
| `capture_checkpoint.js` | WebGL readPixels capture used by visual checkpoints / post-window shot. |
| `scene_trace_frame.js` | Maps `stop_go` into each scene’s camera frame (Coit/Poland/Hobbiton). |
| `replay_fixed_demand.js` | Offline P1 / equal-cache demand replay driver. |
| `p0_wire_test.js` / `p0_negative_test.js` | Protocol integrity gates. |
| `seal_cell.js` / `score_cell_images.js` | Closure helpers for sealed cells and image scores. |

Metric builders that accompany sealed tables:

| Script | Output |
| --- | --- |
| `experiments/metrics/equal_cache/equal_cache_replay.js` | `EQUAL_CACHE_RESULTS.csv`, `ENTRY_LIMIT_DIAGNOSIS.csv` |
| `experiments/metrics/post_eviction/post_eviction_reuse.js` | `POST_EVICTION_REUSE.csv` |

Contracts that freeze the visual matrix without retuning science:

- `experiments/contracts/TREATMENT_MATRIX.json` — Coit/Poland 24 sessions
- `experiments/contracts/HOBBITON_MATRIX.json` — Hobbiton 12 sessions, `capture_during_window=false`
- `experiments/contracts/SCENE_ASSET_CONTRACT.json` — object keys / ETags

---

## 3. Repository layout

```
experiments/
  EXPERIMENT_STEPS.md          English end-to-end protocol
  runtime_frozen/              hashed sources used by sealed runs
  protocol/                    SOURCE_LOCK, manifests, integrity CSVs
  contracts/                   visual / scene / QoE contracts
  metrics/
    p1_fixed_demand/           offline baseline origin bytes
    p2/                        sealed physical cell tables
    equal_cache/               50 vs residual vs fair-large replay
    post_eviction/             proven reuse chains
    visual/                    TREATMENT_PAIRS and reference SSIM audits
    p50_closeout/              latency / holder closeout tables
    paper_audit/               recomputation summaries
  sessions/
    visual/                    Coit/Poland SESSION.json only
    hobbiton/                  Hobbiton SESSION.json only
```

Excluded on purpose: `*.png` / `*.pdf` figures, screenshot zips, `draw*.py` / `plot*.py`.

---

## 4. Minimal reproduction path

### Offline (no browser farm)

1. Use Node.js matching the sealed campaign (`v24.x` used in locks).
2. From `experiments/runtime_frozen/`, run `p0_wire_test.js` / `p0_negative_test.js` and require zero bad delivery/cache.
3. Replay fixed demand with `replay_fixed_demand.js` and compare to `metrics/p1_fixed_demand/FIXED_DEMAND_RESULTS.csv`.
4. Run `metrics/equal_cache/equal_cache_replay.js` against the sealed demand logs referenced by the CSV headers; require regression match on the 50 MiB arms.
5. Run `metrics/post_eviction/post_eviction_reuse.js` over sealed B cells; expect `CHAIN_RECONSTRUCTED` and `FALSE_PASS=0` semantics described in `EXPERIMENT_STEPS.md`.

### Physical N=3 (requires the three-client Ethernet testbed)

1. Deploy **exactly** the hashes in `protocol/SOURCE_LOCK.json` and `ENV_AND_RUNTIME_HASHES.csv` to `S` and clients. Local git checkout is not deployment proof.
2. Start Vite on `S` (HTTP entry used by workers) and launch `proxy.js` with Arm A or Arm B flags (`--cache-max-mb 50 --cache-max-entries 100`, handoff `0|1`).
3. Launch the three client workers with the same `run_id`, scene, seed, and barrier release.
4. After DONE: run validator → DATA_SANITY → exact-RunId audit before promoting a cell.
5. Compare origin/peer/latency/quality against `metrics/p2/*.csv`. Do not edit sealed CSVs by hand.

### Visual campaign notes

- Coit/Poland: checkpoints at `t ∈ {2,5,10,20,40,60}` seconds; score against the per-client reference named in the treatment matrix.
- Hobbiton: **no in-window pixel readback**; only `SESSION.json` is stored here. Caption any paper figure with that **viewer’s own** SSIM, never the three-client mean.

---

## 5. What these artifacts support / do not support

**Supported**

- Reproduce protocol fail-closed behavior (P0).
- Recompute offline origin comparisons under fixed demand and equal-storage settings.
- Audit sealed physical and visual session summaries against frozen hashes.

**Not supported / do not claim from these files alone**

- “SPADE beats S3-FIFO at equal total cache” when a fair large central proxy is allowed.
- Latency wins from browser CSV columns without converting Chrome CDP seconds → milliseconds.
- Quality winners without the locked per-client reference definition.

---

## 6. License / review note

Private research artifact for paper reproduction and review.
Updating this repository does not authorize new physical experiments by itself.
