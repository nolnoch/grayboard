import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { initCoreSchema } from "../core/schema.ts";

const DB_PATH = process.env.BUS_DB_PATH ?? `${homedir()}/.claude-bus/bus.db`;

function openDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender      TEXT    NOT NULL,
      recipient   TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      parent_id   INTEGER REFERENCES messages(id),
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient, id);
    CREATE TABLE IF NOT EXISTS cursors (
      reader        TEXT PRIMARY KEY,
      last_seen_id  INTEGER NOT NULL
    );
  `);
  initCoreSchema(db);
  // The handles roster arrived after the bus did. Backfill identities that have
  // run a session (sent, read, posted, or subscribed) so peer_list shows them
  // and dm_send accepts them. Recipients alone don't count: that would
  // legitimize old typos.
  db.exec(`
    INSERT OR IGNORE INTO handles (name, first_seen, last_seen)
    SELECT h, MIN(t), MAX(t) FROM (
      SELECT sender AS h, created_at AS t FROM messages
      UNION ALL
      SELECT c.reader, COALESCE(m.created_at, 0) FROM cursors c LEFT JOIN messages m ON m.id = c.last_seen_id
      UNION ALL
      SELECT author, created_at FROM posts
      UNION ALL
      SELECT handle, 0 FROM subscriptions
    ) GROUP BY h;
  `);
  return db;
}

export const db = openDb();

export type Message = {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  parent_id: number | null;
  created_at: number;
};

export function insertMessage(
  sender: string,
  recipient: string,
  body: string,
  parent_id: number | null,
): number {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (sender, recipient, body, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sender, recipient, body, parent_id, now);
  return Number(lastInsertRowid);
}

export function unreadFor(reader: string): Message[] {
  const cursor = getCursor(reader);
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE recipient = ? AND id > ?
       ORDER BY id ASC`,
    )
    .all(reader, cursor) as Message[];
}

export function getCursor(reader: string): number {
  const row = db
    .prepare(`SELECT last_seen_id FROM cursors WHERE reader = ?`)
    .get(reader) as { last_seen_id: number } | undefined;
  return row?.last_seen_id ?? 0;
}

export function setCursor(reader: string, last_seen_id: number): void {
  db.prepare(
    `INSERT INTO cursors (reader, last_seen_id)
     VALUES (?, ?)
     ON CONFLICT(reader) DO UPDATE SET last_seen_id = excluded.last_seen_id
     WHERE excluded.last_seen_id > cursors.last_seen_id`,
  ).run(reader, last_seen_id);
}

export function getMessage(id: number): Message | undefined {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | Message
    | undefined;
}

// The whole thread containing message `id`: walk up to its root, then down.
export function getThread(id: number): Message[] {
  return db
    .prepare(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM messages WHERE id = ?
         UNION ALL
         SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
       ),
       thread AS (
         SELECT * FROM messages WHERE id = (SELECT id FROM up WHERE parent_id IS NULL)
         UNION ALL
         SELECT m.* FROM messages m
         JOIN thread t ON m.parent_id = t.id
       )
       SELECT * FROM thread ORDER BY id ASC`,
    )
    .all(id) as Message[];
}

export function getHistory(
  identity: string,
  peer: string | undefined,
  limit: number,
  beforeId: number | undefined,
): Message[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  if (peer) {
    clauses.push(
      `((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`,
    );
    args.push(identity, peer, peer, identity);
  } else {
    clauses.push(`(sender = ? OR recipient = ?)`);
    args.push(identity, identity);
  }

  if (beforeId !== undefined) {
    clauses.push(`id < ?`);
    args.push(beforeId);
  }

  const sql = `
    SELECT * FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
  `;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Message[];
  return rows.reverse();
}
