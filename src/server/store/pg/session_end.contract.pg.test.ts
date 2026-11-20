// #807 P3 C10d1: the session end and delegation contracts (session_end.contract.ts, delegation.contract.ts) on Postgres:
// the same rows SQLite runs from db.test.ts, over makePgSessionEnd and makePgDelegation. Each row gets its own database
// (the raw reads read whole tables). The races are session_end.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { expect, test } from "bun:test";
import { TOMBSTONE_HORIZON_MS as CORE_HORIZON } from "../../../core/boards.ts";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { delegationContract } from "../delegation.contract.ts";
import { sessionEndContract, type IdsBackend, type IdsHarness } from "../session_end.contract.ts";
import { makePgDelegation } from "./delegation.ts";
import { makePgSessionEnd, TOMBSTONE_HORIZON_MS } from "./session_end.ts";
import { int8 } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

type Row = Record<string, unknown>;

export const pgIdsBackend: IdsBackend = {
  kind: "postgres",
  async open(): Promise<IdsHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-ids" });
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      sessionEnd: makePgSessionEnd(),
      delegation: makePgDelegation(),
      write: fn => s.write(fn),
      read: s.read,
      async session(id, f = {}) {
        await sql`INSERT INTO ids (id, principal, launcher, viewer, keyed, delivery, writes_as, root_id, ended_at, held_aliases_json, started_at, last_seen)
          VALUES (${id}, ${f.principal ?? null}, ${f.launcher ?? null}::boolean, ${f.viewer ?? false}, ${f.keyed ?? false}, ${f.delivery ?? "push"},
            ${f.writesAs ?? null}, ${f.rootId ?? null}, ${f.endedAt ?? null}::int8, ${f.held ? JSON.stringify(f.held) : null}::text::jsonb, 0, 0)`;
      },
      async alias(address, f = {}) {
        const at = address.lastIndexOf("/");
        await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, human, created_at, last_seen)
          VALUES (${address}, 'person', ${address.slice(0, at)}, ${address.slice(at + 1)}, ${f.human ?? null}::boolean, 0, ${f.lastSeen ?? null}::int8)`;
      },
      async hold(address, id, boundAt) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, ${boundAt})`; },
      async bound(address, id, at) { await sql`INSERT INTO binding_events (session_id, name, event, at) VALUES (${id}, ${address}, 'bound', ${at})`; },
      async message(sender, recipient, parentId = null) {
        const [r] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at)
          VALUES (${sender}, 'user', ${recipient}, 'm', ${parentId}::int8, 0) RETURNING id`;
        return int8(r.id);
      },
      async ack(reader, messageId) { await sql`INSERT INTO dm_acks (reader, message_id, acked_at) VALUES (${reader}, ${messageId}, 0)`; },
      async requested(target, at, messageId) {
        await sql`INSERT INTO access_log (at, actor, action, target, detail)
          VALUES (${at}, 'b@example.com', 'delegation.requested', ${target}, ${{ requester: "c@example.com/req", via: "explicit", message_id: messageId }})`;
      },
      async tombstone(id, endedAt, prunedAt) { await sql`INSERT INTO pruned_ids (id, ended_at, pruned_at) VALUES (${id}, ${endedAt}, ${prunedAt})`; },
      idRows: async () => (await sql`SELECT id FROM ids ORDER BY id`).map((r: Row) => r.id as string),
      prunedRows: async () => (await sql`SELECT id, ended_at, pruned_at FROM pruned_ids ORDER BY id`)
        .map((r: Row) => ({ id: r.id as string, ended_at: int8(r.ended_at), pruned_at: int8(r.pruned_at) })),
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("session end contract (Postgres)", () => sessionEndContract(pgIdsBackend));
describePg("delegation contract (Postgres)", () => delegationContract(pgIdsBackend));

test("the Postgres tombstone horizon is core's", () => {
  expect(TOMBSTONE_HORIZON_MS).toBe(CORE_HORIZON);
});
