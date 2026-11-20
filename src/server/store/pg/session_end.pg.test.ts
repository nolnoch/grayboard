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
import { DELEGATE_CAP_LOCK, lockCapKeys, makePgDelegation } from "./delegation.ts";
import { makePgSessionEnd } from "./session_end.ts";
import { int8 } from "./sql.ts";
import { pgOf } from "./tx.ts";

const T0 = 1_800_000_000_000;
const S = "id:0000000000001";
const B = "b@example.com", L = `${B}/launcher`, REQ = `${B}/req`;
const S2 = "id:0000000000002", C = "c@example.com", CL = `${C}/launcher`;
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
    const facts = await dl.facts(tx, { to, since: 0, principal: B });
    let d;
    try {
      d = resolveDelegationWith(facts, REQ, B, { persona: "reviewer", task: "review", to }, () => true, () => false, h => h === REQ, facts.open, 2);
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

  // C's launcher CL: its own session S2 holds it.
  const otherUsers = async (p: PgPair) => {
    const sql = p.db.sql;
    await sql`INSERT INTO ids (id, principal, launcher, started_at, last_seen) VALUES (${S2}, ${C}, true, 0, 0)`;
    await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_at, last_seen) VALUES (${CL}, 'person', ${C}, 'launcher', 0, ${T0})`;
    await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${CL}, ${S2}, 0)`;
  };
  const holdCapLock = (target: string) => async (tx: Tx) => { await pgOf(tx)`SELECT pg_advisory_xact_lock(${DELEGATE_CAP_LOCK}::int4, hashtext(${target}))`; };

  // Mutation: the auto-pick locks every launcher (B waits on CL's key, which core would never pick for B's user).
  test("D1: an auto-pick takes no cap lock on another user's launcher: one held on it doesn't make the pick wait", async () => {
    await using p = await pgPair();
    await atCapLessOne(p);
    await otherUsers(p);
    const r = await race(p, holdCapLock(CL), delegate(undefined));
    committed(r.a);
    expect(outcome(r.b)).toBe(`sent to ${L}`);
    expect(r.waited).toBe(false);
  });

  // L is full (2 of 2), so a listed CL would be picked. While B waits on L's key, CL changes hands to B's session S.
  // Mutation: the unlocked, newly matching CL stays listed (B sends to CL, a target whose count it never locked).
  test("D1: a launcher that became the requester's user's after the unlocked read isn't picked: it wasn't locked", async () => {
    await using p = await pgPair();
    await atCapLessOne(p);
    await otherUsers(p);
    const [m] = await p.db.sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES (${REQ}, 'user', ${L}, 'second', 0) RETURNING id`;
    await p.db.sql`INSERT INTO access_log (at, action, target, detail) VALUES (${T0}, 'delegation.requested', ${L}, ${{ message_id: int8(m.id) }})`;
    const r = await race(p, holdCapLock(L), delegate(undefined), async () => { await p.db.sql`UPDATE alias_holds SET id = ${S} WHERE address = ${CL}`; });
    committed(r.a);
    expect(outcome(r.b)).toBe("refused: every live launcher of yours has 2 open delegation requests it hasn't taken (the cap, #252); retry once one replies in a request's thread, or start another launcher");
    expect(r.waitEvent).toBe("advisory");
  });

  // While B waits on L's key, L changes hands to C's session S2. Mutation: users aren't re-read after the lock (B sends
  // to L, now C's launcher, on the stale read that it was B's).
  test("D1: a locked launcher that changed hands to another user while the pick waited isn't picked", async () => {
    await using p = await pgPair();
    await atCapLessOne(p);
    await otherUsers(p);
    await p.db.sql`DELETE FROM alias_holds WHERE address = ${CL}`;
    const r = await race(p, holdCapLock(L), delegate(undefined), async () => { await p.db.sql`UPDATE alias_holds SET id = ${S2} WHERE address = ${L}`; });
    committed(r.a);
    expect(outcome(r.b)).toStartWith("refused: no live launcher session");
    expect(r.waitEvent).toBe("advisory");
  });
});

describePg("delegation cap lock order (Postgres)", () => {
  // Mutation: no ORDER BY (DISTINCT's hash order), or DISTINCT dropped (a repeated target locked twice).
  test("lockCapKeys takes each target's key once, in ascending key order", async () => {
    await using p = await pgPair();
    const targets = Array.from({ length: 60 }, (_, i) => `b@example.com/l${i}`);
    const expected = (await p.db.sql`SELECT DISTINCT hashtext(t) AS k FROM unnest(${targets}::text[]) t`).map((r: Record<string, unknown>) => Number(r.k)).sort((x: number, y: number) => x - y);
    const taken = await p.a.write(async tx => {
      const keys = await lockCapKeys(pgOf(tx), [...targets, ...targets.slice(0, 5)].reverse());
      const [held] = await pgOf(tx)`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = ${DELEGATE_CAP_LOCK}::int8::oid`;
      return { keys, held: int8(held.n) };
    });
    expect(taken.keys).toEqual(expected);
    expect(taken.held).toBe(expected.length);
  });
});
