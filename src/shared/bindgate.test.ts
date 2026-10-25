// The bind gate (#182 audit 11): calls overlap each other, never a bind.
import { expect, test } from "bun:test";
import { BindGate } from "./bindgate.ts";

// A promise and its resolver.
function later(): { p: Promise<void>; go: () => void } {
  let go!: () => void;
  const p = new Promise<void>((r) => { go = r; });
  return { p, go };
}

test("a bind waits for the calls in flight, and calls that arrive meanwhile wait for it", async () => {
  const gate = new BindGate();
  const log: string[] = [];
  const first = later();
  const a = gate.call(async () => { log.push("a start"); await first.p; log.push("a end"); });
  const b = gate.bind(async () => { log.push("bind"); });
  const c = gate.call(async () => { log.push("c"); });
  await Bun.sleep(10);
  expect(log).toEqual(["a start"]);
  first.go();
  await Promise.all([a, b, c]);
  expect(log).toEqual(["a start", "a end", "bind", "c"]);
});

test("calls overlap each other", async () => {
  const gate = new BindGate();
  const first = later();
  let second = false;
  const a = gate.call(() => first.p);
  await gate.call(async () => { second = true; });
  expect(second).toBe(true);
  first.go();
  await a;
});

test("holdUntil keeps calls waiting after the bind's result, until it settles, even if it rejects", async () => {
  const gate = new BindGate();
  const held = later();
  const log: string[] = [];
  await gate.bind(async () => {
    gate.holdUntil(held.p.then(() => Promise.reject(new Error("gave up"))));
    log.push("bind");
  });
  const c = gate.call(async () => { log.push("c"); });
  await Bun.sleep(10);
  expect(log).toEqual(["bind"]);
  held.go();
  await c;
  expect(log).toEqual(["bind", "c"]);
});

test("a bind that throws opens the gate", async () => {
  const gate = new BindGate();
  await expect(gate.bind(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
  expect(await gate.call(async () => 1)).toBe(1);
});
