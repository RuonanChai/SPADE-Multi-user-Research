import { normalizeLogicalPages } from "./LogicalPages";

export interface FetchRangeLogEntry {
  ts: string;
  t_ms: number;
  user_id: string;
  trace_id: string;
  run_id?: string;
  url: string;
  method: string;
  raw_range: string | null;
  logical_pages: string[];
  status?: number;
  ok?: boolean;
  duration_ms?: number;
  error?: string;
  cf_cache_status?: string | null;
  age?: string | null;
  cf_ray?: string | null;
  content_length?: string | null;
  content_range?: string | null;
  server_timing?: string | null;
}

export interface FetchRangeLoggerOptions {
  userId: string;
  traceId: string;
  runId?: string;
  endpoint?: string;
}

export class FetchRangeLogger {
  private readonly userId: string;
  private readonly traceId: string;
  private readonly endpoint?: string;
  private readonly runId?: string;
  private readonly logs: FetchRangeLogEntry[] = [];
  private readonly originalFetch: typeof fetch;
  private readonly t0: number;
  private installed = false;

  constructor(options: FetchRangeLoggerOptions) {
    this.userId = options.userId;
    this.traceId = options.traceId;
    this.runId = options.runId;
    this.endpoint = options.endpoint;
    this.originalFetch = window.fetch.bind(window);
    this.t0 = performance.now();
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const self = this;
    window.fetch = async function wrappedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("x-user-id", self.userId);
      headers.set("x-trace-id", self.traceId);
      if (self.runId) headers.set("x-run-id", self.runId);
      const requestWithTags = new Request(request, { headers });
      const rangeHeader = request.headers.get("range");
      const normalized = normalizeLogicalPages(request.url, rangeHeader);
      const started = performance.now();
      const base: FetchRangeLogEntry = {
        ts: new Date().toISOString(),
        t_ms: started - self.t0,
        user_id: self.userId,
        trace_id: self.traceId,
        run_id: self.runId,
        url: request.url,
        method: request.method || "GET",
        raw_range: rangeHeader,
        logical_pages: normalized.pages,
      };
      try {
        const response = await self.originalFetch(requestWithTags);
        const done = performance.now();
        self.push({
          ...base,
          status: response.status,
          ok: response.ok,
          duration_ms: done - started,
          cf_cache_status: response.headers.get("cf-cache-status"),
          age: response.headers.get("age"),
          cf_ray: response.headers.get("cf-ray"),
          content_length: response.headers.get("content-length"),
          content_range: response.headers.get("content-range"),
          server_timing: response.headers.get("server-timing"),
        });
        return response;
      } catch (error) {
        const done = performance.now();
        self.push({
          ...base,
          duration_ms: done - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }

  uninstall() {
    if (!this.installed) return;
    window.fetch = this.originalFetch;
    this.installed = false;
  }

  getLogs() {
    return [...this.logs];
  }

  toJsonl() {
    return this.logs.map((entry) => JSON.stringify(entry)).join("\n");
  }

  private push(entry: FetchRangeLogEntry) {
    this.logs.push(entry);
    if (!this.endpoint) return;
    const body = `${JSON.stringify(entry)}\n`;
    try {
      navigator.sendBeacon(this.endpoint, body);
    } catch (_error) {
      // keep best-effort logging non-blocking
    }
  }
}
