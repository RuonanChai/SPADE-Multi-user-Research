# WWW285 paper delta

This delta is development evidence for one scene (`coit-40m-sh1-lod`) and one trace (`stop_go`) on verified Ethernet. It is not a confirmation result and not submission-ready.

## What the paired runs show

On N=2 client C3, fixed LRU slots=2 completes 384 and 378 windowed 206 responses. Slots=1 completes 273 and 277. Slots=3 completes 387 and 379, while send-to-first p95 rises from 373.6/430.7 ms at slots=2 to 616.5/629.3 ms. SPADE v1 stays in the slots=1 band. SPADE v2 r3/r4, after the header callback was repaired, completes 294 and 262 on C3. Its headers-pending peak stays 1 while its body-active peak reaches 2.

Send-to-complete p50 minus send-to-first p50 is about 24 ms on the slots=2 C3 runs (269.9−246.2 and 297.8−272.9). Client GPU utilization is already about 96 percent at slots=1. The completion gap is therefore not explained by body transfer time or by idle GPU.

The offline always-ready fixture (header service 165 ms, body 30 ms, 70 s) gives 359, 718, 1077, 424, and 717 completions for slots=1, slots=2, slots=3, header-release, and a second header slot delayed by 80 ms. The delayed second header matches slots=2. That mechanism is not a new physical cell.

## Decision

The first authenticated task-context tick selected `IMPLEMENTATION_TEST`: a deterministic draw-visibility canary, with no new run id. The canary counts a chunk only when a submitted draw names it. Upload, READY, and residency stay unmeasured rather than zero. Existing `www_chunk_draw_inclusion_count`, presentation, PSNR, and SSIM values stay unmeasured.

The empty-queue restart selected `OFFLINE_ANALYSIS`: replay saved arrivals through one and two servers. Using slots=3 request-send times and the slots=1 completion p50 as service, the replay ratios are 1.081 on N=2 C3 and 1.062 on N=3 C5. The measured ratios are 1.407 and 1.087. The slots=3 clock is a poor exogenous demand: its C3 enqueue gap p50 is 184 ms, close to the 199 ms slots=1 service, so the renderer is already waiting. The replay therefore does not explain the measured N=2 C3 gain. It also stays below the pre-registered 1.85 ratio that would have been treated as always-ready doubling. No physical cell follows.

## Not claimed

No Wi-Fi result, no frozen confirmation matrix, no holdout, and no claim that 3,665 measured field values are 3,665 paper-valid metrics.
