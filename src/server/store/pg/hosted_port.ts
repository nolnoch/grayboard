// The hosted-session ends the OAuth and identity stores call on Postgres (#807 P3 C4b, c4-scope decisions 2 and 3):
// a revoked grant ends every hosted session on it, and a disable or revoke-all ends every session of the user, in the
// caller's transaction, as db.ts endHostedWhere does on SQLite. `makePgHostedEnds` implements it over the Postgres
// hosted store (pg/hosted.ts, #807 P3 C8b1); a store whose tests don't need it passes `noHosted`. Each call runs on
// the `tx` it is given, after the statement that revoked the grant or locked the user, so a hosted session inserted
// under that grant or user by a transaction that committed first is seen.
//
// Order: both ends run after the grant revoke. revokeGrant updates the grant, then calls endForGrant; a disable or
// revoke-all (pg/identity.ts revokeUser) updates the user's grants, then calls endForUser. One lock order, grant row
// before hosted rows, so a token revoke racing a disable can't deadlock (40P01) the way grant-then-hosted against
// hosted-then-grant does; and the hosted insert, which reads its grant FOR SHARE first (`grantLive`), waits for either
// revoke and then sees the grant revoked rather than ending up behind a hosted end that already ran. SQLite's single
// writer orders the two whatever db.ts does.
//
// Also the hosted store's own port: a released child's ID end (PgSessionEndPort).
import type { HostedEnd } from "../../hosted-types.ts";
import type { HostedStore } from "../hosted.ts";
import type { SessionEndPort } from "../session_end.ts";
import type { Tx } from "../tx_base.ts";
import { pgOf } from "./tx.ts";

export type PgHostedEnds = {
  endForGrant(tx: Tx, grantId: string, now: number): Promise<void>;
  endForUser(tx: Tx, userId: number, reason: Extract<HostedEnd, "revoked" | "disabled">, now: number): Promise<void>;
};

// For stores whose tests don't exercise hosted sessions: ends nothing.
export const noHosted: PgHostedEnds = { endForGrant: async () => {}, endForUser: async () => {} };

// The session end the Postgres hosted store ends a released child's ID through (#807 P3 C8 decision 7): the server's
// end composed over the Repo's groups (src/server/session_end.ts sessionEndPort), injected so the store imports no
// application code; the same port SQLite's hosted store takes (store/session_end.ts SessionEndPort). C11 wires it once
// Postgres's sessionEnd.end lands (C10d2-b); tests pass a recorder (tests/support/pg_hosted.ts). Its `audit` is
// awaited (#807 P3 C10 Q3): the store passes the sink that writes id.ended to access_log on the end's Tx (pg/audit.ts
// pgCoreAuditSink).
export type PgSessionEndPort = SessionEndPort;

// The revokes' ends over the hosted store's `end`: every root on the grant, or of the user, locked in session_id order
// (one order against another revoke), then each ended with its children. Roots only: a child's grant is its root's
// (attach rewrites every row of an ownership), and only children park, so SQLite's `parked_at IS NULL` adds nothing.
export function makePgHostedEnds(store: HostedStore): PgHostedEnds {
  const endAll = async (tx: Tx, rows: { session_id: string }[], reason: HostedEnd, now: number) => {
    for (const { session_id } of rows) await store.end(tx, session_id, reason, now);
  };
  return {
    async endForGrant(tx, grantId, now) {
      await endAll(tx, await pgOf(tx)`SELECT session_id FROM hosted_sessions
        WHERE grant_id = ${grantId} AND root_session_id IS NULL ORDER BY session_id FOR UPDATE`, "revoked", now);
    },
    async endForUser(tx, userId, reason, now) {
      await endAll(tx, await pgOf(tx)`SELECT session_id FROM hosted_sessions
        WHERE user_id = ${userId} AND root_session_id IS NULL ORDER BY session_id FOR UPDATE`, reason, now);
    },
  };
}
