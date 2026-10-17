export const PAGE_SIZE = 256 * 1024;
export const SCENE_EXT = /\.(spz|ksplat|splat|rad|ply)(\?|$)/i;
export const RANGE_RE = /bytes=\d+/i;

export function getHeader(headers, name) {
  if (!headers) return null;
  const n = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h?.name && h.name.toLowerCase() === n) return h.value ?? null;
    }
    return null;
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === n) return headers[k];
  }
  return null;
}

export function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const o = {};
    for (const h of headers) {
      if (h?.name) o[h.name] = h.value ?? "";
    }
    return o;
  }
  return { ...headers };
}

export function extractRangeFromRequest(req) {
  const h = req?.headers;
  if (!h) return null;
  const v = getHeader(h, "Range") || getHeader(h, "range");
  return v && String(v).trim() ? String(v) : null;
}

export function extractContentRangeLength(respHeaders) {
  if (!respHeaders) return { contentRange: null, contentLength: null };
  const cr = getHeader(respHeaders, "content-range");
  const cl = getHeader(respHeaders, "content-length");
  return { contentRange: cr ? String(cr) : null, contentLength: cl ? String(cl) : null };
}
