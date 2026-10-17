# WWW 长文目标（锁定）

paper_valid 仍是 false。本文件是要执行的问题，不是已成立的结论。

## 问题

多用户 Web 3DGS 的等待不在缓存替换，也不在用户数。共享 LRU 少取的是 origin 字节。每台浏览器自己的 3 条 Range 在途，把发送到首字节抬到约 400 ms。N=3 把同一条管道再验证一次，崖壁还在。

顶会里的多用户 3DGS（LTS、NETSPLAT、LapisGS、MuV2）调度的是无线、DASH 或链路。这套以太网 + COS 上，那条调度打不中。可见内容调度做不了：`render_visible` 是 null，`visibility_flag` 全为 true，`projected_importance` 全为 null。WiFi 与以太网是两个纪元，不能相减。SPADE、SIEVE、S3-FIFO 和槽位加到 10 都没有改掉这段等待。Belady 只是离线参照。

要写进 WWW 长文的机制只有一个可证伪句：

> 这段崖壁是浏览器到第一跳的 HTTP/1.1 Range 队头。把同一条取块改成直连代理，或改成真正打到的 HTTP/2，在途=3 的发送到首字节应落到与在途=1 无法分辨，origin 字节不明显变。

若下降不超过约 30 ms，机制失败。长文改成测量：共享缓存与用户数都碰不到这段等待。不另起调度器。

## 已经能引用的格

以太网、headed、LRU、50 MB/100、stop-go 同步、Vite HTTP/1.1、槽位 3。

- N=2：`viteh1_s3_r1`、`viteh1_s3_r2`，C3/C4 VALID，在途=3 约 446–480 ms。
- N=3：`viteh1_s3_r5`、`viteh1_s3_r6`，C3/C4/C5 VALID，2099 帧。少取 0.474 与 0.451。三方 Jaccard 0.966 与 0.950。在途=3 为 382–477 ms。

HTTP/2 旧格是 `ERR_CONNECTION_REFUSED` 或会话被重置，INVALID，不进主张。端口现在从 C3 能到 18081 和 18443。HTTP/2 复位是前端把同一条流处理了两次，修完再测。

## 第一跳结果

`radh2_s3_r5` 与 `r6` 都是 VALID。全部 `.rad` URL 在 `18443`，206 为 379–390，少取比例 0.375。全体发送到首字节中位 361–398 ms。在途深度最高到 24–26，在途=3 只有 1–4 条，不能用那个桶的中位数。等待没有落到在途=1 的带内。`send_to_vite` 仍是 null。

自动标记 `range_mux_works: true` 作废。裁定在 `F:\WWW_N3_MUX\metrics\H2_ADJUDICATION.json`：机制节关闭，不扩槽，不加 burst-turn。

直连 `18081` 的 `raddirect_s3_r1` 与 `r2` 也是 VALID，URL 全部落在 18081，全体发送到首字节中位 410–495 ms。绕过 Vite 没有拿掉崖壁。第一跳不是杠杆。见 `F:\WWW_N3_MUX\metrics\DIRECT_ADJUDICATION.json`。

产物仍在 `F:\WWW_N3_MUX`。不跑 formal_288，不动 8080 上的 Vite，不做 tc/netem。
