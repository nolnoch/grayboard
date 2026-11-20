import type { Database } from "bun:sqlite";
import { describeLocation } from "../shared/identity.ts";
import type { Pending, Post } from "../shared/notifications.ts";
import { bindAttachments, dropAttachments, withAttachments, type FileSend } from "./attachments.ts";
import { CoreError, IdCollision } from "./errors.ts";
import { ackQueueClaim, logEvent } from "./claims.ts";
import { addressParts, aliasScope, type AliasScope, type ScopeKind } from "./addresses.ts";
import { writeCoreAudit, type AuditSink } from "./audit.ts";
import { SESSION_ID_PATTERN } from "./session_id.ts";
import { SESSION_FACT_MAX } from "../shared/protocol.ts";
import { undeliverableId } from "./session_end.ts";

// For callers outside the storage seam (src/server/*) that pass the handle through.
export type CoreDb = Database;

export const BOARD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PURPOSE_CHARS = 500;

// A post's or direct message's body, checked alike in both modes (#75).
export function checkBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) throw new CoreError("body is required");
  // Postgres text can't hold NUL (#807 P3 C5 decision 7): refused in both modes, so they stay at parity.
  if (body.includes("\0")) throw new CoreError("body contains a NUL character");
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new CoreError(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return body;
}

/** A body the system composed (a claim's announcement, expiry or `[unclaimed]` reply) with each NUL as U+FFFD: its
 * key or note may come from a row written before claim keys and notes refused NUL, and it must still post, since a
 * sweep that refused it would refuse every later take (#807 P3 C5a F1). Authors' bodies keep checkBody's refusal. */
export const systemBody = (body: string): string => body.replaceAll("\0", "\uFFFD");
// @id:<13 Crockford> (a session, #284), @name, @scope/name, @user@org.com/name.
// Not preceded by a word char or @, so plain email addresses in prose aren't
// mentions. A malformed @id:… is the alias "id", as before IDs.
const MENTION_RE = new RegExp(
  `(?:^|[^\\w@])@(${SESSION_ID_PATTERN}(?![0-9a-z])|[a-z0-9._%+-]+(?:@[a-z0-9.-]+\\.[a-z]{2,})?(?:\\/[a-z0-9_-]{1,32})?)`,
  "gi",
);

export type SubMode = "push" | "digest" | "quiet";

// scope: null for an open board, or an opaque string the Access policy
// interprets (the distributed server uses "team:<name>").
export type Board = {
  name: string;
  purpose: string;
  scope: string | null;
  created_by: string;
  created_at: number;
  kind?: string;
  // Set only on an archived board (#635); open boards carry neither.
  archived_at?: number;
  archived_by?: string;
};

// A boards row as callers see it: an open board's NULL archive columns are
// dropped, so every board_list row doesn't pay for them.
function showBoard<T extends Board>(b: T): T {
  const row = b as T & { archived_at?: number | null; archived_by?: string | null };
  if (row.archived_at == null) {
    delete row.archived_at;
    delete row.archived_by;
  }
  return b;
}

// A post's columns as readers see them. author_id (#284) is the writing
// session's provenance, kept in the database and left out of reads and pushes;
// via (#523) is shown, since it names a child writer the author address hides.
const POST_COLS = `id, board, author, via, body, parent_id, created_at, expires_at`;
const P_POST_COLS = `p.id, p.board, p.author, p.via, p.body, p.parent_id, p.created_at, p.expires_at`;

// A post row as stored: via null for a root's own post.
type PostRow = Omit<Post, "via"> & { via: string | null };

// A post as readers see it: via only when a child wrote it, so a root's
// posts don't pay for the key.
function showPost<P extends { via?: string | null }>(p: P): Omit<P, "via"> & { via?: string } {
  if (p.via != null) return p as Omit<P, "via"> & { via?: string };
  const { via: _, ...rest } = p;
  return rest;
}

// Enough to acknowledge a Pending item after it crossed a wire.
export type PendingRef =
  | { kind: "push"; post_id: number }
  | { kind: "digest"; board: string; latest_id: number };


// ── access policy ────────────────────────────────────────────────────────────

// Who can see which board, and who an @token means. Every core read and write
// goes through this, so a mode can't forget to filter at a call site.
export type Access = {
  canSee(handle: string, board: Board): boolean;
  // Returns an error message, or null if allowed.
  checkCreate(handle: string, scope: string | null): string | null;
  // The handle a mention token refers to, or null if unknown or ambiguous.
  // `strict`: a token that names a session that can't receive refuses the
  // post instead of going unresolved. `viewer` (the posting session's ID, else
  // the author) is whose sight a refusal's name suggestions follow (#348).
  resolveMention(token: string, author: string, board: Board, strict: boolean, viewer?: string): string | null;
  // Whether a post by `from` may reach `to` as a thread reply. Omitted: always.
  mayReach?(from: string, to: string): boolean;
  // Whether the principal of `handle` (the calling session's ID) may read an alias's labels (task, owner,
  // source board, spec hash, description) in peer_list: only inside a scope
  // it may act in (#284 S13).
  seesAliasMeta(handle: string, scope: Omit<AliasScope, "name">): boolean;
  // Whether the principal of `handle` may see that an alias of a scope exists
  // at all (peer_list rows, name suggestions): a team's names only inside the
  // team (#348). Omitted: always.
  seesAlias?(handle: string, scope: Omit<AliasScope, "name">): boolean;
  // Whether `handle` may be a lane on `board`, taking its queue work (#270 D5: on a service's board only the
  // service's own addresses consume). Omitted (local mode): anyone who may see the board.
  mayLane?(handle: string, board: Board): boolean;
  // The board only a human handle can start posts on, or null for none.
  announceBoard: string | null;
  // Whether `human` acts for the same user as `address`, so may archive a board
  // it created (#848). Omitted: always (local mode has one user).
  sameUser?(human: string, address: string): boolean;
  // The user `address` acts for (its email), or null for a team, a service or
  // an address that names none; names who else may archive a board in a
  // refusal. Omitted: the refusal says "your user" (local mode has one).
  ownerOf?(address: string): string | null;
  // Whether `user`, a claimant's user (claims.holder_user, #855) named by its principal's name, may see `board`
  // itself, whatever its sessions are bound to: a claim's end is announced for it when its holder lost the board
  // (#1286). Omitted (local mode: one user, and a holder sees every board there is): never.
  userSees?(user: string, board: Board): boolean;
};

export const ANNOUNCE_BOARD = "announce";

// Local mode: one trusted machine, every board open, bare handles only.
export const openAccess = (db: Database): Access => ({
  announceBoard: ANNOUNCE_BOARD,
  canSee: () => true,
  seesAliasMeta: () => true,
  checkCreate: (_h, scope) => (scope === null ? null : "team boards need distributed mode"),
  // An @id: is the session itself; one that can't receive refuses an
  // author's post, as a direct message to it would (#284 S7, S9). A system
  // post (a claim event quoting its key) leaves it unresolved: a key that
  // names a since-ended ID must not refuse every later sweep and end.
  resolveMention: (token, _author, _board, strict) => {
    if (addressParts(token)?.kind === "id") {
      const why = undeliverableId(db, token);
      if (why && strict) throw why;
      return why ? null : token;
    }
    if (!BOARD_NAME_RE.test(token)) return null;
    const row = db.prepare(`SELECT address FROM aliases WHERE address = ?`).get(token) as
      | { address: string }
      | undefined;
    return row?.address ?? null;
  },
});

const policies = new WeakMap<Database, Access>();

export function setAccess(db: Database, access: Access): void {
  policies.set(db, access);
}

function access(db: Database): Access {
  let a = policies.get(db);
  if (!a) {
    a = openAccess(db);
    policies.set(db, a);
  }
  return a;
}

// ── boards ───────────────────────────────────────────────────────────────────

// Accepts "#name" or "name".
export function normalizeBoard(input: string): string {
  const name = String(input).replace(/^#/, "").toLowerCase();
  if (!BOARD_NAME_RE.test(name)) {
    throw new CoreError(`invalid board name "${input}": use [a-z0-9_-], 1-32 chars`);
  }
  return name;
}

// ── aliases and sessions (#284) ──────────────────────────────────────────────

/**
 * Make `address` an alias if it isn't one: local mode's first bind of a
 * name, or its declared human. A new one is audited as `actor`'s
 * alias.created. The server creates its aliases through its Repo.
 */
export function ensureAlias(db: Database, address: string, actor: string, now = Date.now()): void {
  const s = aliasScope(address);
  const r = db.prepare(
    `INSERT OR IGNORE INTO aliases (address, scope_kind, scope_ref, name, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(address, s.scope_kind, s.scope_ref, s.name, now);
  if (r.changes) writeCoreAudit(db, "alias.created", actor, address);
}

/** A session used `address`: its last_seen moves. An address that isn't an alias is left alone. */
export function touchAlias(db: Database, address: string, now = Date.now()): void {
  db.prepare(`UPDATE aliases SET last_seen = ? WHERE address = ?`).run(now, address);
}

/** The facts a session's ids row starts with. */
export type IdFacts = {
  id: string;
  principal: string | null;
  harness?: string | null;
  cwd?: string | null;
  place?: string | null;
  launcher: boolean;
  // A tools-only process (#284 S7): receives nothing, writes as this alias.
  writesAs?: string;
  // A `grayboard tail` (#284 S9): never listed or addressable.
  viewer?: boolean;
  // The ID came from a session key (#284 S10): retention leaves a tombstone for it.
  keyed?: boolean;
  // Self-reported at launch (BUS_MODEL, BUS_EFFORT; the former hello), shown in peer_list (#284 S12).
  model?: string | null;
  effort?: string | null;
  // A local child session (a harness subagent, #523): the root it acts under.
  // It receives nothing (delivery 'none') and ends with its root.
  rootId?: string;
  // The harness's own id for the session (ids.harness_session, #523 step 5).
  harnessSession?: string;
  localResume?: boolean;
};

// The id_collision refusal (#284 decision 2) lives in errors.ts, so a Postgres store can throw it (#807 P3 C10a).
export { IdCollision, idCollisionText } from "./errors.ts";

/**
 * How long a pruned keyed ID's tombstone lasts (#333): a key re-presented
 * later registers silently, without id.reused. A fixed year, not a multiple
 * of the retention window, so a short window doesn't shorten it.
 */
export const TOMBSTONE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** A keyed ID retention pruned (#284 S10), which a new session has presented again. */
export type ReusedId = { ended_at: number; pruned_at: number };

/**
 * A new session's ids row. Throws IdCollision if the ID already has one.
 * Returns the pruned session's tombstone when the ID is a key re-used after
 * retention deleted its row, for the caller to audit as id.reused; null
 * otherwise. Callers are inside a transaction.
 */
export function registerId(db: Database, f: IdFacts, now = Date.now()): ReusedId | null {
  const prior = db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(f.id) as { ended_at: number | null } | null;
  if (prior) throw new IdCollision(f.id, prior.ended_at);
  db.prepare(
    `INSERT INTO ids (id, principal, harness, cwd, place, launcher, started_at, last_seen, delivery, writes_as, viewer, keyed, model, effort, root_id, harness_session, local_resume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.id, f.principal, cleanFact(f.harness), f.cwd ?? null, cleanPlace(f.place ?? null), f.launcher ? 1 : 0, now, now, f.writesAs === undefined && f.rootId === undefined ? "push" : "none", f.writesAs ?? null, f.viewer ? 1 : 0, f.keyed ? 1 : 0, cleanFact(f.model), cleanFact(f.effort), f.rootId ?? null, f.harnessSession ?? null, f.localResume ? 1 : 0);
  return (db.prepare(`DELETE FROM pruned_ids WHERE id = ? RETURNING ended_at, pruned_at`).get(f.id) as ReusedId | null) ?? null;
}

/**
 * Retention for session IDs (#284 S10, decision 4): delete the ids rows of
 * sessions that ended before `olderThanMs`. Nothing else names an ended ID
 * but provenance text (binding_events, sender_id, audit rows), which stays.
 * A keyed row leaves a pruned_ids tombstone, kept TOMBSTONE_HORIZON_MS past
 * its prune (#333). Returns how many ids rows it deleted.
 */
export function pruneEndedIds(db: Database, olderThanMs: number, now = Date.now()): number {
  return db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO pruned_ids (id, ended_at, pruned_at) SELECT id, ended_at, ? FROM ids WHERE ended_at < ? AND keyed = 1`).run(now, olderThanMs);
    db.prepare(`DELETE FROM pruned_ids WHERE pruned_at < ?`).run(now - TOMBSTONE_HORIZON_MS);
    return db.prepare(`DELETE FROM ids WHERE ended_at < ?`).run(olderThanMs).changes;
  }).immediate();
}

// A self-reported session fact (harness, model, effort; #284 S12) as stored:
// one line of at most SESSION_FACT_MAX characters, since peer_list puts it in
// other agents' prompts. Format characters (\p{Cf}: the bidi controls that
// could reorder what follows, direction marks, zero-width characters) go
// first, then the line is folded, then NFC, so match:{model} compares what a
// reader sees: a hosted client sends it over the network (#364). Empty is none.
export function cleanFact(v: string | null | undefined): string | null {
  return v ? oneLine(v.replace(/\p{Cf}/gu, "")).normalize("NFC").slice(0, SESSION_FACT_MAX).trim() || null : null;
}

/**
 * Set a session's model and effort to the latest it reported (#364): only a
 * field the caller names, `undefined` leaving the stored one alone. Returns the
 * before and after of what changed, or null when nothing did (no write).
 */
export function setIdFacts(db: Database, id: string, facts: { model?: string | null; effort?: string | null }): { before: IdSessionFacts; after: IdSessionFacts } | null {
  const row = db.prepare(`SELECT model, effort FROM ids WHERE id = ?`).get(id) as IdSessionFacts | null;
  if (!row) return null;
  const after = {
    model: facts.model === undefined ? row.model : cleanFact(facts.model),
    effort: facts.effort === undefined ? row.effort : cleanFact(facts.effort),
  };
  if (after.model === row.model && after.effort === row.effort) return null;
  db.prepare(`UPDATE ids SET model = ?, effort = ? WHERE id = ?`).run(after.model, after.effort, id);
  return { before: row, after };
}
export type IdSessionFacts = { model: string | null; effort: string | null };

/** A session used the bus: its last_seen moves. */
export function touchId(db: Database, id: string, now = Date.now()): void {
  db.prepare(`UPDATE ids SET last_seen = ? WHERE id = ?`).run(now, id);
}

/**
 * A restart that took its predecessor's name back is the same harness
 * session (#211): its peer status carries over from the earlier session.
 */
export function inheritStatus(db: Database, id: string, from: string): void {
  db.prepare(
    `UPDATE ids SET (status, status_at) = (SELECT status, status_at FROM ids WHERE id = ?2) WHERE id = ?1 AND EXISTS (SELECT 1 FROM ids WHERE id = ?2)`,
  ).run(id, from);
}

/**
 * Make `handle` the one declared human handle (`grayboard human`). `guard`
 * runs first inside the same write transaction and throws to refuse: local
 * mode checks there that no live agent session holds the handle (#79).
 */
export function declareHuman(db: Database, handle: string, guard?: () => void): void {
  db.transaction(() => {
    guard?.();
    ensureAlias(db, handle, handle);
    touchAlias(db, handle);
    db.prepare(`UPDATE aliases SET human = (address = ?)`).run(handle);
  }).immediate();
}

/** Server mode: one handle per linked user is a human; set or clear one. */
export function markHuman(db: Database, handle: string, human: boolean): void {
  touchAlias(db, handle);
  db.prepare(`UPDATE aliases SET human = ? WHERE address = ?`).run(human ? 1 : null, handle);
}

/** Whether `handle` is a declared human's. */
export function isHuman(db: Database, handle: string): boolean {
  return !!(db.prepare(`SELECT human FROM aliases WHERE address = ?`).get(handle) as { human: number | null } | undefined)?.human;
}

/** Of `handles`, those that are a declared human's (isHuman for each, one statement). */
export function humansAmong(db: Database, handles: string[]): Set<string> {
  if (!handles.length) return new Set();
  return new Set((db.prepare(`SELECT address FROM aliases WHERE human = 1 AND address IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...new Set(handles)])) as { address: string }[]).map((r) => r.address));
}

/** Declared human handles. */
export function humanHandles(db: Database): string[] {
  return (db.prepare(`SELECT address FROM aliases WHERE human = 1 ORDER BY address`).all() as { address: string }[]).map((r) => r.address);
}

export const cleanPlace = (place: string | null): string | null => (place === null ? "" : oneLine(place)).slice(0, 200) || null;

// Server mode: where the session runs, as its client described it.
export function setPlace(db: Database, id: string, place: string | null): void {
  db.prepare(`UPDATE ids SET place = ? WHERE id = ?`).run(cleanPlace(place), id);
}

const MAX_STATUS = 200;

// Bidi marks, embeddings, overrides and isolates (U+061C, U+200E-F,
// U+202A-E, U+2066-9) and zero-width characters (U+200B, U+2060, U+FEFF):
// they reorder or hide what a peer reads (#372). ZWJ (U+200D) builds emoji
// sequences and ZWNJ (U+200C) is orthographic in Persian and Indic text, so
// both stay; that's why this isn't all of \p{Cf}.
const INVISIBLE = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/** Text as one line: whitespace runs to a space, other control and bidi/zero-width characters dropped, trimmed. */
export function oneLine(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}

// One line saying what the session holding `handle` is doing; empty clears
// it. Status is the session's (#284), so it goes to the alias's holder: a
// tools-only process sets its owner's.
export function setStatus(db: Database, handle: string, text: string, now = Date.now()): void {
  const t = statusText(text);
  touchAlias(db, handle, now);
  if (!writeStatus(db, handle, t, now)) throw new CoreError(noStatusText(handle));
}

/** A status as stored: one line, at most MAX_STATUS chars; empty clears it. */
export function statusText(text: string): string {
  const t = oneLine(text);
  if (t.length > MAX_STATUS) throw new CoreError(`status must be at most ${MAX_STATUS} chars`);
  return t;
}

export const noStatusText = (handle: string): string => `no live session holds "${handle}", so it has no status to set`;

// setStatus's write: false when no live session holds `handle`. An ID-only session (#284 S13) sets its own row; a
// name, its holder's.
export function writeStatus(db: Database, handle: string, t: string, now: number): boolean {
  const session = addressParts(handle)?.kind === "id" ? `?3 AND ended_at IS NULL` : `(SELECT id FROM alias_holds WHERE address = ?3)`;
  return db.prepare(`UPDATE ids SET status = ?1, status_at = ?2 WHERE id = ${session}`).run(t || null, t ? now : null, handle).changes > 0;
}

// Queue boards skip a lane that opted out (peer_status queue:"off"); it
// persists across restarts until the lane opts back in. Status text never
// affects the rotation (#192 review): it's free text for humans and peers.
export function setQueueParticipation(db: Database, handle: string, on: boolean): void {
  touchAlias(db, handle);
  db.prepare(`UPDATE aliases SET queue_off = ? WHERE address = ?`).run(on ? null : 1, handle);
}

// A duration as one short unit: 45m, 6h, 14d.
export function age(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// A handle that no longer exists (e.g. a deleted alias) leaves its board
// subscriptions and queued pushes; the server's Repo deletes the alias row.
// Its posts and claims stay: they're history.
export function forgetHandle(db: Database, handle: string): void {
  db.prepare(`DELETE FROM outbox WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM thread_mutes WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM claim_watches WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM alias_holds WHERE address = ?`).run(handle);
}

export function createBoard(
  db: Database,
  handle: string,
  name: string,
  purpose: string,
  scope: string | null = null,
  opts: { kind?: string } = {},
): Board {
  const c = createArgs(name, purpose, opts.kind);
  const denied = access(db).checkCreate(handle, scope);
  if (denied) throw new CoreError(denied);
  if (!insertBoard(db, { name: c.board, purpose: c.purpose, scope, kind: c.kind, createdBy: handle, now: Date.now() })) {
    const old = getBoard(db, c.board);
    throw new CoreError(boardExistsText(c.board, !!old?.archived_at && sees(db, handle, old)));
  }
  subscribe(db, handle, c.board, "push");
  return getBoard(db, c.board)!;
}

/** createBoard's insert, its arguments already checked: the new board, or null when the name is taken. */
export function insertBoard(db: Database, b: { name: string; purpose: string; scope: string | null; kind: string; createdBy: string; now: number }): Board | null {
  const row = db
    .prepare(
      `INSERT INTO boards (name, purpose, scope, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING RETURNING *`,
    )
    .get(b.name, b.purpose, b.scope, b.createdBy, b.now, b.kind) as Board | null;
  return row ? showBoard(row) : null;
}

/** createBoard's argument checks, in its order: the name, then the purpose, then the kind. */
export function createArgs(name: string, purpose: string, kind: string | undefined): { board: string; purpose: string; kind: "broadcast" | "queue" } {
  const board = normalizeBoard(name);
  if (!String(purpose ?? "").trim()) throw new CoreError("purpose is required");
  // One line, shown in every board_list (#76).
  if (purpose.length > MAX_PURPOSE_CHARS) throw new CoreError(`purpose must be at most ${MAX_PURPOSE_CHARS} chars`);
  const k = kind ?? "broadcast";
  if (k !== "broadcast" && k !== "queue") throw new CoreError(`kind must be "broadcast" or "queue"`);
  return { board, purpose: purpose.trim(), kind: k };
}

/** A create's refusal for a taken name; `archivedSeen`: the board is archived and the creator may see it. */
export const boardExistsText = (board: string, archivedSeen: boolean): string =>
  archivedSeen ? `board #${board} already exists, archived; board_archive(board, false) reopens it` : `board #${board} already exists`;

/**
 * Whether board_create's arguments repeat `mine`, made by `handle` (#254), apart from its visibility: the open board
 * with this scope, kind and purpose. `purpose` is read only once the rest matches, as its refusal comes after them.
 */
export function createRepeats(mine: Board | undefined, handle: string, scope: string | null, kind: string | undefined, purpose: () => string): boolean {
  return !!mine && !mine.archived_at && mine.created_by === handle && mine.scope === scope && (mine.kind ?? "broadcast") === (kind ?? "broadcast") && mine.purpose === purpose().trim();
}

/** board_create's answer to a repeat (#254). */
export const createdNote = (mine: Board) => ({ ...mine, note: `you created #${mine.name} at ${new Date(mine.created_at).toISOString()}` });

// Archive or reopen a board (#635). An archived board leaves board_list,
// refuses new top-level posts (replies still land, so open threads finish) and
// stays readable by name; subscriptions, cursors and claims are untouched.
// Archiving isn't an edit (principle 5): no post changes, and it reverses.
// Only the board's creator (any of the caller's addresses) or the creator's
// own user's human may; a mode's own boards (#announce, a team's board) never
// archive.
export function archiveBoard(
  db: Database,
  handle: string,
  boardInput: string,
  archived: boolean,
  opts: { addresses?: string[]; human?: boolean } = {},
): { board: Board; note?: string } {
  const b = visibleBoard(db, handle, boardInput);
  archiveGate(b, access(db).announceBoard);
  const addresses = opts.addresses ?? [handle];
  const human = (opts.human || isHuman(db, handle)) && (access(db).sameUser?.(handle, b.created_by) ?? true);
  if (!human && !addresses.includes(b.created_by)) {
    const a = access(db);
    throw new CoreError(archiveRefusalText(b, a.ownerOf ? a.ownerOf(b.created_by) : undefined));
  }
  const note = archiveRepeat(b, archived);
  if (note) return { board: b, note };
  return { board: setArchived(db, b.name, archived ? handle : null, Date.now())! };
}

/**
 * Archives the board as `by` at `now`, or with `by` null reopens it: the board after, or null when it was already
 * in that state, so a repeat never overwrites who archived it or when.
 */
export function setArchived(db: Database, name: string, by: string | null, now: number): Board | null {
  const row = db
    .prepare(
      `UPDATE boards SET archived_at = ?, archived_by = ? WHERE name = ? AND archived_at IS ${by === null ? "NOT NULL" : "NULL"} RETURNING *`,
    )
    .get(by === null ? null : now, by, name) as Board | null;
  return row ? showBoard(row) : null;
}

/** Refuses to archive a mode's own board (#announce, a team's board). */
export function archiveGate(b: Board, announceBoard: string | null): void {
  if (b.name === announceBoard || b.scope === `team:${b.name}`) {
    throw new CoreError(`#${b.name} belongs to the bus itself and can't be archived`);
  }
}

/** A repeat archive or reopen, answered from state (#254) and never written twice; undefined when it changes `b`. */
export function archiveRepeat(b: Board, archived: boolean): string | undefined {
  if (archived && b.archived_at) return `#${b.name} was already archived at ${new Date(b.archived_at).toISOString()} by ${b.archived_by}`;
  if (!archived && !b.archived_at) return `#${b.name} isn't archived`;
  return undefined;
}

/**
 * Who may archive or reopen `b`, named for a caller who may not. `owner`: the creator's user (null for none), or
 * undefined in a mode with one user.
 */
export function archiveRefusalText(b: Board, owner: string | null | undefined): string {
  const who = `only #${b.name}'s creator (${b.created_by})`;
  if (owner === undefined) return `${who} or your user can archive or reopen it`;
  return owner
    ? `${who} or its user (${owner}, from Slack: archive #${b.name} / reopen #${b.name}) can archive or reopen it`
    : `${who} can archive or reopen it`;
}

// For a mode's own bookkeeping (e.g. a team's board), not agent requests:
// no access check, no creator subscription. Returns false if it exists.
export function ensureBoard(
  db: Database,
  name: string,
  purpose: string,
  scope: string | null,
  createdBy: string,
): boolean {
  const res = db
    .prepare(
      `INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(normalizeBoard(name), purpose, scope, createdBy, Date.now());
  return res.changes > 0;
}

// Unchecked lookup, for modes and policies. Tools go through visibleBoard.
export function getBoard(db: Database, name: string): Board | undefined {
  const b = db.prepare(`SELECT * FROM boards WHERE name = ?`).get(name) as Board | null;
  return b ? showBoard(b) : undefined;
}

// A board you can't see reads as missing, so its existence doesn't leak.
// Who a side-effect-free read is judged for: an address, or a predicate for a
// reader that has none (an unbound hosted session, judged by its principal).
// A predicate has no subscriptions, cursors or pushes, so a read it judges
// changes nothing.
export type BoardPredicate = (board: Board) => boolean;
export type Viewer = string | BoardPredicate;
const sees = (db: Database, viewer: Viewer, b: Board): boolean =>
  typeof viewer === "string" ? access(db).canSee(viewer, b) : viewer(b);

function visibleBoard(db: Database, handle: Viewer, input: string): Board {
  const name = normalizeBoard(input);
  const b = getBoard(db, name);
  if (!b || !sees(db, handle, b)) {
    throw new CoreError(`no such board #${name}; see board_list`);
  }
  return b;
}

// A claimant's user (#855) as a viewer: the boards Access.userSees gives it, none in local mode (#1286).
export function userViewer(db: Database, user: string): BoardPredicate {
  const a = access(db);
  return (b) => a.userSees?.(user, b) ?? false;
}

export function canSeeBoard(db: Database, viewer: Viewer, name: string): boolean {
  const b = getBoard(db, name);
  return !!b && sees(db, viewer, b);
}

function tipOf(db: Database, board: string): number {
  const row = db.prepare(`SELECT MAX(id) AS tip FROM posts WHERE board = ?`).get(board) as {
    tip: number | null;
  };
  return row.tip ?? 0;
}

// Unread = after your cursor, not yours, and not already pushed to you in
// full (a mention or thread reply), so one post never notifies twice.
const NOT_PUSHED = `NOT EXISTS (SELECT 1 FROM outbox o WHERE o.handle = ? AND o.post_id = p.id)`;
// For counts and board_read, a deferred push still waiting is unread, so
// reading the board picks it up early (and marks it delivered).
const NOT_PUSHED_YET = `NOT EXISTS (SELECT 1 FROM outbox o WHERE o.handle = ? AND o.post_id = p.id
  AND (o.wake = 1 OR o.delivered_at IS NOT NULL))`;

// A post not written by the reader's session (#284 S5): neither as the
// reader's address nor by the session that is it or holds it, nor by a child
// of that session (#523: a subagent writing under its addresses, whose posts
// are its root's own), whichever of its addresses it wrote as. Binds the
// reader's address three times.
const NOT_OWN = `NOT (p.author = ? OR p.author_id IS NOT NULL AND COALESCE((SELECT id FROM alias_holds WHERE address = ?), ?)
  IN (p.author_id, COALESCE((SELECT root_id FROM ids WHERE id = p.author_id), p.author_id)))`;

export type BoardSummary = Board & { mode: SubMode | null; unread: number; posts: number };

// What a board call without `as` acts for (#284 S14, #366): "read"
// (board_read, board_list's rows) and "subscribe" (board_subscribe) prefer an
// address subscribed to the board, so a held alias's own subscription can be
// read and changed; "read" puts one with unread posts first, so repeated
// reads drain each subscribed address in turn. "post" (board_post) takes the
// first that can see the board, as every use does when none is subscribed.
export type BoardUse = "read" | "subscribe" | "post";

// Each of `handles`' view of the boards it can see (of `board` alone, when given).
// A board summary's columns before mode and unread, shared by both list paths.
const BOARD_COLUMNS = `b.*, (SELECT COUNT(*) FROM posts p WHERE p.board = b.name) AS posts`;

export type BoardView = { handle: string; row: BoardSummary };

function boardViews(db: Database, handles: string[], board: string | null): BoardView[] {
  const a = access(db);
  return boardViewRows(db, handles, board).filter((v) => a.canSee(v.handle, v.row));
}

/** Each of `handles`' view of every board (of `board` alone, when given), unjudged: in handle order, then board name. */
export function boardViewRows(db: Database, handles: string[], board: string | null): BoardView[] {
  const q = db.prepare(
    `SELECT ${BOARD_COLUMNS}, s.mode AS mode,
            CASE WHEN s.handle IS NULL THEN 0 ELSE
              (SELECT COUNT(*) FROM posts p
                WHERE p.board = b.name AND p.id > s.cursor AND ${NOT_OWN} AND ${NOT_PUSHED_YET}) END AS unread
       FROM boards b
       LEFT JOIN subscriptions s ON s.board = b.name AND s.handle = ?
      WHERE ? IS NULL OR b.name = ?
      ORDER BY b.name`,
  );
  return handles.flatMap((h) => (q.all(h, h, h, h, h, board, board) as BoardSummary[]).map((row) => ({ handle: h, row: showBoard(row) })));
}

/** The view a use acts as, from one board's views in address order. */
export function pickView<T extends { row: BoardSummary }>(views: T[], use: BoardUse): T | undefined {
  const subscribed = views.filter((v) => v.row.mode !== null);
  const preferred = use === "read" ? (subscribed.find((v) => v.row.unread > 0) ?? subscribed[0]) : use === "subscribe" ? subscribed[0] : undefined;
  return preferred ?? views[0];
}

/** The first of `handles` (primary first) that `use` of `board` acts as; undefined when none can see it. */
export function boardAddress(db: Database, board: string, handles: string[], use: BoardUse): string | undefined {
  return pickView(boardViews(db, handles, board), use)?.handle;
}

/**
 * The open boards `handles` can see (an archived one is read by name, #635): each row is the view of the address
 * board_read without `as` would act as (boardAddress's "read"), so its mode
 * and unread count are that address's subscription's. A predicate (an
 * addressless reader) sees rows with no mode and nothing unread.
 */
export function listBoards(db: Database, handles: string[] | BoardPredicate): BoardSummary[] {
  if (typeof handles === "function") return openSummaryRows(db).filter(handles);
  return boardsFromViews(boardViews(db, handles, null));
}

/** Every open board as an addressless reader sees it: no mode, nothing unread. */
export function openSummaryRows(db: Database): BoardSummary[] {
  const rows = db.prepare(
    `SELECT ${BOARD_COLUMNS}, NULL AS mode, 0 AS unread
       FROM boards b WHERE b.archived_at IS NULL ORDER BY b.name`,
  ).all() as BoardSummary[];
  return rows.map(showBoard);
}

/** board_list's rows from the judged views in address order: open boards, each the view a read acts as, by name. */
export function boardsFromViews(views: BoardView[]): BoardSummary[] {
  const byBoard = new Map<string, BoardView[]>();
  for (const v of views) if (v.row.archived_at === undefined) byBoard.set(v.row.name, [...(byBoard.get(v.row.name) ?? []), v]);
  return [...byBoard.values()].map((vs) => pickView(vs, "read")!.row).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

// mode "off" unsubscribes. New subscriptions start at the tip: no backlog.
export function subscribe(db: Database, handle: string, boardInput: string, mode: SubMode | "off"): void {
  setSubscription(db, handle, visibleBoard(db, handle, boardInput).name, mode);
}

// subscribe's write, for a board the caller already judged visible to handle (the server's async BoardAccess).
export function setSubscription(db: Database, handle: string, board: string, mode: SubMode | "off"): void {
  if (mode === "off") {
    db.prepare(`DELETE FROM subscriptions WHERE board = ? AND handle = ?`).run(board, handle);
    return;
  }
  checkSubMode(mode);
  const tip = tipOf(db, board);
  db.prepare(
    `INSERT INTO subscriptions (board, handle, mode, cursor, notified_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(board, handle) DO UPDATE SET mode = excluded.mode`,
  ).run(board, handle, mode, tip, tip);
}

/** A subscription's mode, checked after the board's visibility: push, digest or quiet ("off" deletes and isn't one). */
export function checkSubMode(mode: string): asserts mode is SubMode {
  if (!["push", "digest", "quiet"].includes(mode)) {
    throw new CoreError(`mode must be push, digest, quiet, or off`);
  }
}

// Mute or unmute one thread, named by any post in it. A muted thread's
// replies stop pushing to you, even on a push board; @mentions still do.
// Digests and unread counts are unaffected: they aren't pushes.
export function muteThread(db: Database, handle: string, boardInput: string, postId: number, muted: boolean): number {
  const board = visibleBoard(db, handle, boardInput).name;
  const p = getPost(db, postId);
  if (!p || p.board !== board) throw new CoreError(threadNotOnBoard(postId, board));
  const root = threadRoot(db, postId);
  setMute(db, handle, root, muted);
  return root;
}

export const threadNotOnBoard = (postId: number, board: string): string => `thread ${postId} is not a post on #${board}`;

// muteThread's write, for a root the caller already found.
export function setMute(db: Database, handle: string, root: number, muted: boolean): void {
  if (muted) {
    db.prepare(`INSERT INTO thread_mutes (handle, root_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(handle, root);
  } else {
    db.prepare(`DELETE FROM thread_mutes WHERE handle = ? AND root_id = ?`).run(handle, root);
  }
}

export function isSubscribed(db: Database, handle: string, board: string): boolean {
  return !!db.prepare(`SELECT 1 FROM subscriptions WHERE board = ? AND handle = ?`).get(board, handle);
}

// Drop a handle's subscriptions to every board with this scope (e.g. on
// leaving a team).
export function unsubscribeScope(db: Database, handle: string, scope: string): void {
  db.prepare(
    `DELETE FROM subscriptions WHERE handle = ? AND board IN (SELECT name FROM boards WHERE scope = ?)`,
  ).run(handle, scope);
}

// Inline code and fenced blocks: a backtick run up to the next run of the
// same length. Text inside is quoted, not addressed.
const CODE_RE = /(`+)[\s\S]*?\1/g;

// Raw @tokens in a body, outside code, lowercased, trailing sentence
// punctuation removed.
export function mentionTokens(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.replace(CODE_RE, " ").matchAll(MENTION_RE)) {
    const t = m[1]!.toLowerCase().replace(/[.]+$/, "");
    if (t) out.add(t);
  }
  return [...out];
}

function resolveMentions(
  db: Database,
  body: string,
  author: string,
  board: Board,
  strict: boolean,
  viewer: string,
): { handles: string[]; unresolved: string[] } {
  const a = access(db);
  const handles = new Set<string>();
  const unresolved: string[] = [];
  for (const t of mentionTokens(body)) {
    const h = a.resolveMention(t, author, board, strict, viewer);
    if (h && a.canSee(h, board)) handles.add(h);
    else unresolved.push(t);
  }
  return { handles: [...handles], unresolved };
}

// wake: handles to wake now. deferred: thread participants whose push waits
// for their next wake. post.attachments: those bound to the post.

// A queue-kind board's claim TTL: how long a lane holds a post before
// sweepExpired redelivers it to the next lane. Matches the claims default
// (claims.ts DEFAULT_TTL_MIN).
const QUEUE_CLAIM_TTL_MS = 30 * 60_000;

// Whether the named board routes each post to one lane (queue kind). Unknown
// or invalid names answer false: the post call reports the real error.
export function isQueueBoard(db: Database, input: string): boolean {
  try {
    return (getBoard(db, normalizeBoard(input))?.kind ?? "broadcast") === "queue";
  } catch {
    return false;
  }
}

export type PostResult = { post: Post; wake: string[]; deferred: string[]; unresolved: string[] };

// online: which handles have a live session (the mode knows); a human's
// announcement needs it. ttl_ms: how long an announcement stays in new
// sessions' instructions. attachments: the poster's unbound uploads to
// carry, bound in the post's transaction under the mode's size caps (send),
// if the mode's user (send.principal) made them.
// author_id: the posting session's ID (#284), when the writer is a session.
// author_user: the writer's signed-in user, on a server.
// via: the child session writing it (#523), a harness subagent acting under
// its root's addresses; author_id is then the child's ID too.
// addresses: the poster's address set (#284 S5), `handle` the one it posts as; a
// queue claim held by any of them is acked, and none of them is pushed the post.
export type PostOpts = {
  online?: (handle: string) => boolean;
  addresses?: string[];
  author_id?: string;
  author_user?: string;
  via?: string;
  ttl_ms?: number;
  attachments?: { ids: number[]; send?: FileSend };
  // An author's own words: an @id: that can't receive refuses the post, and
  // a declared human's bears the human mark (postMark). Unset (system posts),
  // it goes unresolved, and the post never bears the mark.
  strictIds?: boolean;
  // A system post ending something already announced on the board (a claim's
  // release, update or expiry) still lands once the board is archived (#635).
  allowArchived?: boolean;
  // Whose sight passes the gate in the author's stead: only a claim's end post for the claimant's user, when the
  // holder lost the board (#1286), derived from the claim row. No tool's arguments reach it.
  seenBy?: BoardPredicate;
};

// Eligible lanes for a queue board's rotation, least-recently-woken first
// (never-woken first, then by handle). A lane was last woken at its latest
// queue take on the board (a delivery or redelivery, #221: an old post's
// redelivery counts when it was handed over, not when it was written), or at
// the newest board post in its outbox (a mention or a thread reply), whichever is later. A take counts for the lane of
// the session that made it while that session is live (#1351); any other take, and every push (an outbox row has no
// session), counts under any address of its session now (its ID or an alias it holds, #1174: a take as its ID before
// it bound counts). A lane is a push subscriber who isn't
// one of the poster's addresses (its address set: a session's own lane never
// takes its own post, whichever alias it posted as), hasn't opted out (peer_status queue:"off"), isn't a
// declared human (#1175: a human isn't a work lane, so no queue claim, and no system text written as its holder,
// ever bears the human mark), and isn't a read-only viewer. A lane is named by the address subscribed, but a
// subscription under an ID names the session's primary, the oldest alias it
// holds, else the ID (#284 S8, S13; an ID can't opt out): a session that
// subscribed unbound stays in the rotation after it binds, once however many
// aliases it holds. With
// `online`, live lanes come first; offline lanes are the fallback in the same
// order, so an empty live set still delivers.
export function queueLanes(
  db: Database,
  b: Board,
  poster: string[],
  opts: { online?: (handle: string) => boolean } = {},
): string[] {
  const a = access(db);
  return orderLanes(queueLaneRows(db, b.name, poster), viewers(db), (h) => a.canSee(h, b), laneHook(a, b), opts.online);
}

/** Access.mayLane for `b` as a predicate: everyone when the mode has no such rule. */
export const laneHook = (a: Access, b: Board): ((h: string) => boolean) => (a.mayLane ? (h) => a.mayLane!(h, b) : () => true);

/**
 * queueLanes' judgment over its rows, kept in their rotation order: no viewers, only lanes that may see the board and
 * may be its lanes (Access.mayLane, #270 D5), live first. Every rotation and redelivery goes through here, so none
 * skips the lane rule.
 */
export function orderLanes(
  rows: string[],
  isViewer: (h: string) => boolean,
  sees: (h: string) => boolean,
  mayLane: (h: string) => boolean,
  online?: (h: string) => boolean,
): string[] {
  const lanes = rows.filter((h) => !isViewer(h) && sees(h) && mayLane(h));
  if (!online) return lanes;
  return [...lanes.filter((h) => online(h)), ...lanes.filter((h) => !online(h))];
}

/**
 * SQL for the session an address belongs to now (#1174): an alias's holder, else the address itself (an ID, or an
 * alias no session holds). A queue lane is its session, not the handle it held when it took a post: the rotation's
 * history (queueLaneRowsSql) and a redelivery's one-turn rule (redeliveryFacts) find a lane's session through this,
 * and map an address-keyed take (liveSessionSql) through it. `h` is an SQL expression.
 */
export function laneSessionSql(h: string): string {
  return `COALESCE((SELECT id FROM alias_holds WHERE address = ${h}), ${h})`;
}

/**
 * SQL that is true when `sid` (an SQL expression) names a live session (#1351). A claim_events row whose session_id
 * passes is session-keyed: it belongs to that session whatever its handle names now. NULL, or a session that has
 * ended (a restart mints a new ID and rebinds the name), makes the row address-keyed: it maps through who holds its
 * handle now (laneSessionSql), so a name's successor inherits its history and a restart can't re-open #220's
 * ping-pong.
 */
function liveSessionSql(sid: string): string {
  return `EXISTS (SELECT 1 FROM ids x WHERE x.id = ${sid} AND x.ended_at IS NULL)`;
}

/** SQL for `lane`'s address set, a parenthesized one-column (`address`) subquery: its session's ID and every alias it
 * holds (laneSessionSql), or the address alone when no session holds it. An address-keyed take (liveSessionSql) or a
 * push under any of them woke this lane, and an address-keyed take under any of them was its turn at a post. */
function laneAddressesSql(lane: string): string {
  const sid = laneSessionSql(lane);
  return `(SELECT ${sid} AS address UNION ALL SELECT address FROM alias_holds WHERE id = ${sid})`;
}

/** queueLanes' rows before any judgment: the board's lanes less `poster`, least-recently-woken first. */
export function queueLaneRows(db: Database, board: string, poster: string[]): string[] {
  return (db.prepare(queueLaneRowsSql()).all(board, JSON.stringify(poster)) as { handle: string }[]).map((r) => r.handle);
}

/**
 * queueLaneRows' query (?1 board, ?2 JSON array of poster handles), exported for its plan test. A lane's takes are two
 * subqueries, never one OR (#1351): `es`, its session's session-keyed takes by idx_claim_events_take_sid (board,
 * session_id), and `e`, the address-keyed takes under its addresses now by idx_claim_events_take (board, handle). The
 * outbox half (`o2`) is address-mapped only: an outbox row records no session (#1370). It runs inside every
 * queue post's and requeue's write transaction, so its plan must stay indexed as history grows (#1174 audit H1); two
 * planner pins keep it there, with or without ANALYZE stats:
 * - `+e.key`, `+es.key`: the unary plus keeps idx_claim_events_key out. With stats the planner otherwise ranges that
 *   index on the GLOB prefix and reads every queue take on every board per lane, instead of the take indexes.
 * - `outbox o2 CROSS JOIN posts p2`: pins outbox as the outer loop, searched by handle. Without stats the planner
 *   otherwise drives from every post on the board and probes outbox per post.
 */
export function queueLaneRowsSql(): string {
  return `WITH lanes AS (
           SELECT COALESCE(${primaryHoldSql("s.handle")}, s.handle) AS lane FROM subscriptions s
           WHERE s.board = ?1 AND s.mode = 'push')
         SELECT l.lane AS handle FROM lanes l LEFT JOIN aliases h ON h.address = l.lane
         LEFT JOIN ids i ON i.id = l.lane
         WHERE l.lane NOT IN (SELECT value FROM json_each(?2))
           AND (h.address IS NOT NULL AND h.queue_off IS NULL OR i.id IS NOT NULL AND i.ended_at IS NULL)
           AND h.human IS NOT 1
         GROUP BY l.lane
         ORDER BY NULLIF(MAX(
             COALESCE((SELECT MAX(es.at) FROM claim_events es
                       WHERE es.board = ?1 AND es.session_id = ${laneSessionSql("l.lane")} AND es.event = 'take' AND +es.key GLOB 'queue:*'
                         AND ${liveSessionSql("es.session_id")}), 0),
             COALESCE((SELECT MAX(e.at) FROM claim_events e
                       WHERE e.board = ?1 AND e.handle IN ${laneAddressesSql("l.lane")} AND e.event = 'take' AND +e.key GLOB 'queue:*'
                         AND NOT ${liveSessionSql("e.session_id")}), 0),
             COALESCE((SELECT MAX(p2.created_at) FROM outbox o2 CROSS JOIN posts p2 ON p2.id = o2.post_id
                       WHERE o2.handle IN ${laneAddressesSql("l.lane")} AND p2.board = ?1), 0)), 0) ASC NULLS FIRST, l.lane ASC`;
}

// The claim IS the delivery: the picked lane holds the post until it acks (a
// reply), declines (claim_release), or the TTL lapses (sweepExpired
// redelivers it to the next lane). At-least-once: the claim key is the
// idempotency token. The claim does not announce on the board - the delivery
// IS the visibility, and an announce would cascade back through the queue
// rotation. The claim records the lane's session's user (#855), so a reply the
// bus writes when it ends unclaimed is that user's. Caller is inside post's transaction.
// `push: false`: the caller queues the lane's push itself (a mention's, #219).
// Returns whether this run took the claim (false: a row already held the key).
export function claimQueuePost(
  db: Database, board: string, postId: number, lane: string, now: number, { note = "queue post", push = true }: { note?: string; push?: boolean } = {},
): boolean {
  const key = `queue:${board}:${postId}`;
  const expires = now + QUEUE_CLAIM_TTL_MS;
  // Redelivery to a lane that already had this post resets its push, so the
  // re-offer actually reaches it (at-least-once).
  if (push) db.prepare(
    `INSERT INTO outbox (handle, post_id, reason, wake) VALUES (?, ?, 'subscription', 1)
     ON CONFLICT(handle, post_id) DO UPDATE SET delivered_at = NULL, wake = 1`,
  ).run(lane, postId);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT principal FROM ids WHERE id = ?2),
         (SELECT i.principal FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ?2)))`,
    )
    .run(key, lane, note, board, now, expires);
  // The claim is the idempotency token: when a row already holds the key,
  // this run isn't the lane's delivery and must not read as one in the
  // audit - the lane's reply-ack checks the claim's holder, not the outbox
  // (#192 review).
  if (res.changes === 0) return false;
  logEvent(db, "take", lane, { key, note, board, expires_at: expires }, now);
  return true;
}

// The note on a redelivery's take event: release() reads it to tell a
// decline's own redelivery from a later claim (#254).
export const REDELIVERED_NOTE = "queue post (redelivered)";

/** A post's author's address set as of now, from its author and author_id: the author, and its writing session's ID
 * and the aliases that session holds (#284 S5); for a child's post (#523), its root's ID and holds, the addresses the
 * child acted under. */
export function authorAddresses(db: Database, author: string, authorId: string | null): string[] {
  return (db.prepare(
    `SELECT ?1 AS a
     UNION SELECT ?2 WHERE ?2 IS NOT NULL
     UNION SELECT h.address FROM alias_holds h WHERE h.id = ?2
     UNION SELECT i.root_id FROM ids i WHERE i.id = ?2 AND i.root_id IS NOT NULL
     UNION SELECT h.address FROM ids i JOIN alias_holds h ON h.id = i.root_id WHERE i.id = ?2`,
  ).all(author, authorId) as { a: string }[]).map((r) => r.a);
}

// A queue post's claim ended (TTL lapse in sweepIn, or a decline in release):
// offer the original post to the next eligible lane that hasn't held it. Each
// lane gets one turn (#220): one that held it (declined it, or let its TTL
// lapse) isn't offered it again, so two lanes can't pass it back and forth
// forever. A lane is its session (#219, #1174, #1351): a take it made, as its ID or
// any alias, was its turn, whatever its primary is now (redeliveryFacts). Presence-blind: the sweep has no online predicate, so an offline
// lane holds the re-offer in its outbox until it wakes, and its own TTL lapse
// re-rotates. Caller is inside a transaction. Returns the lane woken; with no
// lane left, the post, how many lanes held it and its writer, for the caller to
// say so in its thread; null for a key that isn't a live queue post.
export type Requeue = { lane: string } | { board: string; postId: number; held: number; author: PostWriter } | null;
export function redeliverQueuePost(db: Database, key: string, prevHolder: string, now = Date.now()): Requeue {
  const f = redeliveryFacts(db, key, prevHolder);
  if (!f) return null;
  const lane = requeuePick(queueLanes(db, f.board, f.poster), f.held);
  if (!lane) return { board: f.board.name, postId: f.postId, held: f.takers, author: f.author };
  claimQueuePost(db, f.board.name, f.postId, lane, now, { note: REDELIVERED_NOTE });
  return { lane };
}

/** A post's writer as its row records it: its author, writing session and user. */
export type PostWriter = { handle: string; id: string | null; user: string | null };

export type RedeliveryFacts = { board: Board; postId: number; poster: string[]; author: PostWriter; takers: number; held: Set<string> };

/** What a queue post's redelivery reads (#807 B5b3a): its board and post, the post's author addresses (no lane they
 * name gets it back) and its writer (who the `[unclaimed]` reply falls back to, #1175), how many sessions took it (the
 * `[unclaimed]` reply's count), and `held`: every address of each session that took it (#1174, #1351; a session-keyed
 * take adds its taking session's addresses now, and its raw handle only while no other session holds it; an address-keyed one adds its handle and the
 * addresses of whoever holds it now). Null when `key` names no queue post. */
export function redeliveryFacts(db: Database, key: string, prevHolder: string): RedeliveryFacts | null {
  const m = /^queue:([^:]+):(\d+)$/.exec(key);
  if (!m) return null;
  const b = getBoard(db, m[1]!);
  const p = getPost(db, Number(m[2]));
  if (!b || !p || p.board !== b.name) return null;
  // Each take, session-keyed or address-keyed (#1351, liveSessionSql): a session-keyed take was its taking session's
  // turn, which held gets as that session's addresses now (its ID and the aliases it holds), and as its raw handle
  // only while no other session holds it: an alias another session holds now leaves that session its turn, but an
  // unheld one is still a lane (a subscription under it) that the taking session would get the post back through. A
  // live session reopened after its name's successor bound (a server's reopenId) takes its rows back from the
  // successor, so the successor can get one more turn; accepted, as a reopen after a rebind is rare. An address-keyed take (from before
  // #1351, under an alias no session held, or by a session that has ended) maps through who holds its handle now
  // (#219, #1174), so a restarted session that rebound the name has had its predecessor's turn.
  const takes = db.prepare(
    `SELECT DISTINCT handle, CASE WHEN ${liveSessionSql("session_id")} THEN session_id END AS sid
     FROM claim_events WHERE key = ? AND event = 'take'`,
  ).all(key) as { handle: string; sid: string | null }[];
  const held = new Set<string>();
  const addressKeyed = new Set<string>();
  const sessions = new Set<string>();
  const addressesOf = db.prepare(`SELECT address FROM ${laneAddressesSql("?1")}`);
  const sessionOf = db.prepare(`SELECT ${laneSessionSql("?1")} AS sid`);
  for (const t of takes) {
    if (t.sid === null) {
      addressKeyed.add(t.handle);
      continue;
    }
    sessions.add(t.sid);
    const holder = (sessionOf.get(t.handle) as { sid: string }).sid;
    if (holder === t.handle || holder === t.sid) held.add(t.handle);
    for (const r of addressesOf.all(t.sid) as { address: string }[]) held.add(r.address);
  }
  // The claim's last holder, as today's address rule maps it, unless a take row already speaks for its handle: then
  // that row's kind decides, so an alias that moved on since a session-keyed take doesn't take its new holder's turn.
  if (!takes.some((t) => t.handle === prevHolder)) addressKeyed.add(prevHolder);
  // A lane is its session as of now: a take as its ID or any alias it holds was its turn, whichever of them
  // queueLanes names it by (its primary, its ID, or the alias it subscribed as). The `[unclaimed]` reply counts
  // sessions, where known: a handle no session holds counts as itself.
  for (const h of addressKeyed) {
    held.add(h);
    sessions.add((sessionOf.get(h) as { sid: string }).sid);
    for (const r of addressesOf.all(h) as { address: string }[]) held.add(r.address);
  }
  const w = db.prepare(`SELECT author, author_id, author_user FROM posts WHERE id = ?`).get(p.id) as
    { author: string; author_id: string | null; author_user: string | null };
  const author = { handle: w.author, id: w.author_id, user: w.author_user };
  return { board: b, postId: p.id, poster: authorAddresses(db, w.author, w.author_id), author, takers: sessions.size, held };
}

/** The lane a declined or lapsed queue post goes to next: the first of `lanes` (queueLanes' order) that hasn't held it. */
export function requeuePick(lanes: string[], held: Set<string>): string | undefined {
  return lanes.find((h) => !held.has(h));
}

// What decides whether `handle` may post (or reply) on a board now: it can see
// it, the parent is a post on it, only a human starts an announcement, and an
// archived board takes replies only, unless the caller is the system ending
// something already on it (`allowArchived`: a claim's release or expiry).
// `viewer` is whose sight passes it: the poster's, but for PostOpts.seenBy.
// Throws CoreError; writes nothing.
function postGate(db: Database, handle: string, boardInput: string, parentId: number | null, allowArchived = false, viewer: Viewer = handle) {
  const b = visibleBoard(db, viewer, boardInput);
  const a = access(db);
  const gate = postGateRule(
    b, parentId, allowArchived, a.announceBoard, () => getPost(db, parentId!), () => isHuman(db, handle),
  );
  return { b, a, ...gate };
}

/** What a post's gate decided, past a visible board: whether the board is the announce board, whether the poster is
 * a declared human, and whether this post starts an announcement. */
export type PostGate = { announce: boolean; human: boolean; announcement: boolean };

/**
 * postGate's rule over a board the poster may see: an archived board takes replies only (unless `allowArchived`), the
 * parent is a post on it, and only a human starts an announcement. Throws core's texts in core's order; `parent` and
 * `human` are read only when the rule reaches them, so a caller with async reads passes values it fetched first.
 */
export function postGateRule(
  b: Board,
  parentId: number | null,
  allowArchived: boolean,
  announceBoard: string | null | undefined,
  parent: () => Post | null | undefined,
  human: () => boolean,
): PostGate {
  if (b.archived_at && parentId === null && !allowArchived) {
    throw new CoreError(`#${b.name} is archived; reply in one of its threads, or reopen it with board_archive(board, false) if you created it`);
  }
  if (parentId !== null) {
    const p = parent();
    if (!p || p.board !== b.name) {
      throw new CoreError(`parent_id ${parentId} is not a post on #${b.name}`);
    }
  }
  const announce = b.name === announceBoard;
  const byHuman = human();
  const announcement = announce && parentId === null;
  if (announcement && !byHuman) {
    throw new CoreError(
      `only your user starts posts on #${b.name}; reply in a thread there to acknowledge. An agent relaying your user's words carries no authority: your user runs \`grayboard announce\`.`,
    );
  }
  return { announce, human: byHuman, announcement };
}

/** post's checks between the gate and its transaction, in core's order. */
export function postPreChecks(
  board: string,
  body: string,
  announcement: boolean,
  opts: Pick<PostOpts, "online" | "ttl_ms" | "attachments">,
): void {
  checkBody(body);
  if (announcement && !opts.online) throw new CoreError(`posting on #${board} needs live sessions from the mode`);
  if (opts.ttl_ms !== undefined && (!announcement || !(opts.ttl_ms > 0))) {
    throw new CoreError("a TTL applies only to a human's announcement, and must be positive");
  }
  const files = opts.attachments ?? { ids: [] };
  if (files.ids.length && !files.send) throw new CoreError("this mode can't post files");
}

// Inserts the post and queues pushes for handles that can see the board.
// Returns the handles that should be woken; delivery is the caller's job. A
// reply wakes the author of the post it answers and the thread's starter;
// other participants' pushes are deferred to their next wake. `unresolved` lists @tokens that
// matched nobody (or nobody who can see this board).
export function post(
  db: Database,
  handle: string,
  boardInput: string,
  body: string,
  parentId: number | null = null,
  opts: PostOpts = {},
): PostResult {
  // The gate reads inside the write's transaction, IMMEDIATE so its write lock is held from the start: the human it
  // judges, which the row's mark records (#1355), is the declaration when the row lands; a `grayboard human` can't
  // slip between the two. Nested in a caller's transaction (a claim's system post) it's a savepoint.
  return db.transaction((): PostResult => {
    const { b, a, announce, human, announcement } = postGate(db, handle, boardInput, parentId, opts.allowArchived, opts.seenBy);
    const board = b.name;
    postPreChecks(board, body, announcement, opts);
    const files = opts.attachments ?? { ids: [] };
    const isViewer = viewers(db);
    const now = Date.now();
    const p = insertPost(db, {
      board, author: handle, body, parentId, now, expiresAt: opts.ttl_ms ? now + opts.ttl_ms : null,
      authorId: opts.author_id ?? null, via: opts.via ?? null, authorUser: opts.author_user ?? null,
      human: postMark({ human }, opts.strictIds === true),
    });
    const { send } = files;
    const attachments = send ? bindAttachments(db, files.ids, { addresses: opts.addresses ?? [handle], principal: send.principal }, { post_id: p.id }, send.limits) : [];
    // Nobody is told of, or handed, their own post: the poster's address set,
    // and the writing session's own (its ID and holds; a child's root's, #523),
    // which a caller passing no address set (a claim announcement) leaves out.
    const own = [...new Set([...(opts.addresses ?? [handle]), ...authorAddresses(db, handle, opts.author_id ?? null)])];
    const strict = opts.strictIds === true;
    const viewer = opts.author_id ?? handle;
    const branch = postBranch(b, parentId, announcement);
    const sees = (h: string) => a.canSee(h, b);
    const mayLane = laneHook(a, b);
    const facts: PostTargetFacts = {
      board: b, handle, parentId, strict, gate: { announce, human, announcement }, own,
      ackAddresses: opts.addresses ?? [handle], isViewer, isHuman: (h) => isHuman(db, h), sees, mayLane,
      mentions: { handles: [], unresolved: [] },
    };
    if (branch === "queue") {
      facts.mentions = resolveMentions(db, body, handle, b, strict, viewer);
      facts.seenMentioned = seenHandles(db, viewer, facts.mentions.handles);
      facts.lanesOnly = strict && !own.some(mayLane);
      if (needsRotation(facts.seenMentioned, mayLane, facts.lanesOnly)) {
        facts.lanes = orderLanes(queueLaneRows(db, board, own), isViewer, sees, mayLane, opts.online);
      }
    } else {
      facts.subs = subscriberRows(db, board);
      if (branch === "announcement") {
        facts.live = liveAddresses(db);
        facts.online = opts.online;
      } else if (branch === "thread") {
        facts.thread = threadFacts(db, parentId!);
        facts.reaches = (h) => !a.mayReach || a.mayReach(handle, h);
      }
      facts.mentions = resolveMentions(db, body, handle, b, strict, viewer);
    }
    const plan = planPostTargets(facts);
    if (plan.claim) claimQueuePost(db, board, p.id, plan.claim.lane, now, { note: plan.claim.note, push: plan.claim.push });
    if (plan.ack) ackQueueClaim(db, plan.ack.addresses, plan.ack.key, now);
    insertOutbox(db, p.id, plan.targets);
    return {
      post: attachments.length ? { ...p, attachments } : p,
      ...postWakes(plan.targets),
      unresolved: plan.unresolved,
    };
  }).immediate();
}

/** Who a post reaches and why. Highest-priority reason wins per handle: mention > thread > subscription. */
export type PostTarget = { reason: "mention" | "thread" | "subscription"; wake: boolean };

/** Which of post's four target rules a post follows. */
export type PostBranch = "queue" | "announcement" | "thread" | "broadcast";

/**
 * A queue-kind board delivers each top-level post to exactly ONE subscriber: the claim IS the delivery. An archived
 * queue board takes no new work (#635): a claim's [release] or [expired] post landing there is a broadcast, never a
 * delivery. Replies follow thread semantics.
 */
export function postBranch(b: Board, parentId: number | null, announcement: boolean): PostBranch {
  if (announcement) return "announcement";
  if (parentId !== null) return "thread";
  return !b.archived_at && (b.kind ?? "broadcast") === "queue" ? "queue" : "broadcast";
}

/**
 * Whether a queue post goes to the rotation: no mention the author may see exists names anyone (#219, #871). With
 * `lanesOnly` (an author's own words, from a poster that may not be the board's lane), only a name that may be a lane
 * holds the post back: on a service's board an invoker named there is told, but the post still rotates to a lane
 * (#1256). A lane's own post and a system post's `cc @watcher` keep the plain rule: a lane answering an invoker, or a
 * claim's notice, isn't new work. Elsewhere every name may be a lane, so the two rules agree.
 */
export const needsRotation = (seenMentioned: string[], mayLane: (h: string) => boolean, lanesOnly: boolean): boolean =>
  lanesOnly ? !seenMentioned.some(mayLane) : seenMentioned.length === 0;

/**
 * Everything post's targeting reads, read and judged already. Predicates may be lazy (core) or set lookups (a caller
 * that read them first). The branch's own fields are required where `postBranch` says it runs: the queue branch needs
 * `seenMentioned` and, when `needsRotation`, `lanes`; every other branch needs `subs`; an announcement `live` and
 * `online`; a reply `thread` and `reaches`.
 */
export type PostTargetFacts = {
  board: Board;
  handle: string;
  parentId: number | null;
  strict: boolean;
  gate: PostGate;
  // The poster's address set and its writing session's (authorAddresses): never a target.
  own: string[];
  // Whose queue claim a reply acks: the caller's address set, not `own`.
  ackAddresses: string[];
  isViewer: (h: string) => boolean;
  isHuman: (h: string) => boolean;
  // May see the board (access canSee).
  sees: (h: string) => boolean;
  // May be a lane on the board (access mayLane, #270 D5): a queue claim, rotated or by name, goes only to one.
  mayLane: (h: string) => boolean;
  // resolveMentions' answer, token order: handles that may see the board, and tokens that matched nobody.
  mentions: { handles: string[]; unresolved: string[] };
  subs?: { handle: string; mode: SubMode }[];
  live?: string[];
  online?: (h: string) => boolean;
  thread?: ThreadFacts;
  // The poster may reach (access mayReach; always true where the mode has no such rule).
  reaches?: (h: string) => boolean;
  seenMentioned?: string[];
  // needsRotation's `lanesOnly`: strict, and no address in `own` may be a lane. Read only when `seenMentioned` is
  // non-empty and names no possible lane (otherwise both rules agree), so a caller may leave it false there.
  lanesOnly?: boolean;
  lanes?: string[];
};

/** What post writes once its row exists: outbox rows in this order, a queue claim, a queue ack. */
export type PostPlan = {
  targets: [string, PostTarget][];
  claim: { lane: string; note: "queue post" | "queue post (mentioned)"; push: boolean } | null;
  ack: { key: string; addresses: string[] } | null;
  unresolved: string[];
};

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`planPostTargets: ${what} missing`);
  return v;
}

/**
 * post's targeting rules, over facts read first. Map order is load-bearing: it is the outbox's insert order and
 * wake/deferred's, and `Map.set` on a present key keeps its slot (a mentioned subscriber stays where it was).
 */
export function planPostTargets(f: PostTargetFacts): PostPlan {
  const { board: b, gate } = f;
  const branch = postBranch(b, f.parentId, gate.announcement);
  const targets = new Map<string, PostTarget>();
  let claim: PostPlan["claim"] = null;
  if (branch === "queue") {
    // A resolved @mention is direct addressing (it bypasses the rotation, but on a service's board only a possible
    // lane's name does in an invoker's words: needsRotation); with none, the rotation picks the least-recently-woken
    // eligible subscriber and claims the post (TTL takeover releases it to the next wake).
    for (const m of f.mentions.handles) targets.set(m, { reason: "mention", wake: true });
    // A mention the poster may not see exists routes as one that matched nobody (#871): a lane still gets
    // the post, so whether a team's name exists shows neither in who was notified nor in a queue claim.
    const seen = need(f.seenMentioned, "seenMentioned");
    // One agent addressed by name holds the post like a rotated lane (#219): its reply acks, its decline or
    // lapse redelivers through the rotation. Only an author's own words (strictIds): a system post's `cc @watcher`
    // isn't work. Exactly one visible name, and it no human, viewer or poster's own address: one claim names
    // one agent, and only agents hold queue work. Subscription and opt-out govern the rotation, not a name. On a
    // service's board the name must also be one of the service's lanes (#270 D5): an invoker named there is told,
    // not handed the service's work, and an invoker's own post still rotates to a lane (needsRotation, #1256).
    const agents = seen.filter((h) => !f.own.includes(h) && !f.isHuman(h) && !f.isViewer(h) && f.mayLane(h));
    if (f.strict && seen.length === 1 && agents.length === 1) {
      claim = { lane: agents[0]!, note: "queue post (mentioned)", push: false };
    }
    if (needsRotation(seen, f.mayLane, f.lanesOnly ?? false)) {
      // Eligible lanes, least-recently-woken first, live lanes preferred: a
      // post claimed by an offline lane would sit for the full TTL while
      // live lanes idle (#192 review).
      const picked = need(f.lanes, "lanes")[0];
      if (picked) {
        targets.set(picked, { reason: "subscription", wake: true });
        claim = { lane: picked, note: "queue post", push: true };
      }
      // No eligible subscriber: the post sits on the board (readable there)
      // until a lane subscribes; documented v1 behavior.
    }
  } else {
    // The announce board ignores agents' subscriptions (viewers like `tail`
    // still get it): an announcement reaches the sessions live now, as a
    // mention so it doesn't read as subscribed traffic, and an agent's ack
    // reaches only the announcer, not every earlier acker. A queue board's
    // subscribers are LANES, not audience: replies follow thread semantics
    // only, so one lane's work chatter doesn't wake the whole fleet.
    const queueBoard = (b.kind ?? "broadcast") === "queue";
    for (const s of need(f.subs, "subs")) {
      if (!f.sees(s.handle) || (gate.announce && !f.isViewer(s.handle))) continue;
      if (s.mode === "push" && !queueBoard) targets.set(s.handle, { reason: "subscription", wake: true });
    }
    if (branch === "announcement") {
      const online = need(f.online, "online");
      for (const h of need(f.live, "live")) {
        if (!f.isViewer(h) && online(h) && f.sees(h)) targets.set(h, { reason: "mention", wake: true });
      }
    } else if (branch === "thread") {
      const t = need(f.thread, "thread");
      const reaches = need(f.reaches, "reaches");
      const authors = gate.announce && !gate.human ? [t.rootAuthor] : t.authors;
      const direct = new Set([t.parentAuthor, t.rootAuthor]);
      for (const author of authors) {
        if (!f.sees(author) || !reaches(author)) continue;
        // Your user's replies wake the whole thread; a push-mode subscriber
        // still gets every post as it lands.
        const wake = gate.human || direct.has(author) || f.isHuman(author) || targets.get(author)?.wake === true;
        targets.set(author, { reason: "thread", wake });
      }
      // Muting drops thread and subscription pushes; the mention pass below
      // runs after this, so an @mention still lands.
      for (const m of t.muted) targets.delete(m);
    }
    for (const m of f.mentions.handles) targets.set(m, { reason: "mention", wake: true });
  }
  // A queue-board reply by the claim holder acks the work: the claim
  // releases with an ack note, so the handled post's audit chain ends in a
  // release instead of an expire (#192 review). Another lane's reply leaves
  // the holder on the hook. No redelivery: handled is handled.
  const ack = f.parentId !== null && (b.kind ?? "broadcast") === "queue"
    ? { key: `queue:${b.name}:${need(f.thread, "thread").root}`, addresses: f.ackAddresses }
    : null;
  for (const a of f.own) targets.delete(a);
  return { targets: [...targets], claim, ack, unresolved: f.mentions.unresolved };
}

/** A plan's targets as post's result names them. Digest subscribers aren't woken: their notice rides with their next wake. */
export function postWakes(targets: [string, PostTarget][]): { wake: string[]; deferred: string[] } {
  return {
    wake: targets.filter(([, t]) => t.wake).map(([h]) => h),
    deferred: targets.filter(([, t]) => !t.wake).map(([h]) => h),
  };
}

/** A post's row before it's written. `human`: the post bears the human mark (postMark), judged at write time. */
export type NewPost = {
  board: string; author: string; body: string; parentId: number | null; now: number; expiresAt: number | null;
  authorId: string | null; via: string | null; authorUser: string | null; human: boolean;
};

/** Writes a post's row. */
export function insertPost(db: Database, p: NewPost): Post {
  return showPost(db
    .prepare(
      `INSERT INTO posts (board, author, body, parent_id, created_at, expires_at, author_id, via, author_user, human)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POST_COLS}`,
    )
    .get(p.board, p.author, p.body, p.parentId, p.now, p.expiresAt, p.authorId, p.via, p.authorUser, p.human ? 1 : 0) as PostRow);
}

/**
 * Whether a post being written bears the human mark (#1355): only a declared human's own words (`ownWords`, the
 * strict write a tool or `grayboard announce` makes), its gate having judged the author human at write time. A system
 * post (a claim's `[release]`/`[expired]`/`[unclaimed]`) never does, whoever it's written as (principle 10,
 * docs/slack-bridge.md §3).
 */
export const postMark = (gate: Pick<PostGate, "human">, ownWords: boolean): boolean => ownWords && gate.human;

/**
 * Whether a delivered post bears the human mark: as its row recorded it when written (#1355), so a handle declared
 * human later never marks what it wrote before. A row from before the column (null), or one already pruned, bears
 * none: losing a pre-upgrade human post's mark is harmless, forging one onto a system post isn't.
 */
export function postHuman(db: Database, post: Pick<Post, "id">): boolean {
  const row = db.prepare(`SELECT human FROM posts WHERE id = ?`).get(post.id) as { human: number | null } | undefined;
  return row?.human === 1;
}

/** A board's subscriptions, unjudged, by handle. */
export function subscriberRows(db: Database, board: string): { handle: string; mode: SubMode }[] {
  return db.prepare(`SELECT handle, mode FROM subscriptions WHERE board = ? ORDER BY handle`).all(board) as {
    handle: string;
    mode: SubMode;
  }[];
}

/** What a reply's targeting reads of its thread: the root, its authors (the reply's own among them once written),
 * the parent's and root's authors, and who muted it. */
export type ThreadFacts = { root: number; authors: string[]; parentAuthor: string; rootAuthor: string; muted: string[] };

/** threadFacts of a reply to `parentId`, a post that exists. */
export function threadFacts(db: Database, parentId: number): ThreadFacts {
  const root = threadRoot(db, parentId);
  return {
    root,
    authors: threadAuthors(db, root),
    parentAuthor: getPost(db, parentId)!.author,
    rootAuthor: getPost(db, root)!.author,
    muted: (db.prepare(`SELECT handle FROM thread_mutes WHERE root_id = ?`).all(root) as { handle: string }[]).map((m) => m.handle),
  };
}

/** A plan's outbox rows, in its order; a row already there stays as it is. */
export function insertOutbox(db: Database, postId: number, targets: [string, PostTarget][]): void {
  const ins = db.prepare(
    `INSERT INTO outbox (handle, post_id, reason, wake) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  for (const [h, t] of targets) ins.run(h, postId, t.reason, t.wake ? 1 : 0);
}

function threadAuthors(db: Database, postId: number): string[] {
  const rootId = threadRoot(db, postId);
  return (
    db
      .prepare(
        `WITH RECURSIVE t AS (
           SELECT id, author FROM posts WHERE id = ?
           UNION ALL
           SELECT p.id, p.author FROM posts p JOIN t ON p.parent_id = t.id
         ) SELECT author FROM t GROUP BY author ORDER BY MIN(id)`,
      )
      .all(rootId) as { author: string }[]
  ).map((r) => r.author);
}

/** The root of the thread `postId` is in (`postId` itself when it's missing or a root). */
export function threadRoot(db: Database, postId: number): number {
  let id = postId;
  while (true) {
    const row = db.prepare(`SELECT parent_id FROM posts WHERE id = ?`).get(id) as
      | { parent_id: number | null }
      | undefined;
    if (!row || row.parent_id === null) return id;
    id = row.parent_id;
  }
}

// ── who ──────────────────────────────────────────────────────────────────────

// An alias's owner-set labels (#284 S12): one line each, set by its binder.
export const ALIAS_META_KEYS = ["task", "owner", "source_board", "spec_hash", "description"] as const;
export type AliasMeta = { [K in (typeof ALIAS_META_KEYS)[number]]?: string };
// bind's `meta` once checked: a key present with null clears that label.
export type AliasMetaSet = { [K in (typeof ALIAS_META_KEYS)[number]]?: string | null };

const MAX_LABEL = 200;

/**
 * bind's `meta` argument, checked (#284 S12): an object of known keys, each a
 * one-line string of at most 200 characters ("" clears it); `source_board`
 * must be a board name (it may name a board since deleted).
 */
export function parseAliasMeta(v: unknown): AliasMetaSet {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new CoreError("meta must be an object of labels");
  const out: AliasMetaSet = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!(ALIAS_META_KEYS as readonly string[]).includes(k)) throw new CoreError(`unknown meta key ${JSON.stringify(oneLine(k).slice(0, 40))}; known: ${ALIAS_META_KEYS.join(", ")}`);
    if (typeof raw !== "string") throw new CoreError(`meta.${k} must be a string`);
    const t = oneLine(raw);
    if (t.length > MAX_LABEL) throw new CoreError(`meta.${k} must be at most ${MAX_LABEL} chars`);
    out[k as keyof AliasMetaSet] = t === "" ? null : k === "source_board" ? normalizeBoard(t) : t;
  }
  return out;
}

/** What an alias label write changed: each changed key's value before and after (null: unset). */
export type AliasMetaDiff = { before: AliasMetaSet; after: AliasMetaSet };

/**
 * Write an alias's labels from a parsed `meta`: only the fields whose value
 * changes are written. Returns what changed, or null when nothing did (no
 * write). Throws when the alias has no row. The server audits the diff itself
 * (#807 P3 C10a); local mode through setAliasMeta.
 */
export function writeAliasMeta(db: Database, address: string, meta: AliasMetaSet): AliasMetaDiff | null {
  const keys = Object.keys(meta) as (keyof AliasMetaSet)[];
  if (!keys.length) return null;
  const cur = db.prepare(`SELECT ${ALIAS_META_KEYS.join(", ")} FROM aliases WHERE address = ?`).get(address) as Record<string, string | null> | null;
  if (!cur) throw new Error(`grayboard: no alias "${address}" to label`);
  const before: AliasMetaSet = {}, after: AliasMetaSet = {};
  for (const k of keys) if ((meta[k] ?? null) !== cur[k]) { before[k] = cur[k] ?? null; after[k] = meta[k] ?? null; }
  const changed = Object.keys(after) as (keyof AliasMetaSet)[];
  if (!changed.length) return null;
  db.prepare(`UPDATE aliases SET ${changed.map((k) => `${k} = ?`).join(", ")} WHERE address = ?`).run(...changed.map((k) => after[k] ?? null), address);
  return { before, after };
}

/**
 * Set an alias's labels from a parsed `meta`, as `session` binding it
 * (writeAliasMeta), auditing what changed as one alias.meta_set. Call inside
 * the bind's write transaction. `actor` is who the row names: the session
 * locally, where no user is.
 */
export function setAliasMeta(db: Database, address: string, meta: AliasMetaSet, session: string, audit: AuditSink, actor: string = session): void {
  const diff = writeAliasMeta(db, address, meta);
  if (diff) audit("alias.meta_set", actor, address, { address, fields: diff.after, session });
}

// A session's self-reported facts (#284 S12), shown on its rows.
type SessionFacts = { harness?: string; model?: string; effort?: string };

export type Peer = {
  handle: string;
  online: boolean;
  last_seen: number;
  self?: true;
  // The session the row's facts come from (#284 S13; ALIAS_SESSION_SQL).
  id?: string;
  mode?: SubMode;
  where?: string;
  status?: string;
  status_age?: string;
  human?: true;
  queue_off?: true;
  launcher?: true;
} & SessionFacts &
  AliasMeta;
/**
 * Which handles are read-only viewers, kept out of the roster, rotations and
 * notified lists: a `grayboard tail` session (ids.viewer, #284 S9). Read
 * once per call.
 */
// Of `handles`, those whose existence `viewer` (a session ID or handle) may
// see: a team's aliases only inside the team (#348), as peer_list lists them.
// For results that echo a board's recipients (board_post's notified/deferred).
export function seenHandles(db: Database, viewer: string, handles: string[]): string[] {
  const acc = access(db);
  if (!acc.seesAlias) return handles;
  const rows = aliasScopeRows(db, handles);
  return handles.filter((h) => {
    const scope = seenScopeOf(rows.get(h), h);
    return scope === null || acc.seesAlias!(viewer, scope);
  });
}

/** The aliases rows' scope columns of `addresses`; an address with no row is absent. */
export function aliasScopeRows(db: Database, addresses: string[]): Map<string, AliasScopeRow> {
  const rows = db
    .prepare(`SELECT address, scope_kind, scope_ref FROM aliases WHERE address IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...new Set(addresses)])) as (AliasScopeRow & { address: string })[];
  return new Map(rows.map(({ address, ...scope }) => [address, scope]));
}

/** An aliases row's scope columns. */
export type AliasScopeRow = { scope_kind: AliasScope["scope_kind"] | null; scope_ref: string | null };

/**
 * The scope whose sight decides whether a viewer may see that `handle` exists (#348), from its aliases row (null when
 * it has none); null when anyone may.
 */
export function seenScopeOf(row: AliasScopeRow | null | undefined, handle: string): AliasScopeOf | null {
  if (row) return row.scope_kind === null ? null : { scope_kind: row.scope_kind, scope_ref: row.scope_ref };
  // A deleted team name (#347) keeps its claims; it stays inside the team that had it (#871).
  const p = addressParts(handle);
  return p?.kind === "alias" && p.scopeKind === "principal" ? { scope_kind: "team", scope_ref: p.scope } : null;
}

export function viewers(db: Database): (handle: string) => boolean {
  const ids = new Set((db.prepare(`SELECT id FROM ids WHERE viewer = 1`).all() as { id: string }[]).map((r) => r.id));
  return (h) => ids.has(h);
}

// A live session with no name yet (#182), addressed by its session ID
// (#284), with the status it set as that ID.
export type UnboundPeer = { session_id: string; unbound: true; online: true; where?: string; status?: string; status_age?: string; self?: true; launcher?: true } & SessionFacts;

// `you` is left out only for a viewer, which nothing can address.
export type WhoResult = { you?: string; peers: Peer[]; unbound_sessions?: UnboundPeer[]; offline_hidden?: number };

// peer_list's match filter (#284 S13): exact, case-insensitive, ANDed. scope
// is an alias's scope_ref, or an ID's principal where the caller may see it.
export const MATCH_KEYS = ["id", "harness", "model", "effort", "task", "owner", "source_board", "spec_hash", "scope"] as const;
export type PeerMatch = { [K in (typeof MATCH_KEYS)[number]]?: string };

/** peer_list's `match` argument, checked; undefined when absent. */
export function parseMatch(v: unknown): PeerMatch | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new CoreError("match must be an object");
  const out: PeerMatch = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(MATCH_KEYS as readonly string[]).includes(k)) throw new CoreError(`match has no key "${k}"; it takes ${MATCH_KEYS.join(", ")}`);
    if (typeof val !== "string" || val === "") throw new CoreError(`match.${k} must be a non-empty string`);
    out[k as keyof PeerMatch] = val;
  }
  return out;
}

function matches(m: PeerMatch, fields: PeerMatch): boolean {
  return Object.entries(m).every(([k, v]) => fields[k as keyof PeerMatch]?.toLowerCase() === v.toLowerCase());
}

/** The order of a session's holds, oldest first (#284 S1, #370): every list of holds and every primary pick uses it. */
export const HOLD_ORDER = "ORDER BY bound_at, address";

/** SQL for session `id`'s primary hold (#284 S1): its oldest, or NULL. `id` is an SQL expression. */
export function primaryHoldSql(id: string): string {
  return `(SELECT address FROM alias_holds WHERE id = ${id} ${HOLD_ORDER} LIMIT 1)`;
}

// The session an alias's facts come from (#284 S13): its holder, or once
// it's offline, the session that last bound it, once that session has
// ended. A live session's facts show only on the aliases it holds: one that
// released this alias shows them on its others. `a` is the aliases row in
// the query that uses it.
export const ALIAS_SESSION_SQL = `COALESCE(
    (SELECT id FROM alias_holds WHERE address = a.address),
    (SELECT l.session_id FROM (SELECT session_id FROM binding_events WHERE name = a.address AND event IN ('bound', 'moved') ORDER BY id DESC LIMIT 1) l
      JOIN ids e ON e.id = l.session_id WHERE e.ended_at IS NOT NULL))`;

// The roster: every alias a session has used (aliases with a last_seen),
// or a board's subscribers, each with its session's facts (ALIAS_SESSION_SQL).
// A status is shown only while a session holds the alias: it's the
// session's, and clears when the session ends (#284 decision 11). An alias's
// labels, and its session's facts, are shown only to a caller that may act
// in its scope (#284 S13, F-12), and `match` filters after that cut, so a
// hidden label or fact can't be probed. A team's aliases aren't listed at all
// outside the team (#348), a cut made first.
// `online` comes from the mode: a live session that will receive pushes
// (local: its wakeup socket answers; server: an open connection).
// `addresses`: the caller's address set, each row of which is its own and
// online; `handle` is its primary. `session`: the caller's ID, whose
// principal the label cut is judged for (a primary can be a team's alias).
// `reader`: an addressless caller's board visibility (an unbound hosted session).
export function who(
  db: Database,
  handle: string,
  opts: { board?: string; include_offline?: boolean; match?: PeerMatch },
  online: (h: string) => boolean,
  ctx: { unbound?: UnboundPeer[]; addresses?: string[]; session?: string; reader?: BoardPredicate } = {},
): WhoResult {
  const isViewer = viewers(db);
  const acc = access(db);
  let rows: WhoRow[];
  if (opts.board !== undefined) {
    const b = visibleBoard(db, ctx.reader ?? handle, opts.board);
    rows = whoRows(db, b.name).filter((r) => acc.canSee(r.handle, b));
  } else {
    rows = whoRows(db, null);
  }
  // One scope check per alias scope, not one per row (#373).
  const viewer = ctx.session ?? handle;
  const memo = (check: (scope: AliasScopeOf) => boolean) => {
    const seen = new Map<string, boolean>();
    return (scope: AliasScopeOf): boolean => {
      const key = `${scope.scope_kind}\0${scope.scope_ref}`;
      let v = seen.get(key);
      if (v === undefined) seen.set(key, v = check(scope));
      return v;
    };
  };
  const peers = assembleWho(rows, opts.match, {
    isViewer,
    seesName: acc.seesAlias ? memo((s) => acc.seesAlias!(viewer, s)) : () => true,
    seesMeta: memo((s) => acc.seesAliasMeta(viewer, s)),
    online,
    own: new Set(ctx.addresses ?? [handle]),
    now: Date.now(),
  });
  // A board's roster lists its unbound subscribers by ID among its peers.
  const unbound = opts.board === undefined ? unboundRows(db, ctx.unbound ?? [], opts.match) : [];
  return finishWho(peers, unbound, isViewer(handle) ? undefined : handle, opts.include_offline);
}

type AliasScopeOf = Omit<AliasScope, "name">;

/** One roster row (who's query): an alias or a board's subscriber, with its session's facts (ALIAS_SESSION_SQL). */
export type WhoRow = {
  handle: string; last_seen: number | null; mode?: SubMode; id: string | null; principal: string | null; cwd: string | null; place: string | null;
  status: string | null; status_at: number | null; harness: string | null; model: string | null; effort: string | null; launcher: number | null;
  human: number | null; queue_off: number | null; scope_kind: ScopeKind | null; scope_ref: string | null;
} & { [K in keyof AliasMeta]-?: string | null };

/**
 * The roster's rows, unjudged: every alias that has had a session, or `board`'s subscribers (a board already judged
 * visible to the caller; the caller judges each row's sight of it).
 */
export function whoRows(db: Database, board: string | null): WhoRow[] {
  const held = `EXISTS (SELECT 1 FROM alias_holds h WHERE h.address = a.address AND h.id = i.id)`;
  const facts = `i.id, i.principal, i.cwd, i.place, i.harness, i.model, i.effort, i.launcher,
    a.human, a.queue_off, a.scope_kind, a.scope_ref, ${ALIAS_META_KEYS.map((k) => `a.${k}`).join(", ")}`;
  if (board === null) {
    return db
      .prepare(
        `SELECT a.address AS handle, a.last_seen, ${facts},
             CASE WHEN ${held} THEN i.status END AS status, CASE WHEN ${held} THEN i.status_at END AS status_at FROM aliases a
           LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL}
          WHERE a.last_seen IS NOT NULL ORDER BY a.address`,
      )
      .all() as WhoRow[];
  }
  // A subscription a session took as its ID is listed under its primary
  // (as queueLanes does), or as the ID with its own session's facts; a
  // name's own subscription wins over its ID's.
  const subs = db
    .prepare(
      `SELECT m.handle, m.mode, m.own, COALESCE(a.last_seen, i.last_seen) AS last_seen, ${facts},
           CASE WHEN a.address IS NULL AND i.ended_at IS NULL OR ${held} THEN i.status END AS status,
           CASE WHEN a.address IS NULL AND i.ended_at IS NULL OR ${held} THEN i.status_at END AS status_at FROM (
           SELECT COALESCE(s.ph, s.handle) AS handle, s.mode, s.ph IS NULL AS own
             FROM (SELECT s0.handle, s0.mode, ${primaryHoldSql("s0.handle")} AS ph FROM subscriptions s0 WHERE s0.board = ?) s) m
         LEFT JOIN aliases a ON a.address = m.handle
         LEFT JOIN ids i ON i.id = COALESCE(${ALIAS_SESSION_SQL}, m.handle)
        ORDER BY m.handle, m.own DESC`,
    )
    .all(board) as (WhoRow & { own: number })[];
  return subs.filter((r, n) => n === 0 || subs[n - 1]!.handle !== r.handle).map(({ own: _, ...r }) => r);
}

/**
 * What assembleWho asks of the mode, each a sync lookup. `seesName`/`seesMeta`: whether the caller (its session's
 * principal) may see that an alias of a scope exists, and read its labels; `seesMeta` is also asked of
 * `{scope_kind: "person", scope_ref: principal}` for every row (principal null included) to gate an ID row's session
 * facts and a `match.scope` on a principal. `own`: the caller's addresses.
 */
export type WhoFacts = {
  isViewer: (handle: string) => boolean;
  seesName: (scope: AliasScopeOf) => boolean;
  seesMeta: (scope: AliasScopeOf) => boolean;
  online: (handle: string) => boolean;
  own: Set<string>;
  now: number;
  // The scope an ID row's principal acts in: the mode's to say (a server's service principal acts in a service scope,
  // #1241); a person's when absent, as local mode's one principal is.
  principalScope?: (principal: string | null) => AliasScopeOf;
};

/** The peers the caller is shown of roster `rows` it may see the board of, cut and matched as who's comment says. */
export function assembleWho(rows: WhoRow[], match: PeerMatch | undefined, f: WhoFacts): Peer[] {
  const all: Peer[] = [];
  const principalScope = f.principalScope ?? ((principal: string | null): AliasScopeOf => ({ scope_kind: "person", scope_ref: principal }));
  for (const r of rows) {
    if (f.isViewer(r.handle)) continue;
    // Whether the row is listed at all: a team's alias only to the team's
    // members (#348), before `match` and the offline count, so neither probes
    // a hidden name.
    if (r.scope_kind !== null && !f.own.has(r.handle) && !f.seesName({ scope_kind: r.scope_kind, scope_ref: r.scope_ref })) continue;
    const seesMeta = r.scope_kind !== null && f.seesMeta({ scope_kind: r.scope_kind, scope_ref: r.scope_ref });
    // The session's facts (where it runs, its status, harness, model, effort,
    // launcher) follow the labels' cut: an alias's to a caller that may act
    // in its scope, an ID's to one that may act in its principal's (security
    // audit F-12). Another user's agent is a handle and its presence, nothing
    // about their machine or work. Locally every row passes.
    const seesSession = f.own.has(r.handle) || (r.scope_kind !== null ? seesMeta : f.seesMeta(principalScope(r.principal)));
    const where = !seesSession ? null : r.cwd ? describeLocation(r.cwd) : r.place;
    const session = seesSession ? sessionFacts(r) : {};
    const meta: AliasMeta = {};
    if (seesMeta) for (const k of ALIAS_META_KEYS) if (r[k]) meta[k] = r[k];
    // An ID row's scope is its principal, which the row doesn't show: it
    // matches only for a caller that may act in that principal's scope (#371).
    if (match) {
      const idScope = match.scope !== undefined && r.principal !== null && f.seesMeta(principalScope(r.principal));
      const scope = (r.scope_kind !== null ? r.scope_ref : idScope ? r.principal : null) ?? undefined;
      if (!matches(match, { id: r.id ?? undefined, ...session, ...meta, scope })) continue;
    }
    all.push({
      handle: r.handle,
      online: f.own.has(r.handle) || f.online(r.handle),
      last_seen: r.last_seen ?? 0,
      ...(f.own.has(r.handle) ? { self: true as const } : {}),
      ...(r.id ? { id: r.id } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(where ? { where } : {}),
      ...(seesSession && r.status ? { status: r.status, status_age: age(f.now - (r.status_at ?? f.now)) } : {}),
      ...session,
      ...meta,
      ...(r.human ? { human: true as const } : {}),
      ...(r.queue_off ? { queue_off: true as const } : {}),
      ...(seesSession && r.launcher ? { launcher: true as const } : {}),
    });
  }
  return all;
}

/** peer_list's result from its peers: `you` unless the caller is a viewer (undefined), offline peers counted unless asked for. */
export function finishWho(all: Peer[], unbound: UnboundPeer[], you: string | undefined, includeOffline: boolean | undefined): WhoResult {
  const sessions = unbound.length ? { unbound_sessions: unbound } : {};
  const y = you === undefined ? {} : { you };
  if (includeOffline) return { ...y, peers: all, ...sessions };
  const peers = all.filter((p) => p.online);
  const hidden = all.length - peers.length;
  return { ...y, peers, ...sessions, ...(hidden ? { offline_hidden: hidden } : {}) };
}

function sessionFacts(r: { harness: string | null; model: string | null; effort: string | null }): SessionFacts {
  return { ...(r.harness ? { harness: r.harness } : {}), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) };
}

// The mode's unbound sessions with their ID facts, filtered by `match`.
// `scope` matches an ID's principal with no seesAliasMeta check (unlike the
// held rows above). That is safe only because every `unbound` list is the
// caller's own user's sessions: the server's unboundPeers
// (src/server/application.ts) filters on the caller's user_id, and local mode
// has one user. A change that lists another user's sessions must add the
// check here, or a scope match probes their principal (#371, #391).
function unboundRows(db: Database, unbound: UnboundPeer[], match: PeerMatch | undefined): UnboundPeer[] {
  const q = db.prepare(`SELECT principal, harness, model, effort, launcher FROM ids WHERE id = ?`);
  return unboundFrom(unbound, (id) => (q.get(id) as UnboundFacts | null) ?? undefined, match);
}

/** An unbound session's ID facts, as peer_list reads them. */
export type UnboundFacts = { principal: string | null; harness: string | null; model: string | null; effort: string | null; launcher: number | null };

/** unboundRows over the sessions' facts, read by the caller (`factsOf`: undefined for a session with no row). */
export function unboundFrom(unbound: UnboundPeer[], factsOf: (id: string) => UnboundFacts | undefined, match: PeerMatch | undefined): UnboundPeer[] {
  const out: UnboundPeer[] = [];
  for (const u of unbound) {
    const r = factsOf(u.session_id);
    const session = r ? sessionFacts(r) : {};
    if (match && !matches(match, { id: u.session_id, ...session, scope: r?.principal ?? undefined })) continue;
    // An unbound launcher is delegable by its ID (#337), so it's marked as a bound one is (#764).
    out.push({ ...u, ...session, ...(r?.launcher ? { launcher: true as const } : {}) });
  }
  return out;
}

// When a handle last had a session, or null if it never connected. An ID's
// is its own session's (#284 S8).
export function lastSeen(db: Database, handle: string): number | null {
  const sql = addressParts(handle)?.kind === "id" ? `SELECT last_seen FROM ids WHERE id = ?` : `SELECT last_seen FROM aliases WHERE address = ?`;
  const row = db.prepare(sql).get(handle) as { last_seen: number | null } | undefined;
  return row?.last_seen ?? null;
}

/** Every handle in the roster: the aliases that have had a session. */
export function rosterHandles(db: Database): string[] {
  return (db.prepare(`SELECT address FROM aliases WHERE last_seen IS NOT NULL`).all() as { address: string }[]).map((r) => r.address);
}

/**
 * Every address that may have a live session, for a mode that must check
 * liveness up front (#284 S8): the roster, and the session IDs that haven't
 * ended, deliver, aren't viewers or children (#523: never an address) and
 * hold no alias (a bound session is reached through its alias).
 */
export function liveAddresses(db: Database): string[] {
  const ids = db
    .prepare(
      `SELECT id FROM ids i WHERE ended_at IS NULL AND delivery = 'push' AND viewer = 0 AND root_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM alias_holds ah WHERE ah.id = i.id) ORDER BY id`,
    )
    .all() as { id: string }[];
  return [...rosterHandles(db), ...ids.map((r) => r.id)];
}

// A human's announcements still inside their TTL, oldest first.
export function activeAnnouncements(db: Database, now = Date.now()): Post[] {
  const board = access(db).announceBoard;
  if (!board) return [];
  return (db
    .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? AND parent_id IS NULL AND expires_at > ? ORDER BY id ASC`)
    .all(board, now) as PostRow[]).map(showPost);
}

export function getPost(db: Database, id: number): Post | undefined {
  const row = db.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`).get(id) as PostRow | null;
  return row ? showPost(row) : undefined;
}

export type Catalog = { boards: Board[]; next_after: string | null };
export function boardCatalog(db: Database, handle: Viewer, after?: string): Catalog {
  return catalogWalk(after, (cursor) => catalogPage(db, cursor), (rows) => rows.filter((b) => sees(db, handle, b)));
}

// The catalog's walk, shared with the server's async catalog: pages of boards after `after` (in name order), each
// filtered by `visible`, until a page of 100 visible boards is filled; `next_after` names the last one when more may follow.
const CATALOG_PAGE = 100;
export function catalogWalk(after: unknown, page: (cursor: string) => Board[], visible: (rows: Board[]) => Board[]): Catalog;
export function catalogWalk(after: unknown, page: (cursor: string) => Promise<Board[]>, visible: (rows: Board[]) => Promise<Board[]>): Promise<Catalog>;
export function catalogWalk(after: unknown, page: (cursor: string) => Board[] | Promise<Board[]>, visible: (rows: Board[]) => Board[] | Promise<Board[]>): Catalog | Promise<Catalog> {
  if (after !== undefined && (typeof after !== "string" || !BOARD_NAME_RE.test(after) || after.trim() !== after)) {
    throw new CoreError("invalid catalog cursor");
  }
  const boards: Board[] = [];
  // One page: its visible rows join `boards`; a result when the catalog page is full or the boards ran out, else the
  // next cursor.
  const step = (rows: Board[], seen: Board[]): Catalog | string => {
    for (const b of seen) {
      boards.push(b);
      if (boards.length > CATALOG_PAGE) return { boards: boards.slice(0, CATALOG_PAGE), next_after: boards[CATALOG_PAGE - 1]!.name };
    }
    return rows.length < CATALOG_PAGE ? { boards, next_after: null } : rows[CATALOG_PAGE - 1]!.name;
  };
  const first = page((after as string | undefined) ?? "");
  if (!(first instanceof Promise)) {
    let rows = first;
    for (;;) {
      const next = step(rows, visible(rows) as Board[]);
      if (typeof next !== "string") return next;
      rows = page(next) as Board[];
    }
  }
  return (async () => {
    let rows = await first;
    for (;;) {
      const next = step(rows, await visible(rows));
      if (typeof next !== "string") return next;
      rows = await page(next);
    }
  })();
}

// One catalog page: up to CATALOG_PAGE boards named after `cursor`, in name order, unfiltered.
export function catalogPage(db: Database, cursor: string): Board[] {
  return (db.prepare(`SELECT * FROM boards WHERE name > ? ORDER BY name LIMIT ${CATALOG_PAGE}`).all(cursor) as Board[]).map(showBoard);
}

export type SnapshotOptions = { limit?: number; before_id?: number };
export type BoardSnapshot = { board: Board; posts: Post[]; next_before_id: number | null };

// History without attention-queue or subscription side effects, oldest first per page.
export function snapshot(db: Database, handle: Viewer, boardInput: string, opts: SnapshotOptions = {}): BoardSnapshot {
  const board = visibleBoard(db, handle, boardInput);
  return { board, ...snapshotPage(db, board.name, opts) };
}

// A snapshot's page of a board already judged visible: the options checked, then the posts with their attachments.
// The server's async snapshot reads it through its store after its own visibility check, in the same order.
export function snapshotPage(db: Database, board: string, opts: SnapshotOptions = {}): Omit<BoardSnapshot, "board"> {
  const limit = opts.limit === undefined ? 20 : opts.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError("snapshot limit must be an integer from 1 to 100");
  if (opts.before_id !== undefined && (!Number.isSafeInteger(opts.before_id) || opts.before_id < 1)) {
    throw new CoreError("snapshot before_id must be a positive safe integer");
  }
  const rows = (opts.before_id === undefined
    ? db.prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`).all(board, limit + 1)
    : db.prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(board, opts.before_id, limit + 1)) as PostRow[];
  const more = rows.length > limit;
  const posts = rows.slice(0, limit).reverse().map(showPost);
  return { posts: withAttachments(db, "post", posts), next_before_id: more ? posts[0]!.id : null };
}

export type ReadResult = { board: string; posts: Post[]; unread_remaining: number };

// Default: your unread posts (oldest first); if none, the latest `limit`
// (default 10: a reader with nothing unread is orienting, and a full page sits
// in its context for the rest of the session).
// With before_id: page back through history. With thread: the whole thread.
// Advances your cursor to the newest post returned. A predicate viewer has
// no cursor: it gets the latest page and changes nothing. Nor does `peek` (a
// child session's read, #523): the board is judged by the viewer, but the read
// state is its root's, so it reads as a predicate viewer does.
export function read(
  db: Database,
  viewer: Viewer,
  boardInput: string,
  opts: { limit?: number; before_id?: number; thread?: number; peek?: boolean } = {},
): ReadResult {
  const board = visibleBoard(db, viewer, boardInput).name;
  return readRows(db, board, typeof viewer === "string" && !opts.peek ? viewer : null, opts);
}

/**
 * read on a board already judged visible: `handle` is whose cursor and pushes the read uses and advances, or null
 * for a read that changes nothing (a predicate viewer, a peek).
 */
export function readRows(db: Database, board: string, handle: string | null, opts: { limit?: number; before_id?: number; thread?: number } = {}): ReadResult {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  let posts: PostRow[];

  if (opts.thread !== undefined) {
    const rootId = threadRoot(db, opts.thread);
    posts = db
      .prepare(
        `WITH RECURSIVE t AS (
           SELECT ${POST_COLS} FROM posts WHERE id = ? AND board = ?
           UNION ALL
           SELECT ${P_POST_COLS} FROM posts p JOIN t ON p.parent_id = t.id
         ) SELECT * FROM t ORDER BY id ASC`,
      )
      .all(rootId, board) as PostRow[];
  } else if (opts.before_id !== undefined) {
    posts = (
      db
        .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(board, opts.before_id, limit) as PostRow[]
    ).reverse();
  } else {
    const sub = handle === null ? undefined : db
      .prepare(`SELECT cursor FROM subscriptions WHERE board = ? AND handle = ?`)
      .get(board, handle) as { cursor: number } | undefined;
    posts = sub
      ? (db
          .prepare(
            `SELECT ${P_POST_COLS} FROM posts p WHERE board = ? AND id > ? AND ${NOT_OWN} AND ${NOT_PUSHED_YET}
              ORDER BY id ASC LIMIT ?`,
          )
          .all(board, sub.cursor, handle, handle, handle, handle, limit) as PostRow[])
      : [];
    if (posts.length === 0) {
      posts = (
        db
          .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`)
          .all(board, opts.limit === undefined ? 10 : limit) as PostRow[]
      ).reverse();
    }
  }

  if (handle === null) return { board, posts: withAttachments(db, "post", posts.map(showPost)), unread_remaining: 0 };
  const maxId = posts.reduce((m, p) => Math.max(m, p.id), 0);
  if (maxId > 0) {
    db.prepare(
      `UPDATE subscriptions SET cursor = MAX(cursor, ?) WHERE board = ? AND handle = ?`,
    ).run(maxId, board, handle);
    // What you've now read no longer needs pushing; what this read skipped
    // (a pending push it filters out, a post outside the thread) still does.
    db.prepare(
      `UPDATE outbox SET delivered_at = ? WHERE handle = ? AND delivered_at IS NULL
         AND post_id IN (SELECT value FROM json_each(?))`,
    ).run(Date.now(), handle, JSON.stringify(posts.map((p) => p.id)));
  }

  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts p JOIN subscriptions s
         ON s.board = p.board AND s.handle = ?
        WHERE p.board = ? AND p.id > s.cursor AND ${NOT_OWN} AND ${NOT_PUSHED_YET}`,
    )
    .get(handle, board, handle, handle, handle, handle) as { n: number };

  return { board, posts: withAttachments(db, "post", posts.map(showPost)), unread_remaining: remaining.n };
}

// ── delivery ─────────────────────────────────────────────────────────────────

// pendingFor's digest read: one row per digest subscription of the handle with nothing sent since its last catch-up.
// Both subqueries share one predicate, so latest_id is the newest post counted (own and pushed posts can be newer);
// it's used only when unread > 0, so the index's walk back from the board's end finds one and stops there (#900). Queue-kind boards are excluded: their posts deliver to exactly one subscriber, so they never
// count as digest unread for the others. Exported so a test pins its plan (#904); all nine parameters are the handle.
export const DIGEST_SQL = `SELECT s.board, s.cursor,
              (SELECT COUNT(*) FROM posts p WHERE p.board = s.board AND p.id > s.cursor
                 AND ${NOT_OWN} AND ${NOT_PUSHED}) AS unread,
              (SELECT p.id FROM posts p WHERE p.board = s.board AND p.id > s.cursor AND ${NOT_OWN} AND ${NOT_PUSHED}
                ORDER BY p.id DESC LIMIT 1) AS latest_id
         FROM subscriptions s
        WHERE s.handle = ? AND s.mode = 'digest' AND s.notified_id <= s.cursor
          AND s.board NOT IN (SELECT name FROM boards WHERE kind = 'queue')`;

// Everything this handle should be told about now. Call markDelivered (or
// acknowledge) for each item after it's handed to the agent (at-least-once).
// Items for boards the handle can no longer see are dropped here.
//
// Deferred pushes and digests never wake an agent on their own: they come
// back only alongside a waking push, or with `all` (a session's first drain,
// a drain that's delivering direct messages, or a human's session). Any
// notification wakes an idle agent, and drains also run on liveness probes.
// `ack`: how a push the reader can no longer see is acknowledged (default: now, on db); the server posts it through
// its write queue (#807 D4).
export function pendingFor(db: Database, handle: string, opts: { all?: boolean; ack?: (handle: string, ref: PendingRef) => void } = {}): Pending[] {
  const a = access(db);
  const seen = new Map<string, boolean>();
  const visible = (name: string) => {
    let v = seen.get(name);
    if (v === undefined) {
      const b = getBoard(db, name);
      v = !!b && a.canSee(handle, b);
      seen.set(name, v);
    }
    return v;
  };
  const { items, lost } = pushItems(pendingPushes(db, handle), visible);
  for (const ref of lost) (opts.ack ?? ((h, r) => acknowledge(db, h, r)))(handle, ref);
  if (!wantsDigests(items, opts.all)) return [];
  return [...items, ...digestItems(pendingDigests(db, handle), visible)];
}

// pendingFor's pieces, shared with the server's async drain (#807 P3 B5a1): its reads, then its rule over them.
export type PushRow = { reason: "mention" | "thread" | "subscription"; wake: boolean; post: Post };
export type DigestRow = { board: string; unread: number; latest: Post };

// The handle's undelivered pushes, oldest first, with their attachments.
export function pendingPushes(db: Database, handle: string): PushRow[] {
  const rows = withAttachments(
    db,
    "post",
    db
      .prepare(
        `SELECT o.reason, o.wake, ${P_POST_COLS} FROM outbox o JOIN posts p ON p.id = o.post_id
          WHERE o.handle = ? AND o.delivered_at IS NULL ORDER BY p.id ASC`,
      )
      .all(handle) as (PostRow & { reason: PushRow["reason"]; wake: number })[],
  );
  return rows.map(({ reason, wake, ...row }) => ({ reason, wake: !!wake, post: showPost(row) }));
}

// The handle's digests due (DIGEST_SQL): unread exists and nothing was sent since its last catch-up, with the latest post.
export function pendingDigests(db: Database, handle: string): DigestRow[] {
  const digests = db
    .prepare(DIGEST_SQL)
    .all(handle, handle, handle, handle, handle, handle, handle, handle, handle) as { board: string; unread: number; latest_id: number | null }[];
  return digests.flatMap((d) => (d.unread > 0 && d.latest_id !== null ? [{ board: d.board, unread: d.unread, latest: getPost(db, d.latest_id)! }] : []));
}

// Pushes on boards the reader sees become items, waking or deferred; the rest are lost and acknowledged.
export function pushItems(rows: PushRow[], visible: (board: string) => boolean): { items: Pending[]; lost: PendingRef[] } {
  const items: Pending[] = [], lost: PendingRef[] = [];
  for (const { reason, wake, post } of rows) {
    if (visible(post.board)) items.push(wake ? { kind: "push", reason, post } : { kind: "push", reason, post, deferred: true });
    else lost.push({ kind: "push", post_id: post.id });
  }
  return { items, lost };
}

// Deferred pushes and digests ride along only with a waking push, or with `all`.
export const wantsDigests = (items: Pending[], all = false): boolean => all || items.some((i) => i.kind === "push" && !i.deferred);

export function digestItems(rows: DigestRow[], visible: (board: string) => boolean): Pending[] {
  return rows.filter((d) => visible(d.board)).map((d): Pending => ({ kind: "digest", board: d.board, unread: d.unread, latest: d.latest }));
}

export function refOf(item: Pending): PendingRef {
  return item.kind === "push"
    ? { kind: "push", post_id: item.post.id }
    : { kind: "digest", board: item.board, latest_id: item.latest.id };
}

/**
 * One key per pending item a session is sent once, whichever of its
 * addresses it is pending for (#361): a push by post; a digest by board, so
 * until one is acked newer posts don't send another.
 */
export function pendingKey(r: PendingRef): string {
  return r.kind === "push" ? `p:${r.post_id}` : `d:${r.board}`;
}

export function markDelivered(db: Database, handle: string, item: Pending): void {
  acknowledge(db, handle, refOf(item));
}

export function acknowledge(db: Database, handle: string, ref: PendingRef): void {
  if (ref.kind === "push") {
    const row = db
      .prepare(
        `SELECT o.reason, p.board FROM outbox o JOIN posts p ON p.id = o.post_id
          WHERE o.handle = ? AND o.post_id = ?`,
      )
      .get(handle, ref.post_id) as { reason: string; board: string } | undefined;
    if (!row) return;
    db.prepare(`UPDATE outbox SET delivered_at = ? WHERE handle = ? AND post_id = ?`).run(
      Date.now(),
      handle,
      ref.post_id,
    );
    // Push-mode subscribers have now seen it in full: count it as read.
    if (row.reason === "subscription") {
      db.prepare(
        `UPDATE subscriptions SET cursor = MAX(cursor, ?), notified_id = MAX(notified_id, ?)
          WHERE board = ? AND handle = ? AND mode = 'push'`,
      ).run(ref.post_id, ref.post_id, row.board, handle);
    }
  } else {
    db.prepare(
      `UPDATE subscriptions SET notified_id = MAX(notified_id, ?) WHERE board = ? AND handle = ?`,
    ).run(ref.latest_id, ref.board, handle);
  }
}

// ── retention ────────────────────────────────────────────────────────────────

// How long messages and posts keep, unless the operator (or a local user) says otherwise.
export const DEFAULT_RETENTION_DAYS = 90;

// The one retention-days rule, shared by the server (GRAYBOARD_*_RETENTION_DAYS) and
// local (BUS_RETENTION_DAYS): unset/empty returns the fallback; otherwise a positive
// whole number of days, or null to refuse. NaN here would make every `created_at <
// cutoff` comparison false and silently prune nothing, so both modes parse through
// this and never re-type the rule (#151).
export function parseRetentionDays(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

// Operator retention, not an agent operation. Replies outlive their pruned
// parents as thread roots. `deleted`, if given, gains each table's count once
// the transaction commits.
export function prunePosts(db: Database, olderThanMs: number, deleted?: Record<string, number>): string[] {
  const counts: Record<string, number> = {};
  // Immediate: the first statement is a read, and a deferred transaction
  // whose snapshot another writer advanced fails its first write with
  // SQLITE_BUSY at once, busy_timeout or not (#340).
  const changed = db.transaction(() => {
    const boards = db.prepare(`SELECT DISTINCT board FROM posts WHERE created_at < ? ORDER BY board`).all(olderThanMs) as { board: string }[];
    const old = `SELECT id FROM posts WHERE created_at < ?`;
    db.prepare(`UPDATE posts SET parent_id = NULL WHERE parent_id IN (${old})`).run(olderThanMs);
    counts.outbox = db.prepare(`DELETE FROM outbox WHERE post_id IN (${old})`).run(olderThanMs).changes;
    counts.thread_mutes = db.prepare(`DELETE FROM thread_mutes WHERE root_id IN (${old})`).run(olderThanMs).changes;
    counts.attachments = dropAttachments(db, "post", old, olderThanMs);
    counts.posts = db.prepare(`DELETE FROM posts WHERE created_at < ?`).run(olderThanMs).changes;
    counts.claim_events = db.prepare(`DELETE FROM claim_events WHERE at < ?`).run(olderThanMs).changes;
    // Each name's latest bound or moved event outlives retention: who holds a
    // name by the record (latestBinder, continuityOf) is read from it (#211).
    counts.binding_events = db.prepare(
      `DELETE FROM binding_events WHERE COALESCE(last_at, at) < ? AND id NOT IN
         (SELECT MAX(id) FROM binding_events WHERE event IN ('bound', 'moved') GROUP BY name)`,
    ).run(olderThanMs).changes;
    // Expired claims are left to sweepExpired, which announces them.
    return boards.map(b => b.board);
  }).immediate();
  if (deleted) for (const [table, n] of Object.entries(counts)) deleted[table] = (deleted[table] ?? 0) + n;
  return changed;
}
