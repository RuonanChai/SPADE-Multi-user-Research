# 双公网链路 / HPC 直出 对照实验（bench）

本目录 **不复制** `run_experiment.mjs` / `run_experiment_distributed.mjs` / `vrc_distributed_merge.mjs`，**全部复用** `vrc-paper/experiments/` 下现有实现，保证 **指标与 baseline 行为不变**。  
仅通过环境变量切换 **`.rad` 等资源从何处 Range 拉取**（HPC HTTP、R2 A、R2 B、或 GCS 公共路径）。

## 目录结构

| 路径 | 作用 |
|------|------|
| `config/origin_profiles.example.json` | 资产源 profile 模板（复制为 `origin_profiles.json` 并改 URL） |
| `config/distributed_lab.example.json` | 双机 SSH 模板（复制为 `distributed_lab.json`） |
| `config/origin_profiles.json` | 已入库的默认 profile（`cdn_r2_secondary` 默认与 primary 相同，请改成第二 bucket） |
| `config/.gitignore` | 仅忽略 `distributed_lab.json`（含 SSH 路径等本机信息） |
| `scripts/Invoke-DualOriginMatrix.ps1` | 按 profile 循环设置 `VRC_*` 并调用 **分布式** runner |
| `scripts/Test-AssetOrigins.ps1` | 对 Coit 平铺 key 做 HTTP 探测（可选） |
| `RUNBOOK_DUAL_ORIGIN.md` | 环境与网络检查清单 |

## 你要的拓扑（概念对齐）

1. **Server（控制面 + 页面）**  
   - **Worker1 `controller_host`**：跑 **Vite + sync**，四用户里的 **u0、u1** 在本机 Playwright。  
   - 浏览器先打开 `http://<controller>:9200/vrc-paper/client_instrument/vrc_scene.html?...`（**先与「server」通信**：页面、sync、实验会话逻辑）。  
2. **Chunks（数据面）**  
   - 由 `vrc_scene` 内 Spark 对 **`.rad` URL** 发 **Range GET**；URL 根由 profile 决定：  
     - **HPC 直出**：`VRC_RAD_ASSET_BASE=http://10.120.17.176:8090`（需与 R2 相同的 **flat key** 路径，如 `streaming-lod/coit-40m-sh1-lod.rad`）。  
     - **CDN**：`VRC_RAD_ASSET_BASE=https://pub-....r2.dev`（主/备两个 bucket 各一条 profile）。  
     - **GCS 公共**：`VRC_USE_GCS_ONLY=1`（走页面内置 `use_gcs_rad` 逻辑，不经 R2 probe）。  
3. **4 clients 双机**  
   - 仍用 **`run_experiment_distributed.mjs`**：Worker1 上 **u0–u1**，SSH 到 Worker2 **u2–u3**，浏览器 **页面源** 始终指向 Worker1；**仅资产 HTTP 源**随 profile 变。

## 一次性配置

1. 配置：  
   - `config\origin_profiles.json`：已带 4 条 profile；**请把 `cdn_r2_secondary` 的 `VRC_RAD_ASSET_BASE` 改成第二个 R2 pub**（真正双 CDN 对照）。  
   - `config\distributed_lab.json`：首次可复制模板：  
     `powershell -File scripts\Copy-DualOriginConfigTemplates.ps1`  
     然后编辑其中的 SSH / 远端路径（该文件被 gitignore，不会提交）。  
2. **HPC**：确认从 **Worker1 与 Worker2** 均能访问 `http://10.120.17.176:8090/streaming-lod/...`（或你实际挂载前缀），且支持 **Range**、CORS 若与浏览器跨域有关。  
3. **不要把** `distributed_lab.json` 放进 `experiments/` 除非你也希望 `run_autonomous_pipeline_detached.ps1` 自动切分布式；本 bench 通过 **`VRC_DISTRIBUTED_CONFIG`** 指向 `benches\dual_origin_public\config\distributed_lab.json` 即可。

## 运行示例（脚本会自动 `cd` 到 spark-main 根）

```powershell
cd D:\Program\spark-main\spark-main\vrc-paper\benches\dual_origin_public\scripts

.\Invoke-DualOriginMatrix.ps1 `
  -ResultsRootBase "D:\SparkRuns\dual_origin_$(Get-Date -Format yyyyMMdd)" `
  -Methods "Full" `
  -Scenarios "nearby" `
  -Trials 1
```

只跑部分 profile：

```powershell
.\Invoke-DualOriginMatrix.ps1 -ResultsRootBase "D:\SparkRuns\dual_origin_test" `
  -OnlyProfileIds @("hpc_server_direct","cdn_r2_primary")
```

干跑：

```powershell
.\Invoke-DualOriginMatrix.ps1 -ResultsRootBase "D:\tmp\do" -DryRun
```

## 结果目录

每次总跑会在 `-ResultsRootBase` 下生成：

`yyyyMMdd_HHmmss_<profileId>/`

内含与其它实验相同的 `raw/`、`summary/` 等，以及 **`ORIGIN_BATCH_MANIFEST.json`**（记录本批 `VRC_RAD_ASSET_BASE` / `VRC_USE_GCS_ONLY` 快照）和 **`distributed_console.log`**。

对比 **HPC 直出 vs CDN** 时，用同一套下游分析脚本分别指向两个 `*_hpc_server_direct` 与 `*_cdn_r2_primary` 目录即可（**列名与 JSONL 结构未改**）。

## 与「第二个 CDN」的对应关系

| 对照目的 | 建议 profile |
|----------|----------------|
| HPC vs 默认 R2 | `hpc_server_direct` vs `cdn_r2_primary` |
| R2 bucket A vs B | `cdn_r2_primary` vs `cdn_r2_secondary`（第二 bucket 填好 URL） |
| R2 vs GCS 公共 | `cdn_r2_primary` vs `cdn_gcs_forge_public` |
