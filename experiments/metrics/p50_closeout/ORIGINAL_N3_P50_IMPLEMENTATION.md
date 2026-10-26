# 原始 N3 浏览器 p50 的实现

P2 封存的 12 对浏览器完成时间来自 `remote_worker_bundle.js` 的 CDP 事件，不是 PerformanceResourceTiming，也不是代理时钟。

`Network.requestWillBeSent` 把 `timestamp` 记入 `requestSent`。`Network.loadingFinished` 把同一个 CDP `timestamp` 记入 `finished`。`p2_metrics.js` 计算 `finished - requestSent`，再用 ceil 分位写入 `browser_p50_ms`。

CDP 的 Network 时间戳单位是秒。字段名写成了毫秒，存储的数字本身是秒。一条原始生命周期记录的差值约为 0.315 秒。12 对的 B−A 是 +0.056 到 +0.183 秒。这里不做跨时钟换算；只说明协议单位和字段名不一致。

这份 worker 用 `page.route` 的搜索结果是 没有。P2 的 `screenshotSampled` 为 false，6 个检查点仍调用 `captureCheckpoint` 的 `gl.readPixels`。因此 12/12 的完成时间变慢发生在有画布读回、没有视觉队列这条 `route.fetch` 路径的运行上。

代理跨度是另一只时钟：代理进程 `Date.now` 从收下请求到 `res.end` 之后写日志。它不包含 Vite 转发，也不包含浏览器端把正文读完再 `route.fulfill`。固定重放的 `service_ms` 是 Node 客户端自己的发送到完成，没有浏览器。
