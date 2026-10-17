// Test CDN2 with explicit proxy (127.0.0.1:10809 — Clash/V2Ray detected in system settings)
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const url = 'https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad';

// Test 1: direct (no proxy)
console.log('Test 1: direct fetch (no proxy)...');
const ac1 = new AbortController();
const t1 = setTimeout(() => ac1.abort(), 15000);
try {
  const r = await fetch(url, { method: 'HEAD', signal: ac1.signal });
  clearTimeout(t1);
  console.log(`  direct: status=${r.status} OK`);
} catch (e) {
  clearTimeout(t1);
  console.log(`  direct: FAIL ${e.cause?.code || e.message}`);
}

// Test 2: via proxy 127.0.0.1:10809
console.log('Test 2: via proxy 127.0.0.1:10809...');
try {
  const dispatcher = new ProxyAgent('http://127.0.0.1:10809');
  const ac2 = new AbortController();
  const t2 = setTimeout(() => ac2.abort(), 15000);
  const r2 = await undiciFetch(url, { method: 'HEAD', signal: ac2.signal, dispatcher });
  clearTimeout(t2);
  console.log(`  proxy: status=${r2.status} OK`);
} catch (e) {
  console.log(`  proxy: FAIL ${e.cause?.code || e.message || e.message}`);
}

// Test 3: set HTTPS_PROXY env and use global fetch
console.log('Test 3: global fetch with HTTPS_PROXY env...');
process.env.HTTPS_PROXY = 'http://127.0.0.1:10809';
process.env.https_proxy = 'http://127.0.0.1:10809';
const ac3 = new AbortController();
const t3 = setTimeout(() => ac3.abort(), 15000);
try {
  const r3 = await fetch(url, { method: 'HEAD', signal: ac3.signal });
  clearTimeout(t3);
  console.log(`  env proxy: status=${r3.status} OK`);
} catch (e) {
  clearTimeout(t3);
  console.log(`  env proxy: FAIL ${e.cause?.code || e.message}`);
}
