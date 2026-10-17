import { defineConfig } from "vite";
import fs from "fs";
import path from "path";

const stageLog = process.env.G1_STAGE_LOG || "F:/WWW_N3_MUX/evidence/vite_rad_stages.jsonl";

function appendStage(row) {
  fs.mkdirSync(path.dirname(stageLog), { recursive: true });
  fs.appendFileSync(stageLog, JSON.stringify(row) + "\n");
}

export default defineConfig({
  plugins: [{
    name: "g1-clock",
    configureServer(server) {
      server.middlewares.use("/clock", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ date_ms: Date.now() }));
      });
    },
  }],
  root: "D:/Program/NSDI_SPADE_DIAG_W04/spark",
  cacheDir: process.env.G1_VITE_CACHE || "F:/WWW_N3_MUX/runtime/vite-cache",
  resolve: {
    alias: {
      "/examples/js/vendor/three/build/three.module.js": "D:/Program/NSDI_SPADE_DIAG_W04/spark/node_modules/three/build/three.module.js",
      "/examples/js/vendor/lil-gui/dist/lil-gui.esm.js": "D:/Program/NSDI_SPADE_DIAG_W04/spark/node_modules/lil-gui/dist/lil-gui.esm.js",
    },
  },
  optimizeDeps: {
    entries: ["examples/streaming-lod/index.html"],
  },
  server: {
    port: 18080,
    host: "0.0.0.0",
    strictPort: true,
    cors: true,
    proxy: {
      "/_p5rad": {
        target: "http://127.0.0.1:18081",
        changeOrigin: true,
        rewrite: (value) => value.replace(/^\/_p5rad/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            req._p5ViteAcceptAt = Date.now();
            if (req.headers.range) proxyReq.setHeader("Range", req.headers.range);
            if (req.headers["x-user-id"]) proxyReq.setHeader("X-User-ID", req.headers["x-user-id"]);
            if (req.headers["x-run-id"]) proxyReq.setHeader("X-Run-ID", req.headers["x-run-id"]);
          });
          proxy.on("proxyRes", (proxyRes, req, res) => {
            const headersAt = Date.now();
            proxyRes.headers["cache-control"] = "no-store";
            res.on("finish", () => {
              appendStage({
                tag: "vite_rad_stage",
                url: req.url,
                accept_ms: req._p5ViteAcceptAt || null,
                headers_ms: headersAt,
                finish_ms: Date.now(),
              });
            });
          });
        },
      },
    },
  },
});
