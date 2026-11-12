// The module's own store (docs/factory.md §6): what it must remember
// across restarts, apart from the bus database and on its own retention.
// The request id is the bus message id, the idempotency key: a redelivered
// request (a restart, a replay) finds its row and spawns nothing.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "./delegate.ts";

// queued: waiting for a slot. running: a child is (or was, before a crash)
// working on it. finished: the outcome is in `reply`, sent when replied = 1.
export type State = "queued" | "running" | "finished";
export type Row = Request & { agent: string; state: State; reply: string | null; replied: boolean; created_at: number; updated_at: number };

export class Store {
  private readonly db: Database;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      requester TEXT NOT NULL,
      persona TEXT NOT NULL,
      task TEXT NOT NULL,
      context TEXT,
      agent TEXT NOT NULL,
      state TEXT NOT NULL,
      reply TEXT,
      replied INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  // Records a request; false when its id is already known (a redelivery).
  admit(r: Request, agent: string): boolean {
    const t = this.now();
    const res = this.db.query(`INSERT OR IGNORE INTO requests (id, requester, persona, task, context, agent, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(r.id, r.requester, r.persona, r.task, r.context ?? null, agent, t, t);
    return res.changes === 1;
  }

  // Records an outcome that needs no spawn (a decline); false on a redelivery.
  admitFinished(r: Request, reply: string): boolean {
    const t = this.now();
    const res = this.db.query(`INSERT OR IGNORE INTO requests (id, requester, persona, task, context, agent, state, reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'finished', ?, ?, ?)`)
      .run(r.id, r.requester, r.persona, r.task, r.context ?? null, reply, t, t);
    return res.changes === 1;
  }

  // The oldest queued request, now running; null when none waits.
  next(): Row | null {
    const row = this.db.query(`SELECT * FROM requests WHERE state = 'queued' ORDER BY id LIMIT 1`).get() as Raw | null;
    if (!row) return null;
    this.db.query(`UPDATE requests SET state = 'running', updated_at = ? WHERE id = ?`).run(this.now(), row.id);
    return toRow({ ...row, state: "running" });
  }

  finish(id: number, reply: string): void {
    this.db.query(`UPDATE requests SET state = 'finished', reply = ?, updated_at = ? WHERE id = ?`).run(reply, this.now(), id);
  }

  markReplied(id: number): void {
    this.db.query(`UPDATE requests SET replied = 1, updated_at = ? WHERE id = ?`).run(this.now(), id);
  }

  queuedAhead(id: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE state = 'queued' AND id < ?`).get(id) as { n: number }).n;
  }

  // At start: a request left running had its child die with the previous
  // process, so it finishes as interrupted (re-running it unasked could
  // repeat side effects the child already had). Returns those rows.
  interrupted(reply: (r: Row) => string): Row[] {
    const rows = (this.db.query(`SELECT * FROM requests WHERE state = 'running'`).all() as Raw[]).map(toRow);
    for (const r of rows) this.finish(r.id, reply(r));
    return rows;
  }

  // Finished outcomes not yet sent (the send failed, or the process died first).
  unsent(): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE state = 'finished' AND replied = 0 ORDER BY id`).all() as Raw[]).map(toRow);
  }

  get(id: number): Row | null {
    const r = this.db.query(`SELECT * FROM requests WHERE id = ?`).get(id) as Raw | null;
    return r ? toRow(r) : null;
  }

  // Retention: replied rows older than `ms` go. The id must outlive any
  // redelivery of its message, which a replay does within a session's life,
  // so the default retention is generous (main.ts).
  prune(ms: number): number {
    return this.db.query(`DELETE FROM requests WHERE state = 'finished' AND replied = 1 AND updated_at < ?`).run(this.now() - ms).changes;
  }

  close(): void {
    this.db.close();
  }
}

type Raw = Omit<Row, "replied" | "context"> & { replied: number; context: string | null };
function toRow(r: Raw): Row {
  const { context, replied, ...rest } = r;
  return { ...rest, ...(context !== null ? { context } : {}), replied: replied === 1 };
}
