// #807 P3 C10d2-b: the server's composed session end on Postgres (session_end.ts endSessionServer over the Postgres
// groups, tests/support/pg_repo.ts) and its races (c10-scope §3 C10d2-b: E1-E4, the hosted port, C10d2-a's open rows,
// the lock order), each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open, B's starts,
// and the race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose
// lock is gone fails on what it broke (a send, hold, claim or child left on an ended ID, a second end), not on a
// timeout. A send is writeSend's body as far as the end bears on it (application.ts: the recipient's refusal, then the
// insert), restated over the stores. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg } from "../../tests/support/pg.ts";
import { blockedOrSettled, committed, outcome, pgPair, race, settle, type PgPair } from "../../tests/support/pg_race.ts";
import { gate, pgRepo } from "../../tests/support/pg_repo.ts";
import { idAddress } from "../core/bindings.ts";
import { boardAccess } from "./access.ts";
import { serverClaim, sweepClaims } from "./claims.ts";
import type { Repo } from "./db.ts";
import { endSessionServer } from "./session_end.ts";
import type { HostedSession } from "./hosted-types.ts";
import { pgCoreAuditSink } from "./store/pg/audit.ts";
import { int8 } from "./store/pg/sql.ts";
import type { Tx } from "./store/tx_base.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03 or 40P01, not on Bun's timeout.
setDefaultTimeout(30_000);

type Row = Record<string, unknown>;
const T0 = 1_800_000_000_000;
const W = "w@example.com", B = "b@example.com";
const R = idAddress("root"), C = idAddress("child"), X = idAddress("other"), N = idAddress("new child");
const WBE = `${W}/be`, WFE = `${W}/fe`, BBE = `${B}/be`;

// R (W's) holds w/be and has a child C; X (B's) holds b/be. Boards general and q (a queue), a post on q; R holds a
// ticket claim on general and q's post; B/be wrote R one unread message.
async function world(p: PgPair): Promise<{ repo: Repo; qp: number; mail: number }> {
  const sql = p.db.sql;
  await sql`INSERT INTO ids (id, principal, launcher, started_at, last_seen, root_id) VALUES
    (${R}, ${W}, false, 0, 0, NULL), (${X}, ${B}, false, 0, 0, NULL), (${C}, ${W}, false, 0, 0, ${R})`;
  await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_at, last_seen) VALUES
    (${WBE}, 'person', ${W}, 'be', 0, 0), (${WFE}, 'person', ${W}, 'fe', 0, 0), (${BBE}, 'person', ${B}, 'be', 0, 0)`;
  await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${WBE}, ${R}, 1), (${BBE}, ${X}, 1)`;
  await sql`INSERT INTO boards (name, purpose, created_by, created_at, kind) VALUES ('general', 'p', ${BBE}, 0, 'broadcast'), ('q', 'p', ${BBE}, 0, 'queue')`;
  const qp = int8((await sql`INSERT INTO posts (board, author, body, created_at) VALUES ('q', ${BBE}, 'task', ${T0}) RETURNING id`)[0].id);
  await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES
    ('ticket:ENG-142', ${R}, 'held', 'general', ${T0}, ${T0 + 3_600_000}), (${`queue:q:${qp}`}, ${R}, 'queue post', 'q', ${T0}, ${T0 + 3_600_000})`;
  const mail = int8((await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES (${BBE}, 'user', ${R}, 'hello', ${T0}) RETURNING id`)[0].id);
  return { repo: pgRepo(p, () => T0 + 10), qp, mail };
}

const end = (repo: Repo, id = R, now = T0 + 10) => (tx: Tx) =>
  endSessionServer(repo, boardAccess(repo, "team"), tx, id, { why: "closed", now, audit: pgCoreAuditSink(tx, now) });

// writeSend's body as far as the end bears on it: the recipient's refusal (FOR KEY SHARE on its ids row), then the insert.
const send = (repo: Repo, to = R, body = "late") => async (tx: Tx) => {
  const why = await repo.sessionEnd.refusal(tx, to);
  if (why) return `refused ${why.code}`;
  return (await repo.messages.insert(tx, BBE, "user", to, body, null)).id;
};

const take = (repo: Repo, id = R, address = WFE) => (tx: Tx) => repo.bindings.take(tx, address, id, W, T0 + 20);

const q = (p: PgPair) => p.db.sql;
const idsRow = async (p: PgPair, id: string) => (await q(p)`SELECT ended_at, held_aliases_json, jsonb_typeof(held_aliases_json) AS t FROM ids WHERE id = ${id}`)[0] as Row;
const holdsOf = async (p: PgPair, id: string) => (await q(p)`SELECT address FROM alias_holds WHERE id = ${id} ORDER BY address`).map((r: Row) => r.address);
const claimsOf = async (p: PgPair, id: string) => (await q(p)`SELECT key FROM claims WHERE holder = ${id} ORDER BY key`).map((r: Row) => r.key);
const ended = async (p: PgPair) => (await q(p)`SELECT target, detail FROM access_log WHERE action = 'id.ended' ORDER BY id`) as Row[];
const mailTo = async (p: PgPair, to: string) => (await q(p)`SELECT sender, body, kind FROM messages WHERE recipient = ${to} ORDER BY id`) as Row[];

// race() with A held mid-way through its body: `held` is a gate on a store method A calls (pg_repo.ts gate). B starts
// once A reaches it and runs until it blocks or settles; then A goes on.
async function midRace<TA, TB>(p: PgPair, first: (tx: Tx) => Promise<TA>, held: ReturnType<typeof gate>, second: (tx: Tx) => Promise<TB>) {
  const a = settle(p.a.write(first));
  let done = false, waitEvent: string | null = null, b;
  try {
    await Promise.race([held.reached, a]);
    b = settle(p.b.write(second)).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
  } finally {
    held.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null, waitEvent };
}

describePg("session end, composed on Postgres", () => {
  test("an end writes what SQLite's does: the row ended with its holds as a jsonb array, bounces, releases, the child, two id.ended rows; a second end changes nothing", async () => {
    await using p = await pgPair();
    const { repo, qp } = await world(p);
    const r = await p.a.write(end(repo));
    expect(r.ended).toBe(true);
    expect(r.held).toEqual([WBE]);
    expect(await idsRow(p, R)).toEqual({ ended_at: String(T0 + 10), held_aliases_json: [WBE], t: "array" });
    expect((await idsRow(p, C)).ended_at).toBe(String(T0 + 10));
    expect(await holdsOf(p, R)).toEqual([]);
    expect(await claimsOf(p, R)).toEqual([]);
    expect((await mailTo(p, BBE)).map(m => m.kind)).toEqual(["bounce"]);
    expect((await ended(p)).map(e => e.target)).toEqual([C, R]);
    expect((await ended(p))[1]!.detail).toMatchObject({ principal: W, held: [WBE], why: "closed", bounced: 1 });
    // Both claims released, in post-id-then-key order (session_end.ts queuePostOrder).
    expect(await q(p)`SELECT key, event, note FROM claim_events ORDER BY id`).toEqual([
      { key: `queue:q:${qp}`, event: "release", note: "session ended" }, { key: "ticket:ENG-142", event: "release", note: "session ended" }]);
    // refusal names what it held, read from the jsonb.
    expect(await p.a.write(send(repo))).toBe("refused id_ended");
    expect(await p.a.write(end(repo))).toEqual({ ended: false, held: [], wake: [] });
    expect((await ended(p)).length).toBe(2);
  });

  test("lockLive: true for a live ID, false for an ended one, null for no row; take refuses unless true", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    await q(p)`UPDATE ids SET ended_at = ${T0} WHERE id = ${X}`;
    expect(await p.a.write(async tx => [await repo.bindings.lockLive(tx, R), await repo.bindings.lockLive(tx, X), await repo.bindings.lockLive(tx, N)]))
      .toEqual([true, false, null]);
    expect(await p.a.write(async tx => [await take(repo, X)(tx), await take(repo, N)(tx)])).toEqual([null, null]);
  });

  test("an ID with no row ends as core's does: nothing marked, principal null", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await p.a.write(end(repo, N));
    expect(r.ended).toBe(true);
    expect((await ended(p))[0]!.detail).toMatchObject({ principal: null, held: [] });
  });
});

describePg("session end races (Postgres)", () => {
  // E1. Mutation: the UPDATE without `ended_at IS NULL` (B's FOR UPDATE waits, then marks it again: a second id.ended).
  // Without FOR UPDATE, B waits at the UPDATE instead and still returns false: E2's send-first row is that mutant's.
  test("E1: two ends of one ID: the second waits, then changes nothing; one id.ended per ID", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, end(repo), end(repo));
    expect(committed(r.a).ended).toBe(true);
    expect(outcome(r.b)).toEqual({ ended: false, held: [], wake: [] });
    expect((await ended(p)).map(e => e.target)).toEqual([C, R]);
    expect(r.waited).toBe(true);
  });

  // E2, end first. Mutation: refusal reads without its lock (the send reads R live and lands on an ended ID, unbounced).
  test("E2: a send to an ID whose end is in flight waits, then is refused id_ended", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, end(repo), send(repo));
    committed(r.a);
    expect(outcome(r.b)).toBe("refused id_ended");
    expect((await mailTo(p, R)).map(m => m.body)).toEqual(["hello"]);
    expect(r.waited).toBe(true);
  });

  // E2, send first. Mutations: the end as a plain UPDATE, or without FOR UPDATE (its NO KEY UPDATE doesn't conflict
  // with the send's KEY SHARE, probe B5: the end commits first and the late message is never bounced).
  test("E2: an end behind an in-flight send waits for it, then bounces its message too", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, send(repo), end(repo));
    expect(typeof committed(r.a)).toBe("number");
    expect(committed(r.b as never)).toMatchObject({ ended: true });
    expect((await mailTo(p, BBE)).map(m => m.kind)).toEqual(["bounce"]);
    expect(String((await mailTo(p, BBE))[0]!.body)).toContain("before reading this or your earlier message");
    expect(r.waited).toBe(true);
  });

  // E3, end first. Mutation: registerId without its root lock (the child registers under an ended root and stays live).
  const register = (repo: Repo) => async (tx: Tx) => {
    try { return await repo.bindings.registerId(tx, { id: N, principal: W, launcher: false, rootId: R }); }
    catch (e) { return `threw ${(e as { refusalCode?: string }).refusalCode}`; }
  };
  test("E3: a child registering under a root whose end is in flight waits, then is refused id_ended", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, end(repo), register(repo));
    committed(r.a);
    expect(outcome(r.b)).toBe("threw id_ended");
    expect((await q(p)`SELECT id FROM ids WHERE id = ${N}`).length).toBe(0);
    expect(r.waited).toBe(true);
  });

  // E3, register first. Mutation: registerId without its root lock (the end doesn't wait, misses the new child).
  test("E3: a root's end behind a child's registration waits for it, then ends that child too", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, register(repo), end(repo));
    committed(r.a);
    expect(outcome(r.b)).toMatchObject({ ended: true });
    expect((await idsRow(p, N)).ended_at).toBe(String(T0 + 10));
    expect((await ended(p)).map(e => e.target).sort()).toEqual([C, N, R].sort());
    expect(r.waited).toBe(true);
  });

  // E4 take, end first. Mutation: take without its ids lock (the hold lands on an ended ID and outlives it).
  test("E4: a take by an ID whose end is in flight waits, then takes nothing", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, end(repo), take(repo));
    committed(r.a);
    expect(outcome(r.b)).toBeNull();
    expect(await holdsOf(p, R)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // E4 take, take first. Mutation: take without its ids lock (the end doesn't wait, and the hold outlives it).
  test("E4: an end behind an in-flight take waits for it, then releases that hold too", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, take(repo), end(repo));
    expect(committed(r.a)).not.toBeNull();
    expect(outcome(r.b)).toMatchObject({ ended: true, held: [WBE, WFE] });
    expect(await holdsOf(p, R)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // E4 claim, end first. Mutation: serverClaim without lockLive (the claim lands on an ended ID and outlives it).
  const claim = (repo: Repo, key = "ticket:ENG-200") => async (tx: Tx) => {
    try { return (await serverClaim(repo, boardAccess(repo, "team"), tx, R, key, {})).ok; }
    catch (e) { return `threw ${(e as { refusalCode?: string }).refusalCode}`; }
  };
  test("E4: a claim by an ID whose end is in flight waits, then is refused id_ended", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, end(repo), claim(repo));
    committed(r.a);
    expect(outcome(r.b)).toBe("threw id_ended");
    expect(await claimsOf(p, R)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // E4 claim, claim first. Mutation: serverClaim without lockLive (the end doesn't wait, and the claim outlives it).
  test("E4: an end behind an in-flight claim waits for it, then releases that claim too", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, claim(repo), end(repo));
    expect(committed(r.a)).toBe(true);
    expect(outcome(r.b)).toMatchObject({ ended: true });
    expect(await claimsOf(p, R)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // E4 for a child. Mutation: SKIP LOCKED on the end's children (the end skips C, whose row the take holds, and C and
  // its hold outlive the root).
  test("E4: a root's end behind its child's in-flight take waits for it, then ends the child and releases its hold", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const r = await race(p, take(repo, C, WFE), end(repo));
    expect(committed(r.a)).not.toBeNull();
    expect(outcome(r.b)).toMatchObject({ ended: true });
    expect((await idsRow(p, C)).ended_at).toBe(String(T0 + 10));
    expect(await holdsOf(p, C)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // The lock order (session_end.ts): the end locks its children's ids rows in its row step, before it deletes the
  // root's holds. Mutation: the children's FOR UPDATE dropped from the row step. The root's end has released w/be
  // when the child's take of it starts; the take locks C's row KEY SHARE and waits on the deleted hold; the end's child
  // step then wants C's row FOR UPDATE: a deadlock (40P01), one side rolled back.
  test("lock order: a child's take of its root's alias while the root's end is between its holds and its children: the take waits, nothing deadlocks", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const held = gate(repo.sessionEnd, "end", 1);
    const r = await midRace(p, end(repo), held, take(repo, C, WBE));
    expect(outcome(r.a)).toMatchObject({ ended: true });
    expect(outcome(r.b)).toBeNull();
    expect(await q(p)`SELECT address, id FROM alias_holds ORDER BY address`).toEqual([{ address: BBE, id: X }]);
    expect(r.waited).toBe(true);
  });

  // C10d2-a's open row: a send between the end's unreadFor and its dropReader. Mutation: refusal without its lock (the
  // send lands after the end read R's mail: unbounced, and the read point it would have had is gone).
  test("a send while the end is past its unread read: it waits, then is refused id_ended", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const held = gate(repo.messages, "dropReader");
    const r = await midRace(p, end(repo), held, send(repo));
    expect(outcome(r.a)).toMatchObject({ ended: true });
    expect(outcome(r.b)).toBe("refused id_ended");
    expect((await mailTo(p, R)).map(m => m.body)).toEqual(["hello"]);
    expect(r.waited).toBe(true);
  });

  // unreadFor's lock mode. Mutation: FOR SHARE instead of FOR KEY SHARE (it conflicts with a delivery stamp's NO KEY
  // UPDATE, so every end would wait on any in-flight markDelivered of its mail).
  test("a held delivery stamp on the ID's unread mail doesn't make the end wait; the message still bounces", async () => {
    await using p = await pgPair();
    const { repo, mail } = await world(p);
    const r = await race(p, tx => repo.messages.markDelivered(tx, mail, T0 + 5), end(repo));
    committed(r.a);
    expect(outcome(r.b)).toMatchObject({ ended: true });
    expect((await mailTo(p, BBE)).map(m => m.kind)).toEqual(["bounce"]);
    expect(r.waited).toBe(false);
  });

  // C10d2-a's open row: a retract against the end's bounce, retract first. unreadFor locks the unread mail KEY SHARE,
  // so the end waits on the retract's FOR UPDATE and then skips the deleted row: nothing to bounce. No mutation of its
  // own: without unreadFor's lock the bounce's parent lock waits instead and the gone parent is skipped (C10d2-a's
  // retry), with the same rows; the other order below is that mutant's.
  test("a retract before the end's bounce: the end waits for it, and bounces nothing for the retracted message", async () => {
    await using p = await pgPair();
    const { repo, mail } = await world(p);
    const r = await race(p, tx => repo.messages.retract(tx, BBE, mail, { actor: B, session: X }), end(repo));
    expect(committed(r.a)).toBe("retracted");
    expect(outcome(r.b)).toMatchObject({ ended: true });
    expect(await mailTo(p, BBE)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // The other order. Mutation: unreadFor without its lock (the retract doesn't wait: it deletes the message under the
  // held end, whose bounce then finds its parent gone and is skipped). With the lock the retract waits, then finds the
  // bounce under its message and answers replied.
  test("a retract while the end is past its unread read: the retract waits, then finds the bounce a reply", async () => {
    await using p = await pgPair();
    const { repo, mail } = await world(p);
    const held = gate(repo.messages, "bounce");
    const r = await midRace(p, end(repo), held, tx => repo.messages.retract(tx, BBE, mail, { actor: B, session: X }));
    expect(outcome(r.a)).toMatchObject({ ended: true });
    expect(outcome(r.b)).toBe("replied");
    expect((await mailTo(p, BBE)).map(m => m.kind)).toEqual(["bounce"]);
    expect(r.waited).toBe(true);
  });
});

// #1387: a sweep requeues expired queue claims in post id order, so two sweeps (or a sweep and a posts prune, which
// locks its batch by id) can't lock two queue posts in opposite orders.
describePg("claims sweep (Postgres, #1387)", () => {
  // Mutation: sweepClaims without queuePostOrder (heldBy's and expire's key order puts queue:q:10 before queue:q:9).
  test("a sweep requeues lapsed queue claims in post id order, not key order", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const sql = q(p);
    await sql`DELETE FROM claims`;
    // Posts up to id 10 (world's is 1): queue:q:10 sorts before queue:q:9 as text, as lapse order breaks its tie.
    for (let i = 2; i <= 10; i++) await sql`INSERT INTO posts (board, author, body, created_at) VALUES ('q', ${BBE}, ${`t${i}`}, ${T0})`;
    for (const id of [10, 9]) await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (${`queue:q:${id}`}, ${X}, 'queue post', 'q', ${T0}, ${T0 + 1})`;
    const order: string[] = [];
    const orig = repo.boards.redeliveryFacts;
    repo.boards.redeliveryFacts = async (tx, key, ...rest) => { order.push(key); return orig.call(repo.boards, tx, key, ...rest); };
    await p.a.write(tx => sweepClaims(repo, boardAccess(repo, "team"), tx, T0 + 2));
    expect(order).toEqual(["queue:q:9", "queue:q:10"]);
  });
});

describePg("session end's releases (Postgres, #1387)", () => {
  // Mutation: endSessionServer without queuePostOrder (heldBy's key order releases queue:q:10 before queue:q:9).
  test("an end releases its queue claims in post id order, not key order", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    const sql = q(p);
    await sql`DELETE FROM claims`;
    for (let i = 2; i <= 10; i++) await sql`INSERT INTO posts (board, author, body, created_at) VALUES ('q', ${BBE}, ${`t${i}`}, ${T0})`;
    for (const id of [10, 9]) await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (${`queue:q:${id}`}, ${R}, 'queue post', 'q', ${T0}, ${T0 + 3_600_000})`;
    await p.a.write(end(repo));
    expect((await sql`SELECT key FROM claim_events WHERE event = 'release' ORDER BY id`).map((r: Row) => r.key)).toEqual(["queue:q:9", "queue:q:10"]);
  });
});

// The hosted store's child end through the real port (hosted_port.ts deferredSessionEnd over sessionEndPort).
describePg("hosted child end through the session-end port (Postgres)", () => {
  const ME = "you@example.com";
  const rowOf = (over: Partial<HostedSession> & Pick<HostedSession, "session_id" | "ownership_id" | "user_id">): HostedSession => ({
    client_id: "client", grant_id: "g", source_session_id: over.session_id, writes_as: null, bind_gen: 0, root_session_id: null, place: null,
    lease_deadline: null, created_at: T0, last_seen_at: T0, suggested: null, parked_at: null, ...over,
  });
  // R's hosted row and C's, a child of it.
  async function hosted(p: PgPair, repo: Repo) {
    const user = int8((await q(p)`INSERT INTO users (email, created_at) VALUES (${ME}, 0) RETURNING id`)[0].id);
    await q(p)`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('g', ${user}, ${T0 + 1_000_000}, '{}'::jsonb)`;
    await p.a.write(async tx => {
      const own = await repo.hosted.start(tx, R, user, "client", T0);
      await repo.hosted.insert(tx, rowOf({ session_id: R, ownership_id: own, user_id: user }));
      await repo.hosted.insert(tx, rowOf({ session_id: C, ownership_id: own, user_id: user, root_session_id: R }));
    });
  }
  const childEnd = (repo: Repo) => (tx: Tx) => repo.hosted.childEnd(tx, C, T0 + 10, "closed");

  test("a released child's ID ends through the port: its id.ended row, its holds released", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    await hosted(p, repo);
    await q(p)`INSERT INTO alias_holds (address, id, bound_at) VALUES (${WFE}, ${C}, 1)`;
    await p.a.write(childEnd(repo));
    expect((await idsRow(p, C)).ended_at).toBe(String(T0 + 10));
    expect(await holdsOf(p, C)).toEqual([]);
    expect(await ended(p)).toEqual([{ target: C, detail: { principal: W, held: [WFE], why: "closed", bounced: 0 } }]);
    expect((await q(p)`SELECT count(*)::int AS n FROM access_log WHERE action = 'hosted.child_released'`)[0].n).toBe(1);
  });

  // Mutation: the end as a plain UPDATE (the send doesn't wait for the port's end).
  test("the port's end against a send to the child: the send waits for it", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    await hosted(p, repo);
    const r = await race(p, childEnd(repo), send(repo, C));
    committed(r.a);
    expect(outcome(r.b)).toBe("refused child_session");
    expect((await idsRow(p, C)).ended_at).toBe(String(T0 + 10));
    expect(r.waited).toBe(true);
  });

  // Mutation: take without its ids lock (the child's hold lands after the port ended it).
  test("the port's end against the child's take, both orders: no hold outlives the end", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    await hosted(p, repo);
    const r = await race(p, childEnd(repo), take(repo, C, WFE));
    committed(r.a);
    expect(outcome(r.b)).toBeNull();
    expect(await holdsOf(p, C)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  test("the child's take, then the port's end: the end waits and releases it", async () => {
    await using p = await pgPair();
    const { repo } = await world(p);
    await hosted(p, repo);
    const r = await race(p, take(repo, C, WFE), childEnd(repo));
    expect(committed(r.a)).not.toBeNull();
    committed(r.b as never);
    expect(await holdsOf(p, C)).toEqual([]);
    expect((await ended(p))[0]!.detail).toMatchObject({ held: [WFE] });
    expect(r.waited).toBe(true);
  });
});
