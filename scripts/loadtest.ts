#!/usr/bin/env bun
// The hosted load test (#805): N leased hosted sessions against one server process, driven by K
// driver processes (scripts/loadtest_driver.ts), with the server's /metrics scraped every window.
//
//   bun scripts/loadtest.ts                 # the exit bar: 1,000 sessions for an hour
//   bun scripts/loadtest.ts --quick         # a minute's smoke at 40 sessions
//   bun scripts/loadtest.ts --sessions 500 --duration 900 --period 20
//
// Exit bar (#805): every session leased throughout; each steady window's native tool calls at
// p99 < 100 ms (at least 99% at or under the 0.1 s bucket edge: no interpolation); RSS flat over
// the steady period (the duration less its warm-up: an hour in the full profile); zero refusals,
// zero client errors, zero DM loss or misdelivery; and every gauge back to zero once the fleet has
// closed. A gate whose metric is missing fails rather than passes. The run writes windows.jsonl,
// server.log, drivers' stderr and summary.json to its run dir (.e2e-runs/loadtest-<time>/ unless
// --out), exits 1 on any miss and 2 when the run itself broke.
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
import { openDatabase } from "../src/server/db.ts";
import { OAUTH_TTL } from "../src/server/oauth-types.ts";
import { issueOAuth } from "../tests/helpers/oauth.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES } from "../tests/support/hosted_session.ts";
import { ServerProcess } from "../tests/support/server.ts";
import { BUCKETS, type DriverConfig, type DriverFinal, type DriverSession, type DriverWindow, type Hist } from "./loadtest_driver.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Options = {
  sessions: number; users: number; drivers: number; durationS: number; warmupS: number; periodS: number;
  boards: number; postShare: number; burst: number; churn: number; churnEveryS: number; windowS: number;
  graceS: number; server: string[]; out: string; keepDb: boolean; rssGate: boolean; env: Record<string, string>;
};

export function options(argv: string[]): Options {
  const { values: v } = parseArgs({
    args: argv, strict: true, options: {
      quick: { type: "boolean" }, sessions: { type: "string" }, users: { type: "string" }, drivers: { type: "string" },
      duration: { type: "string" }, warmup: { type: "string" }, period: { type: "string" }, boards: { type: "string" },
      "post-share": { type: "string" }, burst: { type: "string" }, churn: { type: "string" }, "churn-every": { type: "string" },
      window: { type: "string" }, grace: { type: "string" }, server: { type: "string" }, out: { type: "string" }, "keep-db": { type: "boolean" },
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
    server: v.server ? [resolve(v.server)] : [process.execPath, join(ROOT, "src/server/main.ts")],
    out: v.out ? resolve(v.out) : join(ROOT, ".e2e-runs", `loadtest-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    keepDb: v["keep-db"] === true,
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
  return o;
}

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

// The share of a client histogram at or under 0.1 s.
const fastShare = (h: { buckets: number[]; count: number }) => h.count ? h.buckets[BUCKETS.indexOf(0.1)]! / h.count : 1;
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
// at twice sessions per user the default cadence drew rate_limited). The per-user caps follow
// sessions per user. Never below a shipped default, and a per-user cap never above its global
// (the server refuses to start on that).
export function capsEnv(o: Options): Record<string, string> {
  const n = Math.ceil(o.sessions * 1.25), perUser = Math.ceil(Math.ceil(o.sessions / o.users) * 1.25);
  const pair = (prefix: string, d: { global: number; perUser: number }, scoped = perUser) => {
    const global = Math.max(n, d.global);
    return { [`${prefix}_GLOBAL`]: String(global), [`${prefix}_PER_USER`]: String(Math.min(global, Math.max(scoped, d.perUser))) };
  };
  return {
    ...pair("GRAYBOARD_HOSTED_SESSIONS", DEFAULT_HOSTED_CAPS.sessions), ...pair("GRAYBOARD_DELIVERY_LEASES", DEFAULT_HOSTED_CAPS.leases),
    ...pair("GRAYBOARD_MCP_LISTEN", DEFAULT_MCP_LIMITS.listen), ...pair("GRAYBOARD_MCP_POST", DEFAULT_MCP_LIMITS.post, perUser * 4),
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
// post reaches its board's other subscribers.
export function perUserRate(o: Options): { tools: number; subscriber: number; total: number } {
  const subscribers = Math.max(0, o.sessions / o.boards - 1);
  const perUser = o.sessions / o.users;
  const tools = perUser / o.periodS;
  const subscriber = perUser * (0.2 + (1 / o.periodS) * 3 * ((1 - o.postShare) + o.postShare * subscribers));
  return { tools, subscriber, total: tools + subscriber };
}

type Window = {
  at: number; t: number; steady: boolean; churning: boolean; rss: number; heap: number; lag?: { p50: number; p99: number; max: number };
  leases: number; listens: number; holding: number; live: number; refusals: Record<string, number>;
  tools: Record<string, { count: number; fast: number }>; client: Record<string, Hist>; clientErrors: Record<string, number>;
  driverLagP99: number; ops: number; loadavg: number[];
};

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "gb-loadtest-"));
  const dbPath = join(scratch, "grayboard.db");
  const log = (s: string) => { console.log(s); appendFileSync(join(o.out, "run.log"), s + "\n"); };
  log(`loadtest: ${o.sessions} sessions, ${o.users} users, ${o.drivers} drivers, ${o.durationS}s (${o.warmupS}s warm-up), op every ${o.periodS}s, ${o.boards} boards (~${Math.round(o.sessions / o.boards)} subscribers each), post share ${o.postShare}, burst ${o.burst}, churn ${o.churn} every ${o.churnEveryS}s; ${cpus().length} CPUs, load ${loadavg().map(x => x.toFixed(2)).join(" ")}`);
  log(`run dir: ${o.out}`);

  const caps = capsEnv(o);
  const env = { ...caps, ...o.env, GRAYBOARD_METRICS_ADDR: "127.0.0.1:0", HOME: join(scratch, "home") };
  mkdirSync(env.HOME, { recursive: true });
  log(`server env: ${Object.entries(env).filter(([k]) => k !== "HOME").map(([k, v]) => `${k}=${v}`).join(" ")} (about ${perUserRate(o).tools.toFixed(1)} tool and ${perUserRate(o).subscriber.toFixed(1)} delivery requests/s per user)`);
  type Driver = { proc: ReturnType<typeof Bun.spawn>; windows: DriverWindow[]; ready?: { live: number; want: number }; final?: DriverFinal; churned: number; quiesced: boolean; read: Promise<void> };
  const drivers: Driver[] = [];
  const failures: string[] = [];
  const windows: Window[] = [];
  let exitCode = 0;
  let srv: ServerProcess | undefined;
  // A driver killed by a signal (the scope's OOM killer) keeps a null exitCode.
  const exited = (d: Driver) => d.proc.exitCode !== null || d.proc.signalCode !== null;
  try {
    srv = await ServerProcess.start(o.server, dbPath, env);
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
    const { db, repo } = openDatabase(dbPath, { blobDir: join(scratch, "blobs") });
    const resource = "http://localhost/mcp";
    const users = Array.from({ length: o.users }, (_, u) => {
      const email = `load${u}@example.com`;
      return { email, token: issueOAuth(repo, resource, email, HOSTED_SCOPES, issuedAt, HOSTED_CLIENT).token };
    });
    db.close();

    const scrape = async () => parseMetrics(await (await fetch(metricsUrl!)).text());

    // Sessions: index i belongs to user i % U and driver i % K, binds load-<i>, subscribes board i % B.
    const specs: DriverSession[] = Array.from({ length: o.sessions }, (_, i) => {
      const u = users[i % o.users]!, name = `load-${i}`;
      return { index: i, email: u.email, token: u.token, name, address: `${u.email}/${name}`, board: `load-${i % o.boards}` };
    });
    const addresses = specs.map(s => s.address);

    for (let k = 0; k < o.drivers; k++) {
      const config: DriverConfig = {
        driver: k, url: `${server.base}/mcp`, sessions: specs.filter(s => s.index % o.drivers === k), addresses,
        periodMs: o.periodS * 1000, postShare: o.postShare, burst: Math.max(1, Math.ceil(o.burst / o.drivers)),
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
    if (connected !== o.sessions) failures.push(`only ${connected} of ${o.sessions} sessions connected`);

    // The load: a scrape per window; a churn wave every churnEveryS.
    const start = Date.now(), end = start + o.durationS * 1000;
    let prev = await scrape(), prevTools = toolCumulative(prev), prevRef = refusalsTotal(prev);
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
      const w: Window = {
        at: now, t: (now - start) / 1000, steady: now - start >= o.warmupS * 1000, churning: now < churnUntil,
        rss: one(s, "grayboard_process_resident_memory_bytes") ?? -1, heap: one(s, "grayboard_process_heap_used_bytes") ?? -1,
        ...(lagSamples.every(x => x !== undefined) ? { lag: { p50: lagSamples[0]!, p99: lagSamples[1]!, max: lagSamples[2]! } } : {}),
        leases: one(s, "grayboard_delivery_leases") ?? -1, listens: one(s, "grayboard_mcp_admissions", { kind: "listen" }) ?? -1,
        holding: one(s, "grayboard_hosted_sessions_holding") ?? -1, live, refusals, tools, client, clientErrors, driverLagP99,
        ops: (client.dm_send?.count ?? 0) + (client.board_post?.count ?? 0), loadavg: loadavg(),
      };
      windows.push(w);
      appendFileSync(join(o.out, "windows.jsonl"), JSON.stringify(w) + "\n");
      const toolAll = Object.values(tools).reduce((a, x) => ({ count: a.count + x.count, fast: a.fast + x.fast }), { count: 0, fast: 0 });
      log(`t=${w.t.toFixed(0)}s${w.steady ? "" : " (warm-up)"}${w.churning ? " (churn)" : ""} leases=${w.leases} listens=${w.listens} live=${w.live} rss=${(w.rss / 2 ** 20).toFixed(0)}MB heap=${(w.heap / 2 ** 20).toFixed(0)}MB lag.p99=${w.lag ? (w.lag.p99 * 1000).toFixed(1) : "-"}ms tools=${toolAll.count} (${(100 * (toolAll.count ? toolAll.fast / toolAll.count : 1)).toFixed(2)}% ≤100ms) ops=${w.ops} inbox≤100ms=${client.inbox ? (100 * fastShare(client.inbox)).toFixed(2) : "-"}% drvlag=${(driverLagP99 * 1000).toFixed(0)}ms load=${w.loadavg[0]!.toFixed(1)}${Object.keys(refusals).length ? ` REFUSED ${JSON.stringify(refusals)}` : ""}${Object.keys(clientErrors).length ? ` ERRORS ${JSON.stringify(clientErrors)}` : ""}`);
      prev = s; prevTools = toolCumulative(s); prevRef = ref;
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
    const ro = new Database(dbPath, { readonly: true });
    const rows = (ro.query("SELECT count(*) AS n FROM hosted_sessions").get() as { n: number }).n;
    ro.close();

    // Gates.
    const steady = windows.filter(w => w.steady);
    if (!steady.length) failures.push("no steady window");
    const target = o.sessions * o.windowS / o.periodS;
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
    const opsWindows = steady.filter(w => !w.churning), opsPool = opsWindows.reduce((a, w) => a + w.ops, 0);
    if (opsWindows.length && opsPool < 0.8 * target * opsWindows.length) failures.push(`${opsPool} ops over ${opsWindows.length} steady windows; want ≥ 80% of ${(target * opsWindows.length).toFixed(0)}`);
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
    for (const op of ["inbox", "renew", "receipt", "dm_send", "board_post"]) {
      const h = clientSteady[op];
      if (!h && clean.length && (op !== "board_post" || o.postShare > 0)) failures.push(`client ${op}: no samples in the clean steady windows`);
      if (h && h.count >= 100 && fastShare(h) < 0.99) failures.push(`client ${op}: ${(100 * fastShare(h)).toFixed(2)}% of ${h.count} at ≤ 100 ms (clean steady windows)`);
    }
    // Refusals since the server started, connect and close included: the windows see only the load.
    const refusedAll = Object.fromEntries(Object.entries(refusalsTotal(after)).filter(([, v]) => v > 0));
    const erroredAll: Record<string, number> = {};
    for (const w of windows) for (const [k, v] of Object.entries(w.clientErrors)) erroredAll[k] = (erroredAll[k] ?? 0) + v;
    for (const d of drivers) for (const [k, v] of Object.entries(d.final!.errors)) erroredAll[k] = Math.max(erroredAll[k] ?? 0, v);
    if (Object.keys(refusedAll).length) failures.push(`capacity refusals: ${JSON.stringify(refusedAll)}`);
    if (Object.keys(erroredAll).length) failures.push(`client errors: ${JSON.stringify(erroredAll)}`);
    // DM accounting: every DM a send call returned for reached its recipient's lease.
    const sent = new Set(drivers.flatMap(d => d.final!.sentDm)), recv = new Set(drivers.flatMap(d => d.final!.recvDm));
    const lost = [...sent].filter(id => !recv.has(id));
    if (!sent.size) failures.push("no DM was sent");
    if (lost.length) failures.push(`${lost.length} of ${sent.size} DMs never reached their recipient (e.g. ${lost.slice(0, 5).join(", ")})`);
    // Every undelivered id ("sender:seq", the body's `lt|dm|<sender>|<seq>|...`), for classifying against a --keep-db database (#942).
    if (lost.length) writeFileSync(join(o.out, "lost-dms.json"), JSON.stringify(lost) + "\n");
    const misdelivered = drivers.reduce((a, d) => a + d.final!.misdelivered, 0);
    if (misdelivered) failures.push(`${misdelivered} deliveries reached the wrong session (e.g. ${drivers.flatMap(d => d.final!.misdeliveredFirst).slice(0, 5).join("; ")})`);
    const posts = drivers.reduce((a, d) => a + d.final!.posts, 0), boardRecv = drivers.reduce((a, d) => a + d.final!.boardRecv, 0);
    if (o.postShare > 0 && !boardRecv) failures.push(`${posts} board posts, none delivered`);
    // RSS and heap over the steady period.
    const rssSlope = slope(steady.map(w => [w.t, w.rss])), heapSlope = slope(steady.map(w => [w.t, w.heap]));
    const meanRss = steady.reduce((a, w) => a + w.rss, 0) / Math.max(1, steady.length);
    const steadyS = o.durationS - o.warmupS;
    const rssGrowth = rssSlope * steadyS;
    if (o.rssGate && rssGrowth > Math.max(0.1 * meanRss, 64 * 2 ** 20)) failures.push(`RSS grew ${(rssGrowth / 2 ** 20).toFixed(0)} MB over the steady ${steadyS} s (mean ${(meanRss / 2 ** 20).toFixed(0)} MB); want flat (< 10% or 64 MB)`);
    for (const [k, v] of Object.entries(drained)) if (v !== 0) failures.push(`after close, ${k} = ${v}; want 0`);
    const lagP99 = windows.filter(w => w.lag).map(w => w.lag!.p99);

    const summary = {
      options: { ...o, server: o.server.join(" ") }, env, connected, windows: windows.length, steadyWindows: steady.length, cleanWindows: clean.length,
      toolSteady: Object.fromEntries(Object.entries(toolSteady).map(([t, x]) => [t, { count: x.count, fastShare: x.fast / x.count }])),
      clientSteady: Object.fromEntries(Object.entries(clientSteady).map(([op, h]) => [op, { count: h.count, fastShare: fastShare(h), mean: h.sum / Math.max(1, h.count), errors: h.errors }])),
      dms: { sent: sent.size, received: recv.size, lost: lost.length }, misdelivered, posts, boardDeliveries: boardRecv,
      rss: { meanMB: meanRss / 2 ** 20, growthMB: rssGrowth / 2 ** 20, gated: o.rssGate }, heapGrowthMB: heapSlope * steadyS / 2 ** 20,
      lag: { windows: lagP99.length, p99Max: Math.max(0, ...lagP99), p99Median: lagP99.sort((a, b) => a - b)[Math.floor(lagP99.length / 2)] ?? null },
      drained, hostedRowsAfter: rows, refusals: refusedAll, clientErrors: erroredAll, failures,
    };
    writeFileSync(join(o.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    log(`summary: ${JSON.stringify({ connected, dms: summary.dms, posts, boardDeliveries: boardRecv, rss: summary.rss, heapGrowthMB: summary.heapGrowthMB.toFixed(1), lag: summary.lag, hostedRowsAfter: rows })}`);
    if (failures.length) { log(`FAIL (${failures.length}):`); for (const f of failures.slice(0, 50)) log(`  ${f}`); exitCode = 1; }
    else log("PASS");
  } catch (e) {
    log(`loadtest aborted: ${e instanceof Error ? e.stack ?? e.message : e}`);
    exitCode = 2;
  } finally {
    for (const d of drivers) if (!exited(d)) d.proc.kill("SIGKILL");
    if (srv) { await srv.stop(); writeFileSync(join(o.out, "server.log"), srv.log()); }
    if (!o.keepDb) rmSync(scratch, { recursive: true, force: true });
    else log(`database kept: ${dbPath}`);
  }
  process.exit(exitCode);
}

if (import.meta.main) await main();
