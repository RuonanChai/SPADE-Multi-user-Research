# Measurement-Driven Motivation — 导师汇报版（Origin 3-trial 修订）

## 实验设置

- 场景：Coit Tower (40M splat)，Spark 2.0 streaming-LoD
- 口径：**单用户 3 trials 均值**（多用户标注为 trace-based sequential）
- Chrome 147 headed，NVIDIA RTX 4070 Laptop GPU，1280×720
- Origin server 数据来自 12-trial repeat batch（2026-05-22）

## 三层传输

| 层级 | 含义 | chunk p95 完成时间 (3-trial mean) |
|------|------|----------------------------------|
| Local baseline | 同机 asset server (localhost/loopback reference path) | 30 ms |
| Origin server | HTTP Range server @ 10.120.17.176:8090 | 499 ms |
| Remote server | 地理分布式边缘节点 (Cloudflare R2, unthrottled) | 15,872 ms |

## 核心数据（单用户，3 trials 均值）

| 传输层级 | 场景 | FPS | Chunk 数 (40s) | Chunk p95 (ms) |
|----------|------|-----|----------------|----------------|
| Local baseline | 正常流式 | 86.9 | 230 | 30 |
| Local baseline | Fetch-only | 129.2 | 140 | 161 |
| Local baseline | 纯渲染 | 115.5 | 0 | — |
| Origin server | 正常流式 | 88.3 | 277 | 499 |
| Origin server | Fetch-only | 165.0 | 140 | 991 |
| Origin server | 纯渲染 | 92.3 | 0 | — |
| Remote server | 正常流式 | 156.3 | 17 | 15,872 |
| Remote server | Fetch-only | 165.0 | 5 | 140,626 |
| Remote server | 纯渲染 | 164.9 | 0 | — |

## 三层叙事

### Layer 1：Local baseline 证明客户端管线可用

- 正常流式 86.9 fps，40s 内完成 230 个 chunk
- 纯渲染 115.5 fps → decode+upload 有开销但不是主要瓶颈
- **结论**：pure rendering is not the primary bottleneck under this setup

### Layer 2：Origin server 暴露 per-chunk 延迟；p95 跨层级递增

- 正常流式 88.3 fps / 277 chunks（吞吐与 local 相当）
- 但 chunk p95 从 30ms 升到 **499ms**（17×）
- Fetch-only：p95 = 991ms，chunk 数仍为 140（与 local 相同）→ 网络是主要开销
- 冷启动 first_visible = 1,178 ms (range 948–1,657 ms, n=3)
- **结论**：管线靠请求重叠维持吞吐，但单 chunk 延迟已是百毫秒级

### Layer 3：Remote server 放大 mismatch，出现 "fast but empty"

- 正常流式 **156.3 fps**（比 local/origin 还高！）但只到了 **17 chunks**（少 93%）
- chunk p95 = 15,872 ms（比 local 高 **529×**，比 origin 高 **32×**）
- **"快但空"**：chunk 到达太少 → decode/upload 几乎不执行 → 帧率虚高，画面几何细节严重不足
- Remote chunk arrival drops sharply; p95 increases across all tiers
- 冷启动 first_visible = 6,703 ms（origin 的 5.7×）
- 4 用户 trace-based sequential：只到 12 chunks/client，p95 = 21,141 ms

### 根本 mismatch

On-demand large Range fetching 与交互式 3DGS streaming 不匹配：
- Origin server：per-chunk p95 已是 local 的 17×
- Remote server：是 local 的 529×
- 服务器不知道 viewport 下一步需要哪些 chunk
- 不知道多用户是否共享同一 tile set
- 不知道哪个源能最快送达

→ **Motivate VRC**：viewport prediction + prefetch + chunk priority + multi-user deduplication + source-aware scheduling

**注意**：VRC 的有效性需要后续双机实验验证，此处仅建立 motivation。

## 数据来源

| 数据 | 来源 |
|------|------|
| Local baseline | `arm_comparison_e3_e5_e8.csv`, local_loopback single_user (n=3) |
| Origin server | `origin_repeat_runs/origin_repeat_results.json` + cold_start retries (n=3 each) |
| Remote server | `arm_comparison_e3_e5_e8.csv`, cdn1_r2 single_user (n=3) |
| Remote 4-user | `arm_comparison_e3_e5_e8.csv`, cdn1_r2 lockstep_4users (n=8) |
| Cold start local | `distributed_network_report.md` §Per profile: 1440ms (n=2) |
| Cold start remote | `distributed_network_report.md` §Per profile: 6703ms (n=2) |
