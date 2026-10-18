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
  await a.call("board_post", { board: "eng", body: "standup in 5" });
  const digest = await c.next(boardPush);
  expect(digest.item).toMatchObject({ kind: "digest", board: "eng", unread: 1 });

  await a.call("board_post", { board: "eng", body: "make that 10" });
  await c.none(boardPush); // one digest until carol catches up

  await c.request({ type: "board_ack", refs: [{ kind: "digest", board: "eng", latest_id: digest.item.latest.id }] });
  const r = await c.call("board_read", { board: "eng" });
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
  const a = new Client(alice, "be");
  expect((await a.connect()).notices).toBeUndefined();
  await a.call("claim_take", { key: "ticket:ENG-2", note: "on it" });
  const old = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "stale" });
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fresh" });
  app.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, old.message_id);
  await closeAndSettle(a);

  const notices: string[] = (await new Client(alice, "be").connect()).notices;
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain("ticket:ENG-2 (held by alice@example.com/be until");
  expect(notices[1]).toContain(`bob@example.com/fe: 1 since message_id ${old.message_id} (last seen`);
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
