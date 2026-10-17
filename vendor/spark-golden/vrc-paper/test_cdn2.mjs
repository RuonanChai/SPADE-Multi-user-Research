// Test CDN2 GCS reachability
const url = 'https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20000);
try {
  const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
  clearTimeout(timeout);
  console.log('status=' + r.status);
  console.log('headers: content-length=' + r.headers.get('content-length') + ' accept-ranges=' + r.headers.get('accept-ranges'));
} catch (e) {
  clearTimeout(timeout);
  console.log('ERR: ' + e.message);
  process.exit(1);
}
