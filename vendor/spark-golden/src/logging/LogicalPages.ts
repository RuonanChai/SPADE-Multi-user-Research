export const PAGE_SIZE = 256 * 1024;

export interface LogicalPageRange {
  pageSize: number;
  pages: string[];
}

function parseRangeHeader(rawRange: string | null): { start: number; end: number } | null {
  if (!rawRange) return null;
  const match = /^bytes=(\d+)-(\d+)?$/i.exec(rawRange.trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  if (!Number.isFinite(start)) return null;
  const end = match[2] ? Number.parseInt(match[2], 10) : start;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

export function normalizeLogicalPages(url: string, rawRange: string | null): LogicalPageRange {
  const parsed = parseRangeHeader(rawRange);
  if (!parsed) {
    return { pageSize: PAGE_SIZE, pages: [] };
  }
  const startPage = Math.floor(parsed.start / PAGE_SIZE);
  const endPage = Math.floor(parsed.end / PAGE_SIZE);
  const pages: string[] = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(`${url}#${page}`);
  }
  return { pageSize: PAGE_SIZE, pages };
}
