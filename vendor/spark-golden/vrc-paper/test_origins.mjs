// Test all three origins
const origins = [
  { name: 'HPC', url: 'http://10.120.17.176:8090/examples/streaming-lod/coit-40m-sh1-lod.rad' },
  { name: 'CDN1', url: 'https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev/streaming-lod/coit-40m-sh1-lod.rad' },
  { name: 'CDN2', url: 'https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad' },
];

for (const { name, url } of origins) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-1023' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`${name}: status=${r.status} content-length=${r.headers.get('content-length')} OK`);
  } catch (e) {
    clearTimeout(timeout);
    console.log(`${name}: FAIL ${e.cause ? e.cause.code || e.cause.message || e.cause : e.message}`);
  }
}
