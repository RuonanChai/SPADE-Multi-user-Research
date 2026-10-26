# SPADE Experiment Research Steps (English)

This document records the sealed multi-user experiment pipeline used for the SPADE paper artifact.
It is intentionally free of figure assets and plotting scripts.

## 0. Scope

- Topology: one controller/server `S` and three browser clients `C3/C4/C5`.
- Allowed concurrency: `N ∈ {1,2,3}`.
- Shared proxy budget for physical arms: `50 MiB / 100 entries`.
- Verified handoff residual (when enabled): hold `15 s`, per-client cap `160 MiB`, probe timeout `1500 ms`.
- Digest check: SHA-256 over origin bytes before admit/send. Fail closed to origin on mismatch/empty body.

## 1. Freeze runtime identity

1. Lock the SOURCE_EPOCH inputs (proxy, verified peer, handoff buffer, SpadeByte/S3-FIFO cache, request trace, worker/trace hashes).
2. Record hashes in `experiments/protocol/SOURCE_LOCK.json` and `ENV_AND_RUNTIME_HASHES.csv`.
3. Do not edit frozen sources while reusing a sealed epoch.

## 2. Protocol integrity (P0)

1. Run the peer verification suite against good/bad peer bodies.
2. Require `bad_delivered = 0` and `bad_cached = 0`.
3. Keep the concurrency case where a bad peer and a good peer race: only the origin-trusted body is admitted.

## 3. Fixed-demand offline baselines (P1)

1. Replay sealed Coit/Poland demand logs with cold start and identical arrivals.
2. Compare S3-FIFO, FIFO, LRU, SIEVE, and SPADE with/without verified residual.
3. Primary metric: origin bytes. Store results in `experiments/metrics/p1_fixed_demand/FIXED_DEMAND_RESULTS.csv`.

## 4. Physical N=3 core contrast (P2)

1. Arm A: S3-FIFO proxy only.
2. Arm B: S3-FIFO + verified peer residual (or SPADE-BYTE + handoff in the visual campaign).
3. Seal each cell only after validator + DATA_SANITY + exact-RunId audit.
4. Report response-window origin, peer bytes, latency, and quality tables under `experiments/metrics/p2/`.

## 5. Equal-storage offline stress

1. Replay the same sealed demand with:
   - 50 MiB S3-FIFO
   - 50 MiB S3-FIFO + verified residual
   - fair large proxy ≈ 530 MiB with entry cap = distinct keys
2. Keep the 100-entry large-proxy arm only as a diagnostic trap.
3. Outputs: `experiments/metrics/equal_cache/`.

## 6. Post-eviction reuse proof

1. Reconstruct proxy residency from admits and eviction decisions.
2. Prove each `peer_handoff` object was previously evicted and later served from a different viewer with digest match.
3. Output: `experiments/metrics/post_eviction/POST_EVICTION_REUSE.csv`.

## 7. Visual A/B campaign (Coit / Poland / Hobbiton)

1. Synchronized `stop_go` trajectory, three demand seeds per scene, reps ordered A→B then B→A.
2. Coit/Poland: in-window canvas checkpoints for quality scoring against per-client full-view references.
3. Hobbiton continuation: **no WebGL readPixels during the 70 s measurement window**; one `screenshot_post_window` after measurement end.
4. Keep session summaries only (`SESSION.json`). Screenshot binaries are excluded from this repository.
5. Matrices and contracts: `experiments/contracts/`.
6. Pair scores: `experiments/metrics/visual/TREATMENT_PAIRS.json`.

## 8. What not to claim from these files alone

- Do not claim equal-total-cache superiority over a fair large central proxy.
- Do not print three-viewer mean SSIM on a single-client figure caption.
- Do not treat a filename containing PASS/VALID as scientific authority without the sealed CSV/JSON rows.

## 9. Reproduction entry points

- Frozen sources: `experiments/runtime_frozen/`
- Physical metrics: `experiments/metrics/p2/`
- Visual session metadata: `experiments/sessions/`
- Protocol hashes: `experiments/protocol/`
