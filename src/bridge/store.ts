// The Slack bridge's own SQLite file: which Slack thread holds which grayboard
// thread, and an outbox of notifications not yet posted to Slack. Separate
// from the bus database, so the bus schema never carries bridge state.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ThreadKind = "dm" | "board";

export type ThreadRow = {
  thread_ts: string;
  kind: ThreadKind;
  board: string | null;
  root_id: number;
  peer: string | null;
  last_id: number;
};

export type OutboxRow = { id: number; params: string };

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:" && !existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      -- thread_ts: the Slack top-level message's ts. root_id: the grayboard
      -- thread's root (message id for dm, post id for board). peer: the agent
      -- in a dm thread. last_id: the newest grayboard id seen in the thread,
      -- the parent for the next reply from Slack.
      CREATE TABLE IF NOT EXISTS threads (
        thread_ts  TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('dm','board')),
        board      TEXT NOT NULL DEFAULT '',
        root_id    INTEGER NOT NULL,
        peer       TEXT,
        last_id    INTEGER NOT NULL,
        UNIQUE (kind, board, root_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        params      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        done_at     INTEGER,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(done_at, id);
    `);
  }

  thread(kind: ThreadKind, board: string | null, rootId: number): ThreadRow | undefined {
    const r = this.db
      .prepare(`SELECT * FROM threads WHERE kind = ? AND board = ? AND root_id = ?`)
      .get(kind, board ?? "", rootId) as ThreadRow | undefined;
    return r && fromDb(r);
  }

  byTs(threadTs: string): ThreadRow | undefined {
    const r = this.db.prepare(`SELECT * FROM threads WHERE thread_ts = ?`).get(threadTs) as ThreadRow | undefined;
    return r && fromDb(r);
  }

  addThread(t: ThreadRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO threads (thread_ts, kind, board, root_id, peer, last_id) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.thread_ts, t.kind, t.board ?? "", t.root_id, t.peer, t.last_id);
  }

  /** Move a thread's reply target forward; never back. */
  advance(threadTs: string, id: number): void {
    this.db.prepare(`UPDATE threads SET last_id = MAX(last_id, ?) WHERE thread_ts = ?`).run(id, threadTs);
  }

  enqueue(params: unknown): number {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO outbox (params, created_at) VALUES (?, ?)`)
      .run(JSON.stringify(params), Date.now());
    return Number(lastInsertRowid);
  }

  pending(): OutboxRow[] {
    return this.db.prepare(`SELECT id, params FROM outbox WHERE done_at IS NULL ORDER BY id`).all() as OutboxRow[];
  }

  /** Posted, or given up on (error says why). */
  done(id: number, error: string | null = null): void {
    this.db.prepare(`UPDATE outbox SET done_at = ?, error = ? WHERE id = ?`).run(Date.now(), error, id);
  }

  close(): void {
    this.db.close();
  }
}

function fromDb(r: ThreadRow): ThreadRow {
  return { ...r, board: r.board || null };
}
