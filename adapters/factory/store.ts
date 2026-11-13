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
// `reply`, sent when replied = 1. asking (#652): its run ended on a
// question (`question`), and it holds no slot until an answer queues it again
// to resume (`resume` = 1, the answer in `answer`).
export type State = "queued" | "running" | "waiting" | "asking" | "finished";
// run: the request itself (a fan-out-capable one when `fanout`). synthesize:
// a fanned-out request whose subtasks all finished, combining their results.
export type Phase = "run" | "synthesize";
export type Row = Request & {
  seq: number; agent: string; state: State; reply: string | null; replied: boolean; created_at: number; updated_at: number;
  phase: Phase; fanout: boolean; parent: number | null; title: string | null; fanoutBoard: string | null;
  profile: string | null; // a routed subtask's profile (#645); null runs as its project's lead
  // Asking (#652): the last question and the answer it got (kept for a
  // reseeded run and the cap check), when it was asked and escalated to
  // your user, how many this row asked, and whether its next run resumes.
  question: string | null; askHuman: boolean; askedAt: number | null; escalatedAt: number | null; answer: string | null; asks: number; resume: boolean;
};
export type Admit = { fanout?: boolean; parent?: number; title?: string; profile?: string };
// A child process (#649): one per run of a request (a fanned-out request has
// two, its triage and its synthesis). `outcome` is null while it runs; a run
// cut off by a restart ends as interrupted. Its transcript is the file
// runs/<id>.jsonl beside the store, pruned with it.
export type RunOutcome = "ok" | "failed" | "timeout" | "budget" | "interrupted" | "cancelled" | "deadline";
// Work a spent daily budget holds (#655): everything, or the fleets on these boards.
export type Hold = { all: boolean; boards: string[] };
export type Run = { id: number; seq: number; agent: string; started_at: number; ended_at: number | null; code: number | null; session: string | null; turns: number | null; cost_usd: number | null; granted_usd: number | null; outcome: RunOutcome | null };

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
      question TEXT,
      ask_human INTEGER NOT NULL DEFAULT 0,
      asked_at INTEGER,
      escalated_at INTEGER,
      answer TEXT,
      asks INTEGER NOT NULL DEFAULT 0,
      resume INTEGER NOT NULL DEFAULT 0,
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
      outcome TEXT,
      granted_usd REAL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS runs_seq ON runs (seq)`);
    // Thread commands (#651). threads: each reply the factory sent for a
    // request, keyed like a request (a DM's message id or a post id), so a
    // command answering it finds its request. commands: each command acted
    // on, so a replay acts once.
    this.db.exec(`CREATE TABLE IF NOT EXISTS threads (source TEXT NOT NULL, id INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (source, id))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS commands (source TEXT NOT NULL, id INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (source, id))`);
    // Additive (AGENTS.md): a store an earlier factory wrote gets the fan-out
    // columns, in one transaction with the check.
    this.db.transaction(() => {
      const cols = new Set((this.db.query(`PRAGMA table_info(requests)`).all() as { name: string }[]).map((c) => c.name));
      const add: [string, string][] = [["phase", "TEXT NOT NULL DEFAULT 'run'"], ["fanout", "INTEGER NOT NULL DEFAULT 0"], ["parent", "INTEGER"], ["title", "TEXT"], ["fanout_board", "TEXT"], ["profile", "TEXT"],
        ["question", "TEXT"], ["ask_human", "INTEGER NOT NULL DEFAULT 0"], ["asked_at", "INTEGER"], ["escalated_at", "INTEGER"], ["answer", "TEXT"], ["asks", "INTEGER NOT NULL DEFAULT 0"], ["resume", "INTEGER NOT NULL DEFAULT 0"]];
      for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
      // A run's granted budget (#655): its reservation while open, its charge when it ends without a cost.
      const runCols = new Set((this.db.query(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name));
      if (!runCols.has("granted_usd")) this.db.exec(`ALTER TABLE runs ADD COLUMN granted_usd REAL`);
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

  // The oldest queued request, now running; null when none waits. The
  // returned row says whether this run resumes (#652); the store clears it,
  // so a later run of the row (a synthesis) starts fresh.
  // Held work (#655) is skipped, so a held fleet doesn't block another's.
  next(hold: Hold = { all: false, boards: [] }): Row | null {
    if (hold.all) return null;
    const row = this.db.query(`SELECT q.* FROM requests q LEFT JOIN requests p ON p.seq = q.parent WHERE q.state = 'queued'${held(hold.boards, false)} ORDER BY q.seq LIMIT 1`).get(...hold.boards) as Raw | null;
    if (!row) return null;
    this.db.query(`UPDATE requests SET state = 'running', resume = 0, updated_at = ? WHERE seq = ?`).run(this.now(), row.seq);
    return toRow({ ...row, state: "running" });
  }

  // ── asking (#652) ──
  // A running row's run ended on a question: it parks. `human`: addressed
  // to your user; it's stamped escalated only once it reaches them.
  park(seq: number, question: string, human: boolean): void {
    const t = this.now();
    this.db.query(`UPDATE requests SET state = 'asking', question = ?, ask_human = ?, asked_at = ?, escalated_at = NULL, answer = NULL, asks = asks + 1, updated_at = ? WHERE seq = ? AND state = 'running'`)
      .run(question, human ? 1 : 0, t, t, seq);
  }

  // A question past the tree's cap: counted, never parked; the row queues
  // again at once to resume with `answer`.
  refuse(seq: number, question: string, answer: string): void {
    this.db.query(`UPDATE requests SET state = 'queued', question = ?, answer = ?, resume = 1, asks = asks + 1, updated_at = ? WHERE seq = ? AND state = 'running'`)
      .run(question, answer, this.now(), seq);
  }

  // Answers an asking row: queues it to resume with `answer`. With `cmd`
  // (the answering message), records it in the same transaction, so a
  // replayed answer acts once and a crash can't lose a recorded one.
  // "replay": `cmd` was already acted on; "closed": the row isn't asking.
  answer(seq: number, answer: string, cmd?: Key): "queued" | "replay" | "closed" {
    return this.db.transaction(() => {
      if (this.bySeq(seq)?.state !== "asking") return "closed";
      if (cmd && !this.command(cmd, seq)) return "replay";
      this.db.query(`UPDATE requests SET state = 'queued', answer = ?, resume = 1, updated_at = ? WHERE seq = ?`).run(answer, this.now(), seq);
      return "queued";
    }).immediate() as "queued" | "replay" | "closed";
  }

  // Stamps the question asked at `askedAt` as sent to your user; a row
  // answered or parked again since is left alone.
  escalated(seq: number, askedAt: number | null): void {
    this.db.query(`UPDATE requests SET escalated_at = ? WHERE seq = ? AND state = 'asking' AND asked_at IS ?`).run(this.now(), seq, askedAt);
  }

  asking(): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE state = 'asking' ORDER BY seq`).all() as Raw[]).map(toRow);
  }

  // Questions asked in the tree rooted at `root` (itself and its subtasks).
  treeAsks(root: number): number {
    return (this.db.query(`SELECT COALESCE(SUM(asks), 0) AS n FROM requests WHERE seq = ? OR parent = ?`).get(root, root) as { n: number }).n;
  }

  // The session of the row's latest run that reported one: what a resume continues.
  lastSession(seq: number): string | null {
    return (this.db.query(`SELECT session FROM runs WHERE seq = ? AND session IS NOT NULL ORDER BY id DESC LIMIT 1`).get(seq) as { session: string } | null)?.session ?? null;
  }

  // What the session's earlier runs cost (each row holds its own
  // invocation's share): a resume reports the session's running total.
  sessionUsd(session: string): number {
    return (this.db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE session = ?`).get(session) as { c: number }).c;
  }

  finish(k: Key, reply: string): void {
    this.db.query(`UPDATE requests SET state = 'finished', reply = ?, updated_at = ? WHERE source = ? AND id = ?`).run(reply, this.now(), k.source, k.id);
  }

  markReplied(k: Key): void {
    this.db.query(`UPDATE requests SET replied = 1, updated_at = ? WHERE source = ? AND id = ?`).run(this.now(), k.source, k.id);
  }

  // A reply the factory sent in request `seq`'s thread.
  recordReply(k: Key, seq: number): void {
    this.db.query(`INSERT OR IGNORE INTO threads (source, id, seq) VALUES (?, ?, ?)`).run(k.source, k.id, seq);
  }

  // The request whose thread `parent` (a command's parent id) is: the
  // request itself, or one of the factory's replies to it.
  threadOf(source: Key["source"], parent: number): Row | null {
    const own = this.get({ source, id: parent });
    if (own) return own;
    const t = this.db.query(`SELECT seq FROM threads WHERE source = ? AND id = ?`).get(source, parent) as { seq: number } | null;
    return t ? this.bySeq(t.seq) : null;
  }

  bySeq(seq: number): Row | null {
    const r = this.db.query(`SELECT * FROM requests WHERE seq = ?`).get(seq) as Raw | null;
    return r ? toRow(r) : null;
  }

  // Records command `k` on request `seq`; false when it was already acted on (a replay).
  command(k: Key, seq: number): boolean {
    return this.db.query(`INSERT OR IGNORE INTO commands (source, id, seq) VALUES (?, ?, ?)`).run(k.source, k.id, seq).changes === 1;
  }

  // A cancel (#651), in one transaction. A queued or asking request finishes
  // with `reply`. A waiting one finishes too (so it never synthesizes), with
  // its queued and asking subtasks; its running subtasks are returned for the caller to
  // stop. A running request is the caller's to stop. Returns the rows
  // finished here and the running ones, or null when it had already finished.
  cancel(seq: number, reply: (r: Row) => string): { finished: Row[]; running: Row[] } | null {
    return this.db.transaction(() => {
      const r = this.bySeq(seq);
      if (!r || r.state === "finished") return null;
      if (r.state === "running") return { finished: [], running: [r] };
      const subs = r.state === "waiting" ? this.subtasks(seq) : [];
      const finished = [r, ...subs.filter((s) => s.state === "queued" || s.state === "asking")];
      for (const f of finished) this.finish(f, reply(f));
      return { finished: finished.map((f) => this.bySeq(f.seq)!), running: subs.filter((s) => s.state === "running") };
    }).immediate();
  }

  // How many rows run now, wait for a slot, and wait for an answer.
  load(): { running: number; queued: number; asking: number } {
    return this.db.query(`SELECT COALESCE(SUM(state = 'running'), 0) AS running, COALESCE(SUM(state = 'queued'), 0) AS queued, COALESCE(SUM(state = 'asking'), 0) AS asking FROM requests`).get() as { running: number; queued: number; asking: number };
  }

  // Queued rows a spent daily budget holds (#655), or whether this one is held.
  heldCount(hold: Hold, seq?: number): number {
    if (!hold.all && !hold.boards.length) return 0;
    const one = seq === undefined ? "" : " AND q.seq = ?";
    const args: (string | number)[] = hold.all ? [] : [...hold.boards];
    if (seq !== undefined) args.push(seq);
    return (this.db.query(`SELECT COUNT(*) AS n FROM requests q LEFT JOIN requests p ON p.seq = q.parent WHERE q.state = 'queued'${hold.all ? "" : held(hold.boards, true)}${one}`).get(...args) as { n: number }).n;
  }

  // A row taken by next() that a spent budget turned back (#655): queued
  // again as it was, its resume flag restored.
  requeue(seq: number, resume: boolean): void {
    this.db.query(`UPDATE requests SET state = 'queued', resume = ?, updated_at = ? WHERE seq = ? AND state = 'running'`).run(resume ? 1 : 0, this.now(), seq);
  }

  // Top-level requests not yet finished: what a deadline (#655) is checked on.
  openRoots(): Row[] {
    return (this.db.query(`SELECT * FROM requests WHERE parent IS NULL AND state != 'finished' ORDER BY seq`).all() as Raw[]).map(toRow);
  }

  // A subtask's siblings that will still run: queued, or asking (a resume runs).
  siblingsLeft(parent: number, self: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE parent = ? AND seq != ? AND state IN ('queued', 'asking')`).get(parent, self) as { n: number }).n;
  }

  // Queued requests admitted before this one.
  queuedAhead(k: Key): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE state = 'queued' AND seq < (SELECT seq FROM requests WHERE source = ? AND id = ?)`).get(k.source, k.id) as { n: number }).n;
  }

  // A run of the request `seq` starts; returns its id.
  startRun(seq: number, agent: string, grantedUsd?: number): number {
    return Number(this.db.query(`INSERT INTO runs (seq, agent, started_at, granted_usd) VALUES (?, ?, ?, ?)`).run(seq, agent, this.now(), grantedUsd ?? null).lastInsertRowid);
  }

  // Spend (#655): a run's cost, else its grant. An open run has no cost
  // yet, so its grant is its reservation; a run killed before its final
  // event (timeout, cancel, interrupted) never gets one, so it's charged
  // its grant rather than nothing. A run with neither counts as free: no
  // cap applied when it started.
  treeSpent(root: number): number {
    return (this.db.query(`SELECT COALESCE(SUM(COALESCE(r.cost_usd, r.granted_usd, 0)), 0) AS n FROM runs r JOIN requests q ON q.seq = r.seq WHERE q.seq = ? OR q.parent = ?`).get(root, root) as { n: number }).n;
  }

  // Spend on runs started since `since`: every run, or a fleet's (its root
  // a post on `board`). Rows pruned by retention drop out, so a daily cap
  // needs retention of at least a day (main.ts refuses less).
  spentSince(since: number, board?: string): number {
    const scope = board === undefined ? "" : ` AND COALESCE(p.source, q.source) = 'board' AND COALESCE(p.board, q.board) = ?`;
    const args: (number | string)[] = board === undefined ? [since] : [since, board];
    return (this.db.query(`SELECT COALESCE(SUM(COALESCE(r.cost_usd, r.granted_usd, 0)), 0) AS n FROM runs r JOIN requests q ON q.seq = r.seq LEFT JOIN requests p ON p.seq = q.parent WHERE r.started_at >= ?${scope}`).get(...args) as { n: number }).n;
  }

  // When the oldest charge in the window leaves it: the earliest a held fleet may run again.
  oldestSince(since: number, board?: string): number | null {
    const scope = board === undefined ? "" : ` AND COALESCE(p.source, q.source) = 'board' AND COALESCE(p.board, q.board) = ?`;
    const args: (number | string)[] = board === undefined ? [since] : [since, board];
    return (this.db.query(`SELECT MIN(r.started_at) AS t FROM runs r JOIN requests q ON q.seq = r.seq LEFT JOIN requests p ON p.seq = q.parent WHERE r.started_at >= ? AND COALESCE(r.cost_usd, r.granted_usd, 0) > 0${scope}`).get(...args) as { t: number | null }).t;
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
  // synthesizes with the interruption in its results. A row left asking
  // (#652) had nothing running: it stays parked, its clocks where they were.
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
      this.db.query(`DELETE FROM threads WHERE seq NOT IN (SELECT seq FROM requests)`).run();
      this.db.query(`DELETE FROM commands WHERE seq NOT IN (SELECT seq FROM requests)`).run();
      return n;
    }).immediate();
  }

  close(): void {
    this.db.close();
  }
}

type Fields = { seq: number; id: number; requester: string; persona: string; task: string; agent: string; state: State; reply: string | null; created_at: number; updated_at: number; phase: Phase; parent: number | null; title: string | null; profile: string | null; question: string | null; answer: string | null; asks: number };
// The fleet a row belongs to, by its root's board: in `boards` (`within`) or not.
function held(boards: string[], within: boolean): string {
  if (!boards.length) return "";
  const inList = `COALESCE(p.board, q.board) IN (${boards.map(() => "?").join(", ")})`;
  return within ? ` AND ${inList}` : ` AND NOT (q.source = 'board' AND COALESCE(${inList}, 0))`;
}

type Raw = Fields & { source: string; board: string | null; replied: number; context: string | null; fanout: number; fanout_board: string | null; ask_human: number; asked_at: number | null; escalated_at: number | null; resume: number };
function toRow(r: Raw): Row {
  const { context, replied, source, board, fanout, fanout_board, ask_human, asked_at, escalated_at, resume, ...rest } = r;
  const base = { ...rest, ...(context !== null ? { context } : {}), replied: replied === 1, fanout: fanout === 1, fanoutBoard: fanout_board, askHuman: ask_human === 1, askedAt: asked_at, escalatedAt: escalated_at, resume: resume === 1 };
  return source === "board" ? { ...base, source: "board", board: board ?? "" } : { ...base, source: "dm" };
}
