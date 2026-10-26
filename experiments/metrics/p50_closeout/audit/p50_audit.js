"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const OUT = "F:/SPADE_WWW27_P50_CLOSEOUT_20261025";
const VISUAL = "F:/SPADE_WWW_VISUAL_COS_20261025";
const P2 = "F:/SPADE_WWW_EVIDENCE_V2_20261024/P2_CORE";
const REPLAY = "F:/SPADE_WWW_PHYS_REPLAY_20261025";
const USERS = { C3: "user_C3_0", C4: "user_C4_1", C5: "user_C5_2" };
const CHECKS = [2, 5, 10, 20, 40, 60];
const CLIENTS = ["C3", "C4", "C5"];

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(file, rows) {
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
async function eachJson(file, visit) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) await visit(JSON.parse(line));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const workerPath = path.join(VISUAL, "controller", "treatment_worker.js");
  const capturePath = "F:/SPADE_WWW_EVIDENCE_V2_20261024/runtime/capture_checkpoint.js";
  const n3Worker = "D:/Program/SPADE/SPADE_BYTE_N23_20261023/physical_runtime/remote_worker_bundle.js";
  const n23Proxy = "D:/Program/SPADE/SPADE_BYTE_N23_20261023/physical_runtime/proxy.js";
  const verifiedProxy = "F:/SPADE_WWW_EVIDENCE_V2_20261024/runtime/proxy.js";
  const hashes = {
    visual_worker: await sha256File(workerPath),
    capture_checkpoint: await sha256File(capturePath),
    n3_worker_bundle: await sha256File(n3Worker),
    n23_proxy: await sha256File(n23Proxy),
    verified_proxy: await sha256File(verifiedProxy),
    p2_metrics: await sha256File(path.join(P2, "controller", "p2_metrics.js")),
  };
  const workerText = fs.readFileSync(workerPath, "utf8");
  const n3Text = fs.readFileSync(n3Worker, "utf8");
  const routeOnlyWhenHandoff = workerText.includes("if (config.handoff === true)") && workerText.includes('page.route("**/*"');
  const n3HasRoute = n3Text.includes("page.route(");
  const n3HasCdp = n3Text.includes("Network.requestWillBeSent") && n3Text.includes("Network.loadingFinished");

  const matrix = JSON.parse(fs.readFileSync(path.join(VISUAL, "treatment", "TREATMENT_MATRIX.json"), "utf8"));
  const routeRows = [];
  const captures = [];
  for (const session of matrix.sessions) {
    const root = path.join(VISUAL, "treatment", session.runId);
    for (const client of CLIENTS) {
      const config = JSON.parse(fs.readFileSync(path.join(root, `${client}_config.json`), "utf8"));
      const log = fs.readFileSync(path.join(root, client, "treatment_worker.log"), "utf8");
      const ready = JSON.parse(fs.readFileSync(path.join(root, client, "READY.json"), "utf8"));
      const listening = log.includes("handoff listening 19081");
      const routeFailures = (log.match(/handoff route failed/g) || []).length;
      routeRows.push({
        run_id: session.runId,
        pair_id: session.pairId,
        scene: session.sceneId,
        arm: session.arm,
        client,
        config_handoff: config.handoff === true,
        config_method: config.method,
        ready_handoff: ready.handoff === true,
        log_says_listening_19081: listening,
        route_failure_lines: routeFailures,
        route_enabled: config.handoff === true,
        explicit_disable_http_cache_flag: false,
        launch_args_include_disable_http_cache: false,
        worker_sha256: hashes.visual_worker,
        matches_only_b_rule: (session.arm === "B") === (config.handoff === true) && (session.arm === "B") === listening,
      });
      for (const checkpoint of CHECKS) {
        const canvas = JSON.parse(fs.readFileSync(path.join(root, client, `canvas_t${checkpoint}.json`), "utf8"));
        const endClient = canvas.trace_origin_ms + canvas.trace_relative_s * 1000;
        captures.push({
          run_id: session.runId,
          pair_id: session.pairId,
          scene: session.sceneId,
          arm: session.arm,
          viewer: client,
          user_id: USERS[client],
          checkpoint_s: checkpoint,
          capture_ms: canvas.capture_ms,
          trace_relative_s: canvas.trace_relative_s,
          scheduled_late_ms: canvas.scheduled_late_ms,
          trace_origin_ms: canvas.trace_origin_ms,
          clock_offset_ms: ready.clock_offset_ms,
          capture_end_client_ms: endClient,
          capture_start_client_ms: endClient - canvas.capture_ms,
          capture_start_server_ms: endClient - canvas.capture_ms + ready.clock_offset_ms,
          capture_end_server_ms: endClient + ready.clock_offset_ms,
          method: canvas.method || "",
          substages_with_two_timestamps: "NONE",
        });
      }
    }
  }

  const bySession = new Map();
  for (const row of captures) {
    const list = bySession.get(row.run_id) || [];
    list.push(row);
    bySession.set(row.run_id, list);
  }
  for (const session of matrix.sessions) {
    const windows = bySession.get(session.runId);
    const spans = new Map();
    for (const row of windows) spans.set(`${row.viewer}:${row.checkpoint_s}`, []);
    const outside = new Map();
    for (const client of CLIENTS) outside.set(client, []);
    await eachJson(path.join(VISUAL, "treatment", session.runId, "S_runtime", "proxy.jsonl"), (record) => {
      const viewer = Object.keys(USERS).find((client) => USERS[client] === record.user_id);
      if (!viewer) return;
      const start = record.request_start_ms;
      const end = record.timestamp;
      const span = end - start;
      let hit = false;
      for (const row of windows) {
        if (row.viewer !== viewer) continue;
        if (start < row.capture_end_server_ms && end > row.capture_start_server_ms) {
          spans.get(`${row.viewer}:${row.checkpoint_s}`).push(span);
          hit = true;
        }
      }
      if (!hit) outside.get(viewer).push(span);
    });
    for (const row of windows) {
      const inside = spans.get(`${row.viewer}:${row.checkpoint_s}`);
      const far = outside.get(row.viewer);
      row.overlap_requests = inside.length;
      row.overlap_span_p50_ms = percentile(inside, 0.5);
      row.same_viewer_nonoverlap_span_p50_ms = percentile(far, 0.5);
      row.same_viewer_nonoverlap_n = far.length;
    }
    process.stderr.write(`capture ${session.runId}\n`);
  }

  function armStats(arm) {
    const values = captures.filter((row) => row.arm === arm).map((row) => row.capture_ms);
    return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values), mean: Number(mean(values).toFixed(2)) };
  }
  const captureSummary = { A: armStats("A"), B: armStats("B") };

  const provenance = [
    { estimator: "p2_browser_completion_p50", clock: "CDP Network timestamp, seconds since an arbitrary monotonic origin", formula: "loadingFinished.timestamp - requestWillBeSent.timestamp", stored_field: "browser_p50_ms", unit_of_stored_number: "seconds", covers_downstream_delivery: true, cohort: "P2 sealed browser, verified proxy, both arms S3-FIFO", source: "remote_worker_bundle.js Network events; p2_metrics.js lines 140-143 and 197-198" },
    { estimator: "visual_proxy_span_p50", clock: "proxy process Date.now", formula: "proxy.jsonl timestamp - request_start_ms", stored_field: "proxy_span_p50_ms", unit_of_stored_number: "milliseconds", covers_downstream_delivery: false, cohort: "24 visual sessions, N23 proxy", source: "proxy accept Date.now to log after res.end; excludes Vite forward and Playwright body buffering" },
    { estimator: "fixed_replay_service_ms", clock: "replay client done_ms - send_ms", formula: "client jsonl service_ms, ceil percentile", stored_field: "client_service_ms.p50", unit_of_stored_number: "milliseconds", covers_downstream_delivery: false, cohort: "Node agents, no browser", source: "summarize_run.js" },
    { estimator: "origin_ttfb", clock: "proxy Date.now", formula: "origin_first_byte_ms - origin_start_ms", stored_field: "origin_ttfb_p50_ms", unit_of_stored_number: "milliseconds", covers_downstream_delivery: false, cohort: "P2 decision log", source: "p0_existing_cost.js" },
    { estimator: "holder_wait", clock: "proxy Date.now", formula: "peer_wait_ms on peer_verify with DIGEST_MATCH", stored_field: "match_p50_ms", unit_of_stored_number: "milliseconds", covers_downstream_delivery: false, cohort: "P2 B arms", source: "verified_peer peerMs recorded before SHA-256 return" },
    { estimator: "checkpoint_capture_wall", clock: "client Date.now", formula: "captureCheckpoint finish Date.now minus function entry", stored_field: "capture_ms", unit_of_stored_number: "milliseconds", covers_downstream_delivery: false, cohort: "24 visual sessions, 432 canvases", source: "capture_checkpoint.js finish(); includes wait, readPixels, IPC, PNG encode, write; no per-stage pair of timestamps" },
  ];

  const crosswalk = [];
  let matchSum = 0;
  let peerByteSum = 0;
  let deliverySum = 0;
  const sealedRoot = path.join(P2, "sealed_cells");
  for (const name of fs.readdirSync(sealedRoot)) {
    const files = fs.readdirSync(path.join(sealedRoot, name)).filter((file) => file.endsWith(".json"));
    const sealed = JSON.parse(fs.readFileSync(path.join(sealedRoot, name, files[0]), "utf8"));
    const summary = sealed.summary;
    const runDir = path.join(P2, "attempts", summary.attempt_id, "evidence", summary.run_id, "S_runtime");
    const proxyFile = path.join(runDir, "proxy.jsonl");
    const decisionFile = path.join(runDir, "proxy_decisions.jsonl");
    let peerRows = 0;
    let peerBytes = 0;
    let matchN = 0;
    await eachJson(proxyFile, (row) => {
      if (row.decision === "peer_handoff" || row.decision === "peer_handoff_merge") {
        peerRows += 1;
        peerBytes += Number(row.bytes_to_client) || 0;
      }
    });
    await eachJson(decisionFile, (row) => {
      if (row.type === "peer_verify" && Number.isFinite(row.peer_wait_ms) && (row.reason === "DIGEST_MATCH" || row.reason === "DIGEST_MATCH_PEER_ETAG_IGNORED")) matchN += 1;
    });
    if (summary.arm === "B") {
      matchSum += matchN;
      peerByteSum += peerBytes;
      deliverySum += peerRows;
    }
    crosswalk.push({
      corpus: "P2_SEALED_BROWSER",
      cell_id: summary.cell_id,
      arm: summary.arm,
      run_id: summary.run_id,
      attempt_id: summary.attempt_id,
      proxy: "F:/SPADE_WWW_EVIDENCE_V2_20261024/runtime/proxy.js",
      proxy_sha256: hashes.verified_proxy,
      worker: n3Worker,
      worker_has_page_route: n3HasRoute,
      peer_delivery_rows: peerRows,
      peer_bytes: peerBytes,
      digest_match_with_peer_wait_n: matchN,
      log_sha256: await sha256File(proxyFile),
    });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPLAY, "demand", "DEMAND_MANIFEST.json"), "utf8"));
  for (const cell of manifest.cells) {
    let peerRows = 0;
    let peerBytes = 0;
    let matchN = 0;
    const decisionFile = cell.source_log.replace(/proxy\.jsonl$/, "proxy_decisions.jsonl");
    await eachJson(cell.source_log, (row) => {
      if (row.decision === "peer_handoff" || row.decision === "peer_handoff_merge") {
        peerRows += 1;
        peerBytes += Number(row.bytes_to_client) || 0;
      }
    });
    if (fs.existsSync(decisionFile)) {
      await eachJson(decisionFile, (row) => {
        if (row.type === "peer_verify" && Number.isFinite(row.peer_wait_ms) && (row.reason === "DIGEST_MATCH" || row.reason === "DIGEST_MATCH_PEER_ETAG_IGNORED")) matchN += 1;
      });
    }
    crosswalk.push({
      corpus: "N3_S3FIFO_DEMAND_SOURCE",
      cell_id: cell.cell,
      arm: "S3FIFO_DEMAND_SOURCE",
      run_id: path.basename(path.dirname(path.dirname(cell.source_log))),
      attempt_id: "",
      proxy: cell.source_log,
      proxy_sha256: "",
      worker: "not the P2 sealed browser run",
      worker_has_page_route: "",
      peer_delivery_rows: peerRows,
      peer_bytes: peerBytes,
      digest_match_with_peer_wait_n: matchN,
      log_sha256: await sha256File(cell.source_log),
    });
  }

  writeCsv(path.join(OUT, "TIMING_METRIC_PROVENANCE.csv"), provenance);
  writeCsv(path.join(OUT, "CAPTURE_432.csv"), captures.map((row) => ({
    run_id: row.run_id, scene: row.scene, arm: row.arm, viewer: row.viewer, checkpoint_s: row.checkpoint_s,
    capture_ms: row.capture_ms, trace_relative_s: row.trace_relative_s, scheduled_late_ms: row.scheduled_late_ms,
    capture_start_server_ms: row.capture_start_server_ms, capture_end_server_ms: row.capture_end_server_ms,
    clock_offset_ms: row.clock_offset_ms, method: row.method, substages_with_two_timestamps: row.substages_with_two_timestamps,
    overlap_requests: row.overlap_requests, overlap_span_p50_ms: row.overlap_span_p50_ms,
    same_viewer_nonoverlap_span_p50_ms: row.same_viewer_nonoverlap_span_p50_ms, same_viewer_nonoverlap_n: row.same_viewer_nonoverlap_n,
  })));
  writeCsv(path.join(OUT, "CAPTURE_VS_REQUEST_TIMING.csv"), captures.map((row) => ({
    run_id: row.run_id, arm: row.arm, viewer: row.viewer, checkpoint_s: row.checkpoint_s, capture_ms: row.capture_ms,
    overlap_requests: row.overlap_requests, overlap_span_p50_ms: row.overlap_span_p50_ms,
    same_viewer_nonoverlap_n: row.same_viewer_nonoverlap_n, same_viewer_nonoverlap_span_p50_ms: row.same_viewer_nonoverlap_span_p50_ms,
    overlap_minus_nonoverlap_p50_ms: row.overlap_span_p50_ms === null || row.same_viewer_nonoverlap_span_p50_ms === null ? "" : row.overlap_span_p50_ms - row.same_viewer_nonoverlap_span_p50_ms,
    association_only: true,
  })));
  writeCsv(path.join(OUT, "ROUTE_ASYMMETRY_24.csv"), routeRows);
  writeCsv(path.join(OUT, "N3_PROVENANCE_CROSSWALK.csv"), crosswalk);
  fs.writeFileSync(path.join(OUT, "audit", "HASHES.json"), JSON.stringify({ hashes, captureSummary, matchSum, peerByteSum, deliverySum, routeOnlyWhenHandoff, n3HasRoute, n3HasCdp }, null, 2));

  const overlapDeltas = captures.map((row) => row.overlap_span_p50_ms === null ? null : row.overlap_span_p50_ms - row.same_viewer_nonoverlap_span_p50_ms).filter((value) => value !== null);
  const positiveOverlap = overlapDeltas.filter((value) => value > 0).length;
  fs.writeFileSync(path.join(OUT, "ORIGINAL_N3_P50_IMPLEMENTATION.md"), `# 原始 N3 浏览器 p50 的实现

P2 封存的 12 对浏览器完成时间来自 \`remote_worker_bundle.js\` 的 CDP 事件，不是 PerformanceResourceTiming，也不是代理时钟。

\`Network.requestWillBeSent\` 把 \`timestamp\` 记入 \`requestSent\`。\`Network.loadingFinished\` 把同一个 CDP \`timestamp\` 记入 \`finished\`。\`p2_metrics.js\` 计算 \`finished - requestSent\`，再用 ceil 分位写入 \`browser_p50_ms\`。

CDP 的 Network 时间戳单位是秒。字段名写成了毫秒，存储的数字本身是秒。一条原始生命周期记录的差值约为 0.315 秒。12 对的 B−A 是 +0.056 到 +0.183 秒。这里不做跨时钟换算；只说明协议单位和字段名不一致。

这份 worker 用 \`page.route\` 的搜索结果是 ${n3HasRoute ? "有" : "没有"}。P2 的 \`screenshotSampled\` 为 false，6 个检查点仍调用 \`captureCheckpoint\` 的 \`gl.readPixels\`。因此 12/12 的完成时间变慢发生在有画布读回、没有视觉队列这条 \`route.fetch\` 路径的运行上。

代理跨度是另一只时钟：代理进程 \`Date.now\` 从收下请求到 \`res.end\` 之后写日志。它不包含 Vite 转发，也不包含浏览器端把正文读完再 \`route.fulfill\`。固定重放的 \`service_ms\` 是 Node 客户端自己的发送到完成，没有浏览器。
`);
  fs.writeFileSync(path.join(OUT, "CAPTURE_INTERFERENCE_FINDINGS.md"), `# 432 次画布采集

独立重算，不沿用上传 CSV 的汇总数。A 臂 N=${captureSummary.A.n}，p50=${captureSummary.A.p50} ms，p95=${captureSummary.A.p95} ms，最大 ${captureSummary.A.max} ms，均值 ${captureSummary.A.mean} ms。B 臂 N=${captureSummary.B.n}，p50=${captureSummary.B.p50} ms，p95=${captureSummary.B.p95} ms，最大 ${captureSummary.B.max} ms，均值 ${captureSummary.B.mean} ms。

\`capture_ms\` 是 \`captureCheckpoint\` 入口到写完 JSON 的整段墙钟。源码里没有两枚时间戳能分开：等待下一帧、\`gl.readPixels\`、主线程翻转和 base64、Playwright 传回、PNG 编码、写盘。这些阶段都不能单独报成已测时长。\`readPixels\` 发生在渲染钩子里，调用是同步的，但没有单独的开始和结束时刻。

采集窗口用客户端 \`trace_origin + trace_relative_s\` 作为结束，再减去 \`capture_ms\` 得到开始，然后加上该观看者 \`READY.json\` 的 \`clock_offset_ms\` 对齐到代理时钟。与代理请求区间相交的请求记为重叠。这是同一会话里的时间邻近，不是因果证明。有重叠 p50 的检查点里，重叠请求跨度高于同观看者非重叠跨度的有 ${positiveOverlap} / ${overlapDeltas.length}。

两臂采集中位数只差约 ${Number((captureSummary.B.p50 - captureSummary.A.p50).toFixed(1))} ms。这个差值本身远小于 P2 浏览器完成时间 0.056–0.183 秒的臂间差距，而且 P2 两臂都做了同类读回。不能把 12/12 完成时间变慢写成“只有 SPADE 在截图”。
`);
  const bOnly = routeRows.filter((row) => row.arm === "B" && row.matches_only_b_rule).length;
  const aClean = routeRows.filter((row) => row.arm === "A" && row.config_handoff === false && row.log_says_listening_19081 === false).length;
  fs.writeFileSync(path.join(OUT, "ROUTE_MECHANISM_AUDIT.md"), `# 浏览器路由不对称

视觉 worker SHA-256 \`${hashes.visual_worker}\`。\`page.route("**/*")\` 只写在 \`config.handoff === true\` 分支里。72 份已执行配置中，B 臂符合这条规则的有 ${bOnly} / 36，A 臂 handoff 为 false 且日志没有 \`handoff listening 19081\` 的有 ${aClean} / 36。

B 臂对 \`/_p5rad/\` 和 \`.rad\` 的处理是 \`route.fetch({ timeout: 60000 })\`，然后 \`response.body()\` 取完整正文，有 \`x-p5-handoff-key\` 才放进本机缓冲，再 \`route.fulfill({ response, body })\`。失败时 \`route.abort()\`。A 臂没有这段拦截。

启动参数里没有 \`--disable-http-cache\`，代码也没有单独调用缓存开关。Playwright 对 \`page.route\` 的公开说明是：启用路由会关闭 HTTP 缓存。这只作用在注册了路由的 B 臂。与此同时，N23 代理和验证代理的响应都写 \`Cache-Control: no-store\`，Vite 的 \`/_p5rad\` 代理也把 \`cache-control\` 改成 \`no-store\`。因此这些 RAD 响应在到达浏览器之前已经被标成不可缓存。路由关闭缓存，并不等于这些响应本来会进 Chromium 缓存。

仍然存在的测量差异是：B 臂要等完整正文读入 Playwright，再交回页面。代理日志在 \`res.end\` 时已经结束，不包含这段客户端缓冲。所以 B 臂的浏览器完成语义和 A 臂的原生网络请求不是同一个定义。这是源码里确认的混杂，不是已经测得的毫秒数。

P2 的 \`remote_worker_bundle.js\` 没有 \`page.route\`。12/12 的浏览器完成时间变慢不能归因于视觉队列这条拦截路径。
`);
  fs.writeFileSync(path.join(OUT, "UNCONTROLLED_CLIENT_DIFFERENCE.md"), `# 未控制的客户端差异

视觉 24 场的 A 臂是 S3-FIFO 且 handoff 为 false，B 臂是 SPADE-BYTE 且 handoff 为 true。除了代理的 holder 开关和缓存策略，B 臂还多了 Playwright 的 Range 拦截和全文缓冲。

因此这 24 场浏览器结果测量的是代理策略加上客户端交付路径的组合。它不能单独当成 holder 源选择的增量。

P2 的 12 对把方法固定成两边都是 S3-FIFO，只改 holder 开关，而且 worker 没有这条 \`page.route\`。那 12 对的完成时间仍然全部是 B 更高。路由混杂解释不了那一组。那一组也没有做“只开关截图”的对照。

隔离实验要求 holder 全关，同一代理，2×2 为路由开/关乘采集开/关，每格一场，只标成 N=1。这次没有跑。原因是论文分支不能等这场物理标定，而且现有证据还没有证明提交 PDF 已处于可以再开浏览器的安全状态。没有这四格，就不能给出路由或采集各自的毫秒贡献。
`);
  fs.writeFileSync(path.join(OUT, "N3_HOLDER_DISCREPANCY.md"), `# 3488 次匹配和 holder=0 不是同一批日志

两套数字都重算过，来自不同的 run id。

P2 封存浏览器的 B 臂：\`peer_verify\` 且 \`peer_wait_ms\` 为数值且原因为 DIGEST_MATCH 的条数合计 ${matchSum}。这就是 \`P0_EXISTING_BROWSER_COST.csv\` 的 \`match_n\`。同一批 B 臂代理日志里，\`peer_handoff\` 与 \`peer_handoff_merge\` 交付 ${deliverySum} 行、${peerByteSum} 字节。\`match_n\` 计的是带等待时间的摘要匹配，交付行数还包含合并，所以两个计数可以差几条。这些运行的代理是验证运行时 \`${hashes.verified_proxy}\`，run id 带 \`p2t\`。

另一套是固定需求的来源日志，\`DEMAND_MANIFEST.json\` 里的六条 \`nsdi_N3_S3FIFO_*_b30c*\`。它们的 \`peer_handoff\` 行数和 DIGEST_MATCH 等待数都是 0。上一份审计说原始 N3 holder 为 0，指的是这六条来源日志，不是 P2 的 B 臂。

所以 3488 和 0 可以同时成立：一个是验证浏览器 B 臂的摘要匹配次数，一个是更早的 S3-FIFO 需求来源日志里根本没有 holder 交付。不能把 0 写成 P2 没有交接触发，也不能把 3488 写成那六条 b30c 日志的 holder 字节。
`);
  console.log(JSON.stringify({ captureSummary, bOnly, aClean, matchSum, peerByteSum, deliverySum, positiveOverlap, overlapN: overlapDeltas.length, routeOnlyWhenHandoff, n3HasRoute }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
