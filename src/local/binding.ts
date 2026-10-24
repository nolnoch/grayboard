// Local name binding (#182). Every grayboard mcp process that owns delivery
// writes a bindings row at start, keyed by its session ID, with name NULL
// while unbound. A name is acquired by setting the row's name inside one
// BEGIN IMMEDIATE transaction, so two starters can't both win and a live
// holder whose event loop is busy can't lose its name to a socket probe
// (#80). The wakeup socket follows the row: only the row's owner listens.
import type { Database } from "bun:sqlite";

import { declareHuman, humanHandles, isHuman, isViewer } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { logBinding, closestNames, orderCandidates, unknownNameError, MAX_CANDIDATES, type Candidate } from "../core/bindings.ts";
import { listClaims, moveClaims, type Claim } from "../core/claims.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { testPause } from "../shared/testpause.ts";
import { aliveRows, commandName, isAlive, procStart } from "../shared/proc.ts";
import { poke } from "./wakeup.ts";

export type SessionRow = {
  session_id: string;
  name: string | null;
  pid: number;
  proc_start: string | null;
  harness: string | null;
  harness_pid: number | null;
  cwd: string | null;
  started_at: number;
  bound_at: number | null;
};

/** This process as a session row, unbound. */
export function thisSession(sessionId: string, cwd = process.cwd()): SessionRow {
  const proc_start = procStart(process.pid) ?? null;
  // Without it, liveness falls back to the pid alone: a reused pid would keep this row's name.
  if (proc_start === null) console.error(`[grayboard] can't read this process's start time; session ${sessionId}'s row records none`);
  return {
    session_id: sessionId,
    name: null,
    pid: process.pid,
    proc_start,
    harness: commandName(process.ppid),
    harness_pid: process.ppid,
    cwd,
    started_at: Date.now(),
    bound_at: null,
  };
}

/** Write this session's row, unbound: its presence until it binds. */
export function registerSession(db: Database, s: SessionRow): void {
  db.prepare(
    `INSERT INTO bindings (session_id, name, pid, proc_start, harness, harness_pid, cwd, started_at, bound_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(s.session_id, s.pid, s.proc_start, s.harness, s.harness_pid, s.cwd, s.started_at);
}

/** How a holder reads in a refusal: "pid 4242 (claude, in grayboard on main)". */
export function describeHolder(r: SessionRow): string {
  const where = r.cwd ? describeLocation(r.cwd) : null;
  const what = [r.harness, where ? `in ${where}` : null].filter(Boolean).join(", ");
  return `the live session ${r.session_id} (pid ${r.pid}${what ? `, ${what}` : ""})`;
}

const NO_ROW_HOLDER = "a live session from an older grayboard (its wakeup socket answers; no live bindings row holds the name)";

// Reap rows whose process is gone. Callers are inside a transaction.
function reap(db: Database, rows: SessionRow[], now: number): void {
  for (const r of rows) {
    db.prepare(`DELETE FROM bindings WHERE session_id = ?`).run(r.session_id);
    if (r.name) logBinding(db, r.session_id, r.name, "released", `reaped: pid ${r.pid} is gone`, now);
  }
}

/** Every live session row, reaping the dead ones. */
export function liveSessions(db: Database): SessionRow[] {
  const rows = db.prepare(`SELECT * FROM bindings`).all() as SessionRow[];
  const { alive, dead } = aliveRows(rows);
  if (dead.length) db.transaction(() => reap(db, dead, Date.now())).immediate();
  return alive;
}

export type AcquireResult =
  | { ok: true; name: string; moved: Claim[] }
  | { ok: false; error: string; holder?: string; known?: string[] };

// Names that exist: the roster, minus viewers and humans.
function knownNames(db: Database): string[] {
  const humans = new Set(humanHandles(db));
  return (db.prepare(`SELECT name FROM handles ORDER BY last_seen DESC`).all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !isViewer(n) && !humans.has(n) && n !== HUMAN_NAME);
}

/**
 * Bind session `sessionId` to `name`, moving it off `previous` (a rebind)
 * with its claims. `create` allows a name that has never existed (startup
 * passes it for an explicit BUS_IDENTITY, as startup always created one).
 * `detail` goes on the bound event (a restart's restore). Refusals are logged.
 *
 * The socket probe for a pre-upgrade holder (no live row, live socket) runs
 * before the lock and is re-checked against the rows inside it, so the write
 * lock is never held across a probe. A dead row doesn't skip it: a settled
 * pre-upgrade session can listen on a name whose new-code holder was killed.
 */
export async function acquireName(
  db: Database,
  sessionId: string,
  name: string,
  opts: { create: boolean; previous: string | null; allowHuman?: boolean; detail?: string },
): Promise<AcquireResult> {
  const rowHolder = () => db.prepare(`SELECT * FROM bindings WHERE name = ? AND session_id != ?`).get(name, sessionId) as SessionRow | null;
  const before = rowHolder();
  const sockLive = before && isAlive(before.pid, before.proc_start) ? false : await poke(name);

  testPause("bind:before-txn");
  return db.transaction((): AcquireResult => {
    const now = Date.now();
    const refuse = (error: string, extra: { holder?: string; known?: string[] } = {}): AcquireResult => {
      logBinding(db, sessionId, name, "refused", extra.holder ?? error, now);
      return { ok: false, error, ...extra };
    };
    testPause("bind:in-txn");
    if (!opts.allowHuman && (name === HUMAN_NAME || isHuman(db, name))) {
      return refuse(`"${name}" is your user's handle; an agent session can't bind it`);
    }
    if (!opts.create && !db.prepare(`SELECT 1 FROM handles WHERE name = ?`).get(name)) {
      const known = closestNames(name, knownNames(db));
      return refuse(unknownNameError(name, known), { known });
    }
    const holder = rowHolder();
    if (holder && isAlive(holder.pid, holder.proc_start)) {
      const who = describeHolder(holder);
      return refuse(`"${name}" is held by ${who}`, { holder: who });
    }
    if (holder) reap(db, [holder], now);
    if (sockLive) return refuse(`"${name}" is held by ${NO_ROW_HOLDER}`, { holder: NO_ROW_HOLDER });

    const r = db.prepare(`UPDATE bindings SET name = ?, bound_at = ? WHERE session_id = ?`).run(name, now, sessionId);
    if (r.changes !== 1) throw new Error(`grayboard: session ${sessionId} has no bindings row`);
    const moved = opts.previous ? moveClaims(db, opts.previous, name, now) : [];
    if (opts.previous) logBinding(db, sessionId, opts.previous, "released", `rebound to ${name}`, now);
    logBinding(db, sessionId, name, opts.previous ? "moved" : "bound", opts.previous ?? opts.detail ?? null, now);
    return { ok: true, name, moved };
  }).immediate();
}

/**
 * Wait up to `ms` for the live session holding `name` from under the same
 * harness (`harnessPid`) to exit: a restarted grayboard can start before the
 * process it replaces has released the name. True once no such holder is left.
 */
export async function siblingGone(db: Database, name: string, harnessPid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = db.prepare(`SELECT * FROM bindings WHERE name = ?`).get(name) as SessionRow | null;
    if (!row || row.harness_pid !== harnessPid || !isAlive(row.pid, row.proc_start)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

/**
 * The session ends: delete its row and log the release. Returns the name it
 * still held, if any, so the caller removes that name's socket.
 */
export function endSession(db: Database, sessionId: string): string | null {
  return db.transaction(() => {
    const row = db.prepare(`DELETE FROM bindings WHERE session_id = ? RETURNING name`).get(sessionId) as { name: string | null } | null;
    if (row?.name) logBinding(db, sessionId, row.name, "released");
    return row?.name ?? null;
  }).immediate();
}

/**
 * Who holds `name` now, for a refusal outside acquire (`grayboard human`):
 * a live row, or a live socket with no row. `sockLive` is the caller's
 * probe, taken before its transaction. Call inside that transaction.
 */
export function nameHolder(db: Database, name: string, sockLive: boolean): string | null {
  const row = db.prepare(`SELECT * FROM bindings WHERE name = ?`).get(name) as SessionRow | null;
  if (row && isAlive(row.pid, row.proc_start)) return describeHolder(row);
  return sockLive ? NO_ROW_HOLDER : null;
}

/**
 * Declare `handle` the human, refused while a live agent session holds it
 * (#79). Its bind refuses the human handle in turn, inside its own
 * transaction, so neither order wins a race. Re-declaring the current human
 * skips the check: its holder is the human's own bridge.
 */
export async function declareLocalHuman(db: Database, handle: string, socks?: string): Promise<void> {
  const sockLive = isHuman(db, handle) ? false : await poke(handle, socks);
  testPause("human:before-txn");
  declareHuman(db, handle, () => {
    testPause("human:in-txn");
    if (isHuman(db, handle)) return;
    const holder = nameHolder(db, handle, sockLive);
    if (holder) throw new CoreError(`"${handle}" is bound by ${holder}; an agent's name can't become the human handle while it's in use`);
  });
}

// DMs queued for each of the names in ?1 (a JSON array): one index search per
// name past its read point, never a pass over the whole table. It lives here,
// not in db.ts, because this module takes its database (the Slack bridge
// opens its own). Exported for the plan pin in db.test.ts.
export const QUEUED_FOR_SQL = `SELECT j.value AS name,
    (SELECT COUNT(*) FROM messages m
      WHERE m.recipient = j.value AND m.sender != j.value
        AND m.id > COALESCE((SELECT last_seen_id FROM cursors WHERE reader = j.value), 0)) AS n
  FROM json_each(?1) j`;

/**
 * The names an unbound session is offered: `suggested` (the checkout's
 * default) first if it's free, then the user's other free names with the
 * most pending work (queued DMs plus held claims), then the most recently
 * used. Live names, viewers and humans are left out.
 */
export async function candidateNames(db: Database, suggested: string | null): Promise<Candidate[]> {
  const live = new Set(liveSessions(db).map((r) => r.name).filter((n): n is string => n !== null));
  const claims = new Map<string, number>();
  for (const c of listClaims(db)) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
  const humans = new Set(humanHandles(db));
  const ok = (n: string) => !live.has(n) && !isViewer(n) && !humans.has(n) && n !== HUMAN_NAME;
  const rows = (db.prepare(`SELECT name, last_seen, cwd FROM handles`).all() as { name: string; last_seen: number; cwd: string | null }[]).filter((r) => ok(r.name));
  const queued = new Map((db.prepare(QUEUED_FOR_SQL).all(JSON.stringify(rows.map((r) => r.name))) as { name: string; n: number }[]).map((r) => [r.name, r.n]));
  const pool = orderCandidates(
    rows.map((r) => ({
      name: r.name, queued: queued.get(r.name) ?? 0, claims: claims.get(r.name) ?? 0, last_seen: r.last_seen,
      where: r.cwd ? describeLocation(r.cwd) : null,
    })),
    suggested && ok(suggested) ? suggested : null,
  );
  // A pre-upgrade session holds its name by socket alone; drop those too.
  const free: Candidate[] = [];
  for (let i = 0; i < pool.length && free.length < MAX_CANDIDATES; i += MAX_CANDIDATES) {
    const batch = pool.slice(i, i + MAX_CANDIDATES);
    const held = await Promise.all(batch.map((r) => poke(r.name)));
    free.push(...batch.filter((_, j) => !held[j]));
  }
  return free.slice(0, MAX_CANDIDATES);
}
