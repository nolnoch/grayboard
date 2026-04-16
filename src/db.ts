import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const DB_PATH = process.env.BUS_DB_PATH ?? `${homedir()}/.claude-bus/bus.db`;

function openDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
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

export function getThread(rootId: number): Message[] {
  return db
    .prepare(
      `WITH RECURSIVE thread AS (
         SELECT * FROM messages WHERE id = ?
         UNION ALL
         SELECT m.* FROM messages m
         JOIN thread t ON m.parent_id = t.id
       )
       SELECT * FROM thread ORDER BY id ASC`,
    )
    .all(rootId) as Message[];
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
