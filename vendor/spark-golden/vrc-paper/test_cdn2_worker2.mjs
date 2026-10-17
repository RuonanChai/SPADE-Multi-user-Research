// Test CDN2 from Worker2 via SSH
import { spawnSync } from 'node:child_process';
const sshKey = 'C:/Users/IoT/.ssh/id_ed25519_spark_bench';
const login = 'Ruonan@10.4.146.68';
const cmd = 'powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri \\"https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad\\" -Method Head -TimeoutSec 15 -UseBasicParsing; Write-Host \\"status=$($r.StatusCode)\\" } catch { Write-Host \\"ERR: $($_.Exception.Message)\\" }"';
const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-p', '22', '-i', sshKey, login, cmd], {
  encoding: 'utf8', timeout: 30000
});
console.log('Worker2 CDN2 test:');
console.log(r.stdout?.trim() || '(no stdout)');
if (r.stderr?.trim()) console.log('stderr:', r.stderr.trim());
console.log('exit:', r.status);
