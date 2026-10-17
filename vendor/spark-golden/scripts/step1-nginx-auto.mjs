import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "ssh2";

const cfg = {
  sshHost: "10.120.17.176",
  sshUser: "ddddd",
  sshPass: "ddddd",
  appServer: "http://10.120.17.176:8090",
  nginxPort: 8092,
  scenePath: "/home/ddddd/download/Spark2.0/spark-main/examples/assets/splats/butterfly.spz",
  nginxServePath: "/tmp/step1-butterfly.spz",
  remoteMetricsPath: "/home/ddddd/download/Spark2.0/spark-main/bench-data/metrics.jsonl",
  duration: 120000,
  repeats: 5,
  users: 10,
};

function runNode(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit code ${code}`));
    });
  });
}

function sshExec(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          let out = "";
          let errOut = "";
          stream.on("data", (d) => {
            out += d.toString();
          });
          stream.stderr.on("data", (d) => {
            errOut += d.toString();
          });
          stream.on("close", (code) => {
            conn.end();
            if (code === 0) resolve({ out, err: errOut });
            else reject(new Error(errOut || out || `ssh exit ${code}`));
          });
        });
      })
      .on("error", reject)
      .connect({
        host: cfg.sshHost,
        username: cfg.sshUser,
        password: cfg.sshPass,
        readyTimeout: 20000,
      });
  });
}

async function httpOk(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function m(data, g, key, field = "median") {
  return data.summary[g][key][field];
}

async function main() {
  const repoRoot = process.cwd();
  const workspaceRoot = path.resolve(repoRoot, "..");
  const resultDir = path.join(workspaceRoot, "260421");
  await fs.mkdir(resultDir, { recursive: true });

  console.log("[1/6] 配置并启动远端 Nginx 静态服务...");
  const nginxConf = `
server {
    listen ${cfg.nginxPort};
    server_name _;
    access_log /tmp/step1_nginx_access.log;
    error_log  /tmp/step1_nginx_error.log warn;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;

    location = /healthz {
        add_header Content-Type text/plain;
        return 200 "ok";
    }

    location = /butterfly.spz {
        alias ${cfg.nginxServePath};
        add_header Access-Control-Allow-Origin "*";
        add_header Timing-Allow-Origin "*";
        add_header Cache-Control "public, max-age=31536000, immutable";
        types { }
        default_type application/octet-stream;
    }
}
`;
  const confB64 = Buffer.from(nginxConf, "utf8").toString("base64");
  await sshExec(
    [
      "set -e",
      `cp -f "${cfg.scenePath}" "${cfg.nginxServePath}"`,
      `chmod 644 "${cfg.nginxServePath}"`,
      `echo '${confB64}' | base64 -d | sudo tee /etc/nginx/conf.d/step1_spark_spz.conf >/dev/null`,
      "sudo nginx -t",
      "sudo systemctl restart nginx",
      `curl -sS -I --max-time 5 http://127.0.0.1:${cfg.nginxPort}/butterfly.spz >/tmp/step1_nginx_probe.txt`,
    ].join(" ; "),
  );

  console.log("[2/6] 远端健康检查...");
  const ok1 = await httpOk(`${cfg.appServer}/bench`);
  const ok2 = await httpOk(`http://${cfg.sshHost}:${cfg.nginxPort}/healthz`);
  const ok3 = await httpOk(`http://${cfg.sshHost}:${cfg.nginxPort}/butterfly.spz`);
  if (!ok1 || !ok2 || !ok3) {
    throw new Error(`healthcheck failed app=${ok1} nginx_health=${ok2} spz=${ok3}`);
  }

  console.log("[3/6] 执行 Step1 A/B/C 压测（5轮）...");
  const scene = `http://${cfg.sshHost}:${cfg.nginxPort}/butterfly.spz`;
  await runNode(
    "node",
    [
      "bench-run-remote-ingest.js",
      `--server=${cfg.appServer}`,
      `--users=${cfg.users}`,
      `--repeats=${cfg.repeats}`,
      `--duration=${cfg.duration}`,
      `--scene=${scene}`,
      "--scene_version=step1-nginx-static-v1",
      `--sshHost=${cfg.sshHost}`,
      `--sshUser=${cfg.sshUser}`,
      `--sshPass=${cfg.sshPass}`,
    ],
    repoRoot,
  );

  console.log("[4/6] 读取本次分析 + 基线分析...");
  const base = JSON.parse(await fs.readFile(path.join(repoRoot, "results", "final-remote-analysis-v5.json"), "utf8"));
  const step1 = JSON.parse(await fs.readFile(path.join(repoRoot, "results", "remote-analysis.json"), "utf8"));
  await fs.writeFile(path.join(repoRoot, "results", "step1-nginx-analysis.json"), JSON.stringify(step1, null, 2), "utf8");

  console.log("[5/6] 生成对比结果...");
  const rows = ["group,base_first_byte_median,base_first_byte_p95,step1_first_byte_median,step1_first_byte_p95,delta_median_pct,delta_p95_pct"];
  for (const g of ["A", "B", "C"]) {
    const bm = m(base, g, "first_byte_gap");
    const bp = m(base, g, "first_byte_gap", "p95");
    const sm = m(step1, g, "first_byte_gap");
    const sp = m(step1, g, "first_byte_gap", "p95");
    const dm = bm ? ((sm - bm) / bm) * 100 : null;
    const dp = bp ? ((sp - bp) / bp) * 100 : null;
    rows.push(`${g},${bm},${bp},${sm},${sp},${dm?.toFixed(1)},${dp?.toFixed(1)}`);
  }
  await fs.writeFile(path.join(resultDir, "Step1_Nginx_first_byte_gap_compare.csv"), `${rows.join("\n")}\n`, "utf8");

  const report = `# Step1 真静态服务实验报告（自动生成）

## 实验配置
- App 页面服务：\`${cfg.appServer}\`（保持不变）
- .spz 服务：\`http://${cfg.sshHost}:${cfg.nginxPort}/butterfly.spz\`（Nginx 真静态）
- 并发矩阵：A=1/high, B=10/high, C=10/low
- 轮次与时长：5 轮，duration=${cfg.duration}ms

## first_byte_gap 关键对比
- B 组基线：median=${m(base, "B", "first_byte_gap")} ms, P95=${m(base, "B", "first_byte_gap", "p95")} ms
- B 组 Step1：median=${m(step1, "B", "first_byte_gap")} ms, P95=${m(step1, "B", "first_byte_gap", "p95")} ms

## 判读建议
- 若 B 组 first_byte_gap median/P95 明显下降：说明“仅切到真静态服务”已带来网络侧收益。
- 若无明显下降或更差：优先排查 Nginx 吞吐/连接队列/磁盘与端口负载；再进入 Step2 真 CDN。

## 调试证据
- Nginx conf: \`/etc/nginx/conf.d/step1_spark_spz.conf\`
- Nginx logs: \`/tmp/step1_nginx_access.log\`, \`/tmp/step1_nginx_error.log\`
- 采集数据：\`${cfg.remoteMetricsPath}\`
`;
  await fs.writeFile(path.join(resultDir, "Step1_Nginx_实验报告_20260421.md"), report, "utf8");

  console.log("[6/6] 完成。输出目录:", resultDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
