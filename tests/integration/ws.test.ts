// End-to-end over real WebSockets: an in-memory server with dev auth, and
// clients for two or three users. Covers the distributed board semantics in
// docs/boards-spec.md §7.5.
import { afterEach, beforeEach, expect, test } from "bun:test";

import { startServer } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";

const config = (): Config => ({
  dbPath: ":memory:",
  httpPort: 0,
  googleClientId: "dev",
  googleClientSecret: "",
  orgDomain: "example.com",
  publicUrl: "http://localhost",
  messageRetentionDays: 90,
  auditRetentionDays: 90,
  devAuth: true,
});

let app: ReturnType<typeof startServer>;
let base: string;
const open: Client[] = [];

beforeEach(() => {
  app = startServer(config(), { probeMs: 150, background: false });
  base = `http://localhost:${app.server.port}`;
});

afterEach(() => {
  for (const c of open.splice(0)) c.close();
  app.stop();
});

async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return ((await r.json()) as { session_token: string }).session_token;
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

type Any = ServerMessage & Record<string, any>;

class Client {
  ws!: WebSocket;
  inbox: Any[] = [];
  private waiters: { pred: (m: Any) => boolean; resolve: (m: Any) => void }[] = [];
  private n = 0;

  constructor(
    private token: string,
    private identity: string,
    private opts: { pong?: boolean } = {},
  ) {}

  // Resolves with hello_ok, or the error that refused the hello.
  connect(): Promise<Any> {
    this.ws = new (WebSocket as any)(`${base.replace("http", "ws")}/ws`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    open.push(this);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as Any;
      if (m.type === "ping" && this.opts.pong !== false) this.ws.send(JSON.stringify({ type: "pong" }));
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    };
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({ type: "hello", req_id: "h", identity: this.identity }));
    return this.next((m) => m.type === "hello_ok" || (m.type === "error" && m.req_id === "h"));
  }

  next(pred: (m: Any) => boolean, ms = 1000): Promise<Any> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          reject(new Error(`${this.identity}: timed out waiting`));
        }
      }, ms);
    });
  }

  // Nothing matching arrives within ms.
  async none(pred: (m: Any) => boolean, ms = 150): Promise<void> {
    await Bun.sleep(ms);
    expect(this.inbox.filter(pred)).toEqual([]);
  }

  async request(msg: Record<string, unknown>): Promise<Any> {
    const req_id = `r${++this.n}`;
    this.ws.send(JSON.stringify({ ...msg, req_id }));
    return this.next((m) => m.req_id === req_id);
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<Any> {
    return this.request({ type: "call", tool, args });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const boardPush = (m: Any) => m.type === "board_push";

async function closeAndSettle(c: Client) {
  c.close();
  await Bun.sleep(50);
}

test("team board: members see it and get pushes; non-members can't see or be mentioned", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(bob, "POST", "/api/identities", { name: "fe" });
  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(carol, "POST", "/api/teams/eng/join");

  const a = new Client(alice, "be");
  const b = new Client(bob, "fe");
  const c = new Client(carol, "sim");
  for (const x of [a, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  const posted = await a.call("board_post", { board: "eng", body: "@sim @bob/fe secret plan" });
  expect(posted.type).toBe("call_ok");
  expect(posted.result.unresolved).toEqual(["bob/fe"]);

  const pushed = await c.next(boardPush);
  expect(pushed.item).toMatchObject({
    kind: "push",
    reason: "mention",
    post: { board: "eng", author: "alice@example.com/be", body: "@sim @bob/fe secret plan" },
  });
  await b.none(boardPush);

  expect((await b.call("board_list")).result.map((x: any) => x.name)).toEqual([]);
  expect(await b.call("board_read", { board: "eng" })).toMatchObject({
    type: "error",
    message: "no such board #eng; see board_list",
  });
  expect((await c.call("board_list")).result).toMatchObject([{ name: "eng", scope: "team:eng", mode: "digest" }]);
});

test("who: live connections are online; a closed one is offline with last_seen; team board scopes it", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(bob, "POST", "/api/teams/eng/join");

  const a = new Client(alice, "be");
  const a2 = new Client(alice, "be-stream");
  const b = new Client(bob, "fe");
  const c = new Client(carol, "sim");
  for (const x of [a, a2, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  const online = await c.call("who");
  expect(online.result.you).toBe("carol@example.com/sim");
  expect(online.result.peers.map((p: any) => p.handle)).toEqual([
    "alice@example.com/be",
    "alice@example.com/be-stream",
    "bob@example.com/fe",
    "carol@example.com/sim",
  ]);

  const before = Date.now();
  await closeAndSettle(a2);
  const after = await c.call("who");
  expect(after.result.offline_hidden).toBe(1);
  const all = await c.call("who", { include_offline: true });
  const gone = all.result.peers.find((p: any) => p.handle === "alice@example.com/be-stream");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  const team = await b.call("who", { board: "eng", include_offline: true });
  expect(team.result.peers.map((p: any) => [p.handle, p.online])).toEqual([
    ["alice@example.com/be", true],
    ["alice@example.com/be-stream", false],
    ["bob@example.com/fe", true],
  ]);
  expect(await c.call("who", { board: "eng" })).toMatchObject({ type: "error", message: "no such board #eng; see board_list" });
});

test("unacked board pushes are resent after reconnect; acked ones aren't", async () => {
  const alice = await login("alice@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  const a = new Client(alice, "be");
  const s = new Client(alice, "sim");
  await a.connect();
  await s.connect();

  await a.call("board_post", { board: "eng", body: "@sim ping" });
  const first = await s.next(boardPush);
  await closeAndSettle(s);

  const s2 = new Client(alice, "sim");
  await s2.connect();
  const again = await s2.next(boardPush);
  expect(again.item.post.id).toBe(first.item.post.id);
  const refs = [{ kind: "push", post_id: again.item.post.id }];
  expect((await s2.request({ type: "board_ack", refs })).type).toBe("ack_ok");
  await closeAndSettle(s2);

  const s3 = new Client(alice, "sim");
  await s3.connect();
  await s3.none(boardPush);
});

test("team: sends post to the team board; digests coalesce until read", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(carol, "POST", "/api/teams/eng/join");
  const a = new Client(alice, "be");
  const c = new Client(carol, "sim");
  await a.connect();
  await c.connect();

  const sent = await a.request({ type: "send", recipient: "team:eng", body: "standup in 5" });
  expect(sent).toMatchObject({ type: "send_ok", board: "eng", delivered_now: true });
  const digest = await c.next(boardPush);
  expect(digest.item).toMatchObject({ kind: "digest", board: "eng", unread: 1 });

  await a.request({ type: "send", recipient: "team:eng", body: "make that 10" });
  await c.none(boardPush); // one digest until carol catches up

  await c.request({ type: "board_ack", refs: [{ kind: "digest", board: "eng", latest_id: digest.item.latest.id }] });
  const r = await c.call("board_read", { board: "eng" });
  expect(r.result.posts.map((p: any) => p.body)).toEqual(["standup in 5", "make that 10"]);

  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  expect(await b.request({ type: "send", recipient: "team:eng", body: "hi" })).toMatchObject({
    type: "error",
    message: "no such board #eng; see board_list",
  });
});

test("leaving a team drops its board and pending pushes", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(carol, "POST", "/api/teams/eng/join");
  const a = new Client(alice, "be");
  await a.connect();
  // carol is offline when mentioned, then leaves before connecting.
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: "@carol/sim are you there" });
  await api(carol, "POST", "/api/teams/eng/leave");

  const c = new Client(carol, "sim");
  await c.connect();
  await c.none(boardPush);
  expect((await c.call("board_list")).result).toEqual([]);
});

test("org boards are open to everyone; bare @name prefers the author's own identity", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = new Client(alice, "be");
  const as = new Client(alice, "sim");
  const bs = new Client(bob, "sim");
  for (const x of [a, as, bs]) await x.connect();

  expect((await a.call("board_create", { name: "general", purpose: "Everyone" })).type).toBe("call_ok");
  await a.call("board_post", { board: "general", body: "@sim run the fixtures" });
  expect((await as.next(boardPush)).item.reason).toBe("mention");
  await bs.none(boardPush);

  const r = await bs.call("board_read", { board: "general" });
  expect(r.result.posts).toHaveLength(1);
  expect(await bs.call("board_create", { name: "x", purpose: "y", team: "eng" })).toMatchObject({
    type: "error",
    message: 'no such team "eng"',
  });
});

test("claims are org-wide and atomic across users", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = new Client(alice, "be");
  const b = new Client(bob, "be");
  await a.connect();
  await b.connect();
  expect((await a.call("claim", { key: "ticket:ENG-1", note: "on it" })).result.ok).toBe(true);
  expect((await b.call("claim", { key: "ticket:ENG-1" })).result).toMatchObject({
    ok: false,
    held_by: "alice@example.com/be",
    note: "on it",
  });
  expect((await b.call("claims")).result.map((c: any) => c.key)).toEqual(["ticket:ENG-1"]);
});

test("a live identity refuses a second connection", async () => {
  const alice = await login("alice@example.com");
  const first = new Client(alice, "be");
  await first.connect();
  const second = new Client(alice, "be");
  expect(await second.connect()).toMatchObject({ type: "error", code: "identity_in_use" });
  // The first connection still works.
  expect((await first.call("board_list")).type).toBe("call_ok");
});

test("a connection that doesn't answer the probe is replaced", async () => {
  const alice = await login("alice@example.com");
  const stale = new Client(alice, "be", { pong: false });
  await stale.connect();
  const fresh = new Client(alice, "be");
  expect((await fresh.connect()).type).toBe("hello_ok");
  expect(await stale.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
});

test("direct messages still deliver live", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = new Client(alice, "be");
  const b = new Client(bob, "fe");
  await a.connect();
  await b.connect();
  const sent = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "hi" });
  expect(sent).toMatchObject({ type: "send_ok", delivered_now: true });
  expect((await b.next((m) => m.type === "push")).message.body).toBe("hi");
});
