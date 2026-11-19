// The hosted-session ends the OAuth and identity stores call on Postgres (#807 P3 C4b, c4-scope decisions 2 and 3):
// a revoked grant ends every hosted session on it, and a disable or revoke-all ends every session of the user, in the
// caller's transaction, as db.ts endHostedWhere does on SQLite. C8 supplies the implementation over hosted_sessions;
// until then tests pass a recorder. Each call runs on the `tx` it is given, after the statement that revoked the grant
// or locked the user, so a hosted session inserted under that grant or user by a transaction that committed first is
// seen.
import type { HostedEnd } from "../../hosted-types.ts";
import type { Tx } from "../tx_base.ts";

export type PgHostedEnds = {
  endForGrant(tx: Tx, grantId: string, now: number): Promise<void>;
  endForUser(tx: Tx, userId: number, reason: Extract<HostedEnd, "revoked" | "disabled">, now: number): Promise<void>;
};

// For stores whose tests don't exercise hosted sessions: ends nothing.
export const noHosted: PgHostedEnds = { endForGrant: async () => {}, endForUser: async () => {} };
