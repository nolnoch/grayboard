// #216: a 1.x mixed-case handle moves to its lowercase name at open, where that name is free.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openLocalDb } from "./open.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A bus whose rows a 1.x session `name` wrote: its handle, a DM each way, a
// claim, a cursor, a board subscription and a post.
function legacyBus(names: string[], extra?: (db: Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "gb-case-"));
  dirs.push(dir);
  const path = join(dir, "bus.db");
  const { db } = openLocalDb(path);
  const now = Date.now();
  db.prepare(`INSERT INTO boards (name, purpose, created_by, created_at) VALUES ('work', 'w', 'be', ?)`).run(now);
  for (const name of names) {
    db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES (?, ?, ?)`).run(name, now, now);
    db.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES ('be', ?, 'to you', ?)`).run(name, now);
    db.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, 'be', 'from you', ?)`).run(name, now);
    db.prepare(`INSERT INTO claims (key, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`).run(`ticket:${name}`, name, now, now + 3_600_000);
    db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES (?, 1)`).run(name);
    db.prepare(`INSERT INTO subscriptions (board, handle, mode, cursor, notified_id) VALUES ('work', ?, 'push', 0, 0)`).run(name);
    db.prepare(`INSERT INTO posts (board, author, body, created_at) VALUES ('work', ?, 'hi', ?)`).run(name, now);
  }
  extra?.(db);
  db.close();
  return path;
}

const count = (db: Database, sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const rowsUnder = (db: Database, h: string) => [
  count(db, `SELECT COUNT(*) AS n FROM handles WHERE name = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM aliases WHERE address = ? AND name = ?`, h, h),
  count(db, `SELECT COUNT(*) AS n FROM messages WHERE recipient = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM messages WHERE sender = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM claims WHERE holder = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM cursors WHERE reader = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM subscriptions WHERE handle = ?`, h),
  count(db, `SELECT COUNT(*) AS n FROM posts WHERE author = ?`, h),
];
const audits = (db: Database, action: string) =>
  (db.prepare(`SELECT target, detail FROM audit_log WHERE action = ? ORDER BY rowid`).all(action) as { target: string; detail: string }[])
    .map((r) => [r.target, JSON.parse(r.detail).from]);

test("a 1.x mixed-case handle's rows move to its lowercase name, once", () => {
  const path = legacyBus(["Gray"]);
  const { db } = openLocalDb(path);
  expect(rowsUnder(db, "Gray")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(rowsUnder(db, "gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  // The claim key is text, not an address: it stays as written.
  expect(count(db, `SELECT COUNT(*) AS n FROM claims WHERE key = 'ticket:Gray'`)).toBe(1);
  expect(audits(db, "alias.case_moved")).toEqual([["gray", "Gray"]]);
  db.close();
  const again = openLocalDb(path).db;
  expect(audits(again, "alias.case_moved")).toEqual([["gray", "Gray"]]);
  again.close();
});

test("a lowercase name already taken leaves the old one, reported once", () => {
  const path = legacyBus(["Gray", "gray"]);
  for (let i = 0; i < 2; i++) {
    const { db } = openLocalDb(path);
    expect(rowsUnder(db, "Gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(rowsUnder(db, "gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(audits(db, "alias.case_collision")).toEqual([["gray", "Gray"]]);
    db.close();
  }
});

test("a lowercase name taken only in a keyed table is a collision too", () => {
  const path = legacyBus(["Gray"], (db) => db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES ('gray', 5)`).run());
  const { db } = openLocalDb(path);
  expect(rowsUnder(db, "Gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(audits(db, "alias.case_collision")).toEqual([["gray", "Gray"]]);
  expect(audits(db, "alias.case_moved")).toEqual([]);
  db.close();
});

test("two spellings of one name: the first in byte order moves, the other collides", () => {
  const path = legacyBus(["Gray", "GRAY"]);
  const { db } = openLocalDb(path);
  expect(audits(db, "alias.case_moved")).toEqual([["gray", "GRAY"]]);
  expect(audits(db, "alias.case_collision")).toEqual([["gray", "Gray"]]);
  expect(rowsUnder(db, "Gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(rowsUnder(db, "gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  db.close();
});

test("a name the identity rule refuses stays as written", () => {
  const path = legacyBus(["Gray Fox"]);
  const { db } = openLocalDb(path);
  expect(rowsUnder(db, "Gray Fox")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(count(db, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'alias.case_%'`)).toBe(0);
  db.close();
});

test("the human flag moves with its handle", () => {
  const path = legacyBus(["Wade"], (db) => db.prepare(`UPDATE handles SET human = 1 WHERE name = 'Wade'`).run());
  const { db } = openLocalDb(path);
  expect(db.prepare(`SELECT address, human FROM aliases WHERE human = 1`).all()).toEqual([{ address: "wade", human: 1 }]);
  db.close();
});
