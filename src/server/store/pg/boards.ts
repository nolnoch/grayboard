// The boards store on Postgres (#807 P3 C10e1, docs/future/postgres-server.md D3, D6): store/boards.ts's BoardsStore,
// each method on its caller's handle through pgOf (C10e1 the reads and pure writes, C10e2 the designed writes). The
// SQLite store (db.ts makeRepo's boards, over core/boards.ts's SQL) is the reference; what differs, and why:
// - Under READ COMMITTED each statement sees a new snapshot, and one that waits on a row lock re-checks only that
//   row. So a write that depends on a row other writers change reads it under a lock first (#807 P3 C10 §2):
//   - insertPost locks a reply's parent FOR KEY SHARE by id before it writes and refuses MissingPost when it's gone
//     (P1): a prune holding it FOR UPDATE makes the reply wait and then find nothing, so a caller that catches the
//     refusal and commits commits nothing. A 23503 on posts_parent_id_fkey maps to MissingPost too, as a backstop,
//     though by then the transaction is aborted.
//   - prunePosts locks its batch FOR UPDATE, by id, first (P1): a reply inserted under an old parent holds the
//     parent's KEY SHARE (its own lock or its FK check's), so the prune waits, and its null-the-children UPDATE then
//     sees the reply. ORDER BY id is the lock order against another prune.
//   - board_post's gate reads its board through lockForPost, FOR KEY SHARE, and setArchived locks the board FOR UPDATE
//     before its conditional UPDATE (P5): an archive waits for a post that passed the gate, and a post whose gate
//     waits on an archive reads the board archived. A plain UPDATE of archived_at takes only FOR NO KEY UPDATE, which
//     doesn't conflict with KEY SHARE (probe D5); two posts' KEY SHAREs don't conflict either (probe D6).
//   - claimQueuePost locks its post FOR KEY SHARE first and returns false when it's gone, then claims,
//     `ON CONFLICT (key) DO NOTHING RETURNING` (P3/P4): a second redelivery waits on the first's uncommitted claim and
//     gets no row, so it logs no take; its push, a later statement, sees the winner's committed row and reaches only
//     the key's holder. The post lock keeps a sweep's order posts, then outbox, as a prune's is: a push reset (an
//     outbox UPDATE, no FK check) would otherwise hold the row a prune's outbox delete waits on while the sweep's next
//     post write waits on the prune's batch, a deadlock (c10e2 audit 1).
//   - Lock order across tables: posts, then outbox, then claim_events (a delivered queue push's take, #1461), then
//     subscriptions. forget, read and acknowledge each write a
//     handle's outbox rows before its subscriptions, so a handle's forget racing its read waits rather than deadlocks
//     (c10e2 audit 2); prunePosts locks posts first and touches no subscription.
//   - acknowledge's and read's GREATEST is re-evaluated on the newest row version after the row lock, so a cursor or
//     notified_id never moves back; setSubscription reads the tip in its insert's statement (a post committing beside
//     it lands either side of the cursor, as on SQLite); bindAttachments locks its uploads first (attachment_rows.ts);
//     forget is five deletes keyed by the handle, none read first.
//   Accepted (PS D4): two posts picking the same lane, a subscribe's tip missing an uncommitted post, and ids that
//   commit out of order behind a reader's cursor; the one write queue rules them out until Stage 4 (#808).
// - A Read is the autocommit pool: each statement is its own snapshot. So a read whose parts must agree is one
//   statement (§7 Q10): pendingDigests joins each digest's latest post where core reads it after with getPost(...)!,
//   which a prune committing between the two would turn into a crash; threadFacts reads root, authors, the parent's
//   and root's authors and the mutes in one recursive statement; threadRoot is one WITH RECURSIVE walk, not a loop.
//   redeliveryFacts reads in three statements where core runs 5+2N; the skew left between them is benign (a take or
//   hold committing mid-read changes only who the redelivery skips).
// - json_each(?) is `= ANY`/`<> ALL($n::text[])`; the two-argument scalar MAX is GREATEST; integer booleans are
//   booleans (outbox.wake, aliases.human/queue_off, ids.launcher), mapped back to the 1/0/null the roster's types say;
//   an untyped parameter in a select list or an `IS NULL` test is cast (`$n::text`, D6). int8 columns and counts go
//   through the mappers.
// - laneRows is core's queueLaneRowsSql rewritten: `+e.key GLOB 'queue:*'` (SQLite's planner pin and glob) is
//   `e.key LIKE 'queue:%'` (the column is COLLATE "C", so this is a byte prefix), and `CROSS JOIN posts p2 ON …`
//   (SQLite's join-order pin, a syntax error here) is a plain JOIN; laneRowsStatement is exported for its plan test,
//   which asserts the take subquery still uses idx_claim_events_take.
// - views is one statement over the handles (unnest WITH ORDINALITY keeps their order) where core runs one per
//   handle; insertOutbox is one unnest insert where core runs one per target.
// - Every text column is COLLATE "C" (0001), so name and handle order is byte order, as SQLite's BINARY; each ORDER BY
//   that SQLite runs in byte order says COLLATE "C" anyway, so the order doesn't hang on a column's declaration.
// - ensure, read and acknowledge stamp the store's clock where core reads Date.now().
// - prunePosts' nested immediate transaction (SQLite's) is the caller's body here.
//
// Runtime imports stay off bun:sqlite, db.ts, core/boards.ts and core/attachments.ts (pg/isolation.test.ts): the SQL
// is restated, and so are normalizeBoard and the catalog page size (pinned to core's by the contract runner).
import { CoreError } from "../../../core/errors.ts";
import type { Post } from "../../../shared/notifications.ts";
import { testPauseAsync } from "../../../shared/testpause.ts";
import type { Board, BoardSummary, BoardsStore, DigestRow, PushRow, SubMode, ThreadFacts, WhoRow } from "../boards.ts";
import { MissingPost } from "../errors.ts";
import type { Read } from "../tx_base.ts";
import { bindLocked, dropAttachments, lockUnsent, withAttachments } from "./attachment_rows.ts";
import { foreignKeyViolation } from "./errors.ts";
import { int8, int8OrNull } from "./sql.ts";
import { insertClaimEvent } from "./claims.ts";
import { pgOf, type PgFragment, type PgSql } from "./tx.ts";

type Row = Record<string, unknown>;

// core BOARD_NAME_RE, normalizeBoard and CATALOG_PAGE, restated.
export const BOARD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export function normalizeBoard(input: string): string {
  const name = String(input).replace(/^#/, "").toLowerCase();
  if (!BOARD_NAME_RE.test(name)) throw new CoreError(`invalid board name "${input}": use [a-z0-9_-], 1-32 chars`);
  return name;
}
export const CATALOG_PAGE = 100;

// ── rows ──
const boardCols = (sql: PgSql) => sql.fragment`b.name, b.purpose, b.scope, b.created_by, b.created_at, b.kind, b.archived_at, b.archived_by`;
// core showBoard: an open board carries no archive keys.
const toBoard = (r: Row): Board => {
  const b: Board = {
    name: r.name as string, purpose: r.purpose as string, scope: r.scope as string | null, created_by: r.created_by as string,
    created_at: int8(r.created_at), kind: r.kind as string,
  };
  if (r.archived_at !== null && r.archived_at !== undefined) {
    b.archived_at = int8(r.archived_at);
    b.archived_by = r.archived_by as string;
  }
  return b;
};
const toSummary = (r: Row): BoardSummary => ({ ...toBoard(r), posts: int8(r.posts), mode: r.mode as SubMode | null, unread: int8(r.unread) });

// core POST_COLS / P_POST_COLS.
const postCols = (sql: PgSql) => sql.fragment`p.id, p.board, p.author, p.via, p.body, p.parent_id, p.created_at, p.expires_at`;
// core showPost: via only when a child wrote it.
const toPost = (r: Row, prefix = ""): Post => {
  const p: Post = {
    id: int8(r[`${prefix}id`]), board: r[`${prefix}board`] as string, author: r[`${prefix}author`] as string, body: r[`${prefix}body`] as string,
    parent_id: int8OrNull(r[`${prefix}parent_id`]), created_at: int8(r[`${prefix}created_at`]), expires_at: int8OrNull(r[`${prefix}expires_at`]),
  };
  const via = r[`${prefix}via`];
  return via === null || via === undefined ? p : { ...p, via: via as string };
};
// A boolean column as the roster's integer types read it (SQLite stores 1/0/NULL).
const flag = (v: unknown): number | null => (v === null || v === undefined ? null : v === true ? 1 : 0);

// ── core's shared fragments, over a handle expression (a parameter, or a column in views) ──
// NOT_OWN: not written by the reader's session, as its address, its session (or the session holding it) or a child
// of that session.
const notOwn = (sql: PgSql, h: PgFragment) => sql.fragment`NOT (p.author = ${h} OR p.author_id IS NOT NULL
  AND COALESCE((SELECT ah.id FROM alias_holds ah WHERE ah.address = ${h}), ${h})
    IN (p.author_id, COALESCE((SELECT ri.root_id FROM ids ri WHERE ri.id = p.author_id), p.author_id)))`;
// NOT_PUSHED: no outbox row for the reader (digests). NOT_PUSHED_YET: none that woke or was delivered (views' counts).
const notPushed = (sql: PgSql, h: PgFragment) => sql.fragment`NOT EXISTS (SELECT 1 FROM outbox o WHERE o.handle = ${h} AND o.post_id = p.id)`;
const notPushedYet = (sql: PgSql, h: PgFragment) => sql.fragment`NOT EXISTS (SELECT 1 FROM outbox o WHERE o.handle = ${h} AND o.post_id = p.id
  AND (o.wake OR o.delivered_at IS NOT NULL))`;
const param = (sql: PgSql, v: string) => sql.fragment`${v}::text`;
// core laneSessionSql: the session holding `h`, or `h` itself.
const laneSession = (sql: PgSql, h: PgFragment) => sql.fragment`COALESCE((SELECT ls.id FROM alias_holds ls WHERE ls.address = ${h}), ${h})`;
// core laneAddressesSql: `lane`'s session's ID and every alias it holds, as a one-column subquery.
const laneAddresses = (sql: PgSql, lane: PgFragment) =>
  sql.fragment`(SELECT ${laneSession(sql, lane)} AS address UNION ALL SELECT la.address FROM alias_holds la WHERE la.id = ${laneSession(sql, lane)})`;
// core liveSessionSql (#1351): `sid` names a live session, so a claim_events or outbox (#1370) row with it is session-keyed.
const liveSession = (sql: PgSql, sid: PgFragment) => sql.fragment`EXISTS (SELECT 1 FROM ids x WHERE x.id = ${sid} AND x.ended_at IS NULL)`;
// core holdingSessionSql (#1351, #1370): the session holding `h` as a row is written, the alias's holder, else `h` when
// it is a session ID, else NULL.
const holdingSession = (sql: PgSql, h: PgFragment) =>
  sql.fragment`COALESCE((SELECT hs.id FROM alias_holds hs WHERE hs.address = ${h}), (SELECT hi.id FROM ids hi WHERE hi.id = ${h}))`;
// The session a delivery to `handle` credits (#1461, #1466): `receiver` when the caller names it, else `handle`'s holder.
const credited = (sql: PgSql, handle: string, receiver?: string) =>
  receiver === undefined ? holdingSession(sql, sql.fragment`${handle}::text`) : sql.fragment`${receiver}::text`;
// core heldBy (#1466), in the statement that marks: `handle` is `receiver`'s ID or an alias it holds; TRUE with none.
// Judged in that statement's snapshot, so a hold that moved in a transaction committed before it is seen.
const heldBy = (sql: PgSql, handle: string, receiver?: string) => receiver === undefined ? sql.fragment`TRUE`
  : sql.fragment`(${handle}::text = ${receiver}::text OR EXISTS (SELECT 1 FROM alias_holds hb WHERE hb.address = ${handle}::text AND hb.id = ${receiver}::text))`;
// core creditQueueTakes (#1461): each post's newest take under `handle` re-records the session credited (`receiver`,
// else the one holding `handle` now), while the post's claim still names `handle`.
async function creditQueueTakes(sql: PgSql, handle: string, board: string, postIds: number[], receiver?: string): Promise<void> {
  await sql`UPDATE claim_events SET session_id = ${credited(sql, handle, receiver)}
    WHERE id IN (SELECT MAX(ce.id) FROM claim_events ce WHERE ce.key = ANY(${postIds.map(id => `queue:${board}:${id}`)}::text[])
      AND ce.handle = ${handle} AND ce.event = 'take'
      AND EXISTS (SELECT 1 FROM claims c WHERE c.key = ce.key AND c.holder = ${handle}) GROUP BY ce.key)`;
}
// core primaryHoldSql: session `id`'s oldest hold (HOLD_ORDER), or NULL.
const primaryHold = (sql: PgSql, id: PgFragment) =>
  sql.fragment`(SELECT ph.address FROM alias_holds ph WHERE ph.id = ${id} ORDER BY ph.bound_at, ph.address COLLATE "C" LIMIT 1)`;
// core ALIAS_SESSION_SQL over the aliases row `a`: its holder, or the ended session that last bound it.
const aliasSession = (sql: PgSql) => sql.fragment`COALESCE(
  (SELECT sh.id FROM alias_holds sh WHERE sh.address = a.address),
  (SELECT l.session_id FROM (SELECT be.session_id FROM binding_events be WHERE be.name = a.address AND be.event IN ('bound', 'moved')
     ORDER BY be.id DESC LIMIT 1) l JOIN ids e ON e.id = l.session_id WHERE e.ended_at IS NOT NULL))`;

// queueLaneRows' statement ($board, $poster), exported for its plan test (#1174 audit H1: it runs inside every queue
// post's and requeue's write transaction). A lane's takes are two subqueries, as core's (#1351): `es`, its session's
// session-keyed takes, and `e`, the address-keyed takes under its addresses now; its pushes the same (#1370): `os`, its
// session's session-keyed outbox rows, and `o2`, the address-keyed ones. No planner pins: Postgres picks
// idx_claim_events_take_sid (board, session_id, at), idx_claim_events_take (board, handle, at) and idx_outbox_session
// (session_id, post_id) on its own; the plan test asserts it does.
export function laneRowsStatement(sql: PgSql, board: string, poster: string[]): PgFragment {
  const lane = sql.fragment`l.lane`;
  return sql.fragment`WITH lanes AS (
      SELECT COALESCE(${primaryHold(sql, sql.fragment`s.handle`)}, s.handle) AS lane FROM subscriptions s
      WHERE s.board = ${board} AND s.mode = 'push')
    SELECT l.lane AS handle FROM lanes l LEFT JOIN aliases h ON h.address = l.lane
    LEFT JOIN ids i ON i.id = l.lane
    WHERE l.lane <> ALL(${poster}::text[])
      AND (h.address IS NOT NULL AND h.queue_off IS NULL OR i.id IS NOT NULL AND i.ended_at IS NULL)
      AND h.human IS NOT TRUE
    GROUP BY l.lane
    ORDER BY NULLIF(GREATEST(
        COALESCE((SELECT MAX(es.at) FROM claim_events es
                  WHERE es.board = ${board} AND es.session_id = ${laneSession(sql, lane)} AND es.event = 'take' AND es.key LIKE 'queue:%'
                    AND ${liveSession(sql, sql.fragment`es.session_id`)}), 0),
        COALESCE((SELECT MAX(e.at) FROM claim_events e
                  WHERE e.board = ${board} AND e.handle IN ${laneAddresses(sql, lane)} AND e.event = 'take' AND e.key LIKE 'queue:%'
                    AND NOT ${liveSession(sql, sql.fragment`e.session_id`)}), 0),
        COALESCE((SELECT MAX(ps.created_at) FROM outbox os JOIN posts ps ON ps.id = os.post_id
                  WHERE os.session_id = ${laneSession(sql, lane)} AND ps.board = ${board}
                    AND ${liveSession(sql, sql.fragment`os.session_id`)}), 0),
        COALESCE((SELECT MAX(p2.created_at) FROM outbox o2 JOIN posts p2 ON p2.id = o2.post_id
                  WHERE o2.handle IN ${laneAddresses(sql, lane)} AND p2.board = ${board}
                    AND NOT ${liveSession(sql, sql.fragment`o2.session_id`)}), 0)), 0) ASC NULLS FIRST,
      l.lane COLLATE "C" ASC`;
}

// The thread walk up from `id` (one row per level, depth 0 the post itself), shared by threadRoot and threadFacts.
// The root is the deepest row's parent, or the row itself when it has none: core threadRoot's loop, which stops at a
// missing post or a root.
const upFrom = (sql: PgSql, id: number) => sql.fragment`up(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM posts WHERE id = ${id}
    UNION ALL
    SELECT p.id, p.parent_id, up.depth + 1 FROM posts p JOIN up ON p.id = up.parent_id)`;
const rootOfUp = (sql: PgSql) => sql.fragment`SELECT COALESCE(parent_id, id) AS id FROM up ORDER BY depth DESC LIMIT 1`;

// A post's parent_id foreign key: insertPost's MissingPost.
const POST_PARENT_CONSTRAINT = "posts_parent_id_fkey";
const SUB_MODES: readonly string[] = ["push", "digest", "quiet"];

// core QUEUE_CLAIM_TTL_MS, restated.
const QUEUE_CLAIM_TTL_MS = 30 * 60_000;

// core authorAddresses' UNION (a set; its order is the database's).
async function authorAddresses(r: Read, author: string, authorId: string | null): Promise<string[]> {
  const rows: Row[] = await pgOf(r)`SELECT ${author}::text AS a
    UNION SELECT ${authorId}::text WHERE ${authorId}::text IS NOT NULL
    UNION SELECT h.address FROM alias_holds h WHERE h.id = ${authorId}::text
    UNION SELECT i.root_id FROM ids i WHERE i.id = ${authorId}::text AND i.root_id IS NOT NULL
    UNION SELECT h.address FROM ids i JOIN alias_holds h ON h.id = i.root_id WHERE i.id = ${authorId}::text`;
  return rows.map(x => x.a as string);
}

export function makePgBoards({ clock }: { clock: () => number }): BoardsStore {
  return {
    async get(r, name) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${boardCols(sql)} FROM boards b WHERE b.name = ${name}`;
      return row ? toBoard(row) : undefined;
    },
    // board_post's gate read (header, P5): the board as get reads it, FOR KEY SHARE until the body ends.
    async lockForPost(tx, name) {
      const sql = pgOf(tx);
      const [row] = await sql`SELECT ${boardCols(sql)} FROM boards b WHERE b.name = ${name} FOR KEY SHARE`;
      return row ? toBoard(row) : undefined;
    },
    async post(r, id) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.id = ${id}`;
      return row ? toPost(row) : undefined;
    },
    async catalogPage(r, cursor) {
      const sql = pgOf(r);
      return (await sql`SELECT ${boardCols(sql)} FROM boards b WHERE b.name > ${cursor} ORDER BY b.name COLLATE "C" LIMIT ${CATALOG_PAGE}`).map(toBoard);
    },
    async snapshotPage(r, board, opts) {
      const limit = opts.limit === undefined ? 20 : opts.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError("snapshot limit must be an integer from 1 to 100");
      if (opts.before_id !== undefined && (!Number.isSafeInteger(opts.before_id) || opts.before_id < 1)) {
        throw new CoreError("snapshot before_id must be a positive safe integer");
      }
      const sql = pgOf(r);
      const rows: Row[] = opts.before_id === undefined
        ? await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.board = ${board} ORDER BY p.id DESC LIMIT ${limit + 1}`
        : await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.board = ${board} AND p.id < ${opts.before_id} ORDER BY p.id DESC LIMIT ${limit + 1}`;
      const more = rows.length > limit;
      const posts = rows.slice(0, limit).reverse().map(r => toPost(r));
      return { posts: await withAttachments(sql, "post", posts), next_before_id: more ? posts[0]!.id : null };
    },
    async pendingPushes(r, handle) {
      const sql = pgOf(r);
      const rows: Row[] = await sql`SELECT o.reason, o.wake, ${postCols(sql)} FROM outbox o JOIN posts p ON p.id = o.post_id
        WHERE o.handle = ${handle} AND o.delivered_at IS NULL ORDER BY p.id ASC`;
      const posts = await withAttachments(sql, "post", rows.map(x => toPost(x)));
      return posts.map((post, n): PushRow => ({ reason: rows[n]!.reason as PushRow["reason"], wake: rows[n]!.wake === true, post }));
    },
    // core DIGEST_SQL with the latest post joined in, so a digest and its post come from one snapshot.
    async pendingDigests(r, handle) {
      const sql = pgOf(r);
      const h = param(sql, handle);
      const rows: Row[] = await sql`SELECT d.board AS digest_board, d.unread, ${postCols(sql)} FROM (
          SELECT s.board,
                 (SELECT COUNT(*) FROM posts p WHERE p.board = s.board AND p.id > s.cursor
                    AND ${notOwn(sql, h)} AND ${notPushed(sql, h)}) AS unread,
                 (SELECT p.id FROM posts p WHERE p.board = s.board AND p.id > s.cursor AND ${notOwn(sql, h)} AND ${notPushed(sql, h)}
                   ORDER BY p.id DESC LIMIT 1) AS latest_id
            FROM subscriptions s
           WHERE s.handle = ${h} AND s.mode = 'digest' AND s.notified_id <= s.cursor
             AND s.board NOT IN (SELECT name FROM boards WHERE kind = 'queue')) d
        JOIN posts p ON p.id = d.latest_id
        WHERE d.unread > 0`;
      return rows.map((x): DigestRow => ({ board: x.digest_board as string, unread: int8(x.unread), latest: toPost(x) }));
    },
    // Core acknowledge; each GREATEST re-evaluates after the row lock (header).
    async acknowledge(tx, handle, ref, receiver) {
      const sql = pgOf(tx);
      // core: with `receiver`, only while `handle` is still its address (#1466). Each marking statement carries the
      // check in its WHERE, so it is judged with the mark, not by a read before it.
      const held = heldBy(sql, handle, receiver);
      if (ref.kind === "digest") {
        await sql`UPDATE subscriptions SET notified_id = GREATEST(notified_id, ${ref.latest_id}::int8) WHERE board = ${ref.board} AND handle = ${handle} AND ${held}`;
        return;
      }
      const [row] = await sql`SELECT o.reason, p.board, b.kind FROM outbox o JOIN posts p ON p.id = o.post_id
        JOIN boards b ON b.name = p.board WHERE o.handle = ${handle} AND o.post_id = ${ref.post_id}`;
      if (!row) return;
      // core: credited to `receiver`, else the session holding `handle` now, on its first delivery (#1461). The update
      // itself decides "first": its WHERE is re-checked on the newest row version after the row lock, so of two
      // concurrent acks only one matches (the SELECT above is unlocked and would let both credit). The repeat stamp
      // touches only a row already delivered, so a hold that moves back between the two never marks without crediting.
      const now = clock();
      const first: Row[] = await sql`UPDATE outbox SET delivered_at = ${now}, session_id = ${credited(sql, handle, receiver)}
        WHERE handle = ${handle} AND post_id = ${ref.post_id} AND delivered_at IS NULL AND ${held} RETURNING post_id`;
      if (first.length === 0) {
        // A test forces a hold moving back here (#1472): the repeat's `delivered_at IS NOT NULL` then keeps it unmarked.
        await testPauseAsync("boards:acknowledge:repeat");
        const again: Row[] = await sql`UPDATE outbox SET delivered_at = ${now}
          WHERE handle = ${handle} AND post_id = ${ref.post_id} AND delivered_at IS NOT NULL AND ${held} RETURNING post_id`;
        if (again.length === 0 && receiver !== undefined) return;
      } else if (row.kind === "queue") await creditQueueTakes(sql, handle, row.board as string, [ref.post_id], receiver);
      // Push-mode subscribers have now seen it in full: count it as read.
      if (row.reason === "subscription") {
        await sql`UPDATE subscriptions SET cursor = GREATEST(cursor, ${ref.post_id}::int8), notified_id = GREATEST(notified_id, ${ref.post_id}::int8)
          WHERE board = ${row.board as string} AND handle = ${handle} AND mode = 'push' AND ${held}`;
      }
    },

    async ensure(tx, name, purpose, scope, createdBy) {
      const board = normalizeBoard(name);
      const made: Row[] = await pgOf(tx)`INSERT INTO boards (name, purpose, scope, created_by, created_at)
        VALUES (${board}, ${purpose}, ${scope}::text, ${createdBy}, ${clock()}) ON CONFLICT (name) DO NOTHING RETURNING name`;
      return made.length > 0;
    },
    async isSubscribed(r, handle, board) {
      return (await pgOf(r)`SELECT 1 FROM subscriptions WHERE board = ${board} AND handle = ${handle}`).length > 0;
    },
    // Core setSubscription; the tip is read in the insert's own statement (header).
    async setSubscription(tx, handle, board, mode) {
      const sql = pgOf(tx);
      if (mode === "off") {
        await sql`DELETE FROM subscriptions WHERE board = ${board} AND handle = ${handle}`;
        return;
      }
      if (!SUB_MODES.includes(mode)) throw new CoreError(`mode must be push, digest, quiet, or off`);
      await sql`INSERT INTO subscriptions (board, handle, mode, cursor, notified_id)
        SELECT ${board}, ${handle}, ${mode}, t.tip, t.tip FROM (SELECT COALESCE(MAX(id), 0) AS tip FROM posts WHERE board = ${board}) t
        ON CONFLICT (board, handle) DO UPDATE SET mode = excluded.mode`;
    },
    async unsubscribeScope(tx, handle, scope) {
      await pgOf(tx)`DELETE FROM subscriptions WHERE handle = ${handle} AND board IN (SELECT name FROM boards WHERE scope = ${scope})`;
    },
    // core forgetHandle.
    async forget(tx, handle) {
      const sql = pgOf(tx);
      await sql`DELETE FROM outbox WHERE handle = ${handle}`;
      await sql`DELETE FROM subscriptions WHERE handle = ${handle}`;
      await sql`DELETE FROM thread_mutes WHERE handle = ${handle}`;
      await sql`DELETE FROM claim_watches WHERE handle = ${handle}`;
      await sql`DELETE FROM alias_holds WHERE address = ${handle}`;
    },
    // core prunePosts, its batch locked first (header, P1). Expired claims are left to the sweep, which announces them.
    async prunePosts(tx, olderThan) {
      const sql = pgOf(tx);
      await sql`SELECT count(*) FROM (SELECT id FROM posts WHERE created_at < ${olderThan} ORDER BY id FOR UPDATE) batch`;
      const boards: Row[] = await sql`SELECT board FROM posts WHERE created_at < ${olderThan} GROUP BY board ORDER BY board COLLATE "C"`;
      const old = () => sql.fragment`SELECT id FROM posts WHERE created_at < ${olderThan}`;
      await sql`UPDATE posts SET parent_id = NULL WHERE parent_id IN (${old()})`;
      await sql`DELETE FROM outbox WHERE post_id IN (${old()})`;
      await sql`DELETE FROM thread_mutes WHERE root_id IN (${old()})`;
      await dropAttachments(sql, "post", old());
      await sql`DELETE FROM posts WHERE created_at < ${olderThan}`;
      await sql`DELETE FROM claim_events WHERE at < ${olderThan}`;
      // Each name's latest bound or moved event outlives retention (core #211).
      await sql`DELETE FROM binding_events WHERE COALESCE(last_at, at) < ${olderThan} AND id NOT IN
        (SELECT MAX(id) FROM binding_events WHERE event IN ('bound', 'moved') GROUP BY name)`;
      return boards.map(b => b.board as string);
    },

    // core boardViewRows, one statement over the handles: their order (ordinality), then the board's name.
    async views(r, handles, board) {
      const sql = pgOf(r);
      if (handles.length === 0) return [];
      const h = sql.fragment`hs.handle`;
      const rows: Row[] = await sql`SELECT hs.handle AS view_handle, ${boardCols(sql)},
             (SELECT COUNT(*) FROM posts p WHERE p.board = b.name) AS posts, s.mode,
             CASE WHEN s.handle IS NULL THEN 0 ELSE
               (SELECT COUNT(*) FROM posts p
                 WHERE p.board = b.name AND p.id > s.cursor AND ${notOwn(sql, h)} AND ${notPushedYet(sql, h)}) END AS unread
        FROM unnest(${handles}::text[]) WITH ORDINALITY AS hs(handle, ord)
        CROSS JOIN boards b
        LEFT JOIN subscriptions s ON s.board = b.name AND s.handle = hs.handle
        WHERE ${board}::text IS NULL OR b.name = ${board}::text
        ORDER BY hs.ord, b.name COLLATE "C"`;
      return rows.map(x => ({ handle: x.view_handle as string, row: toSummary(x) }));
    },
    async openSummaries(r) {
      const sql = pgOf(r);
      return (await sql`SELECT ${boardCols(sql)}, (SELECT COUNT(*) FROM posts p WHERE p.board = b.name) AS posts, NULL::text AS mode, 0 AS unread
        FROM boards b WHERE b.archived_at IS NULL ORDER BY b.name COLLATE "C"`).map(toSummary);
    },
    // core whoRows.
    async roster(r, board) {
      const sql = pgOf(r);
      const held = sql.fragment`EXISTS (SELECT 1 FROM alias_holds hh WHERE hh.address = a.address AND hh.id = i.id)`;
      const facts = sql.fragment`i.id, i.principal, i.cwd, i.place, i.harness, i.model, i.effort, i.launcher,
        a.human, a.queue_off, a.scope_kind, a.scope_ref, a.task, a.owner, a.source_board, a.spec_hash, a.description`;
      const toWho = (x: Row): WhoRow => ({
        handle: x.handle as string, last_seen: int8OrNull(x.last_seen), ...(board === null ? {} : { mode: x.mode as SubMode }),
        id: x.id as string | null, principal: x.principal as string | null, cwd: x.cwd as string | null, place: x.place as string | null,
        status: x.status as string | null, status_at: int8OrNull(x.status_at), harness: x.harness as string | null, model: x.model as string | null,
        effort: x.effort as string | null, launcher: flag(x.launcher), human: flag(x.human), queue_off: flag(x.queue_off),
        scope_kind: x.scope_kind as WhoRow["scope_kind"], scope_ref: x.scope_ref as string | null, task: x.task as string | null,
        owner: x.owner as string | null, source_board: x.source_board as string | null, spec_hash: x.spec_hash as string | null,
        description: x.description as string | null,
      });
      if (board === null) {
        return (await sql`SELECT a.address AS handle, a.last_seen, ${facts},
            CASE WHEN ${held} THEN i.status END AS status, CASE WHEN ${held} THEN i.status_at END AS status_at FROM aliases a
          LEFT JOIN ids i ON i.id = ${aliasSession(sql)}
          WHERE a.last_seen IS NOT NULL ORDER BY a.address COLLATE "C"`).map(toWho);
      }
      // A subscription a session took as its ID is listed under its primary, or as the ID; a name's own wins.
      const subs: Row[] = await sql`SELECT m.handle, m.mode, m.own, COALESCE(a.last_seen, i.last_seen) AS last_seen, ${facts},
          CASE WHEN a.address IS NULL AND i.ended_at IS NULL OR ${held} THEN i.status END AS status,
          CASE WHEN a.address IS NULL AND i.ended_at IS NULL OR ${held} THEN i.status_at END AS status_at FROM (
          SELECT COALESCE(s.ph, s.handle) AS handle, s.mode, s.ph IS NULL AS own
            FROM (SELECT s0.handle, s0.mode, ${primaryHold(sql, sql.fragment`s0.handle`)} AS ph FROM subscriptions s0 WHERE s0.board = ${board}) s) m
        LEFT JOIN aliases a ON a.address = m.handle
        LEFT JOIN ids i ON i.id = COALESCE(${aliasSession(sql)}, m.handle)
        ORDER BY m.handle COLLATE "C", m.own DESC`;
      return subs.filter((x, n) => n === 0 || subs[n - 1]!.handle !== x.handle).map(toWho);
    },

    async create(tx, b) {
      const sql = pgOf(tx);
      const [row] = await sql`WITH made AS (INSERT INTO boards (name, purpose, scope, created_by, created_at, kind)
          VALUES (${b.name}, ${b.purpose}, ${b.scope}::text, ${b.createdBy}, ${b.now}, ${b.kind}) ON CONFLICT (name) DO NOTHING RETURNING *)
        SELECT ${boardCols(sql)} FROM made b`;
      return row ? toBoard(row) : null;
    },
    // The board locked FOR UPDATE first, so a post past its gate (lockForPost's KEY SHARE) makes this wait and a gate
    // after it waits and reads it archived (P5). The conditional write is the check (A1): a second archive waits on
    // the first's lock, then its UPDATE's WHERE re-reads the committed row and updates nothing.
    async setArchived(tx, name, by, now) {
      const sql = pgOf(tx);
      await sql`SELECT 1 FROM boards WHERE name = ${name} FOR UPDATE`;
      const state = by === null ? sql.fragment`b.archived_at IS NOT NULL` : sql.fragment`b.archived_at IS NULL`;
      const [row] = await sql`UPDATE boards b SET archived_at = ${by === null ? null : now}::int8, archived_by = ${by}::text
        WHERE b.name = ${name} AND ${state} RETURNING ${boardCols(sql)}`;
      return row ? toBoard(row) : null;
    },
    // Core readRows; the cursor's GREATEST re-evaluates after the row lock (header).
    async read(tx, board, handle, opts, receiver) {
      const sql = pgOf(tx);
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
      let posts: Post[];
      if (opts.thread !== undefined) {
        posts = (await sql`WITH RECURSIVE ${upFrom(sql, opts.thread)},
            t AS (SELECT ${postCols(sql)} FROM posts p WHERE p.id = (${rootOfUp(sql)}) AND p.board = ${board}
              UNION ALL SELECT ${postCols(sql)} FROM posts p JOIN t ON p.parent_id = t.id)
          SELECT * FROM t ORDER BY id ASC`).map((r: Row) => toPost(r));
      } else if (opts.before_id !== undefined) {
        posts = (await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.board = ${board} AND p.id < ${opts.before_id} ORDER BY p.id DESC LIMIT ${limit}`)
          .map((r: Row) => toPost(r)).reverse();
      } else {
        const [sub] = handle === null ? [] : await sql`SELECT cursor FROM subscriptions WHERE board = ${board} AND handle = ${handle}`;
        const h = handle === null ? null : param(sql, handle);
        posts = sub && h ? (await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.board = ${board} AND p.id > ${sub.cursor}
            AND ${notOwn(sql, h)} AND ${notPushedYet(sql, h)} ORDER BY p.id ASC LIMIT ${limit}`).map((r: Row) => toPost(r)) : [];
        if (posts.length === 0) {
          posts = (await sql`SELECT ${postCols(sql)} FROM posts p WHERE p.board = ${board} ORDER BY p.id DESC LIMIT ${opts.limit === undefined ? 10 : limit}`)
            .map((r: Row) => toPost(r)).reverse();
        }
      }
      if (handle === null) return { board, posts: await withAttachments(sql, "post", posts), unread_remaining: 0 };
      const h = param(sql, handle);
      const maxId = posts.reduce((m, p) => Math.max(m, p.id), 0);
      if (maxId > 0) {
        // What this read showed no longer needs pushing; what it skipped (a pending push it filters out, a post
        // outside the thread) still does. Outbox before the cursor: the header's lock order (core runs the reverse).
        // core: what it delivers is credited to `receiver`, else the session holding `handle` now (#1461); a read by a
        // `receiver` that no longer holds `handle` changes nothing (#1466), each write judging it in its own WHERE.
        const held = heldBy(sql, handle, receiver);
        const fresh: Row[] = await sql`UPDATE outbox SET delivered_at = ${clock()}, session_id = ${credited(sql, handle, receiver)}
          WHERE handle = ${handle} AND delivered_at IS NULL AND post_id = ANY(${posts.map(p => p.id)}::int8[]) AND ${held} RETURNING post_id`;
        if (fresh.length > 0 && (await sql`SELECT 1 FROM boards WHERE name = ${board} AND kind = 'queue'`).length > 0) {
          await creditQueueTakes(sql, handle, board, fresh.map(x => int8(x.post_id)), receiver);
        }
        await sql`UPDATE subscriptions SET cursor = GREATEST(cursor, ${maxId}::int8) WHERE board = ${board} AND handle = ${handle} AND ${held}`;
      }
      const [n] = await sql`SELECT COUNT(*) AS n FROM posts p JOIN subscriptions s ON s.board = p.board AND s.handle = ${handle}
        WHERE p.board = ${board} AND p.id > s.cursor AND ${notOwn(sql, h)} AND ${notPushedYet(sql, h)}`;
      return { board, posts: await withAttachments(sql, "post", posts), unread_remaining: int8(n.n) };
    },
    async threadRoot(r, postId) {
      const sql = pgOf(r);
      const [row] = await sql`WITH RECURSIVE ${upFrom(sql, postId)} ${rootOfUp(sql)}`;
      return row ? int8(row.id) : postId;
    },
    async mute(tx, handle, root, muted) {
      const sql = pgOf(tx);
      if (muted) await sql`INSERT INTO thread_mutes (handle, root_id) VALUES (${handle}, ${root}) ON CONFLICT DO NOTHING`;
      else await sql`DELETE FROM thread_mutes WHERE handle = ${handle} AND root_id = ${root}`;
    },

    // Core insertPost, the parent locked by id first (header, P1); human is bound on every insert (#1355/#1366): marked
    // only when given true.
    async insertPost(tx, p) {
      const sql = pgOf(tx);
      if (p.parentId !== null && (await sql`SELECT 1 FROM posts WHERE id = ${p.parentId} FOR KEY SHARE`).length === 0) {
        throw new MissingPost(p.parentId, p.board);
      }
      try {
        const [row] = await sql`INSERT INTO posts AS p (board, author, body, parent_id, created_at, expires_at, author_id, via, author_user, human)
          VALUES (${p.board}, ${p.author}, ${p.body}, ${p.parentId}::int8, ${p.now}, ${p.expiresAt}::int8, ${p.authorId}::text, ${p.via}::text,
            ${p.authorUser}::text, ${p.human === true}) RETURNING ${postCols(sql)}`;
        return toPost(row);
      } catch (e) {
        if (p.parentId !== null && foreignKeyViolation(e) === POST_PARENT_CONSTRAINT) throw new MissingPost(p.parentId, p.board);
        throw e;
      }
    },
    // Core bindAttachments: locked in id order (attachment_rows.ts lockUnsent, so a concurrent bind of the same uploads
    // refuses), returned in call order.
    async bindAttachments(tx, ids, from, postId, limits) {
      const sql = pgOf(tx);
      const files = await lockUnsent(sql, ids, from, limits);
      await bindLocked(sql, "post", postId, files, from);
      return files;
    },
    authorAddresses,
    async subscribers(r, board) {
      const rows: Row[] = await pgOf(r)`SELECT handle, mode FROM subscriptions WHERE board = ${board} ORDER BY handle COLLATE "C"`;
      return rows.map(x => ({ handle: x.handle as string, mode: x.mode as SubMode }));
    },
    // core threadFacts (threadRoot, threadAuthors, two getPost(...)! and the mutes) as one statement.
    async threadFacts(r, parentId) {
      const sql = pgOf(r);
      const [row] = await sql`WITH RECURSIVE ${upFrom(sql, parentId)},
          root(id) AS (${rootOfUp(sql)}),
          t(id, author) AS (
            SELECT p.id, p.author FROM posts p JOIN root ON p.id = root.id
            UNION ALL
            SELECT p.id, p.author FROM posts p JOIN t ON p.parent_id = t.id)
        SELECT (SELECT id FROM root) AS root,
               ARRAY(SELECT author FROM t GROUP BY author ORDER BY MIN(id)) AS authors,
               (SELECT author FROM posts WHERE id = ${parentId}) AS parent_author,
               (SELECT p.author FROM posts p JOIN root ON p.id = root.id) AS root_author,
               ARRAY(SELECT m.handle FROM thread_mutes m WHERE m.root_id = (SELECT id FROM root)) AS muted`;
      if (!row || row.root === null || row.parent_author === null || row.root_author === null) {
        throw new Error(`threadFacts: post ${parentId} is not a post`);
      }
      return { root: int8(row.root), authors: row.authors as string[], parentAuthor: row.parent_author as string, rootAuthor: row.root_author as string, muted: row.muted as string[] } satisfies ThreadFacts;
    },
    async laneRows(r, board, poster) {
      const sql = pgOf(r);
      return (await sql`${laneRowsStatement(sql, board, poster)}`).map((x: Row) => x.handle as string);
    },
    // core claimQueuePost, the post locked and then the claim first (header, P3/P4); a post that's gone (pruned) is
    // false, writing nothing. The take event only when this run inserted the claim; the push
    // (written or reset, undelivered and waking) only when the lane holds the key after it, in a later statement that
    // sees a winner's committed row.
    async claimQueuePost(tx, board, postId, lane, now, { note, push }) {
      const sql = pgOf(tx);
      if ((await sql`SELECT 1 FROM posts WHERE id = ${postId} FOR KEY SHARE`).length === 0) return false;
      const key = `queue:${board}:${postId}`;
      const expires = now + QUEUE_CLAIM_TTL_MS;
      const took = await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
        VALUES (${key}, ${lane}, ${note}, ${board}, ${now}, ${expires}, COALESCE((SELECT principal FROM ids WHERE id = ${lane}),
          (SELECT i.principal FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ${lane})))
        ON CONFLICT (key) DO NOTHING RETURNING key`;
      if (push) {
        // core's reset re-records the receiving session (#1370).
        await sql`INSERT INTO outbox (handle, post_id, reason, wake, session_id)
          SELECT ${lane}::text, ${postId}::int8, 'subscription', true, ${holdingSession(sql, sql.fragment`${lane}::text`)}
          WHERE EXISTS (SELECT 1 FROM claims WHERE key = ${key} AND holder = ${lane})
          ON CONFLICT (handle, post_id) DO UPDATE SET delivered_at = NULL, wake = true, session_id = excluded.session_id`;
      }
      if (took.length === 0) return false;
      await insertClaimEvent(sql, "take", lane, { key, note, board, expires_at: expires }, now);
      return true;
    },
    // core insertOutbox as one statement; a handle given twice keeps its first target, as core's row-by-row insert does.
    async insertOutbox(tx, postId, targets) {
      const sql = pgOf(tx);
      const seen = new Set<string>();
      const first = targets.filter(([h]) => !seen.has(h) && (seen.add(h), true));
      if (first.length === 0) return;
      await sql`INSERT INTO outbox (handle, post_id, reason, wake, session_id)
        SELECT t.handle, ${postId}::int8, t.reason, t.wake, ${holdingSession(sql, sql.fragment`t.handle`)}
          FROM unnest(${first.map(([h]) => h)}::text[], ${first.map(([, t]) => t.reason)}::text[], ${first.map(([, t]) => t.wake)}::boolean[]) AS t(handle, reason, wake)
        ON CONFLICT DO NOTHING`;
    },
    // core redeliveryFacts in three statements: the board and post with its writer; held and the sessions counted;
    // the author's addresses. held, per core (#1351): a session-keyed take (its session_id live) adds its session's
    // addresses now, and its raw handle only while no other session holds it; an address-keyed take, and the last
    // holder unless a take row already speaks for its handle, adds the handle and its holder's addresses now.
    async redeliveryFacts(r, key, prevHolder) {
      const m = /^queue:([^:]+):(\d+)$/.exec(key);
      if (!m) return null;
      const id = Number(m[2]);
      if (!Number.isSafeInteger(id)) return null;
      const sql = pgOf(r);
      const [w] = await sql`SELECT ${boardCols(sql)}, p.id AS post_id, p.author, p.author_id, p.author_user
        FROM posts p JOIN boards b ON b.name = p.board WHERE p.id = ${id} AND b.name = ${m[1]!}`;
      if (!w) return null;
      const prev = param(sql, prevHolder);
      const rows: Row[] = await sql`WITH takes AS (
          SELECT DISTINCT c.handle, CASE WHEN ${liveSession(sql, sql.fragment`c.session_id`)} THEN c.session_id END AS sid
          FROM claim_events c WHERE c.key = ${key} AND c.event = 'take'),
        addressed(h) AS (SELECT handle FROM takes WHERE sid IS NULL
          UNION SELECT ${prev} WHERE NOT EXISTS (SELECT 1 FROM takes WHERE handle = ${prev})),
        sessions(sid) AS (SELECT sid FROM takes WHERE sid IS NOT NULL UNION SELECT ${laneSession(sql, sql.fragment`addressed.h`)} FROM addressed)
        SELECT 'held' AS kind, h AS v FROM addressed
        UNION ALL SELECT 'held', k.handle FROM takes k WHERE k.sid IS NOT NULL AND ${laneSession(sql, sql.fragment`k.handle`)} IN (k.handle, k.sid)
        UNION ALL SELECT 'session', sid FROM sessions
        UNION ALL SELECT 'held', sh.address FROM alias_holds sh WHERE sh.id IN (SELECT sid FROM sessions)`;
      const held = new Set<string>();
      let takers = 0;
      for (const x of rows) {
        held.add(x.v as string);
        if (x.kind === "session") takers++;
      }
      const poster = await authorAddresses(r, w.author as string, w.author_id as string | null);
      return {
        board: toBoard(w), postId: int8(w.post_id), poster, author: { handle: w.author as string, id: w.author_id as string | null, user: w.author_user as string | null },
        takers, held,
      };
    },
  };
}
