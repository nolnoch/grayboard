// The claim SQL's concurrent forms (#807 B5b3a). On SQLite a claim tool reads the row before it writes, so these
// guards never fire through a tool; a Postgres store relies on them when two transactions race. Each is driven
// directly here with the state a lost race leaves.
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { claimRow, expireClaims, releaseClaim, takeClaim, type TakeRow } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;
const NOW = 1_000_000;
const row = (key: string, holder: string, expires: number) =>
  db.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, 'held', NULL, 1, ?)`).run(key, holder, expires);
const take = (t: Partial<TakeRow>): TakeRow => ({ key: "k", as: "fe", note: null, board: null, now: NOW, expires: NOW + 60_000, user: null, ...t });

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
});

test("a take over someone else's live claim writes nothing and answers null: the caller reports it held", () => {
  row("k", "be", NOW + 1);
  expect(takeClaim(db, take({}))).toBeNull();
  expect(claimRow(db, "k")).toMatchObject({ holder: "be", note: "held", expires_at: NOW + 1 });
});

test("a take over a lapsed claim, or the holder's own, overwrites it", () => {
  row("k", "be", NOW);
  expect(takeClaim(db, take({}))).toMatchObject({ holder: "fe", acquired_at: NOW, expires_at: NOW + 60_000 });
  // A live renewal keeps the note it leaves out and its acquired time.
  expect(takeClaim(db, take({ now: NOW + 5, expires: NOW + 90_000 }))).toMatchObject({ holder: "fe", acquired_at: NOW, expires_at: NOW + 90_000 });
});

test("a release ends only the named holder's live claim", () => {
  row("lapsed", "be", NOW);
  row("theirs", "sim", NOW + 1);
  row("mine", "be", NOW + 1);
  expect(releaseClaim(db, "lapsed", "be", NOW)).toBeNull();
  expect(releaseClaim(db, "theirs", "be", NOW)).toBeNull();
  expect(releaseClaim(db, "mine", "be", NOW)).toMatchObject({ key: "mine", holder: "be" });
  expect([claimRow(db, "lapsed")?.key, claimRow(db, "theirs")?.key, claimRow(db, "mine")]).toEqual(["lapsed", "theirs", undefined]);
});

test("the sweep's lapses come back in lapse order, by key within a tie, whatever order the delete gave", () => {
  for (const k of ["c", "a", "b"]) row(k, "be", NOW);
  row("queue:work:10", "be", NOW - 1);
  row("queue:work:9", "be", NOW - 2);
  row("live", "be", NOW + 1);
  expect(expireClaims(db, NOW).map(c => c.key)).toEqual(["queue:work:9", "queue:work:10", "a", "b", "c"]);
  expect(claimRow(db, "live")?.key).toBe("live");
});
