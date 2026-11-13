// The module's own store (docs/factory.md §6): what it must remember
// across restarts, apart from the bus database and on its own retention.
// A request is keyed by (source, id): the bus message or post id, the
// idempotency key. A redelivered request (a restart, a replay, a queue
// redelivery) finds its row and spawns nothing. DM and post ids are separate
// sequences, so the id alone would collide. `seq` orders the queue.
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Key, Request } from "./delegate.ts";
import type { RunMeta } from "./runner.ts";

// queued: waiting for a slot. running: a child is (or was, before a crash)
// working on it. waiting: its run returned a fan-out plan, and its subtasks
// (rows whose `parent` is its seq) are out. finished: the outcome is in
// `reply`, sent when replied = 1.
export type State = "queued" | "running" | "waiting" | "finished";
// run: the request itself (a fan-out-capable one when `fanout`). synthesize:
// a fanned-out request whose subtasks all finished, combining their results.
export type Phase = "run" | "synthesize";
export type Row = Request & {
  seq: number; agent: string; state: State; reply: string | null; replied: boolean; created_at: number; updated_at: number;
  phase: Phase; fanout: boolean; parent: number | null; title: string | null; fanoutBoard: string | null;
  profile: string | null; // a routed subtask's profile (#645); null runs as its project's lead
};
export type Admit = { fanout?: boolean; parent?: number; title?: string; profile?: string };
// A child process (#649): one per run of a request (a fanned-out request has
// two, its triage and its synthesis). `outcome` is null while it runs; a run
// cut off by a restart ends as interrupted. Its transcript is the file
// runs/<id>.jsonl beside the store, pruned with it.
export type RunOutcome = "ok" | "failed" | "timeout" | "budget" | "interrupted";
export type Run = { id: number; seq: number; agent: string; started_at: number; ended_at: number | null; code: number | null; session: string | null; turns: number | null; cost_usd: number | null; outcome: RunOutcome | null };

export class Store {
  private readonly db: Database;

  constructor(path: string, private readonly now: () => number = Date.now) {
    // The data directory holds tasks, replies and transcripts: the operator's only (#649).
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
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
      phase TEXT NOT NULL DEFAULT 'run',
      fanout INTEGER NOT NULL DEFAULT 0,
      parent INTEGER,
      title TEXT,
      fanout_board TEXT,
      profile TEXT,
      UNIQUE (source, id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL,
      agent TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      code INTEGER,
      session TEXT,
      turns INTEGER,
      cost_usd REAL,
      outcome TEXT
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS runs_seq ON runs (seq)`);
    // Additive (AGENTS.md): a store an earlier factory wrote gets the fan-out
    // columns, in one transaction with the check.
    this.db.transaction(() => {
      const cols = new Set((this.db.query(`PRAGMA table_info(requests)`).all() as { name: string }[]).map((c) => c.name));
      const add: [string, string][] = [["phase", "TEXT NOT NULL DEFAULT 'run'"], ["fanout", "INTEGER NOT NULL DEFAULT 0"], ["parent", "INTEGER"], ["title", "TEXT"], ["fanout_board", "TEXT"], ["profile", "TEXT"]];
      for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
    }).immediate();
  }

  // Records a request; false when its key is already known (a redelivery).
  admit(r: Request, agent: string, o: Admit = {}): boolean {
    return this.insert(r, agent, "queued", null, o);
  }

  // Records an outcome that needs no spawn (a decline); false on a redelivery.
  admitFinished(r: Request, reply: string): boolean {
    return this.insert(r, "", "finished", reply);
  }

  private insert(r: Request, agent: string, state: State, reply: string | null, o: Admit = {}): boolean {
    const t = this.now();
    const board = r.source === "board" ? r.board : null;
    const res = this.db.query(`INSERT OR IGNORE INTO requests (source, id, board, requester, persona, task, context, agent, state, reply, created_at, updated_at, fanout, parent, title, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.source, r.id, board, r.requester, r.persona, r.task, r.context ?? null, agent, state, reply, t, t, o.fanout ? 1 : 0, o.parent ?? null, o.title ?? null, o.profile ?? null);
    return res.changes === 1;
  }

  // A run that returned a plan: the request waits on its subtasks, admitted
  // in the same transaction, so a crash leaves both or neither.
  // A subtask runs as `agent` (its profile's, #645) when given, else as its parent's.
  fanOut(parent: Row, board: string, subtasks: { r: Request; title: string; profile?: string; agent?: string }[]): void {
    this.db.transaction(() => {
      this.db.query(`UPDATE requests SET state = 'waiting', fanout_board = ?, updated_at = ? WHERE seq = ?`).run(board, this.now(), parent.seq);
      for (const s of subtasks) this.insert(s.r, s.agent ?? parent.agent, "queued", null, { parent: parent.seq, title: s.title, ...(s.profile ? { profile: s.profile } : {}) });
    })();
  }

  // A waiting request's subtasks, in posting order.
  subtasks(parent: number): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE parent = ? ORDER BY seq`).all(parent) as Raw[]).map(toRow);
  }

  // Once every subtask of a waiting request has finished, queues the
  // request again to synthesize; true when it did.
  synthesizeWhenDone(parent: number): boolean {
    const open = (this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE parent = ? AND state != 'finished'`).get(parent) as { n: number }).n;
    if (open) return false;
    return this.db.query(`UPDATE requests SET state = 'queued', phase = 'synthesize', updated_at = ? WHERE seq = ? AND state = 'waiting'`).run(this.now(), parent).changes === 1;
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

  // A run of the request `seq` starts; returns its id.
  startRun(seq: number, agent: string): number {
    return Number(this.db.query(`INSERT INTO runs (seq, agent, started_at) VALUES (?, ?, ?)`).run(seq, agent, this.now()).lastInsertRowid);
  }

  endRun(id: number, outcome: RunOutcome, m: Partial<RunMeta> = {}): void {
    this.db.query(`UPDATE runs SET ended_at = ?, outcome = ?, code = ?, session = ?, turns = ?, cost_usd = ? WHERE id = ?`)
      .run(this.now(), outcome, m.code ?? null, m.session ?? null, m.turns ?? null, m.costUsd ?? null, id);
  }

  // The request's runs, oldest first.
  runs(seq: number): Run[] {
    return this.db.query(`SELECT * FROM runs WHERE seq = ? ORDER BY id`).all(seq) as Run[];
  }

  // Whether the store still holds run `id`: a transcript is swept once its run's row is gone.
  hasRun(id: number): boolean {
    return this.db.query(`SELECT 1 FROM runs WHERE id = ?`).get(id) !== null;
  }

  // At start: a row left running had its child die with the previous
  // process, so it finishes as interrupted (re-running it unasked could
  // repeat side effects the child already had). Returns those rows. Nothing
  // else is lost: a fanned-out request stays waiting, and its subtasks still
  // queued never started, so they run as before (#642). A subtask that was
  // cut off counts as finished, and once its siblings are done the parent
  // synthesizes with the interruption in its results.
  interrupted(reply: (r: Row) => string): Row[] {
    const rows = (this.db.query(`SELECT * FROM requests WHERE state = 'running' ORDER BY seq`).all() as Raw[]).map(toRow);
    this.db.transaction(() => {
      for (const r of rows) this.finish(r, reply(r));
      this.db.query(`UPDATE runs SET ended_at = ?, outcome = 'interrupted' WHERE outcome IS NULL`).run(this.now());
      // Every waiting parent, not only those of the rows above: a crash
      // between a subtask's finish and its parent's check strands one too.
      for (const { seq } of this.db.query(`SELECT seq FROM requests WHERE state = 'waiting'`).all() as { seq: number }[]) this.synthesizeWhenDone(seq);
    }).immediate();
    return rows;
  }

  // Finished outcomes not yet sent (the send failed, or the process died first).
  unsent(): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE state = 'finished' AND replied = 0 ORDER BY seq`).all() as Raw[]).map(toRow);
  }

  // Whether the store still holds the row with this seq: a working
  // directory's tree (#641) is swept once its request's row is gone.
  has(seq: number): boolean {
    return this.db.query(`SELECT 1 FROM requests WHERE seq = ?`).get(seq) !== null;
  }

  get(k: Key): Row | null {
    const r = this.db.query(`SELECT * FROM requests WHERE source = ? AND id = ?`).get(k.source, k.id) as Raw | null;
    return r ? toRow(r) : null;
  }

  // Retention: replied rows older than `ms` go. The key must outlive any
  // redelivery of its message, which a replay does within a session's life,
  // so the default retention is generous (main.ts).
  // A pruned request's runs go with it.
  prune(ms: number): number {
    return this.db.transaction(() => {
      const n = this.db.query(`DELETE FROM requests WHERE state = 'finished' AND replied = 1 AND updated_at < ?`).run(this.now() - ms).changes;
      this.db.query(`DELETE FROM runs WHERE seq NOT IN (SELECT seq FROM requests)`).run();
      return n;
    }).immediate();
  }

  close(): void {
    this.db.close();
  }
}

type Fields = { seq: number; id: number; requester: string; persona: string; task: string; agent: string; state: State; reply: string | null; created_at: number; updated_at: number; phase: Phase; parent: number | null; title: string | null; profile: string | null };
type Raw = Fields & { source: string; board: string | null; replied: number; context: string | null; fanout: number; fanout_board: string | null };
function toRow(r: Raw): Row {
  const { context, replied, source, board, fanout, fanout_board, ...rest } = r;
  const base = { ...rest, ...(context !== null ? { context } : {}), replied: replied === 1, fanout: fanout === 1, fanoutBoard: fanout_board };
  return source === "board" ? { ...base, source: "board", board: board ?? "" } : { ...base, source: "dm" };
}
