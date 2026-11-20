// #1069: team create against a board_create of its name on Postgres, through a server (pg_server.ts, its pool on side
// b) and a second transaction store on its database (side a), in T-P12's shape (tests/support/pg_race.ts raceRequest).
// A creates the public board and holds its transaction open; B is POST /api/teams for the same name, whose board check
// reads before A commits. B's board insert (ON CONFLICT DO NOTHING) waits on A's uncommitted row, then inserts nothing:
// the create must refuse as its check refuses, and roll the team back, rather than hand the team A's public board.
// The SQLite form (a trigger in the gap) is in board_create_taken.test.ts. Without GRAYBOARD_TEST_PG_URL it skips.
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg } from "../support/pg.ts";
import { committed, outcome, raceRequest } from "../support/pg_race.ts";
import { pgServers } from "../support/pg_server.ts";
import { callBoardTool } from "../../src/server/boards.ts";
import { makePgTransactions } from "../../src/server/store/pg/tx.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03 or 40P01, not on Bun's timeout.
setDefaultTimeout(30_000);

const W = "w@example.com", FE = `${W}/fe`;
// The kinds a wait on another transaction's uncommitted row shows: the tuple lock, or the holder's xid once queued.
const ROW_LOCK = ["tuple", "transactionid"];

describePg("team create against board_create of its name, through a server on Postgres", () => {
  // Mutation: teamCreate ignoring ensureTeamBoard's false: B answers 201 and the team's board is A's public one.
  test("a team create whose board check ran before an in-flight board_create waits, then refuses and rolls back", async () => {
    await using pg = await pgServers(1, { sides: ["b"], overrides: { hostedRequestLimit: { burst: 10_000, perSec: 10_000 } } });
    await using a = { s: makePgTransactions(pg.db.url, { max: 2, applicationName: "gb-test-a" }), async [Symbol.asyncDispose]() { await this.s.close(); } };
    const srv = pg.servers[0]!;
    const fe = await srv.hosted(W, "fe");
    await fe.call("board_list", {});
    const bob = await srv.login("bob@example.com");
    const r = await raceRequest({ db: pg.db, a: a.s },
      tx => callBoardTool(srv.app.repo, srv.app.application.access, tx, FE, "board_create", { name: "qa", purpose: "lobby" }, { addresses: [FE] }),
      () => srv.api(bob, "POST", "/api/teams", { name: "qa" }));
    committed(r.a);
    expect(outcome(r.b)).toEqual({ status: 409, body: { code: "conflict", message: 'a board named "#qa" already exists' } });
    expect((await srv.api(bob, "GET", "/api/teams")).body).toEqual([]);
    expect(await pg.db.sql`SELECT name FROM teams`).toEqual([]);
    expect(await pg.db.sql`SELECT name FROM principals WHERE name = 'qa'`).toEqual([]);
    expect(await pg.db.sql`SELECT action FROM access_log WHERE target = 'qa' AND action <> 'board.created'`).toEqual([]);
    expect(await pg.db.sql`SELECT scope, created_by FROM boards WHERE name = 'qa'`).toEqual([{ scope: null, created_by: FE }]);
    expect(r.waited).toBe(true);
    expect(ROW_LOCK).toContain(r.waitEvent ?? "none");
  });
});
