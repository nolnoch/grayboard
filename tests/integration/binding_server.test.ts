// Name binding in server mode (#182, as #284 PR 3 reshaped it): a session
// is its hello and acts as its ID until it binds, a bind is a frame on its
// one connection, a rebind leaves claims behind, and what the server records.
// Each numbered title is the #182 acceptance criterion the test shows.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { cleanEnv, serverEnv } from "../support/env.ts";
import { PROTO, PROTO_REFUSAL } from "../../src/shared/protocol.ts";
import { closeSessions, mcpSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { latestV1Release, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { idAddress } from "../../src/core/bindings.ts";
import { ApplicationError, GRACE_MS, SWEEP_MS } from "../../src/server/application.ts";
import type { AppSession, AppSessionOptions } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
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

const session = (identity: string | null, o: { token?: string; cwd?: string; extra?: Record<string, string> } = {}): Promise<Session> =>
  srv.session(o.token ?? alice, identity, o.extra, o.cwd);

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  return srv.app.db.query(sql).all(...args) as T[];
}

const events = (name: string) => rows<{ session_id: string; event: string; detail: string | null }>(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id`, `${A}/${name}`);
// The status of the session holding `address` (#284: status is the session's).
const status = (address: string) => rows<{ status: string | null }>(`SELECT i.status FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ?`, address)[0]!.status;
const contents = (s: Session) => s.pushes.map((p) => p.content);
// An unbound session's own row in peer_list's unbound_sessions.
const sessionId = async (s: Session): Promise<string> => (((await s.call("peer_list", {})).unbound_sessions as { session_id: string; self?: true }[]).find((u) => u.self)!.session_id);

// A tool call's error text; a call that succeeds fails the test.
async function refusal(s: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await s.c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}

const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(srv.dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(srv.dir, `go-${point}`), "");

// AppSession drivers (no socket, no frames; #282 PR 1).
const app = (identity: string | null, o: AppSessionOptions & { token?: string } = {}): AppSession => {
  const { token, ...opts } = o;
  return srv.appSession(token ?? alice, identity, opts);
};
async function connect(identity: string | null, opts: AppSessionOptions & { token?: string } = {}): Promise<AppSession> {
  const s = app(identity, opts);
  await s.connect();
  return s;
}
// The ApplicationError a connect or a call is refused with.
async function refuses<T>(f: () => Promise<T>): Promise<ApplicationError> {
  const e = await f().then(() => undefined, (e: unknown) => e);
  if (!(e instanceof ApplicationError)) throw new Error(`expected an ApplicationError, got ${e}`);
  return e;
}
// The server restarts on the same database, a new in-process TestServer.
async function restarted(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), "gb-bind-"));
  tempDirs.push(dbDir);
  await srv.stop();
  srv = new TestServer({ dbPath: join(dbDir, "gb.db") });
  alice = await srv.login(A);
}

test("1, 3, 14: an unbound session acts as its ID, is listed for its user only, and binding a name delivers that name's mail", async () => {
  // "api" existed once and has 3 DMs queued, with no live holder.
  const dead = await srv.hosted(A, "api");
  await dead.close();
  const be = await srv.hosted(A, "be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  // An unbound hosted session: reads as its ID, receives nothing until it binds.
  // (14's unbound_sessions visibility across sessions is hub mechanics: covered
  // at the application level in src/server/application.test.ts.)
  const s = await srv.hosted(A, null);
  expect((await s.call<{ posts: { body: string }[] }>("board_read", { board: "e2e" })).posts.map((p) => p.body)).toEqual(["hello"]);

  // 3: a new name gets none of api's mail. The probe DM to api2 arrives
  // first: had the bind delivered api's backlog, it would have preceded it.
  await s.bind("api2");
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

test("15: an unbound exit removes its name record, a bound exit keeps it", async () => {
  const records = join(srv.dir, "home", ".claude-bus");
  const u = await session(null);
  expect(existsSync(join(records, `bind.${u.harnessPid}`))).toBe(true);
  await stop(u.c);
  expect(existsSync(join(records, `bind.${u.harnessPid}`))).toBe(false);
  const b = await session("api");
  await stop(b.c);
  // Server mode records the full address the bind returned.
  expect(JSON.parse(readFileSync(join(records, `bind.${b.harnessPid}`), "utf8")).names).toEqual([`${A}/api`]);
}, 30_000);

test("2, 13: a second session on a held explicit name starts unbound and names the holder; the holder keeps its mail", async () => {
  const first = await srv.hosted(A, "fe");
  const firstId = events("fe")[0]!.session_id;
  // The second session's bind is refused with the holder named.
  const second = await srv.hosted(A, null);
  await expect(second.bind("fe")).rejects.toMatchObject({ message: expect.stringContaining(firstId) });
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
  // hosted twin: #452 (the refusal's binding row rolls back on the hosted path)
  const dead = await srv.hosted(A, "fe");
  await dead.close();
  const s = await srv.hosted(A, null);
  await expect(s.bind("fee", { create: false })).rejects.toMatchObject({ message: expect.stringContaining(`no name "fee" has ever been used; closest: fe.`) });
  // The refusal created nothing; create: true does.
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'fee'`)).toEqual([]);
  await s.bind("fee");
  expect((await s.call<{ held: string[] }>("whoami", {})).held).toEqual([`${A}/fee`]);
}, 20_000);

// hosted twin: #451 (unbind, multi-alias holds)
test("#284 S1, S2, S6: bind adds a hold; unbind releases one, its claims and mail staying with it", async () => {
  const s = await connect("fe");
  const be = await connect("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  // fe2 exists (it was used once), with a DM queued before the bind.
  await (await connect("fe2")).end();
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

  // Unbinding the primary promotes the next oldest hold.
  const u = await s.unbind("fe");
  expect(u).toMatchObject({ alias: `${A}/fe`, released: true, held: [`${A}/fe2`] });
  // #284 S6: claims stay with the address they were taken under.
  expect(u.left).toEqual(["ticket:ENG-142"]);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: "unbind" });
  expect(rows(`SELECT address FROM alias_holds WHERE id = ?`, sid)).toEqual([{ address: `${A}/fe2` }]);
  expect((await s.call<{ claim: { key: string } }[]>("claim_list", {})).map((c) => c.holder)).toEqual([`${A}/fe`]);
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

  // Unbinding the last hold leaves the session acting as its ID.
  expect(await s.unbind("fe2")).toMatchObject({ alias: `${A}/fe2`, released: true, held: [] });
  expect(s.session.holds).toEqual([]);
}, 40_000);

// hosted twin: #451 (multi-alias holds)
test("#284 S1: the primary is the oldest hold; a ninth hold is refused", async () => {
  const s = await connect(null);
  for (const n of ["zed", "alpha", "c", "d", "e", "f", "g", "h"]) await s.bind(n, { create: true });
  expect(s.session.holds[0]).toBe(`${A}/zed`);
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
  await s.next(board((i) => i.kind === "push" && i.post?.id === post.item.post?.id));
  await s.next(direct((m) => m.id === dm.message.id));
  expect(await s.unbind("fe2")).toMatchObject({ released: true });
  // Another session's bind of fe2 gets the DM still unacked.
  const t = await connect(null);
  await t.bind("fe2");
  await t.next(direct((m) => m.body === "unacked"));
}, 30_000);


// A server-mode child of an interactive Claude Code started without a channels
// flag: its harness runs as `claude`, with CLAUDECODE=1.
async function channelsOffSession(identity: string | null): Promise<Session> {
  const claude = join(srv.dir, "claude");
  if (!existsSync(claude)) symlinkSync(process.execPath, claude);
  const s = await mcpSession({
    env: serverEnv(srv.dir, srv.base, alice, identity, { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" }), cwd: srv.dir, args: ["mcp", "--mode", "server"], harness: claude,
  });
  expect(s.stderr()).toContain("channels are off (the session wasn't started with");
  return s;
}

test("audit 2: a channels-off session holds its names: never online, and an unbind leaves its claims", async () => {
  const s = await channelsOffSession("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  expect(await refusal(await channelsOffSession(null), "bind", { name: "fe" })).toContain("alias_held");
  expect(await refusal(await session(null), "bind", { name: "fe" })).toContain("alias_held");
  // It holds the name without taking pushes: not online, and DMs wait.
  const fe = () => be.call("peer_list", { include_offline: true }).then((r) => r.peers.find((p: any) => p.handle === `${A}/fe`));
  expect((await fe()).online).toBe(false);

  await s.call("bind", { name: "fe2", create: true });
  const result = await s.call("unbind", { name: "fe" });
  expect(result).toContain(`these are now "fe"'s next holder's: ticket:ENG-142.`);
  expect((await be.call("claim_list", {})).map((c: any) => c.holder)).toEqual([`${A}/fe`]);
  const sid = events("fe")[0]!.session_id;
  expect(events("fe").map((e) => e.event)).toEqual(["bound", "refused", "refused", "released"]);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: "unbind" });
  expect(events("fe2")).toEqual([{ session_id: sid, event: "bound", detail: null }]);
  // fe is free now.
  const other = await session(null);
  await other.call("bind", { name: "fe" });
}, 40_000);

// hosted twin: #451 (hold-only session, unbind). The server half of the test
// above: a hold-only connection (no push) is what a channels-off process is.
test("audit 2 (server): a hold-only session holds its names: never online, and an unbind leaves its claims", async () => {
  const s = await connect("fe", { push: false, hold: true });
  const be = await connect("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  for (const opts of [{ push: false, hold: true } as AppSessionOptions, {}]) {
    const t = await connect(null, opts);
    expect((await refuses(() => t.bind("fe"))).code).toBe("alias_held");
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

// hosted twin: #451 (keyed resume)
test("audit 3, 4: a reconnect on the session's key keeps its hold; another session's bind is refused, with a wait only while the holder is in its grace", async () => {
  const key = "a1".repeat(32);
  const sid = idAddress(key);
  const fe = await connect("fe", { key });
  expect(fe.id).toBe(sid);
  await fe.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });

  // 4: a live holder: refused, no wait to offer.
  const other = await connect(null);
  const live = await refuses(() => other.bind("fe"));
  expect(live).toMatchObject({ code: "alias_held" });
  expect(live.extra.holder).toContain(sid);
  expect(live.extra.retry_after_ms).toBeUndefined();

  // 3: the connection drops; the hold stays through the grace.
  fe.close();
  const feOnline = async () => (await other.call<{ peers: { handle: string; online: boolean }[] }>("peer_list", { include_offline: true })).peers.find((p) => p.handle === `${A}/fe`)!.online;
  await until(async () => !(await feOnline()));
  const inGrace = await refuses(() => other.bind("fe"));
  expect(inGrace).toMatchObject({ code: "alias_held", message: expect.stringContaining("ends by") });
  expect(inGrace.extra.retry_after_ms).toBeGreaterThan(30_000);

  // The same key re-attaches: the hold and the claim are its, and nothing is rebound.
  const back = await connect("fe", { key, hello: { resume: true } });
  expect(back.id).toBe(sid);
  expect(rows(`SELECT holder FROM claims`)).toEqual([{ holder: `${A}/fe` }]);
  // One refusal row per reason: held live, then held in the grace.
  expect(events("fe").map((e) => e.event)).toEqual(["bound", "refused", "refused"]);
  expect(rows(`SELECT detail FROM access_log WHERE action = 'id.reattached' AND target = ?`, sid)).toEqual([{ detail: expect.stringContaining(`"resume":true`) }]);
}, 20_000);

test("audit 5: a bind whose answer was lost is settled by calling it again: the same name is already bound", async () => {
  const s = await srv.hosted(A, null);
  expect(await s.bind("fe")).toMatchObject({ name: "fe" });
  // The driver surfaces the structured content; the raw result carries the text.
  expect((await s.callRaw("bind", { name: "fe", create: true })).content).toEqual([{ type: "text", text: `already bound to "fe"` }]);
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
}, 20_000);

test("audit 11: a call issued during a bind waits for it, and runs as the name it bound", async () => {
  const s = await session(null, { extra: pauseEnv("bind:after-acquire") });
  const order: string[] = [];
  const bind = s.c.callTool({ name: "bind", arguments: { name: "fe", create: true } }).then((r) => (order.push("bind"), r));
  await until(() => s.stderr().includes("test pause hit: bind:after-acquire"));
  const take = s.c.callTool({ name: "claim_take", arguments: { key: "ticket:ENG-142", ttl_minutes: 60 } }).then((r) => (order.push("claim_take"), r));
  release("bind:after-acquire");
  expect((await bind).isError).toBeFalsy();
  expect((await take).isError).toBeFalsy();
  expect(order).toEqual(["bind", "claim_take"]);
  expect(rows(`SELECT holder FROM claims`)).toEqual([{ holder: `${A}/fe` }]);
}, 20_000);

// The server half of the test above: bind is atomic — its hold is in place
// before its answer, and a call right after runs as the bound name.
test("audit 11 (server): a call after a bind runs as the name it bound", async () => {
  const s = await connect(null);
  await s.bind("fe", { create: true });
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  expect(rows(`SELECT holder FROM claims`)).toEqual([{ holder: `${A}/fe` }]);
}, 20_000);

test("audit 7: a cancel that crosses the bind's result on the wire still gets the bind into the next result", async () => {
  const s = await session("old", { extra: pauseEnv("bind:after-acquire") });
  const abort = new AbortController();
  const bind = s.c.callTool({ name: "bind", arguments: { name: "fe", create: true } }, undefined, { signal: abort.signal });
  await until(() => s.stderr().includes("test pause hit: bind:after-acquire"));
  // The process is stopped past its last cancel check, so it reads the cancel only after it answers.
  abort.abort();
  await expect(bind).rejects.toThrow();
  release("bind:after-acquire");
  const r = await s.c.callTool({ name: "peer_list", arguments: {} });
  const texts = (r.content as { text: string }[]).map((c) => c.text);
  expect(JSON.parse(texts[0]!).you).toBe(`${A}/old`);
  expect(texts.slice(1).join(" ")).toContain(`bind("fe") completed after it was cancelled. Bound to "fe"; you hold "old", "fe" and send as "old".`);
  expect((r.structuredContent as any).instructions.slice(0, 2)).toEqual([`You are identity "old" on the grayboard bus, which coordinates between agents.`, `You also hold "fe"; you send as "old" unless a call passes as, and a reply goes as the alias its message reached.`]);
  expect((await s.c.callTool({ name: "peer_list", arguments: {} })).structuredContent).toBeUndefined();
}, 20_000);

// Stop the session's grayboard process (the harness's child) for the length of
// `during`. It resumes even when `during` throws: a stopped child outlives its
// harness, as an orphan nothing can resume.
async function whileStopped(s: Session, during: () => Promise<void>) {
  const pid = Number(Bun.spawnSync(["pgrep", "-P", String(s.harnessPid)]).stdout.toString().trim());
  process.kill(pid, "SIGSTOP");
  try {
    await during();
  } finally {
    process.kill(pid, "SIGCONT");
  }
}

// hosted twin: #451 (holder probe)
test("audit 15: a holder that can't answer keeps its name: another session's bind is refused, never a takeover", async () => {
  const s = await connect("fe", { probe: "silent" });
  const holder = events("fe")[0]!.session_id;
  // The holder stops answering the probe; its name is still never taken over.
  const t = await connect(null);
  const e = await refuses(() => t.bind("fe"));
  expect(e.code).toBe("alias_held");
  expect(e.message).toContain(`"${A}/fe" is in use by the session ${holder}`);
  expect(s.session.holds).toEqual([`${A}/fe`]);
}, 30_000);

// hosted twin: #451 (keyed reattach across a restart)
test("audit 15: a holder whose server restarts re-attaches within the grace and keeps its name; a bind meanwhile is refused with a wait", async () => {
  // A server restart on the same database.
  await restarted();
  const s = await connect("fe");
  const holder = events("fe")[0]!.session_id;
  // The restarted server seeds the grace for every unended session.
  await srv.stop();
  srv = new TestServer({ dbPath: join(tempDirs.at(-1)!, "gb.db") });
  alice = await srv.login(A);
  const t = await connect(null);
  const e = await refuses(() => t.bind("fe"));
  expect(e.code).toBe("alias_held");
  expect(e.message).toContain(`"${A}/fe" is in use by the session ${holder}`);
  expect(e.message).toContain("ends by");
  expect(e.extra.retry_after_ms).toBeGreaterThan(0);
  // The holder re-attaches on its key within the grace and keeps its name.
  const back = await connect("fe", { key: s.key, hello: { resume: true } });
  expect(back.id).toBe(holder);
  expect(events("fe").map((e2) => e2.event)).toEqual(["bound", "refused"]);
}, 30_000);

// S4/S11: a session whose server ended it during an outage comes back on a
// new key, and takes its alias back proving descent with the old key: its
// status carries over and the agent is told its ID changed.
test("a session ended during an outage reconnects on a new ID and takes its alias back with previous_key", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gb-db-"));
  const dbPath = join(dbDir, "gb.db");
  let clock = Date.now();
  srv.stop();
  srv = new TestServer({ dbPath }, { now: () => clock });
  alice = await srv.login(A);
  const s = await session("fe");
  await s.call("peer_status", { text: "mid-task" });
  const old = events("fe")[0]!.session_id;
  let next: TestServer | undefined;
  try {
    await whileStopped(s, async () => {
      const port = srv.app.server.port!;
      srv.app.stop();
      // The restarted server seeds a grace for the session; it runs out
      // before the plugin can reconnect (the sweep runs before the event
      // loop accepts a connection).
      next = new TestServer({ dbPath, httpPort: port }, { now: () => clock });
      clock += GRACE_MS + 1;
      next.app.sweepSessions();
    });
    const db = next!.app.db;
    await until(() => db.query(`SELECT 1 FROM alias_holds WHERE address = ?`).all(`${A}/fe`).length > 0, 10_000, "the rekeyed bind");
    const now = (db.query(`SELECT id FROM alias_holds WHERE address = ?`).get(`${A}/fe`) as { id: string }).id;
    expect(now).not.toBe(old);
    expect(db.query(`SELECT ended_at FROM ids WHERE id = ?`).get(old)).toEqual({ ended_at: clock });
    expect(db.query(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`).get(`${A}/fe`)).toEqual({ session_id: now, event: "bound", detail: `restored after end of session ${old}` });
    expect(db.query(`SELECT status FROM ids WHERE id = ?`).get(now)).toEqual({ status: "mid-task" });
    // The next tool result says so, after the result itself.
    const r = await s.c.callTool({ name: "peer_list", arguments: {} });
    expect((r.content as { text: string }[]).slice(1).map((c) => c.text)).toContain(
      `This session's ID changed from ${old} to ${now}: it was disconnected past the server's grace, so the old session ended and DMs sent to the old ID bounce. It took back "fe".`,
    );
  } finally {
    // Hand the restarted server to afterEach's awaited stop; the old one's
    // app was already stopped above.
    if (next) {
      srv = next;
      tempDirs.push(dbDir);
    } else {
      rmSync(dbDir, { recursive: true, force: true });
    }
  }
}, 30_000);

// hosted twin: #451 (previous_key rekey). The server half of the test above.
test("a session ended during an outage takes its alias back with previous_key (server)", async () => {
  await restarted();
  await srv.stop();
  let clock = Date.now();
  srv = new TestServer({ dbPath: join(tempDirs.at(-1)!, "gb.db") }, { now: () => clock });
  alice = await srv.login(A);
  const s = await connect("fe");
  await s.call("peer_status", { text: "mid-task" });
  const old = events("fe")[0]!.session_id;
  s.close();
  clock += GRACE_MS + 1;
  srv.app.sweepSessions();
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, old)).toEqual([{ ended_at: clock }]);
  // The new session proves descent with the old key: the alias, and the status.
  const back = await connect("fe", { bind: { previous_key: s.key } });
  const now = back.id;
  expect(now).not.toBe(old);
  expect(rows(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`, `${A}/fe`)).toEqual([
    { session_id: now, event: "bound", detail: `restored after end of session ${old}` },
  ]);
  expect(rows(`SELECT status FROM ids WHERE id = ?`, now)).toEqual([{ status: "mid-task" }]);
}, 30_000);

// Audit P1 (#345): a tools-only session binds nothing, so a rekey sends no
// bind: its new hello writes as its name again, and it keeps writing as it.
test("a tools-only session ended during an outage reconnects on a new ID still writing as its name", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gb-db-"));
  const dbPath = join(dbDir, "gb.db");
  let clock = Date.now();
  srv.stop();
  srv = new TestServer({ dbPath }, { now: () => clock });
  alice = await srv.login(A);
  const s = await session("be", { extra: { BUS_PUSH: "off" } });
  await s.call("dm_send", { to: `${A}/be`, body: "before" });
  const old = rows<{ id: string }>(`SELECT id FROM ids WHERE writes_as = ?`, `${A}/be`)[0]!.id;
  let next: TestServer | undefined;
  try {
    await whileStopped(s, async () => {
      const port = srv.app.server.port!;
      srv.app.stop();
      next = new TestServer({ dbPath, httpPort: port }, { now: () => clock });
      clock += GRACE_MS + 1;
      next.app.sweepSessions();
    });
    const db = next!.app.db;
    const r = await until(() => s.c.callTool({ name: "dm_send", arguments: { to: `${A}/be`, body: "after" } }).then((r) => (r.isError ? null : r)), 10_000, "the reconnect");
    const now = (db.query(`SELECT id FROM ids WHERE writes_as = ? AND ended_at IS NULL`).get(`${A}/be`) as { id: string }).id;
    expect(now).not.toBe(old);
    expect(db.query(`SELECT sender, sender_id FROM messages WHERE body = 'after'`).get()).toEqual({ sender: `${A}/be`, sender_id: now });
    expect((r.content as { text: string }[]).slice(1).map((c) => c.text)).toContain(
      `This session's ID changed from ${old} to ${now}: it was disconnected past the server's grace, so the old session ended and DMs sent to the old ID bounce.`,
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM binding_events`).get()).toEqual({ n: 0 });
    expect((await s.call("peer_list", {})).you).toBe(`${A}/be`);
  } finally {
    // Hand the restarted server to afterEach's awaited stop; the old one's
    // app was already stopped above.
    if (next) {
      srv = next;
      tempDirs.push(dbDir);
    } else {
      rmSync(dbDir, { recursive: true, force: true });
    }
  }
}, 30_000);

// hosted twin: #451 (writes_as/tools-only rekey). The server half of the test
// above: the new session's hello writes as its name, with no bind and no
// binding events.
test("a tools-only session ended during an outage comes back on a new ID still writing as its name (server)", async () => {
  await restarted();
  await srv.stop();
  let clock = Date.now();
  srv = new TestServer({ dbPath: join(tempDirs.at(-1)!, "gb.db") }, { now: () => clock });
  alice = await srv.login(A);
  const s = await connect("be", { push: false });
  await s.send(`${A}/be`, "before");
  const old = rows<{ id: string }>(`SELECT id FROM ids WHERE writes_as = ?`, `${A}/be`)[0]!.id;
  s.close();
  clock += GRACE_MS + 1;
  srv.app.sweepSessions();
  const back = await connect("be", { push: false });
  const now = back.id;
  expect(now).not.toBe(old);
  await back.send(`${A}/be`, "after");
  expect(rows(`SELECT sender, sender_id FROM messages WHERE body = 'after'`)).toEqual([{ sender: `${A}/be`, sender_id: now }]);
  expect(rows(`SELECT COUNT(*) AS n FROM binding_events`)).toEqual([{ n: 0 }]);
  expect(back.session.holds).toEqual([]);
}, 30_000);

// hosted twin: #451 (the hello-needs-a-session_key refusal is a `hello`
// behaviour — application now, hosted session-meta twin #451)
test("16, 18: raw binds: create: false, lazy create; a hello needs a key, and an unbound connection reads its user's boards and writes as its ID", async () => {
  await srv.api(alice, "POST", "/api/teams", { name: "eng" });
  const be = await connect("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  // 16: create: false refuses an unknown name with the closest known ones.
  const refused = await refuses(() => app("bee", { bind: { create: false } }).connect());
  expect(refused).toMatchObject({ code: "identity_unknown", message: expect.stringContaining("closest") });
  expect(refused.extra.known).toEqual(["be"]);
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'bee'`)).toEqual([]);
  // A bind without create creates the name.
  expect((await connect("lazy")).session.holds).toEqual([`${A}/lazy`]);
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'lazy'`)).toHaveLength(1);

  // A hello with no session_key is refused.
  expect(await refuses(() => app(null, { hello: { session_key: undefined } }).connect())).toMatchObject({ code: "bad_request", message: "a hello needs a session_key" });

  // 18: an unbound connection: open boards and its user's team boards.
  const ro = await connect(null);
  expect(ro.session.holds).toEqual([]);
  const boards = (await ro.call<{ name: string }[]>("board_list", {})).map((b) => b.name);
  expect(boards).toContain("e2e");
  expect(boards).toContain("eng");
  expect((await (await connect(null, { token: bob })).call<{ name: string }[]>("board_list", {})).map((b) => b.name)).not.toContain("eng");
  // It writes as its ID.
  await ro.call("board_post", { board: "e2e", body: "x" });
  await ro.call("claim_take", { key: "k" });
  expect(rows(`SELECT author FROM posts WHERE body = 'x'`)).toEqual([{ author: ro.id }]);
  expect(rows(`SELECT holder FROM claims WHERE key = 'k'`)).toEqual([{ holder: ro.id }]);
}, 20_000);


let rel: ReleaseBinaries;
beforeAll(async () => {
  rel = await releaseBinaries(await latestV1Release());
}, 120_000);

test("18: against a 1.x server, a 2.x session fails at start with the server's refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-oldsrv-"));
  const old = await ServerProcess.start(rel.server, join(dir, "bus.db"));
  try {
    const token = await old.login(A);
    for (const identity of [null, "fe"]) {
      const start = mcpSession({ env: serverEnv(dir, old.base, token, identity), cwd: dir, args: ["mcp", "--mode", "server"] });
      await expect(start).rejects.toThrow(/identity must be string/);
    }
  } finally {
    await closeSessions();
    await old.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("S15: a 1.x CLI against this server fails at start with the update hint", async () => {
  for (const identity of [null, "fe"]) {
    const start = mcpSession({ env: serverEnv(srv.dir, srv.base, alice, identity), cwd: srv.dir, args: ["mcp", "--mode", "server"], bin: rel.cli });
    await expect(start).rejects.toThrow(PROTO_REFUSAL);
  }
  // Refused by the parser, before the limiter and the DB.
  expect(rows(`SELECT id FROM ids`)).toEqual([]);
}, 60_000);

test("11: a restart under the same harness takes its names back, or restores them once a crashed predecessor's grace ends; a fresh harness starts unbound", async () => {
  // The record outranks an explicit BUS_IDENTITY: the restart is the same session, mid-task.
  // It takes back every name it held, in order (S10); restored_from proves nothing, so its status stays behind (S11).
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const peer = await session("fe");
  // A clean restart (/mcp reconnect): the old session ended, so the name is free.
  const before = events("api").at(-1)!.session_id;
  s = await s.restart("reconnect");
  expect(s.c.getInstructions()).toStartWith(`You are identity "be"`);
  expect(s.c.getInstructions()).toContain(`You also hold "api"`);
  expect(s.c.getInstructions()).toContain(`The server couldn't verify that this session continues the one that held "be", "api" (restore claimed from ${before}, not verified), so that session's status wasn't carried over: peer_status to set yours.`);
  expect((await s.call("peer_list", {})).you).toBe(`${A}/be`);
  for (const name of ["be", "api"]) {
    expect(events(name).at(-1)).toEqual({ session_id: expect.not.stringMatching(before), event: "bound", detail: `restore claimed from ${before}, not verified` });
  }
  // Its mail arrives; its status didn't carry over.
  expect((await peer.call("peer_list", {})).peers).toContainEqual(expect.objectContaining({ handle: `${A}/api` }));
  expect((await peer.call("peer_list", {})).peers).not.toContainEqual(expect.objectContaining({ status: "mid-task" }));
  await peer.call("dm_send", { to: "api", body: "after restart" });
  await until(() => contents(s).includes("after restart"));

  // A crash leaves the old session in its grace, holding the name: the
  // restart starts unbound and says it's restoring it (S11).
  s = await s.restart("crash");
  expect(s.c.getInstructions()).toContain(`This session has no bus name yet, so it acts as its ID`);
  expect(s.c.getInstructions()).toContain(`the one before it held "api" and is in its reconnect grace, so this session is restoring it`);
  expect((await s.call("peer_list", {})).you).not.toBe(`${A}/api`);

  // A new harness process is a new session: unbound, with no restore.
  await stop(s.c);
  const fresh = await session(null);
  expect(fresh.c.getInstructions()).toContain("This session has no bus name yet");
  expect(fresh.c.getInstructions()).not.toContain("restarted");
}, 60_000);

// hosted twin: #451 (restored_from restore). The server half of the test
// above: a bind's restored_from claim is never verified — the name binds
// (when free), the status stays behind, and the event logs the claim.
test("11 (server): a restored_from claim binds unverified, with the status left behind and the claim logged", async () => {
  const first = await connect("be");
  await first.bind("api", { create: true });
  await first.call("peer_status", { text: "mid-task" });
  const before = events("be").at(-1)!.session_id;
  // The old session ended (its clean exit): the names are free to restore.
  await first.end();
  const s = await connect("be", { bind: { restored_from: before } });
  const api = await s.bind("api", { restored_from: before });
  expect(api.restored).toMatchObject({ detail: `restore claimed from ${before}, not verified` });
  for (const name of ["be", "api"]) {
    expect(events(name).at(-1)).toEqual({ session_id: s.id, event: "bound", detail: `restore claimed from ${before}, not verified` });
    expect(status(`${A}/${name}`)).toBeNull();
  }
  // Its mail arrives.
  const peer = await connect("fe");
  await peer.send("api", "after restart");
  await s.next(direct((m) => m.body === "after restart"));
}, 30_000);

// S11: a crash restart's restore completes in the background once the
// predecessor's grace ends and the sweep frees the alias. The server's clock
// is injected and the restart paused before its bind, so the refusal's wait
// is one sweep tick, not the whole grace.
test("11: a restore waiting out a crashed predecessor's grace binds once the sweep ends it", async () => {
  srv.stop();
  let clock = Date.now();
  srv = new TestServer({}, { now: () => clock });
  alice = await srv.login(A);
  let s = await session("api", { extra: pauseEnv("restore:before-bind") });
  const before = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)[0]!.id;
  const crashed = clock;
  const restarted = s.restart("crash");
  // The old session is in its grace, and the new one about to restore.
  await until(() => rows(`SELECT 1 FROM access_log WHERE action = 'id.detached' AND target = ?`, before).length > 0);
  await until(() => s.stderr().includes("test pause hit: restore:before-bind"));
  clock = crashed + GRACE_MS - 1;
  release("restore:before-bind");
  s = await restarted;
  expect(s.c.getInstructions()).toContain(`so this session is restoring it: it binds "api" by itself within ${Math.ceil((1 + SWEEP_MS) / 1000)}s`);
  const after = await sessionId(s);
  // The grace runs out; the sweep ends the old session and frees the alias.
  clock += 1;
  srv.app.sweepSessions();
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, before)).toEqual([{ ended_at: clock }]);
  await until(() => rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/api`).length > 0, SWEEP_MS + 5000, "the restore's bind");
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: after }]);
  expect(events("api").at(-1)).toEqual({ session_id: after, event: "bound", detail: `restore claimed from ${before}, not verified` });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/api`);
}, 30_000);

// hosted twin: #451 (restore waits out the grace). The server half of the
// test above: the restore's bind is refused with a wait during the grace and
// succeeds once the sweep ends the predecessor.
test("11 (server): a restore refused during the predecessor's grace binds after the sweep", async () => {
  let clock = Date.now();
  await srv.stop();
  srv = new TestServer({}, { now: () => clock });
  alice = await srv.login(A);
  const first = await connect("api");
  const before = first.id;
  // It drops (crashed): the hold stays through the grace.
  first.close();
  const wait = async () => {
    const s = await connect(null);
    return refuses(() => s.bind("api", { restored_from: before }));
  };
  const refusedDuring = await wait();
  expect(refusedDuring.code).toBe("alias_held");
  const waitMs = refusedDuring.extra.retry_after_ms;
  expect(waitMs).toBeGreaterThan(0);
  clock += waitMs!;
  srv.app.sweepSessions();
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, before)).toEqual([{ ended_at: expect.any(Number) }]);
  const s = await connect(null);
  expect(await s.bind("api", { restored_from: before })).toMatchObject({ alias: `${A}/api`, restored: { verified: false, detail: `restore claimed from ${before}, not verified` } });
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: s.id }]);
}, 30_000);

// Audit P7 (#345): the user's bind limit refuses the restore's bind with a
// wait; the restore retries after it, as the startup bind does.
test("11: a restore refused by the bind limit retries after the wait it was given", async () => {
  srv.stop();
  let clock = Date.now();
  srv = new TestServer({ helloLimit: { burst: 10, perSec: 1 } }, { now: () => clock });
  alice = await srv.login(A);
  let s = await session("api", { extra: pauseEnv("restore:before-bind") });
  const before = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)[0]!.id;
  const crashed = clock;
  const restarted = s.restart("crash");
  // As above: the startup bind's refusal waits one sweep tick.
  await until(() => s.stderr().includes("test pause hit: restore:before-bind"));
  clock = crashed + GRACE_MS - 1;
  release("restore:before-bind");
  s = await restarted;
  expect(s.c.getInstructions()).toContain(`so this session is restoring it`);
  const after = await sessionId(s);
  // Spend the rest of alice's hellos; the clock stands still, so none refill.
  for (;;) {
    const r = await srv.client(alice, null).connect();
    if (r.type === "error") {
      expect(r.code).toBe("rate_limited");
      break;
    }
  }
  // The grace runs out and frees the alias; the restore's bind is limited.
  clock += 1;
  srv.app.sweepSessions();
  await until(() => /restoring "alice@example\.com\/api" retries in \d+ms: rate_limited/.test(s.stderr()), SWEEP_MS + 5000, "the limited restore");
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([]);
  clock += 2000;
  await until(() => rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/api`).length > 0, 5000, "the retried restore");
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: after }]);
  expect(events("api").at(-1)).toEqual({ session_id: after, event: "bound", detail: `restore claimed from ${before}, not verified` });
  expect(s.stderr()).not.toContain(`didn't restore`);
}, 30_000);

// hosted twin: #451 (bind limiter on the restore path). The server half of
// the test above: the user's bind limit refuses the restore's bind with a
// wait, and the retry after it succeeds.
test("11 (server): a restore refused by the bind limit binds after the wait", async () => {
  let clock = Date.now();
  await srv.stop();
  srv = new TestServer({ helloLimit: { burst: 6, perSec: 1 } }, { now: () => clock });
  alice = await srv.login(A);
  const first = await connect("api");
  const before = first.id;
  await first.end();
  // A hello and a bind each spend a token: the restore session, then enough
  // unbound hellos to empty the bucket (6), so the restore's bind is refused.
  const restored = await connect(null);
  await connect(null);
  await connect(null);
  await connect(null);
  const limited = await refuses(() => restored.bind("api", { restored_from: before }));
  expect(limited.code).toBe("rate_limited");
  expect(limited.extra.retry_after_ms).toBeGreaterThan(0);
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([]);
  clock += limited.extra.retry_after_ms! + 1000;
  expect(await restored.bind("api", { restored_from: before })).toMatchObject({ alias: `${A}/api` });
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: restored.id }]);
  expect(events("api").at(-1)).toEqual({ session_id: restored.id, event: "bound", detail: `restore claimed from ${before}, not verified` });
}, 30_000);

// S11: restored_from proves nothing on a server; every one is logged as a
// claim and starts a fresh status.
// hosted twin: #451 (restore flags)
test("S11: a restored_from naming another of the user's sessions is logged unverified and starts a fresh status", async () => {
  const s = await connect("api");
  await s.call("peer_status", { text: "mid-task" });
  await s.end();
  // One of alice's own sessions (a stranger's fails the principal check first).
  const stranger = (await connect(null)).id;
  const ws = await connect("api", { bind: { restored_from: stranger } });
  expect(ws.session.holds).toEqual([`${A}/api`]);
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restore claimed from ${stranger}, not verified` });
  expect(status(`${A}/api`)).toBeNull();
});

// Audit S5 (#345): a team alias's history shows every member's sessions,
// but a restore never carries another principal's session's status over.
// hosted twin: #451 (end, restore flags)
test("S11: a restored_from naming another principal's session is unverified, even when the alias's history shows it", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const theirs = await connect("eng/api", { token: bob });
  await theirs.call("peer_status", { text: "bob's task" });
  await theirs.end();
  const mine = await connect("eng/api", { bind: { restored_from: theirs.id } });
  expect(mine.session.holds).toEqual(["eng/api"]);
  expect(rows(`SELECT detail FROM binding_events WHERE name = 'eng/api' ORDER BY id DESC LIMIT 1`)).toEqual([{ detail: `restore claimed from ${theirs.id}, not verified` }]);
  expect(status("eng/api")).toBeNull();
});

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
  await mine.end();

  const theirs = await connect("eng/api", { token: bob });
  const refused = `attachment ${up.body.id} isn't an unsent upload of yours`;
  await expect(theirs.send(`${A}/be`, "x", { attachment_ids: [up.body.id] })).rejects.toMatchObject({ code: "bad_request", message: refused });
  await expect(theirs.call("board_post", { board: "eng", body: "x", attachment_ids: [up.body.id] })).rejects.toMatchObject({ message: expect.stringContaining(refused) });
  // Nor over HTTP, as the alias: the download and the release both refuse.
  expect(await srv.api(bob, "GET", `/api/attachments/${up.body.id}?as=eng%2Fapi`)).toMatchObject({ status: 404 });
  expect(await srv.api(bob, "DELETE", `/api/attachments/${up.body.id}?as=eng%2Fapi`)).toMatchObject({ status: 404 });
  expect(rows(`SELECT message_id, post_id FROM attachments WHERE id = ?`, up.body.id)).toEqual([{ message_id: null, post_id: null }]);
});

// hosted twin: #451 (restore flags)
test("#284: a 1.x client's 16-hex restored_from is logged as the same session ID, unverified (S11)", async () => {
  const key = "d5".repeat(32);
  const ws = await connect("api", { key });
  await ws.call("peer_status", { text: "mid-task" });
  await ws.end();
  expect(events("api").at(-1)!.event).toBe("released");
  // What a 1.x client's name record holds: the key's SHA-256, first 16 hex.
  const hex = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16);
  const next = await connect("api", { bind: { restored_from: hex } });
  expect(next.id).toMatch(/^id:[0-9a-z]{13}$/);
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restore claimed from ${idAddress(key)}, not verified` });
  expect(status(`${A}/api`)).toBeNull();
});

// hosted twin: #451 (key resume, previous_key descent)
test("#211, S4: a reconnect inside the grace is the same session; past its end, previous_key proves descent and a stray's doesn't", async () => {
  const apiStatus = () => status(`${A}/api`);
  const [mine, theirs] = ["a1".repeat(32), "b1".repeat(32)];
  let ws = await connect("api", { key: mine });
  await ws.call("peer_status", { text: "mid-task" });
  ws.close();
  // A reconnect on its key re-attaches: same ID, still bound, status kept, no rebind.
  ws = await connect("api", { key: mine, hello: { resume: true } });
  expect(ws.id).toBe(idAddress(mine));
  expect(ws.session.holds).toEqual([`${A}/api`]);
  expect(apiStatus()).toBe("mid-task");
  expect(events("api").map((e) => e.event)).toEqual(["bound"]);
  // The session ends (as the grace would end it).
  await ws.end();

  // A stray naming a key that isn't an ended session of the alias's: unverified, fresh status.
  ws = await connect("api", { bind: { previous_key: theirs } });
  const stray = ws.id;
  expect(events("api").at(-1)!.detail).toBe(`restore after end not verified: ${idAddress(theirs)} isn't an ended session of yours`);
  expect(apiStatus()).toBeNull();
  await ws.end();

  // The ended session's own key, after a stray held the name since: not the latest binder.
  const third = "c1".repeat(32);
  ws = await connect("api", { key: third, bind: { previous_key: mine } });
  expect(events("api").at(-1)!.detail).toBe(`restored_from ${idAddress(mine)} not verified: latest bound by ${stray}`);
  expect(apiStatus()).toBeNull();
  await ws.call("peer_status", { text: "resumable" });
  await ws.end();

  // The latest binder's key: verified, status inherited.
  ws = await connect("api", { bind: { previous_key: third } });
  expect(events("api").at(-1)!.detail).toBe(`restored after end of session ${idAddress(third)}`);
  expect(apiStatus()).toBe("resumable");
}, 20_000);


// #284: a session's ID is one principal's. Another user presenting the same
// key is refused, never attached to the session's row; the owner's own
// further hellos and binds are the same session.
// hosted twin: #451 (keyed hello)
test("#284: a key whose ID is another principal's session is refused with id_collision, and audited", async () => {
  const key = "c4".repeat(32);
  const mine = await connect("api", { key, hello: { where: "laptop" } });
  expect(rows(`SELECT id, principal, place FROM ids`)).toEqual([{ id: idAddress(key), principal: A, place: "laptop" }]);
  expect(rows(`SELECT address, id FROM alias_holds`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }]);
  expect(await refuses(() => app("api", { key, token: bob }).connect())).toMatchObject({ code: "id_collision", message: expect.stringContaining(idAddress(key)) });
  expect(rows(`SELECT actor, action, target FROM access_log WHERE action = 'id.collision'`)).toEqual([{ actor: "bob@example.com", action: "id.collision", target: idAddress(key) }]);
  expect(rows(`SELECT address FROM alias_holds`)).toEqual([{ address: `${A}/api` }]);
  // The owner's next bind is the same session: one ids row, a second hold.
  expect(await mine.bind("web")).toMatchObject({ alias: `${A}/web` });
  expect(rows(`SELECT id FROM ids`)).toEqual([{ id: idAddress(key) }]);
  expect(rows(`SELECT address, id FROM alias_holds ORDER BY address`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }, { address: `${A}/web`, id: idAddress(key) }]);
  await mine.end();
  expect(rows(`SELECT 1 FROM alias_holds`)).toEqual([]);
});


// #284 decision 5: teams and service principals share one namespace.
test("#284: creating a team refuses a name another principal holds", async () => {
  srv.app.db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  const r = await srv.api(alice, "POST", "/api/teams", { name: "ingest" });
  expect(r.status).toBe(409);
  expect(r.body.message).toContain(`"ingest" belongs to another team or service principal`);
});

test("13 (decision 13): `grayboard tools` prints what the session serves; bind's result carries its name and instructions", async () => {
  const s = await session(null);
  const printed = await runCli(["tools", "--json"], { cwd: srv.dir, env: serverEnv(srv.dir, srv.base, alice, null) });
  expect(printed.code).toBe(0);
  expect(JSON.parse(printed.out)).toEqual((await s.c.listTools()).tools);
  const r = await s.c.callTool({ name: "bind", arguments: { name: "api", create: true } });
  expect(r.structuredContent).toEqual({ name: "api", instructions: expect.any(Array) });
  expect((r.structuredContent as { instructions: string[] }).instructions[0]).toStartWith(`You are identity "api"`);
}, 20_000);

test("13 (server): a hosted bind's result carries its name and instructions", async () => {
  const s = await srv.hosted(A, null, { delivery: false });
  const bound = await s.call<{ name: string; instructions: string[] }>("bind", { name: "api", create: true });
  expect(bound.name).toBe("api");
  expect(bound.instructions[0]).toStartWith(`You are identity "api"`);
}, 20_000);

test("audit 19: a bind or writes_as refused for an invalid or reserved name is refused, and a reserved one logged", async () => {
  const long = `x${"y".repeat(40)}!`;
  expect(await refuses(() => app(long).connect())).toMatchObject({ code: "bad_request" });
  expect(await refuses(() => app("human").connect())).toMatchObject({ code: "forbidden" });
  // A tools-only connection can't write as it either.
  expect(await refuses(() => app("human", { push: false }).connect())).toMatchObject({ code: "forbidden" });
  // Both refusals are logged, each under its own session's ID.
  const refused = { session_id: expect.stringMatching(/^id:[0-9a-z]{13}$/), event: "refused", detail: expect.stringContaining("human") };
  const rowsFor = events("human");
  expect(rowsFor).toEqual([refused, refused]);
  expect(rowsFor[0]!.session_id).not.toBe(rowsFor[1]!.session_id);
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

// #284 audit B12/W5: the lazy alias.created row names the session that
// created it; handle.launcher_set is the session's (its target), and the
// first hello's flag is written once, by registerId.
// hosted twin: #451 (launcher flag on a hold)
test("#284: alias.created names the session; handle.launcher_set targets it; the flag is on its ids row", async () => {
  await connect("be", { hello: { launcher: true } });
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/be`)[0]!.id;
  expect(rows(`SELECT action, actor, target, detail FROM access_log WHERE action IN ('alias.created', 'handle.launcher_set') ORDER BY id`)).toEqual([
    { action: "handle.launcher_set", actor: A, target: id, detail: JSON.stringify({ on: true }) },
    { action: "alias.created", actor: A, target: `${A}/be`, detail: JSON.stringify({ lazy: true, session: id }) },
  ]);
  expect(rows(`SELECT launcher FROM ids WHERE id = ?`, id)).toEqual([{ launcher: 1 }]);
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

// #284 S10 on the server: a restart takes back what it can of its record; a
// name another live session holds is named in a note, and the rest still bind.
test("#284 S10: a restart takes back its names but one held by another, which a note names", async () => {
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  const path = join(srv.dir, "home", ".claude-bus", `bind.${s.harnessPid}`);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  expect(rec.names).toEqual([`${A}/be`, `${A}/api`]);
  await s.call("unbind", { name: "api" });
  const t = await session(null);
  const tid = await sessionId(t);
  await t.call("bind", { name: "api" });
  writeFileSync(path, JSON.stringify(rec));
  s = await s.restart("reconnect");
  expect((await s.call("peer_list", {})).you).toBe(`${A}/be`);
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: tid }]);
  expect(s.c.getInstructions()).toContain(`This grayboard process restarted; the one before it held "api", but`);
  expect(s.c.getInstructions()).toContain("so this session doesn't hold it.");
  expect(s.c.getInstructions()).not.toContain(`You also hold "api"`);
}, 40_000);

// hosted twin: #451 (record-based restore). The server half of the test
// above: restoring a name another live session holds is refused, naming the
// holder, while the rest restore.
test("#284 S10 (server): a restore takes back its names but one held by another", async () => {
  const s = await connect("be");
  await s.bind("api", { create: true });
  const sid = s.id;
  await s.unbind("api");
  const t = await connect(null);
  await t.bind("api");
  await s.end();
  // The restore re-binds its record: "api" is refused, naming its holder; "be" restores.
  const r = await connect("be", { bind: { restored_from: sid } });
  expect(r.session.holds).toEqual([`${A}/be`]);
  const e = await refuses(() => r.bind("api", { restored_from: sid }));
  expect(e.code).toBe("alias_held");
  expect(e.message).toContain(t.id);
  expect(rows(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/api`)).toEqual([{ id: t.id }]);
}, 30_000);

// A record written before several aliases carries one `name`; client files
// can't be migrated, so it still restores.
test("#284 S10: a name record from before several aliases (one `name`) still restores on the server", async () => {
  let s = await session("api");
  const path = join(srv.dir, "home", ".claude-bus", `bind.${s.harnessPid}`);
  const { names, ...rec } = JSON.parse(readFileSync(path, "utf8"));
  expect(names).toEqual([`${A}/api`]);
  writeFileSync(path, JSON.stringify({ ...rec, name: `${A}/api` }));
  const before = events("api").at(-1)!.session_id;
  s = await s.restart("reconnect");
  expect((await s.call("peer_list", {})).you).toBe(`${A}/api`);
  expect(events("api").at(-1)).toEqual({ session_id: expect.not.stringMatching(before), event: "bound", detail: `restore claimed from ${before}, not verified` });
}, 30_000);

// #284 S16: the Slack bridge's human is its user's `human` and nothing else.
// Its in-process attachment binds, unbinds and ends nothing, and keeps its
// hold.
test("the bridge's human connection binds, unbinds and ends nothing", async () => {
  // #284 port: on master (#402) the bridge attaches its human through the
  // application's trusted method, not a WSS frame, so the refusals are the
  // application's.
  const user = srv.app.repo.users.findByEmail(A)!;
  const pushes: string[] = [];
  const sink = { deliver: (e: any) => { if (e.kind === "direct") pushes.push(e.message.body); }, probe: async () => true, closed() {} };
  const { session, ok } = await srv.app.application.attachHuman({ user_id: user.id, user_email: A, session_id: 0 }, sink);
  expect(ok).toMatchObject({ id: "human" });
  const human = `${A}/human`;
  const refused = async (f: () => unknown) => { try { await f(); } catch (e) { return { code: (e as any).code, message: (e as Error).message }; } return undefined; };
  expect(await refused(() => srv.app.application.unbind(session, human))).toEqual({ code: "bad_request", message: `the Slack bridge's connection is its user's "human"; it unbinds nothing` });
  expect(await refused(() => srv.app.application.bind(session, { alias: "fe", create: true }))).toEqual({ code: "bad_request", message: `the Slack bridge's connection is its user's "human"; it binds nothing` });
  expect(await refused(() => srv.app.application.end(session))).toEqual({ code: "bad_request", message: "the Slack bridge's humans have no session to end" });
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
// its holder lives and keeps writing as b; once the holder ends, a forged
// restored_from gets a's mail and claims, but not the holder's status, and
// leaves the stray's primary b.
// hosted twin: #451 (multi-alias, end, restore flags)
test("#259: a stray refused a while its holder lives takes it after the end, unverified, keeping its primary", async () => {
  const p = await connect("a");
  await p.call("peer_status", { text: "p's task" });
  expect(await p.call("claim_take", { key: "ticket:ENG-7" })).toMatchObject({ claim: { holder: `${A}/a` } });
  const x = await connect("b");
  expect((await refuses(() => x.bind("a", { restored_from: p.id }))).code).toBe("alias_held");
  await x.send(`${A}/a`, "from b");
  await p.next(direct((m) => m.body === "from b" && m.sender === `${A}/b`));

  await p.end();
  const peer = await connect("fe", { token: bob });
  expect(await peer.send(`${A}/a`, "for a")).toMatchObject({ delivered_now: false });

  expect(await x.bind("a", { restored_from: p.id })).toMatchObject({ held: [`${A}/b`, `${A}/a`] });
  await x.next(direct((m) => m.body === "for a"));
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-7'`)).toEqual([{ holder: `${A}/a` }]);
  expect(events("a").slice(-2)).toEqual([
    { session_id: p.id, event: "released", detail: "session_end: exit" },
    { session_id: x.id, event: "bound", detail: `restore claimed from ${p.id}, not verified` },
  ]);
  expect(status(`${A}/a`)).toBeNull();
  const sent = await x.send("bob@example.com/fe", "who am i");
  expect(rows(`SELECT sender FROM messages WHERE id = ?`, sent.message_id)).toEqual([{ sender: `${A}/b` }]);
});

// #284 S11 on the server: the holds are the session's, oldest first. The
// whoami fields the server-mode client added locally (its ID, principal) are
// plugin behaviour, deleted with it; the tools-only half is #451's.
test("#284 S11: whoami over the server names the ID, the holds oldest first and the principal", async () => {
  const s = await srv.hosted(A, null, { delivery: false });
  expect(await s.call<{ held: string[]; primary: string | null; unbound?: boolean }>("whoami", {})).toMatchObject({ held: [], primary: null, unbound: true });
  await s.bind("zed");
  await s.bind("alpha");
  expect(await s.call<{ held: string[]; primary: string }>("whoami", {})).toMatchObject({ held: [`${A}/zed`, `${A}/alpha`], primary: `${A}/zed` });
}, 30_000);

// #284 S1: the primary is the first alias bound, even when binds share a
// millisecond: bound_at is made monotonic per session, so neither the clock
// nor the address order decides. The restore loop binds in record order.
test("#284 S1: with the server's clock frozen, the first alias bound stays the primary, through a restart's restore", async () => {
  srv.stop();
  const frozen = Date.now();
  srv = new TestServer({}, { now: () => frozen });
  alice = await srv.login(A);
  let s = await session("zed");
  await s.call("bind", { name: "alpha", create: true });
  await s.call("bind", { name: "mid", create: true });
  const order = () => rows<{ address: string }>(`SELECT address FROM alias_holds ORDER BY bound_at`).map((r) => r.address);
  expect(order()).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
  expect((await s.call("whoami", {})).primary).toBe(`${A}/zed`);
  s = await s.restart("reconnect");
  expect(order()).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
  expect((await s.call("whoami", {})).aliases).toEqual([`${A}/zed`, `${A}/alpha`, `${A}/mid`]);
  expect(s.c.getInstructions()).toStartWith(`You are identity "zed"`);
}, 40_000);

// hosted twin: #451 (multi-alias restore). The server half of the test
// above: bound_at is monotonic per session, so the primary survives a frozen
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
  await s.end();
  const r = await connect("zed", { bind: { restored_from: s.id } });
  await r.bind("alpha", { restored_from: s.id });
  await r.bind("mid", { restored_from: s.id });
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
  await prev.end();
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
