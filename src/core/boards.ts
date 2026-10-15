import type { Database } from "bun:sqlite";

export const BOARD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_BODY_BYTES = 64 * 1024;
const MENTION_RE = /(?:^|[^\w@])@([a-z0-9_-]{1,32})\b/gi;

export type SubMode = "push" | "digest" | "quiet";

export type Board = { name: string; purpose: string; created_by: string; created_at: number };
export type Post = {
  id: number;
  board: string;
  author: string;
  body: string;
  parent_id: number | null;
  created_at: number;
};

export type Pending =
  | { kind: "push"; reason: "mention" | "thread" | "subscription"; post: Post }
  | { kind: "digest"; board: string; unread: number; latest: Post };

export class CoreError extends Error {}

// Accepts "#name" or "name".
export function normalizeBoard(input: string): string {
  const name = input.replace(/^#/, "").toLowerCase();
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

export function createBoard(db: Database, handle: string, name: string, purpose: string): Board {
  const board = normalizeBoard(name);
  if (!purpose.trim()) throw new CoreError("purpose is required");
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO boards (name, purpose, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(board, purpose.trim(), handle, now);
  if (res.changes === 0) throw new CoreError(`board #${board} already exists`);
  subscribe(db, handle, board, "push");
  return getBoard(db, board)!;
}

export function getBoard(db: Database, name: string): Board | undefined {
  return db.prepare(`SELECT * FROM boards WHERE name = ?`).get(name) as Board | undefined;
}

function requireBoard(db: Database, input: string): string {
  const name = normalizeBoard(input);
  if (!getBoard(db, name)) throw new CoreError(`no such board #${name}; see board_list`);
  return name;
}

function tipOf(db: Database, board: string): number {
  const row = db.prepare(`SELECT MAX(id) AS tip FROM posts WHERE board = ?`).get(board) as {
    tip: number | null;
  };
  return row.tip ?? 0;
}

export type BoardSummary = Board & { mode: SubMode | null; unread: number; posts: number };

export function listBoards(db: Database, handle: string): BoardSummary[] {
  return db
    .prepare(
      `SELECT b.*, s.mode AS mode,
              (SELECT COUNT(*) FROM posts p WHERE p.board = b.name) AS posts,
              CASE WHEN s.handle IS NULL THEN 0 ELSE
                (SELECT COUNT(*) FROM posts p
                  WHERE p.board = b.name AND p.id > s.cursor AND p.author != ?) END AS unread
         FROM boards b
         LEFT JOIN subscriptions s ON s.board = b.name AND s.handle = ?
        ORDER BY b.name`,
    )
    .all(handle, handle) as BoardSummary[];
}

// mode "off" unsubscribes. New subscriptions start at the tip: no backlog.
export function subscribe(db: Database, handle: string, boardInput: string, mode: SubMode | "off"): void {
  const board = requireBoard(db, boardInput);
  if (mode === "off") {
    db.prepare(`DELETE FROM subscriptions WHERE board = ? AND handle = ?`).run(board, handle);
    return;
  }
  const tip = tipOf(db, board);
  db.prepare(
    `INSERT INTO subscriptions (board, handle, mode, cursor, notified_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(board, handle) DO UPDATE SET mode = excluded.mode`,
  ).run(board, handle, mode, tip, tip);
}

export function mentionsIn(db: Database, body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) names.add(m[1]!.toLowerCase());
  if (names.size === 0) return [];
  const known = db
    .prepare(`SELECT name FROM handles WHERE name IN (${[...names].map(() => "?").join(",")})`)
    .all(...names) as { name: string }[];
  return known.map((r) => r.name);
}

// Inserts the post and queues pushes. Returns every handle that should be
// woken (outbox targets plus digest subscribers); delivery is the caller's job.
export function post(
  db: Database,
  handle: string,
  boardInput: string,
  body: string,
  parentId: number | null = null,
): { post: Post; wake: string[] } {
  const board = requireBoard(db, boardInput);
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new CoreError(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (parentId !== null) {
    const parent = getPost(db, parentId);
    if (!parent || parent.board !== board) {
      throw new CoreError(`parent_id ${parentId} is not a post on #${board}`);
    }
  }

  return db.transaction(() => {
    const p = db
      .prepare(
        `INSERT INTO posts (board, author, body, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(board, handle, body, parentId, Date.now()) as Post;

    // Highest-priority reason wins per handle: mention > thread > subscription.
    const targets = new Map<string, "mention" | "thread" | "subscription">();
    const subs = db
      .prepare(`SELECT handle, mode FROM subscriptions WHERE board = ?`)
      .all(board) as { handle: string; mode: SubMode }[];
    for (const s of subs) if (s.mode === "push") targets.set(s.handle, "subscription");
    if (parentId !== null) {
      for (const author of threadAuthors(db, parentId)) targets.set(author, "thread");
    }
    for (const m of mentionsIn(db, body)) targets.set(m, "mention");
    targets.delete(handle);

    const ins = db.prepare(
      `INSERT INTO outbox (handle, post_id, reason) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const [h, reason] of targets) ins.run(h, p.id, reason);

    const wake = new Set(targets.keys());
    for (const s of subs) if (s.mode === "digest" && s.handle !== handle) wake.add(s.handle);

    return { post: p, wake: [...wake] };
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

export function getPost(db: Database, id: number): Post | undefined {
  return db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as Post | undefined;
}

export type ReadResult = { board: string; posts: Post[]; unread_remaining: number };

// Default: your unread posts (oldest first); if none, the latest `limit`.
// With before_id: page back through history. With thread: the whole thread.
// Advances your cursor to the newest post returned.
export function read(
  db: Database,
  handle: string,
  boardInput: string,
  opts: { limit?: number; before_id?: number; thread?: number } = {},
): ReadResult {
  const board = requireBoard(db, boardInput);
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
            `SELECT * FROM posts WHERE board = ? AND id > ? AND author != ? ORDER BY id ASC LIMIT ?`,
          )
          .all(board, sub.cursor, handle, limit) as Post[])
      : [];
    if (posts.length === 0) {
      posts = (
        db
          .prepare(`SELECT * FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`)
          .all(board, limit) as Post[]
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
        WHERE p.board = ? AND p.id > s.cursor AND p.author != ?`,
    )
    .get(handle, board, handle) as { n: number };

  return { board, posts, unread_remaining: remaining.n };
}

// Everything this handle should be told about now. Call markDelivered for
// each item after it's actually handed to the agent (at-least-once).
export function pendingFor(db: Database, handle: string): Pending[] {
  const out: Pending[] = [];
  const pushes = db
    .prepare(
      `SELECT o.reason, p.* FROM outbox o JOIN posts p ON p.id = o.post_id
        WHERE o.handle = ? AND o.delivered_at IS NULL ORDER BY p.id ASC`,
    )
    .all(handle) as (Post & { reason: "mention" | "thread" | "subscription" })[];
  for (const { reason, ...p } of pushes) out.push({ kind: "push", reason, post: p });

  // Digest: unread exists and nothing has been sent since the last catch-up.
  const digests = db
    .prepare(
      `SELECT s.board, s.cursor,
              (SELECT COUNT(*) FROM posts p WHERE p.board = s.board AND p.id > s.cursor AND p.author != ?) AS unread,
              (SELECT MAX(id) FROM posts p WHERE p.board = s.board AND p.author != ?) AS latest_id
         FROM subscriptions s
        WHERE s.handle = ? AND s.mode = 'digest' AND s.notified_id <= s.cursor`,
    )
    .all(handle, handle, handle) as { board: string; unread: number; latest_id: number | null }[];
  for (const d of digests) {
    if (d.unread > 0 && d.latest_id !== null) {
      out.push({ kind: "digest", board: d.board, unread: d.unread, latest: getPost(db, d.latest_id)! });
    }
  }
  return out;
}

export function markDelivered(db: Database, handle: string, item: Pending): void {
  if (item.kind === "push") {
    db.prepare(`UPDATE outbox SET delivered_at = ? WHERE handle = ? AND post_id = ?`).run(
      Date.now(),
      handle,
      item.post.id,
    );
    // Push-mode subscribers have now seen it in full: count it as read.
    if (item.reason === "subscription") {
      db.prepare(
        `UPDATE subscriptions SET cursor = MAX(cursor, ?), notified_id = MAX(notified_id, ?)
          WHERE board = ? AND handle = ? AND mode = 'push'`,
      ).run(item.post.id, item.post.id, item.post.board, handle);
    }
  } else {
    db.prepare(
      `UPDATE subscriptions SET notified_id = MAX(notified_id, ?) WHERE board = ? AND handle = ?`,
    ).run(item.latest.id, item.board, handle);
  }
}
