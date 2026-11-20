// The claims store on Postgres (#807 P3 C10b, docs/future/postgres-server.md D3, D6): store/claims.ts's ClaimsStore,
// each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's claims, over core/claims.ts's SQL,
// already in D3's shape) is the reference; what differs, and why:
// - take is core's upsert as written: on a key another transaction inserted or took over, the loser waits on that row,
//   then its conflict WHERE (lapsed, or the holder's own) re-reads the winner's committed row and it gets no row: held.
// - Every write that ends a claim or its watches is one conditional DELETE … RETURNING, never a read and then a delete:
//   release (the holder's live row), expire (lapsed at `now`), takeWatchers, and ackQueue, whose core form reads the
//   row and then deletes by key alone. Under READ COMMITTED a delete waiting on a takeover re-checks its WHERE against
//   the new row, so an old holder's ack after a takeover deletes nothing (on SQLite the single writer runs the ack's
//   read and delete with nothing between them, so core's two statements are safe there).
// - liveForWatch reads the claim FOR SHARE: a release's DELETE waits for the watch to commit and then takes its row
//   (the watcher is told), or the watch waits for the release and finds no claim. Without it, either order leaves a
//   claim_watches row for a claim that's gone. claim_watches has no foreign key to claims.
// - list's prefix match is ILIKE … ESCAPE '\', which folds case as SQLite's LIKE does (ASCII only, as probed, on these
//   COLLATE "C" columns), with `\`, `%` and `_` escaped, and reads the store's clock where core reads Date.now().
// - Orders that SQLite takes in byte order (list's key, the watchers' handle) are COLLATE "C" (the columns' own);
//   expire keeps core's JS sort.
//
// Runtime imports stay off bun:sqlite, db.ts and core/claims.ts, which reaches core/boards.ts (pg/isolation.test.ts):
// the SQL is restated, and holderUserRule comes from core/claim_holder.ts.
import { holderUserRule } from "../../../core/claim_holder.ts";
import type { Claim, ClaimEvent, ClaimEventRow, ClaimRow, ClaimsStore } from "../claims.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

type Row = Record<string, unknown>;
const toClaim = (r: Row): Claim => ({
  key: r.key as string, holder: r.holder as string, note: r.note as string | null, board: r.board as string | null,
  acquired_at: int8(r.acquired_at), expires_at: int8(r.expires_at),
});
// A whole row, as core's `SELECT *` and `RETURNING *` give it.
const toRow = (r: Row): ClaimRow => ({ ...toClaim(r), holder_user: r.holder_user as string | null });
const claimCols = (sql: PgSql) => sql.fragment`key, holder, note, board, acquired_at, expires_at`;
const rowCols = (sql: PgSql) => sql.fragment`key, holder, note, board, acquired_at, expires_at, holder_user`;

// core expireClaims' order: lapse order, by key within a tie (JS string order, as core sorts).
const lapseOrder = (a: ClaimRow, b: ClaimRow) => a.expires_at - b.expires_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// One claim_events row on the caller's handle (core logEvent); pg/boards.ts's claimQueuePost writes its take event
// through it too. session_id: core logEvent's rule (#1351), the alias's holder, else the handle when it is a session
// ID, else null.
export async function insertClaimEvent(
  sql: PgSql, event: ClaimEvent, handle: string, c: Partial<Claim> & { key: string }, at: number, heldBy?: string,
): Promise<void> {
  await sql`INSERT INTO claim_events (key, handle, event, note, board, expires_at, held_by, at, session_id)
    VALUES (${c.key}, ${handle}, ${event}, ${c.note ?? null}, ${c.board ?? null}, ${c.expires_at ?? null}::int8, ${heldBy ?? null}, ${at},
      COALESCE((SELECT id FROM alias_holds WHERE address = ${handle}), (SELECT id FROM ids WHERE id = ${handle})))`;
}

export function makePgClaims({ clock }: { clock: () => number }): ClaimsStore {
  async function takeWatchers(tx: Parameters<ClaimsStore["takeWatchers"]>[0], key: string): Promise<string[]> {
    const rows: Row[] = await pgOf(tx)`WITH gone AS (DELETE FROM claim_watches WHERE key = ${key} RETURNING handle)
      SELECT handle FROM gone ORDER BY handle COLLATE "C"`;
    return rows.map(x => x.handle as string);
  }
  return {
    async list(r, prefix) {
      const sql = pgOf(r);
      const like = `${(prefix ?? "").replace(/[\\%_]/g, "\\$&")}%`;
      return (await sql`SELECT ${claimCols(sql)} FROM claims WHERE expires_at > ${clock()} AND key ILIKE ${like} ESCAPE '\\'
        ORDER BY key COLLATE "C"`).map(toClaim);
    },
    async nextExpiry(r) {
      const [row] = await pgOf(r)`SELECT MIN(expires_at) AS next FROM claims WHERE board IS NOT NULL`;
      return int8OrNull(row?.next);
    },
    async get(r, key) {
      const sql = pgOf(r);
      const [row] = await sql`SELECT ${rowCols(sql)} FROM claims WHERE key = ${key}`;
      return row ? toRow(row) : undefined;
    },
    // core takeClaim, statement for statement.
    async take(tx, t) {
      const sql = pgOf(tx);
      const [row] = await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
        VALUES (${t.key}, ${t.as}, ${t.note}, ${t.board}, ${t.now}, ${t.expires}, ${t.user})
        ON CONFLICT (key) DO UPDATE SET
          holder = excluded.holder,
          holder_user = excluded.holder_user,
          note = COALESCE(excluded.note, CASE WHEN claims.holder = excluded.holder THEN claims.note END),
          board = COALESCE(excluded.board, CASE WHEN claims.holder = excluded.holder THEN claims.board END),
          acquired_at = CASE WHEN claims.holder = excluded.holder AND claims.expires_at > ${t.now}
                             THEN claims.acquired_at ELSE excluded.acquired_at END,
          expires_at = excluded.expires_at
        WHERE claims.expires_at <= ${t.now} OR claims.holder = excluded.holder
        RETURNING ${claimCols(sql)}`;
      return row ? toClaim(row) : null;
    },
    async release(tx, key, holder, now) {
      const sql = pgOf(tx);
      const [row] = await sql`DELETE FROM claims WHERE key = ${key} AND holder = ${holder} AND expires_at > ${now} RETURNING ${rowCols(sql)}`;
      return row ? toRow(row) : null;
    },
    async recentEvents(r, key) {
      const rows: Row[] = await pgOf(r)`SELECT handle, event, note, at FROM claim_events WHERE key = ${key} ORDER BY id DESC LIMIT 2`;
      return rows.map((x): ClaimEventRow => ({ handle: x.handle as string, event: x.event as ClaimEvent, note: x.note as string | null, at: int8(x.at) }));
    },
    async watchers(r, key) {
      const rows: Row[] = await pgOf(r)`SELECT handle FROM claim_watches WHERE key = ${key} ORDER BY handle COLLATE "C"`;
      return rows.map(x => x.handle as string);
    },
    async liveForWatch(tx, key, now) {
      const sql = pgOf(tx);
      const [row] = await sql`SELECT ${rowCols(sql)} FROM claims WHERE key = ${key} AND expires_at > ${now} FOR SHARE`;
      return row ? toRow(row) : undefined;
    },
    async addWatch(tx, key, handle) {
      await pgOf(tx)`INSERT INTO claim_watches (key, handle) VALUES (${key}, ${handle}) ON CONFLICT DO NOTHING`;
    },
    async unwatch(tx, key, handle) {
      await pgOf(tx)`DELETE FROM claim_watches WHERE key = ${key} AND handle = ${handle}`;
    },
    async expire(tx, now) {
      const sql = pgOf(tx);
      const rows: Row[] = await sql`DELETE FROM claims WHERE expires_at <= ${now} RETURNING ${rowCols(sql)}`;
      return rows.map(toRow).sort(lapseOrder);
    },
    logEvent: (tx, event, handle, c, at, heldBy) => insertClaimEvent(pgOf(tx), event, handle, c, at, heldBy),
    takeWatchers,
    // core holderUser: the row's own user, else holderPrincipals' two facts read in one statement, then the rule.
    async holderUser(r, c) {
      if (c.holder_user) return c.holder_user;
      const [f] = await pgOf(r)`SELECT (SELECT principal FROM ids WHERE id = ${c.holder}) AS id_principal,
        (SELECT i.principal FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ${c.holder}) AS held_principal`;
      return holderUserRule(c, f.id_principal as string | null, f.held_principal as string | null);
    },
    // core ackQueueClaim with its read and its delete made one statement: the row is deleted only while one of
    // `addresses` holds it, lapsed or not, so a takeover committed while this waited leaves the new holder's claim.
    async ackQueue(tx, addresses, key, now) {
      const sql = pgOf(tx);
      const [row] = await sql`DELETE FROM claims WHERE key = ${key} AND holder = ANY(${addresses}::text[]) RETURNING ${rowCols(sql)}`;
      if (!row) return false;
      const gone = toRow(row);
      await takeWatchers(tx, key);
      await insertClaimEvent(pgOf(tx), "release", gone.holder, { ...gone, note: gone.expires_at <= now ? "ack (late)" : "ack" }, now);
      return true;
    },
    // A session end's (#807 P3 C10d2-a): by key, where SQLite's order is its scan's.
    async heldBy(r, holder, now) {
      const rows: Row[] = await pgOf(r)`SELECT key FROM claims WHERE holder = ${holder} AND expires_at > ${now} ORDER BY key COLLATE "C"`;
      return rows.map(x => x.key as string);
    },
  };
}
