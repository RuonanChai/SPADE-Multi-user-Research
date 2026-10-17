# 第三章 单用户主动交付（v2 ready-aware）

> 数据源：`paper_materials/proactive_single_user_v2/runs/2026-05-24T16-06-30`  
> 交付路径：HPC origin (10.120.17.176:8090)，交错顺序，每基线 N=3  
> 生成日期：2026-05-25

## 3.1 问题动机

按需 HTTP Range 拉取大型 3DGS 瓦片文件引入根本性时序问题：客户端在对应瓦片 chunk 完成「获取→解码→GPU 上传」之前无法渲染该视口区域。对于 1.28 GB 的 `.rad` 文件经校园 LAN 传输（RTT ≈ 8 ms，有效吞吐 ≈ 80 MB/s），每个 1.7 MB chunk 从请求到渲染就绪需 ≈ 80–120 ms。当相机移入新区域时，按需管线无法在 100 ms 交互截止时间内完成大多数 chunk 的就绪。

## 3.2 实验设计

**资产与交付**：40M splat 场景（Coit Tower, SF），chunked `.rad` 格式（1.28 GB, 341 chunks @ LOD-0），HPC origin 经 HTTP Range 206 提供。

**基线**：

| ID | 策略 | 说明 |
|----|------|------|
| B0 On-demand | Spark 默认 streaming-LOD | chunk 仅在 pager 判定视口需要时拉取 |
| B3-ready (VRC-Single v2) | 就绪感知主动控制器 | 预测相机姿态 0.5–2 s，按视口相关性 + LOD 重要性评分，Worker 并发 prefetch（maxParallel=2, 128 MB budget），fetch 完成后发射 `parse_complete` |
| B4-ready-oracle | 同 B3 管线，优先级由 B0 参考需求轨迹的完美未来知识决定 | oracle 上界 |

**测量协议**：20 s warmup + 40 s 自动轨道测量；交错顺序（B0/B3/B4/B0/B3/B4/B0/B3/B4）确保每基线经历相同缓存预热序列；本地代理服务器记录每请求服务端时序，与 CDP 网络审计行对齐（对齐率 ≥ 99.7%）。

**指标定义**：

| 指标 | 定义 |
|------|------|
| `deadline_miss_ratio_100ms` | 就绪时间超过需求时间 >100 ms 的 demanded chunk 比例 |
| `useful_chunks_before_demand` | 在渲染器需求之前已达就绪状态的 chunk 数 |
| `first_visible_splat_ms` | 页面加载到首个非零可见 splat 的时间 |
| `wasted_prefetch_ratio` | 预取但从未被需求的字节 / 总预取字节 |
| `measure_fps` | 测量阶段平均渲染帧率 |

## 3.3 结果

### 汇总表（均值 ± 标准差，N=3，HPC origin，交错顺序）

| 基线 | miss₁₀₀ (%) | useful_before | first-vis (s) | FPS | wasted (%) | demanded |
|------|-------------|---------------|---------------|-----|------------|----------|
| B0 On-demand | 69.8 ± 26.3 | 106 ± 94 | 5.0 ± 1.9 | 107.4 ± 34.5 | 0.0 | 305 ± 89 |
| B3-ready | 62.5 ± 5.2 | 121 ± 13 | 3.7 ± 0.7 | 88.5 ± 3.0 | 6.2 ± 0.8 | 324 ± 15 |
| B4-ready-oracle | 66.5 ± 3.7 | 104 ± 12 | 7.7 ± 1.3 | 86.8 ± 1.3 | 10.5 ± 0.4 | 312 ± 4 |

### 冷启动性能（t0，无缓存状态）

| 基线 | miss₁₀₀ (%) | useful_before | first-vis (ms) | FPS | demanded |
|------|-------------|---------------|----------------|-----|----------|
| B0 On-demand | 99.5 | 0 | 7,111 | 147.2 | 203 |
| B3-ready | 65.1 | 119 | 3,352 | 85.5 | 341 |
| B4-ready-oracle | 69.7 | 94 | 8,500 | 87.2 | 310 |

**关键发现**：冷启动条件下，B3-ready 将截止时间违规率降低 34.4 个百分点（相对 B0 降幅 **−34.6%**），首次可见延迟从 7.1 s 降至 3.4 s（**−52.9%**）。控制器使 Spark pager 在测量窗口内请求 341 个 chunk（B0 仅 203），因为预取 chunk 更快完成并解锁后续分页决策。

### 逐试验数据（完整记录）

| 基线 | 试验 | miss₁₀₀ (%) | useful_before | first-vis (ms) | FPS | demanded | wasted (%) |
|------|------|-------------|---------------|----------------|-----|----------|------------|
| B0 On-demand | t0 (cold) | 99.5 | 0 | 7,110.6 | 147.2 | 203 | 0.0 |
| B0 On-demand | t1 (warm) | 60.2 | 140 | 3,626.7 | 87.2 | 354 | 0.0 |
| B0 On-demand | t2 (warm) | 49.6 | 178 | 4,225.6 | 87.7 | 359 | 0.0 |
| B3-ready | t0 (cold) | 65.1 | 119 | 3,352.3 | 85.5 | 341 | 5.3 |
| B3-ready | t1 (warm) | 56.6 | 134 | 4,589.4 | 91.5 | 311 | 6.8 |
| B3-ready | t2 (warm) | 65.9 | 109 | 3,296.9 | 88.4 | 320 | 6.6 |
| B4-ready-oracle | t0 (cold) | 69.7 | 94 | 8,499.8 | 87.2 | 310 | 10.6 |
| B4-ready-oracle | t1 (warm) | 67.3 | 100 | 8,301.8 | 87.9 | 309 | 10.8 |
| B4-ready-oracle | t2 (warm) | 62.5 | 118 | 6,217.9 | 85.4 | 317 | 10.0 |

### 缓存预热动态

B0 的性能随试验轮次显著改善（OS/浏览器缓存预热）：

| 试验 | miss₁₀₀ (%) | useful_before | demanded | 解释 |
|------|-------------|---------------|----------|------|
| t0 | 99.5 | 0 | 203 | 完全冷态：每个 chunk 从 HPC 经 LAN 拉取；Spark pager 饥饿 |
| t1 | 60.2 | 140 | 354 | OS page cache + Chrome disk cache 从 t0 预热；proxy keep-alive 复用 |
| t2 | 49.6 | 178 | 359 | 完全暖态：大多数 chunk 从缓存 <1 ms 提供 |

B3-ready 在各轮保持稳定（miss₁₀₀ ≈ 60–66%），因其预取调度不依赖宿主缓存状态。这揭示 B0 的汇总均值（69.8%）被暖缓存试验主导——在暖缓存下 Spark 的自然管线无需主动控制器即可实现近等效的预暂存。

### Oracle 悖论

B4-ready-oracle 的 first-visible（7,673 ms 均值）反而**差于** B3-ready（3,746 ms）。

**根因**：oracle 按 B0 参考需求轨迹的 `chunk_needed_time` 排序预取优先级。参考轨迹中 chunk 0（.rad 元数据头 + 首个 LOD 瓦片，仅 65 KB）被最先需求。oracle 因此最先预取 chunk 0——但 chunk 0 本身极小，无论如何瞬间到达。同时 oracle 延迟了决定 `first_visible_splat_ms` 的**视口相关 chunk**（它们在参考需求轨迹中出现较晚）。B3-ready 的视口优先评分（`scoreChunk`）自然优先空间相关 chunk，尽管预测不完美但产生更快的初始内容呈现。

### 预取效率

B3-ready 仅浪费 6.2% 的预取字节（远低于 30% 阈值）。视口优先评分函数有效瞄准渲染器将在预测窗口内需要的 chunk。

### 渲染性能

B3-ready 维持 88.5 FPS（B0 107.4 FPS, −17.6%），高于 60 FPS 交互阈值。FPS 差异部分是 B0 t0 膨胀值的伪影（147.2 FPS 仅 203 demanded chunks，表明渲染器在等待数据而非满负荷渲染）。暖试验中 B0 和 B3 收敛至 ≈ 87–91 FPS。

## 3.4 §7 成功门槛检查

| # | 条件 | 通过 | 值 | 备注 |
|---|------|------|-----|------|
| 1 | miss₁₀₀ 相对降幅 ≥30% | ❌ | 10.3% | 汇总被暖缓存稀释；冷启动单独看 −34.6% 通过 |
| 2 | useful_before ≥ 3× B0 | ❌ | B0=106 vs B3=121（1.14×） | B0 暖缓存自然 useful 高 |
| 3 | first_visible 改善 | ✅ | B0=4988ms → B3=3746ms（−24.9%） | |
| 4 | useful_bytes_ratio 提升 | ✅ | 0.30 → 0.38（+26.7%） | |
| 5 | wasted_prefetch_ratio ≤30% | ✅ | 6.2% | |
| 6 | FPS 下降 <20% | ✅ | −17.6%（107.4→88.5） | 边界；B0 t0 膨胀均值 |

**通过 4/6 条**（≥2 条即满足规格门槛）。

## 3.5 讨论

结果表明就绪感知主动交付在**冷启动场景**（新用户首次加入 3DGS 场景）提供可测量的收益。控制器的价值集中在会话的前 ≈ 5–10 秒，此期间按需拉取使渲染器处于数据饥饿状态。一旦宿主缓存预热（首次完整遍历场景后），Spark 的自然 streaming-LOD 管线无需主动控制器即可实现可比的预暂存率。

**对多用户系统的启示**：

1. 对于会话中的**第一个用户**（或任何访问先前未缓存区域的用户），主动交付提供实质性冷启动加速。
2. 对于视口与先前访客重叠的**后续用户**，宿主缓存预热效应表明多用户协调可放大收益——一个用户的预取为其他用户预热缓存——这激发了后续章节研究的视口感知范围协调（VRC）。

## 3.6 与 v1 对比

| 指标 | v1 B3 (origin) | v2 B3 (origin, cold t0) | 改善原因 |
|------|----------------|-------------------------|----------|
| miss₁₀₀ | ~100% | 65.1% | v2 修复 cid 不一致 + ready-aware |
| useful_before | 0 | 119 | v1 prefetch 用裸 range 作 cid，与 demand 的 `url::range` 永不匹配 |
| FPS | ~77 | 85.5 | v2 Worker 并发控制更优 |

## 3.7 局限性

- ready-event 策略使用 `parse_complete` 作为 GPU-upload-complete 的代理（Spark 当前架构不暴露逐 chunk 上传事件）。实际渲染就绪时间可能略晚于报告值。
- 交错试验顺序控制但不消除缓存预热。完全随机化 + 显式缓存刷新可提供更紧的置信区间。
- 测量在单一场景（Coit Tower, 40M splats）上进行。推广到其他场景规模和网络条件需额外实验。

## 3.8 图表说明

| 图号 | 文件 | 描述 |
|------|------|------|
| Fig. 3.1 (a) | `fig_v2_deadline_miss.pdf` | 截止时间违规率（miss₁₀₀）。单点为逐试验值，柱为均值 ± s.d.。B3-ready 方差更低（5.2% vs B0 26.3%）、均值更低。B0 高方差反映缓存预热。 |
| Fig. 3.2 (b) | `fig_v2_first_visible.pdf` | 首次可见延迟。B3-ready 3.7 s vs B0 5.0 s（−24.9%）。B4-oracle 7.7 s 因需求轨迹排序延迟视口相关 chunk。 |
| Fig. 3.3 (c) | `fig_v2_useful_before.pdf` | 需求前就绪 chunk 数。B3-ready 121 ± 13 vs B0 106 ± 94（B0 方差极大因冷/暖差异）。 |
| Fig. 3.4 (d-e) | `fig_v2_cold_warm_dynamics.pdf` | 冷启动 vs 暖状态动态。(d) B0 miss₁₀₀ 从 99.5% 降至 49.6%；B3 稳定 60–66%。(e) B0 useful 从 0 升至 178；B3 稳定 109–134。 |
| Fig. 3.5 (f-g) | `fig_v2_efficiency.pdf` | 效率。(f) FPS 均 >60；B0 t0 的 147 FPS 反映渲染器空闲等数据。(g) 浪费预取 B3 仅 6.2%，远低于 30% 阈值。 |
| Fig. 3.6 (h) | `fig_v2_visibility_timeline.pdf` | 可见性时间线（冷启动 t0）。B3-ready 比 B0 早 ≈ 3.8 s 达到非零可见 splat，且因预取加速分页更快达到高 splat 数。 |

## 3.9 数据完整性与可复现性

所有原始数据保存于：
- 每试验 JSON（含完整 proactive_snapshot）：`paper_materials/proactive_single_user_v2/runs/2026-05-24T16-06-30/per_trial_json/`
- 每试验运行目录（CDP 审计 CSV、服务器请求日志 JSONL、Chrome trace）：`per_trial_runs/`
- 汇总 CSV：`paper_materials/proactive_single_user_v2/proactive_single_user_v2_summary.csv`
- 深度分析报告：`paper_materials/proactive_single_user_v2/deep_analysis_final.md`
- 图表生成脚本（WSL Python3 + matplotlib）：`vrc-paper/paper/figures/proactive_single_user_v2/gen_v2_figures_wsl.py`
- 实验矩阵配置：`config/proactive_single_user_v2/experiment_matrix.json`
- 运行器脚本：`scripts/proactive_single_user_v2/run.mjs`

复现命令：
```bash
# 从 spark-main 仓库根目录
node scripts/proactive_single_user_v2/run.mjs --phase=phase1_origin_interleave --maxRetries=1
node scripts/proactive_single_user_v2/analyze.mjs --batchDir=<output_batch_dir> --writeChapter
wsl bash -c "python3 /mnt/d/Program/spark-main/spark-main/vrc-paper/paper/figures/proactive_single_user_v2/gen_v2_figures_wsl.py"
```
