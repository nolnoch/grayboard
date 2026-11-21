#!/usr/bin/env bun
// The hosted load test (#805): N leased hosted sessions against one server process, driven by K
// driver processes (scripts/loadtest_driver.ts), with the server's /metrics scraped every window.
//
//   bun scripts/loadtest.ts                 # the exit bar: 1,000 sessions for an hour
//   bun scripts/loadtest.ts --quick         # a minute's smoke at 40 sessions
//   bun scripts/loadtest.ts --sessions 500 --duration 900 --period 20
//   bun scripts/loadtest.ts --pg postgres://u:p@host:5432/postgres   # the server on Postgres (#807)
//   bun scripts/loadtest.ts --pg postgres://… --pg-latency 1          # …with 1 ms added each way (#1510)
//
// --pg names a cluster: the run creates an empty database there (gb_loadtest_<time>), the server migrates it at
// startup, and the run drops it at the end unless --keep-db. --pg-latency <ms> puts a delay proxy
// (tests/support/delay_proxy.ts) between the server and the cluster, adding that many ms to each direction's data, so
// every round trip grows by twice it; the run's own seeding and counting connections go direct.
//
// Each window also reports the server's write queue (grayboard_write_queue_*, #1510): bodies/s, busy (the share of the
// window some body held a queue), wait and hold p50/p99 (interpolated within histogram buckets, as Prometheus's
// histogram_quantile does), the deepest queue a body met, and the same per calling site; summary.json has them over the
// steady period.
//
// Exit bar (#805): every session leased throughout; each steady window's native tool calls at
// p99 < 100 ms (at least 99% at or under the 0.1 s bucket edge: no interpolation); RSS flat over
// the steady period (the duration less its warm-up: an hour in the full profile); zero refusals,
// zero client errors, zero DM loss or misdelivery; and every gauge back to zero once the fleet has
// closed. A gate whose metric is missing fails rather than passes. The run writes windows.jsonl,
// server.log, drivers' stderr and summary.json to its run dir (.e2e-runs/loadtest-<time>/ unless
// --out), exits 1 on any miss and 2 when the run itself broke.
//
// Service traffic (#1258), in every profile unless --service-workers 0: the last W sessions are a service's workers
// (service loadsvc, one run token minted by client credentials as a launcher mints it), the lanes of its queue board
// load-svc; every user holds service_invoke through a team (T teams, user u in team u % T). A user's op invokes the
// service (a post on load-svc: service.invoke and queueLanes) at --svc-share, or lists peers (alias.see_service per
// service scope) at --peer-share; the lane replies under each invocation, which wakes the invoker. Those calls are
// native tool calls, so the latency gates cover them, and the client reports them as their own ops (svc_invoke,
// svc_reply, peer_list); every invocation must come back as a reply its invoker read. At --read-share a user's op reads
// the service's board through R5's other canSee sites (#1511), in turn: board_list, board_read (a thread of its own
// answered invocations), the snapshot (resources/read) and the catalog (resources/list, also read by every session as
// it connects, timed and proved as catalog_connect, its latency not gated).
// Each is its own op, and each result must show the board (every board_read thread its invocation and reply, some
// snapshot a post), or the run fails.
//
// The server runs with GRAYBOARD_DEV_AUTH=1 (tests/support/server.ts) on every interface, for as
// long as the run: anyone who can reach this host's port can sign in to the scratch database.
// Run it on a machine whose ports aren't reachable from untrusted networks.
//
// The caps the default config ships with are below this fleet (256 leases, 128 listens): the run
// raises only what N forces and prints the effective env, which is part of the result.
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { DEFAULT_HOSTED_CAPS, DEFAULT_MCP_LIMITS } from "../src/server/config.ts";
import { DEFAULT_HOSTED_REQUEST_LIMIT, DEFAULT_HOSTED_SUBSCRIBER_LIMIT, type RateLimit } from "../src/server/rate_limit.ts";
import { openDatabase, type Repo } from "../src/server/db.ts";
import { makePgRepo } from "../src/server/pg_repo.ts";
import { openPg } from "../src/server/store/pg/sql.ts";
import { sessionEndPort } from "../src/server/session_end.ts";
import { DEFAULT_SERVICE_TOKEN_LIMITS, OAUTH_TTL, SERVICE_TOKEN_MIN_SECONDS } from "../src/server/oauth-types.ts";
import { issueOAuth } from "../tests/helpers/oauth.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES } from "../tests/support/hosted_session.ts";
import { devLogin, ServerProcess } from "../tests/support/server.ts";
import { startDelayProxy, type DelayProxy } from "../tests/support/delay_proxy.ts";
import { BUCKETS, PROOF_OPS, SVC_READS, type DriverConfig, type DriverFinal, type DriverSession, type DriverWindow, type Hist, type ReadProof } from "./loadtest_driver.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Options = {
  sessions: number; users: number; drivers: number; durationS: number; warmupS: number; periodS: number;
  boards: number; postShare: number; burst: number; churn: number; churnEveryS: number; windowS: number;
  graceS: number; server: string[]; out: string; keepDb: boolean; rssGate: boolean; env: Record<string, string>;
  // The service's workers (of `sessions`), the teams its invokers hold service_invoke through, and the shares of a
  // user's ops that invoke it and list peers.
  serviceWorkers: number; teams: number; svcShare: number; peerShare: number;
  // The share of a user's ops that read the service's board.
  readShare: number;
  // A Postgres cluster URL; absent runs the server on a SQLite file.
  pg?: string;
  // Milliseconds added to each direction between the server and Postgres (a delay proxy); absent, none.
  pgLatencyMs?: number;
};

export function options(argv: string[]): Options {
  const { values: v } = parseArgs({
    args: argv, strict: true, options: {
      quick: { type: "boolean" }, sessions: { type: "string" }, users: { type: "string" }, drivers: { type: "string" },
      duration: { type: "string" }, warmup: { type: "string" }, period: { type: "string" }, boards: { type: "string" },
      "post-share": { type: "string" }, burst: { type: "string" }, churn: { type: "string" }, "churn-every": { type: "string" },
      "service-workers": { type: "string" }, teams: { type: "string" }, "svc-share": { type: "string" }, "peer-share": { type: "string" }, "read-share": { type: "string" },
      window: { type: "string" }, grace: { type: "string" }, server: { type: "string" }, out: { type: "string" }, "keep-db": { type: "boolean" }, pg: { type: "string" }, "pg-latency": { type: "string" },
      // Server env overrides, KEY=VALUE, applied after the caps the run computes.
      env: { type: "string", multiple: true },
    },
  });
  const quick = v.quick === true;
  const n = (name: keyof typeof v, full: number, small: number) => {
    const raw = v[name];
    if (raw === undefined) return quick ? small : full;
    const x = Number(raw);
    if (!Number.isFinite(x) || x < 0) throw new Error(`--${name} must be a non-negative number, not "${raw}"`);
    return x;
  };
  // The full profile's steady period is the bar's hour, after its 10 min warm-up.
  const durationS = n("duration", 4200, 40);
  const o: Options = {
    sessions: n("sessions", 1000, 40), users: n("users", 100, 4), drivers: n("drivers", 8, 2),
    durationS, warmupS: n("warmup", 600, 15), periodS: n("period", 30, 3), boards: n("boards", 20, 2),
    postShare: n("post-share", 0.05, 0.2), burst: n("burst", 100, 20), churn: n("churn", 0.1, 0.25),
    churnEveryS: n("churn-every", 900, 20), windowS: n("window", 10, 5), graceS: n("grace", 15, 5),
    // Unset, the workers shrink to what a small fleet leaves after its users' sessions (defaultWorkers).
    serviceWorkers: v["service-workers"] === undefined ? defaultWorkers(n("service-workers", 4, 2), n("sessions", 1000, 40), n("users", 100, 4)) : n("service-workers", 4, 2), teams: v.teams === undefined ? Math.min(n("teams", 10, 2), Math.max(1, n("users", 100, 4))) : n("teams", 10, 2), svcShare: n("svc-share", 0.05, 0.2), peerShare: n("peer-share", 0.02, 0.1), readShare: n("read-share", 0.02, 0.1),
    server: v.server ? [resolve(v.server)] : [process.execPath, join(ROOT, "src/server/main.ts")],
    out: v.out ? resolve(v.out) : join(ROOT, ".e2e-runs", `loadtest-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    keepDb: v["keep-db"] === true,
    ...(v.pg ? { pg: v.pg } : {}),
    ...(v["pg-latency"] !== undefined ? { pgLatencyMs: n("pg-latency", 0, 0) } : {}),
    env: Object.fromEntries((v.env ?? []).map((kv) => {
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`--env takes KEY=VALUE, not "${kv}"`);
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    })),
    // RSS flatness means nothing over a minute.
    rssGate: durationS - n("warmup", 600, 15) >= 1200,
  };
  if (o.sessions < 2 || o.users < 1 || o.drivers < 1 || o.users > o.sessions || o.drivers > o.sessions) throw new Error("need sessions ≥ 2, 1 ≤ users ≤ sessions, 1 ≤ drivers ≤ sessions");
  if (o.warmupS >= o.durationS) throw new Error("--warmup must be shorter than --duration");
  if (!Number.isInteger(o.serviceWorkers) || userSessions(o) < Math.max(2, o.users)) throw new Error("--service-workers must be a whole number that leaves at least 2 sessions, and one per user, to the users");
  if (o.serviceWorkers && (!Number.isInteger(o.teams) || o.teams < 1 || o.teams > o.users)) throw new Error("--teams must be a whole number from 1 to --users");
  if (o.postShare + (o.serviceWorkers ? o.svcShare + o.peerShare + o.readShare : 0) > 1) throw new Error("--post-share, --svc-share, --peer-share and --read-share must sum to at most 1");
  if (o.pgLatencyMs !== undefined && !o.pg) throw new Error("--pg-latency needs --pg");
  return o;
}

// Unset, the workers shrink to what a small fleet leaves after its users' sessions; a fleet that leaves none is
// refused rather than run without the service: only an explicit --service-workers 0 turns it off.
function defaultWorkers(want: number, sessions: number, users: number): number {
  const room = sessions - Math.max(2, users);
  // A fleet the sessions/users check refuses anyway gets that error, not this one.
  if (users > sessions || sessions < 2) return 0;
  if (room < 1) throw new Error(`${sessions} sessions leave no room for a service worker after ${users} users' sessions: raise --sessions, or pass --service-workers 0 to run without the service`);
  return Math.min(want, room);
}

// The sessions that are users' (the rest are the service's workers).
export const userSessions = (o: Options) => o.sessions - o.serviceWorkers;

// Prometheus text, one sample per line: `name{k="v",…} value`.
export type Sample = { name: string; labels: Record<string, string>; value: number };
export function parseMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c);
    out.push({ name: m[1]!, labels, value: m[3] === "+Inf" ? Infinity : Number(m[3]) });
  }
  return out;
}
const one = (s: Sample[], name: string, labels: Record<string, string> = {}) =>
  s.find(x => x.name === name && Object.entries(labels).every(([k, v]) => x.labels[k] === v))?.value;

// Per tool: cumulative count and count at or under 0.1 s.
type ToolCum = Map<string, { count: number; fast: number }>;
function toolCumulative(s: Sample[]): ToolCum {
  const m: ToolCum = new Map();
  for (const x of s) {
    if (x.name === "grayboard_tool_call_duration_seconds_count") (m.get(x.labels.tool!) ?? m.set(x.labels.tool!, { count: 0, fast: 0 }).get(x.labels.tool!)!).count = x.value;
    if (x.name === "grayboard_tool_call_duration_seconds_bucket" && x.labels.le === "0.1") (m.get(x.labels.tool!) ?? m.set(x.labels.tool!, { count: 0, fast: 0 }).get(x.labels.tool!)!).fast = x.value;
  }
  return m;
}
function refusalsTotal(s: Sample[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const x of s) if (x.name === "grayboard_capacity_refusals_total") r[x.labels.kind!] = x.value;
  return r;
}

// The write queue's histograms (#1510), cumulative as scraped: per site for wait and hold, and the depth at enqueue.
// `cum[i]` counts observations at or under `le[i]`; the last edge is +Inf.
export type CumHist = { le: number[]; cum: number[]; sum: number; count: number };
// `keyed`: bodies that ran keyed, per site; `worldStop`: seconds in which an exclusive body waited or ran (chunk 2);
// `gate`: keyed requests by `<site>:<outcome>` (grayboard_hosted_gate_bodies_total, summed over its methods; gate and
// prior, chunk 3; renew and receipt, chunk 4); `gateMethod`: the gate site's by `<method>:<outcome>` (#1537 PR 0).
// `statements`, `roundTrips`: per site, Postgres statements and round trips summed over the bodies counted
// (grayboard_write_queue_statements and _round_trips, #1537 PR 0); `count` is the bodies.
export type StmtCum = { sum: number; count: number };
export type QueueCum = {
  wait: Map<string, CumHist>; hold: Map<string, CumHist>; depth?: CumHist; keyed: Map<string, number>; worldStop: number; gate: Map<string, number>;
  gateMethod: Map<string, number>; statements: Map<string, StmtCum>; roundTrips: Map<string, StmtCum>;
};
export function queueCumulative(s: Sample[]): QueueCum {
  const q: QueueCum = { wait: new Map(), hold: new Map(), keyed: new Map(), worldStop: 0, gate: new Map(), gateMethod: new Map(), statements: new Map(), roundTrips: new Map() };
  const slot = (name: string, labels: Record<string, string>): CumHist | undefined => {
    const m = /^grayboard_write_queue_(wait|hold)_seconds_/.exec(name);
    if (m) { const map = q[m[1] as "wait" | "hold"]; return map.get(labels.site!) ?? map.set(labels.site!, { le: [], cum: [], sum: 0, count: 0 }).get(labels.site!)!; }
    if (name.startsWith("grayboard_write_queue_depth_")) return q.depth ??= { le: [], cum: [], sum: 0, count: 0 };
    return undefined;
  };
  for (const x of s) {
    if (x.name === "grayboard_write_queue_keyed_bodies_total") { q.keyed.set(x.labels.site!, x.value); continue; }
    if (x.name === "grayboard_write_queue_world_stop_seconds_total") { q.worldStop = x.value; continue; }
    if (x.name === "grayboard_hosted_gate_bodies_total") {
      const k = `${x.labels.site}:${x.labels.outcome}`;
      q.gate.set(k, (q.gate.get(k) ?? 0) + x.value);
      if (x.labels.site === "gate" && x.labels.method) q.gateMethod.set(`${x.labels.method}:${x.labels.outcome}`, x.value);
      continue;
    }
    const st = /^grayboard_write_queue_(statements|round_trips)_(sum|count)$/.exec(x.name);
    if (st) {
      const map = st[1] === "statements" ? q.statements : q.roundTrips;
      const c = map.get(x.labels.site!) ?? map.set(x.labels.site!, { sum: 0, count: 0 }).get(x.labels.site!)!;
      c[st[2] as "sum" | "count"] = x.value;
      continue;
    }
    const h = slot(x.name, x.labels);
    if (!h) continue;
    if (x.name.endsWith("_bucket")) { h.le.push(x.labels.le === "+Inf" ? Infinity : Number(x.labels.le)); h.cum.push(x.value); }
    else if (x.name.endsWith("_sum")) h.sum = x.value;
    else if (x.name.endsWith("_count")) h.count = x.value;
  }
  return q;
}
// a - b (b absent: a), or a + b: one histogram's shape on both sides.
function combine(a: CumHist, b: CumHist | undefined, sign: 1 | -1): CumHist {
  if (!b) return sign === 1 ? a : { ...a, cum: [...a.cum] };
  return { le: a.le, cum: a.cum.map((c, i) => c + sign * (b.cum[i] ?? 0)), sum: a.sum + sign * b.sum, count: a.count + sign * b.count };
}
export function combineQueue(a: QueueCum, b: QueueCum, sign: 1 | -1): QueueCum {
  const maps = (x: Map<string, CumHist>, y: Map<string, CumHist>) => {
    const out = new Map<string, CumHist>();
    for (const [k, h] of x) out.set(k, combine(h, y.get(k), sign));
    if (sign === 1) for (const [k, h] of y) if (!x.has(k)) out.set(k, h);
    return out;
  };
  const counts = (x: Map<string, number>, y: Map<string, number>) => {
    const out = new Map(x);
    for (const [k, n] of y) out.set(k, (out.get(k) ?? 0) + sign * n);
    return out;
  };
  const stmts = (x: Map<string, StmtCum>, y: Map<string, StmtCum>) => {
    const out = new Map<string, StmtCum>([...x].map(([k, c]) => [k, { ...c }]));
    for (const [k, c] of y) { const o = out.get(k) ?? out.set(k, { sum: 0, count: 0 }).get(k)!; o.sum += sign * c.sum; o.count += sign * c.count; }
    return out;
  };
  return { wait: maps(a.wait, b.wait), hold: maps(a.hold, b.hold), ...(a.depth ? { depth: combine(a.depth, b.depth, sign) } : b.depth && sign === 1 ? { depth: b.depth } : {}),
    keyed: counts(a.keyed, b.keyed), worldStop: a.worldStop + sign * b.worldStop, gate: counts(a.gate, b.gate),
    gateMethod: counts(a.gateMethod, b.gateMethod), statements: stmts(a.statements, b.statements), roundTrips: stmts(a.roundTrips, b.roundTrips) };
}
// The q-quantile, interpolated linearly within its bucket (histogram_quantile's rule); one in the +Inf bucket reads as
// the last finite edge. Null with no observations.
export function quantile(h: CumHist, q: number): number | null {
  if (!h.count) return null;
  const rank = q * h.count;
  const i = h.cum.findIndex(c => c >= rank);
  if (i < 0) return null;
  const upper = h.le[i]!, lower = i ? h.le[i - 1]! : 0, below = i ? h.cum[i - 1]! : 0;
  if (upper === Infinity) return lower;
  const inBucket = h.cum[i]! - below;
  return inBucket ? lower + (upper - lower) * (rank - below) / inBucket : upper;
}
const sumHists = (hs: Iterable<CumHist>): CumHist | undefined => { let out: CumHist | undefined; for (const h of hs) out = out ? combine(out, h, 1) : h; return out; };
type Dist = { p50: number | null; p99: number | null; mean: number | null };
const dist = (h: CumHist | undefined): Dist => h && h.count ? { p50: quantile(h, 0.5), p99: quantile(h, 0.99), mean: h.sum / h.count } : { p50: null, p99: null, mean: null };
export type QueueStats = {
  bodies: number; bodiesPerS: number; busy: number; wait: Dist; hold: Dist;
  // `worldStop`: the share of wall time in which an exclusive body waited or ran; `keyed`: the share of bodies that ran
  // keyed (#1510 chunk 2).
  worldStop: number; keyed: number;
  // The highest depth bucket edge any body that queued met (null: none queued; past the last edge reads as it + 1).
  maxDepth: number | null;
  // `statements`, `roundTrips`: Postgres statements and round trips per body at the site (#1537 PR 0), null with none
  // counted (SQLite).
  sites: Record<string, { bodies: number; bodiesPerS: number; busy: number; wait: Dist; hold: Dist; keyed: number; statements: number | null; roundTrips: number | null }>;
  // The keyed fast path per site (the hosted gate's gate and prior, delivery's renew and receipt): requests whose body
  // ran keyed, missed (a keyed attempt, then the exclusive body), or skipped it; `missRate`: misses over attempts
  // (keyed + miss), null with none.
  gate: Record<string, { keyed: number; miss: number; skipped: number; missRate: number | null }>;
  // The gate site's requests by the call it served (selection, tool, renew, receipt, pending, …; #1537 PR 0), only
  // methods with any.
  gateMethods: Record<string, { keyed: number; miss: number; skipped: number }>;
};
// A span's queue numbers from its histogram deltas over `wallS` seconds.
export function queueStats(d: QueueCum, wallS: number): QueueStats {
  const hold = sumHists(d.hold.values()), wait = sumHists(d.wait.values());
  let maxDepth: number | null = null;
  if (d.depth) for (let i = 0; i < d.depth.le.length; i++) if (d.depth.cum[i]! - (i ? d.depth.cum[i - 1]! : 0) > 0) maxDepth = d.depth.le[i] === Infinity ? d.depth.le[i - 1]! + 1 : d.depth.le[i]!;
  const sites: QueueStats["sites"] = {};
  let keyed = 0;
  for (const [site, h] of d.hold) if (h.count) {
    const k = d.keyed.get(site) ?? 0;
    keyed += k;
    const st = d.statements.get(site), rt = d.roundTrips.get(site);
    sites[site] = { bodies: h.count, bodiesPerS: h.count / wallS, busy: h.sum / wallS, wait: dist(d.wait.get(site)), hold: dist(h), keyed: k / h.count,
      statements: st?.count ? st.sum / st.count : null, roundTrips: rt?.count ? rt.sum / rt.count : null };
  }
  const bodies = hold?.count ?? 0;
  const gate: QueueStats["gate"] = {};
  for (const [k, n] of d.gate) {
    const [site, outcome] = k.split(":") as [string, "keyed" | "miss" | "skipped"];
    const g = gate[site] ??= { keyed: 0, miss: 0, skipped: 0, missRate: null };
    g[outcome] = n;
  }
  for (const g of Object.values(gate)) g.missRate = g.keyed + g.miss ? g.miss / (g.keyed + g.miss) : null;
  const gateMethods: QueueStats["gateMethods"] = {};
  for (const [k, n] of d.gateMethod) {
    if (!n) continue;
    const [method, outcome] = k.split(":") as [string, "keyed" | "miss" | "skipped"];
    (gateMethods[method] ??= { keyed: 0, miss: 0, skipped: 0 })[outcome] = n;
  }
  return { bodies, bodiesPerS: bodies / wallS, busy: (hold?.sum ?? 0) / wallS, wait: dist(wait), hold: dist(hold), worldStop: d.worldStop / wallS, keyed: bodies ? keyed / bodies : 0, maxDepth, sites, gate, gateMethods };
}
const ms = (x: number | null) => x === null ? "-" : (x * 1000).toFixed(2);

// The share of a client histogram at or under 0.1 s.
const fastShare = (h: { buckets: number[]; count: number }) => h.count ? h.buckets[BUCKETS.indexOf(0.1)]! / h.count : 1;
// The 99th percentile's bucket: the lowest edge at or under which 99% of calls fall (null: beyond the last, or none).
const p99Edge = (h: Hist) => h.count ? BUCKETS.find((_, i) => h.buckets[i]! >= 0.99 * h.count) ?? null : null;
const mergeHist = (into: Hist, h: Hist) => { h.buckets.forEach((b, i) => into.buckets[i]! += b); into.count += h.count; into.sum += h.sum; into.errors += h.errors; };
const newHist = (): Hist => ({ buckets: BUCKETS.map(() => 0), count: 0, sum: 0, errors: 0 });
// The 99% latency gate on a pool of any size: more slow calls than 1% of the pool, rounded up, so a pool under 100
// calls tolerates one (a smoke run's 80 calls failed CI on a single 101 ms call, #858). Never stricter than the old
// `fast / count < 0.99`; one more slow call allowed when count isn't a multiple of 100. `count / 100` is exact for an
// integer count, where `(1 - 0.99) * count` would round 1000 up to 11.
export function tooSlow(count: number, fast: number): boolean {
  return count - fast > Math.ceil(count / 100);
}
// Least-squares slope, units per second.
export function slope(points: [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((a, p) => a + p[0], 0) / n, my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : 0;
}

// What N forces, at a quarter's headroom: sessions, leases and listens are one per session; a
// session's POSTs overlap its listen and each other (a renew, a read and an agent call at once:
// at twice sessions per user the default cadence drew rate_limited), so the POST caps, global and
// per user, allow four per session. A listen holds its POST slot for the stream's life, and a
// connect POSTs from both wires at once: a global POST cap of one per session refused the burst's
// discovers with a plain 429, which the SDK reports as a version negotiation failure and nothing
// retries (#1532: 52 of 300 sessions never connected). The per-user caps follow sessions per user.
// Never below a shipped default, and a per-user cap never above its global (the server refuses to
// start on that).
export const POSTS_PER_SESSION = 4;
export function capsEnv(o: Options): Record<string, string> {
  const n = Math.ceil(o.sessions * 1.25), perUser = Math.ceil(Math.ceil(userSessions(o) / o.users) * 1.25);
  const pair = (prefix: string, d: { global: number; perUser: number }, scoped = perUser, wanted = n) => {
    const global = Math.max(wanted, d.global);
    return { [`${prefix}_GLOBAL`]: String(global), [`${prefix}_PER_USER`]: String(Math.min(global, Math.max(scoped, d.perUser))) };
  };
  return {
    ...pair("GRAYBOARD_HOSTED_SESSIONS", DEFAULT_HOSTED_CAPS.sessions), ...pair("GRAYBOARD_DELIVERY_LEASES", DEFAULT_HOSTED_CAPS.leases),
    ...pair("GRAYBOARD_MCP_LISTEN", DEFAULT_MCP_LIMITS.listen), ...pair("GRAYBOARD_MCP_POST", DEFAULT_MCP_LIMITS.post, perUser * POSTS_PER_SESSION, n * POSTS_PER_SESSION),
    // The service's workers: one lease each, under its own per-service cap (its buckets' defaults are far above them).
    ...(Math.ceil(o.serviceWorkers * 1.25) > DEFAULT_HOSTED_CAPS.leases.perService! ? { GRAYBOARD_DELIVERY_LEASES_PER_SERVICE: String(Math.min(Math.max(n, DEFAULT_HOSTED_CAPS.leases.global), Math.ceil(o.serviceWorkers * 1.25))) } : {}),
    // Board watches: one per session at most here; the per-session default stands.
    GRAYBOARD_RESOURCE_WATCHES_GLOBAL: String(Math.max(n, DEFAULT_HOSTED_CAPS.watches.global)),
    // Each per-user request bucket (#845), raised only when its estimate needs it, at twice the estimate.
    ...bucket("GRAYBOARD_HOSTED_REQUEST", DEFAULT_HOSTED_REQUEST_LIMIT, perUserRate(o).tools),
    ...bucket("GRAYBOARD_HOSTED_SUBSCRIBER", DEFAULT_HOSTED_SUBSCRIBER_LIMIT, perUserRate(o).subscriber),
  };
}
function bucket(prefix: string, d: RateLimit, rate: number): Record<string, string> {
  if (rate * 2 <= d.perSec) return {};
  return { [`${prefix}_PER_SEC`]: String(Math.ceil(rate * 2)), [`${prefix}_BURST`]: String(Math.max(d.burst, Math.ceil(rate * 12))) };
}

// Hosted requests per second per user, per bucket, at hosted-core's cadence. Tool calls: the agent's
// op every period. Delivery upkeep (role=subscriber): a renew and a read every 10 s, and up to three
// requests per delivery (a read on its hint, a renew, a receipt; #845). A DM reaches one session; a
// post reaches its board's other subscribers; an invocation's reply reaches its invoker; a peer_list or a read reaches no one.
export function perUserRate(o: Options): { tools: number; subscriber: number; total: number } {
  const subscribers = Math.max(0, userSessions(o) / o.boards - 1);
  const perUser = userSessions(o) / o.users;
  const tools = perUser / o.periodS;
  const peers = o.serviceWorkers ? o.peerShare + o.readShare : 0;
  const subscriber = perUser * (0.2 + (1 / o.periodS) * 3 * ((1 - o.postShare - peers) + o.postShare * subscribers));
  return { tools, subscriber, total: tools + subscriber };
}

type Window = {
  at: number; t: number; steady: boolean; churning: boolean; rss: number; heap: number; lag?: { p50: number; p99: number; max: number };
  leases: number; listens: number; holding: number; live: number; refusals: Record<string, number>;
  tools: Record<string, { count: number; fast: number }>; client: Record<string, Hist>; clientErrors: Record<string, number>;
  driverLagP99: number; ops: number; loadavg: number[];
  // The server's write queue over the window; absent when the server exports no queue metrics.
  queue?: QueueStats;
};

// What the server recorded of the service's traffic: the post ids of the invocations it allowed through a team's
// service_invoke binding (authz.decision rows, src/server/application.ts board_post), every service.invoke row by
// rule, and the service board's scope. The run's proof that its invocations took the service path, not another one.
type ServiceAudit = { teamAllowed: Set<number>; rules: Record<string, number>; boardScope: string | null; boardKind: string | null };
async function serviceAudit(pgDbUrl: string | undefined, dbPath: string): Promise<ServiceAudit> {
  let details: unknown[], board: { scope: string | null; kind: string | null } | undefined;
  if (pgDbUrl) {
    const sql = openPg(pgDbUrl, { max: 1, applicationName: "gb-loadtest-audit" });
    try {
      details = (await sql`SELECT detail FROM access_log WHERE action = 'authz.decision'`).map((r: { detail: unknown }) => r.detail);
      board = (await sql`SELECT scope, kind FROM boards WHERE name = ${SVC_BOARD}`)[0];
    } finally { await sql.close(); }
  } else {
    const ro = new Database(dbPath, { readonly: true });
    try {
      details = (ro.query("SELECT detail FROM access_log WHERE action = 'authz.decision'").all() as { detail: string }[]).map(r => r.detail);
      board = ro.query("SELECT scope, kind FROM boards WHERE name = ?").get(SVC_BOARD) as typeof board ?? undefined;
    } finally { ro.close(); }
  }
  const teamAllowed = new Set<number>(), rules: Record<string, number> = {};
  for (const raw of details) {
    const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
    if (d?.verb !== "service.invoke") continue;
    const key = `${d.rule}:${d.allow ? "allow" : "deny"}`;
    rules[key] = (rules[key] ?? 0) + 1;
    if (d.allow === true && d.rule === "role.service_invoke" && typeof d.team === "string" && d.board === SVC_BOARD && typeof d.post_id === "number") teamAllowed.add(d.post_id);
  }
  return { teamAllowed, rules, boardScope: board?.scope ?? null, boardKind: board?.kind ?? null };
}

// Every hosted_sessions row left once the fleet has closed, parked children included.
async function hostedRows(pgDbUrl: string | undefined, dbPath: string): Promise<number> {
  if (pgDbUrl) {
    const sql = openPg(pgDbUrl, { max: 1, applicationName: "gb-loadtest-count" });
    try { return Number((await sql`SELECT count(*) AS n FROM hosted_sessions`)[0].n); } finally { await sql.close(); }
  }
  const ro = new Database(dbPath, { readonly: true });
  try { return (ro.query("SELECT count(*) AS n FROM hosted_sessions").get() as { n: number }).n; } finally { ro.close(); }
}

const ADMIN = "load-admin@example.com", SERVICE = "loadsvc", SVC_BOARD = "load-svc";
const SERVICE_OPS = new Set<string>(["svc_invoke", "svc_reply", "peer_list", ...SVC_READS]);

// The service, as an admin and a launcher set one up (tests/support/service_token.ts): the service (owned by the first
// user), a credential whose run tokens outlast the run, one run token minted with client credentials, and T teams
// (user u in team u % T), each granted service_invoke on it. Returns the run token every worker connects with.
async function seedService(base: string, o: Options, emails: string[], runS: number): Promise<string> {
  const admin = await devLogin(base, ADMIN);
  const api = async (method: string, path: string, body: unknown, want: number) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${admin}` }, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status !== want) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return JSON.parse(text);
  };
  await api("POST", "/api/admin/services", { name: SERVICE, owners: [emails[0]] }, 201);
  const c = await api("POST", "/api/admin/services/credentials", { service: SERVICE, token_seconds: Math.max(SERVICE_TOKEN_MIN_SECONDS, Math.min(runS, DEFAULT_SERVICE_TOKEN_LIMITS.maxSeconds)) }, 201);
  const minted = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(c.client_secret)}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const token = ((await minted.json()) as { access_token?: string }).access_token;
  if (minted.status !== 200 || !token) throw new Error(`minting the service's run token: ${minted.status}`);
  for (let t = 0; t < o.teams; t++) {
    const team = `loadteam-${t}`;
    await api("POST", "/api/teams", { name: team }, 201);
    for (let u = t; u < emails.length; u += o.teams) await api("POST", `/api/teams/${team}/add`, { email: emails[u] }, 200);
    await api("POST", "/api/admin/roles/grant", { role: "service_invoke", principal: team, scope: SERVICE }, 201);
  }
  return token;
}

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "gb-loadtest-"));
  const dbPath = join(scratch, "grayboard.db"), blobDir = join(scratch, "blobs");
  // On Postgres: an empty database on the cluster, which the server migrates when it opens it.
  const pgName = `gb_loadtest_${Date.now()}`;
  const pgAdmin = o.pg ? openPg(o.pg, { max: 1, applicationName: "gb-loadtest-admin" }) : undefined;
  const pgDbUrl = o.pg ? (() => { const u = new URL(o.pg!); u.pathname = `/${pgName}`; return u.toString(); })() : undefined;
  const log = (s: string) => { console.log(s); appendFileSync(join(o.out, "run.log"), s + "\n"); };
  log(`loadtest: ${o.sessions} sessions, ${o.users} users, ${o.drivers} drivers, ${o.durationS}s (${o.warmupS}s warm-up), op every ${o.periodS}s, ${o.boards} boards (~${Math.round(o.sessions / o.boards)} subscribers each), post share ${o.postShare}, burst ${o.burst}, churn ${o.churn} every ${o.churnEveryS}s, ${o.serviceWorkers ? `${o.serviceWorkers} service workers, ${o.teams} invoker teams, svc share ${o.svcShare}, peer_list share ${o.peerShare}, read share ${o.readShare}` : "no service"}; ${cpus().length} CPUs, load ${loadavg().map(x => x.toFixed(2)).join(" ")}`);
  log(`run dir: ${o.out}`);

  const caps = capsEnv(o);
  // The admin creates the service, its credential, the teams and their grants through the admin routes.
  const env = { ...caps, ...o.env, GRAYBOARD_METRICS_ADDR: "127.0.0.1:0", GRAYBOARD_ADMINS: ADMIN, HOME: join(scratch, "home") };
  mkdirSync(env.HOME, { recursive: true });
  log(`server env: ${Object.entries(env).filter(([k]) => k !== "HOME").map(([k, v]) => `${k}=${v}`).join(" ")} (about ${perUserRate(o).tools.toFixed(1)} tool and ${perUserRate(o).subscriber.toFixed(1)} delivery requests/s per user)`);
  type Driver = { proc: ReturnType<typeof Bun.spawn>; windows: DriverWindow[]; ready?: { live: number; want: number; connectErrors?: Record<string, number> }; final?: DriverFinal; churned: number; quiesced: boolean; read: Promise<void> };
  const drivers: Driver[] = [];
  const failures: string[] = [];
  const windows: Window[] = [];
  let exitCode = 0;
  let srv: ServerProcess | undefined;
  let proxy: DelayProxy | undefined;
  // The steady period's write-queue deltas, kept outside the try so an aborted run still reports them.
  let steadyQueue: QueueCum = { wait: new Map(), hold: new Map(), keyed: new Map(), worldStop: 0, gate: new Map(), gateMethod: new Map(), statements: new Map(), roundTrips: new Map() }, steadyQueueS = 0;
  // A driver killed by a signal (the scope's OOM killer) keeps a null exitCode.
  const exited = (d: Driver) => d.proc.exitCode !== null || d.proc.signalCode !== null;
  try {
    if (pgAdmin) await pgAdmin.unsafe(`CREATE DATABASE "${pgName}"`);
    if (pgDbUrl && o.pgLatencyMs !== undefined) {
      const u = new URL(pgDbUrl);
      proxy = startDelayProxy({ hostname: u.hostname, port: Number(u.port || 5432) }, o.pgLatencyMs);
      log(`postgres delay proxy on 127.0.0.1:${proxy.port}: +${o.pgLatencyMs} ms each way (round trip +${2 * o.pgLatencyMs} ms); the server connects through it`);
    }
    srv = await ServerProcess.start(o.server, pgDbUrl ? { url: proxy ? proxy.url(pgDbUrl) : pgDbUrl, blobDir } : { dbPath }, env);
    const server = srv;
    let metricsUrl: string | undefined;
    for (const deadline = Date.now() + 10_000; !metricsUrl; await Bun.sleep(50)) {
      const m = /metrics on ([^\s]+):(\d+)/.exec(server.log());
      if (m) metricsUrl = `http://${m[1]}:${m[2]}/metrics`;
      else if (Date.now() > deadline) throw new Error(`the server never logged its metrics address within 10 s:\n${server.log()}`);
    }
    log(`server ${server.base}, metrics ${metricsUrl}, pid ${server.proc.pid}`);
    // Tokens, seeded once the server has opened the file: its first open revokes any grant issued
    // under a built-in client ID before it had built-in clients. A HostedSession never refreshes, so each
    // token's hour starts late enough to outlast the run: issuance takes `now` and stamps every row
    // from it, and the server checks only expiry against its clock.
    const runMs = (o.durationS + o.graceS + 600) * 1000;
    const issuedAt = Date.now() + Math.max(0, runMs - OAUTH_TTL.access);
    const repo: Repo = pgDbUrl ? await makePgRepo(pgDbUrl, { blobDir, humanReach: "team", max: 2, applicationName: "gb-loadtest-seed" })
      : openDatabase(dbPath, { blobDir, sessionEnd: sessionEndPort("team") }).repo;
    const resource = "http://localhost/mcp";
    const users = await Promise.all(Array.from({ length: o.users }, async (_, u) => {
      const email = `load${u}@example.com`;
      return { email, token: (await issueOAuth(repo, resource, email, HOSTED_SCOPES, issuedAt, HOSTED_CLIENT)).token };
    }));
    await repo.close();
    const svcToken = o.serviceWorkers ? await seedService(server.base, o, users.map(u => u.email), Math.ceil(runMs / 1000)) : undefined;

    const scrape = async () => parseMetrics(await (await fetch(metricsUrl!)).text());

    // Sessions: index i belongs to user i % U and driver i % K, binds load-<i>, subscribes board i % B; the last W are
    // the service's workers, w-<j> on its run token, each a lane of its queue board.
    const users_ = userSessions(o);
    const specs: DriverSession[] = Array.from({ length: o.sessions }, (_, i) => {
      if (i >= users_) { const name = `w-${i - users_}`; return { index: i, email: SERVICE, token: svcToken!, name, address: `${SERVICE}/${name}`, board: SVC_BOARD, service: true }; }
      const u = users[i % o.users]!, name = `load-${i}`;
      return { index: i, email: u.email, token: u.token, name, address: `${u.email}/${name}`, board: `load-${i % o.boards}` };
    });
    const addresses = specs.filter(s => !s.service).map(s => s.address);

    for (let k = 0; k < o.drivers; k++) {
      const config: DriverConfig = {
        driver: k, url: `${server.base}/mcp`, sessions: specs.filter(s => s.index % o.drivers === k), addresses,
        periodMs: o.periodS * 1000, postShare: o.postShare, burst: Math.max(1, Math.ceil(o.burst / o.drivers)),
        svcBoard: o.serviceWorkers ? SVC_BOARD : null, svcShare: o.svcShare, peerShare: o.peerShare, readShare: o.readShare,
      };
      const proc = Bun.spawn([process.execPath, join(ROOT, "scripts/loadtest_driver.ts")], {
        cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(o.out, `driver-${k}.stderr`)),
        env: { PATH: process.env.PATH ?? "", HOME: env.HOME },
      });
      const d: Driver = { proc, windows: [], churned: 0, quiesced: false, read: Promise.resolve() };
      drivers.push(d);
      d.read = (async () => {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            let msg: any;
            try { msg = JSON.parse(line); } catch { log(`driver ${k}: ${line}`); continue; }
            if (msg.type === "window") d.windows.push(msg);
            else if (msg.type === "ready") d.ready = msg;
            else if (msg.type === "churned") d.churned++;
            else if (msg.type === "quiesced") d.quiesced = true;
            else if (msg.type === "final") d.final = msg;
          }
        }
      })();
      (proc.stdin as import("bun").FileSink).write(JSON.stringify(config) + "\n");
    }
    const send = (cmd: string) => { for (const d of drivers) (d.proc.stdin as import("bun").FileSink).write(cmd + "\n"); };
    // Every wait sleeps between checks. (Racing the drivers' exits instead spun once one had exited:
    // its settled promise won every race, and the microtask loop starved timers and ate memory.)
    const waitAll = async (what: string, ok: (d: Driver) => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!drivers.every(ok)) {
        if (Date.now() > deadline) throw new Error(`${what}: not every driver got there within ${ms / 1000} s (${drivers.map((d, k) => `${k}:${ok(d)}`).join(" ")})`);
        for (const [k, d] of drivers.entries()) {
          if (!exited(d) || ok(d)) continue;
          // An exited driver's last lines may still be in its pipe.
          await d.read;
          if (!ok(d)) throw new Error(`${what}: driver ${k} exited (${d.proc.exitCode ?? d.proc.signalCode}); see driver-${k}.stderr`);
        }
        await Bun.sleep(100);
      }
    };

    // Every process's RSS once a second, to stderr: the run's scope caps the whole tree.
    const rssOf = (pid: number | undefined) => { try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) >> 10; } catch { return -1; } };
    if (process.env.LOADTEST_MEMLOG) setInterval(() => console.error(`memlog ${new Date().toISOString()} coord=${rssOf(process.pid)}MB server=${rssOf(server.proc.pid)}MB drivers=${drivers.map(d => rssOf(d.proc.pid)).join(",")}MB win=${drivers.map(d => d.windows.length).join(",")}`), 1000).unref();
    const t0 = Date.now();
    await waitAll("connect", d => d.ready !== undefined, Math.max(120_000, o.sessions * 200));
    const connected = drivers.reduce((a, d) => a + d.ready!.live, 0);
    log(`connected ${connected}/${o.sessions} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const connectErrors: Record<string, number> = {};
    for (const d of drivers) for (const [k, v] of Object.entries(d.ready!.connectErrors ?? {})) connectErrors[k] = (connectErrors[k] ?? 0) + v;
    if (Object.keys(connectErrors).length) log(`connect failures by class: ${JSON.stringify(connectErrors)}`);
    if (connected !== o.sessions) failures.push(`only ${connected} of ${o.sessions} sessions connected${Object.keys(connectErrors).length ? `: ${JSON.stringify(connectErrors)}` : ""}`);

    // The load: a scrape per window; a churn wave every churnEveryS.
    const start = Date.now(), end = start + o.durationS * 1000;
    let prev = await scrape(), prevTools = toolCumulative(prev), prevRef = refusalsTotal(prev), prevQueue = queueCumulative(prev), prevAt = Date.now();
    // The connect storm's write bodies (#1537a): the first scrape is cumulative since the server started.
    {
      const bodies = [...prevQueue.hold.values()].reduce((a, h) => a + h.count, 0), keyed = [...prevQueue.keyed.values()].reduce((a, n) => a + n, 0);
      const methods = [...prevQueue.gateMethod].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
      log(`connect storm: ${bodies} bodies, ${bodies - keyed} exclusive, world stop ${prevQueue.worldStop.toFixed(1)} s; gate bodies by method:outcome: ${methods || "none"}`);
    }
    let nextChurn = start + o.churnEveryS * 1000, churnUntil = 0, churnsSent = 0;
    // Each scrape asks every driver for its window since the last ask, so the two cover one span.
    // Report 0 opens the first window: what drivers did before the load started is dropped.
    let seq = 0;
    send(`report ${seq}`);
    const reported = (n: number) => (d: Driver) => d.windows.some(w => w.seq === n);
    await waitAll("report", reported(seq), o.windowS * 1000);
    for (let next = start + o.windowS * 1000; next <= end; next += o.windowS * 1000) {
      await Bun.sleep(Math.max(0, next - Date.now()));
      const s = await scrape(), now = Date.now();
      send(`report ${++seq}`);
      // A driver that can't answer within a window is saturated or dead: the run can't vouch for it.
      await waitAll(`window ${seq}`, reported(seq), o.windowS * 1000);
      const tools: Window["tools"] = {};
      for (const [tool, c] of toolCumulative(s)) {
        const p = prevTools.get(tool) ?? { count: 0, fast: 0 };
        if (c.count > p.count) tools[tool] = { count: c.count - p.count, fast: c.fast - p.fast };
      }
      const ref = refusalsTotal(s), refusals: Record<string, number> = {};
      for (const [k, v] of Object.entries(ref)) if (v > (prevRef[k] ?? 0)) refusals[k] = v - (prevRef[k] ?? 0);
      // Driver windows reported since the last scrape.
      const client: Record<string, Hist> = {}, clientErrors: Record<string, number> = {};
      let driverLagP99 = 0, live = 0;
      drivers.forEach((d, k) => {
        const w = d.windows.find(x => x.seq === seq)!;
        for (const [op, h] of Object.entries(w.ops)) mergeHist(client[op] ??= newHist(), h);
        for (const [c, n] of Object.entries(w.errors)) clientErrors[c] = (clientErrors[c] ?? 0) + n;
        for (const e of w.firstErrors) log(`driver ${k} error: ${e}`);
        driverLagP99 = Math.max(driverLagP99, w.lagP99);
        live += w.live;
      });
      const lagSamples = ["0.5", "0.99", "1"].map(q => one(s, "grayboard_event_loop_lag_seconds", { quantile: q }));
      const queueNow = queueCumulative(s), queueDelta = combineQueue(queueNow, prevQueue, -1), wallS = (now - prevAt) / 1000;
      const steadyWindow = next - o.windowS * 1000 - start >= o.warmupS * 1000;
      if (steadyWindow && queueNow.hold.size) { steadyQueue = combineQueue(steadyQueue, queueDelta, 1); steadyQueueS += wallS; }
      const w: Window = {
        // Steady from the first window that starts after the warm-up (#1038), by schedule, so scrape jitter can't flip it.
        at: now, t: (now - start) / 1000, steady: steadyWindow, churning: now < churnUntil,
        rss: one(s, "grayboard_process_resident_memory_bytes") ?? -1, heap: one(s, "grayboard_process_heap_used_bytes") ?? -1,
        ...(lagSamples.every(x => x !== undefined) ? { lag: { p50: lagSamples[0]!, p99: lagSamples[1]!, max: lagSamples[2]! } } : {}),
        leases: one(s, "grayboard_delivery_leases") ?? -1, listens: one(s, "grayboard_mcp_admissions", { kind: "listen" }) ?? -1,
        holding: one(s, "grayboard_hosted_sessions_holding") ?? -1, live, refusals, tools, client, clientErrors, driverLagP99,
        ops: ["dm_send", "board_post", "svc_invoke", "peer_list", ...SVC_READS].reduce((a, op) => a + (client[op]?.count ?? 0), 0), loadavg: loadavg(),
        ...(queueNow.hold.size ? { queue: queueStats(queueDelta, wallS) } : {}),
      };
      windows.push(w);
      appendFileSync(join(o.out, "windows.jsonl"), JSON.stringify(w) + "\n");
      const toolAll = Object.values(tools).reduce((a, x) => ({ count: a.count + x.count, fast: a.fast + x.fast }), { count: 0, fast: 0 });
      log(`t=${w.t.toFixed(0)}s${w.steady ? "" : " (warm-up)"}${w.churning ? " (churn)" : ""} leases=${w.leases} listens=${w.listens} live=${w.live} rss=${(w.rss / 2 ** 20).toFixed(0)}MB heap=${(w.heap / 2 ** 20).toFixed(0)}MB lag.p99=${w.lag ? (w.lag.p99 * 1000).toFixed(1) : "-"}ms tools=${toolAll.count} (${(100 * (toolAll.count ? toolAll.fast / toolAll.count : 1)).toFixed(2)}% ≤100ms) ops=${w.ops} inbox≤100ms=${client.inbox ? (100 * fastShare(client.inbox)).toFixed(2) : "-"}% drvlag=${(driverLagP99 * 1000).toFixed(0)}ms load=${w.loadavg[0]!.toFixed(1)}${w.queue ? ` queue: ${w.queue.bodiesPerS.toFixed(0)}/s busy=${(100 * w.queue.busy).toFixed(1)}% wait.p50/p99=${ms(w.queue.wait.p50)}/${ms(w.queue.wait.p99)}ms hold.p50/p99=${ms(w.queue.hold.p50)}/${ms(w.queue.hold.p99)}ms depth≤${w.queue.maxDepth ?? 0} stop=${(100 * w.queue.worldStop).toFixed(1)}% keyed=${(100 * w.queue.keyed).toFixed(1)}%` : ""}${Object.keys(refusals).length ? ` REFUSED ${JSON.stringify(refusals)}` : ""}${Object.keys(clientErrors).length ? ` ERRORS ${JSON.stringify(clientErrors)}` : ""}`);
      prev = s; prevTools = toolCumulative(s); prevRef = ref; prevQueue = queueNow; prevAt = now;
      if (o.churn > 0 && o.churnEveryS > 0 && now >= nextChurn && next + o.windowS * 1000 <= end) {
        send(`churn ${o.churn}`); churnsSent++;
        nextChurn += o.churnEveryS * 1000;
        // The churn's windows and the next are exempt from the lease-count gate.
        churnUntil = Infinity;
      }
      // Half a window's slack: the next scrape lands about a window from this one, either side.
      if (churnUntil === Infinity && drivers.every(d => d.churned >= churnsSent)) churnUntil = now + o.windowS * 1500;
    }

    // Quiesce: no new sends; the fleet drains what's in flight. Then close and account.
    send("quiesce");
    await waitAll("quiesce", d => d.quiesced, 30_000);
    await Bun.sleep(o.graceS * 1000);
    send("close");
    await waitAll("close", d => d.final !== undefined, Math.max(120_000, o.sessions * 200));
    await Bun.sleep(o.windowS * 1000 + 500);
    const after = await scrape();
    const drained = { leases: one(after, "grayboard_delivery_leases"), listens: one(after, "grayboard_mcp_admissions", { kind: "listen" }), posts: one(after, "grayboard_mcp_admissions", { kind: "post" }), holding: one(after, "grayboard_hosted_sessions_holding"), watches: one(after, "grayboard_resource_watches"), exchanges: one(after, "grayboard_mcp_exchanges_in_flight") };
    const rows = await hostedRows(pgDbUrl, dbPath);
    const audit = o.serviceWorkers ? await serviceAudit(pgDbUrl, dbPath) : undefined;

    // Gates.
    const steady = windows.filter(w => w.steady);
    if (!steady.length) failures.push("no steady window");
    // Only users' sessions send on the schedule.
    const target = userSessions(o) * o.windowS / o.periodS;
    for (const w of steady) {
      if (!w.churning && (w.leases !== o.sessions || w.listens !== o.sessions)) failures.push(`t=${w.t.toFixed(0)}s: ${w.leases} leases, ${w.listens} listens; want ${o.sessions} of each`);
      const all = Object.values(w.tools).reduce((a, x) => ({ count: a.count + x.count, fast: a.fast + x.fast }), { count: 0, fast: 0 });
      // A missing metric must not read as a pass.
      if (!all.count) failures.push(`t=${w.t.toFixed(0)}s: no server tool-call samples (is grayboard_tool_call_duration_seconds scraped?)`);
      if (w.rss <= 0 || w.heap <= 0) failures.push(`t=${w.t.toFixed(0)}s: no RSS or heap sample`);
      // Per window only with enough calls for a 1% tail to mean something; the steady pool below covers the rest.
      if (all.count >= 100 && all.fast / all.count < 0.99) failures.push(`t=${w.t.toFixed(0)}s: ${(100 * all.fast / all.count).toFixed(2)}% of ${all.count} tool calls at ≤ 100 ms; want ≥ 99%`);
      // Per window only at a size where 80% isn't inside the schedule's own noise; the pool below covers small runs.
      if (!w.churning && target >= 100 && w.ops < 0.8 * target) failures.push(`t=${w.t.toFixed(0)}s: ${w.ops} ops; want ≥ 80% of ${target.toFixed(0)}`);
    }
    // The pool holds 80% once it's past the noise, as the per-window gate does. A smaller pool (a seconds-long run, #1027)
    // wants 65%: the op schedule's jitter or a brief driver stall (a late session skips its missed sends) took 24 to 19,
    // while a fleet with one of two drivers silent (~12) still fails.
    const opsWindows = steady.filter(w => !w.churning), opsPool = opsWindows.reduce((a, w) => a + w.ops, 0);
    const poolTarget = target * opsWindows.length, poolShare = poolTarget >= 100 ? 0.8 : 0.65;
    if (opsWindows.length && opsPool < poolShare * poolTarget) failures.push(`${opsPool} ops over ${opsWindows.length} steady windows; want ≥ ${100 * poolShare}% of ${poolTarget.toFixed(0)}`);
    // Per tool over the steady period: a rare tool's tail can hide in the per-window total.
    const toolSteady: Record<string, { count: number; fast: number }> = {};
    for (const w of steady) for (const [t, x] of Object.entries(w.tools)) { const a = toolSteady[t] ??= { count: 0, fast: 0 }; a.count += x.count; a.fast += x.fast; }
    for (const [t, x] of Object.entries(toolSteady)) if (x.count >= 100 && x.fast / x.count < 0.99) failures.push(`${t}: ${(100 * x.fast / x.count).toFixed(2)}% of ${x.count} at ≤ 100 ms over the steady period`);
    const toolPool = Object.values(toolSteady).reduce((a, x) => ({ count: a.count + x.count, fast: a.fast + x.fast }), { count: 0, fast: 0 });
    if (toolPool.count && tooSlow(toolPool.count, toolPool.fast)) failures.push(`all tools: ${(100 * toolPool.fast / toolPool.count).toFixed(2)}% of ${toolPool.count} at ≤ 100 ms over the steady period`);
    // The client's view of the hot path the server histogram doesn't time (inbox reads, renews,
    // receipts), only from windows where no driver was saturated.
    const clean = steady.filter(w => w.driverLagP99 < 0.05);
    if (steady.length && clean.length < 0.9 * steady.length) failures.push(`${steady.length - clean.length} of ${steady.length} steady windows had a saturated driver (loop p99 ≥ 50 ms): add drivers`);
    const clientSteady: Record<string, Hist> = {};
    for (const w of clean) for (const [op, h] of Object.entries(w.client)) mergeHist(clientSteady[op] ??= newHist(), h);
    // The service's paths (#1258): each must have run, or a run without them would pass unmeasured.
    const wanted: Record<string, boolean> = {
      board_post: o.postShare > 0, svc_invoke: o.serviceWorkers > 0 && o.svcShare > 0, svc_reply: o.serviceWorkers > 0 && o.svcShare > 0, peer_list: o.serviceWorkers > 0 && o.peerShare > 0,
      // board_read reads an answered invocation's thread, so it needs invocations too.
      ...Object.fromEntries(SVC_READS.map(op => [op, o.serviceWorkers > 0 && o.readShare > 0 && (op !== "board_read" || o.svcShare > 0)])),
    };
    for (const op of ["inbox", "renew", "receipt", "dm_send", "board_post", "svc_invoke", "svc_reply", "peer_list", ...SVC_READS]) {
      const h = clientSteady[op];
      if (!h && clean.length && (wanted[op] ?? true)) failures.push(`client ${op}: no samples in the clean steady windows`);
      if (h && h.count >= 100 && fastShare(h) < 0.99) failures.push(`client ${op}: ${(100 * fastShare(h)).toFixed(2)}% of ${h.count} at ≤ 100 ms (clean steady windows)`);
      // The service's ops are rare (tens a run below the full profile): each is held to the pooled small-pool rule.
      else if (h && SERVICE_OPS.has(op) && tooSlow(h.count, h.buckets[BUCKETS.indexOf(0.1)]!)) failures.push(`client ${op}: ${(100 * fastShare(h)).toFixed(2)}% of ${h.count} at ≤ 100 ms (clean steady windows); want at most 1% slower, rounded up`);
    }
    // Refusals since the server started, connect and close included: the windows see only the load.
    const refusedAll = Object.fromEntries(Object.entries(refusalsTotal(after)).filter(([, v]) => v > 0));
    const erroredAll: Record<string, number> = {};
    for (const w of windows) for (const [k, v] of Object.entries(w.clientErrors)) erroredAll[k] = (erroredAll[k] ?? 0) + v;
    // Each driver's final counts are its whole run's, connect included; the windows' sums can miss what came after the
    // last report. Summed over drivers, not the max of one (#1532: 20 of 51 connect failures were counted that way).
    const finalErrors: Record<string, number> = {};
    for (const d of drivers) for (const [k, v] of Object.entries(d.final!.errors)) finalErrors[k] = (finalErrors[k] ?? 0) + v;
    for (const [k, v] of Object.entries(finalErrors)) erroredAll[k] = Math.max(erroredAll[k] ?? 0, v);
    if (Object.keys(refusedAll).length) failures.push(`capacity refusals: ${JSON.stringify(refusedAll)}`);
    if (Object.keys(erroredAll).length) failures.push(`client errors: ${JSON.stringify(erroredAll)}`);
    // DM accounting: every DM a send call returned for reached its recipient's lease.
    const sent = new Set(drivers.flatMap(d => d.final!.sentDm)), recv = new Set(drivers.flatMap(d => d.final!.recvDm));
    const lost = [...sent].filter(id => !recv.has(id));
    if (!sent.size) failures.push("no DM was sent");
    if (lost.length) failures.push(`${lost.length} of ${sent.size} DMs never reached their recipient (e.g. ${lost.slice(0, 5).join(", ")})`);
    // Every undelivered id ("sender:seq", the body's `lt|dm|<sender>|<seq>|...`), for classifying against a --keep-db database (#942).
    // Written even when empty, so a reused --out dir never keeps an earlier run's list.
    writeFileSync(join(o.out, "lost-dms.json"), JSON.stringify(lost) + "\n");
    const misdelivered = drivers.reduce((a, d) => a + d.final!.misdelivered, 0);
    if (misdelivered) failures.push(`${misdelivered} deliveries reached the wrong session (e.g. ${drivers.flatMap(d => d.final!.misdeliveredFirst).slice(0, 5).join("; ")})`);
    const posts = drivers.reduce((a, d) => a + d.final!.posts, 0), boardRecv = drivers.reduce((a, d) => a + d.final!.boardRecv, 0);
    if (o.postShare > 0 && !boardRecv) failures.push(`${posts} board posts, none delivered`);
    // Invocation accounting: every invocation whose post returned reached a lane, and its reply reached the invoker.
    const svcSent = new Set(drivers.flatMap(d => d.final!.svcSent)), svcGot = new Set(drivers.flatMap(d => d.final!.svcGot)), svcDone = new Set(drivers.flatMap(d => d.final!.svcDone));
    const svcLost = [...svcSent].filter(id => !svcDone.has(id)), svcUnread = [...svcSent].filter(id => !svcGot.has(id));
    if (o.serviceWorkers && o.svcShare > 0) {
      if (!svcSent.size) failures.push("no service invocation was sent");
      if (svcUnread.length) failures.push(`${svcUnread.length} of ${svcSent.size} invocations never reached a service lane (e.g. ${svcUnread.slice(0, 5).join(", ")})`);
      if (svcLost.length) failures.push(`${svcLost.length} of ${svcSent.size} invocations never came back as a reply their invoker read (e.g. ${svcLost.slice(0, 5).join(", ")})`);
      // Proof the invocations took the service path: each allowed by a team's service_invoke binding, on a board in
      // the service's scope, and no lane read a reply (a lane rotation would hand a lane its siblings' replies).
      const svcPosts = drivers.flatMap(d => d.final!.svcPosts), unproven = svcPosts.filter(id => !audit!.teamAllowed.has(id));
      if (svcPosts.length !== svcSent.size) failures.push(`${svcSent.size} invocations returned, ${svcPosts.length} with a post id`);
      if (unproven.length) failures.push(`${unproven.length} of ${svcPosts.length} invocations have no authz.decision row allowing service.invoke through a team's binding (e.g. posts ${unproven.slice(0, 5).join(", ")}; service.invoke rows by rule ${JSON.stringify(audit!.rules)})`);
      if (audit!.boardScope !== `service:${SERVICE}` || audit!.boardKind !== "queue") failures.push(`${SVC_BOARD} is scope ${audit!.boardScope}, kind ${audit!.boardKind}; want service:${SERVICE}, queue`);
    }
    // Proof the reads saw the service's board (#1511): every result named it, and the reads of its posts returned some (a
    // board_read's thread, every time: the invocation and its reply; a snapshot, once invocations have put posts there).
    const svcReads: Record<string, ReadProof> = Object.fromEntries(PROOF_OPS.map(op => [op, drivers.reduce((a, d) => {
      const p = d.final!.svcReads[op] ?? { ok: 0, named: 0, content: 0 };
      return { ok: a.ok + p.ok, named: a.named + p.named, content: a.content + p.content };
    }, { ok: 0, named: 0, content: 0 })]));
    for (const op of PROOF_OPS) {
      const p = svcReads[op]!;
      // The connect-time catalog is proved only on churn's reconnects, so it may have none; any it has must show the board.
      if (op === "catalog_connect") { if (o.serviceWorkers && p.named < p.ok) failures.push(`${p.ok - p.named} of ${p.ok} ${op} results didn't show ${SVC_BOARD}`); continue; }
      if (!wanted[op]) continue;
      if (!p.ok) failures.push(`no ${op} of ${SVC_BOARD} returned`);
      if (p.named < p.ok) failures.push(`${p.ok - p.named} of ${p.ok} ${op} results didn't show ${SVC_BOARD}`);
      if (op === "board_read" && p.content < p.ok) failures.push(`${p.ok - p.content} of ${p.ok} board_read threads of ${SVC_BOARD} lacked the invocation or its reply`);
      if (op === "snapshot" && o.svcShare > 0 && p.ok && !p.content) failures.push(`no snapshot of ${SVC_BOARD} carried a post`);
    }
    const laneEchoes = drivers.reduce((a, d) => a + d.final!.laneEcho, 0);
    if (laneEchoes) failures.push(`${laneEchoes} replies reached a service lane; want 0 (a reply goes to its invoker)`);
    // RSS and heap over the steady period.
    const rssSlope = slope(steady.map(w => [w.t, w.rss])), heapSlope = slope(steady.map(w => [w.t, w.heap]));
    const meanRss = steady.reduce((a, w) => a + w.rss, 0) / Math.max(1, steady.length);
    const steadyS = o.durationS - o.warmupS;
    const rssGrowth = rssSlope * steadyS;
    if (o.rssGate && rssGrowth > Math.max(0.1 * meanRss, 64 * 2 ** 20)) failures.push(`RSS grew ${(rssGrowth / 2 ** 20).toFixed(0)} MB over the steady ${steadyS} s (mean ${(meanRss / 2 ** 20).toFixed(0)} MB); want flat (< 10% or 64 MB)`);
    for (const [k, v] of Object.entries(drained)) if (v !== 0) failures.push(`after close, ${k} = ${v}; want 0`);
    const lagP99 = windows.filter(w => w.lag).map(w => w.lag!.p99);
    const queueSteady = steadyQueueS > 0 ? queueStats(steadyQueue, steadyQueueS) : null;

    const summary = {
      options: { ...o, server: o.server.join(" ") }, env, connected, windows: windows.length, steadyWindows: steady.length, cleanWindows: clean.length,
      toolSteady: Object.fromEntries(Object.entries(toolSteady).map(([t, x]) => [t, { count: x.count, fastShare: x.fast / x.count }])),
      toolSteadyAll: toolPool.count ? { count: toolPool.count, fastShare: toolPool.fast / toolPool.count } : null,
      clientSteady: Object.fromEntries(Object.entries(clientSteady).map(([op, h]) => [op, { count: h.count, fastShare: fastShare(h), p99Le: p99Edge(h), mean: h.sum / Math.max(1, h.count), errors: h.errors }])),
      dms: { sent: sent.size, received: recv.size, lost: lost.length }, misdelivered, posts, boardDeliveries: boardRecv,
      service: o.serviceWorkers ? { name: SERVICE, board: SVC_BOARD, workers: o.serviceWorkers, teams: o.teams, invocations: svcSent.size, reachedLane: svcGot.size, replied: svcDone.size, lost: svcLost.length, laneEchoes, teamAllowed: audit!.teamAllowed.size, rules: audit!.rules, boardScope: audit!.boardScope, reads: svcReads } : null,
      rss: { meanMB: meanRss / 2 ** 20, growthMB: rssGrowth / 2 ** 20, gated: o.rssGate }, heapGrowthMB: heapSlope * steadyS / 2 ** 20,
      lag: { windows: lagP99.length, p99Max: Math.max(0, ...lagP99), p99Median: lagP99.sort((a, b) => a - b)[Math.floor(lagP99.length / 2)] ?? null },
      drained, hostedRowsAfter: rows, refusals: refusedAll, clientErrors: erroredAll, queueSteady, pgLatencyMs: o.pgLatencyMs ?? null, failures,
    };
    writeFileSync(join(o.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    log(`summary: ${JSON.stringify({ connected, dms: summary.dms, posts, boardDeliveries: boardRecv, service: summary.service, rss: summary.rss, heapGrowthMB: summary.heapGrowthMB.toFixed(1), lag: summary.lag, hostedRowsAfter: rows })}`);
    if (queueSteady) {
      const q = queueSteady;
      log(`write queue, steady: ${q.bodiesPerS.toFixed(0)} bodies/s, busy ${(100 * q.busy).toFixed(1)}%, wait p50/p99 ${ms(q.wait.p50)}/${ms(q.wait.p99)} ms, hold p50/p99 ${ms(q.hold.p50)}/${ms(q.hold.p99)} ms, depth ≤ ${q.maxDepth ?? 0}, world stop ${(100 * q.worldStop).toFixed(1)}%, keyed ${(100 * q.keyed).toFixed(1)}%`);
      for (const [site, x] of Object.entries(q.sites).sort((a, b) => b[1].busy - a[1].busy)) log(`  ${site}: ${x.bodiesPerS.toFixed(1)}/s, busy ${(100 * x.busy).toFixed(1)}%, hold p50/p99 ${ms(x.hold.p50)}/${ms(x.hold.p99)} ms, wait p50/p99 ${ms(x.wait.p50)}/${ms(x.wait.p99)} ms, keyed ${(100 * x.keyed).toFixed(0)}%${x.statements === null ? "" : `, statements/body ${x.statements.toFixed(2)}, round trips/body ${x.roundTrips?.toFixed(2) ?? "-"}`}`);
      for (const [site, g] of Object.entries(q.gate)) log(`  gate fast path ${site}: keyed ${g.keyed}, miss ${g.miss}, skipped ${g.skipped}, miss rate ${g.missRate === null ? "-" : (100 * g.missRate).toFixed(2) + "%"}`);
      for (const [method, g] of Object.entries(q.gateMethods).sort((a, b) => (b[1].keyed + b[1].miss + b[1].skipped) - (a[1].keyed + a[1].miss + a[1].skipped))) log(`  gate bodies for ${method}: ${((g.keyed + g.miss + g.skipped) / steadyQueueS).toFixed(1)}/s (keyed ${g.keyed}, miss ${g.miss}, skipped ${g.skipped})`);
    }
    if (failures.length) { log(`FAIL (${failures.length}):`); for (const f of failures.slice(0, 50)) log(`  ${f}`); exitCode = 1; }
    else log("PASS");
  } catch (e) {
    log(`loadtest aborted: ${e instanceof Error ? e.stack ?? e.message : e}`);
    exitCode = 2;
    // What the windows measured before the abort (a saturated server can stall the close past its deadline): the
    // steady tool calls and write queue, so the run still has numbers. No gate was judged.
    const toolSteady: Record<string, { count: number; fast: number }> = {};
    for (const w of windows.filter(x => x.steady)) for (const [t, x] of Object.entries(w.tools)) { const a = toolSteady[t] ??= { count: 0, fast: 0 }; a.count += x.count; a.fast += x.fast; }
    const pool = Object.values(toolSteady).reduce((a, x) => ({ count: a.count + x.count, fast: a.fast + x.fast }), { count: 0, fast: 0 });
    writeFileSync(join(o.out, "summary.json"), JSON.stringify({
      aborted: e instanceof Error ? e.message : String(e), options: { ...o, server: o.server.join(" ") }, windows: windows.length, steadyWindows: windows.filter(x => x.steady).length,
      toolSteady: Object.fromEntries(Object.entries(toolSteady).map(([t, x]) => [t, { count: x.count, fastShare: x.fast / x.count }])),
      toolSteadyAll: pool.count ? { count: pool.count, fastShare: pool.fast / pool.count } : null,
      queueSteady: steadyQueueS > 0 ? queueStats(steadyQueue, steadyQueueS) : null, pgLatencyMs: o.pgLatencyMs ?? null,
    }, null, 2) + "\n");
  } finally {
    for (const d of drivers) if (!exited(d)) d.proc.kill("SIGKILL");
    if (srv) { await srv.stop(); writeFileSync(join(o.out, "server.log"), srv.log()); }
    proxy?.stop();
    if (!o.keepDb) {
      rmSync(scratch, { recursive: true, force: true });
      if (pgAdmin) await pgAdmin.unsafe(`DROP DATABASE IF EXISTS "${pgName}" WITH (FORCE)`).catch(e => log(`dropping ${pgName}: ${e instanceof Error ? e.message : e}`));
    } else log(`database kept: ${pgDbUrl ? `${pgName} (blobs ${blobDir})` : dbPath}`);
    await pgAdmin?.close();
  }
  process.exit(exitCode);
}

if (import.meta.main) await main();
