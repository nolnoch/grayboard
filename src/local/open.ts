// Opens (and creates or upgrades) a local-mode bus database. Separate from
// db.ts, which opens this process's bus on import, so the Slack bridge can open
// the bus its child will use.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { ANNOUNCE_BOARD, ensureBoard } from "../core/boards.ts";
import { holdsOf } from "../core/bindings.ts";
import { initCoreSchema } from "../core/schema.ts";
import { openSqlite } from "../core/sqlite.ts";
import { conversationSnapshot, liveSessions, type Ended, type SessionRow } from "./binding.ts";

export function localDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.BUS_DB_PATH ?? `${homedir()}/.claude-bus/bus.db`;
}

/** Title-only lookup: undefined means absent, null suppresses an unacknowledged/empty selection. */
export function readConversationTitle(session: string, env: Record<string, string | undefined> = process.env): string | null | undefined {
  const path = localDbPath(env);
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true });
  try {
    // A read transaction makes snapshot precedence and acquired holds one view;
    // never create, migrate or reap a bus just to name a transcript.
    return db.transaction(() => {
      if (conversationSnapshot(db, session) !== null) return null;
      const rows = db.prepare(`SELECT id FROM ids
        WHERE harness_session = ? AND ended_at IS NULL AND root_id IS NULL
          AND local_resume = 1 AND keyed = 0 AND viewer = 0 AND delivery = 'push'
        LIMIT 2`).all(session) as { id: string }[];
      if (!rows.length) return undefined;
      return rows.length === 1 ? holdsOf(db, rows[0]!.id)[0] ?? null : null;
    })();
  } finally { db.close(); }
}

/**
 * The bus, open, with the sessions this open ended and the live ones it
 * found: every opener ends the dead sessions it finds before serving (#284
 * decision 3), in its own transaction after the schema's. The caller passes
 * `ended` to deliverEnded (wakeup.ts) once it can await.
 */
export function openLocalDb(path = localDbPath()): { db: Database; ended: Ended; live: SessionRow[] } {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = openSqlite(path, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;", initLocalSchema);
  const { alive, ...ended } = liveSessions(db);
  return { db, ended, live: alive };
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
    -- facts are its ids row and the name it holds is alias_holds. name and
    -- bound_at mirror the hold, for 1.x processes sharing the file (their
    -- holder check reads them); harness and cwd are written only by 1.x.
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
  // kind: 'bounce' for a message returned by an ended ID (#284 decision 10);
  // null for an ordinary message.
  if (!msgCols.some((c) => c.name === "kind")) db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
  // delivered_at: when the message was handed to its recipient's harness (#470).
  if (!msgCols.some((c) => c.name === "delivered_at")) db.exec(`ALTER TABLE messages ADD COLUMN delivered_at INTEGER`);
  // via: the child session (a harness subagent, #523) that wrote it, acting
  // under its root's addresses; null for a root's own message.
  if (!msgCols.some((c) => c.name === "via")) db.exec(`ALTER TABLE messages ADD COLUMN via TEXT`);
  // The attachment model (#284 PR 2, S2). For a keyed session (BUS_SESSION_KEY)
  // pid + proc_start are its harness's, whose exit ends the session, and
  // attached_pid + attached_start are the grayboard mcp child serving it (null
  // while detached, after the child exited and before a restart re-attaches).
  // harness_rule: how the harness pid was found ('env': BUS_HARNESS_PID;
  // 'ancestor': the first non-launcher ancestor). All null for an unkeyed
  // session, whose own process is pid.
  const bindingCols = new Set((db.prepare(`PRAGMA table_info(bindings)`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [["attached_pid", "INTEGER"], ["attached_start", "TEXT"], ["detached_at", "INTEGER"], ["harness_rule", "TEXT"]] as const) {
    if (!bindingCols.has(col)) db.exec(`ALTER TABLE bindings ADD COLUMN ${col} ${type}`);
  }
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
