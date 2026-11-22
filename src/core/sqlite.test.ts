import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { busyTimeoutMs, checksWrite, journalModeWarning, openReader, openSqlite, routeReads, scriptStatements, STATEMENT_CACHE_SIZE } from "./sqlite.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// What openSqlite printed on stderr while opening `path` with `pragmas` (#178).
function opened(path: string, pragmas: string): string[] {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try { openSqlite(path, pragmas, () => {}).close(); return spy.mock.calls.map((c) => String(c[0])); }
  finally { spy.mockRestore(); }
}

test("an open that gets the WAL it asked for says nothing", () => {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  expect(opened(join(dir, "a.db"), "PRAGMA journal_mode = WAL;")).toEqual([]);
  expect(opened(":memory:", "PRAGMA journal_mode = WAL;")).toEqual([]);
});

test("an open left in another journal mode names the file and both modes", () => {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  const path = join(dir, "a.db");
  // The second pragma stands in for SQLite refusing the switch: the first is what was asked for.
  const lines = opened(path, "PRAGMA journal_mode = WAL; PRAGMA journal_mode = DELETE;");
  expect(lines).toEqual([`[grayboard] ${path} is in journal_mode delete, not wal: SQLite couldn't switch it (a filesystem without shared-memory locking, such as a network mount, can't use WAL)`]);
});

test("journalModeWarning: no journal_mode asked, in-memory and temporary databases, and case", () => {
  expect(journalModeWarning("/x.db", "PRAGMA synchronous = NORMAL;", "delete")).toBeUndefined();
  expect(journalModeWarning(":memory:", "PRAGMA journal_mode = WAL;", "memory")).toBeUndefined();
  expect(journalModeWarning("", "PRAGMA journal_mode = WAL;", "memory")).toBeUndefined();
  expect(journalModeWarning("/x.db", "pragma JOURNAL_MODE=wal", "WAL")).toBeUndefined();
  expect(journalModeWarning("/x.db", "PRAGMA journal_mode = WAL;", undefined)).toContain("journal_mode unknown, not wal");
});

// #912: `prepare(sql)` hands back the connection's cached statement instead of compiling one per call.
test("prepare reuses one compiled statement per SQL text, bounded, and binds per call", () => {
  const db = openSqlite(":memory:", "PRAGMA foreign_keys = ON;", (d) => d.exec("CREATE TABLE t (a INTEGER)"));
  try {
    expect(db.prepare("SELECT a FROM t WHERE a = ?")).toBe(db.prepare("SELECT a FROM t WHERE a = ?"));
    db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
    db.prepare("INSERT INTO t (a) VALUES (?)").run(2);
    expect(db.prepare("SELECT a FROM t WHERE a = ?").get(2)).toEqual({ a: 2 });
    expect(db.prepare("SELECT a FROM t WHERE a = ?").get(1)).toEqual({ a: 1 });
    // Bound at prepare: never shared.
    expect(db.prepare("SELECT a FROM t WHERE a = ?", [1])).not.toBe(db.prepare("SELECT a FROM t WHERE a = ?", [1]));
    // Past the cap the least recently used is evicted; an evicted statement still runs for its holder.
    const held = db.prepare("SELECT COUNT(*) AS n FROM t");
    for (let i = 0; i <= STATEMENT_CACHE_SIZE; i++) db.prepare(`SELECT ${i} AS i`).get();
    expect(db.prepare("SELECT COUNT(*) AS n FROM t")).not.toBe(held);
    expect(held.get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

// Local mode runs several processes on one file, and a newer one may add a column (a guarded ALTER)
// while an older one holds cached statements: SQLite re-prepares them on the schema change.
test("a cached statement sees a column another connection added", () => {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  const path = join(dir, "a.db");
  const a = openSqlite(path, "PRAGMA journal_mode = WAL;", (d) => d.exec("CREATE TABLE IF NOT EXISTS t (a INTEGER); INSERT INTO t VALUES (1)"));
  const b = openSqlite(path, "PRAGMA journal_mode = WAL;", () => {});
  try {
    expect(a.prepare("SELECT * FROM t").all()).toEqual([{ a: 1 }]);
    b.exec("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'");
    expect(a.prepare("SELECT * FROM t").all()).toEqual([{ a: 1, b: "x" }]);
  } finally { a.close(); b.close(); }
});

test("run with bindings reuses the cached statement and still runs every statement of a script", () => {
  const db = openSqlite(":memory:", "PRAGMA foreign_keys = ON;", (d) => d.exec("CREATE TABLE t (a INTEGER)"));
  try {
    expect(db.run("INSERT INTO t (a) VALUES (?)", [1])).toEqual({ changes: 1, lastInsertRowid: 1 });
    const query = spyOn(db, "query");
    try {
      db.run("INSERT INTO t (a) VALUES (?)", [4]);
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(["INSERT INTO t (a) VALUES (?)"]);
      // A script with bindings: not through a statement, which would compile only the first; every statement runs.
      db.run("DELETE FROM t WHERE a = ?; INSERT INTO t (a) VALUES (5)", [4]);
      expect(query).toHaveBeenCalledTimes(1);
    } finally { query.mockRestore(); }
    db.run("INSERT INTO t (a) VALUES (?)", [4]);
    expect(db.prepare("SELECT a FROM t ORDER BY a").all()).toEqual([1, 4, 5].map((a) => ({ a })));
  } finally { db.close(); }
});

// A WAL writer routed through a read-only reader whose statements are counted (#807 P1b-3).
function routed(): { db: Database; reader: Database; onReader: string[] } {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  const path = join(dir, "a.db");
  const db = openSqlite(path, "PRAGMA journal_mode = WAL;", d => d.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)"));
  const reader = openReader(path), onReader: string[] = [];
  const query = reader.query.bind(reader);
  reader.query = ((sql: string) => { onReader.push(sql); return query(sql); }) as Database["query"];
  routeReads(db, reader);
  return { db, reader, onReader };
}

test("routeReads: a read outside a transaction runs on the reader and sees every commit", () => {
  const { db, onReader } = routed();
  const read = db.prepare<{ v: number }, [string]>("SELECT v FROM t WHERE k = ?");
  db.transaction(() => db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1)).immediate();
  expect(read.get("a")?.v).toBe(1);
  expect(onReader).toEqual(["SELECT v FROM t WHERE k = ?"]);
  db.close();
});

test("routeReads: a statement made outside a transaction reads its own uncommitted writes inside one", () => {
  const { db, onReader } = routed();
  const read = db.prepare<{ v: number }, [string]>("SELECT v FROM t WHERE k = ?");
  const inside = db.transaction(() => { db.run("INSERT INTO t VALUES (?, ?)", ["b", 2]); return read.get("b")?.v; }).immediate();
  expect(inside).toBe(2);
  expect(onReader).toEqual([]);
  db.close();
});

test("routeReads: writes, temp objects, pragmas and transaction control run on the writer", () => {
  const { db, onReader } = routed();
  db.run("INSERT INTO t VALUES (?, ?)", ["c", 3]);
  db.prepare("UPDATE t SET v = ? WHERE k = ?").run(4, "c");
  db.prepare("WITH x AS (SELECT 'c' AS k) DELETE FROM t WHERE k IN (SELECT k FROM x)").run();
  db.prepare("INSERT INTO t VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run("d", 5);
  db.exec("CREATE TEMP TABLE n (x INTEGER)");
  db.prepare("INSERT INTO temp.n VALUES (?)").run(1);
  expect(db.prepare<{ x: number }, []>("SELECT x FROM temp.n").get()?.x).toBe(1);
  expect(typeof db.prepare<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version).toBe("number");
  expect(onReader).toEqual([]);
  expect(db.prepare<{ k: string; v: number }, []>("SELECT k, v FROM t").all()).toEqual([{ k: "d", v: 5 }]);
  db.close();
});

test("openReader: the reader is read-only, so a write misrouted to it fails loudly", () => {
  const { db, reader } = routed();
  expect(() => reader.query("INSERT INTO t VALUES ('e', 6)").run()).toThrow(/readonly/);
  db.close();
});

test("routeReads: closing the writer closes the reader, then checkpoints the WAL into the file", () => {
  const { db, reader } = routed();
  db.run("INSERT INTO t VALUES (?, ?)", ["f", 7]);
  expect(db.prepare<{ v: number }, [string]>("SELECT v FROM t WHERE k = ?").get("f")?.v).toBe(7);
  db.close();
  expect(() => reader.query("SELECT 1").get()).toThrow();
  expect(existsSync(join(dir, "a.db-wal"))).toBe(false);
});

test("routeReads: no reader statement holds a snapshot: each read after a commit sees it, whichever statement ran before", () => {
  const { db, onReader } = routed();
  const one = db.prepare<{ v: number }, [string]>("SELECT v FROM t WHERE k = ?");
  const all = db.prepare<{ n: number }, []>("SELECT count(*) AS n FROM t");
  expect(one.get("g")).toBeNull();
  expect(all.get()?.n).toBe(0);
  db.run("INSERT INTO t VALUES (?, ?)", ["g", 8]);
  expect(all.get()?.n).toBe(1);
  expect(one.get("g")?.v).toBe(8);
  db.prepare("UPDATE t SET v = ? WHERE k = ?").run(9, "g");
  expect(one.all("g")).toEqual([{ v: 9 }]);
  expect(all.values()).toEqual([[1]]);
  expect(new Set(onReader)).toEqual(new Set(["SELECT v FROM t WHERE k = ?", "SELECT count(*) AS n FROM t"]));
  db.close();
});

// #995: the write check exempts schema SQL only when every top-level statement is DDL; a trigger's body, literals
// and comments don't count, and CASE … END inside a body doesn't close it.
test("#995: checksWrite sees a write after a leading DDL statement, not one inside a trigger body or a literal", () => {
  expect(checksWrite("SELECT 1")).toBe(false);
  expect(checksWrite("DELETE FROM users WHERE id = ?")).toBe(true);
  expect(checksWrite("CREATE TABLE IF NOT EXISTS t(a)")).toBe(false);
  expect(checksWrite("CREATE TEMP TABLE x(a); DELETE FROM users")).toBe(true);
  expect(checksWrite("CREATE TEMP TABLE x(a);\n  INSERT INTO x(a) SELECT 0")).toBe(true);
  expect(checksWrite("CREATE TEMP TRIGGER g AFTER UPDATE ON users BEGIN UPDATE c SET n = n + 1; END")).toBe(false);
  expect(checksWrite(`CREATE TRIGGER r BEFORE UPDATE OF s ON users WHEN NEW.s = 'x' BEGIN
    UPDATE users SET s = CASE WHEN OLD.s IS NULL THEN 'a' ELSE 'b' END WHERE id = OLD.id;
    SELECT RAISE(IGNORE);
  END; DELETE FROM users`)).toBe(true);
  expect(checksWrite(`CREATE TRIGGER r BEFORE INSERT ON t BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'end; delete') END; END`)).toBe(false);
  expect(checksWrite("CREATE TABLE t(a TEXT DEFAULT 'x; DELETE FROM users') -- ; UPDATE users\n")).toBe(false);
  expect(checksWrite("CREATE TABLE t(a) /* ; INSERT INTO users */; DROP TABLE t")).toBe(false);
  // CASE … END inside a body doesn't close it: uncounted, the END after CASE would leave the UPDATE top-level.
  expect(checksWrite("CREATE TRIGGER r AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 1 END; UPDATE c SET n = 1; END")).toBe(false);
  // A comment is whitespace, not nothing; begin, end and trigger are identifiers too.
  expect(checksWrite("CREATE TABLE t(a); DELETE/**/FROM users")).toBe(true);
  expect(checksWrite("CREATE TABLE t(a); INSERT/**/INTO users VALUES (1)")).toBe(true);
  expect(checksWrite("CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE c SET begin = 1; END; DELETE FROM users")).toBe(true);
  expect(checksWrite("CREATE TRIGGER g AFTER UPDATE OF begin ON t BEGIN SELECT 1; END; DELETE FROM users")).toBe(true);
  expect(checksWrite("CREATE TABLE t(trigger, begin); DELETE FROM users")).toBe(true);
  // A body that never closes fails closed.
  expect(scriptStatements("CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE c SET n = 1;")).toBeNull();
  expect(checksWrite("CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE c SET n = 1;")).toBe(true);
  expect(scriptStatements("CREATE TABLE a(x); ; CREATE TABLE b(y);")!.map(s => s.trim())).toEqual(["CREATE TABLE a(x)", "CREATE TABLE b(y)"]);
});

// #1589: the test-only knob raises the busy timeout, capped; it never lowers it, and garbage is ignored.
test("BUS_TEST_BUSY_TIMEOUT_MS only raises the busy timeout, capped at 60 s", () => {
  for (const v of ["", "1000", "5000", "abc", "-1", "1e9x", "20000.5"]) expect(busyTimeoutMs(v)).toBe(5000);
  expect(busyTimeoutMs("20000")).toBe(20000);
  expect(busyTimeoutMs("999999")).toBe(60000);
});
