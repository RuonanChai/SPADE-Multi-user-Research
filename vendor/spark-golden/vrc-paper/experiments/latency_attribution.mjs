/**
 * Phase 6: Multi-signal latency attribution (not max-bucket only).
 */
export function computeLatencyAttribution({
  net_total_p95_ms = 0,
  p95_latency_ms = 0,
  viewport_to_visible_latency_ms = null,
  trace_main_script_ms = 0,
  trace_long_task_count = 0,
  trace_layout_paint_ms = 0,
  trace_composite_ms = 0,
  trace_gpu_ms = 0,
  trace_raster_ms = 0,
  fps = 0,
  resource_timing_ok = false,
  trace_ok = false,
  net_completed_request_count = 0,
  playwright_chunk_rows = 0,
  net_zero_encoded_length_count = 0,
}) {
  const renderVisible = viewport_to_visible_latency_ms != null
    && String(viewport_to_visible_latency_ms) !== "NA"
    && Number(viewport_to_visible_latency_ms) > 0;

  let confidence = "low";
  const reasons = [];

  const netP95 = Number(net_total_p95_ms) || Number(p95_latency_ms) || 0;
  const traceRender = Number(trace_gpu_ms) + Number(trace_composite_ms) + Number(trace_raster_ms) + Number(trace_layout_paint_ms);
  const traceMain = Number(trace_main_script_ms);
  const longTasks = Number(trace_long_task_count);
  const fpsVal = Number(fps);

  if (playwright_chunk_rows > 0 && net_completed_request_count === 0) {
    reasons.push("METRICS_COLLECTION_BUG:playwright_logs_without_cdp_network");
  }
  if (net_completed_request_count > 0 && net_zero_encoded_length_count > net_completed_request_count * 0.5) {
    reasons.push("METRICS_COLLECTION_BUG:cdp_encodedDataLength_mostly_zero_check_206_vs_body");
  }
  if (!resource_timing_ok && net_completed_request_count > 0) {
    reasons.push("RESOURCE_TIMING_TAO_OR_ZERO:do_not_call_network_failure");
  }

  let attribution = "unknown";
  let ratioNetwork = null;

  if (renderVisible) {
    confidence = "medium";
    ratioNetwork = netP95 / Math.max(1, Number(viewport_to_visible_latency_ms));
    if (ratioNetwork > 0.55) {
      attribution = "network";
      reasons.push(`network_ratio_vs_viewport=${ratioNetwork.toFixed(2)}`);
    } else if (traceRender > traceMain * 1.2 && traceRender > 50) {
      attribution = "rendering_gpu";
      reasons.push("trace_gpu_composite_dominate");
    } else if (longTasks >= 3 || traceMain > traceRender * 1.5) {
      attribution = "browser_main_thread";
      reasons.push(`longtask_count=${longTasks}`);
    } else {
      attribution = "mixed";
      reasons.push("no_single_dominant_bucket");
    }
  } else if (trace_ok && net_completed_request_count > 0) {
    confidence = "medium";
    if (netP95 > 800 && netP95 > traceRender + traceMain) {
      attribution = "network";
      reasons.push(`net_p95=${netP95.toFixed(0)}ms_dominates`);
    } else if (traceRender > traceMain && traceRender > 30) {
      attribution = "rendering_gpu";
      reasons.push("trace_render_buckets");
    } else if (traceMain > 30 || longTasks > 0) {
      attribution = "browser_main_thread";
      reasons.push("trace_main_or_longtask");
    } else {
      attribution = "mixed";
    }
  } else if (net_completed_request_count > 0) {
    attribution = "network";
    confidence = "low";
    reasons.push("no_render_visible_timestamp_cdp_network_only");
  } else if (fpsVal > 0 && fpsVal < 8) {
    attribution = "rendering_gpu";
    confidence = "low";
    reasons.push(`low_fps=${fpsVal.toFixed(1)}_weak_signal`);
  } else {
    attribution = "metrics_collection_bug";
    confidence = "low";
    reasons.push("insufficient_network_and_trace_signals");
  }

  if (!renderVisible && attribution !== "metrics_collection_bug") {
    confidence = "low";
    reasons.push("missing_render_visible_timestamp");
  }

  return {
    latency_attribution: attribution,
    latency_attribution_confidence: confidence,
    attribution_reason: reasons.join(";"),
    network_viewport_ratio: ratioNetwork,
  };
}
