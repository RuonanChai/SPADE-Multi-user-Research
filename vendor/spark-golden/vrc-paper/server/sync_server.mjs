/**
 * VRC Sync Server
 * Lightweight WebSocket server that synchronizes user state and runs the VRC coordinator.
 * Does NOT modify any Spark source files.
 *
 * Hybrid delivery: when delivery_profile is origin_only | vrc_guided_hybrid,
 * (static_cdn removed — use vrc_guided_hybrid: hot/shared chunks → CDN, cold/personal → HPC).
 * vrc_decision includes chunk_delivery + fetch_plan_version (see VRC_DELIVERY_PROFILE env).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.VRC_SYNC_PORT ?? 9201);
/** Listen address (default 0.0.0.0 so worker2 can reach controller LAN IP). */
const BIND = (process.env.VRC_SYNC_BIND ?? "0.0.0.0").trim() || "0.0.0.0";
const LOG_DIR = process.env.VRC_LOG_DIR ?? path.join(__dirname, "../results/raw");
const DECISION_INTERVAL_MS = Number(process.env.VRC_DECISION_INTERVAL_MS ?? 50);

fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Hybrid delivery config (overridable via /session/new body) ───────────────
const R2_DEFAULT = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev";
let deliveryProfile = (process.env.VRC_DELIVERY_PROFILE ?? "").trim();
let hotThreshold = Number(process.env.VRC_HOT_THRESHOLD ?? 2);
let hpcAssetBase = (process.env.VRC_HPC_ASSET_BASE ?? "http://10.120.17.176:8090").trim().replace(/\/+$/, "");
let cdnAssetBase = (process.env.VRC_CDN_ASSET_BASE ?? R2_DEFAULT).trim().replace(/\/+$/, "");
let cdn2AssetBase = (process.env.VRC_CDN2_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
/** Telemetry label: cdn1 (default) uses source_selected cdn_r2; cdn2 uses cdn2 for static/hybrid hot paths. */
let cdnLabel = (process.env.VRC_CDN_LABEL ?? "").trim().toLowerCase();

function cdnBaseForLabel() {
  if (cdnLabel === "cdn2" && cdn2AssetBase) return cdn2AssetBase;
  return cdnAssetBase;
}

function isActiveHybridProfile() {
  return deliveryProfile === "origin_only"
    || deliveryProfile === "vrc_guided_hybrid";
}

// ── state ─────────────────────────────────────────────────────────────────────
const clients = new Map(); // clientId → { ws, state, method }
let sessionId = `session_${Date.now()}`;
let logStream = null;
let method = process.env.VRC_METHOD ?? "VRC";
let fetchPlanVersion = 0;

function openLog() {
  if (logStream) logStream.end();
  const fname = path.join(LOG_DIR, `${sessionId}_server.jsonl`);
  logStream = fs.createWriteStream(fname, { flags: "a" });
  console.log(`[sync] logging to ${fname}`);
}

function appendLog(obj) {
  if (!logStream) return;
  logStream.write(JSON.stringify({ t: Date.now(), ...obj }) + "\n");
}

function computeVRCDecision() {
  const states = [...clients.values()].map((c) => c.state).filter(Boolean);
  if (states.length === 0) return null;

  const allDemand = new Map(); // chunkId → Set of userIds
  for (const s of states) {
    for (const chunkId of s.viewport_chunks ?? []) {
      const k = String(chunkId);
      if (!allDemand.has(k)) allDemand.set(k, new Set());
      allDemand.get(k).add(s.user_id);
    }
  }

  const shared = [];
  const personalized = {};
  for (const [chunkId, users] of allDemand) {
    if (users.size >= 2) {
      shared.push(chunkId);
    } else {
      const uid = [...users][0];
      if (!personalized[uid]) personalized[uid] = [];
      personalized[uid].push(chunkId);
    }
  }

  const scheduledShared = method === "VRC" || method === "NET-S" || method === "VRC-N"
    ? shared.sort((a, b) => Number(a) - Number(b))
    : shared;

  const decision = {
    type: "vrc_decision",
    session_id: sessionId,
    decision_step: Date.now(),
    method,
    shared_chunks: scheduledShared,
    personalized_chunks: personalized,
    num_users: states.length,
    duplicate_demand_raw: [...allDemand.entries()].map(([k, v]) => ({
      chunk: k,
      users: [...v],
    })),
  };

  if (isActiveHybridProfile()) {
    fetchPlanVersion += 1;
    const chunk_delivery = {};
    for (const [chunkId, users] of allDemand) {
      const demandCount = users.size;
      const userList = [...users];
      let source_selected = "hpc_server";
      let source_reason = "unknown_default_origin";
      let source_base = hpcAssetBase;

      if (deliveryProfile === "origin_only") {
        source_selected = "hpc_server";
        source_reason = "origin_only";
        source_base = hpcAssetBase;
      } else if (deliveryProfile === "static_cdn") {
        console.warn("[sync] static_cdn is deprecated and ignored; use vrc_guided_hybrid (hot→CDN, cold/personal→HPC)");
        source_selected = "hpc_server";
        source_reason = "deprecated_static_cdn_treated_as_hpc";
        source_base = hpcAssetBase;
      } else if (deliveryProfile === "vrc_guided_hybrid") {
        const isHot = demandCount >= hotThreshold || scheduledShared.includes(chunkId);
        if (isHot) {
          if (cdnLabel === "cdn2") {
            source_selected = "cdn2";
            source_reason = "shared_hot";
            source_base = cdnBaseForLabel();
          } else {
            source_selected = "cdn_r2";
            source_reason = "shared_hot";
            source_base = cdnAssetBase;
          }
        } else {
          source_selected = "hpc_server";
          source_reason = "cold";
          for (const uid of userList) {
            if (personalized[uid]?.includes(chunkId)) {
              source_reason = "personalized";
              break;
            }
          }
          source_base = hpcAssetBase;
        }
      }

      chunk_delivery[chunkId] = {
        source_selected,
        source_reason,
        source_base,
        demand_count: demandCount,
        users: userList,
      };
    }

    decision.delivery_profile = deliveryProfile;
    decision.cdn_label = cdnLabel || undefined;
    decision.fetch_plan_version = fetchPlanVersion;
    decision.chunk_delivery = chunk_delivery;
  }

  appendLog({ event: "vrc_decision", ...decision });
  return decision;
}

// ── VRC decision timer ────────────────────────────────────────────────────────
let decisionTimer = null;

function startDecisionLoop() {
  if (decisionTimer) clearInterval(decisionTimer);
  decisionTimer = setInterval(() => {
    const decision = computeVRCDecision();
    if (!decision) return;
    for (const { ws } of clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(decision));
      }
    }
  }, DECISION_INTERVAL_MS);
}

// ── HTTP server (health + session control) ────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      clients: clients.size,
      session_id: sessionId,
      method,
      delivery_profile: deliveryProfile || "legacy",
      cdn_label: cdnLabel || undefined,
      fetch_plan_version: fetchPlanVersion,
    }));
    return;
  }

  if (url.pathname === "/session/new" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        sessionId = parsed.session_id ?? `session_${Date.now()}`;
        method = parsed.method ?? "VRC";
        if (typeof parsed.delivery_profile === "string" && parsed.delivery_profile.trim()) {
          deliveryProfile = parsed.delivery_profile.trim();
        }
        if (parsed.hot_threshold != null && Number.isFinite(Number(parsed.hot_threshold))) {
          hotThreshold = Number(parsed.hot_threshold);
        }
        if (typeof parsed.hpc_asset_base === "string" && parsed.hpc_asset_base.trim()) {
          hpcAssetBase = parsed.hpc_asset_base.trim().replace(/\/+$/, "");
        }
        if (typeof parsed.cdn_asset_base === "string" && parsed.cdn_asset_base.trim()) {
          cdnAssetBase = parsed.cdn_asset_base.trim().replace(/\/+$/, "");
        }
        if (typeof parsed.cdn2_asset_base === "string") {
          cdn2AssetBase = parsed.cdn2_asset_base.trim().replace(/\/+$/, "");
        }
        if (typeof parsed.cdn_label === "string" && parsed.cdn_label.trim()) {
          cdnLabel = parsed.cdn_label.trim().toLowerCase();
        }
        openLog();
        appendLog({
          event: "session_new",
          session_id: sessionId,
          method,
          delivery_profile: deliveryProfile || "legacy",
          hot_threshold: hotThreshold,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          session_id: sessionId,
          method,
          delivery_profile: deliveryProfile || "legacy",
        }));
      } catch {
        res.writeHead(400); res.end("bad json");
      }
    });
    return;
  }

  if (url.pathname === "/metrics" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const metrics = JSON.parse(body);
        appendLog({ event: "client_metrics", ...metrics });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end("bad json");
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const urlParams = new URL(req.url, `ws://localhost:${PORT}`).searchParams;
  const userId = urlParams.get("user_id") ?? `u${Date.now()}`;
  const clientId = userId;

  clients.set(clientId, { ws, state: null });
  console.log(`[sync] connect: ${clientId} (${clients.size} total)`);
  appendLog({ event: "connect", user_id: userId, num_clients: clients.size });

  ws.send(JSON.stringify({
    type: "session_context",
    session_id: sessionId,
    method,
    delivery_profile: deliveryProfile || "legacy",
  }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "user_state") {
        clients.get(clientId).state = { ...msg, user_id: userId };
        appendLog({ event: "user_state", user_id: userId, ...msg });

        const peers = [...clients.entries()]
          .filter(([id]) => id !== clientId)
          .map(([, c]) => c.state)
          .filter(Boolean);
        ws.send(JSON.stringify({ type: "peer_states", peers }));

        for (const [id, c] of clients) {
          if (id !== clientId && c.ws.readyState === c.ws.OPEN) {
            const myState = clients.get(clientId)?.state;
            c.ws.send(JSON.stringify({ type: "peer_state_update", user_id: userId, state: myState }));
          }
        }
      } else if (msg.type === "chunk_event") {
        appendLog({ event: "chunk_event", user_id: userId, ...msg });
      } else if (msg.type === "metrics_snapshot") {
        appendLog({ event: "metrics_snapshot", user_id: userId, ...msg });
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[sync] disconnect: ${clientId} (${clients.size} total)`);
    appendLog({ event: "disconnect", user_id: userId, num_clients: clients.size });
  });
});

openLog();
startDecisionLoop();

httpServer.listen(PORT, BIND, () => {
  console.log(`[sync] VRC sync server listening on ws://${BIND}:${PORT} (health http://${BIND}:${PORT}/health)`);
  console.log(`[sync] method=${method}  session=${sessionId} delivery=${deliveryProfile || "legacy"}`);
});
