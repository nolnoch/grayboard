// Local name binding (#182, #284). Every grayboard mcp process that owns
// delivery writes a bindings row at start, keyed by its session ID: its
// liveness (pid, start time, harness pid). Its facts are its ids row. A name
// is acquired by writing its alias_holds row inside one BEGIN IMMEDIATE
// transaction, so two starters can't both win and a live holder whose event
// loop is busy can't lose its name to a socket probe (#80). The wakeup socket
// follows the hold: only the holder listens.
import type { Database } from "bun:sqlite";

import { ALIAS_SESSION_SQL, declareHuman, endId, ensureAlias, humanHandles, isHuman, isViewer, registerId } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { continuityOf, dropHold, holdAlias, lastWasRelease, logBinding, closestNames, orderCandidates, unknownNameError, MAX_CANDIDATES, type Candidate } from "../core/bindings.ts";
import { listClaims, moveClaims, type Claim } from "../core/claims.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { testPause } from "../shared/testpause.ts";
import { aliveRows, commandName, isAlive, procStart } from "../shared/proc.ts";
import { poke } from "./wakeup.ts";

// A session as binding reads it: its bindings row (liveness), its ids row's
// harness and cwd, and the name it holds, if any.
export type SessionRow = {
  session_id: string;
  name: string | null;
  pid: number;
  proc_start: string | null;
  harness: string | null;
  harness_pid: number | null;
  cwd: string | null;
  started_at: number;
};

const SESSION_SQL = `SELECT b.session_id, h.address AS name, b.pid, b.proc_start, i.harness, b.harness_pid, i.cwd, b.started_at
  FROM bindings b LEFT JOIN ids i ON i.id = b.session_id LEFT JOIN alias_holds h ON h.id = b.session_id`;

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
  };
}

/**
 * Write this session's rows, unbound: its liveness and its ids row, which
 * are its presence until it binds. Throws IdCollision when the ID already
 * has a row: a reused BUS_SESSION_KEY, whose session must not come back.
 */
export function registerSession(db: Database, s: SessionRow, launcher: boolean): void {
  db.transaction(() => {
    registerId(db, { id: s.session_id, principal: null, harness: s.harness, cwd: s.cwd, launcher }, s.started_at);
    db.prepare(
      `INSERT INTO bindings (session_id, pid, proc_start, harness_pid, started_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(s.session_id, s.pid, s.proc_start, s.harness_pid, s.started_at);
  }).immediate();
}

/** How a holder reads in a refusal: "pid 4242 (claude, in grayboard on main)". */
export function describeHolder(r: SessionRow): string {
  const where = r.cwd ? describeLocation(r.cwd) : null;
  const what = [r.harness, where ? `in ${where}` : null].filter(Boolean).join(", ");
  return `the live session ${r.session_id} (pid ${r.pid}${what ? `, ${what}` : ""})`;
}

// A live socket with no live session holding the name: a session from
// before #182, or one that has just rebound off the name and hasn't closed
// its socket yet. That one left no hold (dead or alive) on the name, and its
// release is the name's last event. `deadRow`: a dead holder's row was found,
// so it isn't that.
function noRowHolder(db: Database, name: string, deadRow: boolean): string {
  return !deadRow && lastWasRelease(db, name)
    ? "a session that has just rebound off it (its wakeup socket still answers); try again in a moment"
    : "a live session from an older grayboard (its wakeup socket answers; no live session holds the name)";
}

// The session ends: its liveness row and its holds go, each hold's release
// is logged, and its ID is marked ended. Callers are inside a transaction.
// Returns the names it held.
function end(db: Database, sessionId: string, why: string | null, now: number): string[] {
  db.prepare(`DELETE FROM bindings WHERE session_id = ?`).run(sessionId);
  const held = (db.prepare(`DELETE FROM alias_holds WHERE id = ? RETURNING address`).all(sessionId) as { address: string }[]).map((r) => r.address);
  for (const name of held) logBinding(db, sessionId, name, "released", why, now);
  endId(db, sessionId, now);
  return held;
}

// Reap rows whose process is gone. Callers are inside a transaction. The
// rows were read before it, so another process may have reaped one already:
// only the process whose delete removed the row ends the session.
export function reap(db: Database, rows: SessionRow[], now: number): void {
  for (const r of rows) {
    if (!db.prepare(`SELECT 1 FROM bindings WHERE session_id = ?`).get(r.session_id)) continue;
    end(db, r.session_id, `reaped: pid ${r.pid} is gone`, now);
  }
}

/** Every live session row, reaping the dead ones. */
export function liveSessions(db: Database): SessionRow[] {
  const rows = db.prepare(SESSION_SQL).all() as SessionRow[];
  const { alive, dead } = aliveRows(rows);
  if (dead.length) db.transaction(() => reap(db, dead, Date.now())).immediate();
  return alive;
}

export type AcquireResult =
  | { ok: true; name: string; moved: Claim[]; restored: boolean }
  | { ok: false; error: string; holder?: string; known?: string[] };

// Whether a roster name is an agent's: not a viewer's, nor a human's.
function agentName(db: Database): (name: string) => boolean {
  const humans = new Set(humanHandles(db));
  return (n) => !isViewer(n) && !humans.has(n) && n !== HUMAN_NAME;
}

// Names that exist: the aliases that are agents'.
function knownNames(db: Database): string[] {
  return (db.prepare(`SELECT address FROM aliases ORDER BY last_seen DESC`).all() as { address: string }[])
    .map((r) => r.address)
    .filter(agentName(db));
}

// The session holding `name`, other than `sessionId`.
function holdingSession(db: Database, name: string, sessionId: string | null = null): SessionRow | null {
  return db.prepare(`${SESSION_SQL} WHERE h.address = ? AND b.session_id IS NOT ?`).get(name, sessionId) as SessionRow | null;
}

/**
 * Bind session `sessionId` to `name`, moving it off `previous` (a rebind)
 * with its claims. `create` allows a name that has never existed (startup
 * passes it for an explicit BUS_IDENTITY, as startup always created one).
 * `restartOf` is the session a restart takes the name back from: verified
 * against the name's history in the transaction that logs the bind (#211),
 * and `restored` says whether it held. Refusals are logged.
 *
 * The socket probe for a pre-upgrade holder (no live hold, live socket) runs
 * before the lock and is re-checked against the rows inside it, so the write
 * lock is never held across a probe. A dead holder doesn't skip it: a settled
 * pre-upgrade session can listen on a name whose new-code holder was killed.
 */
export async function acquireName(
  db: Database,
  sessionId: string,
  name: string,
  opts: { create: boolean; previous: string | null; allowHuman?: boolean; restartOf?: string },
): Promise<AcquireResult> {
  const before = holdingSession(db, name, sessionId);
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
    if (!opts.create && !db.prepare(`SELECT 1 FROM aliases WHERE address = ?`).get(name)) {
      const known = closestNames(name, knownNames(db));
      return refuse(unknownNameError(name, known), { known });
    }
    const holder = holdingSession(db, name, sessionId);
    if (holder && isAlive(holder.pid, holder.proc_start)) {
      const who = describeHolder(holder);
      return refuse(`"${name}" is held by ${who}`, { holder: who });
    }
    if (holder) reap(db, [holder], now);
    if (sockLive) {
      const who = noRowHolder(db, name, before !== null || holder !== null);
      return refuse(`"${name}" is held by ${who}`, { holder: who });
    }

    if (!db.prepare(`SELECT 1 FROM bindings WHERE session_id = ?`).get(sessionId)) {
      throw new Error(`grayboard: session ${sessionId} has no bindings row`);
    }
    ensureAlias(db, name, null, now);
    if (opts.previous) dropHold(db, opts.previous, sessionId);
    holdAlias(db, name, sessionId, now);
    const restart = opts.restartOf === undefined ? null : continuityOf(db, name, { restartOf: opts.restartOf });
    const moved = opts.previous ? moveClaims(db, opts.previous, name, now) : [];
    if (opts.previous) logBinding(db, sessionId, opts.previous, "released", `rebound to ${name}`, now);
    logBinding(db, sessionId, name, opts.previous ? "moved" : "bound", opts.previous ?? restart?.detail ?? null, now);
    return { ok: true, name, moved, restored: restart?.verified ?? false };
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
    const row = holdingSession(db, name);
    if (!row || row.harness_pid !== harnessPid || !isAlive(row.pid, row.proc_start)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

/**
 * The session ends: its rows go, its ID is marked ended, and each release is
 * logged. Returns the name it still held, if any, so the caller removes that
 * name's socket.
 */
export function endSession(db: Database, sessionId: string): string | null {
  return db.transaction(() => end(db, sessionId, null, Date.now())[0] ?? null).immediate();
}

/**
 * Who holds `name` now, for a refusal outside acquire (`grayboard human`):
 * a live row, or a live socket with no row. `sockLive` is the caller's
 * probe, taken before its transaction. Call inside that transaction.
 */
export function nameHolder(db: Database, name: string, sockLive: boolean): string | null {
  const row = holdingSession(db, name);
  if (row && isAlive(row.pid, row.proc_start)) return describeHolder(row);
  return sockLive ? noRowHolder(db, name, row !== null) : null;
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
  const agent = agentName(db);
  const ok = (n: string) => !live.has(n) && agent(n);
  const rows = (
    db.prepare(`SELECT a.address AS name, a.last_seen, i.cwd FROM aliases a LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL} WHERE a.last_seen IS NOT NULL`).all() as
      { name: string; last_seen: number; cwd: string | null }[]
  ).filter((r) => ok(r.name));
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
