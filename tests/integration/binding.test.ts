// Name binding over real local-mode processes (#182): unbound start, bind,
// rebind, the races the bindings row settles, and what's left after exit.
// Each numbered comment is the #182 acceptance criterion the test shows.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { CLI } from "../support/paths.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { until } from "../support/until.ts";

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
const sessionId = async (s: Session) => ((await s.call("peer_list", {})).you as string).slice(1);
const pidOf = (name: string) => rows<{ pid: number }>(`SELECT pid FROM bindings WHERE name = ?`, name)[0]!.pid;

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

test("1, 3, 14, 18: an unbound session reads without a trace, offers its default with its mail, and binds", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // "api" existed once and has 3 DMs queued, with no live holder.
  await stop((await session("api")).c);
  const be = await session("be");
  for (const body of ["one", "two", "three"]) await be.call("dm_send", { to: "api", body });
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "hello" });

  const s = await session(undefined, { cwd: repo });
  expect(s.c.getInstructions()).toStartWith("This session has no bus name yet.");
  expect(s.c.getInstructions()).toContain("Candidates (free now): api (this checkout's default: 3 queued DMs, 0 claims");
  const id = await sessionId(s);
  expect(id).toMatch(/^[0-9a-f]{16}$/);

  // Reads work; nothing else does, and nothing records the session.
  expect((await s.call("board_read", { board: "e2e" })).posts.map((p: any) => p.body)).toEqual(["hello"]);
  expect((await s.call("board_list", {})).map((b: any) => b.name)).toContain("e2e");
  expect(await s.call("claim_list", {})).toEqual([]);
  for (const [tool, args] of [["board_post", { board: "e2e", body: "x" }], ["dm_send", { to: "be", body: "x" }], ["claim_take", { key: "k" }], ["dm_inbox", {}]] as const) {
    expect(await refusal(s, tool, args)).toContain("no bus name yet. Call bind(name)");
  }
  expect(cellsEqual(`~${id}`)).toEqual([]);

  // 14: peers see it by session ID, unbound.
  const seen = (await be.call("peer_list", {})).unbound_sessions;
  expect(seen).toEqual([expect.objectContaining({ session_id: id, unbound: true, online: true })]);
  expect(seen[0].self).toBeUndefined();
  expect((await s.call("peer_list", {})).unbound_sessions).toEqual([expect.objectContaining({ session_id: id, self: true })]);

  // 3: a new name gets none of api's mail, and api's mail stays unread.
  await s.call("bind", { name: "api2", create: true });
  await Bun.sleep(300);
  expect(contents(s)).toEqual([]);
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
  expect(r.err).toContain(`"alex" is held by the live session`);
}, 20_000);

test("4: a never-seen name needs create; the refusal lists the closest names, not viewers", async () => {
  await stop((await session("fe")).c);
  const db = new Database(join(dir, "bus.db"));
  db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('~fe', 1, 1)`).run();
  db.close();
  const s = await session();
  const err = await refusal(s, "bind", { name: "fee" });
  expect(err).toContain(`no name "fee" has ever been used; closest: fe.`);
  expect(err).not.toContain("~fe");
  expect(events("fee")).toEqual([{ session_id: await sessionId(s), event: "refused", detail: expect.stringContaining("closest: fe") }]);
}, 20_000);

test("5, 13: of N concurrent binders exactly one wins; the losers name it and leave its socket alone (#80)", async () => {
  const n = 6;
  const all = await Promise.all(Array.from({ length: n }, () => session()));
  const results = await Promise.all(all.map((s) => s.c.callTool({ name: "bind", arguments: { name: "fe", create: true } })));
  const winners = all.filter((_, i) => !results[i]!.isError);
  expect(winners).toHaveLength(1);
  const winnerId = rows<{ session_id: string }>(`SELECT session_id FROM bindings WHERE name = 'fe'`)[0]!.session_id;
  for (const r of results.filter((r) => r.isError)) {
    expect((r.content as { text: string }[])[0]!.text).toContain(`"fe" is held by the live session ${winnerId}`);
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
    expect(await refusal(s, "bind", { name: "fe" })).toContain(`"fe" is held by the live session`);
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
  expect(rows(`SELECT 1 FROM bindings WHERE name = 'fe'`)).toEqual([]);
  expect(await refusal(s, "bind", { name: "fe" })).toContain("a live session from an older grayboard");
  expect(s.c.getInstructions()).not.toContain("fe (");
}, 30_000);

test("7: a dead holder's row doesn't hide a pre-upgrade session listening on the name since", async () => {
  // s starts first: its startup reaps dead rows, and the row must still be there at its bind.
  const s = await session();
  await session("fe");
  process.kill(pidOf("fe"), "SIGKILL");
  await localSession(dir, "fe", { bin: rel.cli });
  expect(rows(`SELECT 1 FROM bindings WHERE name = 'fe'`)).toHaveLength(1);
  expect(await refusal(s, "bind", { name: "fe" })).toContain("a live session from an older grayboard");
  expect(rows(`SELECT 1 FROM bindings WHERE name = 'fe'`)).toEqual([]);
}, 30_000);

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
  expect((await s.call("claim_list", {})).map((c: any) => c.holder)).toEqual(["fe2"]);
  expect(rows(`SELECT handle, event FROM claim_events WHERE key = 'ticket:ENG-142' AND event = 'moved'`)).toEqual([{ handle: "fe2", event: "moved" }]);
  expect(await s.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");
  expect(await s.call("claim_list", {})).toEqual([]);

  expect(events("fe2").map((e) => e.event)).toEqual(["bound", "released", "moved"]);
  expect(events("fe2").at(-1)!.detail).toBe("fe");
  expect(events("fe").at(-1)).toMatchObject({ event: "released", detail: "rebound to fe2" });

  const other = await session();
  await other.call("bind", { name: "fe" });
  expect((await other.call("peer_list", {})).you).toBe("fe");
}, 30_000);

test("9: a DM sent mid-swap is never consumed under the new name", async () => {
  const s = await session("fe", { extra: pauseEnv("bind:after-acquire") });
  const be = await session("be");
  const binding = s.c.callTool({ name: "bind", arguments: { name: "fe2", create: true } });
  await until(() => s.stderr().includes("test pause hit: bind:after-acquire"));
  await be.call("dm_send", { to: "fe", body: "mid-swap" });
  release("bind:after-acquire");
  expect((await binding).isError).toBeFalsy();
  await Bun.sleep(300);
  // Delivered as fe before the swap, or left for fe; never read as fe2.
  const asFe = contents(s).includes("mid-swap");
  if (!asFe) {
    const next = await session();
    await next.call("bind", { name: "fe" });
    await until(() => contents(next).includes("mid-swap"));
  }
}, 30_000);

test("12: the human declaration and a bind of the same name: neither order lets both win", async () => {
  // The declaration holds its transaction while a bind starts: the bind waits, then is refused.
  const s = await session();
  await stop((await session("alex")).c);
  const human = spawnCli(["human", "alex"], pauseEnv("human:in-txn"));
  await until(() => human.stderr().includes("test pause hit: human:in-txn"));
  const bind = s.c.callTool({ name: "bind", arguments: { name: "alex" } });
  await Bun.sleep(200);
  release("human:in-txn");
  expect(await human.p.exited).toBe(0);
  expect(((await bind).content as { text: string }[])[0]!.text).toContain(`"alex" is your user's handle`);

  // A bind holds its transaction while a declaration starts: the declaration waits, then is refused.
  const t = await session(undefined, { extra: pauseEnv("bind:in-txn") });
  await stop((await session("sam")).c);
  const bind2 = t.c.callTool({ name: "bind", arguments: { name: "sam" } });
  await until(() => t.stderr().includes("test pause hit: bind:in-txn"));
  const human2 = spawnCli(["human", "sam"], {});
  await Bun.sleep(200);
  release("bind:in-txn");
  expect((await bind2).isError).toBeFalsy();
  expect(await human2.p.exited).toBe(1);
  expect(human2.stderr()).toContain(`"sam" is bound by the live session`);
}, 30_000);

test("13, 15: an unbound exit leaves nothing; a SIGKILLed holder's row is reaped by the next acquire", async () => {
  const u = await session();
  const uid = await sessionId(u);
  await stop(u.c);
  expect(rows(`SELECT 1 FROM bindings WHERE session_id = ?`, uid)).toEqual([]);

  await session("fe");
  process.kill(pidOf("fe"), "SIGKILL");
  await until(() => {
    try {
      process.kill(pidOf("fe"), 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(rows(`SELECT 1 FROM bindings WHERE name = 'fe'`)).toHaveLength(1);
  const next = await session();
  await next.call("bind", { name: "fe" });
  expect((await next.call("peer_list", {})).you).toBe("fe");
  const ev = events("fe");
  expect(ev.map((e) => e.event)).toEqual(["bound", "released", "bound"]);
  expect(ev[1]!.detail).toMatch(/^reaped: pid \d+ is gone$/);
  // A clean exit logs its release.
  await stop(next.c);
  expect(events("fe").at(-1)!.event).toBe("released");
  expect(existsSync(join(dir, "sock.fe"))).toBe(false);
}, 30_000);

test("11: a restart under the same harness takes its name back; a fresh harness, or a launcher parent, starts unbound", async () => {
  // The record outranks an explicit BUS_IDENTITY: the restart is the same session, mid-task.
  let s = await session("be");
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  const peer = await session("fe");
  for (const how of ["reconnect", "crash"] as const) {
    const before = rows<{ session_id: string }>(`SELECT session_id FROM bindings WHERE name = 'api'`)[0]!.session_id;
    const harness = s.harnessPid;
    s = await s.restart(how);
    expect(s.harnessPid).toBe(harness);
    expect(s.c.getInstructions()).toStartWith(`You are identity "api"`);
    expect((await s.call("peer_list", {})).you).toBe("api");
    const now = rows<{ session_id: string }>(`SELECT session_id FROM bindings WHERE name = 'api'`)[0]!.session_id;
    expect(now).not.toBe(before);
    expect(events("api").at(-1)).toEqual({ session_id: now, event: "bound", detail: `restored: restart of session ${before}` });
    // The same session to its peers: its status stays, and its mail arrives.
    expect((await peer.call("peer_list", {})).peers).toContainEqual(expect.objectContaining({ handle: "api", status: "mid-task" }));
    await peer.call("dm_send", { to: "api", body: how });
    await until(() => contents(s).includes(how));
  }
  // "be" was never taken back: the restart restored "api", not BUS_IDENTITY.
  expect(events("be").map((e) => e.event)).toEqual(["bound", "released"]);

  // A new harness process is a new session: unbound, with "api" free to bind.
  await stop(s.c);
  const fresh = await session();
  expect(fresh.c.getInstructions()).toStartWith("This session has no bus name yet.");
  expect(fresh.c.getInstructions()).not.toContain("restarted");

  // A launcher between harness and grayboard is a new parent on each restart,
  // so the name can't come back; the instructions say why.
  const sh = ["sh", "-c", `"$@"; exit $?`, "sh", process.execPath];
  let l = await localSession(dir, undefined, { via: sh });
  const launcherNote = "Its parent process is a launcher (sh), so if this grayboard process restarts, its name won't come back";
  expect(l.c.getInstructions()).toContain(launcherNote);
  await l.call("bind", { name: "web", create: true });
  l = await l.restart("reconnect");
  expect(l.c.getInstructions()).toStartWith("This session has no bus name yet.");
  expect(l.c.getInstructions()).toContain(launcherNote);
}, 60_000);

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
  expect((r.content as { text: string }[])[0]!.text).toEndWith(instructions.join(" "));
}, 20_000);
