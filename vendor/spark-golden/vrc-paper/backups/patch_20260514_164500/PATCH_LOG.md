# Patch Log — 2026-05-14 16:45:00

## Files Modified

| Original Path | Backup Path | Purpose |
|---|---|---|
| `vrc-paper/experiments/vrc_distributed_merge.mjs` | `vrc-paper/backups/patch_20260514_164500/vrc_distributed_merge.mjs` | H4 fix: extract VRC decisions from server JSONL when shard merge produces empty vrc_decisions.jsonl |
| `vrc-paper/experiments/run_experiment.mjs` | `vrc-paper/backups/patch_20260514_164500/run_experiment.mjs` | H6 fix: add `--headless=new` and `executablePath` for system Chrome on Worker2; H2 fix: trace_url wiring |
| `vrc-paper/experiments/run_experiment_distributed.mjs` | `vrc-paper/backups/patch_20260514_164500/run_experiment_distributed.mjs` | H2/H5 fix: auto-set VRC_CDN_LABEL=cdn1 for static_cdn; add VRC_CHROME_PATH to remote env |
| `vrc-paper/analysis/validate_canary.mjs` | `vrc-paper/backups/patch_20260514_164500/validate_canary.mjs` | Reference backup (no changes yet) |
