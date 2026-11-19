// #807 P3 C67b: the audit store on Postgres beyond its contract (c6c7-scope §5.2 T-C7-3/4, docs/future/postgres-server.md
// D3, D8 A6h): the owed bridge notice's race in T-P12's shape (tests/support/pg_race.ts), running the real
// owedBridgeNotice over a minimal repo; an eager audit write the database refuses; and the pin of `last`'s order. The
// end state is asserted before `waited`, so a race whose lock is gone fails on what it broke (two notices), not on a
// timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { afterEach, expect, spyOn, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, settle, type PgPair } from "../../../../tests/support/pg_race.ts";
import { owedBridgeNotice } from "../../application.ts";
import type { Repo } from "../../db.ts";
import { makePgAudit, PG_ACCESS_LOG_LAST_SQL } from "./audit.ts";
import { makePgCursors } from "./cursors.ts";
import { TxAborted } from "./tx.ts";

const T0 = 1_800_000_000_000;
const EMAIL = "a@example.com";
const TARGET = `${EMAIL}/human`;
const audit = makePgAudit();
// What owedBridgeNotice and writeAudit reach of a Repo; a post would mean an audit row off the body's Tx.
const repo = {
  audit, now: () => T0,
  post: () => { throw new Error("writeAudit posted: the row left the body's transaction"); },
} as unknown as Repo;

const actions = async (p: PgPair, action: string) => (await p.db.sql`SELECT target FROM access_log WHERE action = ${action} ORDER BY id`).length;

describePg("audit store (Postgres)", () => {
  let errors: ReturnType<typeof spyOn<Console, "error">> | undefined;
  afterEach(() => { errors?.mockRestore(); errors = undefined; });

  // Mutation: audit.lock a no-op (B reads no notice while A's is uncommitted, and both deliver).
  test("T-C7-3: two binds owed one bridge notice: one delivers it, the other finds it delivered", async () => {
    await using p = await pgPair();
    await p.a.write(async tx => {
      audit.write(tx, { at: T0 - 10, actor: null, action: "bridge.stopped", target: TARGET, detail: JSON.stringify({ reason: "token revoked", at: "2027-01-15T08:00:00.000Z" }) });
    });
    const r = await race(p, tx => owedBridgeNotice(repo, tx, EMAIL), tx => owedBridgeNotice(repo, tx, EMAIL));
    expect(committed(r.a)).toContain("your Slack bridge stopped at 2027-01-15T08:00:00.000Z (token revoked)");
    expect(outcome(r.b)).toBeUndefined();
    expect(await actions(p, "bridge.notified")).toBe(1);
    expect(r.waitEvent).toBe("advisory");
  });

  // Mutations: write sent outside the transaction (posted, or on afterCommit: the body's other rows commit and the
  // write resolves); its .catch removed (bun fails the test on the insert's unhandled rejection).
  test("T-C7-4: a write the database refuses aborts the body's transaction: the write rejects TxAborted and nothing commits", async () => {
    await using p = await pgPair();
    // A test trigger in this database only: an access_log row whose action is "refused" fails 23514.
    await p.db.sql.unsafe(`CREATE FUNCTION refuse_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'refused' THEN RAISE EXCEPTION 'refused % row', NEW.target USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`);
    await p.db.sql.unsafe("CREATE TRIGGER refuse_row BEFORE INSERT ON access_log FOR EACH ROW EXECUTE FUNCTION refuse_row()");
    const cursors = makePgCursors();
    errors = spyOn(console, "error").mockImplementation(() => {});
    const row = (action: string, target: string) => ({ at: T0, actor: null, action, target, detail: JSON.stringify({ n: 1 }) });
    // The refused row last in the body: its COMMIT is rolled back.
    const last = await settle(p.a.write(async tx => {
      await cursors.advance(tx, "a@example.com/fe", "direct", "a@example.com/fe", 5);
      audit.write(tx, row("kept", "first"));
      audit.write(tx, row("refused", "secret-target"));
    }));
    // A statement after it: that statement fails 25P02.
    const after = await settle(p.a.write(async tx => {
      audit.write(tx, row("kept", "second"));
      audit.write(tx, row("refused", "secret-target"));
      await cursors.advance(tx, "a@example.com/fe", "direct", "a@example.com/fe", 7);
    }));
    for (const s of [last, after]) expect(s.ok ? "committed" : s.error).toBeInstanceOf(TxAborted);
    expect((await p.db.sql`SELECT count(*)::int AS n FROM access_log`)[0].n).toBe(0);
    expect((await p.db.sql`SELECT count(*)::int AS n FROM mailbox_cursors`)[0].n).toBe(0);
    // Each refused insert's own failure is logged once, as its class and SQLSTATE: never its text, which quotes the row.
    const logged = errors.mock.calls.filter((c: unknown[]) => c[0] === "[grayboard] audit row insert failed:").map((c: unknown[]) => c[1]);
    expect(logged).toEqual([
      { class: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", sqlstate: "23514" },
      { class: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", sqlstate: "23514" },
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-target");
  });

  // C67a audit m2: Postgres breaks a tie in `at` by heap order, so no serial contract row (U3) tells `ORDER BY at DESC`
  // alone from (at, id); the text pins it, as db.test.ts pins SQLite's ACCESS_LOG_LAST_SQL.
  test("audit.last orders by (at, id), newest first", () => {
    expect(PG_ACCESS_LOG_LAST_SQL).toContain("ORDER BY at DESC, id DESC LIMIT 1");
  });
});
