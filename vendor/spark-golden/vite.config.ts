import fs from "node:fs";
import path from "node:path";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import glsl from "vite-plugin-glsl";

/**
 * Vite plugin to fix WASM data URL compatibility with webpack/Next.js.
 *
 * wasm-pack generates code like: new URL("data:...", import.meta.url)
 * The import.meta.url argument is unnecessary for data: URLs and causes
 * webpack/Vite to incorrectly try to rewrite the URL as a file path.
 *
 * This plugin transforms:
 *   new URL("data:...", import.meta.url) → new URL("data:...")
 *
 * Uses magic-string to ensure proper source map generation.
 *
 * See: https://github.com/sparkjsdev/spark/issues/95
 */
function fixWasmDataUrl(): Plugin {
  return {
    name: "fix-wasm-data-url",
    renderChunk(code) {
      // Match: new URL("data:...", import.meta.url)
      // The data URL can contain any characters including quotes (escaped)
      const dataUrlPattern =
        /new\s+URL\(\s*("data:[^"]*")\s*,\s*import\.meta\.url\s*\)/g;

      const matches = [...code.matchAll(dataUrlPattern)];
      if (matches.length === 0) return null;

      const magicString = new MagicString(code);
      for (const match of matches) {
        if (match.index === undefined) continue;
        const start = match.index;
        const end = start + match[0].length;
        const replacement = `new URL(${match[1]})`;
        magicString.overwrite(start, end, replacement);
      }

      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}

/** Dev vs prod lib builds emit different filenames; package.json "exports" points at spark.module.js only. */
function resolveSparkPackageEntry(): string {
  const distDir = path.resolve(__dirname, "dist");
  const devBundle = path.join(distDir, "spark.module.js");
  const prodBundle = path.join(distDir, "spark.module.min.js");
  if (fs.existsSync(devBundle)) return devBundle;
  if (fs.existsSync(prodBundle)) return prodBundle;
  return devBundle;
}

const assetsDirectory = "examples/assets";
const localAssetsDirectoryExist = fs.existsSync(assetsDirectory);
if (!localAssetsDirectoryExist) {
  console.log(
    "************************************************************************",
  );
  console.log(" Examples assets will be fetched from an external server.");
  console.log(
    " To work offline you can download them: npm run assets:download",
  );
  console.log(
    "************************************************************************",
  );
}

export default defineConfig(({ mode }) => {
  const isMinify = mode === "production";
  const isFirstPass = mode === "production";

  return {
    appType: "mpa",

    resolve: {
      alias: {
        "@sparkjsdev/spark": resolveSparkPackageEntry(),
      },
    },

    plugins: [
      glsl({
        include: ["**/*.glsl"],
      }),

      dts({ outDir: "dist/types" }),

      // Fix webpack/Next.js compatibility for WASM data URLs
      fixWasmDataUrl(),
      {
        name: "serve-node-modules-alias",
        configureServer(server) {
          const assetsSplatsPath = "/assets/splats/";
          server.middlewares.use((req, res, next) => {
            if (!req.url || !req.url.startsWith(assetsSplatsPath)) return next();
            const clean = req.url.split("?")[0] ?? req.url;
            const rel = clean.slice(assetsSplatsPath.length);
            if (!rel || rel.includes("..")) {
              res.statusCode = 400;
              res.end("bad path");
              return;
            }
            const baseDir = path.resolve(assetsDirectory, "splats");
            const absPath = path.resolve(baseDir, rel);
            if (!absPath.startsWith(baseDir)) {
              res.statusCode = 403;
              res.end("forbidden");
              return;
            }
            if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
              res.setHeader("Content-Type", "application/octet-stream");
              res.setHeader("Accept-Ranges", "bytes");
              fs.createReadStream(absPath).pipe(res);
            } else {
              res.statusCode = 404;
              res.end(`Not found: ${rel}`);
            }
          });
          console.log(`📦 Dev alias active: ${assetsSplatsPath}* → ${path.join(assetsDirectory, "splats")}/*`);

          const baseUrlPath = "/examples/js/vendor/";

          server.middlewares.use((req, res, next) => {
            if (!req.url.startsWith(baseUrlPath)) return next();

            const relModulePath = req.url.slice(baseUrlPath.length); // safe substring
            const absPath = path.resolve("node_modules", relModulePath);

            if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
              const ext = path.extname(absPath);
              const contentType =
                {
                  ".js": "application/javascript",
                  ".mjs": "application/javascript",
                  ".css": "text/css",
                  ".json": "application/json",
                }[ext] || "application/octet-stream";

              res.setHeader("Content-Type", contentType);
              fs.createReadStream(absPath).pipe(res);
            } else {
              res.statusCode = 404;
              res.end(`Not found: ${relModulePath}`);
            }
          });

          console.log(`📦 Dev alias active: ${baseUrlPath} → node_modules/*`);
        },
      },
    ],

    build: {
      minify: isMinify,
      lib: {
        entry: path.resolve(__dirname, "src/index.ts"),
        name: "spark",
        formats: ["es", "cjs"],
        fileName: (format) => {
          const base = format === "es" ? "spark.module" : `spark.${format}`;
          return isMinify ? `${base}.min.js` : `${base}.js`;
        },
      },
      sourcemap: true,
      rollupOptions: {
        external: ["three"],
        output: {
          globals: {
            three: "THREE",
          },
        },
      },
      emptyOutDir: isFirstPass,
    },

    worker: {
      rollupOptions: {
        treeshake: "smallest",
      },
      plugins: () => [
        glsl({
          include: ["**/*.glsl"],
        }),
      ],
    },

    server: {
      watch: {
        usePolling: true,
      },
      port: 8080,
      proxy: {
        // P5_3DGS same-origin proxy: forward /_p5rad/* to scheduler on port 8081
        '/_p5rad': {
          target: process.env.P5_SCHEDULER_URL || 'http://127.0.0.1:8081',
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/_p5rad/, ''),
          configure: (proxy, _options) => {
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              // Vite automatically forwards Range headers and query params
              console.log(`[Vite Proxy] ${req.method} ${req.url} → 8081`);
            });
            proxy.on('error', (err, _req, _res) => {
              console.error('[Vite Proxy Error]', err.message);
            });
          },
        },
      },
    },

    optimizeDeps: {
      force: true,
      exclude: ["three"], // prevent Vite pre-bundling
    },

    define: {
      sparkLocalAssets: localAssetsDirectoryExist,
    },
  };
});
