// scripts/loadtest.ts (#805): its sizing arithmetic, and a seconds-long run of the real coordinator,
// drivers and server that must pass its own gates, beside one the gates must fail. The small run carries the service
// traffic (#1258): workers on a run token, a queue board, invokers granted through teams.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capsEnv, options, parseMetrics, perUserRate, slope, tooSlow, userSessions } from "../../scripts/loadtest.ts";
import { DEFAULT_HOSTED_CAPS, DEFAULT_MCP_LIMITS } from "../../src/server/config.ts";
import { DEFAULT_HOSTED_REQUEST_LIMIT } from "../../src/server/rate_limit.ts";
import { runCli } from "../support/cli.ts";

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
    for (const argv of [[], ["--quick"], ["--users", "1", "--sessions", "400"], ["--sessions", "2", "--users", "2", "--drivers", "1"]]) {
      const env = capsEnv(options(argv));
      for (const [prefix, d] of Object.entries(floors)) {
        const global = Number(env[`${prefix}_GLOBAL`]), perUser = Number(env[`${prefix}_PER_USER`]);
        expect({ argv, prefix, global: global >= d.global, perUser: perUser >= Math.min(d.perUser, global), within: perUser <= global })
          .toEqual({ argv, prefix, global: true, perUser: true, within: true });
      }
    }
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
    }
    expect(() => options(["--sessions", "4", "--users", "3", "--drivers", "1", "--service-workers", "2"])).toThrow(/--service-workers/);
    expect(() => options(["--users", "2", "--teams", "3"])).toThrow(/--teams/);
    expect(() => options(["--post-share", "0.5", "--svc-share", "0.4", "--peer-share", "0.2"])).toThrow(/sum to at most 1/);
    expect(options(["--sessions", "4", "--users", "3", "--drivers", "1"]).serviceWorkers).toBe(1);
    expect(options(["--sessions", "2", "--users", "2", "--drivers", "1"]).serviceWorkers).toBe(0);
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

async function run(extra: string[]): Promise<{ code: number; out: string; summary: any }> {
  const dir = mkdtempSync(join(tmpdir(), "gb-loadtest-test-"));
  try {
    // runCli kills the whole process group on timeout: the coordinator, its drivers and the server.
    const { code, out, err } = await runCli([join(ROOT, "scripts/loadtest.ts"),
      "--sessions", "8", "--service-workers", "2", "--svc-share", "0.2", "--peer-share", "0.1", "--users", "2", "--drivers", "2", "--duration", "10", "--warmup", "2", "--window", "2",
      "--period", "1", "--boards", "2", "--post-share", "0.3", "--churn", "0.5", "--churn-every", "5", "--grace", "1",
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
    // Five windows; the first spans the warm-up, so four are steady (#1038).
    expect({ windows: r.summary.windows, steady: r.summary.steadyWindows }).toEqual({ windows: 5, steady: 4 });
    expect(r.summary.dms.sent).toBeGreaterThan(0);
    expect(r.summary.dms.lost).toBe(0);
    expect(r.summary.misdelivered).toBe(0);
    expect(r.summary.boardDeliveries).toBeGreaterThan(0);
    expect(Object.values(r.summary.drained)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.summary.hostedRowsAfter).toBe(0);
    // The service's paths ran and were measured: invocations (service.invoke, queueLanes) each reached a lane and came
    // back to their invoker; peer_list (alias.see_service) and the lanes' replies show up per op and per server tool.
    const svc = r.summary.service;
    expect(svc.invocations, r.out).toBeGreaterThan(0);
    expect({ reachedLane: svc.reachedLane, replied: svc.replied, lost: svc.lost }).toEqual({ reachedLane: svc.invocations, replied: svc.invocations, lost: 0 });
    for (const op of ["svc_invoke", "svc_reply", "svc_rtt", "peer_list"]) expect({ op, count: r.summary.clientSteady[op]?.count > 0 }).toEqual({ op, count: true });
    expect(r.summary.toolSteady.peer_list?.count).toBeGreaterThan(0);
  }, 90_000);

  test("a lease cap below the fleet fails the run and names why", async () => {
    const r = await run(["--env", "GRAYBOARD_DELIVERY_LEASES_PER_USER=2"]);
    expect(r.code, r.out).toBe(1);
    expect(r.summary.failures.join("\n")).toMatch(/only \d+ of 8 sessions connected/);
    expect(r.summary.failures.join("\n")).toMatch(/capacity refusals/);
  }, 90_000);
});
