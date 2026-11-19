// #807 P3 C67b: the read points' contract (cursors.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgCursors. Each row gets its own database. The races are cursors.pg.test.ts's. Without
// GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { cursorsContract, type CursorsBackend, type CursorsHarness } from "../cursors.contract.ts";
import { makePgCursors } from "./cursors.ts";
import { makePgTransactions } from "./tx.ts";

const pgCursorsBackend: CursorsBackend = {
  kind: "postgres",
  async open(): Promise<CursorsHarness> {
    const db = await pgDatabase({ max: 1 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-cursors" });
    return {
      cursors: makePgCursors(),
      write: fn => s.write(fn),
      read: s.read,
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("cursors contract (Postgres)", () => cursorsContract(pgCursorsBackend));
