# Codex SPADE Resume — Method Iteration

**Authority**: sealed evidence + `SOURCE_LOCK.json` + raw ledgers outrank this file.  
**Purpose**: painless continuation for optimizing SPADE without re-deriving topology, hashes, or campaign state.  
**WiFi**: SPADE WiFi archives were deleted 2026-10-27; paper scope remains three Ethernet viewers. Do not resurrect WiFi claims.

---

## 0. Base directory (run commands from here)

```text
F:\SPADE_WWW_EVIDENCE_V2_20261024
```

Equivalent junction (same tree):

```text
D:\Program\SPADE_WWW_EVIDENCE_V2_20261024
```

| Path | Use |
| --- | --- |
| `F:\SPADE_WWW_EVIDENCE_V2_20261024` | **PRIMARY** runtime + P1/P2/equal-cache metrics |
| `F:\SPADE_WWW_VISUAL_COS_20261025` | Visual A/B + Hobbiton campaign controllers |
| `F:\SPADE_GITHUB_UPLOAD_20261026\repo` | Public/private GitHub artifact clone (`experiments/` only) |
| `D:\Program\P5_3DGS` | Cursor workspace only — **NOT** scientific evidence root (`proxy.jsonl` there is stale) |

Shell: Git bash or PowerShell on the controller `S=192.168.1.200` (`DESKTOP-HJI5KUU`).  
Node: `v24.18.0` (campaign lock).  
SSH: `p5remote@192.168.1.{197,196,195}`, key `C:\Users\IoT\.ssh\id_ed25519`, known_hosts under sealed physical_runtime (read-only).

```bash
cd /f/SPADE_WWW_EVIDENCE_V2_20261024
```

---

## 1. Frozen scientific design (do not silently change)

| Knob | Value |
| --- | --- |
| Topology | `S=192.168.1.200`, clients `C3=.197 C4=.196 C5=.195`, `N∈{1,2,3}` |
| Proxy | 50 MiB / 100 entries |
| Handoff | 15 s hold, 160 MiB/client, port 19081, probe 1500 ms |
| Trust | SHA-256 of origin bytes before admit/send; fail closed |
| Trace | `stop_go` (seeds = demand replicates, not new camera paths) |
| Scenes | Coit / Poland / Hobbiton COS objects |

**Arm A** = S3-FIFO, handoff off. **Arm B** = S3-FIFO or SPADE-BYTE + verified handoff (campaign-specific).  
Mechanism under test: short-lived digest-checked residual reuse after eviction — **not** “beats S3-FIFO at equal total DRAM.”

If you edit any `SOURCE_LOCK` component under `runtime/`, **recompute hashes and restart from earliest invalidated gate**. Do not reuse old epoch certificates.

`SOURCE_LOCK` components (12):  
`verified_peer.js proxy.js client_handoff_buffer.js spade_byte_cache.js matched_cache.js request_trace.js capture_checkpoint.js remote_worker_bundle.next.js isolated_run_cell.next.js phase_regimes.js p0_negative_test.js p0_wire_test.js`  
Manifest SHA-256: `c2d2680ed206268d5afa244757ac752e12e60dc5128f765bddc58a6a10e48846`

---

## 2. Where sealed results already live

| Stage | Location |
| --- | --- |
| P1 fixed demand | `FIXED_DEMAND_RESULTS.csv` |
| P2 physical N=3 | `P2_CORE/metrics/*.csv` (executor finished 24/24) |
| Equal-cache offline | `P2_CACHE_EQUAL/EQUAL_CACHE_RESULTS.csv` |
| Post-eviction proof | `P2_CACHE_EQUAL/POST_EVICTION_REUSE.csv` |
| Visual Coit/Poland | `F:\SPADE_WWW_VISUAL_COS_20261025\treatment\visab_*` + `analysis\TREATMENT_PAIRS.json` |
| Hobbiton | `treatment\visab_hobbiton_*\SESSION.json` (no in-window PNG; post-window only) |
| English protocol | GitHub artifact `experiments/EXPERIMENT_STEPS.md` |

Do **not** delete Ethernet sealed trees. P2 executor is exited; do not spawn a second controller.

---

## 3. Method-iteration workflow (recommended)

Goal: change SPADE logic → prove with offline gates → optional one physical canary → only then expand.

```text
EDIT runtime (minimal)
  → node --check changed files
  → P0 wire + negative
  → P1 fixed-demand replay (must match or document delta vs FIXED_DEMAND_RESULTS.csv)
  → equal_cache_replay (50 MiB arms must still regress unless you intentionally change them)
  → post_eviction_reuse on sealed B cells if handoff path changed
  → if SOURCE_LOCK bytes changed: rewrite SOURCE_LOCK hashes + new epoch note
  → optional: single physical A/B canary on one Coit seed (not full 24)
  → update CODEX_SPADE_RESUME.md + GitHub experiments/ if claim changes
```

### Commands that should just run (from evidence root)

```bash
cd /f/SPADE_WWW_EVIDENCE_V2_20261024

# Syntax
node --check runtime/proxy.js
node --check runtime/spade_byte_cache.js
node --check runtime/verified_peer.js
node --check runtime/matched_cache.js

# P0
node runtime/p0_wire_test.js
node runtime/p0_negative_test.js

# P1 fixed-demand replay (uses sealed demand logs; do not overwrite FIXED_DEMAND_RESULTS.csv unless intentional)
node runtime/replay_fixed_demand.js

# Equal-storage offline (throws if 50 MiB arms diverge from FIXED_DEMAND oracle)
node P2_CACHE_EQUAL/equal_cache_replay.js

# Post-eviction chain (read-only over P2 B cells)
node P2_CACHE_EQUAL/post_eviction_reuse.js
```

### Physical canary (only if offline gates pass)

Preflight:

```bash
# Vite must listen on 18080; proxy must NOT already own 18081
powershell.exe -NoProfile -Command \
  "@(Get-NetTCPConnection -LocalPort 18080,18081 -State Listen -ErrorAction SilentlyContinue)"

# Clients
for ip in 192.168.1.197 192.168.1.196 192.168.1.195; do
  ssh -i /c/Users/IoT/.ssh/id_ed25519 -o BatchMode=yes -o ConnectTimeout=8 \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/d/Program/SPADE/SPADE_BYTE_N23_20261023/physical_runtime/ssh/known_hosts \
    p5remote@$ip "hostname"
done
```

Proxy Arm A / B (example; evidence dir must be unique):

```bash
# Arm A — S3-FIFO, no handoff
node runtime/proxy.js --method S3-FIFO --port 18081 \
  --origin-url https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com \
  --cache-max-entries 100 --cache-max-mb 50 --handoff 0 \
  --run-id spade_canary_A --evidence-dir /tmp/spade_canary_A

# Arm B — SPADE-BYTE + handoff
node runtime/proxy.js --method SPADE-BYTE --port 18081 \
  --origin-url https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com \
  --cache-max-entries 100 --cache-max-mb 50 --handoff 1 \
  --run-id spade_canary_B --evidence-dir /tmp/spade_canary_B
```

Visual Hobbiton campaign (already complete; re-run only after intentional matrix change):

```bash
cd /f/SPADE_WWW_VISUAL_COS_20261025
node controller/hobbiton_campaign.js
```

---

## 4. Hard fail-closed rules for Codex

1. Never invent clients (no C6), never N=5, never `192.168.0.*` for this campaign.
2. Never run experiment Chrome on `S`.
3. Never declare PASS from chat memory; read CSVs / SESSION.json / SOURCE_LOCK.
4. Never mix visual SPADE-BYTE campaign with P2 “S3-FIFO+handoff” when stating method.
5. Never claim equal-total-cache win vs a fair large central proxy (530 MiB offline already shows large proxy lower origin).
6. Browser CSV `"ms"` may be Chrome CDP **seconds** — multiply by 1000 before paper latency.
7. One scientific executor only; check `EXECUTOR.lock` / port 18081 before launching.
8. Do not commit secrets or paste PATs into the repo.

---

## 5. Optimization targets that match the sealed story

Useful next edits (software-resolvable):

- Reduce empty-body / residual miss cost without weakening digest fail-closed.
- Improve staggered reuse without hurting synchronized Poland (inflight merge already covers many misses).
- Keep proxy at 50 MiB; residual is for when shared proxy **cannot** grow.
- Any adaptive SpadeByte change needs P1+equal_cache regression before physical.

Out of scope unless user explicitly authorizes:

- WiFi / WAN / N>3 physical campaigns
- Retuning cache MiB, hold ms, probe ms, or frozen matrix seeds for a pass
- Rerunning full 24 visual cells without invalidation evidence

---

## 6. Quick status snapshot (2026-10-27)

| Item | Status |
| --- | --- |
| P2 core | Complete (24 sealed); executor exited |
| Equal-cache + post-eviction | CSVs on disk under `P2_CACHE_EQUAL/` |
| Visual Coit/Poland | 24 sessions sealed under VISUAL_COS |
| Hobbiton | 12 sessions sealed; measurement-window capture off |
| Vite `:18080` | Often reused (pid may vary); confirm before physical |
| Proxy `:18081` | Must be free before a new cell |
| GitHub artifact | `https://github.com/RuonanChai/SPADE-Multi-user-Research` — `experiments/` tree |

**FIRST_FAILED_STAGE** for a new method iteration starts at: `P0_WIRE` after first runtime edit.

---

## 7. Read next

1. This file  
2. `F:\SPADE_GITHUB_UPLOAD_20261026\repo\README.md`  
3. `F:\SPADE_GITHUB_UPLOAD_20261026\repo\experiments\EXPERIMENT_STEPS.md`  
4. `SOURCE_LOCK.json` + `FIXED_DEMAND_RESULTS.csv` + `P2_CORE/metrics/P2_CELL_MASTER.csv`
