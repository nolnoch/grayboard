// The Postgres stores' ports (src/server/store/pg/hosted_port.ts) as recorders: the hosted ends, for the OAuth and
// identity stores' tests (#807 P3 C4b), which exercise their callers rather than the hosted store; and the session end
// the hosted store ends a child's ID through (#807 P3 C8b1), until C10d2's.
import type { Tx } from "../../src/server/store/tx_base.ts";
import type { PgHostedEnds, PgSessionEndPort } from "../../src/server/store/pg/hosted_port.ts";
import { pgOf } from "../../src/server/store/pg/tx.ts";

// The hosted port as a recorder: each call checks, on the Tx it was handed, that it runs inside the body after the
// statement that ended what it ends (the grant revoked, the users row written or locked by this transaction), then
// records it. `fail` makes the next call throw, for the rollback row.
type Ended = { kind: "grant"; grantId: string } | { kind: "user"; userId: number; reason: string };
export type HostedRecorder = ReturnType<typeof hostedRecorder>;
export function hostedRecorder() {
  const ended: Ended[] = [];
  const problems: string[] = [];
  let fail = false;
  const port: PgHostedEnds = {
    async endForGrant(tx: Tx, grantId: string, now: number) {
      const [g] = await pgOf(tx)`SELECT revoked_at FROM oauth_grants WHERE id = ${grantId}`;
      if (g?.revoked_at === null || g?.revoked_at === undefined) problems.push(`endForGrant(${grantId}) before its grant was revoked`);
      void now;
      if (fail) { fail = false; throw new Error("hosted end failed"); }
      ended.push({ kind: "grant", grantId });
    },
    async endForUser(tx: Tx, userId: number, reason: string, now: number) {
      // This transaction has taken the users row: setDisabled's UPDATE wrote the version this reads (xmin), revokeAllForUser's
      // FOR NO KEY UPDATE locked it (xmax). pg_current_xact_id_if_assigned() is the 64-bit xid8; its ::xid is the 32-bit
      // xid xmin/xmax carry, whatever the epoch. Limit: when another transaction also holds a lock on the row (an FK
      // insert's KEY SHARE alongside the FOR NO KEY UPDATE), xmax is a multixact id and this reports a false problem;
      // no test here holds such a lock across the call.
      const sql = pgOf(tx);
      const [u] = await sql`SELECT pg_current_xact_id_if_assigned()::xid::text IN (xmin::text, xmax::text) AS mine FROM users WHERE id = ${userId}`;
      if (!u?.mine) problems.push(`endForUser(${userId}) without this transaction holding the users row`);
      // After the user's grants are revoked (hosted_port.ts: the lock order revokeGrant also keeps).
      const [g] = await sql`SELECT count(*)::int AS n FROM oauth_grants WHERE user_id = ${userId} AND revoked_at IS NULL`;
      if (g!.n > 0) problems.push(`endForUser(${userId}) before the user's grants were revoked`);
      void now;
      if (fail) { fail = false; throw new Error("hosted end failed"); }
      ended.push({ kind: "user", userId, reason });
    },
  };
  return { port, ended, problems, failNext() { fail = true; } };
}

// The session end as a recorder (#807 P3 C8 decision 4): marks the ID's `ids.ended_at` on the caller's Tx and writes
// its id.ended row through the audit sink it is handed, as core endSession does (the detail's principal, held, why and
// bounced), and wakes nobody. An ID already ended isn't ended again; one with no ids row ends (endSession's rule).
// `calls` lists every call, committed or not, in order. `bounceOnEnd()`: each later end also writes, from the ID at
// its `now`, two bounces (pending and not) and a direct message, so the store's bounce read has rows to pick from.
export function sessionEndRecorder() {
  const calls: { id: string; why: string; now: number }[] = [];
  let bounce = false;
  const port: PgSessionEndPort = {
    async end(tx, id, { why, now, audit }) {
      const sql = pgOf(tx);
      calls.push({ id, why, now });
      const [row] = await sql`SELECT ended_at, principal FROM ids WHERE id = ${id} FOR UPDATE`;
      if (row && row.ended_at !== null) return { ended: false, held: [], wake: [] };
      await sql`UPDATE ids SET ended_at = ${now} WHERE id = ${id}`;
      if (bounce) {
        await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at, pending, kind) VALUES
          (${id}, 'user', 'them@example.com/a', 'bounced', ${now}, true, 'bounce'),
          (${id}, 'user', ${id}, 'not bounced', ${now}, false, NULL),
          (${id}, 'user', 'them@example.com/b', 'bounced too', ${now}, false, 'bounce')`;
      }
      audit("id.ended", id, id, { principal: (row?.principal as string | null | undefined) ?? null, held: [], why, bounced: 0 });
      return { ended: true, held: [], wake: [] };
    },
  };
  return { port, calls, bounceOnEnd() { bounce = true; } };
}
