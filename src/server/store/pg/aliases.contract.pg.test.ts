// #807 P3 C5b: the aliases contract (aliases.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts, over
// makePgAliases on a fixed clock. Each row gets its own database (aliasRows() and cursorRows() read whole tables).
// The races are aliases.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { aliasesContract, type AliasesBackend, type AliasesHarness } from "../aliases.contract.ts";
import { makePgAliases } from "./aliases.ts";
import { makePgTransactions } from "./tx.ts";

const pgAliasesBackend: AliasesBackend = {
  kind: "postgres",
  async open(): Promise<AliasesHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-aliases" });
    let now = 0;
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      aliases: makePgAliases({ clock: () => now }),
      write: fn => s.write(fn),
      read: s.read,
      setNow: ms => { now = ms; },
      async session(id, f) {
        await sql`INSERT INTO ids (id, principal, cwd, place, started_at, last_seen, ended_at) VALUES (${id}, NULL, ${f.cwd ?? null}, ${f.place ?? null}, 0, 0, ${f.endedAt ?? null})`;
      },
      async hold(address, id) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, 0)`; },
      async bound(address, id, at) { await sql`INSERT INTO binding_events (session_id, name, event, at) VALUES (${id}, ${address}, 'bound', ${at})`; },
      async cursor(address, lastSeenId, streamRef = address) {
        await sql`INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (${address}, 'direct', ${streamRef}, ${lastSeenId})`;
      },
      async touch(address, at) { await sql`UPDATE aliases SET last_seen = ${at} WHERE address = ${address}`; },
      aliasRows: async () => [...await sql`SELECT address, created_by_principal FROM aliases`],
      cursorRows: async () => [...await sql`SELECT address, stream_ref FROM mailbox_cursors`],
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("aliases contract (Postgres)", () => aliasesContract(pgAliasesBackend));
