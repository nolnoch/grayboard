// End-to-end over real WebSockets: an in-memory server with dev auth, and
// clients for two or three users. Covers the distributed board semantics in
// docs/architecture.md §4–5.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startServer } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { serverEnv } from "../support/env.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";

// Each test's server gets its own temp dir, so the blob store and any state
// on disk never cross tests.
const config = (dir: string, overrides: Partial<Config> = {}): Config => ({
  dbPath: ":memory:",
  blobDir: join(dir, "blobs"),
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
let dir: string;
const open: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-fleet-"));
  app = startServer(config(dir), { probeMs: 150, background: false });
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


async function closeAndSettle(c: Client) {
  c.close();
  await Bun.sleep(50);
}

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
  // A derived identity (no explicit flag) still lazy-creates — silently:
  // master's hello_ok contract keeps a fresh identity's notices undefined
  // (the identity.created audit row is the record, not a notice sentence
  // every session pays for).
  const derived = new Client(alice, "side");
  const hello = await derived.connect();
  expect(hello).toMatchObject({ type: "hello_ok" });
  expect(hello.notices).toBeUndefined();
  // A user with no identities yet is bootstrapping, even with BUS_IDENTITY:
  // the first pinned identity creates (silently, same rule).
  const carol = await login("carol@example.com");
  const first = new Client(carol, "fe", { hello: { explicit: true } });
  const boot = await first.connect();
  expect(boot).toMatchObject({ type: "hello_ok" });
  expect(boot.notices).toBeUndefined();
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

test("read_lanes compares against the sender's previous message to the recipient, not the global id below (N4)", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  const fe = new Client(alice, "fe");
  await fe.connect();
  // Two live lanes of the recipient, so send_ok carries fleet truth.
  const be = new Client(bob, "be", { hello: { lane: "research" } });
  await be.connect();
  const be2 = new Client(bob, "be", { hello: { lane: "scratch" }, push: false });
  await be2.connect();
  const sim = new Client(carol, "sim");
  await sim.connect();

  // fe↔be exchange, then an UNRELATED pair's message takes the very next
  // global id, then fe↔be again. "Caught up before this message" must mean
  // the sender's previous message ADDRESSED TO the recipient — with the old
  // `id - 1` compare, the noise message's id hid the recipient's read state.
  const one = await fe.request({ type: "send", recipient: "bob@example.com/be", body: "one" });
  await be.next((x) => x.type === "push");
  await be.request({ type: "ack", message_ids: [one.message_id] });
  await sim.request({ type: "send", recipient: "alice@example.com/fe", body: "noise" });
  const two = await fe.request({ type: "send", recipient: "bob@example.com/be", body: "two" });
  expect(two).toMatchObject({ type: "send_ok", live_lanes: 2, read_lanes: ["research"] });
  // A REPLY from the recipient no longer hides its read state: "the pair's
  // previous message" is the previous one ADDRESSED TO the recipient, not
  // any message in the pair — the recipient's own reply sits above its
  // receive cursor forever, so a bidirectional compare always hid read_lanes
  // after the first back-and-forth (the common case).
  await be.next((x) => x.type === "push" && x.message.body === "two");
  await be.request({ type: "ack", message_ids: [two.message_id] });
  await be.request({ type: "send", recipient: "alice@example.com/fe", body: "be replies" });
  await fe.next((x) => x.type === "push");
  const three = await fe.request({ type: "send", recipient: "bob@example.com/be", body: "three" });
  expect(three).toMatchObject({ type: "send_ok", live_lanes: 2, read_lanes: ["research"] });
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

test("a half-open owner on another lane is probed before demotion and replaced with a reconnectable close: the newcomer takes over", async () => {
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
  // owner is probed like a pre-fleet holder, found dead, and replaced.
  const lane = new Client(alice, "be", { hello: { lane: "b" } });
  const hello = await lane.connect();
  expect(hello.type).toBe("hello_ok");
  expect(hello.push_granted).toBeUndefined(); // not demoted: it took over
  await b.request({ type: "send", recipient: "alice@example.com/be", body: "anyone?" });
  expect((await lane.next((m) => m.type === "push")).message.body).toBe("anyone?");
  // The old owner's socket death is handled, with the reconnectable code: a
  // paused session resumed later re-attaches (as a tool lane under the new
  // owner) instead of exiting for good (N1).
  expect(await owner.next((m) => m.type === "error")).toMatchObject({ code: "lost_ownership" });
});

test("a reconnecting ex-owner attaches as a tool lane under the new owner (no starvation)", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  // The half-open-owner scenario up to the takeover: lane b now owns push.
  const owner = new Client(alice, "be", { hello: { lane: "research" }, pong: false });
  await owner.connect();
  const taker = new Client(alice, "be", { hello: { lane: "b" } });
  expect((await taker.connect()).type).toBe("hello_ok");

  // The REAL reconnecting ex-owner: the client the takeover closed
  // reconnects ITSELF (a fresh client that never held the slot pins nothing
  // — the close code and the reconnect path are the point). lost_ownership
  // is reconnectable, so it re-hellos instead of exiting for good: the lane
  // key is free, the delivery slot is held by a live owner on another lane —
  // it attaches as a TOOL lane (push_granted false), and is not closed
  // again: the reconnect path can't starve.
  const closed = await owner.next((m) => m.type === "error");
  expect(closed).toMatchObject({ code: "lost_ownership" });
  const hello = await owner.connect(); // the same client, new socket
  expect(hello).toMatchObject({ type: "hello_ok", push_granted: false, owner_lane: "b" });
  await owner.none((m) => m.type === "error", 500);
  expect((await owner.call("claim_list")).type).toBe("call_ok");

  // Pushes still route to the owner, not the reattached ex-owner.
  const fe = new Client(bob, "fe");
  await fe.connect();
  await fe.request({ type: "send", recipient: "alice@example.com/be", body: "still mine?" });
  expect((await taker.next((m) => m.type === "push")).message.body).toBe("still mine?");
  await owner.none((m) => m.type === "push", 300);
});

test("the heartbeat closes a socket that stops answering pings", async () => {
  const alice = await login("alice@example.com");
  const local = startServer(config(mkdtempSync(join(tmpdir(), "gb-fleet-"))), { probeMs: 150, pingIntervalMs: 20, pingMissLimit: 2 });
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
    // The close is explained server-side, not silent — with the
    // reconnectable code (N1): a paused client resumed later re-attaches
    // instead of exiting for good.
    expect(got.filter((m) => m.type === "error" && m.code === "lost_ownership").length).toBe(1);
    expect(got.at(-1)!.type).not.toBe("hello_ok");
  } finally {
    local.stop();
  }
  void alice;
});

const CLI = resolve(import.meta.dir, "../../src/cli/main.ts");

test("a session paused past the ping-miss window resumes by reconnecting, not exiting (N1)", async () => {
  const local = startServer(
    config(mkdtempSync(join(tmpdir(), "gb-fleet-"))),
    { background: false, pingIntervalMs: 300, pingMissLimit: 2 },
  );
  const base2 = `http://localhost:${local.server.port}`;
  try {
    const token = ((await (await fetch(`${base2}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) })).json()) as { session_token: string }).session_token;
    const p = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
      env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base2, BUS_IDENTITY: "be" } as Record<string, string>,
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
    });
    const fleetLive = async () => {
      const rows = await (await fetch(`${base2}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json() as { live: boolean }[];
      return Array.isArray(rows) && rows.some((l) => l.live);
    };
    for (let i = 0; i < 50 && !(await fleetLive()); i++) await Bun.sleep(100);
    expect(await fleetLive()).toBe(true); // connected

    process.kill(p.pid!, "SIGSTOP"); // the machine went to sleep
    await Bun.sleep(2_000);           // past the miss window: closed meanwhile
    process.kill(p.pid!, "SIGCONT");  // wake: must reconnect, not exit

    let reconnected = false;
    for (let i = 0; i < 60 && !reconnected; i++) {
      await Bun.sleep(100);
      reconnected = await fleetLive();
    }
    expect(reconnected).toBe(true);
    expect(p.exitCode).toBe(null); // never exited
    p.kill();
    await p.exited;
  } finally {
    local.stop();
  }
}, 20_000);

test("a true identity_in_use refusal starts the client unbound, naming the holder (#215, not the old exit)", async () => {
  const token = await login("alice@example.com");
  const dir2 = mkdtempSync(join(tmpdir(), "gb-fleet-iis-"));
  const childEnv = () => serverEnv(dir2, base, token, "be") as Record<string, string>;
  const holder = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
    env: childEnv(),
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const fleetLive = async () => {
    const rows = await (await fetch(`${base}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json() as { live: boolean }[];
    return Array.isArray(rows) && rows.some((l) => l.live);
  };
  for (let i = 0; i < 50 && !(await fleetLive()); i++) await Bun.sleep(100);
  expect(await fleetLive()).toBe(true);

  // A second session, same identity and lane: the holder answers the
  // probe, so this is a genuine refusal — and #215's contract is an
  // UNBOUND START that names the holder, never an exit: the session stays
  // alive (its agent reads the holder's name and moves on), and the held
  // lane keeps exactly one live connection.
  const second = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
    env: childEnv(),
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  // The child stays alive, so its stderr never ends: one background collector
  // drains it into sBuf (never race read() — an abandoned read swallows its
  // chunk), and the poll checks what accumulated. Alive, unbound — never a
  // silent exit. The child read the holder's name record (same harness pid):
  // it restore-retries first (#182: a restart takes its name back), and goes
  // unbound naming the holder when the deadline passes.
  const sReader = second.stderr.getReader();
  const sDec = new TextDecoder();
  let sBuf = "";
  const collected = (async () => {
    for (;;) {
      const { done, value } = await sReader.read();
      if (done) return;
      sBuf += sDec.decode(value);
    }
  })();
  const end = Date.now() + 20_000;
  while (!sBuf.includes("unbound") && Date.now() < end) await Bun.sleep(250);
  expect(sBuf).toContain("unbound");
  holder.kill();
  await holder.exited;
  second.kill();
  await second.exited;
  await collected; // the pipe closes with the child: the collector ends
}, 20_000);

// The close-code taxonomy, pinned from the client's side: only LOST
// OWNERSHIP reconnects. A newer session taking over the SAME lane key is
// terminal — otherwise two clients on one lane reconnect-supersede each
// other forever. The displaced client exits ONCE and never re-enters.
test("a same-lane takeover is terminal: the displaced client exits once, no reconnect flap", async () => {
  const local = startServer(
    config(mkdtempSync(join(tmpdir(), "gb-fleet-"))),
    { background: false, probeMs: 300 },
  );
  const base2 = `http://localhost:${local.server.port}`;
  try {
    const token = ((await (await fetch(`${base2}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) })).json()) as { session_token: string }).session_token;
    const spawnBe = () => Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
      // BUS_LANE pins the lane: from a linked worktree (this test suite's
      // own cwd during a worktree run), an explicit BUS_IDENTITY would
      // otherwise take the worktree's name as its lane and the lane
      // assertions below would fail — and the pre-push hook with them.
      env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base2, BUS_IDENTITY: "be", BUS_LANE: "main" } as Record<string, string>,
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
    });
    const fleet = async () => {
      const rows = await (await fetch(`${base2}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json();
      // Before the first hello creates the identity, the route answers
      // not_found — poll as zero lanes until then.
      return Array.isArray(rows) ? (rows as { live: boolean }[]) : [];
    };
    const liveCount = async () => (await fleet()).filter((l) => l.live).length;

    // The older session hangs (SIGSTOP); the newer probes it, gets no
    // answer, and takes the lane — the classic same-lane takeover.
    const first = spawnBe();
    const lines: string[] = [];
    void (async () => { const r = first.stderr.getReader(); const d = new TextDecoder(); let buf = ""; for (;;) { const { done, value } = await r.read(); if (done) break; buf += d.decode(value); const nl = buf.split("\n"); lines.push(...nl.slice(0, -1)); buf = nl.at(-1)!; } })();
    for (let i = 0; i < 50 && (await liveCount()) !== 1; i++) await Bun.sleep(100);
    expect(await liveCount()).toBe(1);
    process.kill(first.pid!, "SIGSTOP");

    // The newer session probes the stopped holder, gets no answer, and
    // supersedes it. Wait for the TAKEOVER, not just "one live lane": the
    // stopped owner's row already counts as live, and a SIGCONT that lands
    // while the probe is still in flight lets the owner answer it and win
    // its lane back — the taker is (correctly) refused instead. The row's
    // first_seen changes only when the supersede ends the old row and the
    // taker's join writes a fresh one.
    const seenBefore = (await fleet()).find((r) => r.lane === "main")?.first_seen;
    const second = spawnBe();
    let taken = false;
    for (let i = 0; i < 50 && !taken; i++) {
      const main = (await fleet()).find((r) => r.lane === "main");
      taken = !!main && main.live && main.first_seen !== seenBefore;
      if (!taken) await Bun.sleep(100);
    }
    expect(taken).toBe(true); // the newer session holds the lane

    // The displaced client wakes to the superseded code. #215's contract:
    // the session never exits — it goes unbound and says why once (the agent
    // decides whether to re-bind; assertLaneFree refuses the taken lane, so
    // there's no flap). A mutant that reconnects would either re-take the
    // lane (liveCount > 1 is impossible — the taker holds it — but a flap
    // would show repeated taken-over lines) or sit refused; the line-count
    // and liveCount pins below catch both.
    process.kill(first.pid!, "SIGCONT");
    await Bun.sleep(2_500);
    const err1 = lines.join("\n");
    expect(err1.match(/^\[grayboard\] "be" was taken over: a newer session connected/gm) ?? []).toHaveLength(1); // die's line only — lost()"s line embeds the reason too
    expect(err1).not.toContain("lost; reconnecting");

    // No flap: past the reconnect backoff (1s), the lane still holds
    // exactly one live connection — the newer session's. The displaced
    // session is alive, unbound, and still serves tools (its agent decides
    // what to bind next).
    await Bun.sleep(2_500);
    expect(await liveCount()).toBe(1);
    const firstAlive = await Promise.race([first.exited.then(() => false), Bun.sleep(500).then(() => true)]);
    expect(firstAlive).toBe(true); // unbound, serving tools — the session decides what comes next
    first.kill();
    await first.exited;
    second.kill();
    await second.exited;
  } finally {
    local.stop();
  }
}, 20_000);
