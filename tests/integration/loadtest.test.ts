// scripts/loadtest.ts (#805): its sizing arithmetic, and a seconds-long run of the real coordinator,
// drivers and server that must pass its own gates, beside one the gates must fail.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capsEnv, options, parseMetrics, perUserRate, slope } from "../../scripts/loadtest.ts";
import { DEFAULT_HOSTED_CAPS, DEFAULT_MCP_LIMITS } from "../../src/server/config.ts";
import { runCli } from "../support/cli.ts";

const ROOT = resolve(import.meta.dir, "../..");

describe("loadtest sizing", () => {
  test("the full profile fits the default per-user request bucket; the quick one raises it", () => {
    const full = options([]);
    expect(perUserRate(full)).toBeLessThan(10);
    expect(capsEnv(full).GRAYBOARD_HOSTED_REQUEST_PER_SEC).toBeUndefined();
    const quick = options(["--quick"]);
    expect(Number(capsEnv(quick).GRAYBOARD_HOSTED_REQUEST_PER_SEC)).toBeGreaterThanOrEqual(Math.ceil(perUserRate(quick) * 2));
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
      "--sessions", "6", "--users", "2", "--drivers", "2", "--duration", "8", "--warmup", "2", "--window", "2",
      "--period", "1", "--boards", "2", "--post-share", "0.3", "--churn", "0.5", "--churn-every", "3", "--grace", "1",
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
    expect(r.summary.dms.sent).toBeGreaterThan(0);
    expect(r.summary.dms.lost).toBe(0);
    expect(r.summary.misdelivered).toBe(0);
    expect(r.summary.boardDeliveries).toBeGreaterThan(0);
    expect(Object.values(r.summary.drained)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.summary.hostedRowsAfter).toBe(0);
  }, 90_000);

  test("a lease cap below the fleet fails the run and names why", async () => {
    const r = await run(["--env", "GRAYBOARD_DELIVERY_LEASES_PER_USER=2"]);
    expect(r.code, r.out).toBe(1);
    expect(r.summary.failures.join("\n")).toMatch(/only \d+ of 6 sessions connected/);
    expect(r.summary.failures.join("\n")).toMatch(/capacity refusals/);
  }, 90_000);
});
