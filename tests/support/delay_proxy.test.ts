// The loadtest's Postgres delay proxy (#1510): bytes keep their order, each direction is delayed, and a close on
// either side closes the other.
import { afterEach, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { startDelayProxy, type DelayProxy } from "./delay_proxy.ts";
import { until } from "./until.ts";

type Peer = { received: number[]; closed: boolean; socket?: Socket<undefined> };
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// An upstream that echoes every byte back and records what it saw and whether its connection closed.
function echoServer(): { listener: TCPSocketListener<undefined>; peer: Peer } {
  const peer: Peer = { received: [], closed: false };
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(s) { s.setNoDelay(true); peer.socket = s; },
      data(s, d) { peer.received.push(...d); s.write(new Uint8Array(d)); },
      close() { peer.closed = true; },
    },
  });
  cleanup.push(() => listener.stop(true));
  return { listener, peer };
}

async function client(port: number) {
  const got: number[] = [];
  const state = { closed: false, waiters: [] as (() => void)[] };
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port,
    socket: {
      data(_s, d) { got.push(...d); for (const w of state.waiters.splice(0)) w(); },
      close() { state.closed = true; },
    },
  });
  socket.setNoDelay(true);
  cleanup.push(() => socket.end());
  // Sends one byte and resolves when the echo has brought `got` to `want` bytes.
  const echoed = (want: number) => new Promise<void>(resolve => {
    const check = () => { if (got.length >= want) resolve(); else state.waiters.push(check); };
    check();
  });
  return { socket, got, state, echoed };
}

function proxyTo(listener: TCPSocketListener<undefined>, ms: number): DelayProxy {
  const proxy = startDelayProxy({ hostname: "127.0.0.1", port: listener.port }, ms);
  cleanup.push(() => proxy.stop());
  return proxy;
}

// Median round trip of one byte, over `n` ping-pongs.
async function medianRtt(port: number, n = 21): Promise<number> {
  const c = await client(port);
  const rtts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    c.socket.write(new Uint8Array([i & 0xff]));
    await c.echoed(i + 1);
    rtts.push(performance.now() - t);
  }
  return rtts.sort((a, b) => a - b)[n >> 1]!;
}

test("bytes keep their order through the proxy, both ways, across many small writes", async () => {
  const { listener, peer } = echoServer();
  const proxy = proxyTo(listener, 1);
  const c = await client(proxy.port);
  const sent: number[] = [];
  // Writes as fast as the loop allows, so chunks queue behind each other's delay.
  for (let i = 0; i < 2000; i++) {
    const chunk = new Uint8Array(1 + (i % 7)).map((_, j) => (i * 7 + j) & 0xff);
    sent.push(...chunk);
    c.socket.write(chunk);
  }
  await c.echoed(sent.length);
  expect(peer.received).toEqual(sent);
  expect(c.got).toEqual(sent);
});

test("a delay of d ms adds about 2d to a round trip; a sub-millisecond delay is applied too", async () => {
  const { listener } = echoServer();
  const direct = await medianRtt(listener.port);
  const five = await medianRtt(proxyTo(listener, 5).port);
  // Each way at least the delay; generous on the top end for a shared machine.
  expect(five).toBeGreaterThanOrEqual(10);
  expect(five).toBeLessThan(10 + direct + 15);
  const quarter = await medianRtt(proxyTo(listener, 0.25).port);
  expect(quarter).toBeGreaterThanOrEqual(0.5);
  expect(quarter).toBeLessThan(0.5 + direct + 5);
});

test("the client closing closes the upstream connection, after the bytes it sent", async () => {
  const { listener, peer } = echoServer();
  const proxy = proxyTo(listener, 2);
  const c = await client(proxy.port);
  c.socket.write(new Uint8Array([1, 2, 3]));
  c.socket.end();
  await until(() => peer.closed, 5000, "the upstream connection closed");
  expect(peer.received).toEqual([1, 2, 3]);
  await until(() => proxy.connections() === 0, 5000, "the proxy dropped the connection");
});

test("the upstream closing closes the client connection, after the bytes it sent", async () => {
  const { listener, peer } = echoServer();
  const proxy = proxyTo(listener, 2);
  const c = await client(proxy.port);
  c.socket.write(new Uint8Array([9]));
  await c.echoed(1);
  peer.socket!.end(new Uint8Array([7, 7]));
  await until(() => c.state.closed, 5000, "the client connection closed");
  expect(c.got).toEqual([9, 7, 7]);
  await until(() => proxy.connections() === 0, 5000, "the proxy dropped the connection");
});
