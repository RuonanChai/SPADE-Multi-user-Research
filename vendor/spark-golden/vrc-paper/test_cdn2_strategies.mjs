// Test CDN2 with different fetch strategies
import https from 'node:https';

const url = 'https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad';

// Strategy 1: Node native https.get (not undici)
function testNativeHttps() {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { Range: 'bytes=0-1023' }, timeout: 15000 }, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(data).length }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message, code: e.code }));
  });
}

// Strategy 2: fetch with HTTP/1.1 hint (no h2)
async function testFetchNoH2() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
      signal: controller.signal,
    });
    clearTimeout(t);
    const buf = await r.arrayBuffer();
    return { status: r.status, bytes: buf.byteLength };
  } catch (e) {
    clearTimeout(t);
    return { error: e.cause ? (e.cause.code || e.cause.message) : e.message };
  }
}

console.log('Testing native https.get...');
const r1 = await testNativeHttps();
console.log('native https:', JSON.stringify(r1));

console.log('Testing fetch (undici)...');
const r2 = await testFetchNoH2();
console.log('fetch:', JSON.stringify(r2));
