// Name binding in server mode (#182): unbound sessions over a read-only
// connection, bind as a new hello, rebind, and what the server records.
// Each numbered comment is the #182 acceptance criterion the test shows.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { serverEnv } from "../support/env.ts";
import { closeSessions, mcpSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
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
const contents = (s: Session) => s.pushes.map((p) => p.content);
// An unbound session's handle is <email>/~<session id>.
const sessionId = async (s: Session) => /\/~([0-9a-f]{16})$/.exec((await s.call("peer_list", {})).you)![1]!;

// A tool call's error text; a call that succeeds fails the test.
async function refusal(s: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await s.c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}

// Every cell in the server's database that contains `value`, as "table.column".
function cellsContaining(value: string): string[] {
  const hits: string[] = [];
  for (const { name: t } of rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)) {
    for (const { name: c } of rows<{ name: string }>(`PRAGMA table_info("${t}")`)) {
      if (srv.app.db.query(`SELECT 1 FROM "${t}" WHERE instr(CAST("${c}" AS TEXT), ?) > 0 LIMIT 1`).get(value)) hits.push(`${t}.${c}`);
    }
  }
  return hits;
}

const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(srv.dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(srv.dir, `go-${point}`), "");

test("1, 3, 14, 18: an unbound session reads without a trace, offers its default with its mail, and binds", async () => {
  const repo = join(srv.dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // "api" existed once and has 3 DMs queued, with no live holder.
  await stop((await session("api")).c);
  const be = await session("be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  const s = await session(null, { cwd: repo });
  expect(s.c.getInstructions()).toStartWith("This session has no bus name yet.");
  expect(s.c.getInstructions()).toContain("Candidates (free now): api (this checkout's default: 3 queued DMs, 0 claims");
  const id = await sessionId(s);

  // Reads work; nothing else does, and nothing records the session.
  expect((await s.call("board_read", { board: "e2e" })).posts.map((p: any) => p.body)).toEqual(["hello"]);
  expect((await s.call("board_list", {})).map((b: any) => b.name)).toContain("e2e");
  expect(await s.call("claim_list", {})).toEqual([]);
  for (const [tool, args] of [["board_post", { board: "e2e", body: "x" }], ["dm_send", { to: "be", body: "x" }], ["claim_take", { key: "k" }], ["dm_inbox", {}]] as const) {
    expect(await refusal(s, tool, args)).toContain("no bus name yet. Call bind(name)");
  }
  expect(cellsContaining(`~${id}`)).toEqual([]);

  // 14: the user's other sessions see it by session ID; another user's don't.
  const seen = (await be.call("peer_list", {})).unbound_sessions;
  expect(seen).toEqual([expect.objectContaining({ session_id: id, unbound: true, online: true })]);
  expect(seen[0].self).toBeUndefined();
  expect((await s.call("peer_list", {})).unbound_sessions).toEqual([expect.objectContaining({ session_id: id, self: true })]);
  expect((await (await session("ops", { token: bob })).call("peer_list", {})).unbound_sessions).toBeUndefined();

  // 3: a new name gets none of api's mail.
  await s.call("bind", { name: "api2", create: true });
  await Bun.sleep(300);
  expect(contents(s)).toEqual([]);

  // 1: binding the name delivers what waited, and a new DM wakes it.
  await s.call("bind", { name: "api" });
  await until(() => contents(s).length === 3);
  expect(contents(s)).toEqual(["one", "two", "three"]);
  await be.call("dm_send", { to: "api", body: "four" });
  await until(() => contents(s).length === 4);

  // 14: bound, it's gone from the list.
  await until(async () => (await be.call("peer_list", {})).unbound_sessions === undefined);
}, 30_000);

test("15: an unbound exit removes its name record; a bound exit keeps it for a restart", async () => {
  const records = join(srv.dir, "home", ".claude-bus");
  const u = await session(null);
  expect(existsSync(join(records, `bind.${u.harnessPid}`))).toBe(true);
  await stop(u.c);
  expect(existsSync(join(records, `bind.${u.harnessPid}`))).toBe(false);
  const b = await session("api");
  await stop(b.c);
  expect(JSON.parse(readFileSync(join(records, `bind.${b.harnessPid}`), "utf8")).name).toBe("api");
}, 30_000);

test("2, 13: a second session on a held explicit name starts unbound and names the holder; the holder keeps its mail", async () => {
  const first = await session("fe");
  const firstId = events("fe")[0]!.session_id;
  const second = await session("fe");
  expect(second.c.getInstructions()).toContain(`BUS_IDENTITY asked for "fe", but the live session ${firstId}, in `);
  expect((await second.call("peer_list", {})).peers).toEqual(expect.arrayContaining([expect.objectContaining({ handle: `${A}/fe`, online: true })]));
  const be = await session("be");
  await be.call("dm_send", { to: "fe", body: "to the holder" });
  await until(() => contents(first).length === 1);
  expect(contents(second)).toEqual([]);
  const ev = events("fe");
  expect(ev.map((e) => e.event)).toEqual(["bound", "refused"]);
  expect(ev[1]!.detail).toStartWith(`the live session ${firstId}`);
  expect(ev[1]!.session_id).not.toBe(firstId);
}, 20_000);

test("4, 13: a never-seen name needs create; the refusal lists the closest names", async () => {
  await stop((await session("fe")).c);
  const s = await session(null);
  const err = await refusal(s, "bind", { name: "fee" });
  expect(err).toContain(`no name "fee" has ever been used; closest: fe.`);
  expect(events("fee")).toEqual([{ session_id: await sessionId(s), event: "refused", detail: expect.stringContaining("closest: fe") }]);
  // The refusal created nothing; create: true does.
  expect(rows(`SELECT 1 FROM identities WHERE name = 'fee'`)).toEqual([]);
  await s.call("bind", { name: "fee", create: true });
  expect((await s.call("peer_list", {})).you).toBe(`${A}/fee`);
}, 20_000);

test("8, 13: a rebind moves claims, frees the old name, and delivers the new name's mail", async () => {
  const s = await session("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  await be.call("dm_send", { to: "fe", body: "warmup" });
  await until(() => contents(s).length === 1);
  // fe2 exists (it was used once), with a DM queued before the bind.
  await stop((await session("fe2")).c);
  await be.call("dm_send", { to: "fe2", body: "queued for fe2" });

  const result = await s.call("bind", { name: "fe2" });
  expect(result).toContain(`Bound to "fe2" (was "fe")`);
  expect(result).toContain(`Your claims moved from "fe" to "fe2": ticket:ENG-142.`);
  await until(() => contents(s).includes("queued for fe2"));
  expect((await s.call("claim_list", {})).map((c: any) => c.holder)).toEqual([`${A}/fe2`]);
  expect(rows(`SELECT handle, event FROM claim_events WHERE key = 'ticket:ENG-142' AND event = 'moved'`)).toEqual([{ handle: `${A}/fe2`, event: "moved" }]);
  expect(await s.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");
  expect(await s.call("claim_list", {})).toEqual([]);

  const sid = events("fe")[0]!.session_id;
  expect(events("fe")).toEqual([
    { session_id: sid, event: "bound", detail: null },
    { session_id: sid, event: "released", detail: `rebound to ${A}/fe2` },
  ]);
  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "moved"]);
  expect(events("fe2").at(-1)).toEqual({ session_id: sid, event: "moved", detail: `${A}/fe` });

  const other = await session(null);
  await other.call("bind", { name: "fe" });
  expect((await other.call("peer_list", {})).you).toBe(`${A}/fe`);
  // A clean exit logs its release once.
  await stop(other.c);
  await until(() => events("fe").at(-1)!.event === "released");
  expect(events("fe").filter((e) => e.event === "released")).toHaveLength(2);
}, 30_000);

test("9: a DM sent mid-swap is never consumed under the new name, and the old connection stays gone", async () => {
  const s = await session("fe", { extra: pauseEnv("bind:after-acquire") });
  const be = await session("be");
  const binding = s.c.callTool({ name: "bind", arguments: { name: "fe2", create: true } });
  await until(() => s.stderr().includes("test pause hit: bind:after-acquire"));
  await be.call("dm_send", { to: "fe", body: "mid-swap" });
  release("bind:after-acquire");
  expect((await binding).isError).toBeFalsy();
  await Bun.sleep(300);
  // The old connection didn't reconnect and take fe back.
  const fe = (await be.call("peer_list", { include_offline: true })).peers.find((p: any) => p.handle === `${A}/fe`);
  expect(fe.online).toBe(false);
  // Delivered as fe before the swap, or left for fe; never read as fe2.
  if (!contents(s).includes("mid-swap")) {
    const next = await session(null);
    await next.call("bind", { name: "fe" });
    await until(() => contents(next).includes("mid-swap"));
  }
}, 30_000);

test("16, 18: raw hellos: create: false, lazy create, and a read-only connection's limits", async () => {
  await srv.api(alice, "POST", "/api/teams", { name: "eng" });
  const be = srv.client(alice, "be");
  await be.connect();
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  // 16: create: false refuses an unknown name with the closest known ones.
  const refused = await srv.client(alice, "bee", { hello: { create: false } }).connect();
  expect(refused).toMatchObject({ type: "error", code: "identity_unknown", known: ["be"] });
  expect(rows(`SELECT 1 FROM identities WHERE name = 'bee'`)).toEqual([]);
  // An old client's hello (no create) still creates the name.
  const lazy = srv.client(alice, "lazy");
  expect((await lazy.connect()).type).toBe("hello_ok");
  expect(rows(`SELECT 1 FROM identities WHERE name = 'lazy'`)).toHaveLength(1);
  // Candidates leave out live names.
  expect((await srv.client(alice, null).connect()).candidates).toEqual([]);
  lazy.close();

  // A read-only hello must not name an identity.
  expect(await srv.client(alice, "be", { push: false, hello: { read_only: true } }).connect()).toMatchObject({ type: "error", code: "bad_request" });

  // 18: a read-only connection: open boards and its user's team boards.
  let ro = srv.client(alice, null, { hello: { session_id: "0123456789abcdef" } });
  // Once lazy's close lands, it's a candidate.
  await until(async () => {
    ro = srv.client(alice, null, { hello: { session_id: "0123456789abcdef" } });
    const ok = await ro.connect();
    expect(ok).toMatchObject({ type: "hello_ok", identity_full: `${A}/~0123456789abcdef` });
    return ok.candidates.length === 1 && ok.candidates[0].name === "lazy";
  });
  const boards = (await ro.call("board_list")).result.map((b: any) => b.name);
  expect(boards).toContain("e2e");
  expect(boards).toContain("eng");
  const bobs = srv.client(bob, null);
  await bobs.connect();
  expect((await bobs.call("board_list")).result.map((b: any) => b.name)).not.toContain("eng");

  for (const r of [
    await ro.call("board_post", { board: "e2e", body: "x" }),
    await ro.call("claim_take", { key: "k" }),
    await ro.request({ type: "send", recipient: "be", body: "x" }),
    await ro.request({ type: "board_ack", refs: [] }),
  ]) expect(r).toMatchObject({ type: "error", code: "unbound" });
  expect(cellsContaining("~0123456789abcdef")).toEqual([]);
  // A hello with no session_id (an old client) gets one minted.
  expect((await srv.client(alice, null).connect()).identity_full).toMatch(new RegExp(`^${A}/~[0-9a-f]{16}$`));
}, 20_000);

let rel: ReleaseBinaries;
beforeAll(async () => {
  rel = await releaseBinaries(await latestRelease());
}, 120_000);

test("18: against a server without read-only hellos, unbound reads are unavailable and the session keeps running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-oldsrv-"));
  const old = await ServerProcess.start(rel.server, join(dir, "bus.db"));
  try {
    const token = await old.login(A);
    const s = await mcpSession({ env: serverEnv(dir, old.base, token, null), cwd: dir, args: ["mcp", "--mode", "server"] });
    expect(s.c.getInstructions()).toContain("predates unbound sessions");
    expect(await refusal(s, "board_read", { board: "e2e" })).toContain("predates unbound sessions");
    expect(await refusal(s, "peer_list")).toContain("predates unbound sessions");
    // Binding still works there, and the session reads once bound.
    await s.call("bind", { name: "fe", create: true });
    expect((await s.call("peer_list", {})).you).toBe(`${A}/fe`);
  } finally {
    await closeSessions();
    await old.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("11: a restart under the same harness takes its name back; a fresh harness starts unbound", async () => {
  // The record outranks an explicit BUS_IDENTITY: the restart is the same session, mid-task.
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const peer = await session("fe");
  for (const how of ["reconnect", "crash"] as const) {
    const before = events("api").at(-1)!.session_id;
    s = await s.restart(how);
    expect(s.c.getInstructions()).toStartWith(`You are identity "api"`);
    expect((await s.call("peer_list", {})).you).toBe(`${A}/api`);
    const last = events("api").at(-1)!;
    expect(last).toEqual({ session_id: expect.not.stringMatching(before), event: "bound", detail: `restored: restart of session ${before}` });
    // The same session to its peers: its status stays, and its mail arrives.
    expect((await peer.call("peer_list", {})).peers).toContainEqual(expect.objectContaining({ handle: `${A}/api`, status: "mid-task" }));
    await peer.call("dm_send", { to: "api", body: how });
    await until(() => contents(s).includes(how));
  }

  // A new harness process is a new session: unbound.
  await stop(s.c);
  const fresh = await session(null);
  expect(fresh.c.getInstructions()).toStartWith("This session has no bus name yet.");
  expect(fresh.c.getInstructions()).not.toContain("restarted");
}, 60_000);

test("13 (decision 13): `grayboard tools` prints what the session serves; bind's result carries its name and instructions", async () => {
  const s = await session(null);
  const printed = await runCli(["tools", "--json"], { cwd: srv.dir, env: serverEnv(srv.dir, srv.base, alice, null) });
  expect(printed.code).toBe(0);
  expect(JSON.parse(printed.out)).toEqual((await s.c.listTools()).tools);
  const r = await s.c.callTool({ name: "bind", arguments: { name: "api", create: true } });
  expect(r.structuredContent).toEqual({ name: "api", instructions: expect.any(Array) });
  expect((r.structuredContent as { instructions: string[] }).instructions[0]).toStartWith(`You are identity "api"`);
}, 20_000);
