import { expect, test } from "bun:test";

import { UploadGate } from "./uploads.ts";

const never = () => new AbortController().signal;
// Whether a promise has settled by the next turn of the event loop.
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await Bun.sleep(0);
  return done;
};

test("reservations wait for room across the server and per user, in order", async () => {
  const gate = new UploadGate(10, 6);
  const a1 = await gate.reserve("a", 6, never());
  const a2 = gate.reserve("a", 1, never()); // a is at its 6
  const b1 = gate.reserve("b", 4, never()); // behind a2, though it would fit
  expect(await settled(a2)).toBe(false);
  expect(await settled(b1)).toBe(false);
  a1();
  const [r2, r1] = [await a2, await b1];
  const b2 = gate.reserve("b", 2, never());
  expect(await settled(b2)).toBe(true);
  const c = gate.reserve("c", 4, never()); // 1 + 4 + 2 + 4 > 10
  expect(await settled(c)).toBe(false);
  r2();
  r1();
  // A release twice frees its bytes once.
  r1();
  expect(await settled(c)).toBe(true);
  (await b2)();
  (await c)();
  // Everything released: the whole server's room is free again.
  (await gate.reserve("d", 6, never()))();
  expect(await settled(gate.reserve("e", 6, never()))).toBe(true);
});

test("an aborted request leaves the queue and lets the ones behind it in", async () => {
  const gate = new UploadGate(10, 10);
  const first = await gate.reserve("a", 8, never());
  const ac = new AbortController();
  const big = gate.reserve("b", 5, ac.signal);
  const small = gate.reserve("c", 2, never());
  expect(await settled(small)).toBe(false);
  ac.abort();
  await expect(big).rejects.toThrow();
  expect(await settled(small)).toBe(true);
  first();
  const gone = new AbortController();
  gone.abort();
  await expect(gate.reserve("d", 1, gone.signal)).rejects.toThrow();
});
