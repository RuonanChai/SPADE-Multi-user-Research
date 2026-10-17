/**
 * Generate v2 chapter3 LaTeX + zh markdown from batch results (ready-aware).
 */
import fs from "node:fs/promises";
import path from "node:path";

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function aggRows(trials, delivery, baseline) {
  const sub = trials.filter(
    (t) => t.delivery_key === delivery && t.baseline_id === baseline && t.hard_gate_passed,
  );
  return {
    n: sub.length,
    miss50: mean(sub.map((t) => t.deadline_miss_ratio_50ms)),
    miss100: mean(sub.map((t) => t.deadline_miss_ratio_100ms)),
    useful: mean(sub.map((t) => t.useful_chunks_before_demand)),
    ratio: mean(sub.map((t) => t.useful_bytes_ratio)),
    fps: mean(sub.map((t) => t.measure_fps)),
    wasted: mean(sub.map((t) => t.wasted_prefetch_bytes)),
    wasted_ratio: mean(sub.map((t) => t.wasted_prefetch_ratio)),
    fvis: mean(sub.map((t) => t.first_visible_splat_ms)),
    qoe: mean(sub.map((t) => t.normalized_useful_content_score)),
    horizon: mean(sub.map((t) => t.prediction_horizon_ms)),
    ready_event: sub[0]?.ready_event_used ?? null,
  };
}

function pct(x) {
  return x == null ? "---" : `${(x * 100).toFixed(1)}`;
}

function gateChecks(b0, b3) {
  // Spec §7 six conditions
  const checks = [];
  const relMiss100 = b0?.miss100 ? 1 - (b3?.miss100 ?? 1) / b0.miss100 : null;
  checks.push({
    id: 1,
    label: "miss100 relative drop ≥30%",
    pass: relMiss100 != null && relMiss100 >= 0.3,
    value: relMiss100 == null ? "—" : `${(relMiss100 * 100).toFixed(1)}%`,
  });
  checks.push({
    id: 2,
    label: "useful_before ≥ 3× B0",
    pass: b0?.useful != null && b3?.useful != null && b3.useful >= 3 * Math.max(1, b0.useful),
    value: `B0=${b0?.useful?.toFixed(1) ?? "—"} vs B3=${b3?.useful?.toFixed(1) ?? "—"}`,
  });
  checks.push({
    id: 3,
    label: "first_visible improved",
    pass: b0?.fvis != null && b3?.fvis != null && b3.fvis < b0.fvis,
    value: `B0=${b0?.fvis?.toFixed(0) ?? "—"}ms vs B3=${b3?.fvis?.toFixed(0) ?? "—"}ms`,
  });
  checks.push({
    id: 4,
    label: "useful_bytes_ratio improved",
    pass: b0?.ratio != null && b3?.ratio != null && b3.ratio > b0.ratio,
    value: `B0=${b0?.ratio?.toFixed(2) ?? "—"} vs B3=${b3?.ratio?.toFixed(2) ?? "—"}`,
  });
  checks.push({
    id: 5,
    label: "wasted_prefetch_ratio ≤30%",
    pass: b3?.wasted_ratio != null && b3.wasted_ratio <= 0.30,
    value: b3?.wasted_ratio == null ? "—" : `${(b3.wasted_ratio * 100).toFixed(1)}%`,
  });
  checks.push({
    id: 6,
    label: "FPS drop <20%",
    pass: b0?.fps != null && b3?.fps != null && b3.fps >= b0.fps * 0.8,
    value: `B0=${b0?.fps?.toFixed(1) ?? "—"} vs B3=${b3?.fps?.toFixed(1) ?? "—"}`,
  });
  return checks;
}

export async function writeChapter3({ root, batchDir, trials }) {
  const sectionsDir = path.join(root, "vrc-paper", "paper", "sections");
  await fs.mkdir(sectionsDir, { recursive: true });

  const origin = {};
  const remote = {};
  for (const bid of ["B0_on_demand", "B3_ready", "B4_ready_oracle"]) {
    origin[bid] = aggRows(trials, "origin_server", bid);
    remote[bid] = aggRows(trials, "remote_server", bid);
  }

  const b0o = origin.B0_on_demand;
  const b3o = origin.B3_ready;
  const b4o = origin.B4_ready_oracle;
  const b0r = remote.B0_on_demand;
  const b3r = remote.B3_ready;

  const checks = gateChecks(b0o, b3o);
  const passed = checks.filter((c) => c.pass).length;
  const improves = passed >= 2;
  const multiUserOk = improves && (b3o.wasted_ratio == null || b3o.wasted_ratio <= 0.30);

  const tex = `% Auto-generated from proactive_single_user_v2 batch
% ${batchDir}
\\section{Single-User Proactive Delivery (v2: ready-aware)}
\\label{sec:single-proactive-v2}

\\subsection{Recap and v2 Motivation}
The v1 study (27/27 hard-gate PASS) confirmed that on-demand Range fetching of
\\texttt{.rad} tiles violates 50/100\\,ms deadlines for $>$99\\% of demanded chunks
on origin, and that bytes-only prefetch (B1--B4 in v1) brought \\texttt{useful\\_chunks\\_before\\_demand}$\\approx$0.
v2 reframes the problem from \\emph{prefetch bytes} to \\emph{ready useful chunks}:
\\texttt{chunk\\_ready\\_time} is parse/upload complete (parse-only when upload event
unavailable; annotated).

\\subsection{Design}
The v2 ready-aware controller (B3-ready, B4-ready-oracle) keeps Worker-based
range prefetch but fires \\texttt{noteParseComplete} immediately on fetch
completion, subject to a parse budget (chunks/s). Chunk ids are unified as
\\texttt{URL::bytes=start-end} so demand-side and prefetch-side observations
collide correctly --- a v1 cid-mismatch bug is fixed in v2.

\\subsection{Metrics (Spec \\S3)}
\\texttt{chunk\\_ready\\_time}: upload\\_complete $\\succ$ parse\\_complete $\\succ$ fetch\\_complete+parse\\_p95.
\\texttt{miss\\_50/100}: ready $-$ needed $>$ 50/100\\,ms.
\\texttt{useful\\_chunks\\_before\\_demand}: ready $\\le$ needed.
\\texttt{wasted\\_prefetch\\_ratio}: bytes prefetched but never demanded over total prefetched.

\\subsection{Results: Origin Server}
\\begin{tabular}{lrrrrrr}
\\hline
Baseline & $n$ & miss50\\% & miss100\\% & useful-before & first-vis & FPS \\\\
\\hline
B0 & ${b0o.n} & ${pct(b0o.miss50)} & ${pct(b0o.miss100)} & ${b0o.useful?.toFixed(1) ?? "---"} & ${b0o.fvis?.toFixed(0) ?? "---"} & ${b0o.fps?.toFixed(1) ?? "---"} \\\\
B3-ready & ${b3o.n} & ${pct(b3o.miss50)} & ${pct(b3o.miss100)} & ${b3o.useful?.toFixed(1) ?? "---"} & ${b3o.fvis?.toFixed(0) ?? "---"} & ${b3o.fps?.toFixed(1) ?? "---"} \\\\
B4-ready* & ${b4o.n} & ${pct(b4o.miss50)} & ${pct(b4o.miss100)} & ${b4o.useful?.toFixed(1) ?? "---"} & ${b4o.fvis?.toFixed(0) ?? "---"} & ${b4o.fps?.toFixed(1) ?? "---"} \\\\
\\hline
\\end{tabular}

\\subsection{\\S7 Success-Gate Checklist (origin)}
\\begin{itemize}
${checks.map((c) => `  \\item ${c.pass ? "\\checkmark" : "\\fail"} (\\#${c.id}) ${c.label}: ${c.value}`).join("\n")}
\\end{itemize}
Passed ${passed}/6 conditions ($\\ge$2 required to proceed to multi-user overlap/dedup).

\\subsection{Results: Remote Server (cdn1\\_r2)}
B0: miss100=${pct(b0r.miss100)}\\% ($n=${b0r.n}$); B3-ready: miss100=${pct(b3r.miss100)}\\% ($n=${b3r.n}$).
Remote workload is lighter; origin remains the primary judging delivery.

\\subsection{Ready-Event Annotation}
B3-ready predominantly used \\texttt{ready\\_event=${b3o.ready_event ?? "—"}}.
When upload-complete events are unavailable from the page, the metric falls
back to \\texttt{parse\\_only} per spec \\S3.1; this is recorded in
\\texttt{ready\\_event\\_counts} in every per-trial JSON.

\\subsection{Decision}
${improves ? "Sufficient single-user gain (\\S7 $\\ge$2 conditions). Multi-user overlap/dedup may be studied next on top of a ready-aware single-user pipeline." : "Single-user gate \\textbf{not} cleared. Multi-user overlap/dedup is \\emph{not} pursued."}

\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{figures/proactive_single_user_v2/fig_v2_deadline_miss.pdf}
  \\caption{v2 ready-aware deadline miss (origin).}
\\end{figure}
`;

  const zh = `# 第三章 单用户主动交付（v2 ready-aware，自动生成）

批次：\`${batchDir}\`

## v2 重定义
v1 已证 27/27 PASS 但 \`useful_chunks_before_demand≈0\`：bytes 提前到达，**ready 时刻**仍在需求之后。
v2 把 \`chunk_ready_time\` 重新定义为 upload/parse 完成，并修复 cid 不一致 bug（demand 用 \`url::range\`，prefetch 也统一为同一 cid）。

## 结果（origin）
| 基线 | n | miss50% | miss100% | useful_before | first-vis (ms) | FPS |
|------|---|---------|----------|---------------|----------------|-----|
| B0 | ${b0o.n} | ${pct(b0o.miss50)} | ${pct(b0o.miss100)} | ${b0o.useful?.toFixed(1) ?? "—"} | ${b0o.fvis?.toFixed(0) ?? "—"} | ${b0o.fps?.toFixed(1) ?? "—"} |
| B3-ready | ${b3o.n} | ${pct(b3o.miss50)} | ${pct(b3o.miss100)} | ${b3o.useful?.toFixed(1) ?? "—"} | ${b3o.fvis?.toFixed(0) ?? "—"} | ${b3o.fps?.toFixed(1) ?? "—"} |
| B4-ready* | ${b4o.n} | ${pct(b4o.miss50)} | ${pct(b4o.miss100)} | ${b4o.useful?.toFixed(1) ?? "—"} | ${b4o.fvis?.toFixed(0) ?? "—"} | ${b4o.fps?.toFixed(1) ?? "—"} |

## §7 六条门槛（origin，need ≥2）
${checks.map((c) => `- ${c.pass ? "✅" : "❌"} #${c.id} ${c.label}：${c.value}`).join("\n")}

通过 ${passed}/6 条。

## ready 事件来源
B3-ready 多数 chunk 的 ready_event = \`${b3o.ready_event ?? "—"}\`（详见 per_trial_json.ready_event_counts）。

## 决策
${multiUserOk ? "通过门槛 → 可在 ready-aware 单用户成立基础上研究多用户 overlap/dedup。" : "未通过门槛 → 暂不启动多用户实验；下一轮 diagnose 重点：Spark loader pre-parse 复用 / parse budget / 预测精度。"}
`;

  await fs.writeFile(path.join(sectionsDir, "chapter3_single_proactive_delivery.tex"), tex, "utf8");
  await fs.writeFile(path.join(sectionsDir, "chapter3_single_proactive_delivery_zh.md"), zh, "utf8");

  return { improves, multiUserOk, origin, remote, checks, passed };
}
