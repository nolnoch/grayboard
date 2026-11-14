import { afterEach, expect, test } from "bun:test";
import { countRefusal, lagWindow, LATENCY_BUCKETS, observeTool, render, startLagSampler } from "./metrics.ts";
import { DEFAULT_MCP_LIMITS, parseMetricsAddr } from "./config.ts";
import { TestServer } from "../../tests/support/server.ts";
import { until } from "../../tests/support/until.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";

// One sample line's value, or undefined when the series is absent.
const sample = (text: string, series: string) => {
  const line = text.split("\n").find(l => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

test("render writes the exposition format: types, cumulative buckets, escaped labels", () => {
  observeTool("render_probe", 0.003);
  observeTool("render_probe", 0.2);
  countRefusal("resource_watch");
  const text = render({ probe_gauge: { help: "A probe.", values: [{ value: 3, labels: { kind: 'a"b\\c' } }] } });
  expect(text.endsWith("\n")).toBe(true);
  expect(text).toContain("# TYPE grayboard_tool_call_duration_seconds histogram");
  expect(text).toContain("# TYPE grayboard_capacity_refusals_total counter");
  expect(sample(text, 'grayboard_tool_call_duration_seconds_bucket{tool="render_probe",le="0.0025"}')).toBe(0);
  expect(sample(text, 'grayboard_tool_call_duration_seconds_bucket{tool="render_probe",le="0.005"}')).toBe(1);
  expect(sample(text, 'grayboard_tool_call_duration_seconds_bucket{tool="render_probe",le="0.25"}')).toBe(2);
  expect(sample(text, 'grayboard_tool_call_duration_seconds_bucket{tool="render_probe",le="+Inf"}')).toBe(2);
  expect(sample(text, 'grayboard_tool_call_duration_seconds_count{tool="render_probe"}')).toBe(2);
  expect(sample(text, 'grayboard_tool_call_duration_seconds_sum{tool="render_probe"}')).toBeCloseTo(0.203);
  expect(sample(text, 'grayboard_capacity_refusals_total{kind="resource_watch"}')).toBeGreaterThanOrEqual(1);
  // Every kind is present from the start, so a rate() over a fresh process starts at zero, not absent.
  expect(sample(text, 'grayboard_capacity_refusals_total{kind="mcp_exchange"}')).toBeGreaterThanOrEqual(0);
  expect(sample(text, 'grayboard_probe_gauge{kind="a\\"b\\\\c"}')).toBe(3);
  expect(text).toMatch(/^grayboard_build_info\{version="[^"]+"\} 1$/m);
  expect(sample(text, "grayboard_process_resident_memory_bytes")).toBeGreaterThan(0);
  expect(LATENCY_BUCKETS).toEqual([...LATENCY_BUCKETS].sort((a, b) => a - b));
});

test("GRAYBOARD_METRICS_ADDR: a bare port binds loopback; host:port and [v6]:port as given", () => {
  expect(parseMetricsAddr(undefined)).toBeUndefined();
  expect(parseMetricsAddr("")).toBeUndefined();
  expect(parseMetricsAddr("9464")).toEqual({ hostname: "127.0.0.1", port: 9464 });
  expect(parseMetricsAddr("0.0.0.0:9464")).toEqual({ hostname: "0.0.0.0", port: 9464 });
  expect(parseMetricsAddr("[::1]:9464")).toEqual({ hostname: "::1", port: 9464 });
  expect(parseMetricsAddr("metrics.internal:9464")).toEqual({ hostname: "metrics.internal", port: 9464 });
  for (const bad of ["abc", "70000", ":9464", "host:", "1e3", " 9464"]) expect(() => parseMetricsAddr(bad)).toThrow("GRAYBOARD_METRICS_ADDR");
});

let stops: Array<() => void> = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

test("the lag sampler records a blocked loop in its window, and stops by reference count", async () => {
  const stopA = startLagSampler(100), stopB = startLagSampler(100);
  stops.push(stopA, stopB);
  // monitorEventLoopDelay only measures once the loop has ticked after enable().
  await Bun.sleep(30);
  const end = performance.now() + 150;
  while (performance.now() < end) { /* block the loop */ }
  await until(() => (lagWindow()?.max ?? 0) >= 0.1, 2_000, "a 150 ms block never showed in a lag window");
  expect(render()).toMatch(/^grayboard_event_loop_lag_seconds\{quantile="1"\} /m);
  stopA();
  expect(lagWindow()).toBeDefined();
  stopB();
  expect(lagWindow()).toBeUndefined();
  expect(render()).not.toContain("grayboard_event_loop_lag_seconds");
});

test("the listener serves /metrics on its own address, refuses anything else, and stops with the app", async () => {
  const srv = new TestServer({ metricsAddr: { hostname: "127.0.0.1", port: 0 }, mcpLimits: { ...DEFAULT_MCP_LIMITS, post: { global: 0, perUser: 0 } } });
  try {
    const base = `http://127.0.0.1:${srv.app.metrics!.port}`;
    const before = sample(await (await fetch(`${base}/metrics`)).text(), 'grayboard_capacity_refusals_total{kind="mcp_post"}')!;
    // A real refusal site: every POST /mcp is over a zero post cap.
    const { token } = issueOAuth(srv.app.repo, srv.app.oauth.resource, "you@example.com", ["grayboard:tools"], Date.now());
    const refused = await fetch(`${srv.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(refused.status).toBe(429);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(sample(text, 'grayboard_capacity_refusals_total{kind="mcp_post"}')).toBe(before + 1);
    expect(sample(text, 'grayboard_mcp_admissions{kind="post"}')).toBe(0);
    expect(sample(text, "grayboard_delivery_leases")).toBe(0);
    expect(sample(text, "grayboard_hosted_sessions_holding")).toBe(0);
    expect(text).not.toContain("you@example.com");
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(405);
    // The public port never serves it.
    const main = await fetch(`${srv.base}/metrics`);
    expect(main.status).not.toBe(200);
    expect(await main.text()).not.toContain("grayboard_build_info");
  } finally { await srv.stop(); }
  await expect(fetch(`http://127.0.0.1:${srv.app.metrics!.port}/metrics`)).rejects.toThrow();
});

test("no GRAYBOARD_METRICS_ADDR, no listener", async () => {
  const srv = new TestServer();
  try { expect(srv.app.metrics).toBeUndefined(); } finally { await srv.stop(); }
});

test("a hosted tool call lands in the latency histogram under its own name", async () => {
  const srv = new TestServer({ metricsAddr: { hostname: "127.0.0.1", port: 0 }, hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  try {
    const count = async () => sample(await (await fetch(`http://127.0.0.1:${srv.app.metrics!.port}/metrics`)).text(), 'grayboard_tool_call_duration_seconds_count{tool="board_list"}') ?? 0;
    const before = await count();
    const s = await srv.hosted("you@example.com", "be");
    await s.call("board_list");
    expect(await count()).toBe(before + 1);
    expect(sample(await (await fetch(`http://127.0.0.1:${srv.app.metrics!.port}/metrics`)).text(), "grayboard_hosted_sessions_holding")).toBeGreaterThanOrEqual(1);
  } finally { await srv.stop(); }
});

// Last in the file: it fills the process-wide registry's series guard, so a test after it that
// names a new tool would read `other`.
test("tool series past the guard fold into other", () => {
  for (let i = 0; i < 80; i++) observeTool(`guard_probe_${i}`, 0.001);
  const text = render();
  const tools = new Set([...text.matchAll(/^grayboard_tool_call_duration_seconds_count\{tool="([^"]+)"\}/gm)].map(m => m[1]));
  expect(tools.size).toBeLessThanOrEqual(65);
  expect(tools.has("other")).toBe(true);
});
