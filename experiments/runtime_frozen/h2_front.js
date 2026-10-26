"use strict";

const fs = require("fs");
const http = require("http");
const http2 = require("http2");
const path = require("path");

const PORT = Number(process.env.E1_H2_PORT || 18443);
const BACKEND = Number(process.env.E1_H2_BACKEND || 18081);
const KEY = process.env.E1_H2_KEY || path.join("F:/WWW_E1_HT/runtime/key.pem");
const CERT = process.env.E1_H2_CERT || path.join("F:/WWW_E1_HT/runtime/cert.pem");
const LOG = process.env.E1_H2_LOG || path.join("F:/WWW_E1_HT/evidence/h2_front.jsonl");

function write(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ timestamp: Date.now(), ...row }) + "\n");
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-expose-headers": "content-range, accept-ranges, content-length, content-type",
};

function normalizePath(urlPath) {
  let pathName = urlPath || "/";
  if (pathName.startsWith("/_p5rad")) pathName = pathName.slice("/_p5rad".length) || "/";
  return pathName;
}

function forward(method, urlPath, hdrs, onRes, onErr) {
  const req = http.request({
    hostname: "127.0.0.1",
    port: BACKEND,
    path: urlPath,
    method,
    headers: {
      range: hdrs.range || hdrs.Range || "",
      "x-user-id": hdrs["x-user-id"] || hdrs["X-User-ID"] || "",
      "x-run-id": hdrs["x-run-id"] || hdrs["X-Run-ID"] || "",
    },
  }, onRes);
  req.on("error", onErr);
  return req;
}

const server = http2.createSecureServer({
  key: fs.readFileSync(KEY),
  cert: fs.readFileSync(CERT),
  allowHTTP1: true,
});

server.on("error", (error) => {
  write({ type: "server_error", message: error.message });
  console.error("H2_SERVER_ERROR", error.message);
});

server.on("stream", (stream, headers) => {
  const method = headers[":method"] || "GET";
  const urlPath = normalizePath(headers[":path"] || "/");
  const alpn = stream.session && stream.session.alpnProtocol;
  write({ type: "stream", method, urlPath, alpn });
  if (method === "OPTIONS") {
    stream.respond({ ":status": 204, ...CORS });
    stream.end();
    return;
  }
  const fwd = forward(method, urlPath, headers, (res) => {
    const out = { ":status": res.statusCode, ...CORS };
    const drop = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "http2-settings"]);
    for (const [key, value] of Object.entries(res.headers)) {
      if (drop.has(key) || key.startsWith(":")) continue;
      out[key] = value;
    }
    try {
      stream.respond(out);
    } catch (error) {
      write({ type: "respond_error", message: error.message });
      stream.close(2);
      return;
    }
    res.pipe(stream);
  }, (error) => {
    write({ type: "backend_error", message: error.message });
    if (!stream.headersSent) stream.respond({ ":status": 502, ...CORS });
    stream.end("backend");
  });
  stream.pipe(fwd);
});

server.on("request", (req, res) => {
  if (req.httpVersionMajor === 2) return;
  const method = req.method || "GET";
  const urlPath = normalizePath(req.url || "/");
  write({ type: "http1", method, urlPath });
  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const fwd = forward(method, urlPath, req.headers, (up) => {
    const out = { ...CORS };
    for (const [key, value] of Object.entries(up.headers)) {
      if (key !== "transfer-encoding") out[key] = value;
    }
    res.writeHead(up.statusCode, out);
    up.pipe(res);
  }, (error) => {
    write({ type: "backend_error", message: error.message });
    if (!res.headersSent) res.writeHead(502, CORS);
    res.end("backend");
  });
  req.pipe(fwd);
});

server.listen(PORT, "0.0.0.0", () => {
  write({ type: "listen", port: PORT, backend: BACKEND });
  console.log(`H2_LISTEN port=${PORT} backend=${BACKEND}`);
});
