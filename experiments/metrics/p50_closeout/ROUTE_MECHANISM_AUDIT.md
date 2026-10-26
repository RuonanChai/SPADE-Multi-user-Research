# 浏览器路由不对称

视觉 worker SHA-256 `375f8ed1e0312f790ad34e9e0b0234d74b6ec1b017d9f99e4dde0799c9e01522`。`page.route("**/*")` 只写在 `config.handoff === true` 分支里。72 份已执行配置中，B 臂符合这条规则的有 36 / 36，A 臂 handoff 为 false 且日志没有 `handoff listening 19081` 的有 36 / 36。

B 臂对 `/_p5rad/` 和 `.rad` 的处理是 `route.fetch({ timeout: 60000 })`，然后 `response.body()` 取完整正文，有 `x-p5-handoff-key` 才放进本机缓冲，再 `route.fulfill({ response, body })`。失败时 `route.abort()`。A 臂没有这段拦截。72 份正式日志里有 49 行 `handoff route failed`，分布在 29 个 B 臂观看者。抽查 `visab_poland_27394531_r1_B` 的 C4：这些行在 `done` 之后 5 ms，原因是 `Response has been disposed` 和 `Request context disposed`，发生在关闭浏览器时。它们是收尾，不是回放窗口内的失败。

启动参数里没有 `--disable-http-cache`，代码也没有单独调用缓存开关。Playwright 对 `page.route` 的公开说明是：启用路由会关闭 HTTP 缓存。这只作用在注册了路由的 B 臂。与此同时，N23 代理和验证代理的响应都写 `Cache-Control: no-store`，Vite 的 `/_p5rad` 代理也把 `cache-control` 改成 `no-store`。因此这些 RAD 响应在到达浏览器之前已经被标成不可缓存。路由关闭缓存，并不等于这些响应本来会进 Chromium 缓存。

仍然存在的测量差异是：B 臂要等完整正文读入 Playwright，再交回页面。代理日志在 `res.end` 时已经结束，不包含这段客户端缓冲。所以 B 臂的浏览器完成语义和 A 臂的原生网络请求不是同一个定义。这是源码里确认的混杂，不是已经测得的毫秒数。

P2 的 `remote_worker_bundle.js` 没有 `page.route`。12/12 的浏览器完成时间变慢不能归因于视觉队列这条拦截路径。
