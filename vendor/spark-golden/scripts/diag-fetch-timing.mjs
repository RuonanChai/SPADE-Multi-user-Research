/**
 * Measure fetch vs fetch+arrayBuffer timing for local .rad (mimics SplatPager.fetchRange).
 *   node scripts/diag-fetch-timing.mjs [baseUrl]
 */
const base = process.argv[2] || "http://127.0.0.1:9200";
const url = `${base}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
const ranges = [
  { label: "64KB", start: 0, len: 65535 },
  { label: "1.7MB", start: 50400, len: 1807159 - 50400 },
];

async function oneRange({ label, start, len }) {
  const headers = { Range: `bytes=${start}-${start + len - 1}` };
  const t0 = performance.now();
  const res = await fetch(url, { headers });
  const tHeaders = performance.now();
  const buf = await res.arrayBuffer();
  const tDone = performance.now();
  return {
    label,
    status: res.status,
    bytes: buf.byteLength,
    toHeaders_ms: Math.round(tHeaders - t0),
    arrayBuffer_ms: Math.round(tDone - tHeaders),
    total_ms: Math.round(tDone - t0),
  };
}

async function main() {
  console.log("url:", url);
  for (const r of ranges) {
    const row = await oneRange({
      label: r.label,
      start: r.start,
      len: r.len,
    });
    console.log(row);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
