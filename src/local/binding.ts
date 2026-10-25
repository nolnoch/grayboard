// Local name binding (#182, #284). Every grayboard mcp process that owns
// delivery writes a bindings row at start, keyed by its session ID: its
// liveness (pid, start time, harness pid). Its facts are its ids row. A keyed
// session (BUS_SESSION_KEY) lives as long as its harness: the row's pid is
// the harness's, and the grayboard mcp child serving it attaches and detaches
// (#284 decision 3). A name
// is acquired by writing its alias_holds row inside one BEGIN IMMEDIATE
// transaction, so two starters can't both win and a live holder whose event
// loop is busy can't lose its name to a socket probe (#80). The wakeup socket
// follows the hold: only the holder listens.
import type { Database } from "bun:sqlite";

import { ALIAS_SESSION_SQL, declareHuman, ensureAlias, humanHandles, idCollisionText, isHuman, registerId, viewers } from "../core/boards.ts";
import { writeCoreAudit } from "../core/audit.ts";
import { CoreError } from "../core/errors.ts";
import { continuityOf, dropHold, holdAlias, lastWasRelease, logBinding, closestNames, orderCandidates, unknownNameError, MAX_CANDIDATES, type Candidate } from "../core/bindings.ts";
import { listClaims } from "../core/claims.ts";
import { endSession, type EndedSession } from "../core/session_end.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { testPause } from "../shared/testpause.ts";
import { aliveRows, commandName, harnessAncestor, isAlive, procStart } from "../shared/proc.ts";
import { localMail } from "./mailbox.ts";
import { poke } from "./wakeup.ts";

// A session as binding reads it: its bindings row (liveness), its ids row's
// harness and cwd, and the name it holds, if any: its hold, or for a 1.x
// process sharing the file, its bindings row's name.
export type SessionRow = {
  session_id: string;
  name: string | null;
  pid: number;
  proc_start: string | null;
  harness: string | null;
  harness_pid: number | null;
  cwd: string | null;
  started_at: number;
  // Keyed sessions only: how the harness pid was found, and the child
  // serving the session (null while detached).
  harness_rule: HarnessRule | null;
  attached_pid: number | null;
  attached_start: string | null;
};

/** How a keyed session's harness was found: BUS_HARNESS_PID, or its first non-launcher ancestor. */
export type HarnessRule = "env" | "ancestor";

/** A keyed session's harness: the process whose exit ends it. */
export type Harness = { pid: number; proc_start: string | null; rule: HarnessRule };

const SESSION_SQL = `SELECT b.session_id, COALESCE(h.address, b.name) AS name, b.pid, b.proc_start, i.harness, b.harness_pid, i.cwd, b.started_at,
    b.harness_rule, b.attached_pid, b.attached_start
  FROM bindings b LEFT JOIN ids i ON i.id = b.session_id LEFT JOIN alias_holds h ON h.id = b.session_id`;

/**
 * This process as a session row, unbound. A keyed session's row lives by its
 * `harness`, with this process attached; an unkeyed one's by this process.
 */
export function thisSession(sessionId: string, harness: Harness | null = null, cwd = process.cwd()): SessionRow {
  const proc_start = procStart(process.pid) ?? null;
  // Without it, liveness falls back to the pid alone: a reused pid would keep this row's name.
  if (proc_start === null) console.error(`[grayboard] can't read this process's start time; session ${sessionId}'s row records none`);
  const harnessPid = harness?.pid ?? process.ppid;
  return {
    session_id: sessionId,
    name: null,
    pid: harness?.pid ?? process.pid,
    proc_start: harness ? harness.proc_start : proc_start,
    harness: commandName(harnessPid),
    harness_pid: harnessPid,
    cwd,
    started_at: Date.now(),
    harness_rule: harness?.rule ?? null,
    attached_pid: harness ? process.pid : null,
    attached_start: harness ? proc_start : null,
  };
}

/**
 * A keyed session's harness (#284 decision 3): `BUS_HARNESS_PID` when the
 * orchestrator that minted the key set it, else this process's first
 * non-launcher ancestor. An error string when neither names a live process.
 */
export function keyedHarness(env: Record<string, string | undefined> = process.env): Harness | string {
  const raw = env.BUS_HARNESS_PID;
  if (raw !== undefined) {
    if (!/^[1-9][0-9]*$/.test(raw)) return `BUS_HARNESS_PID must be a process id, not "${raw}"`;
    const start = procStart(Number(raw));
    if (start === undefined) return `BUS_HARNESS_PID ${raw} isn't a running process`;
    return { pid: Number(raw), proc_start: start, rule: "env" };
  }
  const pid = harnessAncestor();
  if (pid === null) return "BUS_SESSION_KEY needs a harness, and every ancestor of this process is a shell or package runner; set BUS_HARNESS_PID";
  const start = procStart(pid);
  if (start === undefined) return `harness pid ${pid} exited before this session registered`;
  return { pid, proc_start: start, rule: "ancestor" };
}

/** What kind of session a registration is, beyond its row: see IdFacts. */
export type SessionKind = { launcher?: boolean; writesAs?: string; viewer?: boolean };

/**
 * Write this session's rows, unbound: its liveness and its ids row, which
 * are its presence until it binds. A tools-only process (#284 S7) passes the
 * alias it writes as, `writesAs`: it never binds, and receives nothing. A
 * `grayboard tail` passes `viewer`. Throws IdCollision when the ID already
 * has a row: an ID is never reused, and a keyed session's restart attaches
 * (attachSession) instead.
 */
export function registerSession(db: Database, s: SessionRow, kind: SessionKind = {}): void {
  const { launcher = false, writesAs, viewer } = kind;
  db.transaction(() => {
    registerId(db, { id: s.session_id, principal: null, harness: s.harness, cwd: s.cwd, launcher, writesAs, viewer }, s.started_at);
    db.prepare(
      `INSERT INTO bindings (session_id, pid, proc_start, harness_pid, started_at, harness_rule, attached_pid, attached_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.session_id, s.pid, s.proc_start, s.harness_pid, s.started_at, s.harness_rule, s.attached_pid, s.attached_start);
    writeCoreAudit(db, "id.registered", s.session_id, s.session_id, {
      ...(writesAs === undefined ? {} : { tools_only: true, writes_as: writesAs }),
      ...(viewer ? { viewer: true } : {}),
      keyed: s.harness_rule !== null, harness_rule: s.harness_rule, harness_pid: s.harness_pid, pid: s.attached_pid ?? s.pid,
    });
  }).immediate();
}

export type AttachResult = { ok: true; held: string | null } | { ok: false; error: string };

// How long a restart waits for the child it replaces to exit.
const ATTACH_WAIT_MS = 5000;

/**
 * Attach this process to keyed session `s.session_id`, whose ids row exists:
 * a child restart under the same live harness is the same session, with its
 * hold, status, subscriptions and queued mail (#284 decision 3). The
 * predecessor may not have exited yet, so this waits up to `ms` for it,
 * outside the lock, then re-reads the row inside one. Refused, and audited as
 * id.collision, when the session has ended, another live child is attached,
 * or the row isn't this harness's. `held` is the name the session holds.
 */
export async function attachSession(db: Database, s: SessionRow, ms = ATTACH_WAIT_MS): Promise<AttachResult> {
  // Only a child of this harness is worth waiting for; any other refuses.
  const predecessor = () => {
    const b = db.prepare(`SELECT pid, attached_pid, attached_start FROM bindings WHERE session_id = ?`).get(s.session_id) as
      { pid: number; attached_pid: number | null; attached_start: string | null } | null;
    return b && b.pid === s.pid && b.attached_pid !== null ? b : null;
  };
  for (const deadline = Date.now() + ms; ; await Bun.sleep(50)) {
    const b = predecessor();
    if (!b || !isAlive(b.attached_pid!, b.attached_start) || Date.now() >= deadline) break;
  }
  testPause("attach:before-txn");
  return db.transaction((): AttachResult => {
    const id = db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(s.session_id) as { ended_at: number | null } | null;
    const b = db.prepare(`SELECT pid, proc_start, harness_rule, attached_pid, attached_start FROM bindings WHERE session_id = ?`).get(s.session_id) as
      Pick<SessionRow, "pid" | "proc_start" | "harness_rule" | "attached_pid" | "attached_start"> | null;
    const refuse = (why: string, detail: Record<string, unknown> = {}): AttachResult => {
      writeCoreAudit(db, "id.collision", s.session_id, s.session_id, { pid: process.pid, reason: why, ...detail });
      return { ok: false, error: idCollisionText(s.session_id, why) };
    };
    if (!id) return refuse("has no session row");
    if (id.ended_at !== null) return refuse(`ended at ${new Date(id.ended_at).toISOString()}`, { ended_at: id.ended_at });
    if (!b) return refuse("has no process row (an older grayboard removed it)");
    if (b.harness_rule === null) return refuse(`is an unkeyed session's (pid ${b.pid})`);
    if (b.pid !== s.pid || b.proc_start !== s.proc_start) return refuse(`belongs to a session under harness pid ${b.pid}`, { harness_pid: b.pid });
    if (b.attached_pid !== null && isAlive(b.attached_pid, b.attached_start)) {
      return refuse(`is served by the live process ${b.attached_pid}`, { attached_pid: b.attached_pid });
    }
    db.prepare(`UPDATE bindings SET attached_pid = ?, attached_start = ?, detached_at = NULL WHERE session_id = ?`)
      .run(s.attached_pid, s.attached_start, s.session_id);
    writeCoreAudit(db, "id.reattached", s.session_id, s.session_id, { old_pid: b.attached_pid, new_pid: s.attached_pid, harness_pid: b.pid });
    const hold = db.prepare(`SELECT address FROM alias_holds WHERE id = ?`).get(s.session_id) as { address: string } | null;
    return { ok: true, held: hold?.address ?? null };
  }).immediate();
}

/**
 * This keyed session's child exits while its harness lives: the session
 * stays, detached, until a restart attaches or an opener finds the harness
 * gone. Only the attached child detaches.
 */
export function detachSession(db: Database, sessionId: string): void {
  db.transaction(() => {
    const r = db.prepare(`UPDATE bindings SET attached_pid = NULL, attached_start = NULL, detached_at = ? WHERE session_id = ? AND attached_pid = ?`)
      .run(Date.now(), sessionId, process.pid);
    if (r.changes === 1) writeCoreAudit(db, "id.detached", sessionId, sessionId, { pid: process.pid });
  }).immediate();
}

// "harness pid N" for a keyed row, whose pid is its harness's; "pid N" otherwise.
function pidText(r: { pid: number; harness_rule: string | null }): string {
  return `${r.harness_rule ? "harness pid" : "pid"} ${r.pid}`;
}

/** How a holder reads in a refusal: "pid 4242 (claude, in grayboard on main)". */
export function describeHolder(r: SessionRow): string {
  const where = r.cwd ? describeLocation(r.cwd) : null;
  const what = [r.harness, where ? `in ${where}` : null].filter(Boolean).join(", ");
  return `the live session ${r.session_id} (${pidText(r)}${what ? `, ${what}` : ""})`;
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

/**
 * Sessions a transaction ended, for its caller to act on once it commits:
 * `wake` the addresses it gave mail or posts (deliverEnded), and remove the
 * ended IDs' sockets, which never listen again.
 */
export type Ended = { ended: string[]; wake: string[] };

export const NOTHING_ENDED: Ended = { ended: [], wake: [] };

function merge(into: Ended, id: string, r: EndedSession): void {
  into.ended.push(id);
  for (const h of r.wake) if (!into.wake.includes(h)) into.wake.push(h);
}

// The session ends (core/session_end.ts): its liveness row goes, and with
// it everything deliverable against its ID. A 1.x process's name is its
// bindings row's. Callers are inside a transaction.
function end(db: Database, sessionId: string, why: string | null, now: number): EndedSession {
  const row = db.prepare(`DELETE FROM bindings WHERE session_id = ? RETURNING name`).get(sessionId) as { name: string | null } | null;
  return endSession(db, localMail(db), sessionId, { why, legacyNames: row?.name ? [row.name] : [], now });
}

// Reap rows whose process is gone. Callers are inside a transaction. The
// rows were judged before it, so each is re-read and re-probed here: another
// process may have reaped it already (only the one whose delete removed the
// row ends the session), or a keyed session's child may have re-attached.
export function reap(db: Database, rows: SessionRow[], now: number): Ended {
  const out: Ended = { ended: [], wake: [] };
  for (const r of rows) {
    const cur = db.prepare(`SELECT pid, proc_start, harness_rule FROM bindings WHERE session_id = ?`).get(r.session_id) as
      { pid: number; proc_start: string | null; harness_rule: string | null } | null;
    if (!cur || isAlive(cur.pid, cur.proc_start)) continue;
    merge(out, r.session_id, end(db, r.session_id, `reaped: ${pidText(cur)} is gone`, now));
  }
  return out;
}

// Unended IDs with no bindings row: an older grayboard sharing the file
// reaped the row, which deletes only that. Every live local session has one,
// so these sessions are over.
const ORPHAN_SQL = `SELECT id FROM ids WHERE ended_at IS NULL AND id NOT IN (SELECT session_id FROM bindings)`;

/**
 * Every live session row that receives, ending the dead ones: those whose
 * process is gone, and orphans (ORPHAN_SQL). Tools-only processes (#284 S7)
 * and viewers (S9) are ended like any session but never returned: they own
 * no shell, take no name and can't be reached. The probe runs before the write lock; each
 * candidate is re-checked inside it.
 */
export function liveSessions(db: Database): Ended & { alive: SessionRow[] } {
  const rows = db.prepare(SESSION_SQL).all() as SessionRow[];
  const { alive: live, dead } = aliveRows(rows);
  const silent = new Set((db.prepare(`SELECT id FROM ids WHERE (delivery = 'none' OR viewer = 1) AND ended_at IS NULL`).all() as { id: string }[]).map((r) => r.id));
  const alive = live.filter((r) => !silent.has(r.session_id));
  const orphans = db.prepare(ORPHAN_SQL).all() as { id: string }[];
  if (!dead.length && !orphans.length) return { alive, ...NOTHING_ENDED };
  testPause("end:before-txn");
  const ended = db.transaction(() => {
    const now = Date.now();
    const out = reap(db, dead, now);
    for (const { id } of orphans) {
      if (db.prepare(`SELECT 1 FROM bindings WHERE session_id = ?`).get(id)) continue;
      merge(out, id, endSession(db, localMail(db), id, { why: "its process row was removed by an older grayboard", now }));
    }
    return out;
  }).immediate();
  return { alive, ...ended };
}

export type AcquireResult = (
  | { ok: true; name: string; restored: boolean }
  | { ok: false; error: string; holder?: string; known?: string[] }
) & {
  /** A dead holder this acquire ended. */
  ended: Ended;
};

// Whether a roster name is an agent's: not a viewer's, nor a human's.
function agentName(db: Database): (name: string) => boolean {
  const humans = new Set(humanHandles(db));
  const isViewer = viewers(db);
  return (n) => !isViewer(n) && !humans.has(n) && n !== HUMAN_NAME;
}

// Names that exist: the aliases that are agents'.
function knownNames(db: Database): string[] {
  return (db.prepare(`SELECT address FROM aliases ORDER BY last_seen DESC`).all() as { address: string }[])
    .map((r) => r.address)
    .filter(agentName(db));
}

// The session holding `name`, other than `sessionId`: by its hold, or a
// 1.x process by its bindings row's name.
function holdingSession(db: Database, name: string, sessionId: string | null = null): SessionRow | null {
  return db.prepare(`${SESSION_SQL} WHERE (h.address = ?1 OR b.name = ?1) AND b.session_id IS NOT ?2`).get(name, sessionId) as SessionRow | null;
}

/**
 * Bind session `sessionId` to `name`, moving it off `previous` (a rebind).
 * Claims stay with the name they were taken under (#284 S6). `create` allows a name that has never existed (startup
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
    let ended = NOTHING_ENDED;
    const refuse = (error: string, extra: { holder?: string; known?: string[] } = {}): AcquireResult => {
      logBinding(db, sessionId, name, "refused", extra.holder ?? error, now);
      return { ok: false, error, ...extra, ended };
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
    if (holder) ended = reap(db, [holder], now);
    if (sockLive) {
      const who = noRowHolder(db, name, before !== null || holder !== null);
      return refuse(`"${name}" is held by ${who}`, { holder: who });
    }

    // bindings.name too: a 1.x process sharing the file sees the holder there
    // (its UNIQUE and its holder check), not in alias_holds.
    const r = db.prepare(`UPDATE bindings SET name = ?, bound_at = ? WHERE session_id = ?`).run(name, now, sessionId);
    if (r.changes !== 1) throw new Error(`grayboard: session ${sessionId} has no bindings row`);
    ensureAlias(db, name, sessionId, now);
    if (opts.previous) dropHold(db, opts.previous, sessionId);
    holdAlias(db, name, sessionId, now);
    const restart = opts.restartOf === undefined ? null : continuityOf(db, name, { restartOf: opts.restartOf });
    if (opts.previous) logBinding(db, sessionId, opts.previous, "released", `rebound to ${name}`, now);
    logBinding(db, sessionId, name, opts.previous ? "moved" : "bound", opts.previous ?? restart?.detail ?? null, now);
    return { ok: true, name, restored: restart?.verified ?? false, ended };
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
 * This session ends (a clean exit, or a refusal at start). `held` is the
 * name it still held, if any, so the caller removes that name's socket.
 */
export function endLocalSession(db: Database, sessionId: string): Ended & { held: string | null } {
  return db.transaction(() => {
    const r = end(db, sessionId, null, Date.now());
    const out: Ended = { ended: [], wake: [] };
    merge(out, sessionId, r);
    return { ...out, held: r.held[0] ?? null };
  }).immediate();
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
  const live = new Set(liveSessions(db).alive.map((r) => r.name).filter((n): n is string => n !== null));
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
