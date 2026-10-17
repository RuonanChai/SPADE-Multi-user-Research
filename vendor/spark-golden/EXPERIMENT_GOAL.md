# 真实网络条件下 3DGS Streaming 瓶颈定位 — 实验目标

## 目标

在 **真实网络 / LAN / CDN / 限速 / 多客户端** 条件下，用可复现的分布式 benchmark 回答：

1. localhost 客户端渲染与传输上限是多少？
2. LAN asset server 是否引入网络瓶颈？
3. remote CDN 是否引入 TTFB / 下载 / 缓存瓶颈？
4. 限速与 RTT 下 `time_to_ready`、LoD 完整度、QoE、FPS 如何变化？
5. 多用户 lockstep / nearby / divergent 下 Range 是否重叠、CDN 是否复用？
6. 网络主要影响 preload、measure FPS，还是 streaming 过程中的 upload/parse 长尾？

## 正式 diagnostic arms（勿改语义）

| Arm ID | 含义 |
|--------|------|
| `E3_normal_streaming` | headed, DPR=1, 真实 Spark streaming |
| `E4_normal_dpr05` | headed, DPR=0.5, fill-rate / compositor 对照 |
| `E5_fetch_only` | 仅网络/Range 传输，不测 render |
| `E7_upload_only` | upload CPU/GPU 瓶颈 |
| `E8_pure_render` | preload 后阻断网络，测 render 上限 |
| `E9_static_pure_render` | 静态相机 pure render |
| `E10_moving_pure_render` | 动态相机 pure render |

**不得**将 `E0` / `E2` 写入正式 distributed summary。

## 两种 measurement mode（必须分开）

| Mode | 说明 |
|------|------|
| `warm_steady_render_mode` | preload 稳定 → measure 前等待 5s → 尽量 `measure_rad_requests=0` |
| `streaming_in_loop_mode` | measure 阶段允许继续 `.rad` 请求，测叠加影响 |

每个 trial JSON / CSV 必须包含：`measurement_mode`, `preload_blocked_before_measure`, `network_blocked_during_measure`, `measure_rad_requests`。

## Delivery profiles（`VRC_DELIVERY_PROFILE`）

- `local_loopback` — 客户端上限基线（**不得**当作真实 WAN 结论）
- `lan_server` — 独立 LAN asset server
- `remote_cdn` — HTTPS CDN/R2，须支持 Range/206
- `remote_cdn_throttled_*` — 在 remote 上叠加限速/RTT（工具不支持须在报告中声明）

配置见 `config/distributed_network/delivery_profiles.json`。

## 测量原则（不可违反）

| 原则 | 说明 |
|------|------|
| `time_to_ready_ms` | **已废弃**（恒为 null）。`configured_preload_duration_ms` 仅表示配置的 preload 等待，**不是**首屏时间 |
| cold-start | `scenario=cold_start_single_user` 且 **`warmup_ms=0`**；用 `first_visible_splat_ms` / `first_nonblack_frame_ms` |
| E8 | `measure_rad_requests` 在 measure 期 **必须为 0** |
| E3 streaming | measure 期 `measure_rad_requests` **≥ 30**（门禁 CDN 样本 **> 50**） |
| GPU | 禁止 SwiftShader / 空 renderer；须 headed 或能采到真实 `gpu_renderer` |
| vrc 双机 | 仅当 `gate-check` → `ready_for_vrc_dual=true` |

续跑已有批次时追加冷启动 trial：`node scripts/append-distributed-cold-start-trials.mjs --batchDir=<batch>`。

## 禁止事项

1. 不修改 Spark 渲染核心。
2. 不修改 E3–E10 基本含义。
3. 不使用 E0/E2 作为正式结论。
4. 不伪造协议、吞吐、QoE、FPS。
5. 不把 localhost 结果写成真实网络结果。
6. 不只看 FPS；必须同时输出 network / render / quality / memory / upload。
7. 不大规模重构实验框架；改动须最小、可复现、可回滚。

## 通过标准（canary）

`node scripts/check_distributed_canary.mjs` 在 `local_loopback` + `single_user` 下跑 E3/E5/E8 各 1 trial，且每个 trial 具备：

- `measure_fps`（E5 可为 null，但须有吞吐/请求）
- CDP `protocol`
- `network_*.jsonl` 或 `cdp_network_audit.csv`
- `asset_url`
- `measure_rad_requests`
- `webgl_renderer` / GPU 字段

**canary 未通过不得启动 24h 批次。**

## 输出目录

`260506_distributed_network_benchmark/<timestamp>/` — 见规格 §I（config / raw_logs / per_trial_json / csv / figures / reports）。

## 入口脚本

| 脚本 | 用途 |
|------|------|
| `scripts/check_distributed_canary.mjs` | 最小 canary |
| `scripts/run_24h_distributed_network_experiments.ps1` | 24h 无人值守（需 canary 通过后人工确认） |
| `scripts/resume_distributed_experiment.mjs` | 从 manifest 续跑 |
| `scripts/analyze_distributed_network_results.mjs` | 增量 CSV / 报告 / 图 |
