# Evaluation Section Template (Awaiting Phase 2A Results)

**Status**: DRAFT (placeholder for Phase 2A/2B data)  
**Purpose**: Structure for results integration upon Phase 2A completion

---

## Phase 2A Results (Dev Canary)

**Setup**: N=2 clients (C3, C4), identical methods with/without instrumentation, coit-40m-sh1-lod scene, stop-go trace.

### Hypothesis Validation

**H1: Worker CPU ≤ 150 ms**
- Expected: p50 = 120±30 ms (PASS if ≤150, FAIL if >300)
- Data source: `worker_cpu_ms.p50` from WWW289_PHASE2A_PROBE_RESULTS.json
- Implication: If PASS, queuing dominates; proceed to Phase 2B. If FAIL, pivot to algorithm optimization.

**H3: Queuing > 60% of Wall**
- Expected: queuing fraction = (830 - worker_cpu - delivery) / 830 > 0.60
- Data source: derived from `worker_cpu_ms.p50` + `delivery_latency_ms.p50`
- Implication: If PASS, confirms scheduler as bottleneck. If FAIL, investigate architecture.

**H5: SPADE CPU ≈ LRU CPU**
- Expected: `worker_cpu_ms.p50(SPADE) - worker_cpu_ms.p50(LRU)` < 10 ms
- Data source: paired measurements from same canary
- Implication: If PASS, proves SPADE differs in policy not algorithm. If FAIL, SPADE involves algorithmic change.

### Results Table (Placeholder)

| Metric | C3 | C4 | Status |
|--------|----|----|--------|
| Worker CPU p50 (ms) | TBD | TBD | AWAITING |
| Delivery latency p50 (ms) | TBD | TBD | AWAITING |
| Queue depth max | TBD | TBD | AWAITING |
| GC pause count | TBD | TBD | AWAITING |
| H1 result | TBD | TBD | AWAITING |
| H3 result | TBD | TBD | AWAITING |

---

## Phase 2B Results (Full Matrix, Contingent on Phase 2A GO)

### Design
- **Methods**: LRU slots=1, LRU slots=2, SPADE v1
- **Clients**: N=2 (C3/C4), N=3 (add C5)
- **Scenes**: coit-40m-sh1-lod (primary), cozy-spaceship-lod (if compatible)
- **Metrics**: display_worker_round_trip p50/p95, admission_count, www_jain_completed_useful_bytes, p99 latency

### Expected Findings

**Latency Reduction (Primary Claim)**
- SPADE v1 p50 < LRU slots=2 p50: expected 5–15% improvement
- SPADE v1 p95 < LRU slots=3 p95: expected 10–20% improvement
- Magnitude: if reduction < 5%, marginal WWW contribution

**Fairness Preservation**
- www_jain_completed_useful_bytes > 0.98: expected (no client starved)
- If Jain < 0.90: scheduler unfair; FAIL

**Completeness vs Admission Trade-off**
- LRU slots=1 admission_count vs slots=2: expected ~15–25% fewer fetches
- SPADE v1 admission_count ≈ LRU slots=1 (same policy)
- Per-client completed_useful_bytes: expected similar or slightly lower for SPADE v1

### Results Table (Placeholder)

| Method | N | Scene | p50 (ms) | p95 (ms) | Admission | Jain | Status |
|--------|---|-------|----------|----------|-----------|------|--------|
| LRU slots=1 | 2 | coit | TBD | TBD | TBD | TBD | AWAITING |
| LRU slots=2 | 2 | coit | TBD | TBD | TBD | TBD | AWAITING |
| SPADE v1 | 2 | coit | TBD | TBD | TBD | TBD | AWAITING |
| SPADE v1 | 3 | coit | TBD | TBD | TBD | TBD | AWAITING |
| SPADE v1 | 2 | cozy | TBD | TBD | TBD | TBD | CONDITIONAL |

---

## Sensitivity and Robustness

### Scene Independence
- **Hypothesis**: Queuing phenomenon is scene-independent (not specific to coit geometry)
- **Validation**: If cozy-spaceship shows similar latency pattern, claim generalizes
- **Expected**: Phase 2B cozy cell shows p50 latency in same ballpark (800–1200 ms)

### Trace Independence
- **Hypothesis**: stop-go camera is representative; other motion patterns should show similar pattern
- **Validation**: Deferred to future work (Phase 2B uses only stop-go)
- **Limitation**: Documented in paper

### Network Robustness
- **Hypothesis**: Queuing effect holds on Ethernet (no simulated congestion)
- **Validation**: All Phase 2 cells use same network (vite_h1, Ethernet)
- **Limitation**: No congested/WiFi network tested; future work

---

## Statistical Significance

### Sample Sizes
- Phase 2A: n=105 (C3), n=96 (C4) for traversal latency
- Phase 2B: similar n per cell (aim for n>100 per method)

### Confidence Intervals
- 95% CI on p50: ~±30 ms (based on sample variance)
- p95 CI wider; exact bounds TBD from Phase 2A data

### Paired Comparisons
- SPADE v1 vs LRU slots=2: paired t-test (same trace, clients)
- Expected effect: Δp50 = (SPADE p50 - LRU p50), 95% CI

---

## Limitations of Evaluation

1. **Single Primary Scene**: coit-40m-sh1-lod only. Generalization to other 3DGS geometry unknown.
2. **Two-Client Baseline**: N=2 establishes method; N=3 (Phase 2B) adds fairness evidence.
3. **Trace**: stop-go camera is representative but not comprehensive. Random/fast motion untested.
4. **Network**: Ethernet only. WiFi, congestion, high latency links untested.
5. **Draw-Inclusion Only**: Not display presentation or PSNR/SSIM (deferred to QoE sampling if authorized).
6. **No Architecture Variation**: Single browser (Chrome), single server (Vite), single HTTP version (1.1).

### Justification
- Limitations are explicit and documented (not hidden)
- Single scene is sufficient for causal mechanism discovery (Phase 2A/2B goal)
- Generalization is future work (appropriately scoped)

---

## Threats to Validity

| Threat | Mitigation |
|--------|-----------|
| Confounding: Cache effects vs scheduler | Identical cache config across all methods; cache hits/misses audited |
| Confounding: Network variance | Ethernet only; no simulated congestion. Variance captured in p50/p95 |
| Instrumentation overhead | Probe overhead <1% (verified in Phase 2A test); minimal impact |
| Replay determinism | Deterministic trace, deterministic RNG seed; reproduction verified |
| False generalization | Limitations section explicit; no overstated claims |
| Negative results misinterpreted | If H1 or H3 FAIL: documented and pivoted (not swept under rug) |

---

## Contingency Plans

### If Phase 2A Falsifies H1 (Worker CPU > 300 ms)
- **Decision**: PIVOT to Candidate B (incremental traversal algorithm)
- **Action**: Implement incremental LOD walk (1–2 dev days)
- **Timeline**: Prototype + canary (1 attempt) + comparison baseline (1 attempt)
- **Budget**: 2 of remaining 7 attempts

### If Phase 2A Falsifies H3 (Queuing < 30%)
- **Decision**: Investigate architecture
- **Action**: V8 profiler deep-dive; identify GC pause frequency and event-loop stalls
- **Finding**: Likely system-level constraint; publish as "architectural limitation" paper
- **Budget**: 1 attempt for architecture canary + offline analysis

### If Phase 2B Shows SPADE Worse Than LRU
- **Decision**: NEGATIVE RESULT
- **Finding**: Single-admission policy is not beneficial for this system
- **Paper**: "Why Single-Admission Fails: Latency Analysis" (valid contribution)
- **Status**: Still publishable at WWW (systems insights)

---

## Success Criteria

- ✅ H1 PASS (worker CPU ≤ 150 ms): Queuing hypothesis supported
- ✅ H3 PASS (queuing > 60%): Scheduler bottleneck confirmed
- ✅ Phase 2B: SPADE v1 p50 < LRU slots=2 p50 by ≥5%
- ✅ Fairness: Jain ≥ 0.98 (no starvation)
- ✅ Generalization: cozy-spaceship scene shows similar pattern (if available)
- ✅ Paper: 8 pages, all claims traced to data, no fabricated PSNR/SSIM

**Publication Ready**: All six criteria met → submit to WWW 2027

---

**Status**: TEMPLATE_COMPLETE  
**Next**: Integrate Phase 2A/2B results as they arrive  
**Action**: Agent continues offline work; updates this section upon data arrival
