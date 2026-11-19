// #807 P3 C3b: the identity contract (identity.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgIdentity and makePgTransactions. Each row gets its own database (principalRows and audits read whole
// tables). The races only Postgres has are identity.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { identityContract, type IdentityBackend, type IdentityStore } from "../identity.contract.ts";
import { makePgIdentity } from "./identity.ts";
import { int8OrNull } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

const pgIdentityBackend: IdentityBackend = {
  kind: "postgres",
  async open(): Promise<IdentityStore> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-identity" });
    const g = makePgIdentity({ now: Date.now });
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      ...g,
      write: fn => s.write(fn),
      read: s.read,
      async disable(userId) { await sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${userId}`; },
      async setIdp(userId, issuer, subject) { await sql`UPDATE users SET idp_issuer = ${issuer}, idp_subject = ${subject} WHERE id = ${userId}`; },
      async setPolicyRaw(teamId, policy) { await sql`UPDATE teams SET policy = ${policy} WHERE id = ${teamId}`; },
      async registerId(id, principal) { await sql`INSERT INTO ids (id, principal, started_at, last_seen) VALUES (${id}, ${principal}, 0, 0)`; },
      async principalRows() {
        return (await sql`SELECT kind, name, user_id, team_id FROM principals ORDER BY id`)
          .map((r: { kind: string; name: string; user_id: unknown; team_id: unknown }) => ({ kind: r.kind, name: r.name, user_id: int8OrNull(r.user_id), team_id: int8OrNull(r.team_id) }));
      },
      // The detail as stored: Bun parses jsonb, so a detail stored as a JSON string comes back a string, and
      // detail_type is the database's own jsonb_typeof.
      async audits(action) {
        return [...await sql`SELECT actor, target, detail, jsonb_typeof(detail) AS detail_type FROM access_log WHERE action = ${action} ORDER BY id`];
      },
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("identity contract (Postgres)", () => identityContract(pgIdentityBackend));
