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

// Test seam (#1515): drops the series whose names start with `prefix`. The registry is process-wide, so a test
// that fills the series guard frees it again, or every later file in the process folds its new tools into `other`.
export function forgetToolSeries(prefix: string) { for (const t of [...tools.keys()]) if (t.startsWith(prefix)) tools.delete(t); }

// Times `fn` into the tool histogram, success or throw.
export async function timeTool<T>(tool: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try { return await fn(); } finally { observeTool(tool, (performance.now() - start) / 1000); }
}

// The write queue (store/queue.ts, docs/future/postgres-server.md D4), process-wide across every queue in the process.
// A body's wait runs from run() to its start, its hold from its start to its release (a synchronous body's return or
// throw, an async body's settling). Seconds, from SQLite's ~20 µs bodies to a stalled Postgres commit.
export const QUEUE_BUCKETS = [0.00002, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
// Waiters ahead of a body that queues (an idle queue's body isn't counted: it never waits).
export const QUEUE_DEPTH_BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
// Who queued a body: a literal its caller sets (store/queue.ts `atSite`), never a request's value or a stack frame.
// The hot callers have their own, and so does every other server writer (#1537 PR 6): the hosted timer's sweep, full
// reconcile and heartbeat; a refusal's rows written after its rollback; mcp.ts's lapsed-lease settle; owning bodies
// (bind, unbind, delivery open); register; session ends and releases; a tool's lost-hold take; the claim expiry
// sweep; a lost-visibility push ack; alias rechecks and ends; the Slack bridge's human; startup and shutdown;
// retention; uploads; the HTTP API (`admin`); OAuth; Slack; the IdP recheck; the CLI session touch; limiter rows. A
// body queued with none (core's queuedTx, tests) is `other`.
export const QUEUE_SITES = ["gate", "prior", "tool", "renew", "receipt", "touch", "audit", "sweep", "reconcile", "heartbeat", "refusal", "settle", "owning", "register", "end", "lost",
  "claims", "boards", "alias", "human", "startup", "retention", "attachments", "admin", "oauth", "slack", "idp", "session", "limiter", "other"] as const;
export type QueueSite = typeof QUEUE_SITES[number];

// Per-bucket counts, not cumulative (the last slot is +Inf): an observation is one increment; the scrape sums them.
type Bins = { counts: number[]; sum: number; count: number };
const bins = (edges: readonly number[]): Bins => ({ counts: new Array<number>(edges.length + 1).fill(0), sum: 0, count: 0 });
function bin(b: Bins, edges: readonly number[], v: number) {
  let i = 0;
  while (i < edges.length && v > edges[i]!) i++;
  b.counts[i]!++; b.sum += v; b.count++;
}
const queueWait = new Map<QueueSite, Bins>(QUEUE_SITES.map(s => [s, bins(QUEUE_BUCKETS)]));
const queueHold = new Map<QueueSite, Bins>(QUEUE_SITES.map(s => [s, bins(QUEUE_BUCKETS)]));
const queueDepth = bins(QUEUE_DEPTH_BUCKETS);
const queueKeyed = new Map<QueueSite, number>(QUEUE_SITES.map(s => [s, 0]));
let queueWaiters = 0, queueRunning = 0, queueWorldStopS = 0;

// A body queued behind `ahead` others.
export function queueWaiting(ahead: number) { queueWaiters++; bin(queueDepth, QUEUE_DEPTH_BUCKETS, ahead); }
// A body started.
export function queueStarted() { queueRunning++; }
// A body released: `waited` when it had queued (queueWaiting counted it), `keyed` when it ran keyed (runKeyed), its wait
// and hold in seconds.
export function queueBody(site: QueueSite, waited: boolean, keyed: boolean, waitS: number, holdS: number) {
  queueRunning--;
  if (waited) queueWaiters--;
  if (keyed) queueKeyed.set(site, queueKeyed.get(site)! + 1);
  bin(queueWait.get(site)!, QUEUE_BUCKETS, waitS);
  bin(queueHold.get(site)!, QUEUE_BUCKETS, holdS);
}
// A body the scheduler skipped because its request aborted before it started (#1535, store/queue.ts abandonable):
// `waited` when it had queued (queueWaiting counted it), false when its signal had already fired at run().
const queueSkips = new Map<QueueSite, number>(QUEUE_SITES.map(s => [s, 0]));
export function queueSkipped(site: QueueSite, waited: boolean) {
  if (waited) queueWaiters--;
  queueSkips.set(site, queueSkips.get(site)! + 1);
}
export function queueSkippedCount(site: QueueSite): number { return queueSkips.get(site)!; }
// Bodies waiting now, across every queue in the process.
export function queueWaitersNow(): number { return queueWaiters; }
// A span in which an exclusive body waited or ran (store/queue.ts): every keyed body arriving meanwhile waits behind it,
// so this is the scheduler's world-stop time, an exclusive body's drain of the keyed bodies ahead of it plus its hold.
export function queueWorldStop(seconds: number) { queueWorldStopS += seconds; }

// Postgres statements per write body (#1537 PR 0, store/pg/tx.ts), by calling site: every statement the body's
// transaction sent, BEGIN and its COMMIT or ROLLBACK and the auth-mark read included; and its round trips, the flights
// among them: a statement sent while none of the body's statements is in flight starts one, and one sent behind an
// un-awaited statement (a SAVEPOINT, an in-body audit) rides its flight. SQLite bodies record nothing.
export const STATEMENT_BUCKETS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100];
const queueStatements = new Map<QueueSite, Bins>(QUEUE_SITES.map(s => [s, bins(STATEMENT_BUCKETS)]));
const queueRoundTrips = new Map<QueueSite, Bins>(QUEUE_SITES.map(s => [s, bins(STATEMENT_BUCKETS)]));
export function queueStatementsBody(site: QueueSite, statements: number, roundTrips: number) {
  bin(queueStatements.get(site)!, STATEMENT_BUCKETS, statements);
  bin(queueRoundTrips.get(site)!, STATEMENT_BUCKETS, roundTrips);
}
// One site's totals so far: bodies recorded, statements and round trips summed over them.
export function statementTotals(site: QueueSite): { bodies: number; statements: number; roundTrips: number } {
  const s = queueStatements.get(site)!, r = queueRoundTrips.get(site)!;
  return { bodies: s.count, statements: s.sum, roundTrips: r.sum };
}

// The hosted gate's keyed fast path (#1510 chunk 3, hosted.ts withGate/withPrior): per site, a request whose body ran
// keyed (`keyed`), one whose keyed attempt missed and ran the exclusive body after it (`miss`), and one that ran
// exclusive without an attempt (`skipped`: SQLite, no row yet, a parked row, a prior that differed outright). Delivery's
// renew and receipt the same (#1510 chunk 4, delivery.ts): `skipped` there is SQLite, or the keyed path turned off.
// `method`: the call the gate body served (#1537 PR 0): for the `gate` site the hosted call that ran withGate (an
// exchange's `selection`, a tool call's own `tool` gate, `control`'s renew, receipt, pending and release, `owning`'s
// open, bind and unbind, and the rest by name); for the `prior` site the call that reused its exchange's verdict in
// place of that gate body (withPrior: a native tool call's `tool`, and since #1537 C5/C7 the subscriber's renew,
// receipt, pending, open and bind); renew and receipt have one each, their own. The `tool` site is a keyed tool body
// (#1537 PR 5 hosted.ts dmSend, PR 6 boardPost), its method the tool (dm_send, board_post): `skipped` there is SQLite,
// the keyed path turned off, or a call whose plan says exclusive (application.sendPlan, postPlan). The read tools'
// keyed bodies count there too (#1604 hosted.ts KEYED_READS: `miss` a probe that would have written or refused), and
// every other tool's exclusive body as `skipped` under its own name (`other` for a name outside TOOL_METHODS), so no
// tool body runs exclusive uncounted and a loadtest names which tools still take the world lock.
export const GATE_SITES = ["gate", "prior", "renew", "receipt", "tool"] as const;
export const GATE_OUTCOMES = ["keyed", "miss", "skipped"] as const;
export const GATE_METHODS = ["selection", "tool", "transfer", "whoami", "end", "open", "bind", "unbind", "owning", "renew", "receipt", "pending", "release", "control", "dm_send", "board_post", "peer_list", "board_list", "claim_list", "dm_history", "board_create", "board_archive", "board_read", "board_subscribe", "peer_status", "claim_take", "claim_release", "claim_watch", "delegate", "dm_thread", "dm_inbox", "dm_ack", "dm_retract", "other"] as const;
export type GateSite = typeof GATE_SITES[number];
export type GateOutcome = typeof GATE_OUTCOMES[number];
export type GateMethod = typeof GATE_METHODS[number];
export const PRIOR_METHODS = ["tool", "renew", "receipt", "pending", "open", "bind"] as const satisfies readonly GateMethod[];
const SITE_METHOD: Record<"renew" | "receipt", GateMethod> = { renew: "renew", receipt: "receipt" };
// The native tools that run a tool body (hosted.ts runTool; whoami, bind and unbind have their own sites), and `other`
// for any name outside them.
export const TOOL_METHODS = ["dm_send", "board_post", "peer_list", "board_list", "claim_list", "dm_history", "board_create", "board_archive", "board_read", "board_subscribe", "peer_status", "claim_take", "claim_release", "claim_watch", "delegate", "dm_thread", "dm_inbox", "dm_ack", "dm_retract", "other"] as const satisfies readonly GateMethod[];
const gateKey = (site: GateSite, method: GateMethod, outcome: GateOutcome) => `${site}:${method}:${outcome}`;
// Every series present from the start, so a rate() over a fresh process starts at zero.
const gateFast = new Map<string, number>([
  ...GATE_METHODS.flatMap(m => GATE_OUTCOMES.map(o => [gateKey("gate", m, o), 0] as const)),
  ...PRIOR_METHODS.flatMap(m => GATE_OUTCOMES.map(o => [gateKey("prior", m, o), 0] as const)),
  ...(Object.entries(SITE_METHOD) as [GateSite, GateMethod][]).flatMap(([s, m]) => GATE_OUTCOMES.map(o => [gateKey(s, m, o), 0] as const)),
  ...TOOL_METHODS.flatMap(m => GATE_OUTCOMES.map(o => [gateKey("tool", m, o), 0] as const)),
]);
export function countGate(site: GateSite, outcome: GateOutcome, method: GateMethod = "tool") {
  const k = gateKey(site, site === "renew" || site === "receipt" ? SITE_METHOD[site] : method, outcome);
  gateFast.set(k, (gateFast.get(k) ?? 0) + 1);
}
// One site's count for `outcome`, of one method or (none given) summed over them.
export function gateCount(site: GateSite, outcome: GateOutcome, method?: GateMethod): number {
  let n = 0;
  for (const [k, v] of gateFast) { const [s, m, o] = k.split(":"); if (s === site && o === outcome && (method === undefined || m === method)) n += v; }
  return n;
}

// Event-loop lag, in windows: each window's p50/p99/max of the loop's delay, then a reset. The
// scrape reports the last finished window, so it costs nothing and doesn't depend on the scraper's
// cadence. Shared by every server in the process: started and stopped by reference count; the
// first start's window holds until the last stop.
export type LagWindow = { p50: number; p99: number; max: number };
export const LAG_WINDOW_MS = 10_000;
let lag: { histogram: ReturnType<typeof monitorEventLoopDelay>; timer: ReturnType<typeof setInterval>; users: number; windowMs: number; rotated: number } | undefined;
let lastLag: LagWindow | undefined;
// The newest finished windows, oldest first, for the /healthz lag gate; at most LAG_HISTORY of them.
export const LAG_HISTORY = 60;
let lagHistory: LagWindow[] = [];

export function startLagSampler(windowMs = LAG_WINDOW_MS): () => void {
  if (!lag) {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const timer = setInterval(() => {
      if (lag) lag.rotated = performance.now();
      // Nanoseconds in, seconds out. A window with no tick (count 0) leaves the last one standing.
      if (histogram.count > 0) {
        lastLag = { p50: histogram.percentile(50) / 1e9, p99: histogram.percentile(99) / 1e9, max: histogram.max / 1e9 };
        lagHistory.push(lastLag);
        if (lagHistory.length > LAG_HISTORY) lagHistory.shift();
      }
      histogram.reset();
    }, windowMs);
    timer.unref?.();
    lag = { histogram, timer, users: 0, windowMs, rotated: performance.now() };
  }
  lag.users++;
  let stopped = false;
  return () => {
    if (stopped || !lag) return;
    stopped = true;
    if (--lag.users > 0) return;
    clearInterval(lag.timer); lag.histogram.disable(); lag = undefined; lastLag = undefined; lagHistory = [];
  };
}
// The last finished window, for the scrape.
export function lagWindow(): LagWindow | undefined { return lastLag; }
export function lagWindows(): readonly LagWindow[] { return lagHistory; }
// How long since the sampler last finished a window (its rotation is a timer). Under CPU saturation with more than
// 1024 ready sockets, Bun's socket loop runs up to 48 full epoll batches per tick before any timer (#941): the
// windows freeze for tens of seconds while requests, /healthz and the scrape among them, are still answered. This
// age, read at request time, is what shows that stall; the finished windows can't.
export type LagSampler = { ageMs: number; windowMs: number };
export function lagSampler(now = performance.now()): LagSampler | undefined { return lag ? { ageMs: now - lag.rotated, windowMs: lag.windowMs } : undefined; }

// The /healthz lag gate (#805): lagging when each of the last `windows` finished windows has a p99
// over `p99Ms`. On the p99 rule the window history is its clock: a server with fewer finished windows than that
// never fails it, so a restart passes install.sh's /healthz check, and one slow window (a GC pause, a churn wave)
// never fails it. p99Ms 0 turns the gate off, both rules. With `sampler`, a sampler that has finished no window for
// `windows` windows' time, plus a tenth of a window for timer jitter at a due window, is lagging too, however few
// windows it has (#941): the loop hasn't reached its timers for that long, so every window it would have finished
// had a delay far over any threshold. At the defaults that's 31 s, under the 35-46 s stalls #941 measured.
export type LagGate = { p99Ms: number; windows: number };
export const DEFAULT_LAG_GATE: LagGate = { p99Ms: 1000, windows: 3 };
export function lagVerdict(history: readonly LagWindow[], gate: LagGate, sampler?: LagSampler | null): { lagging: false } | { lagging: true; p99s: number[]; stalledS?: number } {
  if (gate.p99Ms === 0 || gate.windows < 1) return { lagging: false };
  if (sampler && sampler.ageMs >= (gate.windows + 0.1) * sampler.windowMs) return { lagging: true, p99s: history.slice(-gate.windows).map(w => w.p99), stalledS: sampler.ageMs / 1000 };
  if (history.length < gate.windows) return { lagging: false };
  const recent = history.slice(-gate.windows);
  if (!recent.every(w => w.p99 * 1000 > gate.p99Ms)) return { lagging: false };
  return { lagging: true, p99s: recent.map(w => w.p99) };
}
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

function histogram(out: string[], name: string, labels: Record<string, string>, edges: readonly number[], b: Bins) {
  let cum = 0;
  edges.forEach((le, i) => { cum += b.counts[i]!; out.push(`${name}_bucket${labelText({ ...labels, le: String(le) })} ${cum}`); });
  out.push(`${name}_bucket${labelText({ ...labels, le: "+Inf" })} ${b.count}`, `${name}_sum${labelText(labels)} ${num(b.sum)}`, `${name}_count${labelText(labels)} ${b.count}`);
}

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
  const sampler = lagSampler();
  if (sampler) {
    family("grayboard_event_loop_lag_window_age_seconds", "gauge", `Seconds since the last lag window finished (one is due every ${sampler.windowMs / 1000} s); more means the event loop hasn't run its timers for that long.`);
    out.push(`grayboard_event_loop_lag_window_age_seconds ${num(sampler.ageMs / 1000)}`);
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

  family("grayboard_write_queue_wait_seconds", "histogram", "Write-queue wait, from run() to the body's start, by calling site.");
  for (const [site, b] of queueWait) if (b.count) histogram(out, "grayboard_write_queue_wait_seconds", { site }, QUEUE_BUCKETS, b);
  family("grayboard_write_queue_hold_seconds", "histogram", "Write-queue hold, from a body's start to its release, by calling site.");
  for (const [site, b] of queueHold) if (b.count) histogram(out, "grayboard_write_queue_hold_seconds", { site }, QUEUE_BUCKETS, b);
  family("grayboard_write_queue_bodies_total", "counter", "Write-queue bodies released, by calling site.");
  for (const [site, b] of queueHold) out.push(`grayboard_write_queue_bodies_total${labelText({ site })} ${b.count}`);
  family("grayboard_write_queue_skipped_bodies_total", "counter", "Write-queue bodies skipped, never run, because the request that queued them aborted before they started, by calling site.");
  for (const [site, n] of queueSkips) out.push(`grayboard_write_queue_skipped_bodies_total${labelText({ site })} ${n}`);
  family("grayboard_write_queue_keyed_bodies_total", "counter", "Write-queue bodies released that ran keyed (overlapping other keyed bodies), by calling site; the rest ran exclusive.");
  for (const [site, n] of queueKeyed) out.push(`grayboard_write_queue_keyed_bodies_total${labelText({ site })} ${n}`);
  family("grayboard_hosted_gate_bodies_total", "counter", "Hosted gate and delivery requests by site, the call the gate (or, for prior, the reused selection verdict) served (method), and how the write body ran: keyed (the fast path), miss (a keyed attempt, then the exclusive body), skipped (exclusive without an attempt).");
  for (const [k, n] of gateFast) { const [site, method, outcome] = k.split(":"); out.push(`grayboard_hosted_gate_bodies_total${labelText({ site: site!, method: method!, outcome: outcome! })} ${n}`); }
  family("grayboard_write_queue_statements", "histogram", "Postgres statements per write body (BEGIN, COMMIT or ROLLBACK and the auth-mark read included), by calling site; SQLite bodies record none.");
  for (const [site, b] of queueStatements) if (b.count) histogram(out, "grayboard_write_queue_statements", { site }, STATEMENT_BUCKETS, b);
  family("grayboard_write_queue_round_trips", "histogram", "Postgres round trips per write body, by calling site: its statements less those sent while another of its statements was in flight.");
  for (const [site, b] of queueRoundTrips) if (b.count) histogram(out, "grayboard_write_queue_round_trips", { site }, STATEMENT_BUCKETS, b);
  family("grayboard_write_queue_world_stop_seconds_total", "counter", "Seconds in which an exclusive write-queue body waited or ran, so keyed bodies arriving meanwhile waited behind it: its drain of the keyed bodies ahead of it plus its hold.");
  out.push(`grayboard_write_queue_world_stop_seconds_total ${num(queueWorldStopS)}`);
  family("grayboard_write_queue_depth", "histogram", "Bodies already waiting when a body queues behind a held write queue.");
  histogram(out, "grayboard_write_queue_depth", {}, QUEUE_DEPTH_BUCKETS, queueDepth);
  family("grayboard_write_queue_waiters", "gauge", "Bodies waiting for the write queue now.");
  out.push(`grayboard_write_queue_waiters ${queueWaiters}`);
  family("grayboard_write_queue_running", "gauge", "Bodies running now; above 1 only while keyed bodies overlap.");
  out.push(`grayboard_write_queue_running ${queueRunning}`);

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
