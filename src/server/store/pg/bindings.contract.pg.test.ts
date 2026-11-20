// #807 P3 C10a-b: the bindings contract (bindings.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgBindings (with the Postgres aliases store's lock) on a fixed clock. Each row gets its own database (the raw
// reads read whole tables). The races are bindings.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { expect, test } from "bun:test";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { REFUSED_COALESCE_MS as CORE_COALESCE_MS } from "../../../core/bindings.ts";
import { bindingsContract, type BindingsBackend, type BindingsHarness } from "../bindings.contract.ts";
import { makePgAliases } from "./aliases.ts";
import { makePgBindings, REFUSED_COALESCE_MS } from "./bindings.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

type Row = Record<string, unknown>;
// The store's clock: registerId's started_at and last_seen, and the stamps a caller leaves out.
const CLOCK = 1_800_000_000_000;

const pgBindingsBackend: BindingsBackend = {
  kind: "postgres",
  async open(): Promise<BindingsHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-bindings" });
    const aliases = makePgAliases({ clock: () => CLOCK });
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      bindings: makePgBindings({ clock: () => CLOCK, aliases }),
      write: fn => s.write(fn),
      read: s.read,
      alias: (scopeRef, name) => s.write(async tx => (await aliases.create(tx, { scope_kind: "person", scope_ref: scopeRef, name }, scopeRef))!.address),
      async hold(address, id, boundAt) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, ${boundAt})`; },
      async end(id, at) { await sql`UPDATE ids SET ended_at = ${at} WHERE id = ${id}`; },
      async started(id, at) { await sql`UPDATE ids SET started_at = ${at} WHERE id = ${id}`; },
      async tombstone(id, endedAt, prunedAt) { await sql`INSERT INTO pruned_ids (id, ended_at, pruned_at) VALUES (${id}, ${endedAt}, ${prunedAt})`; },
      holdRows: async () => (await sql`SELECT address, id, bound_at FROM alias_holds ORDER BY address`)
        .map((r: Row) => ({ address: r.address as string, id: r.id as string, bound_at: int8(r.bound_at) })),
      events: async () => (await sql`SELECT session_id, name, event, at, detail, count, last_at FROM binding_events ORDER BY id`)
        .map((r: Row) => ({
          session_id: r.session_id as string, name: r.name as string, event: r.event as string, at: int8(r.at), detail: r.detail as string | null,
          count: int8OrNull(r.count), last_at: int8OrNull(r.last_at),
        })),
      aliasRow: async address => (await sql`SELECT last_seen, queue_off, task, owner, source_board, spec_hash, description FROM aliases WHERE address = ${address}`)
        .map((r: Row) => ({
          last_seen: int8OrNull(r.last_seen), queue_off: r.queue_off as boolean | null, task: r.task as string | null, owner: r.owner as string | null,
          source_board: r.source_board as string | null, spec_hash: r.spec_hash as string | null, description: r.description as string | null,
        }))[0],
      idColumns: async id => (await sql`SELECT harness, cwd, delivery, keyed, local_resume, root_id, harness_session, started_at, last_seen FROM ids WHERE id = ${id}`)
        .map((r: Row) => ({
          harness: r.harness as string | null, cwd: r.cwd as string | null, delivery: r.delivery as string, keyed: r.keyed === true,
          local_resume: r.local_resume === true, root_id: r.root_id as string | null, harness_session: r.harness_session as string | null,
          started_at: int8(r.started_at), last_seen: int8(r.last_seen),
        }))[0],
      tombstones: async () => (await sql`SELECT id, ended_at, pruned_at FROM pruned_ids ORDER BY id`)
        .map((r: Row) => ({ id: r.id as string, ended_at: int8(r.ended_at), pruned_at: int8(r.pruned_at) })),
      audits: async action => [...await sql`SELECT actor, target, detail FROM access_log WHERE action = ${action} ORDER BY id`],
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("bindings contract (Postgres)", () => bindingsContract(pgBindingsBackend));

test("the Postgres store's refusal window is core's", () => {
  expect(REFUSED_COALESCE_MS).toBe(CORE_COALESCE_MS);
});
