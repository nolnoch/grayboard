// The hosted sessions store on Postgres (#807 P3 C8b1, docs/future/postgres-server.md D3, D6): store/hosted.ts's
// HostedStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeHostedStore and
// hostedWrites) is the reference; what differs, and why:
// - The three lock seams lock (store/hosted.ts gives the order: grant, root, child, capacity). `grantLive` reads the
//   grant FOR SHARE, so a revoke's UPDATE waits for the body that writes under it, or the body waits and reads it
//   revoked. `lock` takes FOR UPDATE on a child's root, then on the row. `lockCapacity` is HOSTED_CAP_LOCK, one
//   transaction-scoped advisory lock for every admission (the global cap spans users). Each refuses a pool Read.
// - `end` and `childEnd` lock their row FOR UPDATE before they judge it, so a second end finds nothing and a guard
//   (deadline, idle cutoff, an eviction's parked_at) reads the row as a renewal or touch committed it. A missing row, a
//   child passed to `end` or a failed guard returns false having written nothing.
// - Under the capacity lock (the nested sweep inside hosted.ts `full()`), `end`, `childEnd` and `park` take their row
//   FOR UPDATE SKIP LOCKED: a row another body holds is skipped, as a refused guard is, and left to the next tick (a
//   body that holds a root and then wants capacity would otherwise deadlock against the sweep). Before any write,
//   `end` then takes the rest of its ownership's hosted_sessions rows, its alias_holds rows, and its own and its
//   children's ids rows, and `childEnd` its child's ids row, each SKIP LOCKED against an unlocked count: a shortfall
//   means another body holds one, and the call returns as refused, writing nothing (`dependentsFree`). `park` writes
//   only its own row. Not bounded: every lock the session-end port takes past those ids rows (core endSession's
//   claims, messages, aliases and attachments on C10d2's port), so a capped end or childEnd can still wait inside the
//   port. The flag is per Tx handle: hosted.ts runs that sweep on the Tx it took the lock on.
// - A released child's ID ends through the injected session-end port (hosted_port.ts PgSessionEndPort, C10d2's), on
//   the caller's Tx, with an audit sink that writes its id.ended row to access_log as db.ts coreAudit does on SQLite;
//   its wakes and bounces reach `takeEnded` after commit (afterCommitOf), never on rollback.
// - The lost-hold takes are one UPDATE … RETURNING each, ordered by (at, seq) in JS: `seq` stands for SQLite's rowid.
// - int8 columns through the mappers, booleans as booleans, `held_aliases_json` jsonb; SQLite's unary-`+` planner
//   hints are dropped (42883 here); text columns are COLLATE "C", so ORDER BY matches SQLite's binary order.
// - core's dropHold and logBinding("released"), and its HOLD_ORDER, are restated in the root's end (C10a may later
//   call its bindings port instead). Audit rows go through pg/audit_row.ts with the detail as an object.
// - No savepoints: callers hold them (withGate's rowFor, revokeUse). No retries (D6).
//
// Runtime imports stay off bun:sqlite, db.ts, core/session_end.ts and core/bindings.ts (pg/isolation.test.ts).
import { testPauseAsync } from "../../../shared/testpause.ts";
import type { AuditAction } from "../../audit.ts";
import type { EndedChild, HostedLost, HostedSession, LostReader } from "../../hosted-types.ts";
import type { HostedPatch, HostedStore } from "../hosted.ts";
import type { MessageRow } from "../messages.ts";
import { afterCommitOf, isTx, type Read, type Tx } from "../tx_base.ts";
import { pgCoreAuditSink } from "./audit.ts";
import { insertAudit } from "./audit_row.ts";
import type { PgSessionEndPort } from "./hosted_port.ts";
import type { AuditDetail } from "./sql.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, 0) for admission (`full()`): the two-int4 form beside ALIAS_CAP_LOCK and the OAuth
// classes, one key for every user, since the global cap spans them.
export const HOSTED_CAP_LOCK = 0x67626873; // "gbhs"

type Row = Record<string, unknown>;
const toSession = (r: Row): HostedSession => ({
  session_id: r.session_id as string, ownership_id: int8(r.ownership_id), user_id: int8(r.user_id), client_id: r.client_id as string,
  grant_id: r.grant_id as string, source_session_id: r.source_session_id as string, writes_as: r.writes_as as string | null,
  bind_gen: int8(r.bind_gen), root_session_id: r.root_session_id as string | null, place: r.place as string | null,
  lease_deadline: int8OrNull(r.lease_deadline), created_at: int8(r.created_at), last_seen_at: int8(r.last_seen_at),
  suggested: r.suggested as string | null, parked_at: int8OrNull(r.parked_at),
});
const cols = (sql: PgSql) => sql.fragment`session_id, ownership_id, user_id, client_id, grant_id, source_session_id, writes_as, bind_gen,
  root_session_id, place, lease_deadline, created_at, last_seen_at, suggested, parked_at`;
const sessions = async (q: Promise<Row[]>) => (await q).map(toSession);
const one = async (q: Promise<Row[]>) => { const [r] = await q; return r ? toSession(r) : undefined; };
// pg/messages.ts's row, restated (the bounces an ended child's end wrote).
const toMessage = (r: Row): MessageRow => ({
  id: int8(r.id), sender: r.sender as string, recipient_type: r.recipient_type as MessageRow["recipient_type"], recipient: r.recipient as string,
  body: r.body as string, parent_id: int8OrNull(r.parent_id), created_at: int8(r.created_at), delivered_at: int8OrNull(r.delivered_at),
  pending: r.pending === true ? 1 : 0, kind: r.kind as MessageRow["kind"], via: r.via as string | null,
});
const byStart = (a: HostedSession, b: HostedSession) => a.created_at - b.created_at || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0);
// The columns a patch may write (HostedPatch), in a fixed order: the names come from here, never from the patch's keys.
const PATCH_COLUMNS = ["grant_id", "bind_gen", "place", "lease_deadline", "last_seen_at"] as const satisfies readonly (keyof HostedPatch)[];
// The hosted_alias_lost column each reader's take marks (#453).
const LOST_READ: Record<LostReader, "told_at" | "seen_at"> = { agent: "told_at", controller: "seen_at" };
type LostRow = { alias: string; reason: string; was_primary: boolean; at: unknown; seq: unknown };
const toLost = (r: LostRow): HostedLost => ({ alias: r.alias, reason: r.reason, primary: r.was_primary });

export function makePgHosted({ sessionEnd }: { sessionEnd: PgSessionEndPort }): HostedStore {
  // The child IDs ended since the last take, pushed at their transaction's commit (#475 item 1).
  let ended: EndedChild[] = [];
  // The Tx handles that took the capacity lock: their end, childEnd and park skip a locked row rather than wait. Keyed
  // by the handle, so a savepoint's Tx (a new handle) does not inherit it: its ends would wait. No caller takes
  // capacity and then ends inside a savepoint of that Tx (hosted.ts `full()` sweeps on the Tx it locked on).
  const capped = new WeakSet<Tx>();
  const lockOn = (tx: Tx): PgSql => { const sql = pgOf(tx); if (!isTx(tx)) throw new Error("a hosted lock needs the body's Tx, not a pool Read"); return sql; };
  // The row, locked to the transaction's end; under the capacity lock, undefined when another body holds it.
  const lockRow = (sql: PgSql, tx: Tx, id: string) => capped.has(tx)
    ? one(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE session_id = ${id} FOR UPDATE SKIP LOCKED`)
    : one(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE session_id = ${id} FOR UPDATE`);
  // Under the capacity lock, before any write: the rows an end writes past its own, and the ids rows it or the port
  // writes first, each locked SKIP LOCKED and counted against an unlocked count taken before it. False when one is
  // held elsewhere (a row inserted between the count and the lock only adds to what is locked). `ownership`: a root's,
  // whose hosted_sessions rows (its children) and alias_holds rows (`holder`'s) end with it.
  const dependentsFree = async (sql: PgSql, ids: string[], ownership?: { id: number; holder: string }): Promise<boolean> => {
    if (ownership) {
      const [{ n: rows }] = await sql`SELECT count(*)::int AS n FROM hosted_sessions WHERE ownership_id = ${ownership.id}`;
      const kids: Row[] = await sql`SELECT session_id FROM hosted_sessions WHERE ownership_id = ${ownership.id} FOR UPDATE SKIP LOCKED`;
      if (kids.length < rows) return false;
      for (const k of kids) if (k.session_id !== ownership.holder) ids = [...ids, k.session_id as string];
      const [{ n: holds }] = await sql`SELECT count(*)::int AS n FROM alias_holds WHERE id = ${ownership.holder}`;
      if ((await sql`SELECT 1 FROM alias_holds WHERE id = ${ownership.holder} FOR UPDATE SKIP LOCKED`).length < holds) return false;
    }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ids WHERE id = ANY(${ids}::text[])`;
    return (await sql`SELECT 1 FROM ids WHERE id = ANY(${ids}::text[]) FOR UPDATE SKIP LOCKED`).length >= n;
  };

  // db.ts hostedWrites' audit: the session's latest ownership names the actor and the client.
  const audit = async (sql: PgSql, session: string, action: AuditAction, detail: AuditDetail, now: number) => {
    const [owner] = await sql`SELECT u.email, o.client_id FROM hosted_ownerships o JOIN users u ON u.id = o.user_id
      WHERE o.session_id = ${session} ORDER BY o.id DESC LIMIT 1`;
    await insertAudit(sql, now, (owner?.email as string | undefined) ?? null, action, session, { ...detail, client_id: (owner?.client_id as string | undefined) ?? null });
  };
  // A released child's ID ends in the release's transaction, with its reason (#475 item 1); its wakes and bounces are
  // queued at commit, so a rolled-back release wakes nobody and bounces nothing.
  const endChild = async (tx: Tx, sql: PgSql, child: string, why: string, now: number) => {
    const end = await sessionEnd.end(tx, child, { why, now, audit: pgCoreAuditSink(tx, now) });
    if (!end.ended) return;
    const bounces = (await sql`SELECT id, sender, recipient_type, recipient, body, parent_id, created_at, delivered_at, pending, kind, via
      FROM messages WHERE sender = ${child} AND kind = 'bounce' AND created_at >= ${now} ORDER BY id`).map(toMessage);
    afterCommitOf(tx, () => { ended.push({ id: child, at: now, wake: end.wake, bounces }); });
  };
  const lostOf = async (sql: PgSql, session: string, reader: LostReader) =>
    (await sql`SELECT alias, reason, was_primary FROM hosted_alias_lost WHERE session_id = ${session} AND ${sql(LOST_READ[reader])} IS NULL
      ORDER BY at, seq`).map(toLost);
  // One statement marks what it takes, so two takers get each row once between them (#807 P3 C8 R5); then the rows
  // both readers took go.
  const takeLost = async (sql: PgSql, session: string, taken: LostRow[]): Promise<HostedLost[]> => {
    if (!taken.length) return [];
    taken.sort((a, b) => int8(a.at) - int8(b.at) || int8(a.seq) - int8(b.seq));
    await sql`DELETE FROM hosted_alias_lost WHERE session_id = ${session} AND told_at IS NOT NULL AND seen_at IS NOT NULL`;
    return taken.map(toLost);
  };

  return {
    get: (r, id) => { const sql = pgOf(r); return one(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE session_id = ${id}`); },
    // A child's root first, then the row (store/hosted.ts's order). A child's root never changes while its row exists
    // (a convert deletes and inserts), so the root read before the lock is the row's; the re-check covers a row
    // deleted and registered again under another root in between.
    async lock(tx, id) {
      const sql = lockOn(tx);
      const [root] = await sql`SELECT session_id FROM hosted_sessions
        WHERE session_id = (SELECT root_session_id FROM hosted_sessions WHERE session_id = ${id}) FOR UPDATE`;
      const row = await one(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE session_id = ${id} FOR UPDATE`);
      if (row?.root_session_id && row.root_session_id !== root?.session_id) await sql`SELECT 1 FROM hosted_sessions WHERE session_id = ${row.root_session_id} FOR UPDATE`;
      return row;
    },
    async lockCapacity(tx) {
      const sql = lockOn(tx);
      await sql`SELECT pg_advisory_xact_lock(${HOSTED_CAP_LOCK}::int4, 0)`;
      capped.add(tx);
    },
    async grantLive(tx, grantId, now) {
      const sql = lockOn(tx);
      const [g] = await sql`SELECT revoked_at IS NULL AND expires_at > ${now} AS live FROM oauth_grants WHERE id = ${grantId} FOR SHARE`;
      return g?.live === true;
    },
    async owned(r, id) {
      const [row] = await pgOf(r)`SELECT EXISTS (SELECT 1 FROM hosted_ownerships WHERE session_id = ${id})
        OR EXISTS (SELECT 1 FROM hosted_sessions WHERE session_id = ${id}) AS n`;
      return row.n === true;
    },
    all: r => { const sql = pgOf(r); return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE parked_at IS NULL`); },
    async counts(r, user) {
      const [row] = await pgOf(r)`SELECT (SELECT count(*) FROM hosted_sessions WHERE parked_at IS NULL) AS total,
        (SELECT count(*) FROM hosted_sessions WHERE user_id = ${user} AND parked_at IS NULL) AS user`;
      return { total: int8(row.total), user: int8(row.user) };
    },
    ofOwnership: (r, ownership) => { const sql = pgOf(r); return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE ownership_id = ${ownership} AND parked_at IS NULL`); },
    children: (r, root) => { const sql = pgOf(r); return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE root_session_id = ${root}`); },
    roots: (r, user) => { const sql = pgOf(r); return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE user_id = ${user} AND root_session_id IS NULL ORDER BY created_at, session_id`); },
    async park(tx, session, now, idleBefore) {
      const sql = pgOf(tx);
      if (capped.has(tx)) {
        const [free] = await sql`SELECT 1 FROM hosted_sessions WHERE session_id = ${session} FOR UPDATE SKIP LOCKED`;
        if (!free) return false;
      }
      const parked = await sql`UPDATE hosted_sessions SET parked_at = ${now}
        WHERE session_id = ${session} AND root_session_id IS NOT NULL AND parked_at IS NULL AND last_seen_at < ${idleBefore} RETURNING 1`;
      return parked.length > 0;
    },
    async unpark(tx, session, grant, now) {
      await pgOf(tx)`UPDATE hosted_sessions SET parked_at = NULL, grant_id = ${grant}, last_seen_at = ${now} WHERE session_id = ${session}`;
    },
    async start(tx, session, user, client, now, suggested) {
      const sql = pgOf(tx);
      const [row] = await sql`INSERT INTO hosted_ownerships (session_id, user_id, client_id, started_at) VALUES (${session}, ${user}, ${client}, ${now}) RETURNING id`;
      const id = int8(row.id);
      await audit(sql, session, "hosted.ownership_started", { ownership: id, ...(suggested ? { suggested } : {}) }, now);
      return id;
    },
    async insert(tx, row) {
      await pgOf(tx)`INSERT INTO hosted_sessions (session_id, ownership_id, user_id, client_id, grant_id, source_session_id, writes_as, bind_gen,
          root_session_id, place, lease_deadline, created_at, last_seen_at, suggested)
        VALUES (${row.session_id}, ${row.ownership_id}, ${row.user_id}, ${row.client_id}, ${row.grant_id}, ${row.source_session_id}, ${row.writes_as},
          ${row.bind_gen}, ${row.root_session_id}, ${row.place}, ${row.lease_deadline}, ${row.created_at}, ${row.last_seen_at}, ${row.suggested})`;
    },
    async update(tx, id, patch) {
      const sql = pgOf(tx);
      const names = PATCH_COLUMNS.filter(c => patch[c] !== undefined);
      if (!names.length) return;
      await sql.unsafe(`UPDATE hosted_sessions SET ${names.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE session_id = $${names.length + 1}`,
        [...names.map(c => patch[c]!), id]);
    },
    async touch(tx, session, now) {
      await pgOf(tx)`UPDATE hosted_sessions SET last_seen_at = ${now} WHERE session_id = ${session}`;
    },
    expired: (r, now) => { const sql = pgOf(r); return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE lease_deadline <= ${now} AND root_session_id IS NULL`); },
    idle: (r, cutoff) => {
      const sql = pgOf(r);
      return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions h WHERE h.parked_at IS NULL AND h.last_seen_at < ${cutoff}
        AND (h.root_session_id IS NOT NULL OR (h.lease_deadline IS NULL AND NOT EXISTS (SELECT 1 FROM alias_holds a WHERE a.id = h.session_id)))`);
    },
    disabled: r => {
      const sql = pgOf(r);
      return sessions(sql`SELECT ${cols(sql)} FROM hosted_sessions WHERE user_id IN (SELECT id FROM users WHERE disabled_at IS NOT NULL) AND root_session_id IS NULL`);
    },
    // §2.7 of the C8 scope, as db.ts hostedWrites' end.
    async end(tx, session, reason, now, deadline, idleBefore) {
      const sql = pgOf(tx);
      // Locked before it is judged: a guard reads the row as the last committed write left it.
      const row = await lockRow(sql, tx, session);
      if (!row || row.root_session_id || (deadline !== undefined && row.lease_deadline !== deadline)) return false;
      if (idleBefore !== undefined && !(row.last_seen_at < idleBefore)) return false;
      if (capped.has(tx) && !(await dependentsFree(sql, [session], { id: row.ownership_id, holder: session }))) return false;
      await testPauseAsync(reason === "expired" ? "hosted:lease-expire:in-txn" : "hosted:release:in-txn");
      const children = (await sessions(sql`DELETE FROM hosted_sessions WHERE ownership_id = ${row.ownership_id} RETURNING ${cols(sql)}`)).sort(byStart);
      await sql`UPDATE hosted_ownerships SET ended_at = ${now}, end_reason = ${reason} WHERE id = ${row.ownership_id} AND ended_at IS NULL`;
      // The ownership's writes_as and launcher flag end with it (db.ts end's comment); clearing the flag is audited.
      const [ids] = await sql`SELECT launcher FROM ids WHERE id = ${session} FOR UPDATE`;
      await sql`UPDATE ids SET writes_as = NULL, launcher = false WHERE id = ${session}`;
      if (ids?.launcher === true) await audit(sql, session, "handle.launcher_set", { on: false, ownership: row.ownership_id, reason }, now);
      // Every hold the ownership has (#451), oldest first (core HOLD_ORDER), each released: core dropHold and logBinding.
      const holds: { address: string; bound_at: unknown }[] = await sql`DELETE FROM alias_holds WHERE id = ${session} RETURNING address, bound_at`;
      holds.sort((a, b) => int8(a.bound_at) - int8(b.bound_at) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
      for (const { address } of holds) {
        await sql`INSERT INTO binding_events (session_id, name, event, at, detail) VALUES (${session}, ${address}, 'released', ${now}, ${reason})`;
      }
      for (const child of children) if (child.root_session_id) {
        await audit(sql, session, "hosted.child_released", { child: child.session_id, reason }, now);
        await endChild(tx, sql, child.session_id, reason, now);
      }
      if (row.lease_deadline !== null) await audit(sql, session, "hosted.lease_closed", { reason, ownership: row.ownership_id }, now);
      return true;
    },
    async childEnd(tx, session, now, reason) {
      const sql = pgOf(tx);
      const row = await lockRow(sql, tx, session);
      // An eviction ends only a child still parked: a request that woke it since the sweep's read keeps it.
      if (!row?.root_session_id || (reason === "evicted" && row.parked_at === null)) return;
      if (capped.has(tx) && !(await dependentsFree(sql, [session]))) return;
      await sql`DELETE FROM hosted_sessions WHERE session_id = ${session}`;
      await audit(sql, row.root_session_id, "hosted.child_released", { child: session, reason }, now);
      await endChild(tx, sql, session, reason, now);
    },
    takeEnded() {
      const taken = ended;
      ended = [];
      return taken;
    },
    async lose(tx, session, lost, now) {
      await pgOf(tx)`INSERT INTO hosted_alias_lost (session_id, alias, reason, was_primary, at) VALUES (${session}, ${lost.alias}, ${lost.reason}, ${lost.primary}, ${now})
        ON CONFLICT (session_id, alias) DO UPDATE SET reason = excluded.reason, was_primary = excluded.was_primary, at = excluded.at,
          told_at = NULL, reported_at = NULL, seen_at = NULL`;
    },
    lost: (r, session, reader) => lostOf(pgOf(r), session, reader),
    async tellLost(tx, session, now) {
      const sql = pgOf(tx);
      return takeLost(sql, session, await sql`UPDATE hosted_alias_lost SET told_at = ${now}
        WHERE session_id = ${session} AND told_at IS NULL RETURNING alias, reason, was_primary, at, seq`);
    },
    async reportLost(tx, session, now) {
      const sql = pgOf(tx);
      await sql`UPDATE hosted_alias_lost SET reported_at = ${now} WHERE session_id = ${session} AND seen_at IS NULL AND reported_at IS NULL`;
      return lostOf(sql, session, "controller");
    },
    async seeLost(tx, session, now) {
      const sql = pgOf(tx);
      return takeLost(sql, session, await sql`UPDATE hosted_alias_lost SET seen_at = ${now}
        WHERE session_id = ${session} AND seen_at IS NULL AND reported_at IS NOT NULL RETURNING alias, reason, was_primary, at, seq`);
    },
    async forgetLost(tx, session, alias) {
      await pgOf(tx)`DELETE FROM hosted_alias_lost WHERE session_id = ${session} AND alias = ${alias}`;
    },
    async aliveAt(r) {
      const [row] = await pgOf(r)`SELECT value FROM server_state WHERE key = 'alive_at'`;
      return row ? int8(row.value) : undefined;
    },
    async heartbeat(tx, now) {
      await pgOf(tx)`INSERT INTO server_state (key, value) VALUES ('alive_at', ${now}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    },
    async setRoot(tx, id, root) {
      await pgOf(tx)`UPDATE ids SET root_id = ${root}::text WHERE id = ${id} AND root_id IS DISTINCT FROM ${root}::text`;
    },
    async reopenId(tx, id) {
      await pgOf(tx)`UPDATE ids SET ended_at = NULL, held_aliases_json = NULL WHERE id = ${id}`;
    },
    async restateWritesAs(tx, id, writesAs) {
      await pgOf(tx)`UPDATE ids SET writes_as = ${writesAs} WHERE id = ${id} AND writes_as IS NULL`;
    },
    // One statement: two declarers get one true between them.
    async declareLauncher(tx, id) {
      return (await pgOf(tx)`UPDATE ids SET launcher = true WHERE id = ${id} AND launcher IS DISTINCT FROM true RETURNING 1`).length > 0;
    },
    async launcher(r, id) {
      const [row] = await pgOf(r)`SELECT launcher FROM ids WHERE id = ${id}`;
      return row?.launcher === true;
    },
    // core HOLD_ORDER.
    holds: async (r: Read) => (await pgOf(r)`SELECT id, address FROM alias_holds ORDER BY bound_at, address`)
      .map((h: Row) => ({ id: h.id as string, address: h.address as string })),
  };
}
