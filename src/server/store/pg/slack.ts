// The Slack bridge's store on Postgres (#807 P3 C7, docs/future/postgres-server.md D3, D6): store/slack.ts's
// SlackStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's slack) is the
// reference; what differs, and why:
// - lock is pg_advisory_xact_lock(SLACK_LINK_LOCK, 0), one key for every link write (C7 decision 4), held to the
//   transaction's end: linkUser's and unlink's bodies take it before their reads, so two links of one Slack account
//   can't both pass linkBySlackUser (the second's upsert would fail 23505 on slack_links_slack_user_key), and an
//   unlink naming an old account can't delete a link a relink just committed. Link writes are human-rate, so one global
//   key costs nothing and gives one lock order. Never inside a savepoint that rolls back: ROLLBACK TO frees it.
// - link and unlink run their statements in the caller's transaction (SQLite nests one): no savepoints.
// - addThread is ON CONFLICT DO NOTHING with no target, which covers both unique keys (the ts, and (user, kind, board,
//   root)); a targeted one would fail 23505 on the other.
// - advanceThread is one UPDATE (GREATEST for SQLite's MAX): a second advance waits and re-evaluates on the first's
//   row. Its peer and id are cast: a parameter alone in `IS NOT NULL` has no inferable type (42P18).
// - progress is jsonb: setProgress binds the value (made safe by jsonSafe: jsonb refuses NUL and lone surrogates) and
//   progress returns Bun's parsed value, key order as jsonb keeps it.
// - Every int8 (user_id, linked_at, root_id, last_id) maps through int8(); board is '' for null on write, as SQLite.
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import { jsonSafe } from "../json_safe.ts";
import type { SlackLink, SlackStore, SlackThread } from "../slack.ts";
import { int8 } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for every link write: the two-int4 form beside ALIAS_CAP_LOCK and the OAuth
// classes, one key (0).
export const SLACK_LINK_LOCK = 0x6762736c; // "gbsl"

type Row = Record<string, unknown>;
const toLink = (r: Row): SlackLink => ({
  user_id: int8(r.user_id), email: r.email as string, slack_user: r.slack_user as string, dm_channel: r.dm_channel as string,
  linked_at: int8(r.linked_at),
});
const toThread = (r: Row): SlackThread => ({
  thread_ts: r.thread_ts as string, kind: r.kind as SlackThread["kind"], board: (r.board as string) || null,
  root_id: int8(r.root_id), peer: r.peer as string | null, last_id: int8(r.last_id),
});
const linkCols = (sql: PgSql) => sql.fragment`l.user_id, l.slack_user, l.dm_channel, l.linked_at, u.email`;
const threadCols = (sql: PgSql) => sql.fragment`thread_ts, kind, board, root_id, peer, last_id`;

export function makePgSlack({ clock }: { clock: () => number }): SlackStore {
  return {
    async lock(tx) {
      await pgOf(tx)`SELECT pg_advisory_xact_lock(${SLACK_LINK_LOCK}::int4, 0)`;
    },
    async links(r) {
      const sql = pgOf(r);
      return (await sql`SELECT ${linkCols(sql)} FROM slack_links l JOIN users u ON u.id = l.user_id ORDER BY l.user_id`).map(toLink);
    },
    async linkFor(r, userId) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${linkCols(sql)} FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.user_id = ${userId}`;
      return row ? toLink(row) : undefined;
    },
    async linkBySlackUser(r, slackUser) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${linkCols(sql)} FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.slack_user = ${slackUser}`;
      return row ? toLink(row) : undefined;
    },
    async link(tx, userId, slackUser, dmChannel) {
      const sql = pgOf(tx);
      // Threads and progress live in the old account's DM; a new account starts fresh.
      await sql`DELETE FROM slack_threads WHERE user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM slack_links WHERE user_id = ${userId} AND slack_user = ${slackUser} AND dm_channel = ${dmChannel})`;
      await sql`DELETE FROM slack_progress WHERE user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM slack_links WHERE user_id = ${userId} AND slack_user = ${slackUser} AND dm_channel = ${dmChannel})`;
      await sql`INSERT INTO slack_links (user_id, slack_user, dm_channel, linked_at) VALUES (${userId}, ${slackUser}, ${dmChannel}, ${clock()})
        ON CONFLICT (user_id) DO UPDATE SET slack_user = excluded.slack_user, dm_channel = excluded.dm_channel, linked_at = excluded.linked_at`;
    },
    async unlink(tx, userId) {
      const sql = pgOf(tx);
      await sql`DELETE FROM slack_threads WHERE user_id = ${userId}`;
      await sql`DELETE FROM slack_progress WHERE user_id = ${userId}`;
      await sql`DELETE FROM slack_links WHERE user_id = ${userId}`;
    },
    async thread(r, userId, kind, board, rootId) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${threadCols(sql)} FROM slack_threads
        WHERE user_id = ${userId} AND kind = ${kind} AND board = ${board ?? ""} AND root_id = ${rootId}`;
      return row ? toThread(row) : undefined;
    },
    async threadByTs(r, userId, threadTs) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${threadCols(sql)} FROM slack_threads WHERE user_id = ${userId} AND thread_ts = ${threadTs}`;
      return row ? toThread(row) : undefined;
    },
    async addThread(tx, userId, t) {
      await pgOf(tx)`INSERT INTO slack_threads (user_id, thread_ts, kind, board, root_id, peer, last_id)
        VALUES (${userId}, ${t.thread_ts}, ${t.kind}, ${t.board ?? ""}, ${t.root_id}, ${t.peer}, ${t.last_id})
        ON CONFLICT DO NOTHING`;
    },
    async advanceThread(tx, userId, threadTs, id, peer) {
      await pgOf(tx)`UPDATE slack_threads
        SET peer = CASE WHEN ${peer ?? null}::text IS NOT NULL AND ${id}::int8 > last_id THEN ${peer ?? null}::text ELSE peer END,
          last_id = GREATEST(last_id, ${id}::int8)
        WHERE user_id = ${userId} AND thread_ts = ${threadTs}`;
    },
    async progress(r, userId, ref) {
      const [row] = await pgOf(r)`SELECT progress FROM slack_progress WHERE user_id = ${userId} AND ref = ${ref}`;
      return row ? row.progress as unknown : undefined;
    },
    async setProgress(tx, userId, ref, progress) {
      await pgOf(tx)`INSERT INTO slack_progress (user_id, ref, progress) VALUES (${userId}, ${ref}, ${jsonSafe(progress)})
        ON CONFLICT (user_id, ref) DO UPDATE SET progress = excluded.progress`;
    },
    async clearProgress(tx, userId, ref) {
      await pgOf(tx)`DELETE FROM slack_progress WHERE user_id = ${userId} AND ref = ${ref}`;
    },
  };
}
