import type { Database } from "bun:sqlite";
import { describeLocation } from "../shared/identity.ts";
import type { AttachmentInfo, AttachmentLimits } from "../shared/attachments.ts";
import { bindAttachments, dropAttachments, withAttachments } from "./attachments.ts";
import { CoreError } from "./errors.ts";
import { ackQueueClaim, logEvent } from "./claims.ts";
import { addressParts, aliasScope, type AliasScope, type ScopeKind } from "./addresses.ts";
import { writeCoreAudit, type AuditSink } from "./audit.ts";
import { SESSION_ID_PATTERN } from "./session_id.ts";
import { undeliverableId } from "./session_end.ts";

// For callers outside the storage seam (src/server/*) that pass the handle through.
export type CoreDb = Database;

export const BOARD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_BODY_BYTES = 64 * 1024;

// A post's or direct message's body, checked alike in both modes (#75).
export function checkBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) throw new CoreError("body is required");
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new CoreError(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return body;
}
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
};
export type Post = {
  id: number;
  board: string;
  author: string;
  body: string;
  parent_id: number | null;
  created_at: number;
  // An announcement's TTL; null (or absent, from older peers) otherwise.
  expires_at?: number | null;
  // Present on reads and pushes when the post carries files.
  attachments?: AttachmentInfo[];
};

// A post's columns as readers see them. author_id (#284) is the writing
// session's provenance, kept in the database and left out of reads and pushes.
const POST_COLS = `id, board, author, body, parent_id, created_at, expires_at`;
const P_POST_COLS = `p.id, p.board, p.author, p.body, p.parent_id, p.created_at, p.expires_at`;

export type Pending =
  | { kind: "push"; reason: "mention" | "thread" | "subscription"; post: Post; deferred?: true }
  | { kind: "digest"; board: string; unread: number; latest: Post };

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
  // post instead of going unresolved.
  resolveMention(token: string, author: string, board: Board, strict: boolean): string | null;
  // Whether a post by `from` may reach `to` as a thread reply. Omitted: always.
  mayReach?(from: string, to: string): boolean;
  // Whether the principal of `handle` (the calling session's ID) may read an alias's labels (task, owner,
  // source board, spec hash, description) in peer_list: only inside a scope
  // it may act in (#284 S13).
  seesAliasMeta(handle: string, scope: Omit<AliasScope, "name">): boolean;
  // The board only a human handle can start posts on, or null for none.
  announceBoard: string | null;
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
  // Self-reported at launch (BUS_MODEL, BUS_EFFORT; the WSS hello), shown in peer_list (#284 S12).
  model?: string | null;
  effort?: string | null;
};

/** The id_collision refusal's text, both modes: `id` and why it's taken. */
export function idCollisionText(id: string, why: string): string {
  return `id_collision: ${id} ${why}; start with a new session key`;
}

/** The refusal for a session ID that already has a row (#284 decision 2): a reused key, or a collision. */
export class IdCollision extends CoreError {
  // Why the ID can't be this session's: its id.collision audit's `why`.
  readonly why: string;
  constructor(readonly id: string, readonly endedAt: number | null) {
    const why = endedAt === null ? "is a live session's" : `ended at ${new Date(endedAt).toISOString()}`;
    super(idCollisionText(id, why));
    this.why = why;
  }
}

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
    `INSERT INTO ids (id, principal, harness, cwd, place, launcher, started_at, last_seen, delivery, writes_as, viewer, keyed, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.id, f.principal, f.harness ?? null, f.cwd ?? null, cleanPlace(f.place ?? null), f.launcher ? 1 : 0, now, now, f.writesAs === undefined ? "push" : "none", f.writesAs ?? null, f.viewer ? 1 : 0, f.keyed ? 1 : 0, f.model ?? null, f.effort ?? null);
  return (db.prepare(`DELETE FROM pruned_ids WHERE id = ? RETURNING ended_at, pruned_at`).get(f.id) as ReusedId | null) ?? null;
}

/**
 * Retention for session IDs (#284 S10, decision 4): delete the ids rows of
 * sessions that ended before `olderThanMs`. Nothing else names an ended ID
 * but provenance text (binding_events, sender_id, audit rows), which stays.
 * A keyed row leaves a pruned_ids tombstone. Returns how many it deleted.
 */
export function pruneEndedIds(db: Database, olderThanMs: number, now = Date.now()): number {
  return db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO pruned_ids (id, ended_at, pruned_at) SELECT id, ended_at, ? FROM ids WHERE ended_at < ? AND keyed = 1`).run(now, olderThanMs);
    return db.prepare(`DELETE FROM ids WHERE ended_at < ?`).run(olderThanMs).changes;
  }).immediate();
}

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

/** Declared human handles. */
export function humanHandles(db: Database): string[] {
  return (db.prepare(`SELECT address FROM aliases WHERE human = 1 ORDER BY address`).all() as { address: string }[]).map((r) => r.address);
}

export const cleanPlace = (place: string | null): string | null => place?.replace(/\s+/g, " ").trim().slice(0, 200) || null;

// Server mode: where the session runs, as its client described it.
export function setPlace(db: Database, id: string, place: string | null): void {
  db.prepare(`UPDATE ids SET place = ? WHERE id = ?`).run(cleanPlace(place), id);
}

const MAX_STATUS = 200;

/** Text as one line: whitespace runs to a space, other control characters dropped, trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}

// One line saying what the session holding `handle` is doing; empty clears
// it. Status is the session's (#284), so it goes to the alias's holder: a
// tools-only process sets its owner's.
export function setStatus(db: Database, handle: string, text: string, now = Date.now()): void {
  const t = oneLine(text);
  if (t.length > MAX_STATUS) throw new CoreError(`status must be at most ${MAX_STATUS} chars`);
  touchAlias(db, handle, now);
  // An ID-only session (#284 S13) sets its own row; a name, its holder's.
  const session = addressParts(handle)?.kind === "id" ? `?3 AND ended_at IS NULL` : `(SELECT id FROM alias_holds WHERE address = ?3)`;
  const r = db.prepare(`UPDATE ids SET status = ?1, status_at = ?2 WHERE id = ${session}`).run(t || null, t ? now : null, handle);
  if (r.changes === 0) throw new CoreError(`no live session holds "${handle}", so it has no status to set`);
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
  const board = normalizeBoard(name);
  if (!String(purpose ?? "").trim()) throw new CoreError("purpose is required");
  const kind = opts.kind ?? "broadcast";
  if (kind !== "broadcast" && kind !== "queue") throw new CoreError(`kind must be "broadcast" or "queue"`);
  const denied = access(db).checkCreate(handle, scope);
  if (denied) throw new CoreError(denied);
  const res = db
    .prepare(
      `INSERT INTO boards (name, purpose, scope, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(board, purpose.trim(), scope, handle, Date.now(), kind);
  if (res.changes === 0) throw new CoreError(`board #${board} already exists`);
  subscribe(db, handle, board, "push");
  return getBoard(db, board)!;
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
  return db.prepare(`SELECT * FROM boards WHERE name = ?`).get(name) as Board | undefined;
}

// A board you can't see reads as missing, so its existence doesn't leak.
function visibleBoard(db: Database, handle: string, input: string): Board {
  const name = normalizeBoard(input);
  const b = getBoard(db, name);
  if (!b || !access(db).canSee(handle, b)) {
    throw new CoreError(`no such board #${name}; see board_list`);
  }
  return b;
}

export function canSeeBoard(db: Database, handle: string, name: string): boolean {
  const b = getBoard(db, name);
  return !!b && access(db).canSee(handle, b);
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

export type BoardSummary = Board & { mode: SubMode | null; unread: number; posts: number };

export function listBoards(db: Database, handle: string): BoardSummary[] {
  const rows = db
    .prepare(
      `SELECT b.*, s.mode AS mode,
              (SELECT COUNT(*) FROM posts p WHERE p.board = b.name) AS posts,
              CASE WHEN s.handle IS NULL THEN 0 ELSE
                (SELECT COUNT(*) FROM posts p
                  WHERE p.board = b.name AND p.id > s.cursor AND p.author != ? AND ${NOT_PUSHED_YET}) END AS unread
         FROM boards b
         LEFT JOIN subscriptions s ON s.board = b.name AND s.handle = ?
        ORDER BY b.name`,
    )
    .all(handle, handle, handle) as BoardSummary[];
  const a = access(db);
  return rows.filter((b) => a.canSee(handle, b));
}

// mode "off" unsubscribes. New subscriptions start at the tip: no backlog.
export function subscribe(db: Database, handle: string, boardInput: string, mode: SubMode | "off"): void {
  const board = visibleBoard(db, handle, boardInput).name;
  if (mode === "off") {
    db.prepare(`DELETE FROM subscriptions WHERE board = ? AND handle = ?`).run(board, handle);
    return;
  }
  if (!["push", "digest", "quiet"].includes(mode)) {
    throw new CoreError(`mode must be push, digest, quiet, or off`);
  }
  const tip = tipOf(db, board);
  db.prepare(
    `INSERT INTO subscriptions (board, handle, mode, cursor, notified_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(board, handle) DO UPDATE SET mode = excluded.mode`,
  ).run(board, handle, mode, tip, tip);
}

// Mute or unmute one thread, named by any post in it. A muted thread's
// replies stop pushing to you, even on a push board; @mentions still do.
// Digests and unread counts are unaffected: they aren't pushes.
export function muteThread(db: Database, handle: string, boardInput: string, postId: number, muted: boolean): number {
  const board = visibleBoard(db, handle, boardInput).name;
  const p = getPost(db, postId);
  if (!p || p.board !== board) throw new CoreError(`thread ${postId} is not a post on #${board}`);
  const root = threadRoot(db, postId);
  if (muted) {
    db.prepare(`INSERT INTO thread_mutes (handle, root_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(handle, root);
  } else {
    db.prepare(`DELETE FROM thread_mutes WHERE handle = ? AND root_id = ?`).run(handle, root);
  }
  return root;
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
): { handles: string[]; unresolved: string[] } {
  const a = access(db);
  const handles = new Set<string>();
  const unresolved: string[] = [];
  for (const t of mentionTokens(body)) {
    const h = a.resolveMention(t, author, board, strict);
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
// carry, bound in the post's transaction under the mode's size caps.
// author_id: the posting session's ID (#284), when the writer is a session.
// addresses: the poster's address set (#284 S5), `handle` its primary; a
// queue claim held by any of them is acked, and none of them is pushed the post.
export type PostOpts = {
  online?: (handle: string) => boolean;
  addresses?: string[];
  author_id?: string;
  ttl_ms?: number;
  attachments?: { ids: number[]; limits?: AttachmentLimits };
  // An author's own words: an @id: that can't receive refuses the post.
  // Unset (system posts), it goes unresolved.
  strictIds?: boolean;
};

// Eligible lanes for a queue board's rotation, least-recently-woken first
// (never-woken first, then by handle). A lane is a push subscriber who isn't
// the poster, hasn't opted out (peer_status queue:"off"), and isn't a
// read-only viewer. A session's lane is its primary, the oldest alias it
// holds, else its ID (#284 S8, S13; an ID can't opt out), whichever address
// it subscribed under: a session that subscribed unbound stays in the
// rotation after it binds, once however many aliases it holds. With
// `online`, live lanes come first; offline lanes are the fallback in the same
// order, so an empty live set still delivers.
export function queueLanes(
  db: Database,
  b: Board,
  poster: string,
  opts: { online?: (handle: string) => boolean } = {},
): string[] {
  const a = access(db);
  const isViewer = viewers(db);
  const rows = (
    db
      .prepare(
        `WITH lanes AS (
           SELECT COALESCE(${primaryHoldSql("s.handle")}, s.handle) AS lane FROM subscriptions s
           WHERE s.board = ?1 AND s.mode = 'push')
         SELECT l.lane AS handle FROM lanes l LEFT JOIN aliases h ON h.address = l.lane
         LEFT JOIN ids i ON i.id = l.lane
         WHERE l.lane != ?2
           AND (h.address IS NOT NULL AND h.queue_off IS NULL OR i.id IS NOT NULL AND i.ended_at IS NULL)
         GROUP BY l.lane
         ORDER BY (SELECT MAX(p2.created_at) FROM outbox o2 JOIN posts p2 ON p2.id = o2.post_id
                    WHERE o2.handle = l.lane AND p2.board = ?1) ASC NULLS FIRST, l.lane ASC`,
      )
      .all(b.name, poster) as { handle: string }[]
  )
    .map((r) => r.handle)
    .filter((h) => !isViewer(h) && a.canSee(h, b));
  if (!opts.online) return rows;
  const live = rows.filter((h) => opts.online!(h));
  return [...live, ...rows.filter((h) => !opts.online!(h))];
}

// The claim IS the delivery: the picked lane holds the post until it acks (a
// reply), declines (claim_release), or the TTL lapses (sweepExpired
// redelivers it to the next lane). At-least-once: the claim key is the
// idempotency token. The claim does not announce on the board - the delivery
// IS the visibility, and an announce would cascade back through the queue
// rotation. Caller is inside post's transaction.
function claimQueuePost(db: Database, board: string, p: Post, lane: string, now: number, note = "queue post"): void {
  const key = `queue:${board}:${p.id}`;
  const expires = now + QUEUE_CLAIM_TTL_MS;
  // Redelivery to a lane that already had this post resets its push, so the
  // re-offer actually reaches it (at-least-once).
  db.prepare(
    `INSERT INTO outbox (handle, post_id, reason, wake) VALUES (?, ?, 'subscription', 1)
     ON CONFLICT(handle, post_id) DO UPDATE SET delivered_at = NULL, wake = 1`,
  ).run(lane, p.id);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO claims (key, holder, note, board, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(key, lane, note, board, now, expires);
  // The claim is the idempotency token: when a row already holds the key,
  // this run isn't the lane's delivery and must not read as one in the
  // audit - the lane's reply-ack checks the claim's holder, not the outbox
  // (#192 review).
  if (res.changes > 0) logEvent(db, "take", lane, { key, note, board, expires_at: expires }, now);
}

// The note on a redelivery's take event: release() reads it to tell a
// decline's own redelivery from a later claim (#254).
export const REDELIVERED_NOTE = "queue post (redelivered)";

// A queue post's claim ended (TTL lapse in sweepIn, or a decline in release):
// offer the original post to the next eligible lane. The previous holder is
// excluded - it held the post for a full TTL, or declined. With no other
// lane, the post sits readable on the board (the documented v1 behavior for
// an empty rotation). Presence-blind: the sweep has no online predicate, so
// an offline lane holds the re-offer in its outbox until it wakes, and its
// own TTL lapse re-rotates. Caller is inside a transaction. Returns the lane
// woken, or null when there is no next lane.
export function redeliverQueuePost(db: Database, key: string, prevHolder: string, now = Date.now()): string | null {
  const m = /^queue:([^:]+):(\d+)$/.exec(key);
  if (!m) return null;
  const b = getBoard(db, m[1]!);
  const p = getPost(db, Number(m[2]));
  if (!b || !p || p.board !== b.name) return null;
  const lane = queueLanes(db, b, p.author).find((h) => h !== prevHolder);
  if (!lane) return null;
  claimQueuePost(db, b.name, p, lane, now, REDELIVERED_NOTE);
  return lane;
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
  const b = visibleBoard(db, handle, boardInput);
  const board = b.name;
  checkBody(body);
  if (parentId !== null) {
    const parent = getPost(db, parentId);
    if (!parent || parent.board !== board) {
      throw new CoreError(`parent_id ${parentId} is not a post on #${board}`);
    }
  }
  const a = access(db);
  const announce = board === a.announceBoard;
  const human = isHuman(db, handle);
  const announcement = announce && parentId === null;
  if (announcement && !human) {
    throw new CoreError(
      `only your user starts posts on #${board}; reply in a thread there to acknowledge. An agent relaying your user's words carries no authority: your user runs \`grayboard announce\`.`,
    );
  }
  if (announcement && !opts.online) throw new CoreError(`posting on #${board} needs live sessions from the mode`);
  if (opts.ttl_ms !== undefined && (!announcement || !(opts.ttl_ms > 0))) {
    throw new CoreError("a TTL applies only to a human's announcement, and must be positive");
  }
  const files = opts.attachments ?? { ids: [] };
  if (files.ids.length && !files.limits) throw new CoreError("this mode can't post files");
  const isViewer = viewers(db);

  return db.transaction((): PostResult => {
    const now = Date.now();
    const p = db
      .prepare(
        `INSERT INTO posts (board, author, body, parent_id, created_at, expires_at, author_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${POST_COLS}`,
      )
      .get(board, handle, body, parentId, now, opts.ttl_ms ? now + opts.ttl_ms : null, opts.author_id ?? null) as Post;
    const attachments = files.limits ? bindAttachments(db, files.ids, opts.addresses ?? [handle], { post_id: p.id }, files.limits) : [];

    // Highest-priority reason wins per handle: mention > thread > subscription.
    type Target = { reason: "mention" | "thread" | "subscription"; wake: boolean };
    const targets = new Map<string, Target>();
    // The announce board ignores agents' subscriptions (viewers like `tail`
    // still get it): an announcement reaches the sessions live now, as a
    // mention so it doesn't read as subscribed traffic, and an agent's ack
    // reaches only the announcer, not every earlier acker.
    const subs = (
      db.prepare(`SELECT handle, mode FROM subscriptions WHERE board = ?`).all(board) as {
        handle: string;
        mode: SubMode;
      }[]
    ).filter((s) => a.canSee(s.handle, b) && (!announce || isViewer(s.handle)));
    // A queue-kind board delivers each top-level post to exactly ONE
    // subscriber: the claim IS the delivery. A resolved @mention is direct
    // addressing (it bypasses the rotation); with none, the rotation picks the
    // least-recently-woken eligible subscriber and claims the post (TTL
    // takeover releases it to the next wake). Replies follow thread semantics
    // and release the claimer's claim.
    const queue = !announcement && parentId === null && (b.kind ?? "broadcast") === "queue";
    let unresolved: string[] = [];
    if (queue) {
      const { handles: mentioned, unresolved: u } = resolveMentions(db, body, handle, b, opts.strictIds === true);
      unresolved = u;
      for (const m of mentioned) targets.set(m, { reason: "mention", wake: true });
      if (mentioned.length === 0) {
        // Eligible lanes, least-recently-woken first, live lanes preferred: a
        // post claimed by an offline lane would sit for the full TTL while
        // live lanes idle (#192 review).
        const picked = queueLanes(db, b, handle, { online: opts.online })[0];
        if (picked) {
          targets.set(picked, { reason: "subscription", wake: true });
          claimQueuePost(db, board, p, picked, now);
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
      for (const s of subs)
        if (s.mode === "push" && !queueBoard) targets.set(s.handle, { reason: "subscription", wake: true });
      if (announcement) {
        for (const h of liveAddresses(db)) {
          if (!isViewer(h) && opts.online!(h) && a.canSee(h, b)) targets.set(h, { reason: "mention", wake: true });
        }
      } else if (parentId !== null) {
        const root = threadRoot(db, parentId);
        const authors = announce && !human ? [getPost(db, root)!.author] : threadAuthors(db, root);
        const direct = new Set([getPost(db, parentId)!.author, getPost(db, root)!.author]);
        for (const author of authors) {
          if (!a.canSee(author, b) || (a.mayReach && !a.mayReach(handle, author))) continue;
          // Your user's replies wake the whole thread; a push-mode subscriber
          // still gets every post as it lands.
          const wake = human || direct.has(author) || isHuman(db, author) || targets.get(author)?.wake === true;
          targets.set(author, { reason: "thread", wake });
        }
        // Muting drops thread and subscription pushes; the mention pass below
        // runs after this, so an @mention still lands.
        const muted = db.prepare(`SELECT handle FROM thread_mutes WHERE root_id = ?`).all(root) as { handle: string }[];
        for (const m of muted) targets.delete(m.handle);
      }
      const { handles: mentioned, unresolved: u } = resolveMentions(db, body, handle, b, opts.strictIds === true);
      unresolved = u;
      for (const m of mentioned) targets.set(m, { reason: "mention", wake: true });
    }
    // A queue-board reply by the claim holder acks the work: the claim
    // releases with an ack note, so the handled post's audit chain ends in a
    // release instead of an expire (#192 review). Another lane's reply leaves
    // the holder on the hook. No redelivery: handled is handled.
    if (parentId !== null && (b.kind ?? "broadcast") === "queue") {
      ackQueueClaim(db, opts.addresses ?? [handle], `queue:${board}:${threadRoot(db, parentId)}`, now);
    }
    for (const a of opts.addresses ?? [handle]) targets.delete(a);

    const ins = db.prepare(
      `INSERT INTO outbox (handle, post_id, reason, wake) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const [h, t] of targets) ins.run(h, p.id, t.reason, t.wake ? 1 : 0);

    // Digest subscribers aren't woken: their notice rides with their next wake.
    const all = [...targets];
    return {
      post: attachments.length ? { ...p, attachments } : p,
      wake: all.filter(([, t]) => t.wake).map(([h]) => h),
      deferred: all.filter(([, t]) => !t.wake).map(([h]) => h),
      unresolved,
    };
  })();
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
         ) SELECT DISTINCT author FROM t`,
      )
      .all(rootId) as { author: string }[]
  ).map((r) => r.author);
}

function threadRoot(db: Database, postId: number): number {
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
    if (!(ALIAS_META_KEYS as readonly string[]).includes(k)) throw new CoreError(`unknown meta key "${k}"; known: ${ALIAS_META_KEYS.join(", ")}`);
    if (typeof raw !== "string") throw new CoreError(`meta.${k} must be a string`);
    const t = oneLine(raw);
    if (t.length > MAX_LABEL) throw new CoreError(`meta.${k} must be at most ${MAX_LABEL} chars`);
    out[k as keyof AliasMetaSet] = t === "" ? null : k === "source_board" ? normalizeBoard(t) : t;
  }
  return out;
}

/**
 * Set an alias's labels from a parsed `meta`, as `session` binding it.
 * Only the fields whose value changes are written, and audited as one
 * alias.meta_set; those fields are returned (empty: nothing changed). Call
 * inside the bind's write transaction.
 */
export function setAliasMeta(db: Database, address: string, meta: AliasMetaSet, session: string, audit: AuditSink): AliasMetaSet {
  const keys = Object.keys(meta) as (keyof AliasMetaSet)[];
  if (!keys.length) return {};
  const cur = db.prepare(`SELECT ${ALIAS_META_KEYS.join(", ")} FROM aliases WHERE address = ?`).get(address) as Record<string, string | null> | null;
  if (!cur) throw new Error(`grayboard: no alias "${address}" to label`);
  const fields: AliasMetaSet = {};
  for (const k of keys) if ((meta[k] ?? null) !== cur[k]) fields[k] = meta[k] ?? null;
  const changed = Object.keys(fields) as (keyof AliasMetaSet)[];
  if (!changed.length) return {};
  db.prepare(`UPDATE aliases SET ${changed.map((k) => `${k} = ?`).join(", ")} WHERE address = ?`).run(...changed.map((k) => fields[k] ?? null), address);
  audit("alias.meta_set", session, address, { address, fields, session });
  return fields;
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
export function viewers(db: Database): (handle: string) => boolean {
  const ids = new Set((db.prepare(`SELECT id FROM ids WHERE viewer = 1`).all() as { id: string }[]).map((r) => r.id));
  return (h) => ids.has(h);
}

// A live session with no name yet (#182), addressed by its session ID
// (#284), with the status it set as that ID.
export type UnboundPeer = { session_id: string; unbound: true; online: true; where?: string; status?: string; status_age?: string; self?: true } & SessionFacts;

// `you` is left out only for a viewer, which nothing can address.
export type WhoResult = { you?: string; peers: Peer[]; unbound_sessions?: UnboundPeer[]; offline_hidden?: number };

// peer_list's match filter (#284 S13): exact, case-insensitive, ANDed. scope
// is an alias's scope_ref, or an ID's principal.
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

/** SQL for session `id`'s primary hold (#284 S1): its oldest, or NULL. `id` is an SQL expression. */
export function primaryHoldSql(id: string): string {
  return `(SELECT address FROM alias_holds WHERE id = ${id} ORDER BY bound_at, address LIMIT 1)`;
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
// labels are shown only to a caller that may act in its scope (#284 S13),
// and `match` filters after that cut, so a hidden label can't be probed.
// `online` comes from the mode: a live session that will receive pushes
// (local: its wakeup socket answers; server: an open connection).
// `addresses`: the caller's address set, each row of which is its own and
// online; `handle` is its primary. `session`: the caller's ID, whose
// principal the label cut is judged for (a primary can be a team's alias).
export function who(
  db: Database,
  handle: string,
  opts: { board?: string; include_offline?: boolean; match?: PeerMatch },
  online: (h: string) => boolean,
  ctx: { unbound?: UnboundPeer[]; addresses?: string[]; session?: string } = {},
): WhoResult {
  const isViewer = viewers(db);
  const acc = access(db);
  const own = new Set(ctx.addresses ?? [handle]);
  type Row = {
    handle: string; last_seen: number | null; mode?: SubMode; id: string | null; principal: string | null; cwd: string | null; place: string | null;
    status: string | null; status_at: number | null; harness: string | null; model: string | null; effort: string | null; launcher: number | null;
    human: number | null; queue_off: number | null; scope_kind: ScopeKind | null; scope_ref: string | null;
  } & { [K in keyof AliasMeta]-?: string | null };
  const held = `EXISTS (SELECT 1 FROM alias_holds h WHERE h.address = a.address AND h.id = i.id)`;
  const facts = `i.id, i.principal, i.cwd, i.place, i.harness, i.model, i.effort, i.launcher,
    a.human, a.queue_off, a.scope_kind, a.scope_ref, ${ALIAS_META_KEYS.map((k) => `a.${k}`).join(", ")}`;
  let rows: Row[];
  if (opts.board !== undefined) {
    const b = visibleBoard(db, handle, opts.board);
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
      .all(b.name) as (Row & { own: number })[];
    rows = subs
      .filter((r, n) => n === 0 || subs[n - 1]!.handle !== r.handle)
      .map(({ own: _, ...r }) => r)
      .filter((r) => acc.canSee(r.handle, b));
  } else {
    rows = db
      .prepare(
        `SELECT a.address AS handle, a.last_seen, ${facts},
             CASE WHEN ${held} THEN i.status END AS status, CASE WHEN ${held} THEN i.status_at END AS status_at FROM aliases a
           LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL}
          WHERE a.last_seen IS NOT NULL ORDER BY a.address`,
      )
      .all() as Row[];
  }
  const now = Date.now();
  const all: Peer[] = [];
  for (const r of rows) {
    if (isViewer(r.handle)) continue;
    const where = r.cwd ? describeLocation(r.cwd) : r.place;
    const seesMeta = r.scope_kind !== null && acc.seesAliasMeta(ctx.session ?? handle, { scope_kind: r.scope_kind, scope_ref: r.scope_ref });
    const session = sessionFacts(r);
    const meta: AliasMeta = {};
    if (seesMeta) for (const k of ALIAS_META_KEYS) if (r[k]) meta[k] = r[k];
    const scope = (r.scope_kind !== null ? r.scope_ref : r.principal) ?? undefined;
    if (opts.match && !matches(opts.match, { id: r.id ?? undefined, ...session, ...meta, scope })) continue;
    all.push({
      handle: r.handle,
      online: own.has(r.handle) || online(r.handle),
      last_seen: r.last_seen ?? 0,
      ...(own.has(r.handle) ? { self: true as const } : {}),
      ...(r.id ? { id: r.id } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(where ? { where } : {}),
      ...(r.status ? { status: r.status, status_age: age(now - (r.status_at ?? now)) } : {}),
      ...session,
      ...meta,
      ...(r.human ? { human: true as const } : {}),
      ...(r.queue_off ? { queue_off: true as const } : {}),
      ...(r.launcher ? { launcher: true as const } : {}),
    });
  }
  // A board's roster lists its unbound subscribers by ID among its peers.
  const unbound = opts.board === undefined ? unboundRows(db, ctx.unbound ?? [], opts.match) : [];
  const sessions = unbound.length ? { unbound_sessions: unbound } : {};
  const you = isViewer(handle) ? {} : { you: handle };
  if (opts.include_offline) return { ...you, peers: all, ...sessions };
  const peers = all.filter((p) => p.online);
  const hidden = all.length - peers.length;
  return { ...you, peers, ...sessions, ...(hidden ? { offline_hidden: hidden } : {}) };
}

function sessionFacts(r: { harness: string | null; model: string | null; effort: string | null }): SessionFacts {
  return { ...(r.harness ? { harness: r.harness } : {}), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) };
}

// The mode's unbound sessions with their ID facts, filtered by `match`.
function unboundRows(db: Database, unbound: UnboundPeer[], match: PeerMatch | undefined): UnboundPeer[] {
  const q = db.prepare(`SELECT principal, harness, model, effort FROM ids WHERE id = ?`);
  const out: UnboundPeer[] = [];
  for (const u of unbound) {
    const r = q.get(u.session_id) as { principal: string | null; harness: string | null; model: string | null; effort: string | null } | null;
    const session = r ? sessionFacts(r) : {};
    if (match && !matches(match, { id: u.session_id, ...session, scope: r?.principal ?? undefined })) continue;
    out.push({ ...u, ...session });
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
 * ended, deliver, aren't viewers and hold no alias (a bound session is
 * reached through its alias).
 */
export function liveAddresses(db: Database): string[] {
  const ids = db
    .prepare(
      `SELECT id FROM ids i WHERE ended_at IS NULL AND delivery = 'push' AND viewer = 0
         AND NOT EXISTS (SELECT 1 FROM alias_holds ah WHERE ah.id = i.id) ORDER BY id`,
    )
    .all() as { id: string }[];
  return [...rosterHandles(db), ...ids.map((r) => r.id)];
}

// A human's announcements still inside their TTL, oldest first.
export function activeAnnouncements(db: Database, now = Date.now()): Post[] {
  const board = access(db).announceBoard;
  if (!board) return [];
  return db
    .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? AND parent_id IS NULL AND expires_at > ? ORDER BY id ASC`)
    .all(board, now) as Post[];
}

export function getPost(db: Database, id: number): Post | undefined {
  return db.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`).get(id) as Post | undefined;
}

export type ReadResult = { board: string; posts: Post[]; unread_remaining: number };

// Default: your unread posts (oldest first); if none, the latest `limit`
// (default 10: a reader with nothing unread is orienting, and a full page sits
// in its context for the rest of the session).
// With before_id: page back through history. With thread: the whole thread.
// Advances your cursor to the newest post returned.
export function read(
  db: Database,
  handle: string,
  boardInput: string,
  opts: { limit?: number; before_id?: number; thread?: number } = {},
): ReadResult {
  const board = visibleBoard(db, handle, boardInput).name;
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  let posts: Post[];

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
      .all(rootId, board) as Post[];
  } else if (opts.before_id !== undefined) {
    posts = (
      db
        .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(board, opts.before_id, limit) as Post[]
    ).reverse();
  } else {
    const sub = db
      .prepare(`SELECT cursor FROM subscriptions WHERE board = ? AND handle = ?`)
      .get(board, handle) as { cursor: number } | undefined;
    posts = sub
      ? (db
          .prepare(
            `SELECT ${P_POST_COLS} FROM posts p WHERE board = ? AND id > ? AND author != ? AND ${NOT_PUSHED_YET}
              ORDER BY id ASC LIMIT ?`,
          )
          .all(board, sub.cursor, handle, handle, limit) as Post[])
      : [];
    if (posts.length === 0) {
      posts = (
        db
          .prepare(`SELECT ${POST_COLS} FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`)
          .all(board, opts.limit === undefined ? 10 : limit) as Post[]
      ).reverse();
    }
  }

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
        WHERE p.board = ? AND p.id > s.cursor AND p.author != ? AND ${NOT_PUSHED_YET}`,
    )
    .get(handle, board, handle, handle) as { n: number };

  return { board, posts: withAttachments(db, "post", posts), unread_remaining: remaining.n };
}

// ── delivery ─────────────────────────────────────────────────────────────────

// Everything this handle should be told about now. Call markDelivered (or
// acknowledge) for each item after it's handed to the agent (at-least-once).
// Items for boards the handle can no longer see are dropped here.
//
// Deferred pushes and digests never wake an agent on their own: they come
// back only alongside a waking push, or with `all` (a session's first drain,
// a drain that's delivering direct messages, or a human's session). Any
// notification wakes an idle agent, and drains also run on liveness probes.
export function pendingFor(db: Database, handle: string, opts: { all?: boolean } = {}): Pending[] {
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

  const out: Pending[] = [];
  const pushes = withAttachments(
    db,
    "post",
    db
      .prepare(
        `SELECT o.reason, o.wake, ${P_POST_COLS} FROM outbox o JOIN posts p ON p.id = o.post_id
          WHERE o.handle = ? AND o.delivered_at IS NULL ORDER BY p.id ASC`,
      )
      .all(handle) as (Post & { reason: "mention" | "thread" | "subscription"; wake: number })[],
  );
  for (const { reason, wake, ...p } of pushes) {
    if (visible(p.board)) out.push(wake ? { kind: "push", reason, post: p } : { kind: "push", reason, post: p, deferred: true });
    else acknowledge(db, handle, { kind: "push", post_id: p.id });
  }
  if (!opts.all && !out.some((i) => i.kind === "push" && !i.deferred)) return [];

  // Digest: unread exists and nothing has been sent since the last catch-up.
  // Queue-kind boards are excluded: their posts deliver to exactly one
  // subscriber, so they never count as digest unread for the others.
  const digests = db
    .prepare(
      `SELECT s.board, s.cursor,
              (SELECT COUNT(*) FROM posts p WHERE p.board = s.board AND p.id > s.cursor
                 AND p.author != ? AND ${NOT_PUSHED}) AS unread,
              (SELECT MAX(id) FROM posts p WHERE p.board = s.board AND p.author != ? AND ${NOT_PUSHED}) AS latest_id
         FROM subscriptions s
        WHERE s.handle = ? AND s.mode = 'digest' AND s.notified_id <= s.cursor
          AND s.board NOT IN (SELECT name FROM boards WHERE kind = 'queue')`,
    )
    .all(handle, handle, handle, handle, handle) as { board: string; unread: number; latest_id: number | null }[];
  for (const d of digests) {
    if (d.unread > 0 && d.latest_id !== null && visible(d.board)) {
      out.push({ kind: "digest", board: d.board, unread: d.unread, latest: getPost(db, d.latest_id)! });
    }
  }
  return out;
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
// parents as thread roots.
export function prunePosts(db: Database, olderThanMs: number): void {
  db.transaction(() => {
    const old = `SELECT id FROM posts WHERE created_at < ?`;
    db.prepare(`UPDATE posts SET parent_id = NULL WHERE parent_id IN (${old})`).run(olderThanMs);
    db.prepare(`DELETE FROM outbox WHERE post_id IN (${old})`).run(olderThanMs);
    db.prepare(`DELETE FROM thread_mutes WHERE root_id IN (${old})`).run(olderThanMs);
    dropAttachments(db, "post", old, olderThanMs);
    db.prepare(`DELETE FROM posts WHERE created_at < ?`).run(olderThanMs);
    db.prepare(`DELETE FROM claim_events WHERE at < ?`).run(olderThanMs);
    // Each name's latest bound or moved event outlives retention: who holds a
    // name by the record (lastBoundBy, continuityOf) is read from it (#211).
    db.prepare(
      `DELETE FROM binding_events WHERE COALESCE(last_at, at) < ? AND id NOT IN
         (SELECT MAX(id) FROM binding_events WHERE event IN ('bound', 'moved') GROUP BY name)`,
    ).run(olderThanMs);
    // Expired claims are left to sweepExpired, which announces them.
  })();
}
