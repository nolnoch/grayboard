// The module's own store (docs/factory.md §6): what it must remember
// across restarts, apart from the bus database and on its own retention.
// A request is keyed by (source, id): the bus message or post id, the
// idempotency key. A redelivered request (a restart, a replay, a queue
// redelivery) finds its row and spawns nothing. DM and post ids are separate
// sequences, so the id alone would collide. `seq` orders the queue.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Key, Request } from "./delegate.ts";

// queued: waiting for a slot. running: a child is (or was, before a crash)
// working on it. finished: the outcome is in `reply`, sent when replied = 1.
export type State = "queued" | "running" | "finished";
export type Row = Request & { seq: number; agent: string; state: State; reply: string | null; replied: boolean; created_at: number; updated_at: number };

export class Store {
  private readonly db: Database;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      id INTEGER NOT NULL,
      board TEXT,
      requester TEXT NOT NULL,
      persona TEXT NOT NULL,
      task TEXT NOT NULL,
      context TEXT,
      agent TEXT NOT NULL,
      state TEXT NOT NULL,
      reply TEXT,
      replied INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source, id)
    )`);
  }

  // Records a request; false when its key is already known (a redelivery).
  admit(r: Request, agent: string): boolean {
    return this.insert(r, agent, "queued", null);
  }

  // Records an outcome that needs no spawn (a decline); false on a redelivery.
  admitFinished(r: Request, reply: string): boolean {
    return this.insert(r, "", "finished", reply);
  }

  private insert(r: Request, agent: string, state: State, reply: string | null): boolean {
    const t = this.now();
    const board = r.source === "board" ? r.board : null;
    const res = this.db.query(`INSERT OR IGNORE INTO requests (source, id, board, requester, persona, task, context, agent, state, reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.source, r.id, board, r.requester, r.persona, r.task, r.context ?? null, agent, state, reply, t, t);
    return res.changes === 1;
  }

  // The oldest queued request, now running; null when none waits.
  next(): Row | null {
    const row = this.db.query(`SELECT * FROM requests WHERE state = 'queued' ORDER BY seq LIMIT 1`).get() as Raw | null;
    if (!row) return null;
    this.db.query(`UPDATE requests SET state = 'running', updated_at = ? WHERE seq = ?`).run(this.now(), row.seq);
    return toRow({ ...row, state: "running" });
  }

  finish(k: Key, reply: string): void {
    this.db.query(`UPDATE requests SET state = 'finished', reply = ?, updated_at = ? WHERE source = ? AND id = ?`).run(reply, this.now(), k.source, k.id);
  }

  markReplied(k: Key): void {
    this.db.query(`UPDATE requests SET replied = 1, updated_at = ? WHERE source = ? AND id = ?`).run(this.now(), k.source, k.id);
  }

  // Queued requests admitted before this one.
  queuedAhead(k: Key): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE state = 'queued' AND seq < (SELECT seq FROM requests WHERE source = ? AND id = ?)`).get(k.source, k.id) as { n: number }).n;
  }

  // At start: a request left running had its child die with the previous
  // process, so it finishes as interrupted (re-running it unasked could
  // repeat side effects the child already had). Returns those rows.
  interrupted(reply: (r: Row) => string): Row[] {
    const rows = (this.db.query(`SELECT * FROM requests WHERE state = 'running'`).all() as Raw[]).map(toRow);
    for (const r of rows) this.finish(r, reply(r));
    return rows;
  }

  // Finished outcomes not yet sent (the send failed, or the process died first).
  unsent(): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE state = 'finished' AND replied = 0 ORDER BY seq`).all() as Raw[]).map(toRow);
  }

  get(k: Key): Row | null {
    const r = this.db.query(`SELECT * FROM requests WHERE source = ? AND id = ?`).get(k.source, k.id) as Raw | null;
    return r ? toRow(r) : null;
  }

  // Retention: replied rows older than `ms` go. The key must outlive any
  // redelivery of its message, which a replay does within a session's life,
  // so the default retention is generous (main.ts).
  prune(ms: number): number {
    return this.db.query(`DELETE FROM requests WHERE state = 'finished' AND replied = 1 AND updated_at < ?`).run(this.now() - ms).changes;
  }

  close(): void {
    this.db.close();
  }
}

type Fields = { seq: number; id: number; requester: string; persona: string; task: string; agent: string; state: State; reply: string | null; created_at: number; updated_at: number };
type Raw = Fields & { source: string; board: string | null; replied: number; context: string | null };
function toRow(r: Raw): Row {
  const { context, replied, source, board, ...rest } = r;
  const base = { ...rest, ...(context !== null ? { context } : {}), replied: replied === 1 };
  return source === "board" ? { ...base, source: "board", board: board ?? "" } : { ...base, source: "dm" };
}
