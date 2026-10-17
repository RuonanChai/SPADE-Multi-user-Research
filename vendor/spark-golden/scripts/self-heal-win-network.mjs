/**
 * 在 Windows 上把「有 192.168.x 地址的默认网卡」跃点调低、其余有网关的网卡调大，
 * 减少走 10.x 等多网卡时到 Worker2(同网段) 选错出口的问题。无需本机再手动点设置。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function selfHealWindowsRoutePriority() {
  if (process.env.BENCH_NO_SELF_HEAL === "1") {
    return;
  }
  if (process.platform !== "win32") {
    return;
  }
  const ps = `
$ErrorActionPreference = "Continue"
Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object {
  $ip = $_.IPv4Address.IPAddress
  if (-not $ip) { return }
  $idx = $_.InterfaceIndex
  if ($ip -match "^192\\.168\\.") { Set-NetIPInterface -InterfaceIndex $idx -InterfaceMetric 1 -ErrorAction SilentlyContinue }
  else { Set-NetIPInterface -InterfaceIndex $idx -InterfaceMetric 100 -ErrorAction SilentlyContinue }
}
Write-Output "self-heal-ok"`;
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { maxBuffer: 2 * 1024 * 1024, windowsHide: true, timeout: 120000 },
    );
    const o = (stdout + stderr).trim();
    if (o) {
      console.log("[self-heal:win]", o);
    }
  } catch (e) {
    console.warn("[self-heal:win] 可忽略(部分环境需提升权限):", e?.message ?? e);
  }
}
