import { expect, test } from "bun:test";

import { HelloLimiter } from "./hello_limit.ts";

function limiter(burst = 2, perSec = 1) {
  const clock = { t: 0 };
  const events: string[] = [];
  const l = new HelloLimiter({ burst, perSec }, {
    start: (id, email) => events.push(`start ${id} ${email}`),
    end: (id, email, n) => events.push(`end ${id} ${email} ${n}`),
  }, () => clock.t);
  return { l, clock, events };
}

test("a user gets the burst, then waits for the refill", () => {
  const { l, clock } = limiter(2, 1);
  expect(l.take(1, "a@x")).toEqual({ ok: true });
  expect(l.take(1, "a@x")).toEqual({ ok: true });
  expect(l.take(1, "a@x")).toEqual({ ok: false, retryAfterMs: 1000 });
  clock.t = 400;
  expect(l.take(1, "a@x")).toEqual({ ok: false, retryAfterMs: 600 });
  clock.t = 1000;
  expect(l.take(1, "a@x")).toEqual({ ok: true });
});

test("buckets are per user", () => {
  const { l } = limiter(1);
  expect(l.take(1, "a@x").ok).toBe(true);
  expect(l.take(1, "a@x").ok).toBe(false);
  expect(l.take(2, "b@x").ok).toBe(true);
});

test("a run of refusals starts once and ends with its count once the bucket is full again", () => {
  const { l, clock, events } = limiter(1);
  l.take(1, "a@x");
  l.take(1, "a@x");
  l.take(1, "a@x");
  l.take(1, "a@x");
  expect(events).toEqual(["start 1 a@x"]);
  clock.t = 1000;
  l.take(1, "a@x");
  expect(events).toEqual(["start 1 a@x", "end 1 a@x 3"]);
  // A new run starts a new streak.
  l.take(1, "a@x");
  expect(events).toEqual(["start 1 a@x", "end 1 a@x 3", "start 1 a@x"]);
});

test("the sweep ends a stopped loop's streak and drops refilled buckets only", () => {
  const { l, clock, events } = limiter(2, 1);
  l.take(1, "a@x");
  l.take(1, "a@x");
  l.take(1, "a@x");
  l.take(2, "b@x");
  clock.t = 1500;
  l.sweep();
  // a@x has 1.5 of 2 tokens back, b@x 2 of 2.
  expect(l.size).toBe(1);
  expect(events).toEqual(["start 1 a@x"]);
  clock.t = 2000;
  l.sweep();
  expect(l.size).toBe(0);
  expect(events).toEqual(["start 1 a@x", "end 1 a@x 1"]);
});

test("a loop just faster than the refill stays one streak, not one per refusal", () => {
  const { l, clock, events } = limiter(2, 1);
  l.take(1, "a@x");
  l.take(1, "a@x");
  // Every 700 ms: accepted whenever a token is back, refused otherwise.
  for (let i = 1; i <= 20; i++) {
    clock.t = i * 700;
    l.take(1, "a@x");
  }
  expect(events).toEqual(["start 1 a@x"]);
  // Stopped: once the bucket is full, the streak ends with every refusal counted.
  clock.t = 20 * 700 + 2000;
  l.sweep();
  expect(events.length).toBe(2);
  expect(events[1]).toMatch(/^end 1 a@x \d+$/);
  expect(Number(events[1]!.split(" ")[3])).toBeGreaterThan(1);
});

test("the streak's start carries the tripping hello's context and wait", () => {
  const seen: unknown[] = [];
  const l = new HelloLimiter({ burst: 1, perSec: 1 }, {
    start: (_id, _email, ctx, retryAfterMs) => seen.push({ ...ctx, retryAfterMs }),
    end: () => {},
  }, () => 0);
  l.take(1, "a@x", { session_id: "s1", name: "be" });
  l.take(1, "a@x", { session_id: "s2", read_only: true, place: "host" });
  expect(seen).toEqual([{ session_id: "s2", read_only: true, place: "host", retryAfterMs: 1000 }]);
});
