// Process-wide metrics (#805), in Prometheus text exposition, written by hand: no dependency.
// One registry per process, like a C program's static counters: tests that start several servers
// in one process read deltas. Every label value comes from a fixed set in code, never from a
// request (no emails, handles, ids or client-supplied tool names), so a series count is bounded.
// A scrape is O(1) in the fleet (vision P13): counters, fixed histograms and gauges a caller
// reads from O(1) getters; nothing here counts rows or walks sessions.
import { monitorEventLoopDelay } from "node:perf_hooks";
import pkg from "../../package.json" with { type: "json" };

// One per capacity refusal site; `count` the refusal where the request is turned away.
export const REFUSAL_KINDS = [
  "mcp_post", "mcp_listen", "mcp_legacy", "mcp_dormant", "mcp_exchange",
  "hosted_session", "hosted_child", "delivery_lease", "delivery_receipts", "resource_watch", "board_observer",
  "attachment_requests",
] as const;
export type RefusalKind = typeof REFUSAL_KINDS[number];

// Seconds. Tool calls are SQLite-bound and expected well under 100 ms (the #805 exit bar).
export const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// A guard, not a budget: tool names come from code, but a series past this goes to `other`.
const MAX_TOOL_SERIES = 64;

type Histogram = { buckets: number[]; sum: number; count: number };
const refusals = new Map<RefusalKind, number>(REFUSAL_KINDS.map(k => [k, 0]));
const tools = new Map<string, Histogram>();

export function countRefusal(kind: RefusalKind) { refusals.set(kind, refusals.get(kind)! + 1); }
export function refusalCount(kind: RefusalKind): number { return refusals.get(kind)!; }

export function observeTool(tool: string, seconds: number) {
  if (!tools.has(tool) && tools.size >= MAX_TOOL_SERIES) tool = "other";
  let h = tools.get(tool);
  if (!h) tools.set(tool, h = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 });
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) if (seconds <= LATENCY_BUCKETS[i]!) h.buckets[i]!++;
  h.sum += seconds; h.count++;
}

// Times `fn` into the tool histogram, success or throw.
export async function timeTool<T>(tool: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try { return await fn(); } finally { observeTool(tool, (performance.now() - start) / 1000); }
}

// Event-loop lag, in windows: each window's p50/p99/max of the loop's delay, then a reset. The
// scrape reports the last finished window, so it costs nothing and doesn't depend on the scraper's
// cadence. Shared by every server in the process: started and stopped by reference count; the
// first start's window holds until the last stop.
export type LagWindow = { p50: number; p99: number; max: number };
export const LAG_WINDOW_MS = 10_000;
let lag: { histogram: ReturnType<typeof monitorEventLoopDelay>; timer: ReturnType<typeof setInterval>; users: number } | undefined;
let lastLag: LagWindow | undefined;

export function startLagSampler(windowMs = LAG_WINDOW_MS): () => void {
  if (!lag) {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const timer = setInterval(() => {
      // Nanoseconds in, seconds out. A window with no tick (count 0) leaves the last one standing.
      if (histogram.count > 0) lastLag = { p50: histogram.percentile(50) / 1e9, p99: histogram.percentile(99) / 1e9, max: histogram.max / 1e9 };
      histogram.reset();
    }, windowMs);
    timer.unref?.();
    lag = { histogram, timer, users: 0 };
  }
  lag.users++;
  let stopped = false;
  return () => {
    if (stopped || !lag) return;
    stopped = true;
    if (--lag.users > 0) return;
    clearInterval(lag.timer); lag.histogram.disable(); lag = undefined; lastLag = undefined;
  };
}
// The last finished window: what the /healthz lag gate will read (#805, the PR after this one).
export function lagWindow(): LagWindow | undefined { return lastLag; }
export function lagSamplerUsers(): number { return lag?.users ?? 0; }

// Gauges the caller reads at scrape time from O(1) getters. Keys are metric-name suffixes.
export type Gauge = { help: string; values: { value: number; labels?: Record<string, string> }[] };
export type Gauges = Record<string, Gauge>;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelText = (labels: Record<string, string>) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};
const num = (v: number) => Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : v < 0 ? "-Inf" : "NaN";

export function render(gauges: Gauges = {}): string {
  const out: string[] = [];
  const family = (name: string, type: string, help: string) => { out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };

  family("grayboard_build_info", "gauge", "The running release; the value is always 1.");
  out.push(`grayboard_build_info${labelText({ version: pkg.version })} 1`);
  family("grayboard_process_resident_memory_bytes", "gauge", "Resident set size.");
  const mem = process.memoryUsage();
  out.push(`grayboard_process_resident_memory_bytes ${mem.rss}`);
  family("grayboard_process_heap_used_bytes", "gauge", "JavaScript heap in use.");
  out.push(`grayboard_process_heap_used_bytes ${mem.heapUsed}`);
  family("grayboard_process_uptime_seconds", "gauge", "Seconds since the process started.");
  out.push(`grayboard_process_uptime_seconds ${num(process.uptime())}`);

  const window = lastLag;
  if (window) {
    family("grayboard_event_loop_lag_seconds", "gauge", `Event-loop delay over the last ${LAG_WINDOW_MS / 1000} s window, by quantile.`);
    out.push(`grayboard_event_loop_lag_seconds{quantile="0.5"} ${num(window.p50)}`, `grayboard_event_loop_lag_seconds{quantile="0.99"} ${num(window.p99)}`, `grayboard_event_loop_lag_seconds{quantile="1"} ${num(window.max)}`);
  }

  family("grayboard_capacity_refusals_total", "counter", "Requests refused at a capacity limit, by limit.");
  for (const [kind, n] of refusals) out.push(`grayboard_capacity_refusals_total${labelText({ kind })} ${n}`);

  family("grayboard_tool_call_duration_seconds", "histogram", "Native hosted MCP tool-call latency, by tool, authorization and refusals included.");
  for (const [tool, h] of tools) {
    LATENCY_BUCKETS.forEach((le, i) => out.push(`grayboard_tool_call_duration_seconds_bucket${labelText({ tool, le: String(le) })} ${h.buckets[i]}`));
    out.push(`grayboard_tool_call_duration_seconds_bucket${labelText({ tool, le: "+Inf" })} ${h.count}`,
      `grayboard_tool_call_duration_seconds_sum${labelText({ tool })} ${num(h.sum)}`,
      `grayboard_tool_call_duration_seconds_count${labelText({ tool })} ${h.count}`);
  }

  for (const [suffix, g] of Object.entries(gauges)) {
    const name = `grayboard_${suffix}`;
    family(name, "gauge", g.help);
    for (const s of g.values) out.push(`${name}${labelText(s.labels ?? {})} ${num(s.value)}`);
  }
  return out.join("\n") + "\n";
}

// A listener of its own, so exposure is a bind address, not a request check: behind Caddy every
// proxied request on the main port arrives from loopback, so "loopback only" there would admit the world.
export function serveMetrics(addr: { hostname: string; port: number }, gauges: () => Gauges) {
  return Bun.serve({
    hostname: addr.hostname,
    port: addr.port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/metrics") return new Response("not found\n", { status: 404 });
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
      return new Response(render(gauges()), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    },
    error(e) {
      console.error(`[grayboard] metrics failed: ${e.stack ?? e.message}`);
      return new Response("internal error\n", { status: 500 });
    },
  });
}
