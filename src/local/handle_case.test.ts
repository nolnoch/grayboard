// #216: a 1.x mixed-case handle moves to its lowercase name at open, merging into it where it exists.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { lowercaseLegacyHandles } from "./handle_case.ts";
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

test("every address column moves", () => {
  const path = legacyBus(["Gray"], (db) => {
    const now = Date.now();
    const post = (db.prepare(`SELECT id FROM posts WHERE author = 'Gray'`).get() as { id: number }).id;
    const msg = (db.prepare(`SELECT id FROM messages WHERE recipient = 'Gray'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO boards (name, purpose, created_by, created_at, archived_at, archived_by) VALUES ('old', 'o', 'Gray', ?1, ?1, 'Gray')`).run(now);
    db.prepare(`INSERT INTO outbox (handle, post_id, reason) VALUES ('Gray', ?, 'mention')`).run(post);
    db.prepare(`INSERT INTO thread_mutes (handle, root_id) VALUES ('Gray', ?)`).run(post);
    db.prepare(`INSERT INTO claim_watches (key, handle) VALUES ('ticket:x', 'Gray')`).run();
    db.prepare(`INSERT INTO claim_events (key, handle, event, held_by, at) VALUES ('ticket:x', 'Gray', 'taken', 'Gray', ?)`).run(now);
    db.prepare(`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES ('ab', 1, ?)`).run(now);
    db.prepare(`INSERT INTO attachments (sha256, filename, type, size, uploader, message_id, created_at) VALUES ('ab', 'f', 'text/plain', 1, 'Gray', ?, ?)`).run(msg, now);
    db.prepare(`INSERT INTO dm_acks (reader, message_id, acked_at) VALUES ('Gray', ?, ?)`).run(msg, now);
    db.prepare(`INSERT INTO alias_holds (address, id, bound_at) VALUES ('Gray', 'id:x', ?)`).run(now);
  });
  const { db } = openLocalDb(path);
  const columns = [
    ["handles", "name"], ["aliases", "address"], ["aliases", "name"], ["alias_holds", "address"],
    ["boards", "created_by"], ["boards", "archived_by"], ["posts", "author"],
    ["subscriptions", "handle"], ["outbox", "handle"], ["thread_mutes", "handle"],
    ["claims", "holder"], ["claim_watches", "handle"], ["claim_events", "handle"], ["claim_events", "held_by"],
    ["attachments", "uploader"], ["messages", "sender"], ["messages", "recipient"],
    ["cursors", "reader"], ["dm_acks", "reader"],
  ];
  const under = (h: string) => columns.map(([t, c]) => `${t}.${c}=${count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, h)}`);
  expect(under("Gray")).toEqual(columns.map(([t, c]) => `${t}.${c}=0`));
  expect(under("gray").filter((x) => x.endsWith("=0"))).toEqual([]);
  db.close();
});

test("an existing lowercase name absorbs the old one; its own keyed rows win", () => {
  const path = legacyBus(["Gray", "gray"], (db) => {
    db.prepare(`UPDATE cursors SET last_seen_id = 9 WHERE reader = 'gray'`).run();
    db.prepare(`UPDATE subscriptions SET mode = 'quiet' WHERE handle = 'gray'`).run();
  });
  const { db } = openLocalDb(path);
  expect(rowsUnder(db, "Gray")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  // One row per name where a key holds one; both names' DMs, claims and posts.
  expect(rowsUnder(db, "gray")).toEqual([1, 1, 2, 2, 2, 1, 1, 2]);
  // The lower cursor, with each name's DMs up to its own cursor stamped delivered.
  expect(db.prepare(`SELECT last_seen_id FROM cursors WHERE reader = 'gray'`).get()).toEqual({ last_seen_id: 1 });
  expect(count(db, `SELECT COUNT(*) AS n FROM messages WHERE recipient = 'gray' AND delivered_at IS NULL`)).toBe(0);
  expect(db.prepare(`SELECT mode FROM subscriptions WHERE handle = 'gray'`).get()).toEqual({ mode: "quiet" });
  expect(db.prepare(`SELECT detail FROM audit_log WHERE action = 'alias.case_moved'`).all().map((r: any) => JSON.parse(r.detail))).toEqual([{ from: "Gray", merged: true }]);
  expect(audits(db, "alias.case_collision")).toEqual([]);
  db.close();
});

test("a 1.x session writing the old name again after the move merges at the next open", () => {
  const path = legacyBus(["Gray"]);
  openLocalDb(path).db.close();
  const { db: old } = openLocalDb(path);
  old.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('Gray', 1, 1)`).run();
  old.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES ('be', 'Gray', 'later', 1)`).run();
  old.close();
  const { db } = openLocalDb(path);
  expect(count(db, `SELECT COUNT(*) AS n FROM messages WHERE recipient = 'Gray'`)).toBe(0);
  expect(count(db, `SELECT COUNT(*) AS n FROM messages WHERE recipient = 'gray'`)).toBe(2);
  expect(count(db, `SELECT COUNT(*) AS n FROM handles WHERE name = 'Gray'`)).toBe(0);
  expect(audits(db, "alias.case_moved")).toEqual([["gray", "Gray"], ["gray", "Gray"]]);
  expect(audits(db, "alias.case_collision")).toEqual([]);
  db.close();
});

test("two spellings of one name: the most recently seen moves, the other merges into it", () => {
  const path = legacyBus(["Gray", "GRAY"], (db) => {
    db.prepare(`UPDATE handles SET last_seen = 1 WHERE name = 'GRAY'`).run();
    db.prepare(`UPDATE aliases SET last_seen = 1 WHERE address = 'GRAY'`).run();
  });
  const { db } = openLocalDb(path);
  expect(db.prepare(`SELECT detail FROM audit_log WHERE action = 'alias.case_moved' ORDER BY rowid`).all().map((r: any) => JSON.parse(r.detail)))
    .toEqual([{ from: "Gray", merged: false }, { from: "GRAY", merged: true }]);
  expect(rowsUnder(db, "Gray")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(rowsUnder(db, "GRAY")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(rowsUnder(db, "gray")).toEqual([1, 1, 2, 2, 2, 1, 1, 2]);
  db.close();
});

test("a human and a non-human never merge: a collision, reported once", () => {
  const path = legacyBus(["Alex", "alex"], (db) => db.prepare(`UPDATE handles SET human = 1 WHERE name = 'alex'`).run());
  for (let i = 0; i < 2; i++) {
    const { db } = openLocalDb(path);
    expect(rowsUnder(db, "Alex")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(rowsUnder(db, "alex")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(audits(db, "alias.case_collision")).toEqual([["alex", "Alex"]]);
    expect(audits(db, "alias.case_moved")).toEqual([]);
    db.close();
  }
});

test("a name invalid after lowercasing, or the reserved human, stays and is reported", () => {
  const path = legacyBus(["Gray Fox", "Human"]);
  const { db } = openLocalDb(path);
  expect(rowsUnder(db, "Gray Fox")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(rowsUnder(db, "Human")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(audits(db, "alias.case_collision").sort()).toEqual([["gray fox", "Gray Fox"], ["human", "Human"]]);
  expect(audits(db, "alias.case_moved")).toEqual([]);
  db.close();
});

test("the human flag moves with its handle", () => {
  const path = legacyBus(["Alex"], (db) => db.prepare(`UPDATE handles SET human = 1 WHERE name = 'Alex'`).run());
  const { db } = openLocalDb(path);
  expect(db.prepare(`SELECT address, human FROM aliases WHERE human = 1`).all()).toEqual([{ address: "alex", human: 1 }]);
  db.close();
});

test("a notice prints only once its move commits", () => {
  const { db } = openLocalDb(legacyBus([]));
  db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('Gray', 1, 1)`).run();
  const lines: string[] = [];
  expect(() => db.transaction(() => { lowercaseLegacyHandles(db, (l) => lines.push(l)); throw new Error("later step"); })()).toThrow("later step");
  expect(lines).toEqual([]);
  expect(count(db, `SELECT COUNT(*) AS n FROM handles WHERE name = 'Gray'`)).toBe(1);
  db.transaction(() => lowercaseLegacyHandles(db, (l) => lines.push(l)))();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(`"Gray" is now "gray"`);
  db.close();
});

// #1189
test("a repeat merge after a 1.x re-write audits again but prints no second notice, and wakes the name", () => {
  const path = legacyBus(["Gray"]);
  const first = openLocalDb(path);
  expect(first.ended.wake).toContain("gray");
  first.db.close();
  const { db: old } = openLocalDb(path);
  old.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('Gray', 1, 1)`).run();
  old.close();
  const { db, ended } = openLocalDb(path);
  expect(ended.wake).toContain("gray");
  db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('Gray', 1, 1)`).run();
  const lines: string[] = [];
  db.transaction(() => lowercaseLegacyHandles(db, (l) => lines.push(l)))();
  expect(lines).toEqual([]);
  expect(audits(db, "alias.case_moved")).toEqual([["gray", "Gray"], ["gray", "Gray"], ["gray", "Gray"]]);
  db.close();
});

test("an open that moves nothing wakes nothing for it", () => {
  const { db, ended } = openLocalDb(legacyBus(["gray"]));
  expect(ended.wake).not.toContain("gray");
  db.close();
});

test("a 1.x human named Human moves to human; an agent named Human doesn't", () => {
  const human = legacyBus(["Human"], (db) => db.prepare(`UPDATE handles SET human = 1 WHERE name = 'Human'`).run());
  const a = openLocalDb(human).db;
  expect(a.prepare(`SELECT address, human FROM aliases WHERE human = 1`).all()).toEqual([{ address: "human", human: 1 }]);
  expect(audits(a, "alias.case_collision")).toEqual([]);
  a.close();
  const agent = openLocalDb(legacyBus(["Human"])).db;
  expect(audits(agent, "alias.case_collision")).toEqual([["human", "Human"]]);
  agent.close();
});

test("a statement that fails mid-move rolls that name back and reports it; the open succeeds", () => {
  const path = legacyBus(["Gray", "Blue"], (db) =>
    db.exec(`CREATE TRIGGER forced BEFORE UPDATE OF holder ON claims WHEN NEW.holder = 'gray' BEGIN SELECT RAISE(ABORT, 'forced'); END`));
  const { db, ended } = openLocalDb(path);
  expect(rowsUnder(db, "Gray")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(rowsUnder(db, "gray")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(rowsUnder(db, "blue")).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(audits(db, "alias.case_collision")).toEqual([["gray", "Gray"]]);
  expect(ended.wake).toContain("blue");
  expect(ended.wake).not.toContain("gray");
  db.close();
});

test("both names on one key: the union keeps one row each", () => {
  const path = legacyBus(["Gray", "gray"], (db) => {
    const now = Date.now();
    const post = (db.prepare(`SELECT id FROM posts WHERE author = 'gray'`).get() as { id: number }).id;
    const msg = (db.prepare(`SELECT id FROM messages WHERE recipient = 'gray'`).get() as { id: number }).id;
    for (const h of ["Gray", "gray"]) {
      db.prepare(`INSERT INTO outbox (handle, post_id, reason) VALUES (?, ?, 'mention')`).run(h, post);
      db.prepare(`INSERT INTO thread_mutes (handle, root_id) VALUES (?, ?)`).run(h, post);
      db.prepare(`INSERT INTO claim_watches (key, handle) VALUES ('ticket:x', ?)`).run(h);
      db.prepare(`INSERT INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, ?)`).run(h, msg, now);
    }
    db.prepare(`INSERT INTO claim_watches (key, handle) VALUES ('ticket:only-old', 'Gray')`).run();
  });
  const { db } = openLocalDb(path);
  for (const [t, c] of [["outbox", "handle"], ["thread_mutes", "handle"], ["claim_watches", "handle"], ["dm_acks", "reader"]]) {
    expect([t, count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = 'Gray'`)]).toEqual([t, 0]);
  }
  expect(count(db, `SELECT COUNT(*) AS n FROM outbox WHERE handle = 'gray'`)).toBe(1);
  expect(count(db, `SELECT COUNT(*) AS n FROM thread_mutes WHERE handle = 'gray'`)).toBe(1);
  expect(count(db, `SELECT COUNT(*) AS n FROM claim_watches WHERE handle = 'gray'`)).toBe(2);
  expect(count(db, `SELECT COUNT(*) AS n FROM dm_acks WHERE reader = 'gray'`)).toBe(1);
  db.close();
});
