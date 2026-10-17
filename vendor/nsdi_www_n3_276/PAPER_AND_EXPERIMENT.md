# 长文问题、CSV 复用、C5 锁定、实验矩阵

拓扑已定死在 `LOCKED_TOPOLOGY.json`。N=3 LRU 复用分数在 `N3_REUSE_SCORES.json`。受保护树只读，不改。

## C5 定死

来源：`ETHERNET_TOPOLOGY.json`、`NETWORK_EPOCH_ETHERNET_20261015.json`、`CANONICAL_SSH_KNOWN_HOSTS`、`STUDY_V2_PREREGISTRATION.json`、`M1_GOLDEN_EXECUTION_CONTRACT.json`。

| 角色 | 以太网 IP | 主机名 | SSH | 控制台 | 实验 user_id |
| --- | --- | --- | --- | --- | --- |
| S | 192.168.1.200 | 控制器 | — | — | — |
| C3 | 192.168.1.197 | P5-C3 | p5remote | Z8 / InteractiveToken | C3_0 |
| C4 | 192.168.1.196 | P5-C4 | p5remote | Z8 / InteractiveToken | C4_1 |
| C5 | 192.168.1.195 | P5-C5 | p5remote | Z8 / InteractiveToken | C5_2 |

网关 192.168.1.1。C5 ed25519 `AAAAC3NzaC1lZDI1NTE5AAAAINzUMeBwdZ5I8qZWpJ4P954GHQH1bw5dYHaqLli1uze9`。旧 WiFi 纪元是 192.168.0.195，同一把主机钥匙，**不是**以太网对照。headed 必须打到 Z8 session 1，不能走 p5remote session 0。

## CSV 能复用什么，不能当长文

以太网 `ETHERNET_DEVELOPMENT_MASTER.csv`：**151 行**。N=2 且 C3+C4 有 147 行（SPADE 140，LRU 11），几乎全是 stop-go 同步。N=3 且 C3+C4+C5 **只有 4 行**，三台 VALID：SPADE×3 + LRU×1。

WiFi 账本 112 行全是 N=2，其中 C3+C5 29、C4+C5 31，**0 行 N=3**。与以太网不是因果介质实验。

FINAL_MASTER 186 行无 N=3。QOE_RUN_MASTER 40 行没有 N/客户端字段。

这些行的主终点是 origin/ttfb **汇总**。它们已经足够否定「再调 SPADE/SIEVE 当 NSDI 算法」。它们 **不够** 当长文新系统：没有按本机在途分层的发送到 Vite，没有 HTTP/2 第一跳，没有 burst-turn 的 N=3，CSV 里的 SPADE 对 LRU 在 N=3 上 origin 更高（1.28–1.45 GB 对 LRU 1.041 GB）。

旧 formal_288（N2=216 + N3=72，六种替换器）是 SPADE 资格矩阵。`STUDY_V2` 把它锁到 LEGAL_FREEZE_V2 之后。再跑这 288 格 **不会** 变成长文创新，时间再短也不该烧。

## 已复用的 N=3 LRU 格

`nsdi_N3_LRU_coit-40m-sh1-lod_stop_go_synchronized_rep3105_1792032224255`，清单标 `NONPAPER_ETHERNET_LRU_N3`，但 staging 里有完整 lifecycle 与 `scheduler_final_metrics.json`。C3/C4/C5 均为 VALID、2099 帧。

- 唯一 origin **1041185352**，proxy demand **2492106664**，少取比例 **0.582**（E1-A N=2 是 0.448）。
- 命中 424，未命中 623，在途合并 447。
- Range 键两两 Jaccard **0.643–0.668**，三方 **0.522**。C5 相对 C3∪C4 的新键 **21 / 289 = 7.3%**。第三用户主要复用已有块，不是 N=2 的克隆事故。
- 发送到首字节在途 1/2/3：C3 **65 / 275 / 496 ms**，C4 **50 / 298 / 499 ms**，C5 **56 / 279 / 487 ms**。在途=3 仍约 500 ms，与 E1-A 的 512–518 ms 同量级。等待不随 N=3 变差。

H-scale 的身份与延迟两条，**这一格已经指向成立**。缺的是：第二次重复、burst-turn、发送到 Vite 拆分、第一跳协议。没有这些，不能把测量扩成「新 Web 系统」长文。

## 长文要的新问题（不是 SPADE）

近两年顶会（LTS MMSys 2025、NETSPLAT SIGCOMM EMS 2025、LapisGS、RSMA-GS、MuV2）把多用户 3DGS 建成 **链路/无线/DASH** 竞争。本平台在已供给的以太网 + COS 上测到的是：

> 字节在 origin 身份上耦合；主导等待在每台浏览器自己的 3 槽位 HTTP Range 管道上。命中省 origin，省不掉在途=3 的约 500 ms。

长文轨道（WWW Research / CoNEXT / SIGCOMM 系统轨）需要 **改这条管道的机制**，而不是再换 LRU。候选机制 **Range-mux**：让 Spark 的三条在途 Range 走同一条多路连接（HTTP/2 到 18443，或直连 18081），不改准入、不改 50 MB/100 项、不改 COS。

若 Range-mux 把在途=3 的发送到首字节降到与在途=1 无法分辨，origin 不明显变：题目是浏览器 3DGS 的取块合同。这是相对 LTS/NETSPLAT 的真正对照——它们调度的是网，这里调度的是浏览器第一跳。

若降不下来：长文系统轨关闭。可改投 IMC 测量长文（管道分类 + N=1/2/3 缩放），不能投 NSDI 算法，不能把 SPADE 288 当创新。

## 实验矩阵（为长文，不是旧 288）

固定：以太网纪元、COS、LRU、50 MB/100、headed、Z8 InteractiveToken、70 s、相位写明 SYNCHRONIZED 或 STAGGERED。禁止 tc/netem、formal_288、改 8080 上未动的 Vite、把 WiFi CSV 与以太网相减。

**G0 复用（0 新格，本文件已做）。** N=2 E1-A + N=3 LRU staging。主终点已有。

**G1 证伪 Range-mux，最多 48 格。** 只 LRU。

| 因子 | 水平 |
| --- | --- |
| N | 2（C3+C4）、3（C3+C4+C5） |
| 第一跳 | Vite HTTP/1.1 `/_p5rad/`；`https://192.168.1.200:18443/` 且 SPARK 真正打到该 URL；直连 `http://192.168.1.200:18081/` |
| 槽位 | 1 与 3 |
| 轨迹 | stop_go |
| 重复 | 2 |

8 组合 × 2 规模 × 2 重复 = 32。再加 N=1（只 C3）× 3 跳 × 2 槽 × 2 重复 = 12。合计 **44**。burst-turn 只在 G1 的 HTTP/2 相对 HTTP/1.1 有差之后加，每条轨迹最多再 16 格。

主终点：按本机在途分层的发送到首字节，以及发送到 Vite（没有 Vite 时间戳则该格记 null，不作传输结论）。副终点：唯一 origin、少取比例、两两/三方 Jaccard。完整性：三台 VALID；A 与 B 的 origin 差须落在两次 LRU 重复内。

停止：HTTP/2 相对 HTTP/1.1，在途=3 中位下降不超过跨主机带（约 30 ms）→ Range-mux 失败，取消 burst-turn 与槽位扩展，改写 IMC 测量稿。不要用加槽到 10 当新机制（p272/Wave08 已测）。

**G2 系统消融，G1 成立才跑，最多 16 格。** 同一合同上关掉 mux / 只 mux 不共享缓存 / 共享缓存不 mux。用来把「第一跳」从「LRU」里拆开。

总物理上限 **60 格**。不是 288。时间远小于旧资格矩阵，覆盖的是长文真正缺的因子。

## 稿件结构（12 页量级）

1. 引言：Web 3DGS LoD 的多用户问题被建成了无线/DASH；测量显示瓶颈在浏览器 Range 在途。
2. 相关工作：LTS、LapisGS、NETSPLAT、MuV2、Spark、体积组播。
3. 平台与合同：三机 headed、Z8、以太网、COS、50 MB LRU。
4. 测量：N=2 M1–M3；N=3 复用格的 Jaccard 与在途分层。
5. 机制：Range-mux 与 Spark 三槽位合同。
6. G1/G2 结果。失败则本节改成阴性，全文降为测量。
7. 讨论：为何组播/替换器打不中；限制（单场景、轨迹族、无 QoE）。

`paper_valid` 在 G1 的 HTTP/2 格真正打到 18443 且两重复 VALID 之前，对系统主张保持 false。N=3 复用格可以写进测量节，须标明 `NONPAPER_ETHERNET_LRU_N3` 标签，并给出 staging 路径。
