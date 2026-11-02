// The WebSocket upgrade a pre-removal `grayboard mcp --mode server` still makes (#282): accepted without
// authentication, its one frame answered with a refusal that names the fix, then closed. Over a real socket.
import { afterEach, expect, test } from "bun:test";
import { createWsRefusal, MAX_REFUSAL_SOCKETS } from "../../src/server/ws_refusal.ts";
import { PROTO, PROTO_REFUSAL, UPGRADE_REFUSAL } from "../../src/shared/protocol.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function serve(): TestServer {
  const srv = new TestServer();
  cleanup.push(() => srv.stop());
  return srv;
}

type Probe = { ws: WebSocket; frames: Record<string, unknown>[]; closed: Promise<void> };

// No Authorization header: the refusal needs none.
async function open(srv: TestServer): Promise<Probe> {
  const ws = new WebSocket(`${srv.base.replace("http", "ws")}/`);
  const frames: Record<string, unknown>[] = [];
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  const closed = new Promise<void>((res) => { ws.onclose = () => res(); });
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("upgrade refused")); });
  cleanup.push(() => ws.close());
  return { ws, frames, closed };
}

test("a proto-2 hello is answered upgrade_required with its req_id, then the socket closes", async () => {
  const p = await open(serve());
  p.ws.send(JSON.stringify({ type: "hello", req_id: "r1", proto: PROTO }));
  await p.closed;
  expect(p.frames).toEqual([{ type: "error", req_id: "r1", code: "upgrade_required", message: UPGRADE_REFUSAL }]);
});

test("a hello without the protocol version is told to update", async () => {
  const p = await open(serve());
  p.ws.send(JSON.stringify({ type: "hello", req_id: "r2" }));
  await p.closed;
  expect(p.frames).toEqual([{ type: "error", req_id: "r2", code: "bad_request", message: PROTO_REFUSAL }]);
});

test("a frame that is not a hello closes the socket with no answer", async () => {
  const p = await open(serve());
  p.ws.send(JSON.stringify({ type: "send", req_id: "r3", recipient: "x", body: "y" }));
  await p.closed;
  expect(p.frames).toEqual([]);
});

test("an address over the open-socket cap is refused at the upgrade, and a closed socket frees its slot", async () => {
  const srv = serve();
  const held: Probe[] = [];
  for (let i = 0; i < MAX_REFUSAL_SOCKETS; i++) held.push(await open(srv));
  const over = await fetch(`${srv.base}/`, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  expect(over.status).toBe(429);
  expect(await over.json()).toMatchObject({ code: "rate_limited" });
  held[0]!.ws.close();
  await held[0]!.closed;
  await until(async () => (await open(srv)).ws.readyState === WebSocket.OPEN);
});

// Bun's default pings keep a silent client's socket open past idleTimeout (measured on 1.4.4), so the handler turns them off.
test("a socket that never sends a hello is closed at the idle deadline, even though its client answers pings", async () => {
  const refusal = createWsRefusal(16, 2);
  const server = Bun.serve<{ key: string }>({
    port: 0,
    fetch(req, s) { return refusal.admit("a") && s.upgrade(req, { data: { key: "a" } }) ? undefined : new Response("no", { status: 400 }); },
    websocket: refusal.handlers,
  });
  cleanup.push(() => { void server.stop(true); });
  const ws = new WebSocket(`ws://localhost:${server.port}/`);
  const closed = new Promise<void>((res) => { ws.onclose = () => res(); });
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("upgrade refused")); });
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("still open after 9s")), 9000))]);
  expect(ws.readyState).toBe(WebSocket.CLOSED);
}, 15_000);
