import { expect, test } from "bun:test";

import { RateLimiter } from "./rate_limit.ts";

function limiter(burst = 2, perSec = 1) {
  const clock = { t: 0 };
  const events: string[] = [];
  const l = new RateLimiter({ burst, perSec }, {
    start: (key) => events.push(`start ${key}`),
    end: (key, n) => events.push(`end ${key} ${n}`),
  }, () => clock.t);
  return { l, clock, events };
}

test("a user gets the burst, then waits for the refill", () => {
  const { l, clock } = limiter(2, 1);
  expect(l.take("a@x")).toEqual({ ok: true });
  expect(l.take("a@x")).toEqual({ ok: true });
  expect(l.take("a@x")).toEqual({ ok: false, retryAfterMs: 1000 });
  clock.t = 400;
  expect(l.take("a@x")).toEqual({ ok: false, retryAfterMs: 600 });
  clock.t = 1000;
  expect(l.take("a@x")).toEqual({ ok: true });
});

test("buckets are per user", () => {
  const { l } = limiter(1);
  expect(l.take("a@x").ok).toBe(true);
  expect(l.take("a@x").ok).toBe(false);
  expect(l.take("b@x").ok).toBe(true);
});

test("a run of refusals starts once and ends with its count once the bucket is full again", () => {
  const { l, clock, events } = limiter(1);
  l.take("a@x");
  l.take("a@x");
  l.take("a@x");
  l.take("a@x");
  expect(events).toEqual(["start a@x"]);
  clock.t = 1000;
  l.take("a@x");
  expect(events).toEqual(["start a@x", "end a@x 3"]);
  // A new run starts a new streak.
  l.take("a@x");
  expect(events).toEqual(["start a@x", "end a@x 3", "start a@x"]);
});

test("the sweep ends a stopped loop's streak and drops refilled buckets only", () => {
  const { l, clock, events } = limiter(2, 1);
  l.take("a@x");
  l.take("a@x");
  l.take("a@x");
  l.take("b@x");
  clock.t = 1500;
  l.sweep();
  // a@x has 1.5 of 2 tokens back, b@x 2 of 2.
  expect(l.size).toBe(1);
  expect(events).toEqual(["start a@x"]);
  clock.t = 2000;
  l.sweep();
  expect(l.size).toBe(0);
  expect(events).toEqual(["start a@x", "end a@x 1"]);
});

test("a loop just faster than the refill stays one streak, not one per refusal", () => {
  const { l, clock, events } = limiter(2, 1);
  l.take("a@x");
  l.take("a@x");
  // Every 700 ms: accepted whenever a token is back, refused otherwise.
  for (let i = 1; i <= 20; i++) {
    clock.t = i * 700;
    l.take("a@x");
  }
  expect(events).toEqual(["start a@x"]);
  // Stopped: once the bucket is full, the streak ends with every refusal counted.
  clock.t = 20 * 700 + 2000;
  l.sweep();
  expect(events.length).toBe(2);
  expect(events[1]).toMatch(/^end a@x \d+$/);
  expect(Number(events[1]!.split(" ")[2])).toBeGreaterThan(1);
});

test("the streak's start carries the tripping hello's context and wait", () => {
  const seen: unknown[] = [];
  const l = new RateLimiter({ burst: 1, perSec: 1 }, {
    start: (_key, ctx, retryAfterMs, last) => seen.push({ ...ctx, retryAfterMs, last }),
    end: () => {},
  }, () => 0);
  l.take("a@x", { session_id: "s1", name: "be" });
  l.take("a@x", { session_id: "s2", read_only: true, place: "host" });
  // The start names the refused request and the spend that emptied the bucket.
  expect(seen).toEqual([{ session_id: "s2", read_only: true, place: "host", retryAfterMs: 1000, last: { session_id: "s1", name: "be" } }]);
});

test("a check never allocates a bucket or spends; a spend never goes below empty", () => {
  const { l, clock } = limiter(2, 1);
  expect(l.check("a@x")).toEqual({ ok: true });
  expect(l.size).toBe(0);
  l.spend("a@x");
  l.spend("a@x");
  l.spend("a@x");
  l.spend("a@x");
  // Empty, not -2: the wait is one token's refill.
  expect(l.check("a@x")).toEqual({ ok: false, retryAfterMs: 1000 });
  clock.t = 1000;
  expect(l.check("a@x")).toEqual({ ok: true });
});

test("at the key cap a new key is neither charged nor refused, with one notice a minute", () => {
  const clock = { t: 0 };
  const full: [number, number][] = [];
  const l = new RateLimiter({ burst: 1, perSec: 1 }, { start: () => {}, end: () => {}, full: (n, uncharged) => full.push([n, uncharged]) }, () => clock.t, 2);
  l.spend("a");
  l.spend("b");
  l.spend("c");
  l.spend("c");
  expect(l.size).toBe(2);
  expect(l.check("c")).toEqual({ ok: true });
  expect(l.check("a").ok).toBe(false);
  expect(full).toEqual([[2, 1]]);
  clock.t = 59_999;
  l.spend("d");
  expect(full).toEqual([[2, 1]]);
  clock.t = 60_000;
  l.spend("d");
  expect(full).toEqual([[2, 1], [2, 3]]);
});

test("a start hook that throws leaves the streak unstarted, so the next refusal records it", () => {
  let fail = true;
  const starts: string[] = [];
  const l = new RateLimiter({ burst: 1, perSec: 1 }, {
    start: (key) => { if (fail) throw new Error("audit down"); starts.push(key); },
    end: () => {},
  }, () => 0);
  l.take("a");
  expect(() => l.take("a")).toThrow("audit down");
  fail = false;
  expect(l.take("a").ok).toBe(false);
  expect(starts).toEqual(["a"]);
});

test("a sweep whose end hook throws for one key still sweeps the others, and retries it", () => {
  const clock = { t: 0 };
  let fail = true;
  const ends: string[] = [];
  const l = new RateLimiter({ burst: 1, perSec: 1 }, {
    start: () => {},
    end: (key, n) => { if (fail && key === "a") throw new Error("audit down"); ends.push(`${key} ${n}`); },
  }, () => clock.t);
  for (const k of ["a", "b"]) { l.take(k); l.take(k); }
  clock.t = 1000;
  l.sweep();
  expect(ends).toEqual(["b 1"]);
  expect(l.size).toBe(1);
  fail = false;
  l.sweep();
  expect(ends).toEqual(["b 1", "a 1"]);
  expect(l.size).toBe(0);
});
