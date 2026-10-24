import type { Database } from "bun:sqlite";

import { canSeeBoard, normalizeBoard, post, redeliverQueuePost } from "./boards.ts";
import { CoreError } from "./errors.ts";

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

type ClaimEvent = "take" | "renew" | "refused" | "release" | "expire" | "moved";

// One claim_events row; callers are inside the claim's transaction.
export function logEvent(db: Database, event: ClaimEvent, handle: string, c: Partial<Claim> & { key: string }, at: number, heldBy?: string): void {
  db.prepare(
    `INSERT INTO claim_events (key, handle, event, note, board, expires_at, held_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.key, handle, event, c.note ?? null, c.board ?? null, c.expires_at ?? null, heldBy ?? null, at);
}

function announce(db: Database, handle: string, board: string | null, text: string): string[] {
  if (!board) return [];
  return post(db, handle, board, text).wake;
}

// The claim's watchers as @mentions for a post about it. An end post takes
// them (clears them), so a later claim on the same key starts with none.
// Mentions skip anyone who can't see the board.
function watchersCc(db: Database, key: string, take: boolean): string {
  const sql = take ? `DELETE FROM claim_watches WHERE key = ? RETURNING handle` : `SELECT handle FROM claim_watches WHERE key = ?`;
  const rows = db.prepare(sql).all(key) as { handle: string }[];
  return rows.length ? ` cc ${rows.map((r) => `@${r.handle}`).join(" ")}` : "";
}

// Acquire, or renew if you already hold it. Expired claims are free. A
// renewal without a ttl or stop time never shortens the claim, and one that
// changes the note announces it to the board and the watchers.
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
    let expires = expiresAt(now, opts.ttl_minutes, opts.until);
    // Announce a lapsed claim before anyone takes it over.
    const lapsed = sweepIn(db, now);
    const cur = db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as Claim | undefined;
    if (cur && cur.expires_at > now && cur.holder !== handle) {
      logEvent(db, "refused", handle, { key, note: opts.note, board }, now, cur.holder);
      return { ok: false, held_by: cur.holder, note: cur.note, expires_at: cur.expires_at, wake: lapsed };
    }
    const renewed = !!cur && cur.expires_at > now && cur.holder === handle;
    if (renewed && opts.ttl_minutes === undefined && opts.until === undefined) expires = Math.max(expires, cur.expires_at);
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
    logEvent(db, renewed ? "renew" : "take", handle, row, now);
    const wake = !renewed
      ? announce(db, handle, row.board, `[claim] ${key}${row.note ? ` — ${row.note}` : ""}`)
      : opts.note !== undefined && opts.note !== cur.note && row.board && canSeeBoard(db, handle, row.board)
        ? announce(db, handle, row.board, `[update] ${key} — ${opts.note}${watchersCc(db, key, false)}`)
        : [];
    return { ok: true, claim: row, renewed, wake: [...new Set([...lapsed, ...wake])] };
  }).immediate();
}

export function release(db: Database, handle: string, keyInput: string, note?: string): { wake: string[] } {
  const key = validKey(keyInput);
  return db.transaction(() => {
    const cur = db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as Claim | undefined;
    if (!cur || cur.expires_at <= Date.now()) throw new CoreError(`no active claim on "${key}"`);
    if (cur.holder !== handle) throw new CoreError(`"${key}" is held by ${cur.holder}, not you`);
    db.prepare(`DELETE FROM claims WHERE key = ?`).run(key);
    logEvent(db, "release", handle, { ...cur, note: note ?? null }, Date.now());
    if (key.startsWith("queue:")) {
      // A declined queue post goes to the next lane with the original post;
      // the decline post would itself rotate as a new work item, so it isn't
      // announced either (#192 review).
      watchersCc(db, key, true);
      const lane = redeliverQueuePost(db, key, cur.holder, Date.now());
      return { wake: lane ? [lane] : [] };
    }
    const cc = watchersCc(db, key, true);
    // If the holder lost access to the board since claiming, release quietly;
    // watchers too, since they're told through the board.
    const board = cur.board && canSeeBoard(db, handle, cur.board) ? cur.board : null;
    return { wake: announce(db, handle, board, `[release] ${key}${note ? ` — ${note}` : ""}${cc}`) };
  }).immediate();
}

// A session that rebinds takes its claims to the new name (#182): renew and
// release compare the holder, so claims left on the old name could be neither
// renewed nor released by the session doing the work. Runs inside the
// caller's transaction (the bind's), so the claims move with the name. Each
// move is a "moved" event under the new holder, held_by naming the old one.
export function moveClaims(db: Database, from: string, to: string, now = Date.now()): Claim[] {
  const moved = db.prepare(`UPDATE claims SET holder = ? WHERE holder = ? AND expires_at > ? RETURNING *`).all(to, from, now) as Claim[];
  for (const c of moved) logEvent(db, "moved", to, c, now, from);
  return moved;
}

// A queue post's holder replied in its thread: the work is handled. Releases
// the claim with an ack note - no redelivery (handled is handled), no board
// post. A decline, by contrast, is claim_release, which redelivers. Runs
// inside the caller's transaction; returns whether `handle` held it.
export function ackQueueClaim(db: Database, handle: string, key: string, now = Date.now()): boolean {
  const cur = db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as Claim | undefined;
  if (!cur || cur.expires_at <= now || cur.holder !== handle) return false;
  db.prepare(`DELETE FROM claims WHERE key = ?`).run(key);
  watchersCc(db, key, true);
  logEvent(db, "release", handle, { ...cur, note: "ack" }, now);
  return true;
}

// Be told when someone else's claim is updated or ends, whatever your mode on
// its board: the update, release or expiry post @mentions you. Needs a claim with a board, which
// is where that post goes. off: stop watching.
export function watch(db: Database, handle: string, keyInput: string, off = false): string {
  const key = validKey(keyInput);
  if (off) {
    db.prepare(`DELETE FROM claim_watches WHERE key = ? AND handle = ?`).run(key, handle);
    return `ok: not watching ${key}`;
  }
  const cur = db.prepare(`SELECT * FROM claims WHERE key = ? AND expires_at > ?`).get(key, Date.now()) as Claim | undefined;
  if (!cur) throw new CoreError(`no active claim on "${key}"; claim_take it instead`);
  if (cur.holder === handle) throw new CoreError(`you hold "${key}"`);
  if (!cur.board || !canSeeBoard(db, handle, cur.board)) {
    throw new CoreError(
      `"${key}" isn't announced on a board you can see, so its end can't reach you; ask ${cur.holder} to renew it with board=`,
    );
  }
  db.prepare(`INSERT OR IGNORE INTO claim_watches (key, handle) VALUES (?, ?)`).run(key, handle);
  return `ok: watching ${key}; its updates, release or expiry on #${cur.board} will mention you`;
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
    logEvent(db, "expire", c.holder, c, now);
    if (c.key.startsWith("queue:")) {
      // A queue post's claim lapsed: re-offer the original post to the next
      // lane instead of announcing - an expiry post on a queue board would
      // itself rotate as a new work item (#192 review).
      watchersCc(db, c.key, true);
      const lane = redeliverQueuePost(db, c.key, c.holder, now);
      if (lane) wake.add(lane);
      continue;
    }
    const cc = watchersCc(db, c.key, true);
    // As in release(): a holder who lost access to the board lapses quietly.
    if (!c.board || !canSeeBoard(db, c.holder, c.board)) continue;
    const text = `[expired] ${c.key}: not released by ${c.holder}; check with them before relying on it${cc}`;
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
