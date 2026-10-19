import type { Database } from "bun:sqlite";
import { describeLocation } from "../shared/identity.ts";

// For callers outside the storage seam (src/server/*) that pass the handle through.
export type CoreDb = Database;

export const BOARD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_BODY_BYTES = 64 * 1024;
// @name, @local/name, @user@org.com/name. Not preceded by a word char or @,
// so plain email addresses in prose aren't mentions.
const MENTION_RE =
  /(?:^|[^\w@])@([a-z0-9._%+-]+(?:@[a-z0-9.-]+\.[a-z]{2,})?(?:\/[a-z0-9_-]{1,32})?)/gi;

export type SubMode = "push" | "digest" | "quiet";

// scope: null for an open board, or an opaque string the Access policy
// interprets (the distributed server uses "team:<name>").
export type Board = {
  name: string;
  purpose: string;
  scope: string | null;
  created_by: string;
  created_at: number;
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
};

export type Pending =
  | { kind: "push"; reason: "mention" | "thread" | "subscription"; post: Post; deferred?: true }
  | { kind: "digest"; board: string; unread: number; latest: Post };

// Enough to acknowledge a Pending item after it crossed a wire.
export type PendingRef =
  | { kind: "push"; post_id: number }
  | { kind: "digest"; board: string; latest_id: number };

export class CoreError extends Error {}

// ── access policy ────────────────────────────────────────────────────────────

// Who can see which board, and who an @token means. Every core read and write
// goes through this, so a mode can't forget to filter at a call site.
export type Access = {
  canSee(handle: string, board: Board): boolean;
  // Returns an error message, or null if allowed.
  checkCreate(handle: string, scope: string | null): string | null;
  // The handle a mention token refers to, or null if unknown or ambiguous.
  resolveMention(token: string, author: string, board: Board): string | null;
  // The board only a human handle can start posts on, or null for none.
  announceBoard: string | null;
};

export const ANNOUNCE_BOARD = "announce";

// Local mode: one trusted machine, every board open, bare handles only.
export const openAccess = (db: Database): Access => ({
  announceBoard: ANNOUNCE_BOARD,
  canSee: () => true,
  checkCreate: (_h, scope) => (scope === null ? null : "team boards need distributed mode"),
  resolveMention: (token) => {
    if (!BOARD_NAME_RE.test(token)) return null;
    const row = db.prepare(`SELECT name FROM handles WHERE name = ?`).get(token) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
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

export function touchHandle(db: Database, handle: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO handles (name, first_seen, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(handle, now, now);
}

// A session started: refresh last_seen, record where it runs (null when the
// mode can't know, e.g. a remote server), and clear the previous session's
// status.
export function startSession(db: Database, handle: string, cwd: string | null, now?: number): void {
  touchHandle(db, handle, now);
  db.prepare(`UPDATE handles SET cwd = ?, place = NULL, status = NULL, status_at = NULL WHERE name = ?`)
    .run(cwd, handle);
}

/** Make `handle` the one declared human handle (`grayboard human`). */
export function declareHuman(db: Database, handle: string): void {
  db.transaction(() => {
    touchHandle(db, handle);
    db.prepare(`UPDATE handles SET human = (name = ?)`).run(handle);
  })();
}

/** Whether `handle` is a declared human's. */
export function isHuman(db: Database, handle: string): boolean {
  return !!(db.prepare(`SELECT human FROM handles WHERE name = ?`).get(handle) as { human: number | null } | undefined)?.human;
}

/** Declared human handles. */
export function humanHandles(db: Database): string[] {
  return (db.prepare(`SELECT name FROM handles WHERE human = 1 ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
}

// Server mode: where the session runs, as its client described it.
export function setPlace(db: Database, handle: string, place: string | null): void {
  const p = place?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  db.prepare(`UPDATE handles SET place = ? WHERE name = ?`).run(p, handle);
}

const MAX_STATUS = 200;

// One line saying what this session is doing; empty clears it.
export function setStatus(db: Database, handle: string, text: string, now = Date.now()): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length > MAX_STATUS) throw new CoreError(`status must be at most ${MAX_STATUS} chars`);
  touchHandle(db, handle, now);
  db.prepare(`UPDATE handles SET status = ?, status_at = ? WHERE name = ?`).run(t || null, t ? now : null, handle);
}

// A duration as one short unit: 45m, 6h, 14d.
export function age(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// A handle that no longer exists (e.g. a deleted identity) leaves the roster
// and its board subscriptions. Its posts and claims stay: they're history.
export function forgetHandle(db: Database, handle: string): void {
  db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM thread_mutes WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM claim_watches WHERE handle = ?`).run(handle);
  db.prepare(`DELETE FROM handles WHERE name = ?`).run(handle);
}

export function createBoard(
  db: Database,
  handle: string,
  name: string,
  purpose: string,
  scope: string | null = null,
): Board {
  const board = normalizeBoard(name);
  if (!String(purpose ?? "").trim()) throw new CoreError("purpose is required");
  const denied = access(db).checkCreate(handle, scope);
  if (denied) throw new CoreError(denied);
  const res = db
    .prepare(
      `INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(board, purpose.trim(), scope, handle, Date.now());
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
): { handles: string[]; unresolved: string[] } {
  const a = access(db);
  const handles = new Set<string>();
  const unresolved: string[] = [];
  for (const t of mentionTokens(body)) {
    const h = a.resolveMention(t, author, board);
    if (h && a.canSee(h, board)) handles.add(h);
    else unresolved.push(t);
  }
  return { handles: [...handles], unresolved };
}

// wake: handles to wake now. deferred: thread participants whose push waits
// for their next wake.
export type PostResult = { post: Post; wake: string[]; deferred: string[]; unresolved: string[] };

// online: which handles have a live session (the mode knows); a human's
// announcement needs it. ttl_ms: how long an announcement stays in new
// sessions' instructions.
export type PostOpts = { online?: (handle: string) => boolean; ttl_ms?: number };

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
  if (typeof body !== "string" || !body.trim()) throw new CoreError("body is required");
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new CoreError(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }
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

  return db.transaction((): PostResult => {
    const now = Date.now();
    const p = db
      .prepare(
        `INSERT INTO posts (board, author, body, parent_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(board, handle, body, parentId, now, opts.ttl_ms ? now + opts.ttl_ms : null) as Post;

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
    for (const s of subs) if (s.mode === "push") targets.set(s.handle, { reason: "subscription", wake: true });
    if (announcement) {
      for (const h of rosterHandles(db)) {
        if (!isViewer(h) && opts.online!(h) && a.canSee(h, b)) targets.set(h, { reason: "mention", wake: true });
      }
    } else if (parentId !== null) {
      const root = threadRoot(db, parentId);
      const authors = announce && !human ? [getPost(db, root)!.author] : threadAuthors(db, root);
      const direct = new Set([getPost(db, parentId)!.author, getPost(db, root)!.author]);
      for (const author of authors) {
        if (!a.canSee(author, b)) continue;
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
    const { handles: mentioned, unresolved } = resolveMentions(db, body, handle, b);
    for (const m of mentioned) targets.set(m, { reason: "mention", wake: true });
    targets.delete(handle);

    const ins = db.prepare(
      `INSERT INTO outbox (handle, post_id, reason, wake) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const [h, t] of targets) ins.run(h, p.id, t.reason, t.wake ? 1 : 0);

    // Digest subscribers aren't woken: their notice rides with their next wake.
    const all = [...targets];
    return {
      post: p,
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

export type Peer = {
  handle: string;
  online: boolean;
  last_seen: number;
  self?: true;
  mode?: SubMode;
  where?: string;
  status?: string;
  status_age?: string;
  human?: true;
};
// Read-only viewers (`grayboard tail`) subscribe under "~" handles, which no
// identity can have. They aren't agents: keep them out of the roster.
export const isViewer = (handle: string): boolean => handle.startsWith("~");

export type WhoResult = { you: string; peers: Peer[]; offline_hidden?: number };

// The roster: every handle that has connected (the `handles` table), or a
// board's subscribers. `online` comes from the mode: a live session that will
// receive pushes (local: its wakeup socket answers; server: an open connection).
export function who(
  db: Database,
  handle: string,
  opts: { board?: string; include_offline?: boolean },
  online: (h: string) => boolean,
): WhoResult {
  type Row = { handle: string; last_seen: number | null; mode?: SubMode; cwd: string | null; place: string | null; status: string | null; status_at: number | null; human: number | null };
  let rows: Row[];
  if (opts.board !== undefined) {
    const b = visibleBoard(db, handle, opts.board);
    const a = access(db);
    rows = (
      db
        .prepare(
          `SELECT s.handle, s.mode, h.last_seen, h.cwd, h.place, h.status, h.status_at, h.human FROM subscriptions s
             LEFT JOIN handles h ON h.name = s.handle
            WHERE s.board = ? ORDER BY s.handle`,
        )
        .all(b.name) as typeof rows
    ).filter((r) => a.canSee(r.handle, b));
  } else {
    rows = db
      .prepare(`SELECT name AS handle, last_seen, cwd, place, status, status_at, human FROM handles ORDER BY name`)
      .all() as typeof rows;
  }
  const now = Date.now();
  const all: Peer[] = rows.filter((r) => !isViewer(r.handle)).map((r) => {
    const where = r.cwd ? describeLocation(r.cwd) : r.place;
    return {
      handle: r.handle,
      online: r.handle === handle || online(r.handle),
      last_seen: r.last_seen ?? 0,
      ...(r.handle === handle ? { self: true as const } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(where ? { where } : {}),
      ...(r.status ? { status: r.status, status_age: age(now - (r.status_at ?? now)) } : {}),
      ...(r.human ? { human: true as const } : {}),
    };
  });
  if (opts.include_offline) return { you: handle, peers: all };
  const peers = all.filter((p) => p.online);
  const hidden = all.length - peers.length;
  return { you: handle, peers, ...(hidden ? { offline_hidden: hidden } : {}) };
}

// When a handle last had a session, or null if it never connected.
export function lastSeen(db: Database, handle: string): number | null {
  const row = db.prepare(`SELECT last_seen FROM handles WHERE name = ?`).get(handle) as { last_seen: number } | undefined;
  return row?.last_seen ?? null;
}

/** Every handle in the roster, for a mode that must check liveness up front. */
export function rosterHandles(db: Database): string[] {
  return (db.prepare(`SELECT name FROM handles`).all() as { name: string }[]).map((r) => r.name);
}

// A human's announcements still inside their TTL, oldest first.
export function activeAnnouncements(db: Database, now = Date.now()): Post[] {
  const board = access(db).announceBoard;
  if (!board) return [];
  return db
    .prepare(`SELECT * FROM posts WHERE board = ? AND parent_id IS NULL AND expires_at > ? ORDER BY id ASC`)
    .all(board, now) as Post[];
}

export function getPost(db: Database, id: number): Post | undefined {
  return db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as Post | undefined;
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
           SELECT * FROM posts WHERE id = ? AND board = ?
           UNION ALL
           SELECT p.* FROM posts p JOIN t ON p.parent_id = t.id
         ) SELECT * FROM t ORDER BY id ASC`,
      )
      .all(rootId, board) as Post[];
  } else if (opts.before_id !== undefined) {
    posts = (
      db
        .prepare(`SELECT * FROM posts WHERE board = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(board, opts.before_id, limit) as Post[]
    ).reverse();
  } else {
    const sub = db
      .prepare(`SELECT cursor FROM subscriptions WHERE board = ? AND handle = ?`)
      .get(board, handle) as { cursor: number } | undefined;
    posts = sub
      ? (db
          .prepare(
            `SELECT * FROM posts p WHERE board = ? AND id > ? AND author != ? AND ${NOT_PUSHED_YET}
              ORDER BY id ASC LIMIT ?`,
          )
          .all(board, sub.cursor, handle, handle, limit) as Post[])
      : [];
    if (posts.length === 0) {
      posts = (
        db
          .prepare(`SELECT * FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`)
          .all(board, opts.limit === undefined ? 10 : limit) as Post[]
      ).reverse();
    }
  }

  const maxId = posts.reduce((m, p) => Math.max(m, p.id), 0);
  if (maxId > 0) {
    db.prepare(
      `UPDATE subscriptions SET cursor = MAX(cursor, ?) WHERE board = ? AND handle = ?`,
    ).run(maxId, board, handle);
    // Anything you've now read no longer needs pushing.
    db.prepare(
      `UPDATE outbox SET delivered_at = ? WHERE handle = ? AND delivered_at IS NULL
         AND post_id IN (SELECT id FROM posts WHERE board = ? AND id <= ?)`,
    ).run(Date.now(), handle, board, maxId);
  }

  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts p JOIN subscriptions s
         ON s.board = p.board AND s.handle = ?
        WHERE p.board = ? AND p.id > s.cursor AND p.author != ? AND ${NOT_PUSHED_YET}`,
    )
    .get(handle, board, handle, handle) as { n: number };

  return { board, posts, unread_remaining: remaining.n };
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
  const pushes = db
    .prepare(
      `SELECT o.reason, o.wake, p.* FROM outbox o JOIN posts p ON p.id = o.post_id
        WHERE o.handle = ? AND o.delivered_at IS NULL ORDER BY p.id ASC`,
    )
    .all(handle) as (Post & { reason: "mention" | "thread" | "subscription"; wake: number })[];
  for (const { reason, wake, ...p } of pushes) {
    if (visible(p.board)) out.push(wake ? { kind: "push", reason, post: p } : { kind: "push", reason, post: p, deferred: true });
    else acknowledge(db, handle, { kind: "push", post_id: p.id });
  }
  if (!opts.all && !out.some((i) => i.kind === "push" && !i.deferred)) return [];

  // Digest: unread exists and nothing has been sent since the last catch-up.
  const digests = db
    .prepare(
      `SELECT s.board, s.cursor,
              (SELECT COUNT(*) FROM posts p WHERE p.board = s.board AND p.id > s.cursor
                 AND p.author != ? AND ${NOT_PUSHED}) AS unread,
              (SELECT MAX(id) FROM posts p WHERE p.board = s.board AND p.author != ? AND ${NOT_PUSHED}) AS latest_id
         FROM subscriptions s
        WHERE s.handle = ? AND s.mode = 'digest' AND s.notified_id <= s.cursor`,
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

// Operator retention, not an agent operation. Replies outlive their pruned
// parents as thread roots.
export function prunePosts(db: Database, olderThanMs: number): void {
  db.transaction(() => {
    const old = `SELECT id FROM posts WHERE created_at < ?`;
    db.prepare(`UPDATE posts SET parent_id = NULL WHERE parent_id IN (${old})`).run(olderThanMs);
    db.prepare(`DELETE FROM outbox WHERE post_id IN (${old})`).run(olderThanMs);
    db.prepare(`DELETE FROM thread_mutes WHERE root_id IN (${old})`).run(olderThanMs);
    db.prepare(`DELETE FROM posts WHERE created_at < ?`).run(olderThanMs);
    db.prepare(`DELETE FROM claim_events WHERE at < ?`).run(olderThanMs);
    // Expired claims are left to sweepExpired, which announces them.
  })();
}
