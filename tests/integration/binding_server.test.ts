// Name binding in server mode (#182, as #284 PR 3 reshaped it): a session
// holds names by bind and unbind, a rebind leaves claims behind, and what the
// server records. A session with no name only reads (#229, #282). Each
// numbered title is the #182 acceptance criterion the test shows.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { closeSessions } from "../support/mcp.ts";
import { idAddress } from "../../src/core/bindings.ts";
import { endSession } from "../../src/core/session_end.ts";
import { refusal } from "../support/app_session.ts";
import type { AppSession, AppSessionOptions } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let srv: TestServer;
let alice: string;
let bob: string;
const A = "alice@example.com";
// Restarts share a database at a path of its own; the last server opened
// stands, and afterEach removes the temp dirs it made.
const tempDirs: string[] = [];

beforeEach(async () => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  bob = await srv.login("bob@example.com");
});

afterEach(async () => {
  await closeSessions();
  await srv.stop();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  return srv.app.db.query(sql).all(...args) as T[];
}

const events = (name: string) => rows<{ session_id: string; event: string; detail: string | null }>(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id`, `${A}/${name}`);
// The status of the session holding `address` (#284: status is the session's).
const status = (address: string) => rows<{ status: string | null }>(`SELECT i.status FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ?`, address)[0]!.status;
// The address a DM from `s` with no `as` goes out under: what it writes as.
async function sentAs(s: AppSession, body: string): Promise<string> {
  await s.send(`${A}/be`, body);
  return rows<{ sender: string }>(`SELECT sender FROM messages WHERE body = ?`, body)[0]!.sender;
}

// AppSession drivers (no socket, no frames; #282 PR 1).
const app = (identity: string | null, o: AppSessionOptions & { token?: string } = {}): AppSession => {
  const { token, ...opts } = o;
  return srv.appSession(token ?? alice, identity, opts);
};
const connect = (identity: string | null, { token, ...opts }: AppSessionOptions & { token?: string } = {}): Promise<AppSession> => srv.connected(token ?? alice, identity, opts);
// The session ends as a hosted ID's expiry ends it (core endSession): holds and
// claims released, unread mail bounced. A close alone no longer ends one
// (#282: no grace, no clean-exit frame), so tests that need an ended session end it.
function endIt(s: AppSession): void {
  s.close();
  srv.app.repo.atomic(() => endSession(srv.app.db, srv.app.repo.mail, s.id, { why: "exit", now: Date.now() }));
}
// The server restarts on the same database, a new in-process TestServer.
async function restarted(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), "gb-bind-"));
  tempDirs.push(dbDir);
  await srv.stop();
  srv = new TestServer({ dbPath: join(dbDir, "gb.db") });
  alice = await srv.login(A);
}

test("1, 3, 14: an unbound session only reads, is listed for its user only, and binding a name delivers that name's mail", async () => {
  // "api" existed once and has 3 DMs queued, with no live holder.
  const dead = await srv.hosted(A, "api");
  await dead.close();
  const be = await srv.hosted(A, "be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  // An unbound hosted session reads, and receives nothing until it binds: it
  // holds no lease.
  const s = await srv.hosted(A, null);
  expect((await s.call<{ posts: { body: string }[] }>("board_read", { board: "e2e" })).posts.map((p) => p.body)).toEqual(["hello"]);

  // An unbound application session is hosted's read-only kind: it no longer
  // acts as its ID (#284 S13 is gone on purpose, #229), so its writes are refused.
  const u = await connect(null);
  await expect(u.call("board_post", { board: "e2e", body: "from the id" })).rejects.toMatchObject({ code: "unbound" });
  await expect(u.send("be", "hi from the id")).rejects.toMatchObject({ code: "unbound" });
  expect(rows(`SELECT 1 FROM posts WHERE body = 'from the id'`)).toEqual([]);
  // 14: the user's other sessions see the unbound hosted root by session ID, from the
  // durable store (#475); another user's don't. (u is an application session, no hosted
  // root, so nothing lists it.)
  const sId = (await s.call<{ unbound_sessions: { session_id: string; self?: true }[] }>("peer_list", {})).unbound_sessions.find((x) => x.self)!.session_id;
  const seen = (await be.call<{ unbound_sessions?: { session_id: string; self?: true }[] }>("peer_list", {})).unbound_sessions;
  expect(seen).toEqual([expect.objectContaining({ session_id: sId, unbound: true, online: true })]);
  expect(seen![0]!.self).toBeUndefined();
  expect((await (await srv.hosted("bob@example.com", "ops")).call<{ unbound_sessions?: unknown }>("peer_list", {})).unbound_sessions).toBeUndefined();

  // 3: a new name gets none of api's mail. The probe DM to api2 arrives
  // first: had the bind delivered api's backlog, it would have preceded it.
  await s.bind("api2");
  // Bound, it's gone from the list.
  expect((await be.call<{ unbound_sessions?: unknown }>("peer_list", {})).unbound_sessions).toBeUndefined();
  await be.call("dm_send", { to: "api2", body: "probe" });
  expect((await s.next(direct())).event.message.body).toBe("probe");
  // 1: binding the name delivers what waited, and a new DM wakes it.
  await s.bind("api");
  const got: string[] = [];
  for (let i = 0; i < 3; i++) got.push((await s.next(direct())).event.message.body);
  expect(got).toEqual(["one", "two", "three"]);
  await be.call("dm_send", { to: "api", body: "four" });
  await s.next(direct((m) => m.body === "four"));
}, 30_000);

test("#475 3: peer_list reads the user's unbound hosted roots from the durable store, not only those with a request in flight", async () => {
  const be = await srv.hosted(A, "be");
  const unbound = async () => ((await be.call<{ unbound_sessions?: { session_id: string }[] }>("peer_list", {})).unbound_sessions ?? []).map((u) => u.session_id);
  // An unbound root that made its call and has nothing in flight: its client closed, its row lives on.
  const quiet = await srv.hosted(A, null);
  const id = ((await quiet.call<{ unbound_sessions: { session_id: string; self?: true }[] }>("peer_list", {})).unbound_sessions).find((u) => u.self)!.session_id;
  await quiet.close();
  expect(srv.app.repo.hosted.get(id)).toMatchObject({ root_session_id: null });
  expect(await unbound()).toEqual([id]);
  // A tools-only root writes as its writes_as: it isn't an unbound session. (The bound root, be, isn't either.)
  const row = srv.app.repo.hosted.get(id)!;
  const tools = "id:toolsonly0001";
  srv.app.repo.hosted.insert({ ...row, session_id: tools, source_session_id: tools, ownership_id: srv.app.repo.hosted.start(tools, row.user_id, row.client_id, Date.now()), writes_as: `${A}/ci` });
  expect(await unbound()).toEqual([id]);
  // Another user's unbound root is never listed.
  const bob = await srv.hosted("bob@example.com", null);
  await bob.call("board_list", {});
  await bob.close();
  expect(await unbound()).toEqual([id]);
  // Ended, its row is gone and so is its entry.
  expect(srv.app.repo.hosted.end(id, "closed", Date.now())).toBe(true);
  expect(await unbound()).toEqual([]);
}, 20_000);

test("2, 13: a second session on a held explicit name starts unbound and names the holder; the holder keeps its mail", async () => {
  const first = await srv.hosted(A, "fe");
  const firstId = events("fe")[0]!.session_id;
  // The second session's bind is refused with the holder named.
  const second = await srv.hosted(A, null);
  await expect(second.bind("fe")).rejects.toMatchObject({ code: "alias_held", message: expect.stringContaining(firstId) });
  expect((await second.call<{ peers: { handle: string; online: boolean }[] }>("peer_list", {})).peers).toEqual(
    expect.arrayContaining([expect.objectContaining({ handle: `${A}/fe`, online: true })]),
  );
  const be = await srv.hosted(A, "be");
  await be.call("dm_send", { to: "fe", body: "to the holder" });
  await first.next(direct((m) => m.body === "to the holder"));
  // An unbound hosted session holds no lease, so it can receive nothing.
  const ev = events("fe");
  expect(ev.map((e) => e.event)).toEqual(["bound", "refused"]);
  expect(ev[1]!.detail).toStartWith(`the hosted session ${firstId}`);
  expect(ev[1]!.session_id).not.toBe(firstId);
}, 20_000);

test("4, 13: a never-seen name needs create; the refusal lists the closest names", async () => {
  const dead = await srv.hosted(A, "fe");
  await dead.close();
  const s = await srv.hosted(A, null);
  await expect(s.bind("fee", { create: false })).rejects.toMatchObject({ message: expect.stringContaining(`no name "fee" has ever been used; closest: fe.`) });
  // The refusal created nothing; create: true does.
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'fee'`)).toEqual([]);
  await s.bind("fee");
  expect((await s.call<{ held: string[] }>("whoami", {})).held).toEqual([`${A}/fee`]);
  // The refusal is logged against the session that later bound the name.
  const [refused, bound] = events("fee");
  expect(refused).toEqual({ session_id: bound!.session_id, event: "refused", detail: expect.stringContaining("closest: fe") });
  expect(bound!.event).toBe("bound");
}, 20_000);

// hosted twin: #451 (unbind, multi-alias holds)
test("#284 S1, S2, S6: bind adds a hold; unbind releases one, its claims and mail staying with it", async () => {
  const s = await connect("fe");
  const be = await connect("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  // fe2 exists (it was used once), with a DM queued before the bind.
  endIt(await connect("fe2"));
  await be.send("fe2", "queued for fe2");

  const result = await s.bind("fe2");
  expect(result).toMatchObject({ alias: `${A}/fe2`, held: [`${A}/fe`, `${A}/fe2`] });
  // Both names' mail reaches it: fe2's queued DM and a new one to fe. A direct
  // event's recipient names the alias it reached.
  await s.next(direct((m) => m.body === "queued for fe2" && m.recipient === `${A}/fe2`));
  await be.send("fe", "to fe");
  await s.next(direct((m) => m.body === "to fe" && m.recipient === `${A}/fe`));
  const sid = events("fe")[0]!.session_id;
  expect(rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at`, sid)).toEqual([{ address: `${A}/fe` }, { address: `${A}/fe2` }]);
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "bound"]);
  expect(rows(`SELECT COUNT(*) AS n FROM binding_events WHERE event = 'moved'`)).toEqual([{ n: 0 }]);
  expect((await be.call<{ peers: { handle: string }[] }>("peer_list", {})).peers).toEqual(
    expect.arrayContaining([expect.objectContaining({ handle: `${A}/fe` })]),
  );
  // The primary, the oldest hold, is what it writes as by default.
  expect(await sentAs(s, "as the primary")).toBe(`${A}/fe`);

  // Unbinding the primary promotes the next oldest hold.
  const u = await s.unbind("fe");
  expect(u).toMatchObject({ alias: `${A}/fe`, released: true, held: [`${A}/fe2`] });
  expect(await sentAs(s, "as the promoted hold")).toBe(`${A}/fe2`);
  // #284 S6: claims stay with the address they were taken under.
  expect(u.left).toEqual(["ticket:ENG-142"]);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: "unbind" });
  expect(rows(`SELECT address FROM alias_holds WHERE id = ?`, sid)).toEqual([{ address: `${A}/fe2` }]);
  expect((await s.call<{ holder: string }[]>("claim_list", {})).map((c) => c.holder)).toEqual([`${A}/fe`]);
  expect(rows(`SELECT 1 FROM claim_events WHERE key = 'ticket:ENG-142' AND event = 'moved'`)).toEqual([]);
  await expect(s.call("claim_release", { key: "ticket:ENG-142" })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining(`${A}/fe`) });
  expect(await be.send(`${A}/fe`, "after unbind")).toMatchObject({ delivered_now: false });
  // Idempotent: a name it doesn't hold is already released.
  expect(await s.unbind("fe")).toMatchObject({ released: false, held: [`${A}/fe2`] });
  expect(events("fe").filter((e) => e.event === "released")).toHaveLength(1);

  // fe's next holder gets its mail and its claim.
  const other = await connect(null);
  await other.bind("fe");
  await other.next(direct((m) => m.body === "after unbind"));
  await s.none(direct((m) => m.body === "after unbind"));
  expect(await other.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");

  // Unbinding the last hold leaves it holding nothing.
  expect(await s.unbind("fe2")).toMatchObject({ alias: `${A}/fe2`, released: true, held: [] });
  expect(s.session.holds).toEqual([]);
}, 40_000);

// hosted twin: #451 (multi-alias holds)
test("#284 S1: the primary is the oldest hold; a ninth hold is refused", async () => {
  const s = await connect(null);
  for (const n of ["zed", "alpha", "c", "d", "e", "f", "g", "h"]) await s.bind(n, { create: true });
  expect(s.session.holds[0]).toBe(`${A}/zed`);
  await connect("be");
  expect(await sentAs(s, "as the oldest")).toBe(`${A}/zed`);
  await expect(s.bind("i", { create: true })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("already holds 8 names") });
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/i`)).toEqual([]);
}, 40_000);

// hosted twin: #451 (writes_as/tools-only, unbind)
test("#284 S2, S6: unbind is refused for a tools-only process, whose whoami names what it writes as", async () => {
  const s = await connect("fe");
  const tools = await connect("fe", { push: false });
  await expect(tools.unbind("fe")).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("tools-only") });
  expect(tools.session.holds).toEqual([]);
  expect(tools.session.writerId).toBeDefined();
  expect(rows<{ writes_as: string }>(`SELECT writes_as FROM ids WHERE id = ?`, tools.id)).toEqual([{ writes_as: `${A}/fe` }]);
  expect(s.session.holds).toEqual([`${A}/fe`]);
}, 30_000);

// hosted twin: #451 (unbind, push-ack semantics)
test("#284 S2: a DM pushed for an alias and unacked at its unbind reaches its next holder; a board item pushed before is pushed again on a re-bind", async () => {
  const s = await connect("fe");
  expect(await s.bind("fe2", { create: true })).toMatchObject({ held: [`${A}/fe`, `${A}/fe2`] });
  const be = await connect("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "@fe2 look" });
  const post = await s.next(board((i) => i.kind === "push" && i.post?.body === "@fe2 look"));
  await be.send("fe2", "unacked");
  const dm = await s.next(direct((m) => m.body === "unacked"));
  // Neither is acked; the unbind leaves both for fe2.
  expect(await s.unbind("fe2")).toMatchObject({ alias: `${A}/fe2`, released: true, held: [`${A}/fe`] });
  expect(await s.unbind("fe2")).toMatchObject({ released: false });
  // Re-bound on the same session, the board item goes out again.
  expect(await s.bind("fe2")).toMatchObject({ alias: `${A}/fe2` });
  const posted = post.item.kind === "push" ? post.item.post.id : undefined;
  await s.next(board((i) => i.kind === "push" && i.post.id === posted));
  await s.next(direct((m) => m.id === dm.message.id));
  expect(await s.unbind("fe2")).toMatchObject({ released: true });
  // Another session's bind of fe2 gets the DM still unacked.
  const t = await connect(null);
  await t.bind("fe2");
  await t.next(direct((m) => m.body === "unacked"));
}, 30_000);

// hosted twin: #451 (hold-only session, unbind).
// a hold-only connection (no push) is what a channels-off process is.
test("audit 2 (server): a hold-only session holds its names: never online, and an unbind leaves its claims", async () => {
  const s = await connect("fe", { push: false, hold: true });
  const be = await connect("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  for (const opts of [{ push: false, hold: true } as AppSessionOptions, {}]) {
    const t = await connect(null, opts);
    expect((await refusal(t.bind("fe"))).code).toBe("alias_held");
  }
  // It holds the name without taking pushes: not online, and DMs wait.
  const fe = async () => (await be.call<{ peers: { handle: string; online: boolean }[] }>("peer_list", { include_offline: true })).peers.find((p) => p.handle === `${A}/fe`);
  expect((await fe())!.online).toBe(false);
  expect(await be.send(`${A}/fe`, "held off")).toMatchObject({ delivered_now: false });
  await s.none(direct());

  await s.bind("fe2", { create: true });
  const u = await s.unbind("fe");
  expect(u.left).toEqual(["ticket:ENG-142"]);
  expect((await be.call<{ holder: string }[]>("claim_list", {})).map((c) => c.holder)).toEqual([`${A}/fe`]);
  const sid = events("fe")[0]!.session_id;
  expect(events("fe").map((e) => e.event)).toEqual(["bound", "refused", "refused", "released"]);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: "unbind" });
  expect(events("fe2")).toEqual([{ session_id: sid, event: "bound", detail: null }]);
  // fe is free now.
  await (await connect(null)).bind("fe");
}, 40_000);

test("audit 5: a bind whose answer was lost is settled by calling it again: the same name is already bound", async () => {
  const s = await srv.hosted(A, null);
  expect(await s.bind("fe")).toMatchObject({ name: "fe" });
  // The driver surfaces the structured content; the raw result carries the text.
  expect((await s.callRaw("bind", { name: "fe", create: true })).content).toEqual([{ type: "text", text: `already bound to "fe"` }]);
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
}, 20_000);

//
// bind is atomic — its hold is in place
// before its answer, and a call right after runs as the bound name.
test("audit 11 (server): a call after a bind runs as the name it bound", async () => {
  const s = await connect(null);
  await s.bind("fe", { create: true });
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  expect(rows(`SELECT holder FROM claims`)).toEqual([{ holder: `${A}/fe` }]);
}, 20_000);

// hosted twin: #451 (holder probe)
// An application session is never a hosted holder, so no bind probes it: this
// is the live holder's refusal, not a silent probe's.
test("audit 15: a live holder keeps its name: another session's bind is refused, never a takeover", async () => {
  const s = await connect("fe");
  const holder = events("fe")[0]!.session_id;
  const t = await connect(null);
  const e = await refusal(t.bind("fe"));
  expect(e.code).toBe("alias_held");
  expect(e.message).toContain(`"${A}/fe" is in use by the session ${holder}`);
  expect(s.session.holds).toEqual([`${A}/fe`]);
}, 30_000);

// The WSS transport is gone (#282): no connection can re-attach to a session a
// restart left unended, so the server ends each non-hosted one at start
// (why: wss_removed) and its names are free at once, with no grace to wait out.
test("a restart ends the application sessions it finds, and their names are free to bind", async () => {
  await restarted();
  const s = await connect("fe");
  const holder = events("fe")[0]!.session_id;
  await srv.stop();
  srv = new TestServer({ dbPath: join(tempDirs.at(-1)!, "gb.db") });
  alice = await srv.login(A);
  expect(rows(`SELECT ended_at IS NOT NULL AS ended FROM ids WHERE id = ?`, holder)).toEqual([{ ended: 1 }]);
  expect(rows(`SELECT detail FROM access_log WHERE action = 'id.ended' AND target = ?`, holder).map((r: any) => JSON.parse(r.detail).why)).toEqual(["wss_removed"]);
  expect(events("fe").at(-1)).toEqual({ session_id: holder, event: "released", detail: "session_end: wss_removed" });
  const t = await connect(null);
  expect(await t.bind("fe")).toMatchObject({ alias: `${A}/fe` });
  expect(s.id).toBe(holder);
}, 30_000);

// hosted twin: #451 (writes_as/tools-only rekey).
// the new session's hello writes as its name, with no bind and no
// binding events.
test("a tools-only session that ended comes back on a new ID still writing as its name (server)", async () => {
  const s = await connect("be", { push: false });
  await s.send(`${A}/be`, "before");
  const old = rows<{ id: string }>(`SELECT id FROM ids WHERE writes_as = ?`, `${A}/be`)[0]!.id;
  endIt(s);
  const back = await connect("be", { push: false });
  const now = back.id;
  expect(now).not.toBe(old);
  await back.send(`${A}/be`, "after");
  expect(rows(`SELECT sender, sender_id FROM messages WHERE body = 'after'`)).toEqual([{ sender: `${A}/be`, sender_id: now }]);
  expect(rows(`SELECT COUNT(*) AS n FROM binding_events`)).toEqual([{ n: 0 }]);
  expect(back.session.holds).toEqual([]);
}, 30_000);

// The hello's needs-a-session_key refusal is deleted with the hello (#282): a
// hosted session's ID is the raw session ID its request names.
test("16, 18: raw binds: create: false, lazy create; an unbound connection reads its user's boards and writes nothing", async () => {
  await srv.api(alice, "POST", "/api/teams", { name: "eng" });
  const be = await connect("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  // 16: create: false refuses an unknown name with the closest known ones.
  const refused = await refusal(app("bee", { bind: { create: false } }).connect());
  expect(refused).toMatchObject({ code: "identity_unknown", message: expect.stringContaining("closest") });
  expect(refused.extra.known).toEqual(["be"]);
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'bee'`)).toEqual([]);
  // A bind without create creates the name.
  expect((await connect("lazy")).session.holds).toEqual([`${A}/lazy`]);
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'lazy'`)).toHaveLength(1);

  // 18: an unbound connection: open boards and its user's team boards.
  const ro = await connect(null);
  expect(ro.session.holds).toEqual([]);
  const boards = (await ro.call<{ name: string }[]>("board_list", {})).map((b) => b.name);
  expect(boards).toContain("e2e");
  expect(boards).toContain("eng");
  expect((await (await connect(null, { token: bob })).call<{ name: string }[]>("board_list", {})).map((b) => b.name)).not.toContain("eng");
  // It no longer writes as its ID (S13 is gone, #229): writes are refused.
  await expect(ro.call("board_post", { board: "e2e", body: "x" })).rejects.toMatchObject({ code: "unbound" });
  await expect(ro.call("claim_take", { key: "k" })).rejects.toMatchObject({ code: "unbound" });
  expect(rows(`SELECT 1 FROM posts WHERE body = 'x'`)).toEqual([]);
  expect(rows(`SELECT 1 FROM claims WHERE key = 'k'`)).toEqual([]);
}, 20_000);

// hosted twin: #451 (bind limiter on the restore path).
// the user's bind limit refuses a bind back to an ended session's name with
// a wait, and the retry after it succeeds.
test("11 (server): a rebind refused by the bind limit binds after the wait", async () => {
  let clock = Date.now();
  await srv.stop();
  srv = new TestServer({ helloLimit: { burst: 3, perSec: 1 } }, { now: () => clock });
  alice = await srv.login(A);
  const first = await connect("api");
  endIt(first);
  // Only a bind spends a token now (the hello is gone, #282): api's, then two
  // more empty the bucket (3), so the rebind is refused.
  const restored = await connect(null);
  await connect("x1");
  await connect("x2");
  const limited = await refusal(restored.bind("api"));
  expect(limited.code).toBe("rate_limited");
  expect(limited.extra.retry_after_ms).toBeGreaterThan(0);
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([]);
  clock += limited.extra.retry_after_ms! + 1000;
  expect(await restored.bind("api")).toMatchObject({ alias: `${A}/api` });
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: restored.id }]);
  expect(events("api").at(-1)).toEqual({ session_id: restored.id, event: "bound", detail: null });
}, 30_000);

// #367: an upload stays with the user who made it, so a team alias that
// passes to another member doesn't carry its last holder's unsent files: the
// next holder can't send, download or delete them.
// hosted twin: #451 (end)
test("#284 #367: a team alias's unsent upload doesn't pass to the next member who holds it", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const mine = await connect("eng/api");
  const up = await srv.upload(alice, "eng/api", "plan.md", "# plan");
  expect(up.status).toBe(201);
  endIt(mine);

  const theirs = await connect("eng/api", { token: bob });
  const refused = `attachment ${up.body.id} isn't an unsent upload of yours`;
  await expect(theirs.send(`${A}/be`, "x", { attachment_ids: [up.body.id] })).rejects.toMatchObject({ code: "bad_request", message: refused });
  await expect(theirs.call("board_post", { board: "eng", body: "x", attachment_ids: [up.body.id] })).rejects.toMatchObject({ message: expect.stringContaining(refused) });
  // Nor over HTTP, as the alias: the download and the release both refuse.
  expect(await srv.api(bob, "GET", `/api/attachments/${up.body.id}?as=eng%2Fapi`)).toMatchObject({ status: 404 });
  expect(await srv.api(bob, "DELETE", `/api/attachments/${up.body.id}?as=eng%2Fapi`)).toMatchObject({ status: 404 });
  expect(rows(`SELECT message_id, post_id FROM attachments WHERE id = ?`, up.body.id)).toEqual([{ message_id: null, post_id: null }]);

  // #391: the uploader takes the alias back and still sends her own upload.
  endIt(theirs);
  await connect("be");
  const again = await connect("eng/api");
  const sent = await again.send(`${A}/be`, "the plan", { attachment_ids: [up.body.id] });
  expect(rows(`SELECT message_id FROM attachments WHERE id = ?`, up.body.id)).toEqual([{ message_id: sent.message_id }]);
});

// #391: #367's case as written: an explicit unbind, not an end, passes the
// alias on, and the next member still can't send the upload.
test("#367: after an unbind, the next member who binds a team alias can't send its unsent upload", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const mine = await connect("eng/api");
  const up = await srv.upload(alice, "eng/api", "plan.md", "# plan");
  expect(up.status).toBe(201);
  expect(await mine.unbind("eng/api")).toMatchObject({ alias: "eng/api", released: true });

  const theirs = await connect("eng/api", { token: bob });
  expect(theirs.session.holds).toEqual(["eng/api"]);
  await expect(theirs.send(`${A}/be`, "x", { attachment_ids: [up.body.id] }))
    .rejects.toMatchObject({ code: "bad_request", message: `attachment ${up.body.id} isn't an unsent upload of yours` });
  expect(rows(`SELECT message_id, post_id FROM attachments WHERE id = ?`, up.body.id)).toEqual([{ message_id: null, post_id: null }]);
});

// #284: a session's ID is one principal's. Another user presenting the same
// key is refused, never attached to the session's row; the owner's own
// further binds are the same session.
// hosted twin: #451 (keyed hello)
test("#284: a key whose ID is another principal's session is refused with id_collision, and audited", async () => {
  const key = "c4".repeat(32);
  const mine = await connect("api", { key });
  expect(rows(`SELECT id, principal FROM ids`)).toEqual([{ id: idAddress(key), principal: A }]);
  expect(rows(`SELECT address, id FROM alias_holds`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }]);
  expect(await refusal(app("api", { key, token: bob }).connect())).toMatchObject({ code: "id_collision", message: expect.stringContaining(idAddress(key)) });
  expect(rows(`SELECT address FROM alias_holds`)).toEqual([{ address: `${A}/api` }]);
  expect(rows(`SELECT action, target FROM access_log WHERE action IN ('id.registered', 'id.collision') ORDER BY id`)).toEqual([
    { action: "id.registered", target: idAddress(key) }, { action: "id.collision", target: idAddress(key) },
  ]);
  // The owner's next bind is the same session: one ids row, a second hold.
  expect(await mine.bind("web")).toMatchObject({ alias: `${A}/web` });
  expect(rows(`SELECT id FROM ids`)).toEqual([{ id: idAddress(key) }]);
  expect(rows(`SELECT address, id FROM alias_holds ORDER BY address`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }, { address: `${A}/web`, id: idAddress(key) }]);
  endIt(mine);
  expect(rows(`SELECT 1 FROM alias_holds`)).toEqual([]);
});

// #284 decision 5: teams and service principals share one namespace.
test("#284: creating a team refuses a name another principal holds", async () => {
  srv.app.db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  const r = await srv.api(alice, "POST", "/api/teams", { name: "ingest" });
  expect(r.status).toBe(409);
  expect(r.body.message).toContain(`"ingest" belongs to another team or service principal`);
});

test("13 (server): a hosted bind's result carries its name and instructions", async () => {
  const s = await srv.hosted(A, null, { delivery: false });
  const bound = await s.call<{ name: string; instructions: string[] }>("bind", { name: "api", create: true });
  expect(bound.name).toBe("api");
  expect(bound.instructions[0]).toStartWith(`You are identity "api"`);
}, 20_000);

test("audit 19: a bind or writes_as refused for an invalid or reserved name is refused, and a reserved one logged", async () => {
  const long = `x${"y".repeat(40)}!`;
  expect(await refusal(app(long).connect())).toMatchObject({ code: "bad_request" });
  expect(await refusal(app("human").connect())).toMatchObject({ code: "forbidden" });
  // A tools-only connection can't write as it either.
  expect(await refusal(app("human", { push: false }).connect())).toMatchObject({ code: "forbidden" });
  // Each refusal is logged under its session's ID: the bind's and the writes_as's.
  const refused = { session_id: expect.stringMatching(/^id:[0-9a-z]{13}$/), event: "refused", detail: expect.stringContaining("human") };
  expect(events("human")).toEqual([refused, refused]);
});

// #284 S7: every agent connection is a session, so a write carries the
// writing session's ID: a tools-only connection's is its own, not the owner's.
// hosted twin: #451 (writes_as/tools-only)
test("#284: messages and posts carry the writing session's ID, a tools-only connection's included", async () => {
  const owner = await connect("be");
  await owner.call("board_create", { name: "e2e", purpose: "test" });
  const tools = await connect("be", { push: false });
  for (const [s, tag] of [[owner, "owner"], [tools, "tools"]] as const) {
    await s.send(`${A}/be`, `dm ${tag}`);
    await s.call("board_post", { board: "e2e", body: `post ${tag}` });
  }
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/be`)[0]!.id;
  const toolsId = rows<{ id: string }>(`SELECT id FROM ids WHERE writes_as = ?`, `${A}/be`)[0]!.id;
  expect(id).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).not.toBe(id);
  expect(rows(`SELECT body, sender, sender_id FROM messages ORDER BY id`)).toEqual([{ body: "dm owner", sender: `${A}/be`, sender_id: id }, { body: "dm tools", sender: `${A}/be`, sender_id: toolsId }]);
  expect(rows(`SELECT body, author, author_id FROM posts ORDER BY id`)).toEqual([{ body: "post owner", author: `${A}/be`, author_id: id }, { body: "post tools", author: `${A}/be`, author_id: toolsId }]);
  // Mail it could never read is refused with its code.
  await expect(owner.send(toolsId, "hi")).rejects.toMatchObject({ code: "no_delivery", message: `${toolsId} is a tools-only session and receives nothing; send to ${A}/be` });
}, 20_000);

// #284 audit B12: the lazy alias.created row names the session that created
// it. (The hello's launcher flag and its handle.launcher_set row are gone
// with the hello, #282.)
// hosted twin: #451 (a hosted bind's lazy create)
test("#284: alias.created names the session", async () => {
  await connect("be");
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/be`)[0]!.id;
  expect(rows(`SELECT action, actor, target, detail FROM access_log WHERE action = 'alias.created' ORDER BY id`)).toEqual([
    { action: "alias.created", actor: A, target: `${A}/be`, detail: JSON.stringify({ lazy: true, session: id }) },
  ]);
}, 20_000);

const senderOf = (id: number) => rows<{ sender: string }>(`SELECT sender FROM messages WHERE id = ?`, id)[0]!.sender;

// hosted twin: #451 (multi-alias holds)
test("#284 S3: as on dm_send names one of the session's addresses; another's is refused with the list", async () => {
  await connect("peer");
  const s = await connect(null);
  const id = s.id;
  await s.bind("a", { create: true });
  await s.bind("b", { create: true });
  await connect("c");
  const plain = await s.send("peer", "1");
  expect([senderOf(plain.message_id), plain.sent_as]).toEqual([`${A}/a`, undefined]);
  const asB = await s.send("peer", "2", { as: "b" });
  expect([senderOf(asB.message_id), asB.sent_as]).toEqual([`${A}/b`, `${A}/b`]);
  const asId = await s.send("peer", "3", { as: id });
  expect(senderOf(asId.message_id)).toBe(id);
  for (const other of ["zzz", "c"]) {
    await expect(s.send("peer", "x", { as: other })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining(`isn't one of this session's addresses: ${A}/a, ${A}/b, ${id}`) });
  }
}, 30_000);

// hosted twin: #451 (multi-alias holds, unbind)
test("#284 S4: a reply goes as the held alias its parent reached or was sent as; else the primary", async () => {
  const peer = await connect("peer");
  const s = await connect(null);
  const id = s.id;
  // Mail to the ID before any bind is answered as the alias bound since.
  const toId = await peer.send(id, "to the id");
  await s.bind("a", { create: true });
  await s.bind("b", { create: true });
  expect(senderOf((await s.send("peer", "r0", { parent_id: toId.message_id })).message_id)).toBe(`${A}/a`);

  const toB = await peer.send("b", "to b");
  await s.next(direct((m) => m.body === "to b"));
  const r1 = await s.send("peer", "r1", { parent_id: toB.message_id });
  expect([senderOf(r1.message_id), r1.sent_as]).toEqual([`${A}/b`, `${A}/b`]);
  const r2 = await s.send("peer", "r2", { parent_id: toB.message_id, as: "a" });
  expect(senderOf(r2.message_id)).toBe(`${A}/a`);
  // Its own thread, as its sender.
  expect(senderOf((await s.send("peer", "r3", { parent_id: r1.message_id })).message_id)).toBe(`${A}/b`);

  // b unbound and taken by t: a reply to mail that reached b is refused, not sent as a.
  const toB2 = await peer.send("b", "to b again");
  await s.next(direct((m) => m.body === "to b again"));
  await s.unbind("b");
  const t = await connect(null);
  await t.bind("b");
  await expect(s.send("peer", "x", { parent_id: toB2.message_id })).rejects.toMatchObject({ code: "not_found", message: `parent_id ${toB2.message_id} is not a message you sent or received` });
}, 40_000);

// S14: a team alias sees only its team's boards, while a person alias sees
// every team its user is in. So with eng/x primary, a board of ops (which
// alice is in, eng isn't) acts as the person alias, and its subscription,
// cursor and unread count are that alias's.
// hosted twin: #451 (multi-alias acting-as)
test("#284 S14: a board call without as acts as the first address that can see the board", async () => {
  for (const name of ["eng", "ops"]) expect((await srv.api(alice, "POST", "/api/teams", { name })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/ops/add", { email: "bob@example.com" })).status).toBe(200);
  const s = await connect(null);
  await s.bind("eng/x", { create: true });
  await s.bind("a", { create: true });
  expect(s.session.holds).toEqual(["eng/x", `${A}/a`]);
  const sub = (handle: string) => rows<{ mode: string; cursor: number }>(`SELECT mode, cursor FROM subscriptions WHERE board = 'ops' AND handle = ?`, handle);

  await s.call("board_subscribe", { board: "ops", mode: "digest" });
  expect(sub(`${A}/a`)).toMatchObject([{ mode: "digest" }]);
  expect(sub("eng/x")).toEqual([]);
  const bo = await connect("bo", { token: bob });
  const posted = await bo.call<{ post_id: number }>("board_post", { board: "ops", body: "for ops" });
  const opsRow = async () => (await s.call<{ name: string; mode: string | null; unread: number }[]>("board_list", {})).find((b) => b.name === "ops");
  expect(await opsRow()).toMatchObject({ mode: "digest", unread: 1 });
  expect((await s.call<{ posts: { body: string }[] }>("board_read", { board: "ops" })).posts.map((p) => p.body)).toEqual(["for ops"]);
  expect(sub(`${A}/a`)).toMatchObject([{ cursor: posted.post_id }]);
  expect(await opsRow()).toMatchObject({ unread: 0 });
  const reply = await s.call<{ post_id: number }>("board_post", { board: "ops", body: "ops reply" });
  expect(rows(`SELECT author FROM posts WHERE id = ?`, reply.post_id)).toEqual([{ author: `${A}/a` }]);
  // eng's board the primary can see: it acts as eng/x.
  const own = await s.call<{ post_id: number }>("board_post", { board: "eng", body: "eng post" });
  expect(rows(`SELECT author FROM posts WHERE id = ?`, own.post_id)).toEqual([{ author: "eng/x" }]);
}, 30_000);

// #360: `grayboard claim` from a shell acts as an alias over HTTP with the
// session's address set, so it releases what the session took under its ID.
// Another principal's ?as= of a held team alias is refused outright (S8), so
// the set never reaches across principals.
test("#284 #360: grayboard claim release as an alias releases its session's ID-held claim; another member's as is refused", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const dir = mkdtempSync(join(srv.dir, "grayboard-claim-"));
  const gb = async (token: string, email: string, identity: string, ...args: string[]) => {
    const creds = join(dir, `creds-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: srv.base, user_email: email }));
    return runCli(args, { cwd: dir, env: cleanEnv({ HOME: dir, GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity }) });
  };
  const s = await connect(null, { token: bob });
  const id = s.id;
  await s.bind("eng/x", { create: true });
  expect(await s.call<{ claim: { holder: string } }>("claim_take", { key: "ticket:ENG-7", as: id })).toMatchObject({ claim: { holder: id } });

  const theirs = await gb(alice, A, "eng/x", "claim", "release", "ticket:ENG-7");
  expect(theirs.code).toBe(1);
  expect(theirs.err).toContain(`"eng/x" is in use by`);
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-7'`)).toEqual([{ holder: id }]);

  const mine = await gb(bob, "bob@example.com", "eng/x", "claim", "release", "ticket:ENG-7");
  expect(mine.code, mine.err).toBe(0);
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-7'`)).toEqual([]);
}, 30_000);

// hosted twin: #451 (record-based restore).
// restoring a name another live session holds is refused, naming the
// holder, while the rest restore.
test("#284 S10 (server): a restore takes back its names but one held by another", async () => {
  const s = await connect("be");
  await s.bind("api", { create: true });
  const sid = s.id;
  await s.unbind("api");
  const t = await connect(null);
  await t.bind("api");
  endIt(s);
  // The restore re-binds its names: "api" is refused, naming its holder; "be" binds.
  const r = await connect("be");
  expect(r.session.holds).toEqual([`${A}/be`]);
  const e = await refusal(r.bind("api"));
  expect(e.code).toBe("alias_held");
  expect(e.message).toContain(t.id);
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: t.id }]);
}, 30_000);

// #284 S16: the Slack bridge's human is its user's `human` and nothing else.
// Its in-process attachment binds and unbinds nothing, and keeps its hold.
test("the bridge's human connection binds and unbinds nothing", async () => {
  // #284 port: on master (#402) the bridge attaches its human through the
  // application's trusted method, not a WSS frame, so the refusals are the
  // application's.
  const user = srv.app.repo.users.findByEmail(A)!;
  const pushes: string[] = [];
  const sink = { deliver: (e: any) => { if (e.kind === "direct") pushes.push(e.message.body); }, closed() {} };
  const { session, ok } = await srv.app.application.attachHuman({ user_id: user.id, user_email: A, session_id: 0 }, sink);
  expect(ok).toMatchObject({ id: "human" });
  const human = `${A}/human`;
  const refused = async (f: () => unknown) => { try { await f(); } catch (e) { return { code: (e as any).code, message: (e as Error).message }; } return undefined; };
  expect(await refused(() => srv.app.application.unbind(session, human))).toEqual({ code: "bad_request", message: `the Slack bridge's connection is its user's "human"; it unbinds nothing` });
  expect(await refused(() => srv.app.application.bindNow(session, { alias: "fe", create: true }))).toEqual({ code: "bad_request", message: `the Slack bridge's connection is its user's "human"; it binds nothing` });
  // Still the human: a DM to it is pushed to this connection.
  const be = await connect("be");
  expect(await be.send("human", "still you")).toMatchObject({ delivered_now: true });
  await until(() => pushes.includes("still you"));
});

// #284 S5, decision 20: claims are the session's across its address set; a
// claim stays under the address that took it.
// hosted twin: #451 (multi-alias holds, unbind)
test("claims across a session's aliases: release under another primary, renew under the taker, a queue reply-ack by a non-primary lane", async () => {
  const s = await connect("b");
  expect(await s.bind("a", { create: true })).toMatchObject({ held: [`${A}/b`, `${A}/a`] });
  const claimRow = (key: string) => rows<{ holder: string }>(`SELECT holder FROM claims WHERE key = ?`, key);

  // Taken as a, released with no `as` while the primary is b.
  expect(await s.call("claim_take", { key: "ticket:ENG-1", as: "a" })).toMatchObject({ claim: { holder: `${A}/a` } });
  await s.call("claim_release", { key: "ticket:ENG-1" });
  expect(claimRow("ticket:ENG-1")).toEqual([]);

  // Taken as a, taken again as b: renewed, still a's.
  await s.call("claim_take", { key: "ticket:ENG-2", as: "a" });
  expect(await s.call("claim_take", { key: "ticket:ENG-2", as: "b" })).toMatchObject({ claim: { holder: `${A}/a` } });
  expect(claimRow("ticket:ENG-2")).toEqual([{ holder: `${A}/a` }]);

  // A queue lane subscribed as b, whose primary is now a, acks a post by replying.
  const lane = await connect("lane-b");
  await lane.call("board_create", { name: "lanes", purpose: "rotation", kind: "queue" });
  expect(await lane.bind("lane-a", { create: true })).toMatchObject({ held: [`${A}/lane-b`, `${A}/lane-a`] });
  expect(await lane.unbind("lane-b")).toMatchObject({ released: true });
  expect(await lane.bind("lane-b")).toMatchObject({ held: [`${A}/lane-a`, `${A}/lane-b`] });
  expect(rows(`SELECT handle FROM subscriptions WHERE board = 'lanes'`)).toEqual([{ handle: `${A}/lane-b` }]);
  const poster = await connect("fe", { token: bob });
  const posted = await poster.call<{ post_id: number }>("board_post", { board: "lanes", body: "work item" });
  const key = `queue:lanes:${posted.post_id}`;
  expect(claimRow(key)).toEqual([{ holder: `${A}/lane-b` }]);
  await lane.next(board((i) => i.kind === "push" && i.post?.body === "work item"));
  const reply = await lane.call<{ post_id: number }>("board_post", { board: "lanes", body: "done", parent_id: posted.post_id });
  expect(rows(`SELECT author FROM posts WHERE id = ?`, reply.post_id)).toEqual([{ author: `${A}/lane-a` }]);
  expect(claimRow(key)).toEqual([]);
}, 30_000);

// #284 PR 4: an upload is the session's across its address set. One made as
// a rides a send as b, and a reply that defaults to b.
test("an upload made as one alias attaches to a send as another, and to a reply defaulting to it", async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  const s = await connect("a");
  expect(await s.bind("b", { create: true })).toMatchObject({ alias: `${A}/b` });
  const peer = await connect("fe", { token: bob });
  const up = async () => {
    const r = await srv.upload(alice, "a", "shot.png", PNG);
    expect(r.status).toBe(201);
    return r.body.id as number;
  };
  const senderOf = (id: number) => rows<{ sender: string }>(`SELECT sender FROM messages WHERE id = ?`, id)[0]!.sender;

  const first = await up();
  const sent = await s.send("bob@example.com/fe", "as b", { as: "b", attachment_ids: [first] });
  expect(sent.attachments).toEqual([expect.objectContaining({ id: first })]);
  expect(senderOf(sent.message_id)).toBe(`${A}/b`);

  const ask = await peer.send(`${A}/b`, "to b");
  await s.next(direct((m) => m.body === "to b"));
  const second = await up();
  const reply = await s.send("bob@example.com/fe", "reply", { parent_id: ask.message_id, attachment_ids: [second] });
  expect(reply.attachments).toEqual([expect.objectContaining({ id: second })]);
  expect(senderOf(reply.message_id)).toBe(`${A}/b`);
});

// #259 with several aliases (spec AC 6): a stray holding b is refused a while
// its holder lives and keeps writing as b; once the holder ends, its bind
// gets a's mail and claims, but not the holder's status, and leaves the
// stray's primary b.
// hosted twin: #451 (multi-alias, end, restore flags)
test("#259: a stray refused a while its holder lives takes it after the end, keeping its primary", async () => {
  const p = await connect("a");
  await p.call("peer_status", { text: "p's task" });
  expect(await p.call("claim_take", { key: "ticket:ENG-7" })).toMatchObject({ claim: { holder: `${A}/a` } });
  const x = await connect("b");
  expect((await refusal(x.bind("a"))).code).toBe("alias_held");
  await x.send(`${A}/a`, "from b");
  await p.next(direct((m) => m.body === "from b" && m.sender === `${A}/b`));

  endIt(p);
  const peer = await connect("fe", { token: bob });
  expect(await peer.send(`${A}/a`, "for a")).toMatchObject({ delivered_now: false });

  expect(await x.bind("a")).toMatchObject({ held: [`${A}/b`, `${A}/a`] });
  await x.next(direct((m) => m.body === "for a"));
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-7'`)).toEqual([{ holder: `${A}/a` }]);
  expect(events("a").slice(-2)).toEqual([
    { session_id: p.id, event: "released", detail: "session_end: exit" },
    { session_id: x.id, event: "bound", detail: null },
  ]);
  expect(status(`${A}/a`)).toBeNull();
  const sent = await x.send("bob@example.com/fe", "who am i");
  expect(rows(`SELECT sender FROM messages WHERE id = ?`, sent.message_id)).toEqual([{ sender: `${A}/b` }]);
});

// #284 S11 on the server: the holds are the session's, oldest first. The
test("#284 S11: whoami over the server names the ID, the holds oldest first and the principal", async () => {
  const s = await srv.hosted(A, null, { delivery: false });
  expect(await s.call<{ held: string[]; primary: string | null; unbound?: boolean }>("whoami", {})).toMatchObject({ held: [], primary: null, unbound: true });
  await s.bind("zed");
  await s.bind("alpha");
  expect(await s.call<{ held: string[]; primary: string }>("whoami", {})).toMatchObject({ held: [`${A}/zed`, `${A}/alpha`], primary: `${A}/zed` });
}, 30_000);

// hosted twin: #451 (multi-alias restore).
// bound_at is monotonic per session, so the primary survives a frozen
// clock, and a restore re-binds in the same order.
test("#284 S1 (server): with the server's clock frozen, the first alias bound stays the primary through a restore", async () => {
  await srv.stop();
  const frozen = Date.now();
  srv = new TestServer({}, { now: () => frozen });
  alice = await srv.login(A);
  const s = await connect("zed");
  await s.bind("alpha", { create: true });
  await s.bind("mid", { create: true });
  const order = () => rows<{ address: string }>(`SELECT address FROM alias_holds ORDER BY bound_at`).map((r) => r.address);
  expect(order()).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
  expect(s.session.holds[0]).toBe(`${A}/zed`);
  // A restore (the old session ended, the record re-binds in order) keeps it.
  endIt(s);
  const r = await connect("zed");
  await r.bind("alpha");
  await r.bind("mid");
  expect(order()).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
  expect(r.session.holds).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
}, 40_000);

// #366: a held alias's own subscription is the one a read, a subscribe and a
// board_list row act on, even when the primary also sees the board; with two
// subscribed, reads drain the one with unread first, then the other.
// hosted twin: #451 (multi-alias holds, unbind)
test("#366: a board call without as acts as a subscribed address first, one with unread first for a read", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const prev = await connect("eng/x");
  await prev.call("board_subscribe", { board: "eng", mode: "digest" });
  endIt(prev);
  const s = await connect("a");
  // alice made the team, so a is subscribed to its board: unsubscribe it, as in the issue.
  await s.call("board_subscribe", { board: "eng", mode: "off" });
  expect(await s.bind("eng/x")).toMatchObject({ held: [`${A}/a`, "eng/x"] });
  const bo = await connect("bo", { token: bob });
  const cursor = () => Object.fromEntries(rows<{ handle: string; cursor: number }>(`SELECT handle, cursor FROM subscriptions WHERE board = 'eng' AND handle IN (?, 'eng/x')`, `${A}/a`).map((r) => [r.handle, r.cursor]));
  const postId = async (body: string) => (await bo.call<{ post_id: number }>("board_post", { board: "eng", body })).post_id;
  const bodies = async () => (await s.call<{ posts: { body: string }[] }>("board_read", { board: "eng" })).posts.map((p) => p.body);
  const row = async () => (await s.call<{ name: string; mode: string | null; unread: number }[]>("board_list", {})).find((b) => b.name === "eng");

  const p1 = await postId("p1");
  expect(await row()).toMatchObject({ mode: "digest", unread: 1 });
  expect(await bodies()).toEqual(["p1"]);
  expect(cursor()).toEqual({ "eng/x": p1 });
  expect(await row()).toMatchObject({ mode: "digest", unread: 0 });

  // Both subscribed (a's taken while eng/x was unbound): a read drains the one with unread first.
  expect(await s.unbind("eng/x")).toMatchObject({ released: true });
  await s.call("board_subscribe", { board: "eng", mode: "digest" });
  expect(await s.bind("eng/x")).toMatchObject({ held: [`${A}/a`, "eng/x"] });
  const p2 = await postId("p2");
  expect(await bodies()).toEqual(["p2"]);
  expect(cursor()).toEqual({ [`${A}/a`]: p2, "eng/x": p1 });
  expect(await row()).toMatchObject({ unread: 1 });
  expect(await bodies()).toEqual(["p2"]);
  expect(cursor()).toEqual({ [`${A}/a`]: p2, "eng/x": p2 });
  expect(await row()).toMatchObject({ unread: 0 });

  // A subscribe acts on the first subscribed; off removes one per call.
  await s.call("board_subscribe", { board: "eng", mode: "push" });
  const modes = () => rows(`SELECT handle, mode FROM subscriptions WHERE board = 'eng' AND handle IN (?, 'eng/x') ORDER BY handle`, `${A}/a`);
  expect(modes()).toEqual([{ handle: `${A}/a`, mode: "push" }, { handle: "eng/x", mode: "digest" }]);
  await s.call("board_subscribe", { board: "eng", mode: "off" });
  await s.call("board_subscribe", { board: "eng", mode: "off" });
  expect(modes()).toEqual([]);
  // None subscribed: the first that can see the board, the primary.
  await s.call("board_subscribe", { board: "eng", mode: "digest" });
  expect(modes()).toEqual([{ handle: `${A}/a`, mode: "digest" }]);
}, 30_000);

// hosted twin: #451 (multi-alias holds)
test("audit F8: a raw call's as is honoured only by the tools whose schema takes it", async () => {
  const s = await connect("fe");
  expect(await s.bind("fe2", { create: true })).toMatchObject({ alias: `${A}/fe2` });
  await s.call("board_create", { name: "eng", purpose: "fixtures" });
  await expect(s.call("board_read", { board: "eng", as: "fe2" })).rejects.toMatchObject({ code: "bad_request", message: `board_read takes no "as": it acts as your primary` });
  await s.call("board_post", { board: "eng", body: "hi", as: "fe2" });
  expect(rows(`SELECT author FROM posts`)).toEqual([{ author: `${A}/fe2` }]);
}, 20_000);
