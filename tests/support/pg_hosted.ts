// The Postgres stores' hosted port (src/server/store/pg/hosted_port.ts) as a recorder, for the OAuth store's tests
// (#807 P3 C4b) until C8's implementation over hosted_sessions exists.
import type { Tx } from "../../src/server/store/tx_base.ts";
import type { PgHostedEnds } from "../../src/server/store/pg/hosted_port.ts";
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
      // FOR NO KEY UPDATE locked it (xmax). A test cluster's xid epoch is 0, so the 32-bit xid is the txid.
      const [u] = await pgOf(tx)`SELECT txid_current_if_assigned()::text IN (xmin::text, xmax::text) AS mine FROM users WHERE id = ${userId}`;
      if (!u?.mine) problems.push(`endForUser(${userId}) without this transaction holding the users row`);
      void now;
      if (fail) { fail = false; throw new Error("hosted end failed"); }
      ended.push({ kind: "user", userId, reason });
    },
  };
  return { port, ended, problems, failNext() { fail = true; } };
}
