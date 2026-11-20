// #807 P3 C10b: the claims contract (claims.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts, over
// makePgClaims on a fixed clock. Each row gets its own database (the raw reads read whole tables). The races are
// claims.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { claimsContract, type ClaimsBackend, type ClaimsHarness } from "../claims.contract.ts";
import type { ClaimRow } from "../claims.ts";
import { makePgClaims } from "./claims.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

type Row = Record<string, unknown>;

const pgClaimsBackend: ClaimsBackend = {
  kind: "postgres",
  async open(): Promise<ClaimsHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-claims" });
    let now = 0;
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      claims: makePgClaims({ clock: () => now }),
      write: fn => s.write(fn),
      read: s.read,
      setNow: ms => { now = ms; },
      async board(name) { await sql`INSERT INTO boards (name, purpose, created_by, created_at) VALUES (${name}, '', 'test', 0)`; },
      async session(id, principal) { await sql`INSERT INTO ids (id, principal, started_at, last_seen) VALUES (${id}, ${principal}, 0, 0)`; },
      async hold(address, id) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, 0)`; },
      async claim(c) {
        await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
          VALUES (${c.key}, ${c.holder}, ${c.note}, ${c.board}, ${c.acquired_at}, ${c.expires_at}, ${c.holder_user})`;
      },
      claimRows: async () => (await sql`SELECT * FROM claims ORDER BY key`).map((r: Row): ClaimRow => ({
        key: r.key as string, holder: r.holder as string, note: r.note as string | null, board: r.board as string | null,
        acquired_at: int8(r.acquired_at), expires_at: int8(r.expires_at), holder_user: r.holder_user as string | null,
      })),
      watchRows: async () => [...await sql`SELECT key, handle FROM claim_watches ORDER BY key, handle`],
      eventRows: async () => (await sql`SELECT key, handle, event, note, board, expires_at, held_by, at FROM claim_events ORDER BY id`)
        .map((r: Row) => ({ ...r, expires_at: int8OrNull(r.expires_at), at: int8(r.at) })),
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("claims contract (Postgres)", () => claimsContract(pgClaimsBackend));
