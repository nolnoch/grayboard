// Name binding over real local-mode processes (#182): unbound start, bind,
// rebind, the races the bindings row settles, and what's left after exit.
// Each numbered comment is the #182 acceptance criterion the test shows.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { CLI } from "../support/paths.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { sigkill } from "../support/procs.ts";
import { until } from "../support/until.ts";
import { crockford13 } from "../../src/core/session_id.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-bind-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const session = (identity?: string, o: { cwd?: string; extra?: Record<string, string> } = {}): Promise<Session> =>
  localSession(dir, identity, { cwd: o.cwd, extra: o.extra });

// The bus file, read beside the sessions (WAL: readers don't block them).
function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

const events = (name: string) => rows<{ session_id: string; event: string; detail: string | null }>(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id`, name);
const contents = (s: Session) => s.pushes.map((p) => p.content);
// An unbound session's own row in peer_list's unbound_sessions.
const sessionId = async (s: Session): Promise<string> => (((await s.call("peer_list", {})).unbound_sessions as { session_id: string; self?: true }[]).find((u) => u.self)!.session_id);
const pidOf = (name: string) => rows<{ pid: number }>(`SELECT b.pid FROM bindings b JOIN alias_holds h ON h.id = b.session_id WHERE h.address = ?`, name)[0]!.pid;
// The session holding `name`, and its status (#284: status is the session's).
const holderOf = (name: string) => rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, name)[0]?.id;
const statusOf = (name: string) => rows<{ status: string | null }>(`SELECT i.status FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ?`, name)[0]!.status;

// A tool call's error text; a call that succeeds fails the test.
async function refusal(s: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await s.c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}

// Every cell in the bus that equals `value`, as "table.column".
function cellsEqual(value: string): string[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    const hits: string[] = [];
    for (const { name: t } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]) {
      for (const { name: c } of db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]) {
        if (db.prepare(`SELECT 1 FROM "${t}" WHERE "${c}" = ? LIMIT 1`).get(value)) hits.push(`${t}.${c}`);
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

// A CLI process whose stderr is read as it runs, for a test pause.
function spawnCli(args: string[], extra: Record<string, string>) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: localEnv(dir, undefined, extra), stdout: "pipe", stderr: "pipe" });
  let err = "";
  (async () => {
    for await (const chunk of p.stderr) err += new TextDecoder().decode(chunk);
  })();
  return { p, stderr: () => err };
}

const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(dir, `go-${point}`), "");

test("1, 3, 14, 18: an unbound session acts as its ID, offers its default with its mail, and binds", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // "api" existed once and has 3 DMs queued, with no live holder.
  await stop((await session("api")).c);
  const be = await session("be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  const s = await session(undefined, { cwd: repo });
  const id = await sessionId(s);
  expect(id).toMatch(/^id:[0-9abcdefghjkmnpqrstvwxyz]{13}$/);
  // #284 S13: it acts as its ID, told so in one line beside the usual text.
  expect(s.c.getInstructions()).toStartWith(`You are identity "${id}" on the grayboard bus`);
  expect(s.c.getInstructions()).toContain(`This session has no bus name yet, so it acts as its ID: peers reach it at ${id}`);
  expect(s.c.getInstructions()).toContain("Candidates (free now): api (this checkout's default: 3 queued DMs, 0 claims");

  // Reads work as before, and nothing is recorded under a "~" handle.
  expect((await s.call("board_read", { board: "e2e" })).posts.map((p: any) => p.body)).toEqual(["hello"]);
  expect((await s.call("board_list", {})).map((b: any) => b.name)).toContain("e2e");
  expect(await s.call("claim_list", {})).toEqual([]);
  expect(await s.call("dm_inbox", {})).toEqual({ unanswered: [] });
  expect(cellsEqual(`~${id}`)).toEqual([]);

  // 14: peers see it by session ID, unbound.
  const seen = (await be.call("peer_list", {})).unbound_sessions;
  expect(seen).toEqual([expect.objectContaining({ session_id: id, unbound: true, online: true })]);
  expect(seen[0].self).toBeUndefined();
  expect((await s.call("peer_list", {})).unbound_sessions).toEqual([expect.objectContaining({ session_id: id, self: true })]);

  // 3: a new name gets none of api's mail, and api's mail stays unread.
  await s.call("bind", { name: "api2", create: true });
  // Barrier: the bind's drain under api2 runs before this DM's, so api's mail,
  // if wrongly delivered, would arrive first.
  await be.call("dm_send", { to: "api2", body: "probe" });
  await until(() => contents(s).length > 0);
  expect(contents(s)).toEqual(["probe"]);
  s.pushes.splice(0);
  expect(rows(`SELECT 1 FROM cursors WHERE reader = 'api'`)).toEqual([]);

  // 1: binding the name delivers what waited, and a new DM wakes it.
  await s.call("bind", { name: "api" });
  await until(() => contents(s).length === 3);
  expect(contents(s)).toEqual(["one", "two", "three"]);
  await be.call("dm_send", { to: "api", body: "four" });
  await until(() => contents(s).length === 4);

  // 14: once it exits, it's gone from the list.
  await stop(s.c);
  expect((await be.call("peer_list", {})).unbound_sessions).toBeUndefined();
}, 30_000);

test("2: a second session on a held explicit name starts unbound and names the holder; the holder keeps its mail", async () => {
  const first = await session("fe");
  const second = await session("fe");
  expect(second.c.getInstructions()).toContain(`BUS_IDENTITY asked for "fe", but the live session `);
  expect((await second.call("peer_list", {})).peers).toEqual([expect.objectContaining({ handle: "fe", online: true })]);
  const be = await session("be");
  await be.call("dm_send", { to: "fe", body: "to the holder" });
  await until(() => contents(first).length === 1);
  expect(contents(second)).toEqual([]);
}, 20_000);

test("2: a Slack-bridge child on a held human name still exits", async () => {
  expect((await runCli(["human", "alex"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
  await session("alex", { extra: { BUS_HUMAN: "1" } });
  const r = await runCli(["mcp", "--mode", "local"], { cwd: dir, env: localEnv(dir, "alex", { BUS_HUMAN: "1" }), holdStdin: true, timeoutMs: 5000 });
  expect(r.code).toBe(1);
  expect(r.err).toContain(`"alex" is in use by the live session`);
}, 20_000);

test("#363: the human's session binds nothing", async () => {
  expect((await runCli(["human", "alex"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
  const h = await session("alex", { extra: { BUS_HUMAN: "1" } });
  expect(await refusal(h, "bind", { name: "fe", create: true })).toBe(`error: this is the human's session ("alex", BUS_HUMAN=1); it binds nothing`);
  expect(rows(`SELECT address FROM alias_holds`)).toEqual([{ address: "alex" }]);
  expect(rows(`SELECT 1 FROM aliases WHERE address = 'fe'`)).toEqual([]);
}, 20_000);

test("4: a never-seen name needs create; the refusal lists the closest names", async () => {
  await stop((await session("fe")).c);
  const s = await session();
  const err = await refusal(s, "bind", { name: "fee" });
  expect(err).toContain(`no name "fee" has ever been used; closest: fe.`);
  expect(events("fee")).toEqual([{ session_id: await sessionId(s), event: "refused", detail: expect.stringContaining("closest: fe") }]);
}, 20_000);

test("audit 20: a scoped name is refused locally: local mode has one scope", async () => {
  const s = await session();
  for (const name of ["eng/x", "you@example.com/x"]) {
    expect(await refusal(s, "bind", { name, create: true })).toContain(`local mode has one scope; bind a bare name, not "${name}"`);
  }
}, 20_000);

test("5, 13: of N concurrent binders exactly one wins; the losers name it and leave its socket alone (#80)", async () => {
  const n = 6;
  const all = await Promise.all(Array.from({ length: n }, () => session()));
  const results = await Promise.all(all.map((s) => s.c.callTool({ name: "bind", arguments: { name: "fe", create: true } })));
  const winners = all.filter((_, i) => !results[i]!.isError);
  expect(winners).toHaveLength(1);
  const winnerId = holderOf("fe")!;
  for (const r of results.filter((r) => r.isError)) {
    expect((r.content as { text: string }[])[0]!.text).toContain(`"fe" is in use by the live session ${winnerId}`);
  }
  expect(existsSync(join(dir, "sock.fe"))).toBe(true);
  const be = await session("be");
  expect((await be.call("dm_send", { to: "fe", body: "to the winner" })).delivered_now).toBe(true);
  await until(() => contents(winners[0]!).length === 1);
  const ev = events("fe");
  expect(ev.filter((e) => e.event === "bound")).toEqual([{ session_id: winnerId, event: "bound", detail: null }]);
  expect(ev.filter((e) => e.event === "refused")).toHaveLength(n - 1);
  for (const e of ev.filter((e) => e.event === "refused")) expect(e.detail).toContain(winnerId);
}, 30_000);

test("6: a holder whose event loop is stopped keeps its name", async () => {
  await session("fe");
  const pid = pidOf("fe");
  process.kill(pid, "SIGSTOP");
  try {
    const s = await session();
    expect(await refusal(s, "bind", { name: "fe" })).toContain(`"fe" is in use by the live session`);
  } finally {
    process.kill(pid, "SIGCONT");
  }
}, 20_000);

let rel: ReleaseBinaries;
beforeAll(async () => {
  rel = await releaseBinaries(await latestRelease());
}, 120_000);

test("7: a pre-upgrade session holding a name by socket alone keeps it", async () => {
  await localSession(dir, "fe", { bin: rel.cli });
  const s = await session();
  expect(holderOf("fe")).toBeUndefined();
  expect(await refusal(s, "bind", { name: "fe" })).toContain("a live session from an older grayboard");
  expect(s.c.getInstructions()).not.toContain("fe (");
}, 30_000);

test("7: a dead holder's row doesn't hide a pre-upgrade session listening on the name since", async () => {
  // s starts first: its startup reaps dead rows, and the row must still be there at its bind.
  const s = await session();
  await session("fe");
  await sigkill(pidOf("fe"));
  await localSession(dir, "fe", { bin: rel.cli });
  expect(holderOf("fe")).toBeDefined();
  expect(await refusal(s, "bind", { name: "fe" })).toContain("a live session from an older grayboard");
  expect(holderOf("fe")).toBeUndefined();
}, 30_000);

test("8: a bind whose setup fails after the acquire leaves the session holding the new name, and says so", async () => {
  const s = await session("fe");
  // The wakeup socket can't be renamed onto a non-empty directory.
  mkdirSync(join(dir, "sock.fe2", "x"), { recursive: true });
  const err = await refusal(s, "bind", { name: "fe2", create: true });
  expect(err).toContain('bound "fe2", but setting it up failed');
  expect(rows(`SELECT address FROM alias_holds WHERE address LIKE 'fe%' ORDER BY bound_at`)).toEqual([{ address: "fe" }, { address: "fe2" }]);
  expect(await s.call("bind", { name: "fe2" })).toContain('already bound to "fe2"');
  // fe's socket is untouched: the failure was fe2's alone.
  expect(existsSync(join(dir, "sock.fe"))).toBe(true);
  expect(readdirSync(dir).filter((f) => f.startsWith(".w"))).toEqual([]);
}, 30_000);

// The session's own rows in peer_list, as [handle, online].
const ownRows = async (s: Session) =>
  ((await s.call("peer_list", {})).peers as { handle: string; online: boolean; self?: true }[]).filter((p) => p.self).map((p) => [p.handle, p.online]).sort();

test("#284 S1, S2: bind adds a hold; unbind releases one, its claims and mail staying with it", async () => {
  const s = await session("fe");
  const be = await session("be");
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 60 });
  // fe2 exists (it was used once), with a DM queued before the bind.
  await stop((await session("fe2")).c);
  await be.call("dm_send", { to: "fe2", body: "queued for fe2" });

  const result = await s.call("bind", { name: "fe2" });
  expect(result).toStartWith(`Bound to "fe2"; you hold "fe", "fe2" and send as "fe".`);
  expect(result).toContain(`You are identity "fe" on the grayboard bus, which coordinates between agents. You also hold "fe2"; you send as "fe" unless a call passes as, and a reply goes as the alias its message reached.`);
  // Both names' mail reaches it: fe2's queued DM and a new one to fe.
  await until(() => contents(s).includes("queued for fe2"));
  await be.call("dm_send", { to: "fe", body: "to fe" });
  await until(() => contents(s).includes("to fe"));
  const id = holderOf("fe")!;
  expect(rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at`, id)).toEqual([{ address: "fe" }, { address: "fe2" }]);
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "bound"]);
  expect(rows(`SELECT COUNT(*) AS n FROM binding_events WHERE event = 'moved'`)).toEqual([{ n: 0 }]);
  // The 1.x mirror holds the primary only.
  expect(rows(`SELECT name FROM bindings WHERE session_id = ?`, id)).toEqual([{ name: "fe" }]);
  const peers = await s.call("peer_list", {});
  expect(peers.you).toBe("fe");
  expect(await ownRows(s)).toEqual([["fe", true], ["fe2", true]]);

  // Unbinding the primary promotes the next oldest hold.
  const u = await s.call("unbind", { name: "fe" });
  expect(u).toStartWith(`Released "fe"; mail to it queues for its next holder.`);
  // #284 S6: claims stay with the address they were taken under.
  expect(u).toContain(`Claims stay with the name they were taken under; these are now "fe"'s next holder's: ticket:ENG-142.`);
  expect(u).toContain(`You now send as "fe2".`);
  expect(events("fe").at(-1)).toMatchObject({ session_id: id, event: "released", detail: "unbind" });
  expect(rows(`SELECT address FROM alias_holds WHERE id = ?`, id)).toEqual([{ address: "fe2" }]);
  expect(rows(`SELECT name FROM bindings WHERE session_id = ?`, id)).toEqual([{ name: "fe2" }]);
  expect(existsSync(join(dir, "sock.fe"))).toBe(false);
  expect((await s.call("peer_list", {})).you).toBe("fe2");
  expect((await s.call("claim_list", {})).map((c: any) => c.holder)).toEqual(["fe"]);
  expect(await refusal(s, "claim_release", { key: "ticket:ENG-142" })).toContain('"ticket:ENG-142" is held by fe, not you');
  expect(await be.call("dm_send", { to: "fe", body: "after unbind" })).toMatchObject({ delivered_now: false });
  // Idempotent: a name it doesn't hold is already released.
  expect(await s.call("unbind", { name: "fe" })).toBe(`not holding "fe"`);
  expect(events("fe").filter((e) => e.event === "released")).toHaveLength(1);

  // fe's next holder gets its mail and its claim.
  const other = await session();
  await other.call("bind", { name: "fe" });
  await until(() => contents(other).includes("after unbind"));
  expect(contents(s)).not.toContain("after unbind");
  expect(await other.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");

  // Unbinding the last hold leaves the session acting as its ID.
  const last = await s.c.callTool({ name: "unbind", arguments: { name: "fe2" } });
  expect((last.content as { text: string }[])[0]!.text).toContain(`You now send as "${id}".`);
  expect((last.structuredContent as { name: string; instructions: string[] })).toEqual({ name: id, instructions: expect.arrayContaining([expect.stringContaining("This session has no bus name yet, so it acts as its ID")]) });
  expect((await s.call("peer_list", {})).you).toBe(id);
  expect(rows(`SELECT name FROM bindings WHERE session_id = ?`, id)).toEqual([{ name: null }]);
  expect(JSON.parse(readFileSync(join(dir, `bind.${s.harnessPid}`), "utf8")).names).toEqual([]);
}, 40_000);

test("#284 S1: the primary is the oldest hold; a ninth hold is refused", async () => {
  const s = await session();
  for (const n of ["zed", "alpha", "c", "d", "e", "f", "g", "h"]) await s.call("bind", { name: n, create: true });
  expect((await s.call("peer_list", {})).you).toBe("zed");
  const err = await refusal(s, "bind", { name: "i", create: true });
  expect(err).toBe(`error: this session already holds 8 names (zed, alpha, c, d, e, f, g, h); unbind one first`);
  expect(rows(`SELECT 1 FROM alias_holds WHERE address = 'i'`)).toEqual([]);
}, 40_000);

test("#284 S2: unbind is refused for a scoped name, a tools-only process and the human", async () => {
  const s = await session("fe");
  expect(await refusal(s, "unbind", { name: "eng/x" })).toContain(`local mode has one scope; unbind a bare name, not "eng/x"`);
  const tools = await session("fe", { extra: { BUS_PUSH: "off" } });
  expect(await refusal(tools, "unbind", { name: "fe" })).toContain("this grayboard process is tools-only (BUS_PUSH=off)");
  expect((await runCli(["human", "alex"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
  const h = await session("alex", { extra: { BUS_HUMAN: "1" } });
  expect(await refusal(h, "unbind", { name: "alex" })).toBe(`error: this is the human's session ("alex", BUS_HUMAN=1); it unbinds nothing`);
  expect(holderOf("fe")).toBeDefined();
  expect(holderOf("alex")).toBeDefined();
}, 30_000);

// The alias's labels and its meta audit rows.
const labels = (name: string) => rows<Record<string, string | null>>(`SELECT task, owner, source_board, spec_hash, description, last_bound_at FROM aliases WHERE address = ?`, name)[0]!;
const metaAudits = (name: string) => rows<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'alias.meta_set' AND target = ? ORDER BY rowid`, name).map((r) => JSON.parse(r.detail));

test("#284 S12: bind's meta labels the alias; a re-bind of a held alias changes only its labels", async () => {
  const s = await session();
  const id = await sessionId(s);
  await s.call("bind", { name: "fe", create: true, meta: { task: "  idle\tanim ", source_board: "#E2E" } });
  const first = labels("fe");
  expect(first).toMatchObject({ task: "idle anim", source_board: "e2e", owner: null });
  expect(first.last_bound_at).toBeNumber();
  expect(metaAudits("fe")).toEqual([{ address: "fe", fields: { task: "idle anim", source_board: "e2e" }, session: id }]);
  const boundAt = rows<{ bound_at: number }>(`SELECT bound_at FROM alias_holds WHERE address = 'fe'`)[0]!.bound_at;

  // Held already: no bind event, the hold's times stand, and only a change is audited.
  expect(await s.call("bind", { name: "fe", meta: { task: "idle anim" } })).toBe(`already bound to "fe"`);
  expect(metaAudits("fe")).toHaveLength(1);
  expect(await s.call("bind", { name: "fe", meta: { task: "", owner: "be" } })).toBe(`already bound to "fe"`);
  expect(labels("fe")).toMatchObject({ task: null, owner: "be", source_board: "e2e", last_bound_at: first.last_bound_at });
  expect(metaAudits("fe").at(-1)).toEqual({ address: "fe", fields: { task: null, owner: "be" }, session: id });
  expect(events("fe").map((e) => e.event)).toEqual(["bound"]);
  expect(rows<{ bound_at: number }>(`SELECT bound_at FROM alias_holds WHERE address = 'fe'`)[0]!.bound_at).toBe(boundAt);

  // Refusals change nothing.
  expect(await refusal(s, "bind", { name: "fe", meta: { task: "x".repeat(201) } })).toContain("meta.task must be at most 200 chars");
  expect(await refusal(s, "bind", { name: "fe", meta: { source_board: "not a board" } })).toContain(`invalid board name "not a board"`);
  expect(await refusal(s, "bind", { name: "fe", meta: { colour: "red" } })).toContain(`unknown meta key "colour"; known: task, owner, source_board, spec_hash, description`);
  expect(await refusal(s, "bind", { name: "fe", meta: { task: 7 } })).toContain("meta.task must be a string");
  expect(await refusal(s, "bind", { name: "fe2", create: true, meta: { task: "x".repeat(201) } })).toContain("meta.task must be at most 200 chars");
  expect(holderOf("fe2")).toBeUndefined();
  expect(labels("fe")).toMatchObject({ task: null, owner: "be" });
}, 30_000);

test("#284 AC 8: the session's model shows on the alias it holds; the alias's task stays with the alias", async () => {
  const s = await session(undefined, { extra: { BUS_MODEL: "m", BUS_EFFORT: "high" } });
  const id = await sessionId(s);
  await s.call("bind", { name: "a", create: true, meta: { task: "t" } });
  await s.call("unbind", { name: "a" });
  await s.call("bind", { name: "b", create: true });
  // A is released, so offline: listed only with include_offline.
  const peers = (await s.call("peer_list", { include_offline: true })).peers as Record<string, unknown>[];
  expect(peers.find((p) => p.handle === "b")).toMatchObject({ id, model: "m", effort: "high" });
  const a = peers.find((p) => p.handle === "a")!;
  expect(a).toMatchObject({ task: "t" });
  expect(a.model).toBeUndefined();
}, 30_000);

test("#361: a post pending for the ID and the alias is pushed once and delivered for both", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const s = await session();
  const id = await sessionId(s);
  await s.call("board_subscribe", { board: "e2e", mode: "push" });
  await s.call("bind", { name: "fe", create: true });
  await s.call("board_subscribe", { board: "e2e", mode: "push" });
  expect(rows(`SELECT handle FROM subscriptions WHERE board = 'e2e' AND handle != 'be' ORDER BY handle`)).toEqual([{ handle: "fe" }, { handle: id }]);

  await be.call("board_post", { board: "e2e", body: "once" });
  const delivered = () => rows<{ handle: string }>(`SELECT o.handle FROM outbox o JOIN posts p ON p.id = o.post_id WHERE p.body = 'once' AND o.delivered_at IS NOT NULL ORDER BY o.handle`);
  await until(() => delivered().length === 2);
  expect(delivered()).toEqual([{ handle: "fe" }, { handle: id }]);
  // Barrier: a DM drained after the post's push.
  await be.call("dm_send", { to: "fe", body: "probe" });
  await until(() => contents(s).includes("probe"));
  expect(contents(s).filter((c) => c === "once")).toHaveLength(1);
}, 30_000);

test("9: a DM sent mid-unbind is queued for the name's next holder, never consumed here", async () => {
  const s = await session("fe", { extra: pauseEnv("unbind:before-txn") });
  await s.call("bind", { name: "fe2", create: true });
  const be = await session("be");
  const unbinding = s.c.callTool({ name: "unbind", arguments: { name: "fe2" } });
  await until(() => s.stderr().includes("test pause hit: unbind:before-txn"));
  // fe2's socket closed before its hold drops: the sender is told it's queued.
  expect(existsSync(join(dir, "sock.fe2"))).toBe(false);
  expect(await be.call("dm_send", { to: "fe2", body: "mid-unbind" })).toMatchObject({ delivered_now: false });
  // The hold stands until the release commits: nobody takes the name meanwhile.
  const third = await session();
  expect(await refusal(third, "bind", { name: "fe2" })).toContain(`"fe2" is in use by the live session`);
  release("unbind:before-txn");
  expect((await unbinding).isError).toBeFalsy();
  // Barrier: a DM to fe drains after anything under fe2.
  await be.call("dm_send", { to: "fe", body: "probe" });
  await until(() => contents(s).includes("probe"));
  expect(contents(s)).not.toContain("mid-unbind");
  await third.call("bind", { name: "fe2" });
  await until(() => contents(third).includes("mid-unbind"));
}, 30_000);

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
  expect(JSON.parse(texts[0]!).you).toBe("old");
  expect(texts.slice(1).join(" ")).toContain(`bind("fe") completed after it was cancelled. Bound to "fe"; you hold "old", "fe" and send as "old".`);
  expect((r.structuredContent as any).instructions.slice(0, 2)).toEqual([`You are identity "old" on the grayboard bus, which coordinates between agents.`, `You also hold "fe"; you send as "old" unless a call passes as, and a reply goes as the alias its message reached.`]);
  expect((await s.c.callTool({ name: "peer_list", arguments: {} })).structuredContent).toBeUndefined();
}, 30_000);

test("12: the human declaration and a bind of the same name: neither order lets both win", async () => {
  // The declaration holds its transaction while a bind starts: the bind waits, then is refused.
  // Each waiter opens first and parks just before its transaction; "pause released" is logged
  // right before its BEGIN IMMEDIATE, so a run where the two didn't overlap can't pass.
  const s = await session(undefined, { extra: pauseEnv("bind:before-txn") });
  await stop((await session("alex")).c);
  const bind = s.c.callTool({ name: "bind", arguments: { name: "alex" } });
  await until(() => s.stderr().includes("test pause hit: bind:before-txn"));
  const human = spawnCli(["human", "alex"], pauseEnv("human:in-txn"));
  await until(() => human.stderr().includes("test pause hit: human:in-txn"));
  release("bind:before-txn");
  await until(() => s.stderr().includes("test pause released: bind:before-txn"));
  release("human:in-txn");
  expect(await human.p.exited).toBe(0);
  expect(((await bind).content as { text: string }[])[0]!.text).toContain(`"alex" is your user's handle`);

  // A bind holds its transaction while a declaration starts: the declaration waits, then is refused.
  const t = await session(undefined, { extra: pauseEnv("bind:in-txn") });
  await stop((await session("sam")).c);
  const human2 = spawnCli(["human", "sam"], pauseEnv("human:before-txn"));
  await until(() => human2.stderr().includes("test pause hit: human:before-txn"));
  const bind2 = t.c.callTool({ name: "bind", arguments: { name: "sam" } });
  await until(() => t.stderr().includes("test pause hit: bind:in-txn"));
  release("human:before-txn");
  await until(() => human2.stderr().includes("test pause released: human:before-txn"));
  release("bind:in-txn");
  expect((await bind2).isError).toBeFalsy();
  expect(await human2.p.exited).toBe(1);
  expect(human2.stderr()).toContain(`"sam" is bound by the live session`);
}, 30_000);

test("13, 15: an unbound exit leaves nothing; a SIGKILLed holder's row is reaped by the next acquire", async () => {
  const u = await session();
  const uid = await sessionId(u);
  const record = join(dir, `bind.${u.harnessPid}`);
  expect(existsSync(record)).toBe(true);
  await stop(u.c);
  expect(rows(`SELECT 1 FROM bindings WHERE session_id = ?`, uid)).toEqual([]);
  expect(existsSync(record)).toBe(false);

  await session("fe");
  await sigkill(pidOf("fe"));
  await until(() => {
    try {
      process.kill(pidOf("fe"), 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(holderOf("fe")).toBeDefined();
  const next = await session();
  await next.call("bind", { name: "fe" });
  expect((await next.call("peer_list", {})).you).toBe("fe");
  const ev = events("fe");
  expect(ev.map((e) => e.event)).toEqual(["bound", "released", "bound"]);
  expect(ev[1]!.detail).toMatch(/^session_end: reaped: pid \d+ is gone$/);
  // A clean exit logs its release, and keeps its name record for a restart under its harness.
  await stop(next.c);
  expect(events("fe").at(-1)!.event).toBe("released");
  expect(existsSync(join(dir, "sock.fe"))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, `bind.${next.harnessPid}`), "utf8")).names).toEqual(["fe"]);
}, 30_000);

test("#211: a name record whose session the name's history doesn't show restores the name unverified, with a fresh status", async () => {
  let s = await session(null);
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const path = join(dir, `bind.${s.harnessPid}`);
  const stranger = "id:0123456789abc";
  const prior = events("api").at(-1)!.session_id;
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), session_id: stranger }));
  s = await s.restart("crash");
  expect((await s.call("peer_list", {})).you).toBe("api");
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored_from ${stranger} not verified: latest bound by ${prior}` });
  expect(statusOf("api")).toBeNull();
}, 30_000);

// #259, local half: a session ID is public, but locally the proof of descent
// is the name record under the same harness, which a stray never has.
test("#259: a stray refused while the holder lived binds the name after its death as a fresh session: no restore, no status", async () => {
  const holder = await session("api");
  await holder.call("peer_status", { text: "mid-task" });
  const prior = holderOf("api")!;
  const stray = await session("api");
  expect((await stray.call("peer_list", {})).you).toMatch(/^id:/);
  await sigkill(pidOf("api"));
  await stray.call("bind", { name: "api" });
  expect((await stray.call("peer_list", {})).you).toBe("api");
  expect(holderOf("api")).not.toBe(prior);
  const bound = events("api").filter((e) => e.event === "bound").at(-1)!;
  expect(bound.session_id).toBe(holderOf("api")!);
  expect(bound.detail ?? "").not.toContain("restored");
  expect(statusOf("api")).toBeNull();
}, 30_000);

// #284: a 1.x name record and binding history carry a 16-hex session ID, the
// same 64 bits; a restart across the upgrade still matches its history.
test("#284: a restart from a 1.x name record is verified against 1.x binding history", async () => {
  let s = await session(null);
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const legacy = "0123456789abcdef";
  const db = new Database(join(dir, "bus.db"));
  db.prepare(`INSERT INTO binding_events (session_id, name, event, at) VALUES (?, 'api', 'bound', ?)`).run(legacy, Date.now());
  db.close();
  const path = join(dir, `bind.${s.harnessPid}`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), session_id: legacy }));
  s = await s.restart("crash");
  expect((await s.call("peer_list", {})).you).toBe("api");
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored: restart of session id:${crockford13(legacy)}` });
}, 30_000);

test("#211: a restore is verified in the transaction that binds: a bind that lands while it waits makes it unverified", async () => {
  const s = await session(null, { extra: pauseEnv("bind:before-txn") });
  const bind = s.call("bind", { name: "api", create: true });
  await until(() => s.stderr().includes("test pause hit: bind:before-txn"));
  release("bind:before-txn");
  await bind;
  const prior = events("api").at(-1)!.session_id;
  rmSync(join(dir, "go-bind:before-txn"));
  // The restart parks just before its transaction; another session binds the
  // name, sets a status and exits meanwhile.
  const hits = () => s.stderr().split("test pause hit: bind:before-txn").length - 1;
  const restarting = s.restart("crash");
  await until(() => hits() === 2);
  const other = await session("api");
  await other.call("peer_status", { text: "theirs" });
  await stop(other.c);
  const theirs = events("api").filter((e) => e.event === "bound").at(-1)!.session_id;
  expect(theirs).not.toBe(prior);
  release("bind:before-txn");
  const next = await restarting;
  expect((await next.call("peer_list", {})).you).toBe("api");
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored_from ${prior} not verified: latest bound by ${theirs}` });
  expect(statusOf("api")).toBeNull();
}, 30_000);

test("11: a restart under the same harness takes its name back; a fresh harness, or a launcher parent, starts unbound", async () => {
  // The record outranks an explicit BUS_IDENTITY: the restart is the same session, mid-task.
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  await s.call("unbind", { name: "be" });
  await s.call("peer_status", { text: "mid-task" });
  const peer = await session("fe");
  for (const how of ["reconnect", "crash"] as const) {
    const before = holderOf("api")!;
    const harness = s.harnessPid;
    s = await s.restart(how);
    expect(s.harnessPid).toBe(harness);
    expect(s.c.getInstructions()).toStartWith(`You are identity "api"`);
    expect((await s.call("peer_list", {})).you).toBe("api");
    const now = holderOf("api")!;
    expect(now).not.toBe(before);
    expect(events("api").at(-1)).toEqual({ session_id: now, event: "bound", detail: `restored: restart of session ${before}` });
    // The same session to its peers: its status stays, and its mail arrives.
    expect((await peer.call("peer_list", {})).peers).toContainEqual(expect.objectContaining({ handle: "api", status: "mid-task" }));
    await peer.call("dm_send", { to: "api", body: how });
    await until(() => contents(s).includes(how));
  }
  // "be" was never taken back: the restart restored "api", not BUS_IDENTITY.
  expect(events("be").map((e) => e.event)).toEqual(["bound", "released"]);
  expect(events("be")[1]!.detail).toBe("unbind");

  // A new harness process is a new session: unbound, with "api" free to bind.
  await stop(s.c);
  const fresh = await session();
  expect(fresh.c.getInstructions()).toContain("This session has no bus name yet, so it acts as its ID");
  expect(fresh.c.getInstructions()).not.toContain("restarted");

  // A launcher between harness and grayboard is a new parent on each restart,
  // so the name can't come back; the instructions say why.
  const sh = ["sh", "-c", `"$@"; exit $?`, "sh", process.execPath];
  let l = await localSession(dir, undefined, { via: sh });
  const launcherNote = "Its parent process is a launcher (sh), so if this grayboard process restarts, its name won't come back";
  expect(l.c.getInstructions()).toContain(launcherNote);
  await l.call("bind", { name: "web", create: true });
  l = await l.restart("reconnect");
  expect(l.c.getInstructions()).toContain("This session has no bus name yet, so it acts as its ID");
  expect(l.c.getInstructions()).toContain(launcherNote);
}, 60_000);

test("#284 S10: a restart takes back every name in its record, in order; one held by another is named in a note", async () => {
  let s = await session();
  await s.call("bind", { name: "zed", create: true });
  await s.call("bind", { name: "alpha", create: true });
  const before = holderOf("zed")!;
  const path = join(dir, `bind.${s.harnessPid}`);
  expect(JSON.parse(readFileSync(path, "utf8")).names).toEqual(["zed", "alpha"]);
  const peer = await session("be");
  s = await s.restart("crash");
  const now = holderOf("zed")!;
  expect(now).not.toBe(before);
  expect(rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at`, now)).toEqual([{ address: "zed" }, { address: "alpha" }]);
  expect(s.c.getInstructions()).toStartWith(`You are identity "zed" on the grayboard bus, which coordinates between agents. You also hold "alpha"; you send as "zed" unless a call passes as, and a reply goes as the alias its message reached.`);
  for (const n of ["zed", "alpha"]) expect(events(n).at(-1)).toEqual({ session_id: now, event: "bound", detail: `restored: restart of session ${before}` });
  await peer.call("dm_send", { to: "alpha", body: "to alpha" });
  await until(() => contents(s).includes("to alpha"));

  // alpha taken by another session while this one is down: zed comes back alone.
  const rec = JSON.parse(readFileSync(path, "utf8"));
  await s.call("unbind", { name: "alpha" });
  const t = await session();
  const tid = await sessionId(t);
  await t.call("bind", { name: "alpha" });
  writeFileSync(path, JSON.stringify(rec));
  s = await s.restart("crash");
  expect((await s.call("peer_list", {})).you).toBe("zed");
  expect(holderOf("alpha")).toBe(tid);
  expect(s.c.getInstructions()).toContain(`This grayboard process restarted; the one before it held "alpha", but "alpha" is in use by the live session`);
  expect(s.c.getInstructions()).toContain("so this session doesn't hold it.");
}, 40_000);

test("#284 S10: a name record from before several aliases (one `name`) still restores", async () => {
  let s = await session();
  await s.call("bind", { name: "api", create: true });
  const path = join(dir, `bind.${s.harnessPid}`);
  const { names, ...rec } = JSON.parse(readFileSync(path, "utf8"));
  expect(names).toEqual(["api"]);
  writeFileSync(path, JSON.stringify({ ...rec, name: "api" }));
  const before = holderOf("api")!;
  s = await s.restart("crash");
  expect((await s.call("peer_list", {})).you).toBe("api");
  expect(events("api").at(-1)).toMatchObject({ event: "bound", detail: `restored: restart of session ${before}` });
}, 30_000);

test("13 (decision 13): `grayboard tools` prints what the session serves; bind's result carries its name and instructions", async () => {
  const s = await session();
  const printed = await runCli(["tools", "--json"], { cwd: dir, env: localEnv(dir) });
  expect(printed.code).toBe(0);
  expect(JSON.parse(printed.out)).toEqual((await s.c.listTools()).tools);
  // Printing the tools opened no bus.
  const fresh = mkdtempSync(join(dir, "fresh-"));
  expect((await runCli(["tools"], { cwd: fresh, env: localEnv(fresh) })).code).toBe(0);
  expect(existsSync(join(fresh, "bus.db"))).toBe(false);

  const r = await s.c.callTool({ name: "bind", arguments: { name: "api", create: true } });
  expect(r.structuredContent).toEqual({ name: "api", instructions: expect.any(Array) });
  const { instructions } = r.structuredContent as { instructions: string[] };
  expect(instructions[0]).toStartWith(`You are identity "api"`);
  // The unbound session already had the general text (#284 S13): the result
  // repeats only what's about the name.
  const text = (r.content as { text: string }[])[0]!.text;
  expect(text).toEndWith(instructions[0]!);
  expect(s.c.getInstructions()).toContain(instructions[1]!);
  expect(text).not.toContain(instructions[1]!);
}, 20_000);

// #284 audit B1/W1: a write carries the writing session's ID; a tools-only
// process registers no session, so its writes carry none.
test("#284 S7: a tools-only process is its own session: its writes carry its ID, it can't be sent to, it isn't listed, it ends on exit", async () => {
  const owner = await session("be");
  await owner.call("board_create", { name: "e2e", purpose: "test" });
  const tools = await session("be", { extra: { BUS_PUSH: "off" } });
  for (const [s, tag] of [[owner, "owner"], [tools, "tools"]] as const) {
    await s.call("dm_send", { to: "be", body: `dm ${tag}` });
    await s.call("board_post", { board: "e2e", body: `post ${tag}` });
  }
  const id = holderOf("be")!;
  const toolsId = rows<{ id: string }>(`SELECT id FROM ids WHERE delivery = 'none'`)[0]!.id;
  expect(id).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).toMatch(/^id:[0-9a-z]{13}$/);
  expect(toolsId).not.toBe(id);
  expect(rows(`SELECT writes_as, ended_at FROM ids WHERE id = ?`, toolsId)).toEqual([{ writes_as: "be", ended_at: null }]);
  expect(rows(`SELECT body, sender_id FROM messages ORDER BY id`)).toEqual([{ body: "dm owner", sender_id: id }, { body: "dm tools", sender_id: toolsId }]);
  expect(rows(`SELECT body, author_id FROM posts ORDER BY id`)).toEqual([{ body: "post owner", author_id: id }, { body: "post tools", author_id: toolsId }]);
  // Mail it could never read is refused now, pointed at the alias it writes as.
  expect(await refusal(owner, "dm_send", { to: toolsId, body: "hi" })).toBe(`error: no_delivery: ${toolsId} is a tools-only session and receives nothing; send to be`);
  const other = await session();
  expect(((await other.call("peer_list", {})).unbound_sessions as { session_id: string }[]).map((u) => u.session_id)).toEqual([await sessionId(other)]);
  await stop(tools.c);
  await until(() => rows<{ ended_at: number | null }>(`SELECT ended_at FROM ids WHERE id = ?`, toolsId)[0]!.ended_at !== null);
  expect(holderOf("be")).toBe(id);
}, 20_000);

const senderOf = (id: number) => rows<{ sender: string }>(`SELECT sender FROM messages WHERE id = ?`, id)[0]!.sender;

test("#284 S3: as on dm_send, board_post and claim_take names one of the session's addresses", async () => {
  const peer = await session("peer");
  const s = await session();
  const id = await sessionId(s);
  await s.call("bind", { name: "a", create: true });
  await s.call("bind", { name: "b", create: true });
  const t = await session("c");

  const plain = await s.call("dm_send", { to: "peer", body: "1" });
  expect([senderOf(plain.message_id as number), plain.sent_as]).toEqual(["a", undefined]);
  const asB = await s.call("dm_send", { to: "peer", body: "2", as: "b" });
  expect([senderOf(asB.message_id as number), asB.sent_as]).toEqual(["b", "b"]);
  const asId = await s.call("dm_send", { to: "peer", body: "3", as: id });
  expect(senderOf(asId.message_id as number)).toBe(id);
  for (const other of ["zzz", "c"]) {
    expect(await refusal(s, "dm_send", { to: "peer", body: "x", as: other })).toBe(`error: "${other}" isn't one of this session's addresses: a, b, ${id}`);
  }

  // Files go out as the sender: uploaded as b, bound to b's message.
  writeFileSync(join(dir, "f.txt"), "f");
  const withFile = await s.call("dm_send", { to: "peer", body: "4", as: "b", attachments: [join(dir, "f.txt")] });
  expect(rows<{ uploader: string }>(`SELECT uploader FROM attachments WHERE message_id = ?`, withFile.message_id as number)).toEqual([{ uploader: "b" }]);

  await s.call("board_create", { name: "e2e", purpose: "fixtures" });
  const post = await s.call("board_post", { board: "e2e", body: "as b", as: "b" });
  expect(rows<{ author: string }>(`SELECT author FROM posts WHERE id = ?`, post.post_id as number)).toEqual([{ author: "b" }]);
  expect(await refusal(s, "board_post", { board: "e2e", body: "x", as: "c" })).toBe(`error: "c" isn't one of this session's addresses: a, b, ${id}`);

  expect((await s.call("claim_take", { key: "k", as: "b" })).claim).toMatchObject({ holder: "b" });
  // An instance-scoped claim: taken as the ID.
  expect((await s.call("claim_take", { key: "k2", as: id })).claim).toMatchObject({ holder: id });
  // Renewing as another of the session's addresses moves nothing (decision 20).
  expect((await s.call("claim_take", { key: "k", as: "a" })).claim).toMatchObject({ holder: "b" });
  expect(await refusal(t, "claim_take", { key: "k3", as: "a" })).toContain(`"a" isn't one of this session's addresses: c, `);
}, 30_000);

test("#284 S3: the human's session acts only as its handle", async () => {
  expect((await runCli(["human", "alex"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
  const peer = await session("peer");
  const h = await session("alex", { extra: { BUS_HUMAN: "1" } });
  const id = rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = 'alex'`)[0]!.id;
  expect(await refusal(h, "dm_send", { to: "peer", body: "x", as: id })).toBe(`error: "${id}" isn't one of this session's addresses: alex`);
  expect(senderOf((await h.call("dm_send", { to: "peer", body: "y", as: "alex" })).message_id as number)).toBe("alex");
}, 30_000);

test("#284 S4: a reply goes as the held alias its parent reached or was sent as; else the primary", async () => {
  const peer = await session("peer");
  const s = await session();
  const id = await sessionId(s);
  // Mail to the ID before any bind is answered as the alias bound since.
  const toId = await peer.call("dm_send", { to: id, body: "to the id" });
  await s.call("bind", { name: "a", create: true });
  await s.call("bind", { name: "b", create: true });
  const r0 = await s.call("dm_send", { to: "peer", body: "r0", parent_id: toId.message_id });
  expect(senderOf(r0.message_id as number)).toBe("a");

  // Mail to b: pushed with to "b" (b isn't the primary), listed with it, answered as b.
  s.pushes.splice(0);
  const toB = await peer.call("dm_send", { to: "b", body: "to b" });
  const toA = await peer.call("dm_send", { to: "a", body: "to a" });
  const pushed = await until(() => {
    const b = s.pushes.find((p) => p.meta.message_id === String(toB.message_id));
    const a = s.pushes.find((p) => p.meta.message_id === String(toA.message_id));
    return a && b ? { a, b } : undefined;
  }, 10_000, "both DMs pushed");
  expect([pushed.b.meta.to, pushed.a.meta.to]).toEqual(["b", undefined]);
  const inbox = (await s.call("dm_inbox", {})).unanswered as { id: number; to?: string }[];
  expect(inbox.find((m) => m.id === toB.message_id)?.to).toBe("b");
  expect(inbox.find((m) => m.id === toA.message_id)?.to).toBeUndefined();
  const r1 = await s.call("dm_send", { to: "peer", body: "r1", parent_id: toB.message_id });
  expect([senderOf(r1.message_id as number), r1.sent_as]).toEqual(["b", "b"]);
  // as wins.
  const r2 = await s.call("dm_send", { to: "peer", body: "r2", parent_id: toB.message_id, as: "a" });
  expect([senderOf(r2.message_id as number), r2.sent_as]).toEqual(["a", undefined]);
  // Its own thread, as its sender.
  const r3 = await s.call("dm_send", { to: "peer", body: "r3", parent_id: r1.message_id });
  expect(senderOf(r3.message_id as number)).toBe("b");

  // b unbound and taken by t: a reply to mail that reached b is refused, not sent as a.
  const toB2 = await peer.call("dm_send", { to: "b", body: "to b again" });
  await s.call("unbind", { name: "b" });
  const t = await session();
  await t.call("bind", { name: "b" });
  expect(await refusal(s, "dm_send", { to: "peer", body: "x", parent_id: toB2.message_id })).toBe(`error: parent_id ${toB2.message_id} is not a message you sent or received`);
}, 30_000);

// #284 S11: whoami names the session, its holds oldest first, and what it sends as.
test("#284 S11: whoami lists the ID, the primary and the holds oldest first; a tools-only process names its writes_as", async () => {
  const s = await session();
  const id = await sessionId(s);
  expect(await s.call("whoami", {})).toEqual({ id, primary: id, aliases: [], principal: null });
  await s.call("bind", { name: "zed", create: true });
  await s.call("bind", { name: "alpha", create: true });
  expect(await s.call("whoami", {})).toEqual({ id, primary: "zed", aliases: ["zed", "alpha"], principal: null });
  await s.call("unbind", { name: "zed" });
  expect(await s.call("whoami", {})).toEqual({ id, primary: "alpha", aliases: ["alpha"], principal: null });

  const tools = await session("fe", { extra: { BUS_PUSH: "off" } });
  expect(await tools.call("whoami", {})).toEqual({ id: expect.stringMatching(/^id:/), primary: "fe", aliases: [], principal: null, writes_as: "fe" });
}, 30_000);

// #284 AC 3: a reply goes to the alias a message was sent as, so it follows
// that alias's holder.
test("#284 AC 3: a reply to a send as b reaches the session; once b moves to another session, the next reply reaches that one", async () => {
  const s = await session("a");
  await s.call("bind", { name: "b", create: true });
  const peer = await session("fe");
  const sent = await s.call("dm_send", { to: "fe", body: "from b", as: "b" });
  await until(() => contents(peer).includes("from b"));
  await peer.call("dm_send", { to: "b", body: "reply one", parent_id: sent.message_id });
  await until(() => contents(s).includes("reply one"));

  await s.call("unbind", { name: "b" });
  const t = await session();
  await t.call("bind", { name: "b" });
  await peer.call("dm_send", { to: "b", body: "reply two", parent_id: sent.message_id });
  await until(() => contents(t).includes("reply two"));
  // Barrier: a DM to a drains after anything for s.
  await peer.call("dm_send", { to: "a", body: "probe" });
  await until(() => contents(s).includes("probe"));
  expect(contents(s)).not.toContain("reply two");
}, 30_000);

// #284 S4: files go out as the reply's sender, which the parent decides.
test("#284 S4: a reply defaulting to b uploads its files as b", async () => {
  const peer = await session("peer");
  const s = await session("a");
  await s.call("bind", { name: "b", create: true });
  const toB = await peer.call("dm_send", { to: "b", body: "to b" });
  writeFileSync(join(dir, "f.txt"), "f");
  const r = await s.call("dm_send", { to: "peer", body: "with file", parent_id: toB.message_id, attachments: [join(dir, "f.txt")] });
  expect(r.sent_as).toBe("b");
  expect(rows<{ uploader: string }>(`SELECT uploader FROM attachments WHERE message_id = ?`, r.message_id as number)).toEqual([{ uploader: "b" }]);
}, 30_000);

test("#361: a post pending for two held aliases is pushed once and delivered for both", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const s = await session("a");
  await s.call("board_subscribe", { board: "e2e", mode: "push" });
  await s.call("bind", { name: "b", create: true });
  // Local picks the primary for a board tool (S14): make b the primary to subscribe it.
  await s.call("unbind", { name: "a" });
  await s.call("board_subscribe", { board: "e2e", mode: "push" });
  await s.call("bind", { name: "a" });
  expect(rows(`SELECT handle FROM subscriptions WHERE board = 'e2e' AND handle IN ('a', 'b') ORDER BY handle`)).toEqual([{ handle: "a" }, { handle: "b" }]);

  await be.call("board_post", { board: "e2e", body: "once" });
  const delivered = () => rows<{ handle: string }>(`SELECT o.handle FROM outbox o JOIN posts p ON p.id = o.post_id WHERE p.body = 'once' AND o.delivered_at IS NOT NULL ORDER BY o.handle`);
  await until(() => delivered().length === 2);
  expect(delivered()).toEqual([{ handle: "a" }, { handle: "b" }]);
  await be.call("dm_send", { to: "b", body: "probe" });
  await until(() => contents(s).includes("probe"));
  expect(contents(s).filter((c) => c === "once")).toHaveLength(1);
}, 30_000);

// #259 with several aliases (spec AC 6): the stray keeps writing as b while
// refused a, and taking a after p dies brings a's mail and claims, not p's
// status, and leaves its primary b.
test("#259: a stray holding b, refused a while p lives, takes a after p dies: mail and claims, no status, primary still b", async () => {
  const p = await session("a");
  await p.call("peer_status", { text: "p's task" });
  await p.call("claim_take", { key: "ticket:ENG-7" });
  const pid = holderOf("a")!;
  const x = await session("b");
  expect(await refusal(x, "bind", { name: "a" })).toContain(`"a" is in use by the live session`);
  expect(senderOf((await x.call("dm_send", { to: "a", body: "from b" })).message_id as number)).toBe("b");

  await sigkill(pidOf("a"));
  const peer = await session("fe");
  await peer.call("dm_send", { to: "a", body: "for a" });
  await x.call("bind", { name: "a" });
  await until(() => contents(x).includes("for a"));
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-7'`)).toEqual([{ holder: "a" }]);
  const xid = holderOf("b")!;
  const tail = events("a").filter((e) => e.event !== "refused").slice(-2);
  expect(tail[0]).toMatchObject({ session_id: pid, event: "released", detail: expect.stringMatching(/^session_end: /) });
  expect(tail[1]).toEqual({ session_id: xid, event: "bound", detail: null });
  expect(statusOf("a")).toBeNull();
  expect(senderOf((await x.call("dm_send", { to: "fe", body: "who" })).message_id as number)).toBe("b");
}, 30_000);

// #284 decision 8: a claim taken as the ID is listed under the ID.
test("#284: claim_list shows a claim taken as the session's ID under that ID", async () => {
  const s = await session();
  const id = await sessionId(s);
  await s.call("claim_take", { key: "ticket:ENG-9" });
  const peer = await session("fe");
  expect(((await peer.call("claim_list", {})) as { key: string; holder: string }[]).find((c) => c.key === "ticket:ENG-9")).toMatchObject({ holder: id });
}, 30_000);
