// Keeping history through an upgrade: a bus a pre-retention release wrote, whose
// first session on this tree prunes it unless `grayboard retention off` ran first.
// The release writes the schema and the rows; only their dates are moved.
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../support/cli.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, stopSession } from "../support/mcp.ts";
import { releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { until } from "../support/until.ts";

// The last release with no local retention.
const FROM = "v1.9.1";
const YEAR_AGO = () => Date.now() - 365 * 86_400_000;

let rel: ReleaseBinaries;
let dir: string;
let dbPath: string;

beforeAll(async () => {
  rel = await releaseBinaries(FROM);
}, 120_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-retention-"));
  dbPath = join(dir, "bus.db");
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return fn(db);
  } finally {
    db.close();
  }
}

const ids = (table: string) => withDb((db) => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map((r) => r.id));
const schema = () => withDb((db) => db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all() as { name: string; sql: string | null }[]);
// Every row of every table in `tables`, whichever tables the release has.
const rowsOf = (tables: { name: string; sql: string | null }[]) => withDb((db) =>
  Object.fromEntries(tables.filter((t) => t.sql?.startsWith("CREATE TABLE") && !t.name.startsWith("sqlite_")).map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()])));

// A year-old DM and post, written by the release's own sessions, which stay up.
async function oldHistory() {
  const be = await localSession(dir, "be", { bin: rel.cli });
  const fe = await localSession(dir, "fe", { bin: rel.cli });
  await be.call("dm_send", { to: "fe", body: "old dm" });
  await be.call("board_create", { name: "e2e", purpose: "tests" });
  await be.call("board_post", { board: "e2e", body: "old post" });
  withDb((db) => {
    db.prepare(`UPDATE messages SET created_at = ?`).run(YEAR_AGO());
    db.prepare(`UPDATE posts SET created_at = ?`).run(YEAR_AGO());
  });
  return { be, fe, messages: ids("messages"), posts: ids("posts") };
}

// One session of this tree, until its first retention run has finished: the
// run's writes all come in one synchronous block, so stopping the process
// after its claim leaves nothing still to happen.
async function firstSessionOnThisTree(extra?: Record<string, string>): Promise<string> {
  const s = await localSession(dir, "next", { extra });
  await until(() => withDb((db) => db.prepare(`SELECT 1 FROM retention_runs WHERE id = 1`).get() != null), 10_000, "the session's retention run to claim the day");
  await stopSession(s.c);
  return s.stderr();
}

test(`control: with nothing stored, a ${FROM} bus loses its old history to this tree's first session`, async () => {
  const old = await oldHistory();
  expect(old.messages.length).toBeGreaterThan(0);
  expect(old.posts.length).toBeGreaterThan(0);
  await stopSession(old.be.c);
  await stopSession(old.fe.c);

  const stderr = await firstSessionOnThisTree();

  for (const id of old.messages) expect(ids("messages")).not.toContain(id);
  for (const id of old.posts) expect(ids("posts")).not.toContain(id);
  // What it deleted, by table.
  expect(stderr).toMatch(new RegExp(`retention: deleted .*messages=${old.messages.length}\\b`));
  expect(stderr).toMatch(new RegExp(`retention: deleted .*posts=${old.posts.length}\\b`));
}, 60_000);

test(`retention off on a live ${FROM} bus adds one table, leaves its sessions alone, and keeps every row through this tree's first session`, async () => {
  const old = await oldHistory();
  const before = schema();
  const rows = rowsOf(before);

  const set = await runCli(["retention", "off"], { env: localEnv(dir) });
  expect(set.err).toBe("");
  expect(set.code).toBe(0);
  expect(set.out).toContain("retention: off");
  // Off is the row, days NULL; an empty table would mean the env or the default decides.
  expect(withDb((db) => db.prepare(`SELECT days FROM retention_setting WHERE id = 1`).get())).toEqual({ days: null });

  expect(schema().filter((t) => !t.name.startsWith("retention_setting"))).toEqual(before);
  expect(schema().map((t) => t.name)).toContain("retention_setting");
  expect(rowsOf(before)).toEqual(rows);
  // The release's sessions never noticed.
  await old.be.call("dm_send", { to: "fe", body: "still up" });
  await until(() => old.fe.pushes.some((p) => p.content === "still up"), 10_000, "fe to receive a DM after retention off");
  withDb((db) => db.prepare(`UPDATE messages SET created_at = ?`).run(YEAR_AGO()));
  const messages = ids("messages");

  await stopSession(old.be.c);
  await stopSession(old.fe.c);
  // A stray env value in the session is the same risk, so test with one.
  const stderr = await firstSessionOnThisTree({ BUS_RETENTION_DAYS: "1" });

  for (const id of messages) expect(ids("messages")).toContain(id);
  for (const id of old.posts) expect(ids("posts")).toContain(id);
  expect(stderr).not.toContain("retention: deleted");
  // And still off on the next open, with no day left to wait for: move the run back.
  withDb((db) => db.prepare(`UPDATE retention_runs SET last_run = ?`).run(YEAR_AGO()));
  const last = withDb((db) => (db.prepare(`SELECT last_run FROM retention_runs`).get() as { last_run: number }).last_run);
  const again = await localSession(dir, "again", { extra: { BUS_RETENTION_DAYS: "1" } });
  await until(() => withDb((db) => (db.prepare(`SELECT last_run FROM retention_runs`).get() as { last_run: number }).last_run > last), 10_000, "the second session's run to claim the day");
  await stopSession(again.c);
  for (const id of messages) expect(ids("messages")).toContain(id);
  for (const id of old.posts) expect(ids("posts")).toContain(id);
}, 60_000);

// A live pre-retention bus a 2.x CLI has opened once: `claims` upgrades the schema
// under the old sessions and starts no retention, so the bus has 2.x's tables and
// no run yet. Its first mcp session would prune it just as a clean one's would.
test(`retention off on a live ${FROM} bus that a 2.x CLI already upgraded keeps every row through this tree's first session`, async () => {
  const old = await oldHistory();
  const v2 = await releaseBinaries("v2.4.0");
  await runCli(["claims"], { env: localEnv(dir), bin: v2.cli });

  const tables = () => schema().map((t) => t.name);
  for (const table of ["retention_runs", "aliases", "ids", "alias_holds", "bindings"]) expect(tables()).toContain(table);
  expect(withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM retention_runs`).get() as { n: number }).n)).toBe(0);
  expect(tables()).not.toContain("retention_setting");

  const before = schema();
  const rows = rowsOf(before);
  const set = await runCli(["retention", "off"], { env: localEnv(dir) });
  expect(set.err).toBe("");
  expect(set.code).toBe(0);
  expect(schema().filter((t) => !t.name.startsWith("retention_setting"))).toEqual(before);
  expect(rowsOf(before)).toEqual(rows);

  await stopSession(old.be.c);
  await stopSession(old.fe.c);
  const stderr = await firstSessionOnThisTree();

  for (const id of old.messages) expect(ids("messages")).toContain(id);
  for (const id of old.posts) expect(ids("posts")).toContain(id);
  expect(stderr).not.toContain("retention: deleted");
}, 120_000);

test(`control: a ${FROM} bus that a 2.x CLI already upgraded still loses its old history with nothing stored`, async () => {
  const old = await oldHistory();
  const v2 = await releaseBinaries("v2.4.0");
  await runCli(["claims"], { env: localEnv(dir), bin: v2.cli });
  await stopSession(old.be.c);
  await stopSession(old.fe.c);

  await firstSessionOnThisTree();

  for (const id of old.messages) expect(ids("messages")).not.toContain(id);
  for (const id of old.posts) expect(ids("posts")).not.toContain(id);
}, 120_000);

test("the command shows the setting and its source, and never creates a bus to do it", async () => {
  const run = (args: string[], extra?: Record<string, string>) => runCli(args, { env: localEnv(dir, undefined, extra) });
  const json = async (extra?: Record<string, string>) => JSON.parse((await run(["retention", "--json"], extra)).out);

  expect(await json()).toMatchObject({ retention: 90, source: "default" });
  expect((await run(["retention"], { BUS_RETENTION_DAYS: "30" })).out).toContain("30 days, from BUS_RETENTION_DAYS");
  expect(await json({ BUS_RETENTION_DAYS: "30" })).toMatchObject({ retention: 30, source: "env" });
  // A malformed value isn't off: a session with it won't start at all.
  const bad = await run(["retention", "--json"], { BUS_RETENTION_DAYS: "0" });
  expect(bad.code).toBe(1);
  expect(bad.out).toBe("");
  expect(Bun.file(dbPath).size).toBe(0);

  for (const refused of ["0", "-1", "1.5", "30d", "99999999999999999999"]) {
    const r = await run(["retention", "--", refused]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("isn't off, a whole number of days, or default");
  }
  expect(Bun.file(dbPath).size).toBe(0);

  expect((await run(["retention", "365"])).code).toBe(0);
  expect(await json({ BUS_RETENTION_DAYS: "30" })).toMatchObject({ retention: 365, source: "stored", env: "30" });
  expect((await run(["retention", "off"])).out).toContain("was 365 days");
  expect(await json()).toMatchObject({ retention: "off", source: "stored" });
  expect((await run(["retention", "default"])).out).toContain("was off");
  expect(await json()).toMatchObject({ retention: 90, source: "default" });

  // Written on a brand new bus, the setting holds once a session creates the rest.
  expect((await run(["retention", "off"])).code).toBe(0);
  const s = await localSession(dir, "fresh");
  expect(await json()).toMatchObject({ retention: "off", source: "stored" });
  await stopSession(s.c);
}, 60_000);
