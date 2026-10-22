// End-to-end over real WebSockets: an in-memory server with dev auth, and
// clients for two or three users. Covers the distributed board semantics in
// docs/architecture.md §4–5.
import { afterEach, beforeEach, expect, test } from "bun:test";

import { startServer } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";

const config = (overrides: Partial<Config> = {}): Config => ({
  dbPath: ":memory:",
  httpPort: 0,
  googleClientId: "dev",
  googleClientSecret: "",
  orgDomain: "example.com",
  publicUrl: "http://localhost",
  messageRetentionDays: 90,
  auditRetentionDays: 90,
  devAuth: true,
  admins: [],
  ...overrides,
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
    private opts: { pong?: boolean; push?: boolean; hello?: Record<string, unknown> } = {},
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
      this.ws.send(JSON.stringify({ type: "hello", req_id: "h", identity: this.identity, ...(this.opts.push === false ? { push: false } : {}), ...this.opts.hello }));
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
    } catch { /* the socket may already be dead; that's the point */ }
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
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });

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
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  const a = new Client(alice, "be");
  const a2 = new Client(alice, "be-stream");
  const b = new Client(bob, "fe");
  const c = new Client(carol, "sim");
  for (const x of [a, a2, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  const online = await c.call("peer_list");
  expect(online.result.you).toBe("carol@example.com/sim");
  expect(online.result.peers.map((p: any) => p.handle)).toEqual([
    "alice@example.com/be",
    "alice@example.com/be-stream",
    "bob@example.com/fe",
    "carol@example.com/sim",
  ]);

  const before = Date.now();
  await closeAndSettle(a2);
  const after = await c.call("peer_list");
  expect(after.result.offline_hidden).toBe(1);
  const all = await c.call("peer_list", { include_offline: true });
  const gone = all.result.peers.find((p: any) => p.handle === "alice@example.com/be-stream");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  const team = await b.call("peer_list", { board: "eng", include_offline: true });
  expect(team.result.peers.map((p: any) => [p.handle, p.online])).toEqual([
    ["alice@example.com/be", true],
    ["alice@example.com/be-stream", false],
    ["bob@example.com/fe", true],
  ]);
  expect(await c.call("peer_list", { board: "eng" })).toMatchObject({ type: "error", message: "no such board #eng; see board_list" });
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

test("peer_list shows where the client says it runs; a resumed hello keeps the status, a new session clears it", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const watcher = new Client(bob, "fe");
  await watcher.connect();
  const be = async () => (await watcher.call("peer_list", { include_offline: true })).result.peers.find((p: any) => p.handle === "alice@example.com/be");

  const first = new Client(alice, "be", { hello: { where: "api worktree stream \n on stream" } });
  await first.connect();
  await first.call("peer_status", { text: "soaking" });
  expect(await be()).toMatchObject({ where: "api worktree stream on stream", status: "soaking" });

  await closeAndSettle(first);
  const resumed = new Client(alice, "be", { hello: { where: "api worktree stream on main", resume: true } });
  await resumed.connect();
  expect(await be()).toMatchObject({ where: "api worktree stream on main", status: "soaking" });

  await closeAndSettle(resumed);
  await new Client(alice, "be").connect();
  const fresh = await be();
  expect(fresh.where).toBeUndefined();
  expect(fresh.status).toBeUndefined();
});

test("team boards: digests coalesce until read; team: is not a DM recipient", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  const a = new Client(alice, "be");
  const c = new Client(carol, "sim");
  await a.connect();
  await c.connect();

  expect(await a.request({ type: "send", recipient: "team:eng", body: "standup in 5" })).toMatchObject({
    type: "error",
    code: "bad_request",
  });
  // A digest never wakes a session by itself; it arrives with the next hello.
  await a.call("board_post", { board: "eng", body: "standup in 5" });
  await c.none(boardPush);
  await closeAndSettle(c);
  const c2 = new Client(carol, "sim");
  await c2.connect();
  const digest = await c2.next(boardPush);
  expect(digest.item).toMatchObject({ kind: "digest", board: "eng", unread: 1 });

  await a.call("board_post", { board: "eng", body: "make that 10" });
  await c2.none(boardPush); // one digest until carol catches up

  await c2.request({ type: "board_ack", refs: [{ kind: "digest", board: "eng", latest_id: digest.item.latest.id }] });
  const r = await c2.call("board_read", { board: "eng" });
  expect(r.result.posts.map((p: any) => p.body)).toEqual(["standup in 5", "make that 10"]);

  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  expect(await b.call("board_post", { board: "eng", body: "hi" })).toMatchObject({
    type: "error",
    message: "no such board #eng; see board_list",
  });
});

test("leaving a team drops its board and pending pushes", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
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

test("removing a member drops their board and pending pushes", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  const a = new Client(alice, "be");
  await a.connect();
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: "@carol/sim are you there" });
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "carol@example.com" })).status).toBe(200);

  const c = new Client(carol, "sim");
  await c.connect();
  await c.none(boardPush);
  expect((await c.call("board_list")).result).toEqual([]);
  expect((await api(carol, "GET", "/api/teams/eng/members")).status).toBe(404);
});

test("teams are invite-only: members add and remove; outsiders can't join, add, or see the roster", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });

  const join = await api(bob, "POST", "/api/teams/eng/join");
  expect(join).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("team add") } });
  // A non-member gets the same answer whether or not the team exists.
  for (const team of ["eng", "nope"]) {
    expect((await api(bob, "POST", `/api/teams/${team}/add`, { email: "bob@example.com" })).status).toBe(404);
    expect((await api(bob, "GET", `/api/teams/${team}/members`)).status).toBe(404);
    expect((await api(bob, "POST", `/api/teams/${team}/remove`, { email: "alice@example.com" })).status).toBe(404);
  }

  const never = await api(alice, "POST", "/api/teams/eng/add", { email: "dave@example.com" });
  expect(never).toMatchObject({ status: 404, body: { message: expect.stringContaining("never signed in") } });

  // Any member can add; the added member can add others and remove.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "Bob@Example.com" })).status).toBe(200);
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(200);
  const members = await api(carol, "GET", "/api/teams/eng/members");
  expect(members.body.map((m: { email: string }) => m.email).sort()).toEqual([
    "alice@example.com", "bob@example.com", "carol@example.com",
  ]);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual([]);

  const audit = app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action = 'team.member_removed'")
    .all();
  expect(audit).toEqual([{ actor: "carol@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com"}' }]);
});

test("admin routes: refused for non-admins and when no admins are configured", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  const none = await api(alice, "POST", "/api/admin/disable-user", { email: "bob@example.com" });
  expect(none).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("GRAYBOARD_ADMINS") } });

  app.stop();
  app = startServer(config({ admins: ["alice@example.com"] }), { probeMs: 150, background: false });
  base = `http://localhost:${app.server.port}`;
  const admin = await login("alice@example.com");
  const bob = await login("bob@example.com");
  for (const path of ["/api/admin/disable-user", "/api/admin/enable-user", "/api/admin/revoke-session"]) {
    expect((await api(bob, "POST", path, { email: "alice@example.com" })).status).toBe(403);
  }
  expect((await api(admin, "POST", "/api/admin/disable-user", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(401);
});

test("admin revoke-session signs a user out of every session, ignoring an old CLI's all", async () => {
  app.stop();
  app = startServer(config({ admins: ["root@example.com"] }), { probeMs: 150, background: false });
  base = `http://localhost:${app.server.port}`;
  const root = await login("root@example.com");
  for (const all of [false, true, undefined]) {
    const laptop = await login("bob@example.com");
    const desktop = await login("bob@example.com");
    expect((await api(root, "POST", "/api/admin/revoke-session", { email: "bob@example.com", ...(all !== undefined ? { all } : {}) })).status).toBe(200);
    expect((await api(laptop, "GET", "/api/whoami")).status).toBe(401);
    expect((await api(desktop, "GET", "/api/whoami")).status).toBe(401);
  }
});

test("revoking or disabling a user closes their open connections; the heartbeat catches a disable it missed", async () => {
  app.stop();
  app = startServer(config({ admins: ["root@example.com"] }), { probeMs: 150, background: false });
  base = `http://localhost:${app.server.port}`;
  const [root, alice] = await Promise.all([login("root@example.com"), login("alice@example.com")]);
  const a = new Client(alice, "be");
  await a.connect();
  const closed = (c: Client) => new Promise<void>((resolve) => c.ws.addEventListener("close", () => resolve()));

  for (const path of ["/api/admin/revoke-session", "/api/admin/disable-user"]) {
    await api(root, "POST", "/api/admin/enable-user", { email: "bob@example.com" });
    const bob = await login("bob@example.com");
    const live = new Client(bob, "be");
    const tools = new Client(bob, "fe", { push: false });
    await Promise.all([live.connect(), tools.connect()]);
    const gone = Promise.all([closed(live), closed(tools)]);
    expect((await api(root, "POST", path, { email: "bob@example.com" })).status).toBe(200);
    expect(await live.next((m) => m.type === "error")).toMatchObject({ code: "unauthenticated" });
    await gone;
  }
  expect((await a.call("board_list")).type).toBe("call_ok");

  // Disabled behind the server's back (no admin route): the next tick closes it.
  await api(root, "POST", "/api/admin/enable-user", { email: "bob@example.com" });
  const late = new Client(await login("bob@example.com"), "be");
  await late.connect();
  const gone = closed(late);
  app.repo.users.setDisabled(app.repo.users.findByEmail("bob@example.com")!.id, true);
  app.revalidate();
  await gone;
  expect((await a.call("board_list")).type).toBe("call_ok");
});

test("an admin can manage a team they're not in, e.g. after its last member left", async () => {
  app.stop();
  app = startServer(config({ admins: ["root@example.com"] }), { probeMs: 150, background: false });
  base = `http://localhost:${app.server.port}`;
  const root = await login("root@example.com");
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/leave");
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(404);

  expect((await api(root, "GET", "/api/teams/eng/members")).body).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(root, "GET", "/api/teams/nope/members")).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual(["eng"]);
  // Managing doesn't make the admin a member.
  expect((await api(root, "GET", "/api/whoami")).body.teams).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);

  const audit = app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action LIKE 'team.member_%' AND actor = 'root@example.com'")
    .all();
  expect(audit).toEqual([
    { actor: "root@example.com", action: "team.member_added", detail: '{"member":"bob@example.com","as_admin":true}' },
    { actor: "root@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com","as_admin":true}' },
  ]);
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
  expect((await a.call("claim_take", { key: "ticket:ENG-1", note: "on it" })).result.ok).toBe(true);
  expect((await b.call("claim_take", { key: "ticket:ENG-1" })).result).toMatchObject({
    ok: false,
    held_by: "alice@example.com/be",
    note: "on it",
  });
  expect((await b.call("claim_list")).result.map((c: any) => c.key)).toEqual(["ticket:ENG-1"]);
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

test("a second push session on another lane joins as a tool lane; the owner is told", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = new Client(alice, "be");
  await owner.connect();
  const lane = new Client(alice, "be", { hello: { lane: "research-3" } });
  const hello = await lane.connect();
  expect(hello).toMatchObject({ type: "hello_ok", lane: "research-3", push_granted: false, owner_lane: "main" });
  expect(hello.notices.some((n: string) => n.includes('owned by lane "main"'))).toBe(true);
  // The owner learns its fleet grew.
  const evt = await owner.next((m) => m.type === "fleet");
  expect(evt).toMatchObject({ event: "lane_joined", lane: "research-3" });
  // The lane is tools-only: it can call tools, but a DM is delivered to the owner.
  const b = new Client(bob, "fe");
  await b.connect();
  expect((await lane.call("board_list")).type).toBe("call_ok");
  const sent = await b.request({ type: "send", recipient: "alice@example.com/be", body: "who's driving?" });
  expect(sent).toMatchObject({ delivered_now: true, live_lanes: 2 });
  expect((await owner.next((m) => m.type === "push")).message.body).toBe("who's driving?");
  await lane.none((m) => m.type === "push");
  // The roster shows one row per live lane, the default lane unmarked.
  const peers = (await b.call("peer_list")).result.peers.filter((p: any) => p.handle === "alice@example.com/be");
  expect(peers.map((p: any) => p.lane)).toEqual([undefined, "research-3"]);
});

test("an explicit join attaches or refuses — never a lazy fork on a typo", async () => {
  const alice = await login("alice@example.com");
  const real = new Client(alice, "be");
  await real.connect();
  // A client whose identity came from BUS_IDENTITY (explicit: true) with a
  // typo'd name is refused, naming the user's existing identities.
  const typo = new Client(alice, "sim-ordering", { hello: { explicit: true } });
  const refused = await typo.connect();
  expect(refused).toMatchObject({ type: "error", code: "not_found" });
  expect(refused.message).toContain("alice@example.com/be");
  // The refusal names the remedy, not just the problem.
  expect(refused.message).toContain("grayboard identity create sim-ordering");
  const list = await api(alice, "GET", "/api/identities");
  expect((list.body as any[]).map((i) => i.name)).not.toContain("sim-ordering");
  // A derived identity (no explicit flag) still lazy-creates, with the notice.
  const derived = new Client(alice, "side");
  const hello = await derived.connect();
  expect(hello).toMatchObject({ type: "hello_ok" });
  expect(hello.notices.some((n: string) => n.includes("created"))).toBe(true);
  // A user with no identities yet is bootstrapping, even with BUS_IDENTITY:
  // the first pinned identity creates, with the notice.
  const carol = await login("carol@example.com");
  const first = new Client(carol, "fe", { hello: { explicit: true } });
  const boot = await first.connect();
  expect(boot).toMatchObject({ type: "hello_ok" });
  expect(boot.notices.some((n: string) => n.includes("created"))).toBe(true);
});

test("a lane-less push hello under an owner on another lane is refused, not silently demoted", async () => {
  const alice = await login("alice@example.com");
  // The owner lives on a named lane (e.g. after a rotation).
  const owner = new Client(alice, "be", { hello: { lane: "research" } });
  await owner.connect();
  // A client predating lanes: no lane field, wants push. It would silently
  // join tools-only and never learn why — refuse it the way it has always
  // been refused.
  const old = new Client(alice, "be");
  const refused = await old.connect();
  expect(refused).toMatchObject({ type: "error", code: "identity_in_use" });
  // A lane-aware client on main still demotes (that's the fleet path).
  const laneAware = new Client(alice, "be", { hello: { lane: "main" } });
  expect(await laneAware.connect()).toMatchObject({ type: "hello_ok", push_granted: false, owner_lane: "research" });
});

test("owner close rotates push to the lane: fleet event, no replay of the owner's handled DMs, unacked boards redelivered", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = new Client(alice, "be");
  await owner.connect();
  const lane = new Client(alice, "be", { hello: { lane: "b" } });
  await lane.connect(); // demoted: tools-only, holds lane key "b"

  const b = new Client(bob, "fe");
  await b.connect();
  // Two DMs arrive while the lane is demoted. The owner behaves like the
  // real client: it receives each push and acks it (auto-ack); the demoted
  // lane receives nothing and acks nothing — a client can only ack what it
  // received, so its cursor stays where it was.
  for (const body of ["one", "two"]) {
    const m = await b.request({ type: "send", recipient: "alice@example.com/be", body });
    expect((await owner.next((x) => x.type === "push")).message.body).toBe(body);
    await owner.request({ type: "ack", message_ids: [m.message_id] });
  }
  // An unacked board push sits in the outbox for the identity.
  await b.call("board_create", { name: "e2e", purpose: "fixtures" });
  await b.call("board_post", { board: "e2e", body: "@alice/be look" });
  const item = await owner.next((m) => m.type === "board_push");
  expect(item.item.post.body).toContain("look"); // received, never acked

  await closeAndSettle(owner);
  // Rotation: the lane is told it owns delivery now. The identity's read
  // point (the owner's acks) covers both DMs — a real client acked them, so
  // nothing replays — and only the unacked board item redelivers
  // (at-least-once, the safe direction).
  expect(await lane.next((m) => m.type === "fleet")).toMatchObject({ event: "owner_rotated", lane: "b" });
  await lane.none((m) => m.type === "push");
  const redelivered = await lane.next((m) => m.type === "board_push");
  expect(redelivered.item.post.id).toBe(item.item.post.id);

  // It owns delivery now: a new DM arrives live.
  await b.request({ type: "send", recipient: "alice@example.com/be", body: "three" });
  expect((await lane.next((m) => m.type === "push")).message.body).toBe("three");
  const audit = app.db.prepare(`SELECT action FROM access_log WHERE action = 'lane.owner_rotated'`).all() as { action: string }[];
  expect(audit.length).toBe(1);
});

test("per-lane DM cursors: a lane's ack never suppresses a sibling's pending delivery", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  const owner = new Client(alice, "be");
  await owner.connect();

  const m1 = await b.request({ type: "send", recipient: "alice@example.com/be", body: "first" });
  expect((await owner.next((m) => m.type === "push")).message.body).toBe("first");
  // A lane joins, is demoted, and acks the message from its own stream: its
  // cursor moves, the owner's doesn't.
  const lane = new Client(alice, "be", { hello: { lane: "b" } });
  await lane.connect();
  await lane.request({ type: "ack", message_ids: [m1.message_id] });
  const sent = await b.request({ type: "send", recipient: "alice@example.com/be", body: "second" });
  // Read markers are "caught up to just before this message": the lane had
  // read "first", the owner (live but unacked) hadn't.
  expect(sent).toMatchObject({ live_lanes: 2, read_lanes: ["b"] });
  expect((await owner.next((m) => m.type === "push")).message.body).toBe("second");
  await owner.request({ type: "ack", message_ids: [sent.message_id] });
  const both = await b.request({ type: "send", recipient: "alice@example.com/be", body: "third" });
  expect(both.read_lanes).toEqual(["main"]); // the owner is caught up; the lane stopped at "first"

  // A lane offline at send time rejoins: the owner acked on past what it
  // missed, and any lane's ack is the identity reading — so the read point
  // covers "second" and "third", and nothing replays to the rejoined lane.
  await closeAndSettle(lane);
  await owner.request({ type: "ack", message_ids: [both.message_id] });
  const rejoined = new Client(alice, "be", { hello: { lane: "b", resume: true } });
  await rejoined.connect();
  await rejoined.none((m) => m.type === "push");

  // A fresh lane seeds from the identity's read point — the MAX across
  // lanes, not just main's cursor — so joining a fleet must not replay the
  // identity's already-read history.
  const fresh = new Client(alice, "be", { hello: { lane: "c" } });
  await fresh.connect();
  await fresh.none((m) => m.type === "push");
});

test("a fresh lane joins an identity that only ever ran non-main lanes without replaying its history", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  // The identity has only ever run on worktree-style lanes: main has no
  // cursor row at all (its cursor is 0).
  const wt = new Client(alice, "be", { hello: { lane: "stream" } });
  await wt.connect();
  const m = await b.request({ type: "send", recipient: "alice@example.com/be", body: "read on the worktree lane" });
  expect((await wt.next((x) => x.type === "push")).message.body).toBe("read on the worktree lane");
  await wt.request({ type: "ack", message_ids: [m.message_id] });
  // A fresh lane seeds from the identity's read point — the MAX across
  // lanes ("stream"'s cursor), not main's 0 — so the history doesn't replay.
  const fresh = new Client(alice, "be", { hello: { lane: "c" } });
  await fresh.connect();
  await fresh.none((x) => x.type === "push");
});

test("auto-drop: a closed lane's row goes; the roster keeps no ghost lane", async () => {
  const alice = await login("alice@example.com");
  const owner = new Client(alice, "be");
  await owner.connect();
  const lane = new Client(alice, "be", { hello: { lane: "gone" } });
  await lane.connect();
  const fleet = await api(alice, "GET", "/api/fleet?identity=be");
  expect(fleet.body.map((l: any) => l.lane).sort()).toEqual(["gone", "main"]);

  await closeAndSettle(lane);
  const after = await api(alice, "GET", "/api/fleet?identity=be");
  expect(after.body.map((l: any) => l.lane)).toEqual(["main"]);
  const peers = (await owner.call("peer_list", { include_offline: true })).result.peers.filter((p: any) => p.handle === "alice@example.com/be");
  expect(peers.map((p: any) => p.lane)).toEqual([undefined]);
});

test("fleet disconnect is owner-ordered, audited, and never invents lanes", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = new Client(alice, "be");
  await owner.connect();
  const lane = new Client(alice, "be", { hello: { lane: "b" } });
  await lane.connect();

  // Not the identity's user: nothing to disconnect (and no existence leak).
  expect((await api(bob, "POST", "/api/fleet/disconnect", { identity: "be", lane: "b" })).status).toBe(404);
  // Unknown identity names what the caller has.
  expect((await api(alice, "POST", "/api/fleet/disconnect", { identity: "si", lane: "b" })).status).toBe(404);
  // Unknown lane names the live ones.
  expect((await api(alice, "POST", "/api/fleet/disconnect", { identity: "be", lane: "nope" })).status).toBe(404);

  expect((await api(alice, "POST", "/api/fleet/disconnect", { identity: "be", lane: "b" })).status).toBe(200);
  expect(await lane.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
  const audit = app.db.prepare(`SELECT action, target, detail FROM access_log WHERE action = 'lane.disconnected'`).all() as { action: string; target: string; detail: string }[];
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0]!.detail)).toMatchObject({ lane: "b" });
  // The owner stays live and keeps delivery.
  expect((await owner.call("board_list")).type).toBe("call_ok");

  // The disconnected lane's row went with its connection: no ghost for the roster.
  await Bun.sleep(50);
  expect((await api(alice, "GET", "/api/fleet?identity=be")).body.map((l: any) => l.lane)).toEqual(["main"]);

  // Enforcement is audit + revocation, not prevention: the kicked process,
  // still holding its token, rejoins (demoted again — the owner is live).
  const again = new Client(alice, "be", { hello: { lane: "b" } });
  expect(await again.connect()).toMatchObject({ type: "hello_ok", push_granted: false });

  // Disconnect never reaches a human handle's sessions (slack-bridge §3):
  // the reserved name, and a handle declared human.
  expect((await api(alice, "POST", "/api/fleet/disconnect", { identity: "human", lane: "main" })).status).toBe(400);
  app.db.prepare(`UPDATE handles SET human = 1 WHERE name = ?`).run("alice@example.com/be");
  expect((await api(alice, "POST", "/api/fleet/disconnect", { identity: "be", lane: "main" })).status).toBe(403);
});

test("simultaneous push joins on distinct lanes: exactly one owner, the rest demoted", async () => {
  const alice = await login("alice@example.com");
  const a = new Client(alice, "be", { hello: { lane: "a" } });
  const b = new Client(alice, "be", { hello: { lane: "b" } });
  const [ra, rb] = await Promise.all([a.connect(), b.connect()]);
  const results = [ra, rb];
  expect(results.filter((r) => r.type === "hello_ok" && r.push_granted !== false)).toHaveLength(1);
  expect(results.filter((r) => r.type === "hello_ok" && r.push_granted === false)).toHaveLength(1);
  for (const c of [a, b]) expect((await c.call("board_list")).type).toBe("call_ok");
  const fleet = await api(alice, "GET", "/api/fleet?identity=be");
  expect(fleet.body.filter((l: any) => l.push_owner).length).toBe(1);
});

test("a fleet of many lanes: one owner, the rest tools-only, all usable", async () => {
  const alice = await login("alice@example.com");
  // Lane-aware on every lane, including main: a lane-less (old-client) hello
  // is refused under a foreign-lane owner instead of joining the fleet.
  const conns = [new Client(alice, "be", { hello: { lane: "main" } })];
  for (const lane of ["b", "c", "d", "e"]) conns.push(new Client(alice, "be", { hello: { lane } }));
  const results = await Promise.all(conns.map((c) => c.connect()));
  expect(results.filter((r) => r.type === "hello_ok" && r.push_granted !== false)).toHaveLength(1);
  for (const c of conns) expect((await c.call("claim_list")).type).toBe("call_ok");
  const fleet = await api(alice, "GET", "/api/fleet?identity=be");
  expect(fleet.body.filter((l: any) => l.live).length).toBe(5);
  expect(fleet.body.filter((l: any) => l.push_owner).length).toBe(1);
});

test("a connection that doesn't answer the probe is replaced", async () => {
  const alice = await login("alice@example.com");
  const stale = new Client(alice, "be", { pong: false });
  await stale.connect();
  const fresh = new Client(alice, "be");
  expect((await fresh.connect()).type).toBe("hello_ok");
  expect(await stale.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
});

test("a half-open owner on another lane is probed before demotion and superseded: the newcomer takes over", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  // The owner holds the push slot but never answers pings (a machine asleep
  // with its session open — TCP still looks open from the server's side).
  const owner = new Client(alice, "be", { hello: { lane: "research" }, pong: false });
  await owner.connect();
  const b = new Client(bob, "fe");
  await b.connect();
  // A newcomer on ANOTHER lane: before this PR's demotion path it would
  // have joined tools-only under a ghost that never delivers. Instead the
  // owner is probed like a pre-fleet holder, found dead, and superseded.
  const lane = new Client(alice, "be", { hello: { lane: "b" } });
  const hello = await lane.connect();
  expect(hello.type).toBe("hello_ok");
  expect(hello.push_granted).toBeUndefined(); // not demoted: it took over
  await b.request({ type: "send", recipient: "alice@example.com/be", body: "anyone?" });
  expect((await lane.next((m) => m.type === "push")).message.body).toBe("anyone?");
  // The old owner's socket death is handled: superseded error on its side.
  expect(await owner.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
});

test("the heartbeat closes a socket that stops answering pings", async () => {
  const alice = await login("alice@example.com");
  const local = startServer(config(), { probeMs: 150, pingIntervalMs: 20, pingMissLimit: 2 });
  const base2 = `http://localhost:${local.server.port}`;
  try {
    const login2 = async (email: string) =>
      ((await (await fetch(`${base2}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) })).json()) as { session_token: string }).session_token;
    const token = await login2("alice@example.com");
    // Pongs normally, then stops: half-open from the heartbeat's view.
    const ws = new (WebSocket as any)(`${base2.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
    const got: any[] = [];
    let pong = true;
    ws.onmessage = (e: any) => {
      const m = JSON.parse(e.data);
      got.push(m);
      if (m.type === "ping" && pong) ws.send(JSON.stringify({ type: "pong" }));
    };
    await new Promise<void>((r) => { ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", req_id: "h", identity: "be" })); r(); }; });
    await new Promise<void>((r) => setTimeout(r, 80)); // hello_ok + a few pings answered
    pong = false; // the machine went to sleep
    const close = new Promise<void>((r) => { ws.onclose = () => r(); });
    await close;
    // The close is explained server-side, not silent.
    expect(got.filter((m) => m.type === "error" && m.code === "superseded").length).toBe(1);
    expect(got.at(-1)!.type).not.toBe("hello_ok");
  } finally {
    local.stop();
  }
  void alice;
});

test("a hello arriving while another probes the holder waits for it, so only one wins", async () => {
  const [alice, bob] = await Promise.all([login("alice@example.com"), login("bob@example.com")]);
  const dead = new Client(alice, "be", { pong: false });
  await dead.connect();
  const n1 = new Client(alice, "be");
  const first = n1.connect(); // probes the dead holder (150 ms)
  await Bun.sleep(40);
  dead.close(); // the holder goes away mid-probe
  await Bun.sleep(40);
  const n2 = new Client(alice, "be");
  const [r1, r2] = await Promise.all([first, n2.connect()]);
  expect(r1.type).toBe("hello_ok");
  expect(r2).toMatchObject({ type: "error", code: "identity_in_use" });

  const b = new Client(bob, "fe");
  await b.connect();
  expect(await b.request({ type: "send", recipient: "alice@example.com/be", body: "who?" })).toMatchObject({ delivered_now: true });
  expect((await n1.next((m) => m.type === "push")).message.body).toBe("who?");
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

test("deleting an identity closes its live connections superseded-style, and no roster ghost follows", async () => {
  const alice = await login("alice@example.com");
  const be = new Client(alice, "be");
  const fe = new Client(alice, "fe");
  await Promise.all([be.connect(), fe.connect()]);
  await be.request({ type: "send", recipient: "fe", body: "hi" });
  const id = (await fe.next((m) => m.type === "push")).message.id;
  // Deleting the identity under its live connection closes it (#73's fix
  // shape): the close path can't re-insert a deleted handle as a ghost, and
  // the connection's pending ack dies with it instead of throwing.
  expect((await api(alice, "DELETE", "/api/identities/fe")).status).toBe(200);
  expect(await fe.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
  expect((await be.call("peer_list", { include_offline: true })).result.peers.find((p: any) => p.handle === "alice@example.com/fe")).toBeUndefined();
  // The ack frame never ran: the DM is still unread for the (now gone) identity.
  void id;
});

test("login refuses an email no direct address can carry", async () => {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "o'brien@example.com" }) });
  expect(r.status).toBe(400);
});

test("a bare DM recipient is your own identity of that name, else the only one with it", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((n) => login(`${n}@example.com`)));
  const a = new Client(alice, "be");
  const a2 = new Client(alice, "be-stream");
  const b = new Client(bob, "be-stream");
  const b2 = new Client(bob, "fe");
  const c = new Client(carol, "fe");
  await Promise.all([a, a2, b, b2, c].map((x) => x.connect()));

  // alice and bob both have be-stream: alice's bare name means her own.
  expect(await a.request({ type: "send", recipient: "be-stream", body: "mine" })).toMatchObject({ type: "send_ok" });
  expect((await a2.next((m) => m.type === "push")).message.body).toBe("mine");
  // carol has no be: the only be is alice's.
  expect(await c.request({ type: "send", recipient: "be", body: "only one" })).toMatchObject({ type: "send_ok" });
  expect((await a.next((m) => m.type === "push")).message.body).toBe("only one");
  // alice has no fe, and bob and carol each have one: ambiguous.
  const amb = await a.request({ type: "send", recipient: "fe", body: "?" });
  expect(amb).toMatchObject({ type: "error", code: "not_found" });
  expect(amb.message).toContain("bob@example.com/fe, carol@example.com/fe");
  expect(await a.request({ type: "send", recipient: "nobody", body: "?" })).toMatchObject({ type: "error", code: "not_found" });
});

test("dm_history: peer resolves like dm_send's recipient, oldest first, limit clamped; empty bodies refused", async () => {
  const [alice, bob] = await Promise.all([login("alice@example.com"), login("bob@example.com")]);
  const a = new Client(alice, "be");
  const b = new Client(bob, "fe");
  await Promise.all([a.connect(), b.connect()]);
  for (const body of ["one", "two", "three"]) await a.request({ type: "send", recipient: "fe", body });
  expect(await a.request({ type: "send", recipient: "fe", body: "  " })).toMatchObject({ type: "error", code: "bad_request" });

  const bodies = async (peer: string, limit?: number) =>
    (await a.request({ type: "history", peer, ...(limit !== undefined ? { limit } : {}) })).messages.map((m: any) => m.body);
  expect(await bodies("fe")).toEqual(["one", "two", "three"]);
  expect(await bodies("Bob@Example.com/FE")).toEqual(["one", "two", "three"]);
  expect(await bodies("fe", 2)).toEqual(["two", "three"]);
  expect(await bodies("fe", 0)).toEqual(["three"]);
  expect(await a.request({ type: "history", peer: "nobody" })).toMatchObject({ type: "error", code: "not_found" });
});

test("senders see what hasn't reached an offline peer", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  const a = new Client(alice, "be");
  await a.connect();
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "one" });
  const sent = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "two" });
  expect(sent).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  const delivered = async () =>
    (await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.delivered);
  expect(await delivered()).toEqual([false, false]);

  const b2 = new Client(bob, "fe");
  await b2.connect();
  const ids = [(await b2.next((m) => m.type === "push")).message.id, (await b2.next((m) => m.type === "push")).message.id];
  await b2.request({ type: "ack", message_ids: ids });
  expect(await delivered()).toEqual([true, true]);
});

test("dm_retract withdraws a queued message; one the recipient is holding or has acked stays", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  const a = new Client(alice, "be");
  await a.connect();
  const fresh = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fresh" });
  expect(fresh.note).toMatch(/^Recipient offline/);
  app.db.prepare("UPDATE handles SET last_seen = ? WHERE name = ?").run(Date.now() - 22 * 3_600_000, "bob@example.com/fe");
  const wrong = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "wrong" });
  expect(wrong.note).toMatch(/^Queued: bob@example.com\/fe last seen 22h ago\. .*dm_retract/);

  const other = new Client(bob, "sim");
  await other.connect();
  expect(await other.request({ type: "dm_retract", message_id: wrong.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_retract", message_id: wrong.message_id })).toMatchObject({ type: "ack_ok" });
  expect((await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.body)).toEqual(["fresh"]);

  // Pushed but not acked: the cursor hasn't moved, but bob is live.
  const b2 = new Client(bob, "fe");
  await b2.connect();
  expect((await b2.next((m) => m.type === "push")).message.body).toBe("fresh");
  await b2.none((m) => m.type === "push");
  const held = await a.request({ type: "dm_retract", message_id: fresh.message_id });
  expect(held).toMatchObject({ type: "error", message: expect.stringContaining("already reached") });
});

test("hello_ok carries active claims and DMs undelivered after a day", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = new Client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  // Created up front, so the first hello carries no "new identity" notice.
  await api(alice, "POST", "/api/identities", { name: "be" });
  const a = new Client(alice, "be");
  expect((await a.connect()).notices).toBeUndefined();
  await a.call("claim_take", { key: "ticket:ENG-2", note: "on it" });
  const old = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "stale" });
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fresh" });
  app.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, old.message_id);
  await closeAndSettle(a);

  const notices: string[] = (await new Client(alice, "be").connect()).notices;
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain(`bob@example.com/fe: 1 since message_id ${old.message_id} (last seen`);
  expect(notices[1]).toMatch(/Yours: ticket:ENG-2 \(until \d{4}-\d\d-\d\dT\d\d:\d\dZ: on it\)\./);
  expect((await new Client(alice, "sim").connect()).notices.some((n: string) => n.includes("Others': ticket:ENG-2."))).toBe(true);
});

test("dm_inbox: replied and acked messages drop out; only the recipient can ack", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = new Client(alice, "be");
  const b = new Client(bob, "fe");
  await a.connect();
  await b.connect();
  const q = await b.request({ type: "send", recipient: "alice@example.com/be", body: "question?" });
  const fyi = await b.request({ type: "send", recipient: "alice@example.com/be", body: "FYI" });
  const inbox = async () => (await a.request({ type: "inbox" })).unanswered.map((m: any) => m.id);
  expect(await inbox()).toEqual([q.message_id, fyi.message_id]);

  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "answer", parent_id: q.message_id });
  expect(await b.request({ type: "dm_ack", message_id: fyi.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_ack", message_id: fyi.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await inbox()).toEqual([]);
});

test("a pending send is echoed, listed as promised until the sender's next message, and ackable by the sender", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = new Client(alice, "be");
  const b = new Client(bob, "fe");
  await a.connect();
  await b.connect();
  const p = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "results by noon", pending: true });
  expect(p).toMatchObject({ type: "send_ok", pending: true });
  const plain = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fyi" });
  expect(plain.pending).toBeUndefined();
  const promises = async () => (await a.request({ type: "inbox", days: 1 })).promised?.map((m: any) => m.id);
  expect(await promises()).toEqual([p.message_id]);
  // History is oldest first; only the pending row says so.
  expect((await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.pending)).toEqual([true, undefined]);

  // Bob's reply doesn't keep it, and his ack (as its recipient) doesn't drop it.
  await b.request({ type: "send", recipient: "alice@example.com/be", body: "thanks", parent_id: p.message_id });
  expect(await b.request({ type: "dm_ack", message_id: p.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await promises()).toEqual([p.message_id]);
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "done", parent_id: p.message_id });
  expect(await promises()).toBeUndefined();

  const p2 = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "later", pending: true });
  expect(await a.request({ type: "dm_ack", message_id: plain.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_ack", message_id: p2.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await promises()).toBeUndefined();
});

test("only a message's sender and recipient can read its thread or reply to it", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((n) => login(`${n}@example.com`)));
  const a = new Client(alice!, "be");
  const b = new Client(bob!, "fe");
  const c = new Client(carol!, "sim");
  await Promise.all([a.connect(), b.connect(), c.connect()]);
  const root = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "private" });
  const reply = await b.request({ type: "send", recipient: "alice@example.com/be", body: "re", parent_id: root.message_id });
  expect((await b.request({ type: "thread", message_id: root.message_id })).messages.map((m: any) => m.id)).toEqual([
    root.message_id,
    reply.message_id,
  ]);
  expect(await c.request({ type: "thread", message_id: reply.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await c.request({ type: "send", recipient: "alice@example.com/be", body: "x", parent_id: root.message_id })).toMatchObject({
    type: "error",
    code: "not_found",
  });
  expect(await a.request({ type: "send", recipient: "bob@example.com/fe", body: "x", parent_id: 99999 })).toMatchObject({
    type: "error",
  });
});

test("a tools-only connection works beside the live owner without taking its pushes", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = new Client(alice, "be");
  await owner.connect();
  const tools = new Client(alice, "be", { push: false });
  expect(await tools.connect()).toMatchObject({ type: "hello_ok" });
  const b = new Client(bob, "fe");
  await b.connect();

  const sent = await b.request({ type: "send", recipient: "alice@example.com/be", body: "hi" });
  expect(sent.delivered_now).toBe(true);
  expect((await owner.next((m) => m.type === "push")).message.body).toBe("hi");
  expect((await b.call("board_create", { name: "e2e", purpose: "x" })).type).toBe("call_ok");
  expect((await tools.request({ type: "call", tool: "board_list", args: {} })).type).toBe("call_ok");
  await tools.none((m) => m.type === "push" || m.type === "board_push");

  await closeAndSettle(tools);
  const peers = (await b.call("peer_list")).result.peers;
  expect(peers.find((p: any) => p.handle === "alice@example.com/be")?.online).toBe(true);
});
