// The delegation store on Postgres (#807 P3 C10d1, docs/future/postgres-server.md D3, D6): store/delegation.ts's
// DelegationStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's delegation, over
// core/delegation.ts's launchers, isLauncher, everConnected, addressUser and countOpenDelegations, and core/boards.ts's
// ALIAS_SESSION_SQL, primaryHoldSql and rosterHandles) is the reference; what differs, and why:
// - The open cap (DELEGATE_OPEN_CAP, #252): on a Tx, facts takes a transaction-scoped advisory lock per target core
//   could pick (DELEGATE_CAP_LOCK keyed by hashtext(target), lockCapKeys) before it counts: a named target, or each
//   launcher whose user is the requester's (core's own-user filter); another user's launchers take none. The caller
//   (the delegate path, application.ts) reads the facts on the savepoint it then writes the request's message and its
//   delegation.requested row on, so a second delegation to that launcher waits for the first to commit and counts it:
//   two at cap-1 would otherwise both count cap-1 and both send. Advisory rather than the launcher's ids row: the count
//   is keyed by access_log.target, which may be an alias, and that row is also an end's FOR UPDATE and every send's
//   KEY SHARE (c10-scope §7 Q7). A savepoint rolled back frees it, which only a refused delegation does: it wrote
//   nothing to count. On a Read (the pool) there is no transaction to hold it, and no lock is taken.
// - The open count reads the request's message id as `a.detail->>'message_id'` (access_log.detail is jsonb), cast to
//   int8 so the join probes messages' primary key; the counts for every candidate are one statement, as are the users.
// - launcher, viewer and human are booleans: `launcher` (NULL is not one), `NOT viewer`, `human IS NOT TRUE`.
//
// Runtime imports stay off bun:sqlite, db.ts and core's SQLite modules (pg/isolation.test.ts): the SQL is restated.
import { addressParts } from "../../../core/addresses.ts";
import { isTx } from "../tx_base.ts";
import { delegationFacts, type DelegationStore } from "../delegation.ts";
import { int8 } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for a launcher's open cap: the two-int4 form beside ALIAS_CAP_LOCK and the OAuth
// caps' classes, keyed by hashtext(target). A collision only serializes two launchers' delegations.
export const DELEGATE_CAP_LOCK = 0x6762646c; // "gbdl"

// Takes DELEGATE_CAP_LOCK for each of `targets` in one statement, in ascending key order, each key once (a repeated
// target or a hashtext collision is one lock), so two delegations over overlapping targets lock in one order and can't
// deadlock (40P01). Returns the keys in the order taken. The order is the subquery's: DISTINCT with ORDER BY keeps it
// from being flattened, and the outer target list, the lock call, runs per row as the scan emits them.
export async function lockCapKeys(sql: PgSql, targets: string[]): Promise<number[]> {
  const rows: Row[] = await sql`SELECT k, pg_advisory_xact_lock(${DELEGATE_CAP_LOCK}::int4, k)
    FROM (SELECT DISTINCT hashtext(t) AS k FROM unnest(${targets}::text[]) t ORDER BY k) s`;
  return rows.map(r => Number(r.k));
}

// core/delegation.ts userMatches, restated (pg modules can't reach core/delegation.ts at runtime): a candidate core's
// auto-pick keeps for this requester, one with no session behind it or whose user is the requester's.
const userMatches = (principal: string | null, user: string | null | undefined): boolean => user === undefined || user === principal;

type Row = Record<string, unknown>;

// core ALIAS_SESSION_SQL over the aliases row `a`: its holder's session, else the last binder's once it has ended.
const aliasSession = (sql: PgSql) => sql.fragment`COALESCE(
    (SELECT id FROM alias_holds WHERE address = a.address),
    (SELECT l.session_id FROM (SELECT session_id FROM binding_events WHERE name = a.address AND event IN ('bound', 'moved') ORDER BY id DESC LIMIT 1) l
      JOIN ids e ON e.id = l.session_id WHERE e.ended_at IS NOT NULL))`;

// core LAUNCHER_SQL's and UNBOUND_LAUNCHER_SQL's filters: a named launcher is an alias (not a human's) whose session is
// a launcher; an unbound one is a live, push-delivered, non-viewer root launcher holding no alias.
const unboundLauncher = (sql: PgSql) => sql.fragment`i.launcher AND i.ended_at IS NULL AND i.delivery = 'push' AND NOT i.viewer
  AND i.root_id IS NULL AND NOT EXISTS (SELECT 1 FROM alias_holds ah WHERE ah.id = i.id)`;

async function launchers(sql: PgSql): Promise<string[]> {
  // core launchers: one per launcher session, its primary hold (core primaryHoldSql, HOLD_ORDER) or an alias nobody
  // holds now, named ones by address, then unbound ones by ID.
  const named: Row[] = await sql`SELECT a.address FROM aliases a JOIN ids i ON i.id = ${aliasSession(sql)}
    WHERE i.launcher AND a.human IS NOT TRUE
      AND (a.address = (SELECT address FROM alias_holds WHERE id = i.id ORDER BY bound_at, address LIMIT 1)
        OR NOT EXISTS (SELECT 1 FROM alias_holds h WHERE h.address = a.address))
    ORDER BY a.address`;
  const unbound: Row[] = await sql`SELECT i.id AS address FROM ids i WHERE ${unboundLauncher(sql)} ORDER BY i.id`;
  return [...named, ...unbound].map(r => r.address as string);
}

async function isLauncher(sql: PgSql, handle: string): Promise<boolean> {
  const rows: Row[] = addressParts(handle)?.kind === "id"
    ? await sql`SELECT 1 FROM ids i WHERE ${unboundLauncher(sql)} AND i.id = ${handle}`
    : await sql`SELECT 1 FROM aliases a JOIN ids i ON i.id = ${aliasSession(sql)} WHERE i.launcher AND a.human IS NOT TRUE AND a.address = ${handle}`;
  return rows.length > 0;
}

// core everConnected: an ID with a row, or an alias on the roster (core rosterHandles: one with a last_seen).
async function everConnected(sql: PgSql, to: string): Promise<boolean> {
  const rows: Row[] = addressParts(to)?.kind === "id"
    ? await sql`SELECT 1 FROM ids WHERE id = ${to}`
    : await sql`SELECT 1 FROM aliases WHERE address = ${to} AND last_seen IS NOT NULL`;
  return rows.length > 0;
}

async function addressUser(sql: PgSql, candidate: string): Promise<string | null | undefined> {
  const [row]: Row[] = addressParts(candidate)?.kind === "id"
    ? await sql`SELECT principal FROM ids WHERE id = ${candidate}`
    : await sql`SELECT i.principal FROM aliases a JOIN ids i ON i.id = ${aliasSession(sql)} WHERE a.address = ${candidate}`;
  return row ? (row.principal as string | null) : undefined;
}

// addressUser for every candidate: an ID's and an alias's each in one statement; one with no session behind it is
// absent, which the map reads as undefined, as addressUser does.
async function addressUsers(sql: PgSql, candidates: string[]): Promise<Map<string, string | null | undefined>> {
  const idList = candidates.filter(h => addressParts(h)?.kind === "id"), names = candidates.filter(h => addressParts(h)?.kind !== "id");
  const rows: Row[] = [
    ...(idList.length ? await sql`SELECT id AS address, principal FROM ids WHERE id = ANY(${idList}::text[])` : []),
    ...(names.length ? await sql`SELECT a.address, i.principal FROM aliases a JOIN ids i ON i.id = ${aliasSession(sql)} WHERE a.address = ANY(${names}::text[])` : []),
  ];
  const found = new Map(rows.map(r => [r.address as string, r.principal as string | null]));
  return new Map(candidates.map(h => [h, found.has(h) ? found.get(h) : undefined]));
}

// core countOpenDelegations over access_log, for every target at once: requests audited to it since `since` whose
// message still exists and that its side hasn't taken (no reply from anyone but the requester, no ack by anyone but
// the requester). A target with none is absent.
async function openCounts(sql: PgSql, targets: string[], since: number): Promise<Map<string, number>> {
  const rows: Row[] = await sql`SELECT a.target, count(*) AS n FROM access_log a
    JOIN messages m ON m.id = (a.detail->>'message_id')::int8 AND m.recipient = a.target
    WHERE a.action = 'delegation.requested' AND a.target = ANY(${targets}::text[]) AND a.at > ${since}::int8
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.id AND r.sender <> m.sender)
      AND NOT EXISTS (SELECT 1 FROM dm_acks k WHERE k.message_id = m.id AND k.reader <> m.sender)
    GROUP BY a.target`;
  const out = new Map(targets.map(t => [t, 0]));
  for (const r of rows) out.set(r.target as string, int8(r.n));
  return out;
}

export function makePgDelegation(): DelegationStore {
  return {
    addressUser: async (r, address) => addressUser(pgOf(r), address),
    async facts(r, q) {
      const sql = pgOf(r);
      if (q.to !== undefined) {
        const to = q.to;
        // The cap's lock, before any count.
        if (isTx(r)) await lockCapKeys(sql, [to]);
        return delegationFacts({
          to: { address: to, everConnected: await everConnected(sql, to), isLauncher: await isLauncher(sql, to) },
          users: await addressUsers(sql, [to]),
          open: await openCounts(sql, [to], q.since),
        });
      }
      const all = await launchers(sql);
      let candidates = all, users: Map<string, string | null | undefined>;
      if (isTx(r)) {
        // Only the launchers core could pick for this requester are locked: their users are read unlocked first, and
        // read again once the locks are held, since an alias can change hands in between. A launcher locked that no
        // longer matches, core filters out. One that matches now but didn't then wasn't locked, so it's left out of
        // the list: that answer is the one a delegation reading just before it changed hands would have got, and
        // core only ever sends to a listed launcher, so nothing reaches a target whose count it didn't lock.
        const before = await addressUsers(sql, all);
        const locked = new Set(all.filter(h => userMatches(q.principal, before.get(h))));
        await lockCapKeys(sql, [...locked]);
        users = await addressUsers(sql, all);
        const after = users;
        candidates = all.filter(h => locked.has(h) || !userMatches(q.principal, after.get(h)));
      } else users = await addressUsers(sql, all);
      // Counted for every listed launcher, so the facts match SQLite's; another user's counts are unlocked, but core's
      // user filter runs before it asks for a count.
      return delegationFacts({ launchers: candidates, users, open: await openCounts(sql, candidates, q.since) });
    },
  };
}
