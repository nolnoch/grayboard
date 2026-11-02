// The WSS transport's own behaviour over real WebSockets: what ws.ts does
// that no application call does (a hello on a socket whose token changed
// since the upgrade, one hello in flight per connection, a throwing handler
// answered with an error frame). #282 PR 2 deletes these with ws.ts; the
// application-level halves are in hub.test.ts and hosted_tools.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Config } from "../../src/server/config.ts";
import { PROTO } from "../../src/shared/protocol.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import type { Any, WsClientOptions } from "../support/ws_client.ts";

// Each test's server, with a short probe so heartbeat tests run fast.
const start = (overrides: Partial<Config> = {}) => new TestServer(overrides, { probeMs: 150 });
let srv: TestServer;

beforeEach(() => {
  srv = start();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const client = (token: string, identity: string, opts?: WsClientOptions) => srv.client(token, identity, opts);

const audits = (action: string) =>
  (srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY at`).all(action) as { actor: string; target: string; detail: string }[]);

// A socket opened with a token that is revoked before it speaks is in no
// registry, so only the hello can refuse it.
test("a hello on a token revoked since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login("alice@example.com");
  const key = "ab".repeat(32);
  const ws = new (WebSocket as any)(`${srv.base.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve) => (ws.onopen = resolve));
  const frames: Any[] = [];
  ws.onmessage = (e: MessageEvent) => frames.push(JSON.parse(e.data as string));
  const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()));
  expect((await api(token, "POST", "/api/auth/logout")).status).toBe(200);
  ws.send(JSON.stringify({ type: "hello", req_id: "h", proto: PROTO, session_key: key }));
  await closed;
  expect(frames.find((m) => m.type === "error")).toMatchObject({ req_id: "h", code: "unauthenticated" });
  expect(frames.some((m) => m.type === "hello_ok")).toBe(false);
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  const rows = audits("auth.hello_refused").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "alice@example.com", detail: { why: "token_revoked" } });
});

test("a hello from a user disabled since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login("alice@example.com");
  const ws = new (WebSocket as any)(`${srv.base.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve) => (ws.onopen = resolve));
  const frames: Any[] = [];
  ws.onmessage = (e: MessageEvent) => frames.push(JSON.parse(e.data as string));
  const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()));
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail("alice@example.com")!.id, true);
  ws.send(JSON.stringify({ type: "hello", req_id: "h", proto: PROTO, session_key: "cd".repeat(32) }));
  await closed;
  expect(frames.find((m) => m.type === "error")).toMatchObject({ req_id: "h", code: "unauthenticated" });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  expect(audits("auth.hello_refused").map((r) => JSON.parse(r.detail).why)).toEqual(["user_disabled"]);
});

// Audit S2 (#345): a hello awaits the probe; a second hello on the same
// connection meanwhile is refused and closes it, and the first never
// supersedes the holder from a closed socket.
test("a second hello while the first is probing is refused and closes the connection", async () => {
  const alice = await login("alice@example.com");
  const dead = client(alice, "be", { pong: false });
  await dead.connect();
  const twice = client(alice, "be", { key: dead.key });
  const first = twice.connect(); // probes the dead holder (150 ms)
  await until(() => twice.ws.readyState === 1);
  twice.ws.send(JSON.stringify({ type: "hello", req_id: "h2", proto: PROTO, session_key: dead.key }));
  expect(await twice.next((m) => m.req_id === "h2")).toMatchObject({ type: "error", code: "bad_request", message: "a hello is already in flight on this connection" });
  await expect(first).rejects.toThrow("socket closed");
  await dead.none((m: Any) => m.type === "error", 300);
});

test("a handler that throws answers the call with an internal error and keeps the socket", async () => {
  const alice = await login("alice@example.com");
  const be = client(alice, "be");
  const fe = client(alice, "fe");
  await Promise.all([be.connect(), fe.connect()]);
  await be.request({ type: "send", recipient: "fe", body: "hi" });
  const id = (await fe.next((m) => m.type === "push")).message.id;
  // A read-point table gone from under the live server makes the ack's cursor write fail.
  srv.app.db.exec(`ALTER TABLE mailbox_cursors RENAME TO mailbox_cursors_gone`);
  expect(await fe.request({ type: "ack", message_ids: [id] })).toMatchObject({ type: "error", code: "internal" });
  expect((await fe.call("board_list")).type).toBe("call_ok");
});
