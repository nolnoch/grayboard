// #807 P3 C67b: the Slack bridge store's contract (slack.contract.ts) on Postgres: the same rows SQLite runs from
// db.test.ts, over makePgSlack on a fixed clock, with the users rows and raw reads on the database's own pool. Each row
// gets its own database. The races are slack.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { slackContract, type SlackBackend, type SlackHarness } from "../slack.contract.ts";
import { makePgSlack } from "./slack.ts";
import { int8 } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

type Row = Record<string, unknown>;

const pgSlackBackend: SlackBackend = {
  kind: "postgres",
  async open(): Promise<SlackHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-slack" });
    const sql = db.sql;
    let now = 0;
    return {
      slack: makePgSlack({ clock: () => now }),
      write: fn => s.write(fn),
      read: s.read,
      setNow: ms => { now = ms; },
      user: async email => int8((await sql`INSERT INTO users (email, created_at) VALUES (${email}, 0) RETURNING id`)[0].id),
      threadRows: async () => (await sql`SELECT user_id, thread_ts, kind, board, root_id, peer, last_id FROM slack_threads ORDER BY user_id, thread_ts`)
        .map((r: Row) => ({ ...r, user_id: int8(r.user_id), root_id: int8(r.root_id), last_id: int8(r.last_id) }) as Awaited<ReturnType<SlackHarness["threadRows"]>>[number]),
      progressRows: async () => (await sql`SELECT user_id, ref FROM slack_progress ORDER BY user_id, ref`)
        .map((r: Row) => ({ user_id: int8(r.user_id), ref: r.ref as string })),
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("slack contract (Postgres)", () => slackContract(pgSlackBackend));
