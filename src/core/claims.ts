import type { Database } from "bun:sqlite";

import { CoreError, canSeeBoard, normalizeBoard, post } from "./boards.ts";

export type Claim = {
  key: string;
  holder: string;
  note: string | null;
  board: string | null;
  acquired_at: number;
  expires_at: number;
};

export type ClaimResult =
  | { ok: true; claim: Claim; renewed: boolean; wake: string[] }
  | { ok: false; held_by: string; note: string | null; expires_at: number; wake: string[] };

const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 7 * 24 * 60;

// Absolute expiry from either a duration or a stop time. Stored as a
// timestamp, so a claim outlives the sessions and machines that took it.
function expiresAt(now: number, minutes: number | undefined, until: string | undefined): number {
  if (minutes !== undefined && until !== undefined) throw new CoreError("pass ttl_minutes or until, not both");
  if (until !== undefined) {
    const t = Date.parse(until);
    if (Number.isNaN(t)) throw new CoreError(`until must be an ISO 8601 time, got "${until}"`);
    if (t <= now || t - now > MAX_TTL_MIN * 60_000) throw new CoreError("until must be in the future and at most 7 days away");
    return t;
  }
  const m = minutes ?? DEFAULT_TTL_MIN;
  if (!(m > 0) || m > MAX_TTL_MIN) throw new CoreError(`ttl_minutes must be in (0, ${MAX_TTL_MIN}]`);
  return now + m * 60_000;
}

function validKey(key: string): string {
  const k = key.trim();
  if (!k || k.length > 200) throw new CoreError("claim key must be 1-200 chars");
  return k;
}

function announce(db: Database, handle: string, board: string | null, text: string): string[] {
  if (!board) return [];
  return post(db, handle, board, text).wake;
}

// Acquire, or renew if you already hold it. Expired claims are free.
// IMMEDIATE takes the write lock up front so two processes can't both win.
export function claim(
  db: Database,
  handle: string,
  keyInput: string,
  opts: { ttl_minutes?: number; until?: string; note?: string; board?: string } = {},
): ClaimResult {
  const key = validKey(keyInput);
  expiresAt(Date.now(), opts.ttl_minutes, opts.until); // validate before taking the lock
  const board = opts.board ? normalizeBoard(opts.board) : null;

  return db.transaction((): ClaimResult => {
    const now = Date.now();
    const expires = expiresAt(now, opts.ttl_minutes, opts.until);
    // Announce a lapsed claim before anyone takes it over.
    const lapsed = sweepIn(db, now);
    const cur = db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as Claim | undefined;
    if (cur && cur.expires_at > now && cur.holder !== handle) {
      return { ok: false, held_by: cur.holder, note: cur.note, expires_at: cur.expires_at, wake: lapsed };
    }
    const renewed = !!cur && cur.expires_at > now && cur.holder === handle;
    const row = db
      .prepare(
        `INSERT INTO claims (key, holder, note, board, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           holder = excluded.holder,
           note = COALESCE(excluded.note, CASE WHEN claims.holder = excluded.holder THEN claims.note END),
           board = COALESCE(excluded.board, CASE WHEN claims.holder = excluded.holder THEN claims.board END),
           acquired_at = CASE WHEN claims.holder = excluded.holder AND claims.expires_at > ?
                              THEN claims.acquired_at ELSE excluded.acquired_at END,
           expires_at = excluded.expires_at
         RETURNING *`,
      )
      .get(key, handle, opts.note ?? null, board, now, expires, now) as Claim;
    const wake = renewed
      ? []
      : announce(db, handle, row.board, `[claim] ${key}${row.note ? ` — ${row.note}` : ""}`);
    return { ok: true, claim: row, renewed, wake: [...new Set([...lapsed, ...wake])] };
  }).immediate();
}

export function release(db: Database, handle: string, keyInput: string): { wake: string[] } {
  const key = validKey(keyInput);
  return db.transaction(() => {
    const cur = db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as Claim | undefined;
    if (!cur || cur.expires_at <= Date.now()) throw new CoreError(`no active claim on "${key}"`);
    if (cur.holder !== handle) throw new CoreError(`"${key}" is held by ${cur.holder}, not you`);
    db.prepare(`DELETE FROM claims WHERE key = ?`).run(key);
    // If the holder lost access to the board since claiming, release quietly.
    const board = cur.board && canSeeBoard(db, handle, cur.board) ? cur.board : null;
    return { wake: announce(db, handle, board, `[release] ${key}`) };
  }).immediate();
}

// Claims are visible to everyone on the bus. The announcing board's name is
// hidden from handles that can't see that board.
export function listClaims(db: Database, prefix?: string, viewer?: string): Claim[] {
  const rows = db
    .prepare(
      `SELECT * FROM claims WHERE expires_at > ? AND key LIKE ? ESCAPE '\\' ORDER BY key`,
    )
    .all(Date.now(), `${(prefix ?? "").replace(/[\\%_]/g, "\\$&")}%`) as Claim[];
  if (viewer === undefined) return rows;
  return rows.map((c) => (c.board && !canSeeBoard(db, viewer, c.board) ? { ...c, board: null } : c));
}

// Delete lapsed claims and say so on their boards. The holder never confirmed
// the work was done, so the post says to check with them. Runs inside the
// caller's transaction: the delete makes each lapse announce once, however
// many sessions sweep.
function sweepIn(db: Database, now: number): string[] {
  const gone = db.prepare(`DELETE FROM claims WHERE expires_at <= ? RETURNING *`).all(now) as Claim[];
  const wake = new Set<string>();
  for (const c of gone) {
    // As in release(): a holder who lost access to the board lapses quietly.
    if (!c.board || !canSeeBoard(db, c.holder, c.board)) continue;
    const text = `[expired] ${c.key}: not released by ${c.holder}; check with them before relying on it`;
    for (const h of announce(db, c.holder, c.board, text)) wake.add(h);
  }
  return [...wake];
}

export function sweepExpired(db: Database, now = Date.now()): { wake: string[] } {
  return db.transaction(() => ({ wake: sweepIn(db, now) })).immediate();
}

// One timer, armed for the next expiry of a claim with a board, so a lapse is
// announced when it happens. Call arm() after anything that may have added a
// claim (a tool call, a wakeup); it only ever moves the timer earlier.
export function claimExpiryTimer(
  db: Database,
  onWake: (handles: string[]) => void,
): { arm(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let at = Infinity;
  const set = (when: number) => {
    clearTimeout(timer);
    at = when;
    timer = setTimeout(fire, Math.max(0, when - Date.now()));
    timer.unref?.();
  };
  const fire = () => {
    timer = undefined;
    at = Infinity;
    try {
      const { wake } = sweepExpired(db);
      if (wake.length) onWake(wake);
    } catch (e) {
      console.error("[grayboard] claim expiry sweep failed:", e);
      return set(Date.now() + 5_000);
    }
    arm();
  };
  const arm = () => {
    const row = db.prepare(`SELECT MIN(expires_at) AS next FROM claims WHERE board IS NOT NULL`).get() as {
      next: number | null;
    };
    if (row.next !== null && row.next < at) set(row.next);
  };
  arm();
  return {
    arm,
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
      at = Infinity;
    },
  };
}
