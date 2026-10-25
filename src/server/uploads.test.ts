import { expect, test } from "bun:test";

import { UploadGate, UploadTimeout, readUploadBody } from "./uploads.ts";

const never = () => new AbortController().signal;
// Whether a promise has settled by the next turn of the event loop.
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await Bun.sleep(0);
  return done;
};

test("reservations wait for room across the server and per user", async () => {
  const gate = new UploadGate(10, 6);
  const a1 = await gate.reserve("a", 6, never());
  const a2 = gate.reserve("a", 1, never()); // a is at its 6
  const b1 = gate.reserve("b", 4, never()); // a2 waits on a's cap only, so b goes ahead
  expect(await settled(a2)).toBe(false);
  expect(await settled(b1)).toBe(true);
  const r1 = await b1;
  a1();
  const r2 = await a2;
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

test("a user at their cap keeps their own order and doesn't block others", async () => {
  const gate = new UploadGate(100, 25);
  const a1 = await gate.reserve("a", 10, never());
  const a2 = await gate.reserve("a", 10, never());
  const a3 = gate.reserve("a", 10, never()); // a would be at 30
  const a4 = gate.reserve("a", 1, never()); // fits a's cap, but stays behind a3
  const b = gate.reserve("b", 1, never());
  expect(await settled(a3)).toBe(false);
  expect(await settled(a4)).toBe(false);
  expect(await settled(b)).toBe(true);
  a1();
  expect(await settled(a3)).toBe(true);
  expect(await settled(a4)).toBe(true);
  for (const r of [a2, await a3, await a4, await b]) r();
});

test("a waiter short of server room isn't passed by smaller ones behind it", async () => {
  const gate = new UploadGate(10, 10);
  const a = await gate.reserve("a", 8, never());
  const big = gate.reserve("b", 5, never());
  const small = gate.reserve("c", 1, never()); // would fit, but big was first
  expect(await settled(big)).toBe(false);
  expect(await settled(small)).toBe(false);
  a();
  expect(await settled(big)).toBe(true);
  expect(await settled(small)).toBe(true);
  (await big)();
  (await small)();
});

// A request whose body sends `first` and then nothing more.
function stalled(first: Uint8Array, length: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first);
    },
  });
  return new Request("http://x/", { method: "POST", body, headers: { "content-length": String(length) } });
}

test("an upload body is read in full, or refused once its deadline passes", async () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  expect(await readUploadBody(new Request("http://x/", { method: "POST", body: data }), 4, 1000)).toEqual(data);
  // Short of its declared length: what came, for the size checks to judge.
  expect(await readUploadBody(new Request("http://x/", { method: "POST", body: data }), 9, 1000)).toEqual(data);
  await expect(readUploadBody(new Request("http://x/", { method: "POST", body: data }), 3, 1000)).rejects.toThrow(/longer than its Content-Length/);
  const t = Date.now();
  await expect(readUploadBody(stalled(data, 8), 8, 50)).rejects.toBeInstanceOf(UploadTimeout);
  expect(Date.now() - t).toBeLessThan(1000);
});
