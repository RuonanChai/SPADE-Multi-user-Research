# Related Work and Baseline Selection

**Status**: DRAFT (for Phase 2A parallel development)  
**Purpose**: Position novelty, select comparable methods, document reproducibility

---

## Related Work Summary (2024–2026)

### 3DGS Streaming and Progressive Rendering

**Category A: LOD-based Approaches**
- **L3GS** (MobiCom 2025): Level-of-detail for Gaussian splats, focusing on network bandwidth optimization. Hierarchical transmission of splat importance. **Relevance**: Comparable LOD mechanism; different optimization target (bandwidth vs latency).
- **LapisGS** (3DV 2025): Layered approach to 3D Gaussian splatting; progressive refinement. **Relevance**: Similar render readiness concept; comparability limited by representation differences (layers vs tree).
- **LTS** (MMSys 2025): Long-tail streaming for 3DGS; addresses tail latency in multiuser CDN delivery. **Relevance**: Network-focused; our focus is browser-local scheduling.

**Category B: Browser-based Rendering**
- **Tome et al.** (WebXR, prior years): Worker-thread architecture for WebGL rendering. **Relevance**: Confirms worker-thread bottleneck is known in browser graphics; our work quantifies scheduler interaction.
- **Three.js InstancedBufferGeometry**: Standard browser API for mesh instancing; used by most 3DGS WebGL implementations. **Relevance**: Our baseline uses this; no novelty in GPU submission path.

**Category C: Admission Control and Scheduling**
- **DASH / HTTP Adaptive Bitrate**: Rate-limiting fetch requests based on buffer state. **Relevance**: Analogous to single-admission policy; browser-level implementation differs.
- **QUIC congestion control**: Modern transport-layer flow control. **Relevance**: Our work is above the transport layer (application-level scheduler).

---

## Baseline Implementations

### Baseline 1: LRU Cache with Configurable Slots

**Reference**: Standard LRU eviction policy (well-established, no paper required for classic algorithm).

**Implementation**:
- Shared 50 MiB cache, 100-entry LRU
- Fetch slot count: 1, 2, 3 (configurable per cell)
- Eviction: least-recently-used chunk
- Per-client queueing: FIFO by admission time

**Reproducibility**:
- Language: JavaScript (Web Workers)
- Cache implementation: Map + doubly-linked list (O(1) eviction)
- Test code location: (source repo, NSDI_SPADE_HARNESS)
- Deterministic on fixed trace + fixed scene

**Comparable to**: SPADE v1 (same LRU backend, different fetch policy)

### Baseline 2: Full-Tree LOD Traversal (No Dirty-Bit Optimization)

**Reference**: Original codebase behavior prior to WWW286.

**Implementation**:
- Set tree dirty-flag on every chunk update
- Full traversal recompute on every frame
- No incremental maintenance
- Serves as maximal-cost control

**Reproducibility**:
- Same scene and trace as SPADE
- Disabled dirty-bit coalescing
- Expected: highest latency, confirms waste

**Comparable to**: SPADE v1 (same algorithm, no optimization)

### Baseline 3: Position-Only Dirty Detection (Simple Version)

**Reference**: Prior work (simple heuristic, not published but documented in lodtimeline_r1).

**Implementation**:
- Skip traversal if camera position unchanged
- Still recompute on rotation, FOV, viewport change
- Coarser than full dirty-tracking but cheaper

**Reproducibility**:
- Deterministic if camera trace has reproducible stops
- Expected: modest savings (~10–20%) in stationary intervals

**Comparable to**: SPADE v1 (same LOD tree, different dirty-detection heuristic)

---

## SPADE Implementations

### SPADE v1: Single-Admission Policy

**Paper**: (Anonymous, this work)

**Algorithm**:
- Main loop submits LOD traversal requests to worker queue
- Worker accepts ONE concurrent traversal
- Remaining requests are queued by browser's own event loop (not application-controlled)
- Result: bounded queue depth on application side

**Equivalence**:
- Functionally identical to LRU slots=1
- Difference: slots=1 is cache policy; SPADE v1 is traversal admission policy
- Both produce similar latency; SPADE v1 has slightly lower completeness (fewer fetches admitted)

**Reproducibility**:
- Source code: (NSDI_SPADE_HARNESS/research/www_n3_XXX)
- Configuration: single_admission=true
- Deterministic on fixed trace

### SPADE v2: Predictive Prefetch (Not Recommended)

**Paper**: (Anonymous, experimental)

**Algorithm**:
- Predict camera motion; prefetch LOD in advance
- Attempt to fill pipeline during user motion pause
- Did not recover lost completeness vs SPADE v1; abandoned

**Reproducibility**:
- Marked as EXPERIMENTAL; not comparable to other methods
- Excluded from final matrix

---

## Selection Rationale

**Primary Methods for Phase 2B**:
1. **LRU slots=1**: Strong baseline, proven comparable to SPADE v1
2. **LRU slots=2**: Current strongest baseline, shows queue-depth effect
3. **SPADE v1**: Single-admission policy, hypothesized to lower latency

**Rationale**:
- Slots progression (1 → 2 → 3) tests saturation of admission policy
- SPADE v1 as the intervention (same algorithm, different policy)
- All methods use same LOD tree, scene, trace, clients
- Fairness Jain index is primary multiuser metric

**Excluded Methods**:
- Full-tree traversal without optimization (confirmed waste, not newsworthy)
- Position-only dirty detection (modest gain, not WWW contribution level)
- Incremental traversal (Candidate B; only if SPADE v1 CPU bound)
- SPADE v2 prefetch (experimental, negative result)

---

## Metrics and Reproducibility

### Frozen Metric Contract

| Metric | Unit | Definition | Aggregation | Falsifier |
|--------|------|-----------|------------|-----------|
| `display_worker_round_trip_p50_ms` | ms | Awaited traverseLodTrees call (main thread perception) | Per-client p50 | > 1000 ms on baseline (system failure) |
| `admission_count` | count | Number of distinct traversals admitted | Per-client total | < 100 (insufficient trace data) |
| `completed_useful_bytes_p50_ms` | bytes | Chunks successfully downloaded and integrated | Per-client total over trace | < 500 MB (network failure) |
| `www_jain_completed_useful_bytes` | index | Jain fairness of per-client byte counts | Derived from clients | < 0.90 (unfair scheduler) |
| `worker_cpu_ms` (Phase 2A only) | ms | Measured CPU time in traverseLodTrees | Per-batch p50/p95 | Varies by hypothesis |

### Reproducibility Checklist

- [ ] Source code SHA256 recorded (exact commit)
- [ ] Browser version and build number recorded
- [ ] Scene geometry hash (coit-40m-sh1-lod) recorded
- [ ] LOD tree snapshot (3.75M splats) recorded
- [ ] Camera trace SHA256 recorded
- [ ] Network topology (Ethernet, Vite hop vite_h1) recorded
- [ ] Cache configuration (50 MiB, 100-entry LRU) recorded
- [ ] Clock sync scheme (if used) recorded
- [ ] Seed or determinism specification (if random components exist) recorded
- [ ] All 125 metrics and their sources audited and logged

---

## Scene Compatibility (Contingency)

### Scene 1: coit-40m-sh1-lod (PROVEN)
- Status: VALID in lodtimeline_r1 (run 36/44)
- Geometry: 40M splat LOD base
- Trace: stop-go (stationary + motion)
- Use: Primary matrix

### Scene 2: cozy-spaceship-lod (CONDITIONAL)
- Status: Manifest exists, but not yet loaded in any cell
- Risk: Incompatible format, missing assets, shader differences
- Validation needed: Load scene + render 1 frame + verify LOD splat count
- Use: If validated, as secondary scene in 1–2 Phase 2B cells
- Fallback: Use coit-40m-sh1-lod for all cells

### Scene 3: poland-lod, hobbiton-lod (DEFERRED)
- Status: Manifest exists
- Risk: High (unknown assets, unvalidated)
- Use: Future work if time permits

---

## Expected Paper Structure

1. **Abstract** (120–150 words)
   - Problem: Worker queuing dominates LOD latency
   - Method: Instrumented canary + full matrix with admission policies
   - Result: Single-admission reduces p95 latency, maintains fairness
   - Implication: Browser scheduler, not algorithm, governs 3DGS readiness

2. **Introduction** (500–700 words)
   - Motivation: Real multiuser 3DGS streaming in browsers (1–2 scenes, 2–3 clients)
   - Gap: Prior work assumes CPU bottleneck; we measure queuing
   - Contribution: Quantify queue depth, show single-admission policy effectiveness

3. **Related Work** (400–600 words)
   - 3DGS streaming: LapisGS, LTS, L3GS (positioning)
   - Browser rendering: Three.js, WebGL limitations
   - Admission control: DASH, QUIC (analogous systems)
   - Scheduling: Web Workers, browser event loop (system constraints)

4. **System Design** (300–400 words)
   - Architecture: Browser client + HTTP/1.1 server, shared LRU, worker pool
   - Scene: coit-40m-sh1-lod, 3.75M LOD splats
   - Clients: C3, C4 (Ethernet), optionally C5 (scaling test)
   - Metrics: Latency (p50/p95), admission count, fairness (Jain)

5. **Evaluation** (800–1200 words)
   - Phase 2A: Confirm hypotheses (worker CPU ≤ 150ms, queuing > 60%)
   - Phase 2B: Full matrix (LRU slots 1/2 vs SPADE v1, N=2/3)
   - Results: Latency reduction (5–20%), fairness maintained (Jain > 0.98)
   - Sensitivity: Robustness to scenes, traces, network conditions

6. **Discussion** (300–400 words)
   - Implications for HTTP/2, HTTP/3 (transport-level flow control orthogonal to app scheduling)
   - Browser constraints: Single event loop per worker, GC pauses
   - Recommendations: Preemptive scheduling APIs for Web Workers

7. **Limitations** (150–200 words)
   - Single primary scene (coit-40m-sh1-lod)
   - Two-client baseline (N=3 adds insight but not generalization)
   - No PSNR/SSIM (draw-inclusion only)
   - No network shaping (Ethernet only, no simulated congestion)

8. **Reproducibility** (200–300 words)
   - Exact commands: how to launch server, browser, clients
   - Source code: GitHub link or artifact repository
   - Data: F: drive dump with all metrics, logs, traces
   - License: (e.g., MIT, CC-BY)

---

**Status**: Ready for incorporation into main.tex during Phase 2A/2B execution  
**Next**: Merge with existing draft, compile to PDF, count pages
