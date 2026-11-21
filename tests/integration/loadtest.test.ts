// scripts/loadtest.ts (#805): its sizing arithmetic, and a seconds-long run of the real coordinator,
// drivers and server that must pass its own gates, beside one the gates must fail. The small run carries the service
// traffic (#1258): workers on a run token, a queue board, invokers granted through teams.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capsEnv, options, parseMetrics, perUserRate, combineQueue, quantile, queueCumulative, queueStats, slope, tooSlow, userSessions } from "../../scripts/loadtest.ts";
import { DEFAULT_HOSTED_CAPS, DEFAULT_MCP_LIMITS } from "../../src/server/config.ts";
import { DEFAULT_HOSTED_REQUEST_LIMIT } from "../../src/server/rate_limit.ts";
import { runCli } from "../support/cli.ts";
import { SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { ServerUnreachable } from "../../adapters/hosted-core/src/wire.ts";
import { errorClass } from "../../scripts/loadtest_errors.ts";

const ROOT = resolve(import.meta.dir, "../..");

describe("loadtest sizing", () => {
  test("the full profile fits both default per-user request buckets; the quick one raises the subscriber one", () => {
    const full = options([]);
    expect(perUserRate(full).total).toBeLessThan(10);
    expect(capsEnv(full).GRAYBOARD_HOSTED_REQUEST_PER_SEC).toBeUndefined();
    expect(capsEnv(full).GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC).toBeUndefined();
    const quick = options(["--quick"]);
    expect(Number(capsEnv(quick).GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC)).toBeGreaterThanOrEqual(Math.ceil(perUserRate(quick).subscriber * 2));
    // Tool calls alone stay inside their default bucket even in the quick profile.
    expect(perUserRate(quick).tools * 2).toBeLessThanOrEqual(DEFAULT_HOSTED_REQUEST_LIMIT.perSec);
    expect(capsEnv(quick).GRAYBOARD_HOSTED_REQUEST_PER_SEC).toBeUndefined();
    // The caps cover the fleet with headroom, never below the shipped floors.
    expect(Number(capsEnv(full).GRAYBOARD_DELIVERY_LEASES_GLOBAL)).toBe(1250);
    expect(Number(capsEnv(quick).GRAYBOARD_DELIVERY_LEASES_GLOBAL)).toBe(256);
  });

  test("capsEnv never lowers a shipped default, and no per-user cap exceeds its global", () => {
    const floors: Record<string, { global: number; perUser: number }> = {
      GRAYBOARD_HOSTED_SESSIONS: DEFAULT_HOSTED_CAPS.sessions, GRAYBOARD_DELIVERY_LEASES: DEFAULT_HOSTED_CAPS.leases,
      GRAYBOARD_MCP_LISTEN: DEFAULT_MCP_LIMITS.listen, GRAYBOARD_MCP_POST: DEFAULT_MCP_LIMITS.post,
    };
    for (const argv of [[], ["--quick"], ["--users", "1", "--sessions", "400"], ["--sessions", "2", "--users", "2", "--drivers", "1", "--service-workers", "0"]]) {
      const env = capsEnv(options(argv));
      for (const [prefix, d] of Object.entries(floors)) {
        const global = Number(env[`${prefix}_GLOBAL`]), perUser = Number(env[`${prefix}_PER_USER`]);
        expect({ argv, prefix, global: global >= d.global, perUser: perUser >= Math.min(d.perUser, global), within: perUser <= global })
          .toEqual({ argv, prefix, global: true, perUser: true, within: true });
      }
    }
  });

  test("the POST caps leave every listener its slot and a connect's two wires theirs (#1532)", () => {
    for (const argv of [[], ["--quick"], ["--sessions", "300", "--service-workers", "0"], ["--users", "1", "--sessions", "400"]]) {
      const o = options(argv), env = capsEnv(o);
      // A listen holds a POST slot for its stream's life; a connect POSTs discover from both wires at once.
      expect({ argv, fits: Number(env.GRAYBOARD_MCP_POST_GLOBAL) >= Number(env.GRAYBOARD_MCP_LISTEN_GLOBAL) + 2 * o.sessions }).toEqual({ argv, fits: true });
    }
  });

  test("a client error is classed by its cause chain: the SDK's code, an HTTP status and a capacity 429's body (#1532)", () => {
    const capacity = new SdkHttpError(SdkErrorCode.EraNegotiationFailed, "probe", { status: 429, statusText: "Too Many Requests", text: "MCP request capacity reached" });
    expect(errorClass(new SdkError(SdkErrorCode.EraNegotiationFailed, "Version negotiation probe failed", undefined, { cause: capacity }))).toBe("SdkError(ERA_NEGOTIATION_FAILED)<http_429(MCP request capacity reached)");
    expect(errorClass(new ServerUnreachable(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")))).toBe("ServerUnreachable<SdkError(REQUEST_TIMEOUT)");
    // A JSON body is the server's structured refusal, not a capacity line: the status alone.
    expect(errorClass(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "x", { status: 503, text: "{\"code\":\"internal\"}" }))).toBe("http_503");
    expect(errorClass(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("Error(ECONNRESET)");
    expect(errorClass("boom")).toBe("string");
  });

  test("slope is least squares in units per second", () => {
    expect(slope([[0, 10], [10, 30], [20, 50]])).toBeCloseTo(2);
    expect(slope([[0, 50], [10, 30], [20, 10]])).toBeCloseTo(-2);
    expect(slope([[0, 7], [60, 7]])).toBe(0);
    expect(slope([[5, 1]])).toBe(0);
  });

  test("the pooled latency gate allows 1% slow calls rounded up, so a small pool tolerates one", () => {
    expect(tooSlow(80, 79)).toBe(false);
    expect(tooSlow(80, 78)).toBe(true);
    expect(tooSlow(1000, 990)).toBe(false);
    expect(tooSlow(1000, 989)).toBe(true);
    expect(tooSlow(1050, 1039)).toBe(false);
    expect(tooSlow(1050, 1038)).toBe(true);
    // A fraction under .5: ceil, not round (1040 allows 11, round would allow 10).
    expect(tooSlow(1040, 1029)).toBe(false);
    expect(tooSlow(1040, 1028)).toBe(true);
    expect(tooSlow(0, 0)).toBe(false);
  });

  test("service traffic is in every profile; the workers come out of the sessions, the teams never exceed the users", () => {
    for (const [argv, workers, teams] of [[[], 4, 10], [["--quick"], 2, 2], [["--users", "3", "--sessions", "40"], 4, 3]] as const) {
      const o = options([...argv]);
      expect({ argv, workers: o.serviceWorkers, teams: o.teams, users: userSessions(o) }).toEqual({ argv, workers, teams, users: o.sessions - workers });
      expect(o.svcShare).toBeGreaterThan(0);
      expect(o.peerShare).toBeGreaterThan(0);
      expect(o.readShare).toBeGreaterThan(0);
    }
    expect(() => options(["--sessions", "4", "--users", "3", "--drivers", "1", "--service-workers", "2"])).toThrow(/--service-workers/);
    expect(() => options(["--users", "2", "--teams", "3"])).toThrow(/--teams/);
    expect(() => options(["--post-share", "0.5", "--svc-share", "0.4", "--peer-share", "0.2"])).toThrow(/sum to at most 1/);
    expect(() => options(["--post-share", "0.5", "--svc-share", "0.2", "--peer-share", "0.2", "--read-share", "0.2"])).toThrow(/sum to at most 1/);
    expect(options(["--sessions", "4", "--users", "3", "--drivers", "1"]).serviceWorkers).toBe(1);
    // A fleet that leaves no room for a worker is refused unless the service is turned off explicitly.
    expect(() => options(["--sessions", "2", "--users", "2", "--drivers", "1"])).toThrow(/no room for a service worker.*--service-workers 0/);
    expect(options(["--sessions", "2", "--users", "2", "--drivers", "1", "--service-workers", "0"]).serviceWorkers).toBe(0);
    expect(options(["--service-workers", "0", "--post-share", "0.9", "--svc-share", "0.5"]).serviceWorkers).toBe(0);
  });

  test("--env overrides parse, and a malformed one is refused", () => {
    expect(options(["--env", "A=1", "--env", "B=x=y"]).env).toEqual({ A: "1", B: "x=y" });
    expect(() => options(["--env", "nope"])).toThrow(/KEY=VALUE/);
  });

  test("parseMetrics reads labels, escapes and +Inf", () => {
    const s = parseMetrics('# HELP x y\nfoo_total{kind="a\\"b",le="+Inf"} 3\nbar 1.5\nbaz{le="0.1"} +Inf\n');
    expect(s).toEqual([
      { name: "foo_total", labels: { kind: 'a"b', le: "+Inf" }, value: 3 },
      { name: "bar", labels: {}, value: 1.5 },
      { name: "baz", labels: { le: "0.1" }, value: Infinity },
    ]);
  });
});

describe("loadtest write-queue report (#1510)", () => {
  // Two scrapes' worth of exposition, in the server's format: hold by site, wait by site, depth.
  const expo = (holdCum: number[], holdSum: number, depthCum: number[], keyed = 0, stop = 0, gate: [number, number, number] = [0, 0, 0]) => [
    ...["0.001", "0.002", "0.004", "+Inf"].map((le, i) => `grayboard_write_queue_hold_seconds_bucket{site="gate",le="${le}"} ${holdCum[i]}`),
    `grayboard_write_queue_hold_seconds_sum{site="gate"} ${holdSum}`, `grayboard_write_queue_hold_seconds_count{site="gate"} ${holdCum[3]}`,
    ...["0.001", "0.002", "0.004", "+Inf"].map((le, i) => `grayboard_write_queue_wait_seconds_bucket{site="gate",le="${le}"} ${holdCum[i]}`),
    `grayboard_write_queue_wait_seconds_sum{site="gate"} ${holdSum / 2}`, `grayboard_write_queue_wait_seconds_count{site="gate"} ${holdCum[3]}`,
    ...["0", "1", "2", "+Inf"].map((le, i) => `grayboard_write_queue_depth_bucket{le="${le}"} ${depthCum[i]}`),
    `grayboard_write_queue_depth_sum 0`, `grayboard_write_queue_depth_count ${depthCum[3]}`,
    `grayboard_write_queue_keyed_bodies_total{site="gate"} ${keyed}`, `grayboard_write_queue_world_stop_seconds_total ${stop}`,
    ...(["keyed", "miss", "skipped"] as const).map((o, i) => `grayboard_hosted_gate_bodies_total{site="gate",outcome="${o}"} ${gate[i]}`),
  ].join("\n");

  test("quantiles interpolate within a bucket, and one past the last edge reads as that edge", () => {
    const h = { le: [0.001, 0.002, Infinity], cum: [50, 100, 101], sum: 0, count: 101 };
    expect(quantile(h, 0.25)).toBeCloseTo(0.000505, 6);
    expect(quantile(h, 0.75)).toBeCloseTo(0.001515, 6);
    expect(quantile(h, 1)).toBe(0.002);
    expect(quantile({ le: [1, Infinity], cum: [0, 0], sum: 0, count: 0 }, 0.5)).toBeNull();
  });

  test("a window's numbers come from the deltas between two scrapes", () => {
    const a = queueCumulative(parseMetrics(expo([10, 10, 10, 10], 0.005, [3, 3, 3, 3], 4, 0.5, [2, 1, 5])));
    const b = queueCumulative(parseMetrics(expo([10, 60, 110, 110], 0.205, [3, 5, 7, 7], 29, 1.3, [20, 4, 9])));
    const q = queueStats(combineQueue(b, a, -1), 2);
    expect(q.bodies).toBe(100);
    expect(q.bodiesPerS).toBe(50);
    expect(q.busy).toBeCloseTo(0.1, 9);
    expect(q.hold.p50).toBeCloseTo(0.002, 9);
    expect(q.hold.mean).toBeCloseTo(0.002, 9);
    expect(q.maxDepth).toBe(2);
    expect(Object.keys(q.sites)).toEqual(["gate"]);
    // 25 of the window's 100 bodies ran keyed; 0.8 s of its 2 s were a world stop (#1510 chunk 2).
    expect(q.keyed).toBeCloseTo(0.25, 9);
    expect(q.sites.gate!.keyed).toBeCloseTo(0.25, 9);
    expect(q.worldStop).toBeCloseTo(0.4, 9);
    // The gate's fast path in the window: 18 keyed, 3 missed, 4 skipped; 3 of 21 attempts missed (#1510 chunk 3).
    expect(q.gate).toEqual({ gate: { keyed: 18, miss: 3, skipped: 4, missRate: 3 / 21 } });
  });

  // #1537 PR 0. Mutations: the gate line summing replaced by a set (gate.keyed reads one method's); statements per body
  // over the window's bodies dropped for the cumulative (reads 9, not 10).
  test("statements and round trips per body per site, and the gate's bodies by method, come from the window's deltas", () => {
    const expo2 = (holdCount: number, st: [number, number], rt: number, sel: number, renew: number) => [
      `grayboard_write_queue_hold_seconds_bucket{site="gate",le="+Inf"} ${holdCount}`, `grayboard_write_queue_hold_seconds_sum{site="gate"} 0.1`, `grayboard_write_queue_hold_seconds_count{site="gate"} ${holdCount}`,
      `grayboard_write_queue_statements_bucket{site="gate",le="+Inf"} ${st[1]}`, `grayboard_write_queue_statements_sum{site="gate"} ${st[0]}`, `grayboard_write_queue_statements_count{site="gate"} ${st[1]}`,
      `grayboard_write_queue_round_trips_sum{site="gate"} ${rt}`, `grayboard_write_queue_round_trips_count{site="gate"} ${st[1]}`,
      `grayboard_hosted_gate_bodies_total{site="gate",method="selection",outcome="keyed"} ${sel}`,
      `grayboard_hosted_gate_bodies_total{site="gate",method="renew",outcome="keyed"} ${renew}`,
      `grayboard_hosted_gate_bodies_total{site="gate",method="pending",outcome="miss"} 0`,
      `grayboard_hosted_gate_bodies_total{site="prior",method="receipt",outcome="keyed"} ${renew}`,
    ].join("\n");
    const a = queueCumulative(parseMetrics(expo2(10, [90, 10], 80, 4, 2)));
    const b = queueCumulative(parseMetrics(expo2(30, [290, 30], 260, 14, 12)));
    const q = queueStats(combineQueue(b, a, -1), 2);
    // 200 statements and 180 round trips over the window's 20 bodies.
    expect(q.sites.gate!.statements).toBe(10);
    expect(q.sites.gate!.roundTrips).toBe(9);
    expect(q.gate.gate).toMatchObject({ keyed: 20, miss: 0 });
    // The prior site's by method as `prior.<method>` (#1537 C5/C7).
    expect(q.gateMethods).toEqual({ selection: { keyed: 10, miss: 0, skipped: 0 }, renew: { keyed: 10, miss: 0, skipped: 0 }, "prior.receipt": { keyed: 10, miss: 0, skipped: 0 } });
    // A site with no statement series (SQLite) reads null.
    expect(queueStats(queueCumulative(parseMetrics(expo([10, 10, 10, 10], 0.005, [3, 3, 3, 3]))), 1).sites.gate!.statements).toBeNull();
  });

  test("--pg-latency needs --pg", () => {
    expect(() => options(["--pg-latency", "1"])).toThrow("--pg-latency needs --pg");
    expect(options(["--pg", "postgres://x@127.0.0.1:5432/postgres", "--pg-latency", "0.25"]).pgLatencyMs).toBe(0.25);
    expect(options([]).pgLatencyMs).toBeUndefined();
  });
});

async function run(extra: string[]): Promise<{ code: number; out: string; summary: any }> {
  const dir = mkdtempSync(join(tmpdir(), "gb-loadtest-test-"));
  try {
    // runCli kills the whole process group on timeout: the coordinator, its drivers and the server.
    const { code, out, err } = await runCli([join(ROOT, "scripts/loadtest.ts"),
      "--sessions", "8", "--service-workers", "2", "--svc-share", "0.2", "--peer-share", "0.1", "--read-share", "0.3", "--users", "2", "--drivers", "2", "--duration", "14", "--warmup", "2", "--window", "2",
      "--period", "1", "--boards", "2", "--post-share", "0.2", "--churn", "0.5", "--churn-every", "5", "--grace", "1",
      "--out", dir, ...extra], { bin: process.execPath, cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60_000 });
    let summary: any;
    try { summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")); } catch { summary = undefined; }
    return { code, out: out + err, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadtest run", () => {
  test("a small fleet with churn passes every gate and drains to zero", async () => {
    const r = await run([]);
    expect({ code: r.code, failures: r.summary?.failures }, r.out).toEqual({ code: 0, failures: [] });
    // Seven windows; the first spans the warm-up, so six are steady (#1038).
    expect({ windows: r.summary.windows, steady: r.summary.steadyWindows }).toEqual({ windows: 7, steady: 6 });
    expect(r.summary.dms.sent).toBeGreaterThan(0);
    expect(r.summary.dms.lost).toBe(0);
    expect(r.summary.misdelivered).toBe(0);
    expect(r.summary.boardDeliveries).toBeGreaterThan(0);
    expect(Object.values(r.summary.drained)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.summary.hostedRowsAfter).toBe(0);
    // The server's write queue, over the steady period (#1510): every hosted call goes through the gate.
    expect(r.summary.queueSteady.bodies).toBeGreaterThan(0);
    expect(r.summary.queueSteady.busy).toBeGreaterThan(0);
    expect(r.summary.queueSteady.busy).toBeLessThan(1);
    expect(r.summary.queueSteady.sites.gate.bodies).toBeGreaterThan(0);
    // The service's paths ran and were measured: invocations (service.invoke, queueLanes) each reached a lane and came
    // back to their invoker; peer_list (alias.see_service) and the lanes' replies show up per op and per server tool.
    const svc = r.summary.service;
    expect(svc.invocations, r.out).toBeGreaterThan(0);
    expect({ reachedLane: svc.reachedLane, replied: svc.replied, lost: svc.lost }).toEqual({ reachedLane: svc.invocations, replied: svc.invocations, lost: 0 });
    // The server's record: each invocation allowed through a team's binding, on the service's queue board.
    expect({ teamAllowed: svc.teamAllowed, boardScope: svc.boardScope, laneEchoes: svc.laneEchoes }).toEqual({ teamAllowed: svc.invocations, boardScope: "service:loadsvc", laneEchoes: 0 });
    for (const op of ["svc_invoke", "svc_reply", "svc_rtt", "peer_list"]) expect({ op, count: r.summary.clientSteady[op]?.count > 0 }).toEqual({ op, count: true });
    expect(r.summary.toolSteady.peer_list?.count).toBeGreaterThan(0);
    // The service board's other canSee sites (#1511): board_list, board_read, the snapshot and the catalog each ran as
    // its own op, and each result showed the board (the reads of its posts, some posts).
    for (const op of ["board_list", "board_read", "snapshot", "catalog"]) {
      expect({ op, count: r.summary.clientSteady[op]?.count > 0 }).toEqual({ op, count: true });
      const p = svc.reads[op];
      expect({ op, ok: p.ok > 0, named: p.named, content: op === "snapshot" ? p.content > 0 : p.content }).toEqual({ op, ok: true, named: p.ok, content: op === "snapshot" ? true : p.ok });
    }
    expect(svc.reads.catalog_connect.named).toBe(svc.reads.catalog_connect.ok);
  }, 90_000);

  test("with no invocations the reads still rotate: board_list, the snapshot and the catalog each run and see the board", async () => {
    const r = await run(["--svc-share", "0"]);
    expect({ code: r.code, failures: r.summary?.failures }, r.out).toEqual({ code: 0, failures: [] });
    const svc = r.summary.service;
    expect(svc.invocations).toBe(0);
    for (const op of ["board_list", "snapshot", "catalog"]) {
      expect({ op, count: r.summary.clientSteady[op]?.count > 0 }).toEqual({ op, count: true });
      const p = svc.reads[op];
      expect({ op, ok: p.ok > 0, named: p.named }).toEqual({ op, ok: true, named: p.ok });
    }
    // board_read has no answered thread to read, so it never runs.
    expect({ steady: r.summary.clientSteady.board_read, proved: svc.reads.board_read.ok }).toEqual({ steady: undefined, proved: 0 });
  }, 90_000);

  test("a lease cap below the fleet fails the run and names why", async () => {
    const r = await run(["--env", "GRAYBOARD_DELIVERY_LEASES_PER_USER=2"]);
    expect(r.code, r.out).toBe(1);
    expect(r.summary.failures.join("\n")).toMatch(/only \d+ of 8 sessions connected/);
    expect(r.summary.failures.join("\n")).toMatch(/capacity refusals/);
  }, 90_000);
});
