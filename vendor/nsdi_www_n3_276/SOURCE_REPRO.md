# 从成功 Ethernet headed runs 复现，不猜

对照源（只读）：`D:\Program\P5_3DGS_ICASSP_CLEAN`

- 启动：`scripts/icassp_campaign_controller.js` `createRemoteTask` / `runRemoteTask`
- 成功 N=3 LRU XML：`artifacts/P5_Experiment_nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_synchronized_rep3105_1792032224255_C5.xml`
- CONFIG.C5.interactiveUser：`thinkpad t14`（不是 Z8，也不从 query session 拆词）

相对 E1 `console_launch.ps1` 的 diff：

| | 成功 Ethernet | 之前 G1 猜的 |
| --- | --- | --- |
| UserId | 写死 `Z8` / `thinkpad t14` | 解析 `query session`，C5 变成 `Thinkpad` |
| 动作 | `node.exe` + worker + config + sha | `cmd.exe /c start_*.cmd` |
| 注册 | `schtasks /create /xml /f` | `Register-ScheduledTask` |
| 运行 | `schtasks /run` | `Start-ScheduledTask` |
| 工作目录 | `D:\Program\P5_3DGS_ICASSP_CLEAN` | 无 |

G1 仍走 18080/18081（不碰 8080 pid 65108），证据仍写 `F:\WWW_N3_MUX`。
