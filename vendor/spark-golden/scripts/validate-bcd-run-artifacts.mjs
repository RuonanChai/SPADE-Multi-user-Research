/**
 * 校验单次 B/C/D 分布式 run 的 proxy 与用量指标，用于 repeatability 与论文管线闸口。
 * 入口：node scripts/validate-bcd-run-artifacts.mjs --runDir=... --runId=...
 *
 * 当 **SPARK_SHARED_OBJECT_PROXY=1**（或 true）时额外校验 **proxy/shared-proxy.jsonl**，
 * 并写入 **summary/viewport_sharing_validation.json**、**sharing_gain_comparison.md**（闸口结论）；
 * 数值聚合报告见 **scripts/analyze-viewport-sharing-gain.mjs** → `viewport_sharing_gain.json`。
 * **pairwise overlap**：场景 ID/`run_id` 含 `viewport-lockstep`，或设置 **SPARK_VIEWPORT_LOCKSTEP_VALIDATE_OVERLAP=1**，则要求日志中含较高的 **viewport_lockstep_overlap.pairwise_overlap_avg**。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  NON_VIEWPORT_GAIN_EXT,
  extFromPathname,
  rawUrlHasEphemeralQuery,
  isTraceJsonPath,
} from "./lib/shared-proxy-log-schema.mjs";

function parseArgs(argv) {
  const o = { runDir: "", runId: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runDir") o.runDir = v;
    else if (k === "runId") o.runId = v;
  }
  return o;
}

function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function envTruthy(name) {
  const v = process.env[name];
  return v === "1" || v === "true";
}

function isShareableRequestEvent(e) {
  const ev = String(e?.event || "");
  return ev === "shareable_client_request" || ev === "downstream_shareable_received";
}

function isUpstreamShareComplete(e) {
  const ev = String(e?.event || "");
  return (
    ev === "upstream_share_fetch_complete" ||
    ev === "upstream_fetch_complete" ||
    ev === "upstream_share_fetch_done"
  );
}

function isGainEstimateEvent(e) {
  return String(e?.event || "") === "sharing_gain_estimate";
}

function isOverlapEvent(e) {
  return String(e?.event || "") === "viewport_lockstep_overlap";
}

function pathnameFromRawUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || ""), "http://placeholder.local").pathname;
  } catch {
    return "";
  }
}

async function validateSharedObjectProxy(runRoot, runId, metadata, out) {
  const sharedPath = path.join(runRoot, "proxy", "shared-proxy.jsonl");
  const warnings = [];
  const errors = [];

  if (!existsSync(sharedPath)) {
    errors.push(`规则1 失败: SPARK_SHARED_OBJECT_PROXY=1 但缺少 ${path.relative(process.cwd(), sharedPath) || sharedPath}`);
    out.shared_proxy_log_path = sharedPath;
    out.validation_ok = false;
    out.errors = errors;
    out.warnings = warnings;
    return out;
  }

  const raw = await fs.readFile(sharedPath, "utf8").catch(() => "");
  const lines = parseJsonl(raw);
  if (!lines.length) {
    errors.push("shared-proxy.jsonl 为空");
    out.validation_ok = false;
    out.errors = errors;
    out.warnings = warnings;
    return out;
  }

  const shareReqs = lines.filter(isShareableRequestEvent);
  const shareable_client_requests = shareReqs.length;
  const shareKeys = shareReqs.map((e) => String(e.share_key || "")).filter(Boolean);
  const unique_share_keys = new Set(shareKeys).size;

  const clientIds = shareReqs.map((e) => String(e.client_id || e.user_id || "").trim()).filter(Boolean);
  const active_users = [...new Set(clientIds)].sort();
  const active_user_count = active_users.length;

  if (active_user_count < 4) {
    errors.push(`规则2 失败: active users < 4（当前 ${active_user_count}: ${active_users.join(", ") || "—"}）`);
  }

  if (shareable_client_requests <= 0) {
    errors.push("规则3 失败: shareable_client_requests 必须 > 0");
  }

  if (unique_share_keys <= 0) {
    errors.push("规则4 失败: unique_share_keys 必须 > 0");
  }

  /** 规则7：排除 HTML/JS/CSS/JSON trace 等计入 gain */
  let excluded_gain_hits = 0;
  for (const e of shareReqs) {
    const ext = String(e.asset_ext || "").toLowerCase().replace(/^\./, "") || extFromPathname(pathnameFromRawUrl(e.raw_url || e.url || ""));
    const pn = pathnameFromRawUrl(e.raw_url || e.url || "");
    if (NON_VIEWPORT_GAIN_EXT.has(ext) || isTraceJsonPath(pn)) {
      excluded_gain_hits += 1;
    }
  }
  if (excluded_gain_hits > 0) {
    errors.push(
      `规则7 失败: ${excluded_gain_hits} 条 shareable 事件命中 HTML/JS/CSS/JSON/trace 等，不应算作 viewport 静态 3D 增益`,
    );
  }

  /** 规则8：仍有用户相关 / cachebuster 查询串 */
  const withRaw = shareReqs.filter((e) => e.raw_url || e.url);
  let ephemeralRaw = 0;
  for (const e of withRaw) {
    if (rawUrlHasEphemeralQuery(e.raw_url || e.url)) ephemeralRaw += 1;
  }
  if (withRaw.length > 0 && ephemeralRaw / withRaw.length >= 0.5) {
    warnings.push(
      `规则8: 多数 (${ephemeralRaw}/${withRaw.length}) shareable 请求的 raw URL 仍含 user_id/trace_id/run_id/ts/cachebuster 等查询键；规范化可能不足，sharing gain 可信度下降`,
    );
  } else if (ephemeralRaw > 0) {
    warnings.push(`规则8: ${ephemeralRaw} 条 shareable 请求 raw URL 仍含疑似用户隔离 / cachebuster 查询参数`);
  }

  /** 规则9：同一 logical 对象、不同 Range */
  const logicalToRanges = new Map();
  for (const e of shareReqs) {
    const rk = String(e.logical_object_key || e.resource_key_no_range || "").trim();
    const rangeH = String(e.raw_range ?? e.range_header ?? e.range ?? "").trim() || "(none)";
    if (!rk) continue;
    if (!logicalToRanges.has(rk)) logicalToRanges.set(rk, new Set());
    logicalToRanges.get(rk).add(rangeH);
  }
  let range_mismatch_count = 0;
  for (const [_lk, set] of logicalToRanges) {
    if (set.size > 1) range_mismatch_count += 1;
  }
  if (logicalToRanges.size === 0) {
    warnings.push(
      "规则9: 无法统计 range_mismatch_count（缺少 logical_object_key / resource_key_no_range）；代理应为每条 shareable 请求标注 logical key 与 Range",
    );
    out.range_mismatch_count = null;
  } else {
    out.range_mismatch_count = range_mismatch_count;
    if (range_mismatch_count > 0) {
      warnings.push(`规则9: ${range_mismatch_count} 个 logical object 在不同用户间存在多种 Range（已按不同 share_key 合并请求除外），属预期拆分`);
    }
  }

  const upstreamCompletes = lines.filter(isUpstreamShareComplete);
  const upstream_fetch_events_visible = upstreamCompletes.length;
  const upstream_bytes_sum = upstreamCompletes.reduce((s, e) => s + (Number(e.upstream_bytes) || 0), 0);

  if (shareable_client_requests > 0 && upstream_fetch_events_visible === 0 && upstream_bytes_sum === 0) {
    warnings.push(
      "规则10: shareable 客户端请求存在，但未观察到上游完成事件/字节；可能 CDN 或浏览器缓存吃掉请求，本 run 不适合度量 proxy 级 sharing gain",
    );
  }

  /** 规则6 / gain estimate */
  const gainEv = [...lines].reverse().find(isGainEstimateEvent);
  let no_sharing_estimated_upstream_bytes =
    gainEv != null && Number.isFinite(Number(gainEv.no_sharing_estimated_upstream_bytes))
      ? Number(gainEv.no_sharing_estimated_upstream_bytes)
      : null;
  let sharing_gain_ratio =
    gainEv != null && gainEv.sharing_gain_ratio != null && Number.isFinite(Number(gainEv.sharing_gain_ratio))
      ? Number(gainEv.sharing_gain_ratio)
      : null;

  if (!gainEv && shareable_client_requests > 0) {
    warnings.push("规则6: 缺少 sharing_gain_estimate 事件；无法审计 sharing_gain_ratio 与 no_sharing_estimated_upstream_bytes");
  }

  if (no_sharing_estimated_upstream_bytes === 0) {
    sharing_gain_ratio = null;
    warnings.push("规则6: no_sharing_estimated_upstream_bytes = 0，不得解读 sharing_gain_ratio（已置 null）");
  } else if (
    gainEv &&
    (no_sharing_estimated_upstream_bytes == null || !Number.isFinite(no_sharing_estimated_upstream_bytes)) &&
    sharing_gain_ratio != null
  ) {
    sharing_gain_ratio = null;
    warnings.push("规则6: no_sharing_estimated_upstream_bytes 缺失或非有限值，已忽略 sharing_gain_ratio（置 null）");
  }

  /** 规则5：B-viewport-lockstep */
  const scenario = String(metadata?.scenario || "");
  const rid = String(runId || "");
  const isViewportLockstep =
    scenario.includes("viewport-lockstep") ||
    scenario.includes("B-viewport-lockstep") ||
    rid.includes("viewport-lockstep") ||
    rid.includes("B-viewport-lockstep");
  const forceOverlapCheck = isViewportLockstep || envTruthy("SPARK_VIEWPORT_LOCKSTEP_VALIDATE_OVERLAP");

  const overlapEv = [...lines].reverse().find(isOverlapEvent);
  let pairwise_overlap_avg =
    overlapEv != null && Number.isFinite(Number(overlapEv.pairwise_overlap_avg))
      ? Number(overlapEv.pairwise_overlap_avg)
      : null;

  if (forceOverlapCheck) {
    if (pairwise_overlap_avg == null) {
      warnings.push(
        "规则5: viewport-lockstep（或 SPARK_VIEWPORT_LOCKSTEP_VALIDATE_OVERLAP）缺少 viewport_lockstep_overlap.pairwise_overlap_avg；无法确认视口对齐度高",
      );
    } else if (pairwise_overlap_avg < 0.6) {
      warnings.push(
        `规则5: pairwise_overlap_avg=${pairwise_overlap_avg.toFixed(3)} 偏低（期望较高）；viewport 重叠不足会低估共享收益或产生虚假对比`,
      );
    }
  }

  out.shared_proxy_log_path = sharedPath;
  out.shareable_client_requests = shareable_client_requests;
  out.unique_share_keys = unique_share_keys;
  out.active_users = active_users;
  out.active_user_count = active_user_count;
  out.pairwise_overlap_avg = pairwise_overlap_avg;
  out.no_sharing_estimated_upstream_bytes = no_sharing_estimated_upstream_bytes;
  out.sharing_gain_ratio = sharing_gain_ratio;
  out.upstream_fetch_events_visible = upstream_fetch_events_visible;
  out.upstream_bytes_summed = upstream_bytes_sum;
  out.warnings = [...warnings, ...out.warnings];
  out.errors = [...errors, ...out.errors];
  out.validation_ok = errors.length === 0;

  return out;
}

async function writeSharingMarkdown(runRoot, payload) {
  const mdPath = path.join(runRoot, "sharing_gain_comparison.md");
  const lines = [
    `# Sharing gain 校验（viewport shared proxy）`,
    ``,
    `- run_id: ${payload.run_id}`,
    `- shared_proxy_enabled: ${payload.shared_proxy_enabled}`,
    `- validation_ok: ${payload.validation_ok}`,
    ...(payload.note ? [`- note: ${payload.note}`, ``] : []),
    ``,
    `## 指标`,
    ``,
    `- active_user_count: ${payload.active_user_count ?? "—"}`,
    `- shareable_client_requests: ${payload.shareable_client_requests ?? "—"}`,
    `- unique_share_keys: ${payload.unique_share_keys ?? "—"}`,
    `- pairwise_overlap_avg: ${payload.pairwise_overlap_avg ?? "—"}`,
    `- range_mismatch_count: ${payload.range_mismatch_count ?? "—"}`,
    `- no_sharing_estimated_upstream_bytes: ${payload.no_sharing_estimated_upstream_bytes ?? "—"}`,
    `- sharing_gain_ratio: ${payload.sharing_gain_ratio ?? "—"}`,
    `- upstream_fetch_events_visible: ${payload.upstream_fetch_events_visible ?? "—"}`,
    ``,
    `## 错误`,
    ...(payload.errors?.length ? payload.errors.map((x) => `- ${x}`) : ["- （无）"]),
    ``,
    `## 警告`,
    ...(payload.warnings?.length ? payload.warnings.map((x) => `- ${x}`) : ["- （无）"]),
    ``,
  ];
  await fs.writeFile(mdPath, lines.join("\n") + "\n", "utf8");
}

async function main() {
  const { runDir, runId } = parseArgs(process.argv.slice(2));
  if (!runDir || !runId) {
    console.error("need --runDir= --runId=");
    process.exitCode = 1;
    return;
  }
  const runRoot = path.resolve(runDir);
  const proxyPath = path.join(runRoot, "proxy", "proxy.jsonl");
  const raw = await fs.readFile(proxyPath, "utf8").catch(() => "");
  const lines = parseJsonl(raw);
  if (lines.length <= 1) {
    console.error(`[validate-artifacts] proxy.jsonl 仅含 init 或空: ${proxyPath} (lines=${lines.length})`);
    process.exitCode = 1;
    return;
  }
  const hasRequest = lines.some(
    (p) => p.event === "request_complete" || p.event === "downstream_request_received",
  );
  if (!hasRequest) {
    console.error(`[validate-artifacts] proxy.jsonl 中无 request_complete / downstream 记录: ${proxyPath}`);
    process.exitCode = 1;
    return;
  }

  const valPath = path.join(runRoot, "validate-run-coverage.json");
  const val = JSON.parse(await fs.readFile(valPath, "utf8").catch(() => "{}"));
  const up = val.upstream_bytes_total;
  if (!Number.isFinite(up) || up <= 0) {
    const sumPath = path.join(runRoot, "summary", "distributed-summary.json");
    const sum = JSON.parse(await fs.readFile(sumPath, "utf8").catch(() => "{}"));
    const r0 = (sum.runs || [])[0];
    const t2 = r0?.totals?.total_B_upstream;
    if (!Number.isFinite(t2) || t2 <= 0) {
      console.error(
        "[validate-artifacts] upstream_bytes_total 与 total_B_upstream 均无法确认 >0",
      );
      process.exitCode = 1;
      return;
    }
  }

  const metaPath = path.join(runRoot, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}"));

  const sharedProxyEnabled = envTruthy("SPARK_SHARED_OBJECT_PROXY");
  const summaryDir = path.join(runRoot, "summary");
  await fs.mkdir(summaryDir, { recursive: true });

  const payload = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    shared_proxy_enabled: sharedProxyEnabled,
    validation_ok: true,
    errors: [],
    warnings: [],
  };

  if (sharedProxyEnabled) {
    payload.shared_validation_skipped = false;
    await validateSharedObjectProxy(runRoot, runId, metadata, payload);
    if (!payload.validation_ok) {
      for (const e of payload.errors || []) console.error(`[validate-artifacts] ${e}`);
      for (const w of payload.warnings || []) console.warn(`[validate-artifacts] WARN ${w}`);
      await fs.writeFile(
        path.join(summaryDir, "viewport_sharing_validation.json"),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
      await writeSharingMarkdown(runRoot, payload);
      process.exitCode = 1;
      return;
    }
    for (const w of payload.warnings || []) console.warn(`[validate-artifacts] WARN ${w}`);
    await fs.writeFile(path.join(summaryDir, "viewport_sharing_validation.json"), JSON.stringify(payload, null, 2), "utf8");
    await writeSharingMarkdown(runRoot, payload);
  } else {
    payload.note = "SPARK_SHARED_OBJECT_PROXY 未开启，跳过 shared-proxy.jsonl 校验（未写入强制 sharing 指标）";
    payload.shared_validation_skipped = true;
    await fs.writeFile(path.join(summaryDir, "viewport_sharing_validation.json"), JSON.stringify(payload, null, 2), "utf8");
    await writeSharingMarkdown(runRoot, payload);
  }

  console.log(`[validate-artifacts] ok runId=${runId} proxyLines=${lines.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
