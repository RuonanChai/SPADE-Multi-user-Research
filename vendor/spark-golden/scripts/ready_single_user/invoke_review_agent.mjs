/**
 * Sub-agent review invoker.
 *
 * Two modes:
 *   - deterministic: only run pass_criteria_loader checks (fast, no LLM)
 *   - llm_review: spawn ready_remote_gate_review_agent via stdout marker for
 *                 the parent Claude session to pick up
 *
 * The supervisor invokes deterministic mode after every batch.
 * LLM review mode is invoked only at P1 claim-gate phases (P1-1, P1-2, etc).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { evaluatePhase, aggregateBaselines } from "./pass_criteria_loader.mjs";

/**
 * Load all per_trial_json files from a batchDir.
 */
async function loadBatchTrials(batchDir) {
  const trialDir = path.join(batchDir, "per_trial_json");
  const files = await fs.readdir(trialDir);
  const trials = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(trialDir, f), "utf8");
      trials.push(JSON.parse(raw));
    } catch (e) {
      console.warn(`[review] skipping ${f}: ${e.message}`);
    }
  }
  return trials;
}

/**
 * Try to load baseline_config_audit.csv if it exists.
 */
async function loadConfigAudit(batchDir) {
  const auditPath = path.join(batchDir, "baseline_config_audit.csv");
  try {
    const raw = await fs.readFile(auditPath, "utf8");
    const lines = raw.trim().split(/\r?\n/);
    const header = lines[0].split(",");
    const rows = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const obj = {};
      for (let j = 0; j < header.length; j++) {
        const v = cols[j];
        // try parse bool/number
        if (v === "true") obj[header[j]] = true;
        else if (v === "false") obj[header[j]] = false;
        else if (v === "" || v == null) obj[header[j]] = null;
        else if (!isNaN(Number(v))) obj[header[j]] = Number(v);
        else obj[header[j]] = v;
      }
      rows[obj.baseline] = obj;
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * Format a deterministic review report into infra_guard.md / claim_guard.md style.
 */
function formatReviewMarkdown(phase, evalResult, stats) {
  const ts = new Date().toISOString();
  let md = `# ${phase} Review — ${ts}\n\n`;
  md += `**Phase**: ${evalResult.phase}\n`;
  md += `**Description**: ${evalResult.description || ""}\n`;
  md += `**Overall**: ${evalResult.all_pass ? "✅ PASS" : "❌ FAIL"}\n`;
  md += `**Hard failures**: ${evalResult.hard_failures.length}\n`;
  md += `**Soft (auto-fixable) failures**: ${evalResult.soft_failures.length}\n`;
  md += `**Unevaluable**: ${evalResult.unevaluable.length}\n\n`;

  md += `## Aggregated Stats\n\n`;
  md += `| Baseline | n | Q@5s | T-1M (ms) | Blank | FV (ms) | Decoded% | TickCnt | SessPrior |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;
  for (const [b, s] of Object.entries(stats)) {
    if (typeof s !== "object" || s.n == null) continue;
    md += `| ${b} | ${s.n} | ${fmt(s.q5s_median, 0)} | ${fmt(s.t1m_median, 0)} | ${fmt(s.blank_ratio_median, 3)} | ${fmt(s.first_visible_median, 0)} | ${fmt(s.decoded_hit_pct_median, 1)} | ${fmt(s.continuous_tick_count_median, 0)} | ${s.session_prior_used} |\n`;
  }
  md += `\n`;

  if (evalResult.hard_failures.length) {
    md += `## ❌ Hard Failures (block, no auto-fix)\n\n`;
    for (const f of evalResult.hard_failures) {
      md += `### ${f.check_id}\n- **Rule**: \`${f.rule}\`\n- **Detail**: ${f.detail}\n- **Claim gate**: ${f.claim_gate}\n\n`;
    }
  }

  if (evalResult.soft_failures.length) {
    md += `## ⚠️ Soft Failures (auto-fixable)\n\n`;
    for (const f of evalResult.soft_failures) {
      md += `### ${f.check_id}\n- **Rule**: \`${f.rule}\`\n- **Detail**: ${f.detail}\n- **Auto-fix**: \`${f.auto_fix}\`\n\n`;
    }
  }

  if (evalResult.unevaluable.length) {
    md += `## ❓ Unevaluable\n\n`;
    for (const u of evalResult.unevaluable) {
      md += `- ${u.check_id}: ${u.detail}\n`;
    }
  }

  if (evalResult.passed.length) {
    md += `## ✅ Passed\n\n`;
    for (const p of evalResult.passed) md += `- ${p}\n`;
  }

  return md;
}

function fmt(x, dec) {
  if (x == null) return "—";
  if (typeof x !== "number") return String(x);
  return x.toFixed(dec);
}

/**
 * Deterministic review: load batch trials, aggregate, evaluate pass_criteria,
 * write infra_guard.md + claim_guard.md + fix_categories.json.
 */
export async function deterministicReview(batchDir, phase) {
  const trials = await loadBatchTrials(batchDir);
  const stats = aggregateBaselines(trials);
  const audit = await loadConfigAudit(batchDir);
  if (audit) stats.config_audit = audit;

  const evalResult = await evaluatePhase(phase, stats);

  // Split into infra (mechanism) and claim (gate) for separate review docs
  const infraResult = { ...evalResult };
  const claimResult = { ...evalResult };

  // Write infra_guard.md (mechanism integrity)
  const infraMd = formatReviewMarkdown(`${phase} INFRA`, infraResult, stats);
  await fs.writeFile(path.join(batchDir, "infra_guard.md"), infraMd, "utf8");

  // Write claim_guard.md (only if this is a claim_gate phase)
  if (evalResult.is_claim_gate) {
    const claimMd = formatReviewMarkdown(`${phase} CLAIM`, claimResult, stats);
    await fs.writeFile(path.join(batchDir, "claim_guard.md"), claimMd, "utf8");
  }

  // Write fix_categories.json
  const fixCategories = [
    ...evalResult.soft_failures.map((f) => ({
      check_id: f.check_id,
      category: f.auto_fix,
      reason: f.detail,
      hard: false,
    })),
    ...evalResult.hard_failures.map((f) => ({
      check_id: f.check_id,
      category: f.auto_fix || "human_escalate",
      reason: f.detail,
      hard: true,
    })),
  ];
  await fs.writeFile(
    path.join(batchDir, "fix_categories.json"),
    JSON.stringify({ phase, fix_categories: fixCategories, generated_at: new Date().toISOString() }, null, 2),
    "utf8",
  );

  // Write blocker if any hard failure with no auto-fix
  if (evalResult.hard_failures.length) {
    const blocker = `# Blocker — ${phase}\n\n` +
      `Hard failures detected with no automatic fix:\n\n` +
      evalResult.hard_failures
        .map((f) => `- **${f.check_id}**: ${f.detail}\n  - Rule: \`${f.rule}\``)
        .join("\n") +
      `\n\nHuman intervention required. See infra_guard.md and claim_guard.md.\n`;
    await fs.writeFile(path.join(batchDir, "blocker_report.md"), blocker, "utf8");
  }

  return { evalResult, stats, fixCategories };
}

/**
 * LLM review: emits a structured marker that the parent Claude session
 * (or an orchestrator) can pick up to invoke ready_remote_gate_review_agent.
 *
 * In Claude Code: parent agent should detect this marker and invoke the
 * sub-agent via the agent tool, passing batchDir as input.
 */
export function emitLlmReviewRequest(batchDir, phase) {
  const marker = {
    type: "LLM_REVIEW_REQUEST",
    agent: "ready_remote_gate_review_agent",
    batchDir,
    phase,
    instruction: `Read trial JSONs in ${batchDir}/per_trial_json, infra_guard.md, claim_guard.md, fix_categories.json. Output a final verdict: GREEN/YELLOW/RED with reasoning. Do not modify any files.`,
  };
  console.log(`\n<<<LLM_REVIEW_REQUEST>>>`);
  console.log(JSON.stringify(marker, null, 2));
  console.log(`<<<END_LLM_REVIEW_REQUEST>>>\n`);
  return marker;
}
