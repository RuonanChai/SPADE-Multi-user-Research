import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire("D:/Program/SPADE/NSDI_SPADE_DIAG_W04/spark/package.json");
const { defineConfig } = require("vite");

const stageLog = process.env.G1_STAGE_LOG;
const cacheDir = process.env.G1_VITE_CACHE;
if (!stageLog || !cacheDir) throw new Error("VITE_ISOLATED_PATHS_REQUIRED");
const spark = "D:/Program/SPADE/NSDI_SPADE_DIAG_W04/spark";

function appendStage(row) {
  fs.mkdirSync(path.dirname(stageLog), { recursive: true });
  fs.appendFileSync(stageLog, JSON.stringify(row) + "\n");
}

export default defineConfig({
  plugins: [{
    name: "g1-clock",
    configureServer(server) {
      server.middlewares.use("/favicon.ico", (_req, res) => {
        res.statusCode = 204;
        res.end();
      });
      server.middlewares.use((req, res, next) => {
        res.on("finish", () => {
          if (res.statusCode === 404) appendStage({ tag: "vite_404", url: req.url || "", status: 404 });
        });
        next();
      });
      server.middlewares.use("/clock", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ date_ms: Date.now() }));
      });
    },
  }],
  root: spark,
  cacheDir,
  resolve: {
    alias: {
      "/examples/js/vendor/three/build/three.module.js": spark + "/examples/js/vendor/three/build/three.module.js",
      "/examples/js/vendor/lil-gui/dist/lil-gui.esm.js": spark + "/node_modules/lil-gui/dist/lil-gui.esm.js",
    },
  },
  optimizeDeps: { entries: ["examples/streaming-lod/index.html"] },
  server: {
    port: 18080,
    host: "0.0.0.0",
    strictPort: true,
    cors: true,
    fs: {
      allow: [spark, path.resolve(cacheDir)],
    },
    watch: {
      ignored: [path.resolve(cacheDir), path.join(spark, "examples/streaming-lod/index.html")],
    },
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
            for (const name of ["x-p5-obs-reason", "x-p5-pose", "x-p5-quat", "x-p5-fov", "x-p5-vp", "x-p5-vis", "x-p5-queued", "x-p5-demand", "x-p5-future-frame"]) {
              if (req.headers[name]) proxyReq.setHeader(name, req.headers[name]);
            }
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
