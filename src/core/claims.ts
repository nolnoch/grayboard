import type { Database } from "bun:sqlite";

import { REDELIVERED_NOTE, canSeeBoard, getBoard, isHuman, normalizeBoard, post, redeliverQueuePost, seenHandles, systemBody, userViewer, type BoardPredicate, type PostOpts, type PostResult, type Viewer } from "./boards.ts";
import { addressParts } from "./addresses.ts";
import { idRow } from "./bindings.ts";
import { CoreError } from "./errors.ts";
import { immediateTx, type WriteTx } from "./write_tx.ts";

export type Claim = {
  key: string;
  holder: string;
  note: string | null;
  board: string | null;
  acquired_at: number;
  expires_at: number;
};

// The columns a caller sees: every one but holder_user, which names the claimant's user (#855).
const CLAIM_COLS = "key, holder, note, board, acquired_at, expires_at";
// A row as the claim's own code reads it: holder_user is the claimant's signed-in user, null in local mode and
// on a claim taken before the column.
export type ClaimRow = Claim & { holder_user: string | null };

// The user an announcement the system writes for a claim (its expiry, a session end's release) is recorded
// as written by (#855): the claimant's, or for a claim from before holder_user (or a queue delivery to an alias
// no session held then) an ID holder's principal, else the user of the session holding the alias now, else a
// person alias's person. A team alias nobody holds names no user. The rule is pure; both modes read its facts.
export function holderUserRule(c: ClaimRow, idPrincipal: string | null | undefined, heldPrincipal: string | null | undefined): string | undefined {
  if (c.holder_user) return c.holder_user;
  if (idPrincipal) return idPrincipal;
  if (heldPrincipal) return heldPrincipal;
  const p = addressParts(c.holder);
  return p?.kind === "alias" && p.scopeKind === "person" ? p.scope : undefined;
}

/** holderUserRule's facts: the principal of the ID `holder` names, and of the session holding `holder` as an alias. */
export function holderPrincipals(db: Database, holder: string): { idPrincipal: string | null; heldPrincipal: string | null } {
  const held = db.prepare(`SELECT i.principal FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ?`).get(holder) as
    { principal: string | null } | null;
  return { idPrincipal: idRow(db, holder)?.principal ?? null, heldPrincipal: held?.principal ?? null };
}

export function holderUser(db: Database, c: ClaimRow): string | undefined {
  if (c.holder_user) return c.holder_user;
  const f = holderPrincipals(db, c.holder);
  return holderUserRule(c, f.idPrincipal, f.heldPrincipal);
}

/**
 * Who a claim's end (a release or a lapse) is announced for on its board (#1286), judged in order:
 * - `"holder"`: the holder can still see the board; a release carries its note.
 * - `"user"`: the holder can't, but the claimant's user (holderUser, #855) can, as a session confined to its binder's
 *   other team (#1255) whose user still sees the board. The post is written for that user, in fixed text: never the
 *   caller's note, explicit claim_release or a session end's alike, so a confined holder's own words can't reach a
 *   board outside its team. Its watchers keep the end post they were promised (principle 3).
 * - `null`: neither can (or the claim has no board): a quiet end, its watches consumed all the same.
 * The rule is pure; both modes read its facts, the user's only when the holder's fails.
 */
export function endReachRule(board: string | null, holderSees: boolean, user: string | undefined, userSees: boolean): "holder" | "user" | null {
  if (!board) return null;
  if (holderSees) return "holder";
  return user !== undefined && userSees ? "user" : null;
}

/** endReachRule on `db` for claim `c`: the board and, on the user's path, the user and its sight for the post's gate. */
function endReach(db: Database, c: ClaimRow): { board: string; user?: { name: string; sees: BoardPredicate } } | null {
  const board = c.board;
  const holderSees = !!board && canSeeBoard(db, c.holder, board);
  const user = board && !holderSees ? holderUser(db, c) : undefined;
  const sees = user === undefined ? undefined : userViewer(db, user);
  const via = endReachRule(board, holderSees, user, !!board && !!sees && canSeeBoard(db, sees, board));
  if (via === null) return null;
  return via === "holder" ? { board: board! } : { board: board!, user: { name: user!, sees: sees! } };
}

// A claim as a reader sees it: a holder whose name the reader may not see (a team's alias, outside the team,
// #871) reads as held by nobody named, its note withheld with it, since a team's labels stay inside it (#284 S13).
export type ClaimView = Omit<Claim, "holder"> & { holder: string | null };

// Whether `seer` (a session ID or handle) may not see that `holder` exists (#348, #871).
function holderHidden(db: Database, seer: string, holder: string): boolean {
  return seenHandles(db, seer, [holder]).length === 0;
}

export type ClaimChanges = { wake: string[]; boards: string[] };
export type ClaimResult = ClaimChanges & (
  | { ok: true; claim: Claim; renewed: boolean }
  | { ok: false; held_by: string | null; note: string | null; expires_at: number }
);

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

export function validKey(key: string): string {
  const k = key.trim();
  if (!k || k.length > 200) throw new CoreError("claim key must be 1-200 chars");
  // Postgres text can't hold NUL (#807 P3 C5a F1), and a key goes into every announcement of its claim.
  if (k.includes("\0")) throw new CoreError("claim key contains a NUL character");
  return k;
}

// A claim note is a line of status (#76): stored on the claim and every
// claim_events row, and announced on its board.
export const MAX_NOTE_CHARS = 1000;
function validNote(note: string | undefined): void {
  if (note !== undefined && note.length > MAX_NOTE_CHARS) throw new CoreError(`note must be at most ${MAX_NOTE_CHARS} chars`);
  if (note?.includes("\0")) throw new CoreError("claim note contains a NUL character");
}

export type ClaimEvent = "take" | "renew" | "refused" | "release" | "expire";
export type ClaimEventRow = { handle: string; event: ClaimEvent; note: string | null; at: number };

// One claim_events row; callers are inside the claim's transaction.
export function logEvent(db: Database, event: ClaimEvent, handle: string, c: Partial<Claim> & { key: string }, at: number, heldBy?: string): void {
  db.prepare(
    `INSERT INTO claim_events (key, handle, event, note, board, expires_at, held_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.key, handle, event, c.note ?? null, c.board ?? null, c.expires_at ?? null, heldBy ?? null, at);
}

// The calling session (#284): `addresses` is its address set, the primary
// first; `session` its ID, recorded on the posts it makes (S8); `via` the
// child session acting under those addresses (#523), recorded beside it;
// `user` the signed-in user on a server, recorded as the post's author_user.
export type ClaimCtx = { addresses?: string[]; session?: string; via?: string; user?: string };

// --- The claim rules, pure (#807 B5b3a): both modes' claim tools run these in the same order over their own reads
// and writes, so the decisions and the texts have one copy.

export type TakeOpts = { ttl_minutes?: number; until?: string; note?: string; board?: string };

/** claim_take's argument checks, in order: the key, the note, the reserved queue: keyspace, the ttl or stop time,
 * the board name. Throws CoreError; reads nothing. */
export function checkTake(keyInput: string, opts: TakeOpts): { key: string; board: string | null } {
  const key = validKey(keyInput);
  validNote(opts.note);
  // The queue: keyspace is the delivery machinery's: only claimQueuePost
  // mints these keys, against a post that exists on a board the lane can
  // see. A public take would let any handle squat a future post's key - the
  // audit would record a delivery that never happened, and the lane's
  // reply-ack would fail (#192 review).
  if (key.startsWith("queue:"))
    throw new CoreError(
      `claim keys starting "queue:" are reserved for queue-board delivery; pick up queued work through the board flow instead`,
    );
  expiresAt(Date.now(), opts.ttl_minutes, opts.until); // validate before taking the lock
  return { key, board: opts.board ? normalizeBoard(opts.board) : null };
}

export type TakeDecision = { held: true } | { held: false; renewed: boolean; as: string; expires: number };

/** Whether `cur` (the key's row, any expiry) is someone else's live claim, and if not, the take: a claim held by any
 * of `addresses` renews as its holder; a renewal without a ttl or stop time never shortens it; a new claim is
 * taken as `handle`. */
export function takeDecision(cur: Claim | undefined, addresses: string[], handle: string, now: number, opts: TakeOpts): TakeDecision {
  let expires = expiresAt(now, opts.ttl_minutes, opts.until);
  const renewed = !!cur && cur.expires_at > now && addresses.includes(cur.holder);
  if (cur && cur.expires_at > now && !renewed) return { held: true };
  if (renewed && opts.ttl_minutes === undefined && opts.until === undefined) expires = Math.max(expires, cur.expires_at);
  return { held: false, renewed, as: renewed ? cur.holder : handle, expires };
}

/** A held take's answer: a holder the caller may not see reads as nobody named, its note withheld with it (#871). */
/** A held claim's answer: no holder or note for a holder the caller can't see, and no note for a claim on a board it
 * can't see, since the note was written for that board's room (#1257). */
export function heldAnswer(cur: Claim, hidden: boolean, boardHidden = false): { ok: false; held_by: string | null; note: string | null; expires_at: number } {
  return { ok: false, held_by: hidden ? null : cur.holder, note: hidden || boardHidden ? null : cur.note, expires_at: cur.expires_at };
}

/** Whether a renewal moves the claim onto a board it wasn't on. */
export function moves(renewed: boolean, row: Claim, cur: Claim | undefined): boolean {
  return renewed && !!row.board && row.board !== cur?.board;
}

/** A renewal that moves the claim onto an archived board would start new business there (#635), like a fresh
 * [claim]; it rolls back instead. So does one moving it onto a board its holder can't see (#1269): the caller saw the
 * board, but a renewal through another of its addresses keeps that address as holder, which would then hold a claim on
 * a board it can't read and announce nothing there. `archived` is whether `row.board` is archived; `holderSees` whether
 * `row.holder` may see it. */
export function checkMove(renewed: boolean, row: Claim, cur: Claim | undefined, archived: boolean, holderSees: boolean): void {
  if (!moves(renewed, row, cur)) return;
  if (archived) throw new CoreError(`#${row.board} is archived; a claim can't move onto it`);
  if (!holderSees) throw new CoreError(`${row.holder}, which holds ${row.key}, can't see #${row.board}; a claim can't move onto it`);
}

/** Whether a renewal announces: its note changed. The caller also needs the board, seen by the holder. */
export function renewAnnounces(note: string | undefined, cur: Claim | undefined): boolean {
  return note !== undefined && note !== cur?.note;
}

/** The watchers as a post's mentions. */
export const ccText = (handles: string[]): string => handles.length ? ` cc ${handles.map((h) => `@${h}`).join(" ")}` : "";
export const claimText = (key: string, note: string | null): string => `[claim] ${key}${note ? ` — ${note}` : ""}`;
export const updateText = (key: string, note: string, cc: string[]): string => `[update] ${key} — ${note}${ccText(cc)}`;
export const releaseText = (key: string, note: string | undefined, cc: string[]): string => `[release] ${key}${note ? ` — ${note}` : ""}${ccText(cc)}`;
export const expiredText = (key: string, holder: string, cc: string[]): string =>
  `[expired] ${key}: not released by ${holder}; check with them before relying on it${ccText(cc)}`;
export const unclaimedText = (key: string, takers: number, cc: string[]): string =>
  `[unclaimed] ${key}: ${takers === 1 ? "its one lane" : `all ${takers} lanes`} passed on it, and no other lane is left; it stays here unclaimed${ccText(cc)}`;

/** release's argument checks: the key and the note. */
export function checkRelease(keyInput: string, note: string | undefined): string {
  const key = validKey(keyInput);
  validNote(note);
  return key;
}

/** Whether `cur` is a live claim held by one of `addresses`: the only claim release ends. */
export function releasable(cur: Claim | undefined, addresses: string[], now: number): boolean {
  return !!cur && cur.expires_at > now && addresses.includes(cur.holder);
}

/** A release that ends nothing: no live claim, or someone else's (named only when the caller may see them). */
export function releaseRefusal(key: string, cur: Claim | undefined, now: number, hidden: boolean): CoreError {
  if (!cur || cur.expires_at <= now) return new CoreError(`no active claim on "${key}"`);
  return new CoreError(hidden ? `"${key}" is held by someone else` : `"${key}" is held by ${cur.holder}, not you`);
}

/** When one of `addresses` released `key`, if nothing has happened to the key since: its release is the key's
 * latest event, or on a queue: key the one its own redelivery directly followed. `events` are the key's latest
 * two, newest first. Otherwise undefined. */
export function releasedByRule(events: ClaimEventRow[], key: string, addresses: string[]): number | undefined {
  const [last, prev] = events;
  if (last?.event === "release" && addresses.includes(last.handle)) return last.at;
  const redelivered = key.startsWith("queue:") && last?.event === "take" && last.note === REDELIVERED_NOTE;
  if (redelivered && prev?.event === "release" && addresses.includes(prev.handle)) return prev.at;
  return undefined;
}

/** claim_watch's refusals, in the order its checks run. */
export const watchNoClaim = (key: string) => new CoreError(`no active claim on "${key}"; claim_take it instead`);
export const watchOwn = (key: string) => new CoreError(`you hold "${key}"`);
export const watchNoBoard = (key: string, holder: string | null) => new CoreError(
  `"${key}" isn't announced on a board you can see, so its end can't reach you; ask ${holder ?? "its holder"} to renew it with board=`,
);
export const watching = (key: string, board: string) => `ok: watching ${key}; its updates, release or expiry on #${board} will mention you`;
export const notWatching = (key: string) => `ok: not watching ${key}`;

/** claim_release's answers: a release, and a repeat of the caller's own. */
export const releasedText = (key: string) => `released ${key}`;
export const alreadyReleasedText = (at: number) => `already released by you at ${new Date(at).toISOString()}`;

// --- The claim SQL (#807 B5b3a). Each statement is already the form a concurrent store needs, so SQLite runs the
// shape Postgres will: a take or release that a racing write beat returns no row rather than overwriting.

/** The key's row, live or lapsed. */
export function claimRow(db: Database, key: string): ClaimRow | undefined {
  return (db.prepare(`SELECT * FROM claims WHERE key = ?`).get(key) as ClaimRow | null) ?? undefined;
}

export type TakeRow = { key: string; as: string; note: string | null; board: string | null; now: number; expires: number; user: string | null };

/** Take or renew: the upsert keeps the note and board a renewal leaves out, and the acquired time of a live
 * renewal. It overwrites only a lapsed row or the holder's own (D3): null when a live claim of someone else's
 * was there, which the caller answers as held. */
export function takeClaim(db: Database, t: TakeRow): Claim | null {
  return (db.prepare(
    `INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(key) DO UPDATE SET
       holder = excluded.holder,
       holder_user = excluded.holder_user,
       note = COALESCE(excluded.note, CASE WHEN claims.holder = excluded.holder THEN claims.note END),
       board = COALESCE(excluded.board, CASE WHEN claims.holder = excluded.holder THEN claims.board END),
       acquired_at = CASE WHEN claims.holder = excluded.holder AND claims.expires_at > ?5
                          THEN claims.acquired_at ELSE excluded.acquired_at END,
       expires_at = excluded.expires_at
     WHERE claims.expires_at <= ?5 OR claims.holder = excluded.holder
     RETURNING ${CLAIM_COLS}`,
  ).get(t.key, t.as, t.note, t.board, t.now, t.expires, t.user) as Claim | null) ?? null;
}

/** End `holder`'s live claim on `key`: the deleted row, or null when it wasn't (a racing release or sweep ended it). */
export function releaseClaim(db: Database, key: string, holder: string, now: number): ClaimRow | null {
  return (db.prepare(`DELETE FROM claims WHERE key = ? AND holder = ? AND expires_at > ? RETURNING *`).get(key, holder, now) as ClaimRow | null) ?? null;
}

/** The key's latest two events, newest first: what releasedByRule reads. */
export function recentClaimEvents(db: Database, key: string): ClaimEventRow[] {
  return db.prepare(`SELECT handle, event, note, at FROM claim_events WHERE key = ? ORDER BY id DESC LIMIT 2`).all(key) as ClaimEventRow[];
}

/** The claim's watchers, by handle. */
export function claimWatchers(db: Database, key: string): string[] {
  return (db.prepare(`SELECT handle FROM claim_watches WHERE key = ? ORDER BY handle`).all(key) as { handle: string }[]).map((r) => r.handle);
}

/** The watchers of a claim that ended, by handle, and their watches gone: a later claim on the key starts with none. */
export function takeClaimWatchers(db: Database, key: string): string[] {
  const handles = claimWatchers(db, key);
  if (handles.length) db.prepare(`DELETE FROM claim_watches WHERE key = ?`).run(key);
  return handles;
}

/** The key's live claim, for a watch. */
export function liveClaim(db: Database, key: string, now: number): Claim | undefined {
  return (db.prepare(`SELECT * FROM claims WHERE key = ? AND expires_at > ?`).get(key, now) as Claim | null) ?? undefined;
}

export function addClaimWatch(db: Database, key: string, handle: string): void {
  db.prepare(`INSERT OR IGNORE INTO claim_watches (key, handle) VALUES (?, ?)`).run(key, handle);
}

export function removeClaimWatch(db: Database, key: string, handle: string): void {
  db.prepare(`DELETE FROM claim_watches WHERE key = ? AND handle = ?`).run(key, handle);
}

/** Delete the claims lapsed at `now`, and return them in lapse order, by key within a tie: the delete makes each
 * lapse announce once, however many sweep, and the order is the store's, not the delete's. A queue claim's lapse
 * redelivers its post, so lapse order keeps the lanes' rotation as the claims were taken. */
export function expireClaims(db: Database, now: number): ClaimRow[] {
  const gone = db.prepare(`DELETE FROM claims WHERE expires_at <= ? RETURNING *`).all(now) as ClaimRow[];
  return gone.sort((a, b) => a.expires_at - b.expires_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// --- Core's claim tools, composed over the rules and the SQL above.

// A new claim can't announce on an archived board (#635); its update, release
// or expiry, ending what's already there, can (`ending`).
// `seenBy` passes the gate for a claimant's user whose holder lost the board (endReach, #1286).
function announce(db: Database, handle: string, board: string | null, text: string, ctx: ClaimCtx = {}, ending = true, seenBy?: BoardPredicate): ClaimChanges {
  if (!board) return { wake: [], boards: [] };
  const result = post(db, handle, board, systemBody(text), null, { author_id: ctx.session, via: ctx.via, author_user: ctx.user, allowArchived: ending, seenBy });
  return { wake: result.wake, boards: [result.post.board] };
}

// Acquire, or renew if you already hold it. Expired claims are free. A
// renewal without a ttl or stop time never shortens the claim, and one that
// changes the note announces it to the board and the watchers.
// IMMEDIATE takes the write lock up front so two processes can't both win.
// `addresses` is the caller's address set (#284 S5), `handle` its primary: a
// claim held by any of them is the caller's, and a renewal keeps the address
// it was taken under; a new claim is taken as `handle`.
export function claim(
  db: Database,
  handle: string,
  keyInput: string,
  opts: TakeOpts & ClaimCtx = {},
): ClaimResult {
  const { key, board } = checkTake(keyInput, opts);
  const addresses = opts.addresses ?? [handle];

  return db.transaction((): ClaimResult => {
    // A board that doesn't exist, or that `handle` can't see, refuses as a
    // post to it would (#81), not as the claims row's foreign key failing.
    if (board && !canSeeBoard(db, handle, board)) throw new CoreError(`no such board #${board}; see board_list`);
    const now = Date.now();
    // Announce a lapsed claim before anyone takes it over.
    const lapsed = sweepChanges(db, now);
    const held = (cur: Claim): ClaimResult => {
      logEvent(db, "refused", handle, { key, note: opts.note, board }, now, cur.holder);
      return { ...heldAnswer(cur, holderHidden(db, opts.session ?? handle, cur.holder), !!cur.board && !canSeeBoard(db, handle, cur.board)), ...lapsed };
    };
    const cur = claimRow(db, key);
    const d = takeDecision(cur, addresses, handle, now, opts);
    if (d.held) return held(cur!);
    const row = takeClaim(db, { key, as: d.as, note: opts.note ?? null, board, now, expires: d.expires, user: opts.user ?? null });
    if (!row) return held(claimRow(db, key)!);
    const moved = moves(d.renewed, row, cur);
    checkMove(d.renewed, row, cur, moved && !!getBoard(db, row.board!)?.archived_at, !moved || row.holder === handle || canSeeBoard(db, row.holder, row.board!));
    logEvent(db, d.renewed ? "renew" : "take", d.as, row, now);
    const changed = !d.renewed
      ? announce(db, d.as, row.board, claimText(key, row.note), opts, false)
      : renewAnnounces(opts.note, cur) && row.board && canSeeBoard(db, d.as, row.board)
        ? announce(db, d.as, row.board, updateText(key, opts.note!, claimWatchers(db, key)), opts)
        : { wake: [], boards: [] };
    return {
      ok: true, claim: row, renewed: d.renewed,
      wake: [...new Set([...lapsed.wake, ...changed.wake])],
      boards: [...new Set([...lapsed.boards, ...changed.boards])],
    };
  }).immediate();
}

// A queue post's claim ended without an ack: offer the post to the next lane
// that hasn't held it. With none left, the post stays readable on its board
// unclaimed, and a reply in its thread, as the lane that held it last, tells
// the poster and the claim's watchers (#220). The reply's author shows that
// last lane, as `[expired]` posts show a holder; its text counts the lanes
// rather than naming them. A decline's reply is the declining session's
// (`ctx`); a lapse's is the claimant's user (#855). A holder that lost the
// board ends it as release does (endReach, #1286): the reply is posted for the
// claimant's user when that user still sees the board, never as the caller's
// session. When neither can write it, or it's refused, the post's own author
// writes it (#1175), else it ends quietly.
function requeue(db: Database, c: ClaimRow, now: number, ctx: ClaimCtx = {}): ClaimChanges {
  const cc = takeClaimWatchers(db, c.key);
  const r = redeliverQueuePost(db, c.key, c.holder, now);
  if (!r) return { wake: [], boards: [] };
  if ("lane" in r) return { wake: [r.lane], boards: [] };
  const text = systemBody(unclaimedText(c.key, r.held, cc));
  const changes = (res: PostResult): ClaimChanges => ({ wake: res.wake, boards: [res.post.board] });
  // Judged on the post's board, the key's, which claimQueuePost also recorded as the claim's. A human holder (a
  // claim from before humans left the lanes) never writes it: system text never bears the human mark (#1175).
  const end = isHuman(db, c.holder) ? null : endReach(db, { ...c, board: r.board });
  if (end) {
    // The system's reply for the claimant's user: no caller's session, via or name set reaches it.
    const opts: PostOpts = end.user
      ? { author_user: end.user.name, allowArchived: true, seenBy: end.user.sees }
      : { author_id: ctx.session, via: ctx.via, addresses: ctx.addresses, author_user: ctx.user ?? holderUser(db, c), allowArchived: true };
    const res = refusedAsNull(() => post(db, c.holder, r.board, text, r.postId, opts));
    if (res) return changes(res);
  }
  // No holder can write it (#1175): the post's own author, the reader it informs, writes it into its own thread as the
  // post's writer (its session and user as the post records them), so post's own-exclusion keeps the post's address
  // set (authorAddresses) out of the fan-out: it never wakes itself; the claim's watchers are told as before. Only while the author sees the board (the post's
  // gate judges it), and never a declared human's: system text never bears the human mark (principle 10,
  // docs/slack-bridge.md §3), so a human's post ends quietly.
  if (isHuman(db, r.author.handle)) return { wake: [], boards: [] };
  const res = refusedAsNull(() => post(db, r.author.handle, r.board, text, r.postId, {
    author_id: r.author.id ?? undefined, author_user: r.author.user ?? undefined, allowArchived: true,
  }));
  return res ? changes(res) : { wake: [], boards: [] };
}

/** `f`'s result, or null when it's refused (a CoreError): a system post that can't land writes nothing. */
function refusedAsNull<T>(f: () => T): T | null {
  try {
    return f();
  } catch (e) {
    if (e instanceof CoreError) return null;
    throw e;
  }
}

// releasedAt: this caller had already released the claim, at that time, and
// nothing has happened to it since: a repeat whose first answer was lost
// (#254) succeeds without a second release event or redelivery. A claim held
// by any of `addresses` is released as its holder (#284 S5).
export function release(
  db: Database,
  handle: string,
  keyInput: string,
  note?: string,
  ctx: ClaimCtx = {},
): ClaimChanges & { releasedAt?: number } {
  const key = checkRelease(keyInput, note);
  const addresses = ctx.addresses ?? [handle];
  return db.transaction(() => {
    const now = Date.now();
    const refuse = (cur: ClaimRow | undefined) => {
      const releasedAt = releasedByRule(recentClaimEvents(db, key), key, addresses);
      if (releasedAt !== undefined) return { wake: [], boards: [], releasedAt };
      if (cur && hiddenQueue(cur, (b) => canSeeBoard(db, handle, b))) throw releaseRefusal(key, undefined, now, false);
      throw releaseRefusal(key, cur, now, !!cur && cur.expires_at > now && holderHidden(db, ctx.session ?? handle, cur.holder));
    };
    const cur = claimRow(db, key);
    if (!releasable(cur, addresses, now)) return refuse(cur);
    const gone = releaseClaim(db, key, cur!.holder, now);
    if (!gone) return refuse(claimRow(db, key));
    const as = gone.holder;
    logEvent(db, "release", as, { ...gone, note: note ?? null }, now);
    if (key.startsWith("queue:")) {
      // A declined queue post goes to the next lane with the original post;
      // the decline post would itself rotate as a new work item, so it isn't
      // announced either (#192 review).
      return requeue(db, gone, now, ctx);
    }
    const cc = takeClaimWatchers(db, key);
    // A holder who lost the board releases for its user, without the note, or quietly (endReach, #1286); watchers
    // are consumed either way, since they're told through the board.
    const end = endReach(db, gone);
    if (!end) return { wake: [], boards: [] };
    // The system's post for the claimant's user: no caller's session, note or name set reaches it.
    if (end.user) return announce(db, as, end.board, releaseText(key, undefined, cc), { user: end.user.name }, true, end.user.sees);
    // A release with no signed-in caller is the system's (a session end's): it posts as the claimant's user (#855).
    return announce(db, as, end.board, releaseText(key, note, cc), { ...ctx, user: ctx.user ?? holderUser(db, gone) });
  }).immediate();
}

// A queue post's holder replied in its thread: the work is handled. Releases
// the claim with an ack note - no redelivery (handled is handled), no board
// post. A decline, by contrast, is claim_release, which redelivers. Runs
// inside the caller's transaction; returns whether one of `addresses` held it.
export function ackQueueClaim(db: Database, addresses: string[], key: string, now = Date.now()): boolean {
  const cur = claimRow(db, key);
  // A lapsed row the sweep hasn't reached is still the holder's: the reply
  // handled the post, so redelivering it would duplicate the work (#234).
  if (!cur || !addresses.includes(cur.holder)) return false;
  db.prepare(`DELETE FROM claims WHERE key = ?`).run(key);
  takeClaimWatchers(db, key);
  logEvent(db, "release", cur.holder, { ...cur, note: cur.expires_at <= now ? "ack (late)" : "ack" }, now);
  return true;
}

// Be told when someone else's claim is updated or ends, whatever your mode on
// its board: the update, release or expiry post @mentions you. Needs a claim with a board, which
// is where that post goes. off: stop watching. A claim held by any of
// `addresses` is yours.
export function watch(db: Database, handle: string, keyInput: string, off = false, addresses: string[] = [handle], seer: string = handle): string {
  const key = validKey(keyInput);
  if (off) {
    removeClaimWatch(db, key, handle);
    return notWatching(key);
  }
  const cur = liveClaim(db, key, Date.now());
  if (!cur || hiddenQueue(cur, (b) => canSeeBoard(db, handle, b))) throw watchNoClaim(key);
  if (addresses.includes(cur.holder)) throw watchOwn(key);
  if (!cur.board || !canSeeBoard(db, handle, cur.board)) throw watchNoBoard(key, holderHidden(db, seer, cur.holder) ? null : cur.holder);
  addClaimWatch(db, key, handle);
  return watching(key, cur.board);
}

// Claims are visible to everyone on the bus. The announcing board's name is
// hidden from handles that can't see that board; with `seer` (a session ID or
// handle), a holder it may not see is withheld with its note (#871).
export function listClaims(db: Database, prefix?: string): Claim[];
export function listClaims(db: Database, prefix: string | undefined, viewer: Viewer, seer?: string): ClaimView[];
export function listClaims(db: Database, prefix?: string, viewer?: Viewer, seer?: string): ClaimView[] {
  const rows = db
    .prepare(
      `SELECT ${CLAIM_COLS} FROM claims WHERE expires_at > ? AND key LIKE ? ESCAPE '\\' ORDER BY key`,
    )
    .all(Date.now(), `${(prefix ?? "").replace(/[\\%_]/g, "\\$&")}%`) as Claim[];
  if (viewer === undefined) return rows;
  return rows
    .filter((c) => !isQueueKey(c.key) || (!!c.board && canSeeBoard(db, viewer, c.board)))
    .map((c) => claimView(c, !c.board || canSeeBoard(db, viewer, c.board), seer === undefined || !holderHidden(db, seer, c.holder)));
}

/** A queue post's claim (claimQueuePost): its key names its board and post, so a reader who can't see the board
 * isn't shown it, and claim_watch and claim_release answer it as no claim (#270 D5). */
export function isQueueKey(key: string): boolean {
  return key.startsWith("queue:");
}

/** Whether `c` is a queue post's claim on a board the caller (`sees`) can't see: it answers as no claim at all. */
export function hiddenQueue(c: { key: string; board: string | null }, sees: (board: string) => boolean): boolean {
  return isQueueKey(c.key) && !(c.board && sees(c.board));
}

/** A claim as a reader sees it: its board named only when `boardSeen`, its holder and note only when `holderSeen`. */
export function claimView(c: Claim, boardSeen: boolean, holderSeen: boolean): ClaimView {
  // A claim on a board the viewer can't see shows neither the board nor its note, written for that room (#1257).
  const v: ClaimView = boardSeen ? c : { ...c, board: null, note: null };
  return holderSeen ? v : { ...v, holder: null, note: null };
}

// Delete lapsed claims and say so on their boards. The holder never confirmed
// the work was done, so the post says to check with them. Runs inside the
// caller's transaction: the delete makes each lapse announce once, however
// many sessions sweep.
export function sweepChanges(db: Database, now: number): ClaimChanges {
  const wake = new Set<string>();
  const boards = new Set<string>();
  for (const c of expireClaims(db, now)) {
    logEvent(db, "expire", c.holder, c, now);
    if (c.key.startsWith("queue:")) {
      // A queue post's claim lapsed: re-offer the original post to the next
      // lane instead of announcing - an expiry post on a queue board would
      // itself rotate as a new work item (#192 review).
      const changed = requeue(db, c, now);
      for (const h of changed.wake) wake.add(h);
      for (const board of changed.boards) boards.add(board);
      continue;
    }
    const cc = takeClaimWatchers(db, c.key);
    // As in release(): a holder who lost the board lapses for its user, or quietly (endReach, #1286).
    const end = endReach(db, c);
    if (!end) continue;
    const changed = announce(db, c.holder, end.board, expiredText(c.key, c.holder, cc), { user: end.user?.name ?? holderUser(db, c) }, true, end.user?.sees);
    for (const h of changed.wake) wake.add(h);
    for (const board of changed.boards) boards.add(board);
  }
  return { wake: [...wake], boards: [...boards] };
}

export function sweepIn(db: Database, now: number): string[] {
  return sweepChanges(db, now).wake;
}

export function sweepExpired(db: Database, now = Date.now()): ClaimChanges {
  return db.transaction(() => sweepChanges(db, now)).immediate();
}

// What an expiry timer reads and writes: the next expiry of a claim with a board, and the sweep, which reads the
// clock inside its write. A server's store reads asynchronously (#807 P3 B2); local mode's reads are synchronous.
export type ExpirySource = {
  next(): number | null | Promise<number | null>;
  sweep(): ClaimChanges | Promise<ClaimChanges>;
};

// One timer, armed for the next expiry of a claim with a board, so a lapse is
// announced when it happens. Call arm() after anything that may have added a
// claim (a tool call, a wakeup); it only ever moves the timer earlier. stop() is terminal.
export function claimExpiryTimer(
  db: Database,
  onWake: (handles: string[]) => void,
  onBoardsChanged?: (boards: string[]) => void | Promise<void>,
  tx: WriteTx = immediateTx(db),
): { arm(): void; stop(): void } {
  return expiryTimer({
    next: () => (db.prepare(`SELECT MIN(expires_at) AS next FROM claims WHERE board IS NOT NULL`).get() as { next: number | null }).next,
    // A queued `tx` may make the sweep wait (#807 D4): the clock is read inside it.
    sweep: () => tx((w) => sweepChanges(w, Date.now())),
  }, onWake, onBoardsChanged);
}

// claimExpiryTimer over any source. An asynchronous next() resolves after the arm that asked: a read that started
// before a commit may miss that commit's claim, but the commit's own arm reads after it; a stale earlier time only
// fires an empty sweep, which re-arms. A failed sweep or read retries after `retryMs`: a transient store error
// mustn't leave live claims' lapses unannounced until the next arm.
export function expiryTimer(
  source: ExpirySource,
  onWake: (handles: string[]) => void,
  onBoardsChanged?: (boards: string[]) => void | Promise<void>,
  retryMs = 5_000,
): { arm(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let at = Infinity;
  let stopped = false;
  const set = (when: number) => {
    if (stopped) return;
    clearTimeout(timer);
    at = when;
    timer = setTimeout(() => void fire().catch(e => console.error("[grayboard] claim expiry timer failed:", e)), Math.max(0, when - Date.now()));
    timer.unref?.();
  };
  const fire = async () => {
    if (stopped) return;
    timer = undefined;
    at = Infinity;
    try {
      // A stop while the sweep waited still stops what follows.
      const { wake, boards } = await source.sweep();
      if (stopped) return;
      if (boards.length) {
        try { void Promise.resolve(onBoardsChanged?.(boards)).catch(() => {}); } catch {}
      }
      if (!stopped && wake.length) onWake(wake);
    } catch (e) {
      console.error("[grayboard] claim expiry sweep failed:", e);
      return set(Date.now() + retryMs);
    }
    arm();
  };
  const moveTo = (next: number | null) => {
    if (next !== null && next < at) set(next);
  };
  const arm = () => {
    if (stopped) return;
    const next = source.next();
    if (!(next instanceof Promise)) return moveTo(next);
    // set() checks stopped, so a stop while the read waited arms nothing.
    next.then(moveTo, e => { console.error("[grayboard] claim expiry arm failed:", e); moveTo(Date.now() + retryMs); });
  };
  arm();
  return {
    arm,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      at = Infinity;
    },
  };
}
