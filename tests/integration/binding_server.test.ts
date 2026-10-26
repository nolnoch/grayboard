// Name binding in server mode (#182, as #284 PR 3 reshaped it): a session
// is its hello and acts as its ID until it binds, a bind is a frame on its
// one connection, a rebind leaves claims behind, and what the server records.
// Each numbered title is the #182 acceptance criterion the test shows.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { serverEnv } from "../support/env.ts";
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
  expect(JSON.parse(readFileSync(join(records, `bind.${b.harnessPid}`), "utf8")).name).toBe(`${A}/api`);
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

test("8, 13: a rebind leaves its claims with the old name, frees it, and delivers the new name's mail", async () => {
  const s = await session("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  await be.call("dm_send", { to: "fe", body: "warmup" });
  await until(() => contents(s).length === 1);
  // fe2 exists (it was used once), with a DM queued before the bind.
  await stop((await session("fe2")).c);
  await be.call("dm_send", { to: "fe2", body: "queued for fe2" });

  // #284 S6: claims stay with the name they were taken under.
  const result = await s.call("bind", { name: "fe2" });
  expect(result).toContain(`Bound to "fe2" (was "fe")`);
  expect(result).toContain(`Claims stay with the name they were taken under; these are now "fe"'s next holder's: ticket:ENG-142.`);
  await until(() => contents(s).includes("queued for fe2"));
  expect((await s.call("claim_list", {})).map((c: any) => c.holder)).toEqual([`${A}/fe`]);
  expect(rows(`SELECT 1 FROM claim_events WHERE key = 'ticket:ENG-142' AND event = 'moved'`)).toEqual([]);
  expect(await refusal(s, "claim_release", { key: "ticket:ENG-142" })).toContain(`${A}/fe`);

  const sid = events("fe")[0]!.session_id;
  expect(events("fe")).toEqual([
    { session_id: sid, event: "bound", detail: null },
    { session_id: sid, event: "released", detail: `rebound to ${A}/fe2` },
  ]);
  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "moved"]);
  expect(events("fe2").at(-1)).toEqual({ session_id: sid, event: "moved", detail: `${A}/fe` });

  // fe's next holder has its claim.
  const other = await session(null);
  await other.call("bind", { name: "fe" });
  expect((await other.call("peer_list", {})).you).toBe(`${A}/fe`);
  expect(await other.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");
  // A clean exit logs its release once.
  await stop(other.c);
  await until(() => events("fe").at(-1)!.event === "released");
  expect(events("fe").filter((e) => e.event === "released")).toHaveLength(2);
}, 30_000);

test("9: a DM sent mid-swap is never consumed under the new name", async () => {
  const s = await session("fe", { extra: pauseEnv("bind:after-acquire") });
  const be = await session("be");
  const binding = s.c.callTool({ name: "bind", arguments: { name: "fe2", create: true } });
  await until(() => s.stderr().includes("test pause hit: bind:after-acquire"));
  // The server has moved the hold: fe has no holder now.
  await be.call("dm_send", { to: "fe", body: "mid-swap" });
  release("bind:after-acquire");
  expect((await binding).isError).toBeFalsy();
  const fe = (await be.call("peer_list", { include_offline: true })).peers.find((p: any) => p.handle === `${A}/fe`);
  expect(fe.online).toBe(false);
  // Left for fe; never read as fe2.
  await be.call("dm_send", { to: "fe2", body: "barrier" });
  await until(() => contents(s).includes("barrier"));
  expect(contents(s)).not.toContain("mid-swap");
  const next = await session(null);
  await next.call("bind", { name: "fe" });
  await until(() => contents(next).includes("mid-swap"));
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

test("audit 2: a channels-off session holds its name: never online, and its rebind leaves its claims", async () => {
  const s = await channelsOffSession("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  expect(await refusal(await channelsOffSession(null), "bind", { name: "fe" })).toContain("alias_held");
  expect(await refusal(await session(null), "bind", { name: "fe" })).toContain("alias_held");
  // It holds the name without taking pushes: not online, and DMs wait.
  const fe = () => be.call("peer_list", { include_offline: true }).then((r) => r.peers.find((p: any) => p.handle === `${A}/fe`));
  expect((await fe()).online).toBe(false);

  const result = await s.call("bind", { name: "fe2", create: true });
  expect(result).toContain(`these are now "fe"'s next holder's: ticket:ENG-142.`);
  expect((await be.call("claim_list", {})).map((c: any) => c.holder)).toEqual([`${A}/fe`]);
  const sid = events("fe")[0]!.session_id;
  expect(events("fe").map((e) => e.event)).toEqual(["bound", "refused", "refused", "released"]);
  expect(events("fe").at(-1)).toEqual({ session_id: sid, event: "released", detail: `rebound to ${A}/fe2` });
  expect(events("fe2")).toEqual([{ session_id: sid, event: "moved", detail: `${A}/fe` }]);
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
  expect(ok).toMatchObject({ type: "hello_ok", id: sid, bound: `${A}/fe` });
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

test("audit 11: a call issued during a bind waits for it, and runs as the new name", async () => {
  const s = await session("old", { extra: pauseEnv("bind:after-acquire") });
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
  expect(JSON.parse(texts[0]!).you).toBe(`${A}/fe`);
  expect(texts.slice(1).join(" ")).toContain(`bind("fe") completed after it was cancelled. Bound to "fe" (was "old")`);
  expect((r.structuredContent as any).instructions[0]).toBe(`You are identity "fe" on the grayboard bus, which coordinates between agents.`);
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
    expect(await refusal(t, "bind", { name: "fe" })).toContain(`alias_held: "${A}/fe" is held by the session ${holder}`);
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
      expect(why).toContain(`alias_held: "${A}/fe" is held by the session ${holder}`);
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

test("11: a restart under the same harness takes its name back, or restores it once a crashed predecessor's grace ends; a fresh harness starts unbound", async () => {
  // The record outranks an explicit BUS_IDENTITY: the restart is the same session, mid-task.
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const peer = await session("fe");
  // A clean restart (/mcp reconnect): the old session ended, so the name is free.
  const before = events("api").at(-1)!.session_id;
  s = await s.restart("reconnect");
  expect(s.c.getInstructions()).toStartWith(`You are identity "api"`);
  expect((await s.call("peer_list", {})).you).toBe(`${A}/api`);
  const last = events("api").at(-1)!;
  expect(last).toEqual({ session_id: expect.not.stringMatching(before), event: "bound", detail: `restored: restart of session ${before}` });
  // The same session to its peers: its status stays, and its mail arrives.
  expect((await peer.call("peer_list", {})).peers).toContainEqual(expect.objectContaining({ handle: `${A}/api`, status: "mid-task" }));
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
  expect(events("api").at(-1)).toEqual({ session_id: after, event: "bound", detail: `restored: restart of session ${before}` });
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
  expect(events("api").at(-1)).toEqual({ session_id: after, event: "bound", detail: `restored: restart of session ${before}` });
  expect(s.stderr()).not.toContain(`didn't restore`);
}, 30_000);

test("#211: a restored_from the name's history doesn't show is logged unverified and starts a fresh status", async () => {
  const s = await session("api");
  await s.call("peer_status", { text: "mid-task" });
  const prior = events("api").at(-1)!.session_id;
  await stop(s.c);
  // One of alice's own sessions (a stranger's fails the principal check first).
  const stranger = await sessionId(await session(null));
  const ws = srv.client(alice, "api", { bind: { restored_from: stranger } });
  expect((await ws.connect()).bind_ok.alias).toBe(`${A}/api`);
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored_from ${stranger} not verified: latest bound by ${prior}` });
  expect(status(`${A}/api`)).toBeNull();
});

// Audit S5 (#345): a team alias's history shows every member's sessions,
// but a restore never carries another principal's session's status over.
test("#211: a restored_from naming another principal's session is unverified, even when the alias's history shows it", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const theirs = srv.client(bob, "eng/api");
  expect((await theirs.connect()).bind_ok.alias).toBe("eng/api");
  await theirs.call("peer_status", { text: "bob's task" });
  expect((await theirs.request({ type: "end" })).type).toBe("end_ok");
  const mine = srv.client(alice, "eng/api", { bind: { restored_from: theirs.id } });
  expect((await mine.connect()).bind_ok.alias).toBe("eng/api");
  expect(rows(`SELECT detail FROM binding_events WHERE name = 'eng/api' ORDER BY id DESC LIMIT 1`)).toEqual([{ detail: `restore not verified: ${theirs.id} isn't a session of yours` }]);
  expect(status("eng/api")).toBeNull();
});

test("#284: a 1.x client's 16-hex restored_from is the same session ID: its restore verifies", async () => {
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
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored: restart of session ${idAddress(key)}` });
  expect(status(`${A}/api`)).toBe("mid-task");
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
  expect(await ws.connect()).toMatchObject({ type: "hello_ok", id: idAddress(mine), bound: `${A}/api` });
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
// further hellos (a reconnect, a rebind) are the same session.
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
  // The owner's rebind is the same session: one ids row, the hold moves.
  expect(await mine.bind("web")).toMatchObject({ type: "bind_ok", alias: `${A}/web` });
  expect(rows(`SELECT id FROM ids`)).toEqual([{ id: idAddress(key) }]);
  expect(rows(`SELECT address FROM alias_holds`)).toEqual([{ address: `${A}/web` }]);
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
