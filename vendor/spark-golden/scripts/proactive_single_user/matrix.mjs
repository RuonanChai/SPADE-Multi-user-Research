import { BASELINES } from "./constants.mjs";

export function expandTrials(matrix, phaseName) {
  const phase = matrix.phases[phaseName];
  if (!phase) throw new Error(`Unknown phase: ${phaseName}`);
  const trials = [];
  for (const baselineId of phase.baselines) {
    const arm = BASELINES[baselineId];
    if (!arm) continue;
    for (let i = 0; i < (phase.trials_per_baseline ?? 1); i++) {
      trials.push({
        phase: phaseName,
        delivery_key: phase.delivery,
        baseline_id: baselineId,
        baseline: arm,
        trial_index: i,
        scenario: matrix.scenario,
        warmup_ms: matrix.warmup_ms,
        move_ms: matrix.move_ms,
        timeout_ms: matrix.timeout_ms,
        prefetch_budget_bytes: matrix.prefetch_budget_bytes,
      });
    }
  }
  return trials;
}

export function trialId(desc) {
  return [
    desc.delivery_key,
    desc.baseline_id,
    desc.phase,
    `t${desc.trial_index}`,
  ].join("__");
}
