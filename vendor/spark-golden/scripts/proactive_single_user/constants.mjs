/** Proactive single-user baselines — do not rename CDN/HPC. */

export const BASELINES = {
  B0_on_demand: {
    id: "B0_on_demand",
    label: "B0 On-demand",
    ablation_mode: "normal",
    proactive_baseline: "B0",
    use_oracle: false,
  },
  B1_naive_prefetch: {
    id: "B1_naive_prefetch",
    label: "B1 Naive prefetch",
    ablation_mode: "normal",
    proactive_baseline: "B1",
    use_oracle: false,
  },
  B2_priority_prefetch: {
    id: "B2_priority_prefetch",
    label: "B2 Priority prefetch",
    ablation_mode: "normal",
    proactive_baseline: "B2",
    use_oracle: false,
  },
  B3_vrc_single: {
    id: "B3_vrc_single",
    label: "B3 VRC-Single",
    ablation_mode: "normal",
    proactive_baseline: "B3",
    use_oracle: false,
  },
  B4_oracle_prefetch: {
    id: "B4_oracle_prefetch",
    label: "B4 Oracle (upper bound)",
    ablation_mode: "normal",
    proactive_baseline: "B4",
    use_oracle: true,
  },
};

export const DEFAULT_ORIGIN_URL =
  "http://10.120.17.176:8090/examples/streaming-lod/coit-40m-sh1-lod.rad";

export const REMOTE_PROFILE_ID = "cdn1_r2";
