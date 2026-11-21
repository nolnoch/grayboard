// The write queue's metrics (#1510): wait, hold, bodies, depth and waiters, by site. The registry is process-wide, so
// every assertion reads a delta from a scrape taken before.
import { expect, test } from "bun:test";
import { parseMetrics, type Sample } from "../../../scripts/loadtest.ts";
import { QUEUE_BUCKETS, queueWaitersNow, render, type QueueSite } from "../metrics.ts";
import { atSite, WriteQueue } from "./queue.ts";

const scrape = () => parseMetrics(render());
const value = (s: Sample[], name: string, labels: Record<string, string> = {}) =>
  s.find(x => x.name === name && Object.keys(labels).length === Object.keys(x.labels).length && Object.entries(labels).every(([k, v]) => x.labels[k] === v))?.value ?? 0;
// One site's histogram, as deltas from `before`.
function delta(before: Sample[], after: Sample[], metric: "wait" | "hold", site: QueueSite) {
  const name = `grayboard_write_queue_${metric}_seconds`;
  return {
    count: value(after, `${name}_count`, { site }) - value(before, `${name}_count`, { site }),
    sum: value(after, `${name}_sum`, { site }) - value(before, `${name}_sum`, { site }),
  };
}
const bodies = (before: Sample[], after: Sample[], site: QueueSite) =>
  value(after, "grayboard_write_queue_bodies_total", { site }) - value(before, "grayboard_write_queue_bodies_total", { site });
// A synchronous body that holds the queue for at least `ms` (a spin, not a sleep: the hold is the body's own time).
const spin = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* hold */ } };
const deferred = () => { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };

test("a synchronous body's hold is recorded under its site, with no wait on an idle queue", async () => {
  const q = new WriteQueue(), before = scrape();
  await atSite("touch", () => q.run(() => spin(5)));
  const after = scrape();
  const hold = delta(before, after, "hold", "touch"), wait = delta(before, after, "wait", "touch");
  expect(hold.count).toBe(1);
  expect(hold.sum).toBeGreaterThanOrEqual(0.005);
  expect(wait.count).toBe(1);
  expect(wait.sum).toBe(0);
  expect(bodies(before, after, "touch")).toBe(1);
});

test("an async body holds until it settles; the body behind it records its wait, and the waiters gauge goes up and back down", async () => {
  const q = new WriteQueue(), before = scrape(), gate = deferred();
  const first = atSite("gate", () => q.run(() => gate.promise));
  const second = atSite("renew", () => q.run(() => 1));
  const third = q.run(() => 2);
  expect(queueWaitersNow()).toBeGreaterThanOrEqual(2);
  const mid = scrape();
  expect(value(mid, "grayboard_write_queue_waiters") - value(before, "grayboard_write_queue_waiters")).toBe(2);
  // Depth at enqueue: the second queued behind nobody waiting, the third behind one.
  expect(value(mid, "grayboard_write_queue_depth_bucket", { le: "0" }) - value(before, "grayboard_write_queue_depth_bucket", { le: "0" })).toBe(1);
  expect(value(mid, "grayboard_write_queue_depth_bucket", { le: "1" }) - value(before, "grayboard_write_queue_depth_bucket", { le: "1" })).toBe(2);
  expect(value(mid, "grayboard_write_queue_depth_count") - value(before, "grayboard_write_queue_depth_count")).toBe(2);
  spin(5);
  gate.resolve();
  expect(await Promise.all([first, second, third])).toEqual([undefined, 1, 2]);
  const after = scrape();
  expect(value(after, "grayboard_write_queue_waiters")).toBe(value(before, "grayboard_write_queue_waiters"));
  const gateHold = delta(before, after, "hold", "gate"), renewWait = delta(before, after, "wait", "renew");
  expect(gateHold.count).toBe(1);
  expect(gateHold.sum).toBeGreaterThanOrEqual(0.005);
  expect(renewWait.count).toBe(1);
  // The second waited out the first's hold, the spin included.
  expect(renewWait.sum).toBeGreaterThanOrEqual(0.005);
  expect(delta(before, after, "wait", "other").count).toBe(1);
});

test("a body that throws, synchronously or by rejecting, is still timed and releases the waiters count", async () => {
  const q = new WriteQueue(), before = scrape(), gate = deferred();
  const rejected = atSite("receipt", () => q.run(() => gate.promise));
  const thrown = atSite("receipt", () => q.run(() => { spin(2); throw new Error("sync"); }));
  const settled = Promise.allSettled([rejected, thrown]);
  gate.reject(new Error("async"));
  expect((await settled).map(r => r.status === "rejected" && (r.reason as Error).message)).toEqual(["async", "sync"]);
  const idleThrow = atSite("receipt", () => q.run(() => { throw new Error("idle"); }));
  await expect(idleThrow).rejects.toThrow("idle");
  const after = scrape();
  expect(delta(before, after, "hold", "receipt").count).toBe(3);
  expect(delta(before, after, "hold", "receipt").sum).toBeGreaterThanOrEqual(0.002);
  expect(bodies(before, after, "receipt")).toBe(3);
  expect(value(after, "grayboard_write_queue_waiters")).toBe(value(before, "grayboard_write_queue_waiters"));
});

test("the innermost site wins; a body queued with none is `other`", async () => {
  const q = new WriteQueue(), before = scrape();
  await atSite("tool", () => atSite("audit", () => q.run(() => {})));
  await atSite("tool", () => q.run(() => {}));
  await q.run(() => {});
  const after = scrape();
  expect(bodies(before, after, "audit")).toBe(1);
  expect(bodies(before, after, "tool")).toBe(1);
  expect(bodies(before, after, "other")).toBe(1);
});

test("the exposition parses with the loadtest's parser: cumulative buckets, +Inf equal to the count", async () => {
  const q = new WriteQueue();
  await atSite("prior", () => q.run(() => spin(1)));
  const s = scrape();
  for (const metric of ["wait", "hold"]) {
    const name = `grayboard_write_queue_${metric}_seconds`;
    const buckets = s.filter(x => x.name === `${name}_bucket` && x.labels.site === "prior");
    expect(buckets.map(b => b.labels.le)).toEqual([...QUEUE_BUCKETS.map(String), "+Inf"]);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.value).toBeGreaterThanOrEqual(buckets[i - 1]!.value);
    expect(buckets.at(-1)!.value).toBe(value(s, `${name}_count`, { site: "prior" }));
  }
  // A hold of at least 1 ms lands over the 0.5 ms edge.
  const le = (edge: string) => value(s, "grayboard_write_queue_hold_seconds_bucket", { site: "prior", le: edge });
  expect(le("+Inf") - le("0.0005")).toBeGreaterThanOrEqual(1);
  const depth = s.filter(x => x.name === "grayboard_write_queue_depth_bucket");
  expect(depth.at(-1)!.labels.le).toBe("+Inf");
});

test("#1510: a keyed body counts in the keyed counter under its site as well as in bodies; the running gauge counts bodies running at once", async () => {
  const q = new WriteQueue(2), before = scrape(), a = deferred(), b = deferred();
  const first = atSite("gate", () => q.runKeyed(["root:1"], () => a.promise));
  const second = atSite("gate", () => q.runKeyed(["root:2"], () => b.promise));
  expect(value(scrape(), "grayboard_write_queue_running") - value(before, "grayboard_write_queue_running")).toBe(2);
  a.resolve(); b.resolve();
  await Promise.all([first, second]);
  await atSite("gate", () => q.run(() => 1));
  const after = scrape();
  expect(value(after, "grayboard_write_queue_running")).toBe(value(before, "grayboard_write_queue_running"));
  expect(bodies(before, after, "gate")).toBe(3);
  expect(value(after, "grayboard_write_queue_keyed_bodies_total", { site: "gate" }) - value(before, "grayboard_write_queue_keyed_bodies_total", { site: "gate" })).toBe(2);
});
