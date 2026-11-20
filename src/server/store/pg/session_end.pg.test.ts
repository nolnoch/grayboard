// #807 P3 C10d1: the session end and delegation stores' races on Postgres (c10-scope §2 C10d1: E2 lock shape, D1,
// R-pruneEnded; docs/future/postgres-server.md D3), each in T-P12's shape (tests/support/pg_race.ts): A's body holds its
// transaction open at a gate, B's starts, and the race waits until B is blocked on a lock or done. The end state is
// asserted before `waited`, so a race whose lock is gone fails on what it broke, not on a timeout. The full send-vs-end
// race needs the Postgres end (C10d2-b); until then E2's A side is the end's lock as a raw `SELECT … FOR UPDATE`.
// Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import { resolveDelegationWith } from "../../../core/delegation.ts";
import { CoreError } from "../../../core/errors.ts";
import type { Tx } from "../tx_base.ts";
import { makePgDelegation } from "./delegation.ts";
import { makePgSessionEnd } from "./session_end.ts";
import { int8 } from "./sql.ts";
import { pgOf } from "./tx.ts";

const T0 = 1_800_000_000_000;
const S = "id:0000000000001";
const B = "b@example.com", L = `${B}/launcher`, REQ = `${B}/req`;
const se = makePgSessionEnd();
const dl = makePgDelegation();

const refusal = async (tx: Tx) => { const why = await se.refusal(tx, S); return why && `${why.code}: ${why.detail}`; };

describePg("session end races (Postgres)", () => {
  // Mutation: refusal reads without a lock (B doesn't wait, and reads the ID live while its end is in flight).
  test("E2 lock shape: a held end's FOR UPDATE on the ID's row makes refusal wait, and it then reads the ID ended", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO ids (id, principal, started_at, last_seen) VALUES (${S}, ${B}, 0, 0)`;
    const r = await race(p, async tx => {
      const sql = pgOf(tx);
      await sql`SELECT id FROM ids WHERE id = ${S} FOR UPDATE`;
      await sql`UPDATE ids SET ended_at = ${T0}, held_aliases_json = '["b@example.com/be"]'::jsonb WHERE id = ${S}`;
    }, refusal);
    committed(r.a);
    expect(outcome(r.b)).toBe(`id_ended: ${S} ended at ${new Date(T0).toISOString()}; it held \`b@example.com/be\``);
    expect(r.waited).toBe(true);
  });

  // Mutation: FOR SHARE (B waits behind the touch's FOR NO KEY UPDATE).
  test("E2 lock shape: a held presence touch (UPDATE ids SET last_seen) doesn't make refusal wait", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO ids (id, principal, started_at, last_seen) VALUES (${S}, ${B}, 0, 0)`;
    const r = await race(p, async tx => { await pgOf(tx)`UPDATE ids SET last_seen = ${T0} WHERE id = ${S}`; }, refusal);
    committed(r.a);
    expect(outcome(r.b)).toBeNull();
    expect(r.waited).toBe(false);
  });

  // No mutation beyond C10a-b's T5 (c10-scope §2): the send's KEY SHARE is what the prune's DELETE waits on.
  test("R-pruneEnded: a prune deleting an ended row waits on a send's refusal, which read it ended", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO ids (id, principal, started_at, last_seen, ended_at, keyed) VALUES (${S}, ${B}, 0, 0, ${T0 - 10}, true)`;
    const r = await race(p, refusal, tx => se.pruneEnded(tx, T0, T0 + 100));
    expect(committed(r.a)).toBe(`id_ended: ${S} ended at ${new Date(T0 - 10).toISOString()}; it held no alias`);
    expect(outcome(r.b)).toBe(1);
    expect((await p.db.sql`SELECT id FROM ids`).length).toBe(0);
    expect(r.waited).toBe(true);
  });
});

describePg("delegation races (Postgres)", () => {
  // A launcher L (its session holds it and was seen) with one open request, at a cap of 2.
  const atCapLessOne = async (p: PgPair) => {
    const sql = p.db.sql;
    await sql`INSERT INTO ids (id, principal, launcher, started_at, last_seen) VALUES (${S}, ${B}, true, 0, 0)`;
    await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_at, last_seen) VALUES (${L}, 'person', ${B}, 'launcher', 0, ${T0})`;
    await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${L}, ${S}, 0)`;
    const [m] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES (${REQ}, 'user', ${L}, 'first', 0) RETURNING id`;
    await sql`INSERT INTO access_log (at, action, target, detail) VALUES (${T0}, 'delegation.requested', ${L}, ${{ message_id: int8(m.id) }})`;
  };
  // The delegate path's body (application.ts handleDelegate): facts on the Tx, core's decision over them, then the
  // request's message and its delegation.requested row on the same Tx.
  const delegate = (to: string | undefined) => async (tx: Tx) => {
    const facts = await dl.facts(tx, { to, since: 0 });
    let d;
    try {
      d = resolveDelegationWith(facts, REQ, B, { persona: "reviewer", task: "review", to }, () => true, undefined, h => h === REQ, facts.open, 2);
    } catch (e) {
      if (e instanceof CoreError) return `refused: ${e.message}`;
      throw e;
    }
    const sql = pgOf(tx);
    const [m] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES (${REQ}, 'user', ${d.to}, ${d.body}, 0) RETURNING id`;
    await sql`INSERT INTO access_log (at, action, target, detail) VALUES (${T0 + 1}, 'delegation.requested', ${d.to}, ${{ message_id: int8(m.id) }})`;
    return `sent to ${d.to}`;
  };
  const requests = async (p: PgPair) => (await p.db.sql`SELECT count(*) AS n FROM access_log WHERE action = 'delegation.requested' AND target = ${L}`)[0].n;

  // Mutation: facts takes no DELEGATE_CAP_LOCK (both count 1 of 2 and send: 3 open requests at a cap of 2).
  for (const [name, to, refusedText] of [
    ["named", L, `"${L}" has 2 open delegation requests it hasn't taken (the cap, #252); retry once it replies in one's thread, or pass another launcher`],
    ["auto-picked", undefined, "every live launcher of yours has 2 open delegation requests it hasn't taken (the cap, #252); retry once one replies in a request's thread, or start another launcher"],
  ] as const) {
    test(`D1: two delegations to one ${name} launcher at cap-1: one is sent, the other refused at the cap`, async () => {
      await using p = await pgPair();
      await atCapLessOne(p);
      const r = await race(p, delegate(to), delegate(to));
      expect([committed(r.a), outcome(r.b)]).toEqual([`sent to ${L}`, `refused: ${refusedText}`]);
      expect(int8(await requests(p))).toBe(2);
      expect(r.waitEvent).toBe("advisory");
    });
  }
});
