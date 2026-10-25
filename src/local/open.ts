// Opens (and creates or upgrades) a local-mode bus database. Separate from
// db.ts, which opens this process's bus on import, so the Slack bridge can open
// the bus its child will use.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { ANNOUNCE_BOARD, ensureBoard } from "../core/boards.ts";
import { initCoreSchema } from "../core/schema.ts";
import { openSqlite } from "../core/sqlite.ts";

export function localDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.BUS_DB_PATH ?? `${homedir()}/.claude-bus/bus.db`;
}

export function openLocalDb(path = localDbPath()): Database {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return openSqlite(path, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;", initLocalSchema);
}

function initLocalSchema(db: Database): void {
  db.exec(`
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
    -- One row per live grayboard mcp process (binding.ts, #182): local
    -- liveness. pid + proc_start say whether the session still runs;
    -- harness_pid is the process that launched it. Since #284 the session's
    -- facts are its ids row and the name it holds is alias_holds; name,
    -- harness, cwd and bound_at are written only by 1.x processes.
    CREATE TABLE IF NOT EXISTS bindings (
      session_id   TEXT PRIMARY KEY,
      name         TEXT UNIQUE,
      pid          INTEGER NOT NULL,
      proc_start   TEXT,
      harness      TEXT,
      harness_pid  INTEGER,
      cwd          TEXT,
      started_at   INTEGER NOT NULL,
      bound_at     INTEGER
    );
    -- When a session last ran retention (retention.ts); one row.
    CREATE TABLE IF NOT EXISTS retention_runs (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      last_run  INTEGER NOT NULL
    );
  `);
  // dm_send pending: the sender owes a follow-up in the thread. sender_id:
  // the sending session's ID (#284), beside the address it sent as; null for
  // messages from before it, and for writers with no session.
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
  if (!msgCols.some((c) => c.name === "sender_id")) db.exec(`ALTER TABLE messages ADD COLUMN sender_id TEXT`);
  initCoreSchema(db);
  // Every 1.x handle is an alias (#284), with its durable facts. Seeded on
  // every open, not once: a 1.x grayboard sharing this file may still add
  // handles, and local mode never deletes an alias, so none comes back.
  db.exec(`
    INSERT OR IGNORE INTO aliases (address, scope_kind, scope_ref, name, human, queue_off, created_at, last_seen)
    SELECT name, 'person', NULL, name, human, queue_off, first_seen, last_seen FROM handles WHERE name NOT LIKE '~%';
  `);
  ensureBoard(db, ANNOUNCE_BOARD, "Your user's announcements to every live session. Only a human starts posts here; reply in the thread to acknowledge.", null, "grayboard");
}
