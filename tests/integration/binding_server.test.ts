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
import { PROTO_REFUSAL } from "../../src/shared/protocol.ts";
import { closeSessions, mcpSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { idAddress } from "../../src/core/bindings.ts";
import { GRACE_MS, SWEEP_MS } from "../../src/server/ws.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let srv: TestServer;
let alice: string;
let bob: string;
const A = "alice@example.com";

beforeEach(async () => {
  srv = new TestServer();
  alice = await srv.login(A);
  bob = await srv.login("bob@example.com");
});

afterEach(async () => {
  await closeSessions();
  srv.stop();
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

test("1, 3, 14: an unbound session acts as its ID, is listed for its user only, and binding a name delivers that name's mail", async () => {
  // "api" existed once and has 3 DMs queued, with no live holder.
  await stop((await session("api")).c);
  const be = await session("be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  const s = await session(null);
  const id = await sessionId(s);
  expect(s.c.getInstructions()).toContain(`This session has no bus name yet, so it acts as its ID: peers reach it at ${id}`);

  // It reads, and writes as its ID (#284 S1): a reply to its ID reaches it.
  expect((await s.call("board_read", { board: "e2e" })).posts.map((p: any) => p.body)).toEqual(["hello"]);
  await s.call("board_post", { board: "e2e", body: "from the id" });
  expect(rows(`SELECT author FROM posts WHERE body = 'from the id'`)).toEqual([{ author: id }]);
  await s.call("dm_send", { to: "be", body: "hi from the id" });
  await until(() => contents(be).includes("hi from the id"));
  expect(be.pushes.find((p) => p.content === "hi from the id")!.meta.from).toBe(id);
  await be.call("dm_send", { to: id, body: "reply" });
  await until(() => contents(s).includes("reply"));
  s.pushes.splice(0);

  // 14: the user's other sessions see it by session ID; another user's don't.
  const seen = (await be.call("peer_list", {})).unbound_sessions;
  expect(seen).toEqual([expect.objectContaining({ session_id: id, unbound: true, online: true })]);
  expect(seen[0].self).toBeUndefined();
  expect((await (await session("ops", { token: bob })).call("peer_list", {})).unbound_sessions).toBeUndefined();

  // 3: a new name gets none of api's mail.
  await s.call("bind", { name: "api2", create: true });
  // Barrier: api2's backlog is sent on its connection before this DM, so api's
  // mail, if wrongly delivered, would arrive first.
  await be.call("dm_send", { to: "api2", body: "probe" });
  await until(() => contents(s).length > 0);
  expect(contents(s)).toEqual(["probe"]);
  s.pushes.splice(0);

  // 1: binding the name delivers what waited, and a new DM wakes it.
  await s.call("bind", { name: "api" });
  await until(() => contents(s).length === 3);
  expect(contents(s)).toEqual(["one", "two", "three"]);
  await be.call("dm_send", { to: "api", body: "four" });
  await until(() => contents(s).length === 4);

  // 14: bound, it's gone from the list.
  await until(async () => (await be.call("peer_list", {})).unbound_sessions === undefined);
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
  const first = await session("fe");
  const firstId = events("fe")[0]!.session_id;
  const second = await session("fe");
  expect(second.c.getInstructions()).toContain(`BUS_IDENTITY asked for "fe", but the session ${firstId}, in `);
  expect((await second.call("peer_list", {})).peers).toEqual(expect.arrayContaining([expect.objectContaining({ handle: `${A}/fe`, online: true })]));
  const be = await session("be");
  await be.call("dm_send", { to: "fe", body: "to the holder" });
  await until(() => contents(first).length === 1);
  expect(contents(second)).toEqual([]);
  const ev = events("fe");
  expect(ev.map((e) => e.event)).toEqual(["bound", "refused"]);
  expect(ev[1]!.detail).toStartWith(`the session ${firstId}`);
  expect(ev[1]!.session_id).not.toBe(firstId);
}, 20_000);

test("4, 13: a never-seen name needs create; the refusal lists the closest names", async () => {
  await stop((await session("fe")).c);
  const s = await session(null);
  const err = await refusal(s, "bind", { name: "fee" });
  expect(err).toContain(`no name "fee" has ever been used; closest: fe.`);
  expect(events("fee")).toEqual([{ session_id: await sessionId(s), event: "refused", detail: expect.stringContaining("closest: fe") }]);
  // The refusal created nothing; create: true does.
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'fee'`)).toEqual([]);
  await s.call("bind", { name: "fee", create: true });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fee`);
}, 20_000);

test("#284 S1, S2, S6: bind adds a hold; unbind releases one, its claims and mail staying with it", async () => {
  const s = await session("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  // fe2 exists (it was used once), with a DM queued before the bind.
  await stop((await session("fe2")).c);
  await be.call("dm_send", { to: "fe2", body: "queued for fe2" });

  const result = await s.call("bind", { name: "fe2" });
  expect(result).toStartWith(`Bound to "fe2"; you hold "fe", "fe2" and send as "fe".`);
  expect(result).toContain(`You are identity "fe" on the grayboard bus, which coordinates between agents. You also hold "fe2"; you send as "fe" unless a call passes as, and a reply goes as the alias its message reached.`);
  // Both names' mail reaches it: fe2's queued DM and a new one to fe. A push
  // names the alias it reached when that isn't the primary (S4).
  await until(() => contents(s).includes("queued for fe2"));
  await be.call("dm_send", { to: "fe", body: "to fe" });
  await until(() => contents(s).includes("to fe"));
  expect(s.pushes.find((p) => p.content === "queued for fe2")!.meta.to).toBe(`${A}/fe2`);
  expect(s.pushes.find((p) => p.content === "to fe")!.meta.to).toBeUndefined();
  const sid = events("fe")[0]!.session_id;
  expect(rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at`, sid)).toEqual([{ address: `${A}/fe` }, { address: `${A}/fe2` }]);
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "bound"]);
  expect(rows(`SELECT COUNT(*) AS n FROM binding_events WHERE event = 'moved'`)).toEqual([{ n: 0 }]);
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fe`);
  expect(await s.call("whoami", {})).toEqual({ id: sid, primary: `${A}/fe`, aliases: [`${A}/fe`, `${A}/fe2`], principal: A });

  // Unbinding the primary promotes the next oldest hold.
  const u = await s.call("unbind", { name: "fe" });
  expect(u).toStartWith(`Released "fe"; mail to it queues for its next holder.`);
  // #284 S6: claims stay with the address they were taken under.
  expect(u).toContain(`Claims stay with the name they were taken under; these are now "fe"'s next holder's: ticket:ENG-142.`);
  expect(u).toContain(`You now send as "fe2".`);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: "unbind" });
  expect(rows(`SELECT address FROM alias_holds WHERE id = ?`, sid)).toEqual([{ address: `${A}/fe2` }]);
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fe2`);
  expect(await s.call("whoami", {})).toEqual({ id: sid, primary: `${A}/fe2`, aliases: [`${A}/fe2`], principal: A });
  expect((await s.call("claim_list", {})).map((c: any) => c.holder)).toEqual([`${A}/fe`]);
  expect(rows(`SELECT 1 FROM claim_events WHERE key = 'ticket:ENG-142' AND event = 'moved'`)).toEqual([]);
  expect(await refusal(s, "claim_release", { key: "ticket:ENG-142" })).toContain(`${A}/fe`);
  expect(await be.call("dm_send", { to: "fe", body: "after unbind" })).toMatchObject({ delivered_now: false });
  // Idempotent: a name it doesn't hold is already released.
  expect(await s.call("unbind", { name: "fe" })).toBe(`not holding "fe"`);
  expect(events("fe").filter((e) => e.event === "released")).toHaveLength(1);

  // fe's next holder gets its mail and its claim.
  const other = await session(null);
  await other.call("bind", { name: "fe" });
  await until(() => contents(other).includes("after unbind"));
  expect(contents(s)).not.toContain("after unbind");
  expect(await other.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");

  // Unbinding the last hold leaves the session acting as its ID.
  const last = await s.c.callTool({ name: "unbind", arguments: { name: "fe2" } });
  expect((last.content as { text: string }[])[0]!.text).toContain(`You now send as "${sid}".`);
  expect((last.structuredContent as { name: string; instructions: string[] })).toEqual({ name: sid, instructions: expect.arrayContaining([expect.stringContaining("This session has no bus name yet, so it acts as its ID")]) });
  expect((await s.call("peer_list", {})).you).toBe(sid);
  expect(JSON.parse(readFileSync(join(srv.dir, "home", ".claude-bus", `bind.${s.harnessPid}`), "utf8")).names).toEqual([]);
}, 40_000);

test("#284 S1: the primary is the oldest hold; a ninth hold is refused", async () => {
  const s = await session(null);
  for (const n of ["zed", "alpha", "c", "d", "e", "f", "g", "h"]) await s.call("bind", { name: n, create: true });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/zed`);
  expect(await refusal(s, "bind", { name: "i", create: true })).toContain(`this session already holds 8 names`);
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = ?`, `${A}/i`)).toEqual([]);
}, 40_000);

test("#284 S2, S6: unbind is refused for a tools-only process, whose whoami names what it writes as", async () => {
  const s = await session("fe");
  const tools = await session("fe", { extra: { BUS_PUSH: "off" } });
  expect(await refusal(tools, "unbind", { name: "fe" })).toContain("this grayboard process is tools-only (BUS_PUSH=off)");
  expect(await tools.call("whoami", {})).toMatchObject({ aliases: [], primary: `${A}/fe`, writes_as: `${A}/fe` });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fe`);
}, 30_000);

test("#284 S2: a DM pushed for an alias and unacked at its unbind reaches its next holder; a board item pushed before is pushed again on a re-bind", async () => {
  const s = srv.client(alice, "fe");
  await s.connect();
  expect(await s.bind("fe2", { create: true })).toMatchObject({ type: "bind_ok", held: [`${A}/fe`, `${A}/fe2`] });
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "@fe2 look" });
  const post = await s.next((m) => m.type === "board_push" && m.item.post?.body === "@fe2 look");
  await be.call("dm_send", { to: "fe2", body: "unacked" });
  const dm = await s.next((m) => m.type === "push" && m.message.body === "unacked");
  // Neither is acked; the unbind leaves both for fe2.
  expect(await s.request({ type: "unbind", alias: "fe2" })).toMatchObject({ type: "unbind_ok", alias: `${A}/fe2`, released: true, held: [`${A}/fe`] });
  expect(await s.request({ type: "unbind", alias: "fe2" })).toMatchObject({ type: "unbind_ok", released: false });
  // Re-bound on the same connection, the board item goes out again.
  expect(await s.bind("fe2")).toMatchObject({ type: "bind_ok" });
  expect(await s.next((m) => m.type === "board_push" && m.item.post?.id === post.item.post.id)).toBeDefined();
  expect(await s.next((m) => m.type === "push" && m.message.id === dm.message.id)).toBeDefined();
  expect(await s.request({ type: "unbind", alias: "fe2" })).toMatchObject({ released: true });
  // Another session's bind of fe2 gets the DM still unacked.
  const t = await session(null);
  await t.call("bind", { name: "fe2" });
  await until(() => contents(t).includes("unacked"));
}, 30_000);


// A server-mode child that Claude Code started without a channels flag: its
// harness runs as `claude`, with CLAUDECODE=1.
async function channelsOffSession(identity: string | null): Promise<Session> {
  const claude = join(srv.dir, "claude");
  if (!existsSync(claude)) symlinkSync(process.execPath, claude);
  const s = await mcpSession({
    env: serverEnv(srv.dir, srv.base, alice, identity, { CLAUDECODE: "1" }), cwd: srv.dir, args: ["mcp", "--mode", "server"], harness: claude,
  });
  expect(s.stderr()).toContain("no channels flag: tools only");
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

test("audit 3, 4: a reconnect on the session's key keeps its hold; another session's bind is refused, with a wait only while the holder is in its grace", async () => {
  const key = "a1".repeat(32);
  const sid = idAddress(key);
  const fe = srv.client(alice, "fe", { key });
  expect((await fe.connect()).bind_ok.alias).toBe(`${A}/fe`);
  await fe.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });

  // 4: a live holder: refused, no wait to offer.
  const other = srv.client(alice, null);
  await other.connect();
  const live = await other.bind("fe");
  expect(live).toMatchObject({ type: "error", code: "alias_held", holder: expect.stringContaining(sid) });
  expect(live.retry_after_ms).toBeUndefined();

  // 3: the connection drops; the hold stays through the grace.
  fe.close();
  const feOnline = async () => (await other.call("peer_list", { include_offline: true })).result.peers.find((p: any) => p.handle === `${A}/fe`).online;
  await until(async () => !(await feOnline()));
  const inGrace = await other.bind("fe");
  expect(inGrace).toMatchObject({ code: "alias_held", message: expect.stringContaining("ends by") });
  expect(inGrace.retry_after_ms).toBeGreaterThan(30_000);

  // The same key re-attaches: the hold and the claim are its, and nothing is rebound.
  const back = srv.client(alice, "fe", { key, hello: { resume: true } });
  const ok = await back.connect();
  expect(ok).toMatchObject({ type: "hello_ok", id: sid, bound: [`${A}/fe`] });
  expect(ok.bind_ok).toBeUndefined();
  expect(rows(`SELECT holder FROM claims`)).toEqual([{ holder: `${A}/fe` }]);
  // One refusal row per reason: held live, then held in the grace.
  expect(events("fe").map((e) => e.event)).toEqual(["bound", "refused", "refused"]);
  expect(rows(`SELECT detail FROM access_log WHERE action = 'id.reattached' AND target = ?`, sid)).toEqual([{ detail: expect.stringContaining(`"resume":true`) }]);
}, 20_000);

test("audit 5: a bind whose answer was lost is settled by calling it again: the same name is already bound", async () => {
  const s = await session(null);
  expect(await s.call("bind", { name: "fe", create: true })).toContain(`Bound to "fe"`);
  expect(await s.call("bind", { name: "fe" })).toBe(`already bound to "fe"`);
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

test("audit 15: a holder that can't answer keeps its name: another session's bind is refused, never a takeover", async () => {
  const s = await session("fe");
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fe`);
  const holder = events("fe")[0]!.session_id;
  await whileStopped(s, async () => {
    const t = await session(null);
    expect(await refusal(t, "bind", { name: "fe" })).toContain(`alias_held: "${A}/fe" is in use by the session ${holder}`);
  });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fe`);
  expect(s.stderr()).not.toContain("superseded");
}, 30_000);

test("audit 15: a holder whose server restarts re-attaches within the grace and keeps its name; a bind meanwhile is refused with a wait", async () => {
  // A server restart on the same port and database: the sessions' env still points at it.
  const dbDir = mkdtempSync(join(tmpdir(), "gb-db-"));
  const dbPath = join(dbDir, "gb.db");
  srv.stop();
  srv = new TestServer({ dbPath });
  alice = await srv.login(A);
  const s = await session("fe");
  const holder = events("fe")[0]!.session_id;
  let next: TestServer | undefined;
  try {
    await whileStopped(s, async () => {
      const port = srv.app.server.port!;
      srv.app.stop();
      next = new TestServer({ dbPath, httpPort: port });
      expect(next.base).toBe(srv.base);
      // The restarted server seeds the grace for every unended session.
      const t = await session(null);
      const why = await refusal(t, "bind", { name: "fe" });
      expect(why).toContain(`alias_held: "${A}/fe" is in use by the session ${holder}`);
      expect(why).toContain("ends by");
    });
    // Tool calls fail while it reconnects; then it acts as fe again.
    await until(async () => (await s.call("peer_list", {}).catch(() => null))?.you === `${A}/fe`, 10_000);
    expect(next!.app.db.query(`SELECT event FROM binding_events WHERE name = ? ORDER BY id`).all(`${A}/fe`)).toEqual([{ event: "bound" }, { event: "refused" }]);
  } finally {
    next?.stop();
    rmSync(dbDir, { recursive: true, force: true });
  }
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
    next?.stop();
    rmSync(dbDir, { recursive: true, force: true });
  }
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
    next?.stop();
    rmSync(dbDir, { recursive: true, force: true });
  }
}, 30_000);

test("16, 18: raw binds: create: false, lazy create; a hello needs a key, and an unbound connection reads its user's boards and writes as its ID", async () => {
  await srv.api(alice, "POST", "/api/teams", { name: "eng" });
  const be = srv.client(alice, "be");
  await be.connect();
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  // 16: create: false refuses an unknown name with the closest known ones.
  const refused = await srv.client(alice, "bee", { bind: { create: false } }).connect();
  expect(refused).toMatchObject({ type: "error", code: "identity_unknown", known: ["be"] });
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'bee'`)).toEqual([]);
  // A bind without create creates the name.
  const lazy = srv.client(alice, "lazy");
  expect((await lazy.connect()).bind_ok.alias).toBe(`${A}/lazy`);
  expect(rows(`SELECT 1 FROM aliases WHERE name = 'lazy'`)).toHaveLength(1);

  // A hello with no session_key is refused.
  expect(await srv.client(alice, null, { hello: { session_key: undefined } }).connect()).toMatchObject({ type: "error", code: "bad_request", message: "a hello needs a session_key" });

  // 18: an unbound connection: open boards and its user's team boards.
  const ro = srv.client(alice, null);
  const ok = await ro.connect();
  expect(ok).toMatchObject({ type: "hello_ok", id: ro.id });
  expect(ok.bound).toBeUndefined();
  const boards = (await ro.call("board_list")).result.map((b: any) => b.name);
  expect(boards).toContain("e2e");
  expect(boards).toContain("eng");
  const bobs = srv.client(bob, null);
  await bobs.connect();
  expect((await bobs.call("board_list")).result.map((b: any) => b.name)).not.toContain("eng");
  // It writes as its ID.
  expect((await ro.call("board_post", { board: "e2e", body: "x" })).type).toBe("call_ok");
  expect((await ro.call("claim_take", { key: "k" })).type).toBe("call_ok");
  expect(rows(`SELECT author FROM posts WHERE body = 'x'`)).toEqual([{ author: ro.id }]);
  expect(rows(`SELECT holder FROM claims WHERE key = 'k'`)).toEqual([{ holder: ro.id }]);
}, 20_000);


let rel: ReleaseBinaries;
beforeAll(async () => {
  rel = await releaseBinaries(await latestRelease());
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

// S11: restored_from proves nothing on a server; every one is logged as a
// claim and starts a fresh status.
test("S11: a restored_from naming another of the user's sessions is logged unverified and starts a fresh status", async () => {
  const s = await session("api");
  await s.call("peer_status", { text: "mid-task" });
  await stop(s.c);
  // One of alice's own sessions (a stranger's fails the principal check first).
  const stranger = await sessionId(await session(null));
  const ws = srv.client(alice, "api", { bind: { restored_from: stranger } });
  expect((await ws.connect()).bind_ok.alias).toBe(`${A}/api`);
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restore claimed from ${stranger}, not verified` });
  expect(status(`${A}/api`)).toBeNull();
});

// Audit S5 (#345): a team alias's history shows every member's sessions,
// but a restore never carries another principal's session's status over.
test("S11: a restored_from naming another principal's session is unverified, even when the alias's history shows it", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const theirs = srv.client(bob, "eng/api");
  expect((await theirs.connect()).bind_ok.alias).toBe("eng/api");
  await theirs.call("peer_status", { text: "bob's task" });
  expect((await theirs.request({ type: "end" })).type).toBe("end_ok");
  const mine = srv.client(alice, "eng/api", { bind: { restored_from: theirs.id } });
  expect((await mine.connect()).bind_ok.alias).toBe("eng/api");
  expect(rows(`SELECT detail FROM binding_events WHERE name = 'eng/api' ORDER BY id DESC LIMIT 1`)).toEqual([{ detail: `restore claimed from ${theirs.id}, not verified` }]);
  expect(status("eng/api")).toBeNull();
});

test("#284: a 1.x client's 16-hex restored_from is logged as the same session ID, unverified (S11)", async () => {
  const key = "d5".repeat(32);
  const ws = srv.client(alice, "api", { key });
  expect((await ws.connect()).type).toBe("hello_ok");
  await ws.call("peer_status", { text: "mid-task" });
  expect((await ws.request({ type: "end" })).type).toBe("end_ok");
  expect(events("api").at(-1)!.event).toBe("released");
  // What a 1.x client's name record holds: the key's SHA-256, first 16 hex.
  const hex = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16);
  const next = srv.client(alice, "api", { bind: { restored_from: hex } });
  expect((await next.connect()).type).toBe("hello_ok");
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restore claimed from ${idAddress(key)}, not verified` });
  expect(status(`${A}/api`)).toBeNull();
});

test("#211, S4: a reconnect inside the grace is the same session; past its end, previous_key proves descent and a stray's doesn't", async () => {
  const apiStatus = () => status(`${A}/api`);
  const [mine, theirs] = ["a1".repeat(32), "b1".repeat(32)];
  let ws = srv.client(alice, "api", { key: mine });
  expect((await ws.connect()).type).toBe("hello_ok");
  expect((await ws.call("peer_status", { text: "mid-task" })).type).toBe("call_ok");
  ws.close();
  // A reconnect on its key re-attaches: same ID, still bound, status kept, no rebind.
  ws = srv.client(alice, "api", { key: mine, hello: { resume: true } });
  expect(await ws.connect()).toMatchObject({ type: "hello_ok", id: idAddress(mine), bound: [`${A}/api`] });
  expect(apiStatus()).toBe("mid-task");
  expect(events("api").map((e) => e.event)).toEqual(["bound"]);
  // The session ends (as the grace would end it).
  expect((await ws.request({ type: "end" })).type).toBe("end_ok");
  ws.close();

  // A stray naming a key that isn't an ended session of the alias's: unverified, fresh status.
  ws = srv.client(alice, "api", { bind: { previous_key: theirs } });
  await ws.connect();
  const stray = ws.id;
  expect(events("api").at(-1)!.detail).toBe(`restore after end not verified: ${idAddress(theirs)} isn't an ended session of yours`);
  expect(apiStatus()).toBeNull();
  expect((await ws.request({ type: "end" })).type).toBe("end_ok");
  ws.close();

  // The ended session's own key, after a stray held the name since: not the latest binder.
  const third = "c1".repeat(32);
  ws = srv.client(alice, "api", { key: third, bind: { previous_key: mine } });
  await ws.connect();
  expect(events("api").at(-1)!.detail).toBe(`restored_from ${idAddress(mine)} not verified: latest bound by ${stray}`);
  expect(apiStatus()).toBeNull();
  await ws.call("peer_status", { text: "resumable" });
  expect((await ws.request({ type: "end" })).type).toBe("end_ok");
  ws.close();

  // The latest binder's key: verified, status inherited.
  ws = srv.client(alice, "api", { bind: { previous_key: third } });
  await ws.connect();
  expect(events("api").at(-1)!.detail).toBe(`restored after end of session ${idAddress(third)}`);
  expect(apiStatus()).toBe("resumable");
}, 20_000);


// #284: a session's ID is one principal's. Another user presenting the same
// key is refused, never attached to the session's row; the owner's own
// further hellos and binds are the same session.
test("#284: a key whose ID is another principal's session is refused with id_collision, and audited", async () => {
  const key = "c4".repeat(32);
  const mine = srv.client(alice, "api", { key, hello: { where: "laptop" } });
  expect((await mine.connect()).type).toBe("hello_ok");
  expect(rows(`SELECT id, principal, place FROM ids`)).toEqual([{ id: idAddress(key), principal: A, place: "laptop" }]);
  expect(rows(`SELECT address, id FROM alias_holds`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }]);
  const theirs = srv.client(bob, "api", { key });
  expect(await theirs.connect()).toMatchObject({ type: "error", code: "id_collision", message: expect.stringContaining(idAddress(key)) });
  expect(rows(`SELECT actor, action, target FROM access_log WHERE action = 'id.collision'`)).toEqual([{ actor: "bob@example.com", action: "id.collision", target: idAddress(key) }]);
  expect(rows(`SELECT address FROM alias_holds`)).toEqual([{ address: `${A}/api` }]);
  // The owner's next bind is the same session: one ids row, a second hold.
  expect(await mine.bind("web")).toMatchObject({ type: "bind_ok", alias: `${A}/web` });
  expect(rows(`SELECT id FROM ids`)).toEqual([{ id: idAddress(key) }]);
  expect(rows(`SELECT address, id FROM alias_holds ORDER BY address`)).toEqual([{ address: `${A}/api`, id: idAddress(key) }, { address: `${A}/web`, id: idAddress(key) }]);
  expect((await mine.request({ type: "end" })).type).toBe("end_ok");
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

test("audit 19: a bind or writes_as refused for an invalid or reserved name is refused, and a reserved one logged", async () => {
  const long = `x${"y".repeat(40)}!`;
  expect(await srv.client(alice, long).connect()).toMatchObject({ type: "error", code: "bad_request" });
  expect(await srv.client(alice, "human").connect()).toMatchObject({ type: "error", code: "forbidden" });
  // A tools-only connection can't write as it either.
  expect(await srv.client(alice, "human", { push: false }).connect()).toMatchObject({ type: "error", code: "forbidden" });
  // Both refusals are logged, each under its own session's ID.
  const refused = { session_id: expect.stringMatching(/^id:[0-9a-z]{13}$/), event: "refused", detail: expect.stringContaining("human") };
  const rowsFor = events("human");
  expect(rowsFor).toEqual([refused, refused]);
  expect(rowsFor[0]!.session_id).not.toBe(rowsFor[1]!.session_id);
});


// #284 S7: every agent connection is a session, so a write carries the
// writing session's ID: a tools-only connection's is its own, not the owner's.
test("#284: messages and posts carry the writing session's ID, a tools-only connection's included", async () => {
  const owner = await session("be");
  await owner.call("board_create", { name: "e2e", purpose: "test" });
  const tools = await session("be", { extra: { BUS_PUSH: "off" } });
  for (const [s, tag] of [[owner, "owner"], [tools, "tools"]] as const) {
    await s.call("dm_send", { to: `${A}/be`, body: `dm ${tag}` });
    await s.call("board_post", { board: "e2e", body: `post ${tag}` });
  }
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/be`)[0]!.id;
  const toolsId = rows<{ id: string }>(`SELECT id FROM ids WHERE writes_as = ?`, `${A}/be`)[0]!.id;
  expect(id).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).not.toBe(id);
  expect(rows(`SELECT body, sender, sender_id FROM messages ORDER BY id`)).toEqual([{ body: "dm owner", sender: `${A}/be`, sender_id: id }, { body: "dm tools", sender: `${A}/be`, sender_id: toolsId }]);
  expect(rows(`SELECT body, author, author_id FROM posts ORDER BY id`)).toEqual([{ body: "post owner", author: `${A}/be`, author_id: id }, { body: "post tools", author: `${A}/be`, author_id: toolsId }]);
  // Mail it could never read is refused with its code, in local mode's words (#284 S18).
  expect(await refusal(owner, "dm_send", { to: toolsId, body: "hi" })).toBe(`error: no_delivery: ${toolsId} is a tools-only session and receives nothing; send to ${A}/be`);
}, 20_000);

// #284 audit B12/W5: the lazy alias.created row names the session that
// created it; handle.launcher_set is the session's (its target), and the
// first hello's flag is written once, by registerId.
test("#284: alias.created names the session; handle.launcher_set targets it; the flag is on its ids row", async () => {
  await session("be", { extra: { BUS_LAUNCHER: "1" } });
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, `${A}/be`)[0]!.id;
  expect(rows(`SELECT action, actor, target, detail FROM access_log WHERE action IN ('alias.created', 'handle.launcher_set') ORDER BY id`)).toEqual([
    { action: "handle.launcher_set", actor: A, target: id, detail: JSON.stringify({ on: true }) },
    { action: "alias.created", actor: A, target: `${A}/be`, detail: JSON.stringify({ lazy: true, session: id }) },
  ]);
  expect(rows(`SELECT launcher FROM ids WHERE id = ?`, id)).toEqual([{ launcher: 1 }]);
}, 20_000);

const senderOf = (id: number) => rows<{ sender: string }>(`SELECT sender FROM messages WHERE id = ?`, id)[0]!.sender;

test("#284 S3: as on dm_send names one of the session's addresses; another's is refused with the list", async () => {
  await session("peer");
  const s = await session(null);
  const id = await sessionId(s);
  await s.call("bind", { name: "a", create: true });
  await s.call("bind", { name: "b", create: true });
  await session("c");
  const plain = await s.call("dm_send", { to: "peer", body: "1" });
  expect([senderOf(plain.message_id as number), plain.sent_as]).toEqual([`${A}/a`, undefined]);
  const asB = await s.call("dm_send", { to: "peer", body: "2", as: "b" });
  expect([senderOf(asB.message_id as number), asB.sent_as]).toEqual([`${A}/b`, `${A}/b`]);
  const asId = await s.call("dm_send", { to: "peer", body: "3", as: id });
  expect(senderOf(asId.message_id as number)).toBe(id);
  for (const other of ["zzz", "c"]) {
    expect(await refusal(s, "dm_send", { to: "peer", body: "x", as: other })).toContain(`isn't one of this session's addresses: ${A}/a, ${A}/b, ${id}`);
  }
}, 30_000);

test("#284 S4: a reply goes as the held alias its parent reached or was sent as; else the primary", async () => {
  const peer = await session("peer");
  const s = await session(null);
  const id = await sessionId(s);
  // Mail to the ID before any bind is answered as the alias bound since.
  const toId = await peer.call("dm_send", { to: id, body: "to the id" });
  await s.call("bind", { name: "a", create: true });
  await s.call("bind", { name: "b", create: true });
  expect(senderOf((await s.call("dm_send", { to: "peer", body: "r0", parent_id: toId.message_id })).message_id as number)).toBe(`${A}/a`);

  const toB = await peer.call("dm_send", { to: "b", body: "to b" });
  await until(() => contents(s).includes("to b"));
  const r1 = await s.call("dm_send", { to: "peer", body: "r1", parent_id: toB.message_id });
  expect([senderOf(r1.message_id as number), r1.sent_as]).toEqual([`${A}/b`, `${A}/b`]);
  const r2 = await s.call("dm_send", { to: "peer", body: "r2", parent_id: toB.message_id, as: "a" });
  expect(senderOf(r2.message_id as number)).toBe(`${A}/a`);
  // Its own thread, as its sender.
  expect(senderOf((await s.call("dm_send", { to: "peer", body: "r3", parent_id: r1.message_id })).message_id as number)).toBe(`${A}/b`);

  // b unbound and taken by t: a reply to mail that reached b is refused, not sent as a.
  const toB2 = await peer.call("dm_send", { to: "b", body: "to b again" });
  await until(() => contents(s).includes("to b again"));
  await s.call("unbind", { name: "b" });
  const t = await session(null);
  await t.call("bind", { name: "b" });
  expect(await refusal(s, "dm_send", { to: "peer", body: "x", parent_id: toB2.message_id })).toContain(`parent_id ${toB2.message_id} is not a message you sent or received`);
}, 40_000);

// S14: a team alias sees only its team's boards, while a person alias sees
// every team its user is in. So with eng/x primary, a board of ops (which
// alice is in, eng isn't) acts as the person alias, and its subscription,
// cursor and unread count are that alias's.
test("#284 S14: a board call without as acts as the first address that can see the board", async () => {
  for (const name of ["eng", "ops"]) expect((await srv.api(alice, "POST", "/api/teams", { name })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/ops/add", { email: "bob@example.com" })).status).toBe(200);
  const s = await session(null);
  await s.call("bind", { name: "eng/x", create: true });
  await s.call("bind", { name: "a", create: true });
  expect((await s.call("whoami", {})).primary).toBe("eng/x");
  const sub = (handle: string) => rows<{ mode: string; cursor: number }>(`SELECT mode, cursor FROM subscriptions WHERE board = 'ops' AND handle = ?`, handle);

  await s.call("board_subscribe", { board: "ops", mode: "digest" });
  expect(sub(`${A}/a`)).toMatchObject([{ mode: "digest" }]);
  expect(sub("eng/x")).toEqual([]);
  const bo = await session("bo", { token: bob });
  const posted = await bo.call("board_post", { board: "ops", body: "for ops" });
  const opsRow = async () => ((await s.call("board_list", {})) as { name: string; mode: string | null; unread: number }[]).find((b) => b.name === "ops");
  expect(await opsRow()).toMatchObject({ mode: "digest", unread: 1 });
  expect((await s.call("board_read", { board: "ops" })).posts.map((p: any) => p.body)).toEqual(["for ops"]);
  expect(sub(`${A}/a`)).toMatchObject([{ cursor: posted.post_id }]);
  expect(await opsRow()).toMatchObject({ unread: 0 });
  const reply = await s.call("board_post", { board: "ops", body: "ops reply" });
  expect(rows(`SELECT author FROM posts WHERE id = ?`, reply.post_id)).toEqual([{ author: `${A}/a` }]);
  // eng's board the primary can see: it acts as eng/x.
  const own = await s.call("board_post", { board: "eng", body: "eng post" });
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
  const s = await session(null, { token: bob });
  const id = await sessionId(s);
  await s.call("bind", { name: "eng/x", create: true });
  expect((await s.call("claim_take", { key: "ticket:ENG-7", as: id })).claim).toMatchObject({ holder: id });

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
