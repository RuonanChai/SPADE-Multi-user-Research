# Figure Plan: Three-Layer Motivation (Origin 3-Trial Revision)

## Data (all single-user, 3 trials mean)

| Tier | Normal: Chunks | Normal: FPS | Normal: p95 (ms) | Fetch-only: Chunks | Fetch-only: p95 (ms) | Pure render: FPS |
|------|---------------|-------------|-------------------|--------------------|--------------------|-----------------|
| Local baseline | 230 | 86.9 | 30 | 140 | 161 | 115.5 |
| Origin server | 277 | 88.3 | 499 | 140 | 991 | 92.3 |
| Remote server | 17 | 156.3 | 15,872 | 5 | 140,626 | 164.9 |

Cold start first_visible: Local=1,440ms, Origin=1,178ms, Remote=6,703ms

---

## Figure 1: Chunk Delivery + p95 Latency Across Tiers

**Type**: Grouped bar (chunks) + log-scale line (p95)
**X-groups**: Normal streaming, Fetch-only, Pure render
**Bars**: Local (blue), Origin (green), Remote (coral)
**Secondary y-axis**: Chunk p95 (ms, log scale) — diamond markers for normal streaming only
**Annotation**: "fast but empty" on Remote normal-streaming bar
**Size**: 3.33 × 2.5 in (single column)

## Figure 2: Cold-Start + Multi-User (two panels)

**Panel A**: Horizontal bars — cold-start first_visible (Origin=1,178ms, Remote=6,703ms)
**Panel B**: Paired bars — 4-user trace-based sequential (Local 288 chunks/80ms vs Remote 12 chunks/21,141ms)
**Size**: 7.0 × 2.0 in (full width)

## Colors
- Local: #4477AA (blue)
- Origin: #228833 (green)  
- Remote: #EE6677 (coral)

## Generation: WSL matplotlib → PDF
