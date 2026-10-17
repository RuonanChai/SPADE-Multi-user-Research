import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function parseArgs(argv) {
  const out = {
    server: "http://127.0.0.1:8090",
    page: "/examples/hello-world/index.html",
    traceDir: "scripts/traces/generated",
    durationMs: 120000,
    outputDir: "results/replay",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v || out.server;
    else if (k === "page") out.page = v || out.page;
    else if (k === "traceDir") out.traceDir = v || out.traceDir;
    else if (k === "durationMs") out.durationMs = Number.parseInt(v || "120000", 10);
    else if (k === "out") out.outputDir = v || out.outputDir;
  }
  return out;
}

function scenarioDefinitions() {
  return [
    { id: "single-user-baseline", workload: "lockstep", users: ["user0"] },
    { id: "4-user-lockstep", workload: "lockstep", users: ["user0", "user1", "user2", "user3"] },
    { id: "4-user-near-cohort", workload: "near-cohort", users: ["user0", "user1", "user2", "user3"] },
    { id: "4-user-divergent", workload: "divergent", users: ["user0", "user1", "user2", "user3"] },
  ];
}

async function runScenario(browser, config, scenario) {
  const contexts = [];
  const pages = [];
  const base = `${config.server}${config.page}`;
  for (const userId of scenario.users) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    const traceFile = `/scripts/traces/generated/${scenario.workload}/${userId}.json`;
    const url = new URL(base);
    url.searchParams.set("mode", "replay");
    url.searchParams.set("user_id", userId);
    url.searchParams.set("trace_id", `${scenario.workload}-${userId}`);
    url.searchParams.set("trace_url", traceFile);
    url.searchParams.set("start_offset_ms", "0");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await new Promise((resolve) => setTimeout(resolve, config.durationMs));

  const result = [];
  for (const page of pages) {
    const data = await page.evaluate(() => window.__clientTrace || null).catch(() => null);
    result.push(data);
  }

  await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  return result;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  await fs.mkdir(config.outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const scenario of scenarioDefinitions()) {
      console.log(`Running scenario: ${scenario.id}`);
      const run = await runScenario(browser, config, scenario);
      report.push({
        scenario: scenario.id,
        workload: scenario.workload,
        users: scenario.users,
        finished_at: new Date().toISOString(),
        clients: run,
      });
    }
  } finally {
    await browser.close();
  }
  const outFile = path.join(config.outputDir, "runner-report.json");
  await fs.writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
