# VRC 论文实验环境（从 spark-main 根目录）

目标：**自检 → 真实浏览器 canary/prefull →（可选）72-run → 校验与报表 → 打包论文素材**。长任务一律 **detached** 或 **autopilot 子进程**，避免占满交互终端。

## 前置

- Windows + PowerShell，`node` / `npm` 在 PATH；建议 `python` 或 `py`（主编排末尾跑 `analysis/*.py`）。
- 仓库根执行：`cd D:\Program\spark-main\spark-main`（或你的克隆路径）。
- 读 `vrc-paper/VRC_MASTER_AUTORUN.md`、`vrc-paper/REAL_EXPERIMENT_DEBUG_PROTOCOL.md`。

## npm 命令（cwd = 仓库根）

| 命令 | 作用 |
|------|------|
| `npm run vrc:paper:check` | 检查路径与 node/python |
| `npm run vrc:paper:orchestrator` | **单次 detached** 主编排；新目录 `vrc-paper/results_onerun_*`；**不含** 72 全量 |
| `npm run vrc:paper:orchestrator:72` | 同上 + **72-run + 报表**（`VRC_RUN_FULL_PIPELINE=1`） |
| `npm run vrc:paper:autopilot` | **24h 内循环** canary+prefull（失败会重试；见 `results_autopilot_session_*`） |
| `npm run vrc:paper:autopilot:72` | 同上，但成功条件为 **full pipeline `complete`** |
| `npm run vrc:paper:bundle` | 打包论文产物（需传参，见下） |

## 打包论文产物（72 成功后）

```powershell
npm run vrc:paper:bundle -- -ResultsRoot "D:\...\spark-main\vrc-paper\results_xxx" -Zip
```

生成 `vrc-paper/results_xxx/paper_bundle/`（及可选 zip）。

## Autopilot + 自动 debug（可选 Hook）

1. 复制 `vrc-paper/scripts/vrc_autopilot_hook.example.ps1` → `vrc-paper/scripts/vrc_autopilot_hook.ps1`，在里调用 `@cursor/sdk` 或写队列文件。
2. 从根目录执行（示例）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vrc_paper_experiment.ps1 autopilot -RunFullPipeline -HookScript "D:\...\spark-main\vrc-paper\scripts\vrc_autopilot_hook.ps1"
```

Skills **不会自动执行**；Hook 里调 SDK 或你定时打开 Claude Code 并粘贴 `vrc-paper/scripts/CURSOR_PROMPT_AUTOPILOT.txt`。

## 成功判据

- 单次：`vrc-paper/<results>/RUN_STATE.json` 的 `phase` 为 `prefull_complete`（未开 72）或 `complete`（72+报表）。
- Autopilot：同目录下 `AUTOPILOT_SUMMARY.md` 含 `**SUCCESS**`。
