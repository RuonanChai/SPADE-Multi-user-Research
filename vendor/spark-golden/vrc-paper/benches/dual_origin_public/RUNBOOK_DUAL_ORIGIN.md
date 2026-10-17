# 双资产源 + 双机分布式 — 环境搭建 RUNBOOK

## 目标

- **1 个「应用 server」**：Worker1（`10.4.158.143`）提供 **Vite + sync**，四用户页面与同步都先连这里。  
- **2 条「公网/可控 HTTP 资产链路」**：在 **不改 metrics 计算代码** 的前提下，用环境变量切换 **`.rad` Range 拉取根 URL**（HPC、R2-A、R2-B、GCS）。  
- **4 clients、双机**：`run_experiment_distributed.mjs`（本仓库已实现 u0–u1 本机 + u2–u3 SSH）。

## 网络清单（必查）

| 源 / 目标 | 需要通的端口 / 协议 | 说明 |
|-----------|---------------------|------|
| Worker2 → Worker1 | TCP `9200`（HTTP）、`9201`（WS） | 页面与 sync；**不能用 127.0.0.1 指 Worker1** |
| Worker1 → Worker2 | SSH `22`（或你改的 `ssh_port`） | 控制器发 shard 命令 |
| Worker1 / Worker2 → HPC | TCP `8090`（示例） | 仅当 profile 使用 `VRC_RAD_ASSET_BASE=http://10.120.17.176:8090` |
| Worker1 / Worker2 → 公网 | HTTPS `443` | R2 / GCS 拉 `.rad` |

## HPC 上「直出 server」要满足的布局

Runner / `dual_cdn_preflight.mjs` 会探测 **`GET <VRC_HPC_ASSET_BASE>/streaming-lod/coit-40m-sh1-lod.rad`**（与默认 R2 相同的 flat key），需 **200/206** 且支持 **Range**。

**`python3 -m http.server` 的 `cd` 目录（文档根）必须是 `streaming-lod/` 的父目录，即仓库下的 `spark-main/examples/`**（例如 `/home/.../Spark2.0/spark-main/examples`）。在该目录起服务后，约定 URL 为：

- `http://10.120.17.176:8090/streaming-lod/coit-40m-sh1-lod.rad` → 磁盘上 `examples/streaming-lod/coit-40m-sh1-lod.rad`

**常见 404 原因：**

| 若 `cd` 到 | 能直接访问的 Coit URL 形如 | 与约定 `/streaming-lod/coit-40m-sh1-lod.rad` |
|------------|-----------------------------|---------------------------------------------|
| `.../spark-main/examples` | `/streaming-lod/coit-40m-sh1-lod.rad` | 一致，`VRC_HPC_ASSET_BASE=http://10.120.17.176:8090` 即可 |
| `.../spark-main/examples/streaming-lod` | `/coit-40m-sh1-lod.rad`（无 `streaming-lod/` 前缀） | **不一致** → 404；应改 `cd` 到上一级 `examples` |
| `.../spark-main`（仓库根） | `/examples/streaming-lod/coit-40m-sh1-lod.rad` | **不一致**；要么 `cd examples` 再起服务，要么设 **`VRC_HPC_ASSET_BASE=http://10.120.17.176:8090/examples`**（使 `BASE` + `streaming-lod/...` 仍指向同一文件） |

若 HPC 只挂了别的前缀，把 **`VRC_HPC_ASSET_BASE`** 设到**能拼出上述 key 的 HTTP 根**（不要多一层或少一层路径段）。

## Worker2 与 Worker1 代码一致（可选 scp）

`run_experiment_distributed.mjs` 默认**不**同步到 Worker2。若要在分布式启动前推送，设置 **`VRC_DISTRIBUTED_PUSH_TO_WORKER2=1`**（与 **`VRC_DISTRIBUTED_PUSH_VRC_PAPER=1`** 等价）——**仅**推送 **`experiments/worker2_push_manifest.mjs`** 清单（`run_experiment.mjs`、`visual_validator.mjs`、`distributed_lab.json` + 可选根目录 `package.json`/锁文件）。**禁止** `scp -r vrc-paper/`。Worker2 浏览器页面由 Worker1 Vite 提供。**不推送 `node_modules`**。改 manifest 后须再推。一键：`Push-Worker2ExperimentBundle.ps1`。

## Cloudflare 第二套 R2（可选）

1. 新建 bucket，上传与主 bucket **相同 object key**（至少 `streaming-lod/coit-40m-sh1-lod.rad` 等实验会用到的对象）。  
2. 打开 R2 **Public access**，得到 `https://pub-xxxx.r2.dev`。  
3. 写入 `origin_profiles.json` 里 `cdn_r2_secondary.env.VRC_RAD_ASSET_BASE`。

## GCS 对照（可选）

Profile `cdn_gcs_forge_public` 使用 **`VRC_USE_GCS_ONLY=1`**，与现有 `run_experiment.mjs` 中 **无 CDN hit 时 fallback GCS** 的路径一致，指标集合不变。

## 常见故障

1. **分布式没启用**：不要用 detached 单机路径；请直接运行 `Invoke-DualOriginMatrix.ps1`（内部已设 `VRC_USE_DISTRIBUTED=1` 与 `VRC_DISTRIBUTED_CONFIG`）。  
2. **HPC profile 失败、日志写 `no Coit .rad on CDN`**，或 preflight 对 **`/streaming-lod/coit-40m-sh1-lod.rad` 返回 404**：说明 **8090 的文档根不是 `spark-main/examples`**（见上节表格）；或 **`VRC_HPC_ASSET_BASE`** 与文档根不匹配。  
3. **Worker2 白屏但 R2 正常**：多为 **9200/9201** 或 **controller_host** 写错；或 **CORS**（若页面与资源跨域策略过严）。

## 复用代码说明

- **Runner**：`vrc-paper/experiments/run_experiment_distributed.mjs` + `run_experiment.mjs` + `vrc_distributed_merge.mjs`  
- **客户端**：`vrc-paper/client_instrument/vrc_scene.html`（`rad_asset_base` / `use_gcs_rad` 已由上游注入）

本 bench 目录 **仅** 增加配置与编排脚本，避免与主实验脚本分叉。
