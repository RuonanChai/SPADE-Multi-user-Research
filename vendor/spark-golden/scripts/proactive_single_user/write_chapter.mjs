/**
 * Generate chapter3 LaTeX + zh markdown from batch results.
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
    fvis: mean(sub.map((t) => t.first_visible_splat_ms)),
    qoe: mean(sub.map((t) => t.normalized_useful_content_score)),
  };
}

function pct(x) {
  return x == null ? "---" : `${(x * 100).toFixed(1)}`;
}

export async function writeChapter3({ root, batchDir, trials }) {
  const sectionsDir = path.join(root, "vrc-paper", "paper", "sections");
  await fs.mkdir(sectionsDir, { recursive: true });

  const origin = {};
  const remote = {};
  for (const bid of [
    "B0_on_demand",
    "B1_naive_prefetch",
    "B2_priority_prefetch",
    "B3_vrc_single",
    "B4_oracle_prefetch",
  ]) {
    origin[bid] = aggRows(trials, "origin_server", bid);
    remote[bid] = aggRows(trials, "remote_server", bid);
  }

  const b0o = origin.B0_on_demand;
  const b3o = origin.B3_vrc_single;
  const b4o = origin.B4_oracle_prefetch;
  const b0r = remote.B0_on_demand;
  const b3r = remote.B3_vrc_single;

  const improves =
    b3o.n > 0 && b0o.n > 0 && (b3o.miss50 ?? 1) < (b0o.miss50 ?? 1) - 0.05;
  const multiUserOk = improves && (b3o.wasted ?? 1e12) < (b0o.wasted ?? 0) * 2;

  const tex = `% Auto-generated from proactive_single_user batch
% ${batchDir}
\\section{Single-User Proactive Delivery}
\\label{sec:single-proactive}

\\subsection{Problem Recap}
Prior measurements show on-demand HTTP Range fetching for large \\texttt{.rad} tiles yields chunk completion latencies far above interactive deadlines ($\\gg$50\\,ms), while render FPS can remain high---a \\emph{timing} failure, not a pure GPU cap.

\\subsection{Design Goal}
Place \\emph{useful} chunks in a near-client cache before \\texttt{chunk\\_needed\\_time}, using prediction, prefetch, and priority scheduling, without claiming multi-user overlap/dedup benefits.

\\subsection{Demand Trace Construction}
For each trial we record the first on-demand Range request per chunk (\\texttt{chunk\\_id = URL::bytes=start-end}). For baselines B1--B4, \\texttt{chunk\\_needed\\_time} is taken from the B0 reference demand trace on the same delivery path.

\\subsection{Baselines}
\\begin{itemize}
  \\item \\textbf{B0} On-demand (Spark default)
  \\item \\textbf{B1} Naive prefetch (byte budget, no priority)
  \\item \\textbf{B2} Priority prefetch (viewport + urgency + LOD score)
  \\item \\textbf{B3} VRC-Single (0.5/1/2\\,s pose prediction + priority)
  \\item \\textbf{B4*} Oracle prefetch (full future demand; \\emph{upper bound only})
\\end{itemize}

\\subsection{Metrics}
\\texttt{chunk\\_ready\\_time} is parse/upload complete when available, else parse complete.
\\texttt{miss\\_50} if ready $>$ needed + 50\\,ms; \\texttt{miss\\_100} if +100\\,ms.
Useful chunk: appears in demand trace and ready on time. Wasted prefetch: prefetched bytes never demanded.

\\subsection{Implementation}
Browser-injected probes (\\texttt{proactive\\_chunk\\_probe.js}, \\texttt{proactive\\_prefetch\\_controller.js}) wrap fetch without Spark core edits. CDP audit enriches Range timelines.

\\subsection{Results: Origin Server}
\\begin{tabular}{lrrrrr}
\\hline
Baseline & $n$ & miss50\\% & miss100\\% & useful-before & FPS \\\\
\\hline
B0 & ${b0o.n} & ${pct(b0o.miss50)} & ${pct(b0o.miss100)} & ${b0o.useful?.toFixed(0) ?? "---"} & ${b0o.fps?.toFixed(1) ?? "---"} \\\\
B1 & ${origin.B1_naive_prefetch.n} & ${pct(origin.B1_naive_prefetch.miss50)} & ${pct(origin.B1_naive_prefetch.miss100)} & ${origin.B1_naive_prefetch.useful?.toFixed(0) ?? "---"} & ${origin.B1_naive_prefetch.fps?.toFixed(1) ?? "---"} \\\\
B2 & ${origin.B2_priority_prefetch.n} & ${pct(origin.B2_priority_prefetch.miss50)} & ${pct(origin.B2_priority_prefetch.miss100)} & ${origin.B2_priority_prefetch.useful?.toFixed(0) ?? "---"} & ${origin.B2_priority_prefetch.fps?.toFixed(1) ?? "---"} \\\\
B3 & ${b3o.n} & ${pct(b3o.miss50)} & ${pct(b3o.miss100)} & ${b3o.useful?.toFixed(0) ?? "---"} & ${b3o.fps?.toFixed(1) ?? "---"} \\\\
B4* & ${b4o.n} & ${pct(b4o.miss50)} & ${pct(b4o.miss100)} & ${b4o.useful?.toFixed(0) ?? "---"} & ${b4o.fps?.toFixed(1) ?? "---"} \\\\
\\hline
\\end{tabular}

\\subsection{Results: Remote Server}
B0: miss50=${pct(b0r.miss50)}\\% ($n=${b0r.n}$); B3: miss50=${pct(b3r.miss50)}\\% ($n=${b3r.n}$).

\\subsection{Oracle Gap}
On origin, B3 miss50=${pct(b3o.miss50)}\\% vs B4*=${pct(b4o.miss50)}\\% (gap ${((b4o.miss50 ?? 0) - (b3o.miss50 ?? 0)) * 100 > 0 ? "+" : ""}${(((b4o.miss50 ?? 0) - (b3o.miss50 ?? 0)) * 100).toFixed(1)}\\,pp).

\\subsection{Failure Cases}
${improves ? "B3 improves miss50 vs B0 on origin." : "B3 does \\emph{not} significantly beat B0 on deadline miss; high FPS with low useful chunks (fast-but-empty) was flagged in several trials."}
Non-blocking prefetch is required; synchronous prefetch collapsed FPS to $\\approx$1 in early canaries.

\\subsection{Decision}
${multiUserOk ? "Single-user proactive delivery shows sufficient timing gains to justify studying multi-user overlap/dedup next." : "\\textbf{Do not} proceed to multi-user overlap/dedup until B3 reliably beats B0 on deadline miss without pathological wasted bytes or main-thread starvation."}

\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{figures/proactive_single_user/fig_3_1_deadline_miss.pdf}
  \\caption{Deadline miss ratios (origin).}
\\end{figure}
`;

  const zh = `# 第三章 单用户主动交付（自动生成）

## 问题回顾
按需远程 Range 拉取导致 chunk 完成时间远超 50ms 交互截止，而 FPS 仍可能很高。

## 结果摘要（origin）
| 基线 | n | miss50% | useful_before | FPS |
|------|---|---------|---------------|-----|
| B0 | ${b0o.n} | ${pct(b0o.miss50)} | ${b0o.useful?.toFixed(0) ?? "—"} | ${b0o.fps?.toFixed(1) ?? "—"} |
| B3 | ${b3o.n} | ${pct(b3o.miss50)} | ${b3o.useful?.toFixed(0) ?? "—"} | ${b3o.fps?.toFixed(1) ?? "—"} |
| B4* | ${b4o.n} | ${pct(b4o.miss50)} | ${b4o.useful?.toFixed(0) ?? "—"} | ${b4o.fps?.toFixed(1) ?? "—"} |

## 决策
${multiUserOk ? "建议进入多用户 overlap/dedup 实验。" : "暂不建议进入多用户实验；需先让 B3 在 miss50 上稳定优于 B0。"}

批次：\`${batchDir}\`
`;

  await fs.writeFile(path.join(sectionsDir, "chapter3_single_proactive_delivery.tex"), tex, "utf8");
  await fs.writeFile(path.join(sectionsDir, "chapter3_single_proactive_delivery_zh.md"), zh, "utf8");

  return { improves, multiUserOk, origin, remote };
}
