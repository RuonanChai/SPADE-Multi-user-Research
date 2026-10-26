# 3488 次匹配和 holder=0 不是同一批日志

两套数字都重算过，来自不同的 run id。

P2 封存浏览器的 B 臂：`peer_verify` 且 `peer_wait_ms` 为数值且原因为 DIGEST_MATCH 的条数合计 3488。这就是 `P0_EXISTING_BROWSER_COST.csv` 的 `match_n`。同一批 B 臂代理日志里，`peer_handoff` 与 `peer_handoff_merge` 交付 3503 行、5587506304 字节。`match_n` 计的是带等待时间的摘要匹配，交付行数还包含 follower 合并。两者相差 15 行，是计数口径不同，不是另一套实验。这些运行的代理是验证运行时 `df258c1954fec028bd1067fcf1625e01b7a701c2ee30626e8a1edb6daac758a5`，run id 带 `p2t`。

另一套是固定需求的来源日志，`DEMAND_MANIFEST.json` 里的六条 `nsdi_N3_S3FIFO_*_b30c*`。它们的 `peer_handoff` 行数和 DIGEST_MATCH 等待数都是 0。上一份审计说原始 N3 holder 为 0，指的是这六条来源日志，不是 P2 的 B 臂。

所以 3488 和 0 可以同时成立：一个是验证浏览器 B 臂的摘要匹配次数，一个是更早的 S3-FIFO 需求来源日志里根本没有 holder 交付。不能把 0 写成 P2 没有交接触发，也不能把 3488 写成那六条 b30c 日志的 holder 字节。
