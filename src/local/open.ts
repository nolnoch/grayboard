// Opens (and creates or upgrades) a local-mode bus database. Separate from
// db.ts, which opens this process's bus on import, so the Slack bridge can open
// the bus its child will use.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { ANNOUNCE_BOARD, ensureBoard } from "../core/boards.ts";
import { initCoreSchema } from "../core/schema.ts";

export function localDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.BUS_DB_PATH ?? `${homedir()}/.claude-bus/bus.db`;
}

export function openLocalDb(path = localDbPath()): Database {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path);
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
    -- Received messages marked handled without a reply (dm_ack).
    CREATE TABLE IF NOT EXISTS dm_acks (
      reader      TEXT NOT NULL,
      message_id  INTEGER NOT NULL,
      acked_at    INTEGER NOT NULL,
      PRIMARY KEY (reader, message_id)
    );
    -- Local DM delivery claims: the first lane to drain a message inserts
    -- its row and is the one that delivers it; siblings see the row and skip.
    -- delivered_at marks the message reached an agent — the unit of truth:
    -- the claim only reserves, the marker decides. The row persists after
    -- delivery as the marker that keeps a slower sibling's scan from
    -- re-delivering (it is never released on success — releasing would
    -- reopen the duplicate window); a row past its TTL (the claimer crashed
    -- mid-handle) is taken over by another lane, DELIVERED rows are pruned
    -- after a day, and an undelivered row is never pruned — it holds the
    -- identity's read point until some lane takes it over and delivers it.
    -- Delivery is at-least-once at the claim level, exactly-once per attempt.
    CREATE TABLE IF NOT EXISTS dm_claims (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      claimer    TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
  `);
  // dm_claims.delivered_at, added after the claims themselves (D1: the
  // marker that keeps a crashed claimer's message from being lost).
  const claimCols = db.prepare(`PRAGMA table_info(dm_claims)`).all() as { name: string }[];
  if (!claimCols.some((c) => c.name === "delivered_at")) db.exec(`ALTER TABLE dm_claims ADD COLUMN delivered_at INTEGER`);
  // dm_send pending: the sender owes a follow-up in the thread.
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
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
    ) WHERE h NOT LIKE '~%' GROUP BY h;
    -- Earlier builds backfilled tail viewers (~tail-<pid>) as peers.
    DELETE FROM handles WHERE name LIKE '~%';
  `);
  ensureBoard(db, ANNOUNCE_BOARD, "Your user's announcements to every live session. Only a human starts posts here; reply in the thread to acknowledge.", null, "grayboard");
  return db;
}
