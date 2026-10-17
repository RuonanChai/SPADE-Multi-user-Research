/**
 * Worker2 browser shard — **not** invoked as the main entry in this repo.
 *
 * `run_experiment_distributed.mjs` SSH-launches:
 *   `node vrc-paper\experiments\run_experiment.mjs`
 * with `VRC_USER_INDICES=2,3`, `VRC_DISTRIBUTED=true`, `VRC_WORKER_ID=worker2`,
 * `VRC_BROWSER_ORIGIN` / `VRC_PUBLIC_PAGE_BASE` = `http://<controller>:9200`, and
 * `VRC_SYNC_HTTP_HOST=<controller>`.
 *
 * This file exists so operators can grep for "remote client worker" and to allow a future
 * dedicated thin launcher without changing metrics formulas.
 */
process.stderr.write("[run_remote_client_worker] Do not run directly — use run_experiment.mjs from SSH (see run_experiment_distributed.mjs).\n");
process.exit(2);
