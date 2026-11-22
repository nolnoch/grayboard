// #807 P3 C10e2: the boards store's races on Postgres (c10-scope §2 C10e2: P1, P5, A1, P3/P4, and the c10e2 audit's
// sweep-vs-prune and forget-vs-read; docs/future/postgres-server.md D3), each in T-P12's shape
// (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race
// whose lock is gone fails on what it broke (a raw 23503, an aborted body, a post on an archived board, a second
// archive or take), not on a timeout. The gate's board read is board_post's (postGateOn: lockForPost, then core's
// archived refusal), restated over the store, since no Postgres Repo exists before C11. Without GRAYBOARD_TEST_PG_URL
// they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { hostedPause } from "../../../../tests/support/hosted-pause.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import type { NewPost } from "../boards.ts";
import { MissingPost } from "../errors.ts";
import type { Tx } from "../tx_base.ts";
import { makePgBoards } from "./boards.ts";
import { int8, int8OrNull } from "./sql.ts";

type Row = Record<string, unknown>;
const T0 = 1_800_000_000_000;
const BE = "a@example.com/be", FE = "a@example.com/fe", QA = "b@example.com/qa";
const bs = makePgBoards({ clock: () => T0 });

const np = (body: string, now: number, parentId: number | null = null, board = "hall"): NewPost =>
  ({ board, author: BE, body, parentId, now, expiresAt: null, authorId: null, via: null, authorUser: null, human: false });

async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

const postRows = async (p: PgPair) => (await p.db.sql`SELECT id, parent_id, body FROM posts ORDER BY id`)
  .map((r: Row) => ({ id: int8(r.id), parent_id: int8OrNull(r.parent_id), body: r.body as string }));

// A board and a root post on it at T0, the race's parent or the archive's board.
async function hall(p: PgPair, kind = "broadcast"): Promise<number> {
  await p.a.write(tx => bs.create(tx, { name: "hall", purpose: "p", scope: null, kind, createdBy: BE, now: T0 }));
  return (await p.a.write(tx => bs.insertPost(tx, np("root", T0)))).id;
}

// board_post's gate on `tx`, as far as an archive bears on it: the board read through lockForPost, refused when
// archived (core postGateRule without allowArchived), then the post.
async function gatedPost(tx: Tx, body: string): Promise<string> {
  const b = await bs.lockForPost(tx, "hall");
  if (!b) return "no board";
  if (b.archived_at !== undefined) return "refused archived";
  await bs.insertPost(tx, np(body, T0 + 5));
  return "posted";
}

describePg("boards store races (Postgres)", () => {
  // Mutation: insertPost's parent FOR KEY SHARE dropped (the insert's FK check waits on the prune instead and fails
  // 23503, which aborts B's body: the backstop still names MissingPost, but the body's next statement fails 25P02).
  test("P1: a prune, then a reply to a post it deletes: the reply refuses MissingPost and its body goes on", async () => {
    await using p = await pgPair();
    const root = await hall(p);
    const r = await race(p, tx => bs.prunePosts(tx, T0 + 1), async tx => {
      const e = await caught(() => bs.insertPost(tx, np("reply", T0 + 5, root)));
      const after = await bs.insertPost(tx, np("after", T0 + 6));
      return { e, after: after.id };
    });
    expect(committed(r.a)).toEqual(["hall"]);
    const b = outcome(r.b) as { e: unknown; after: number };
    expect(b.e).toBeInstanceOf(MissingPost);
    expect((b.e as Error).message).toBe(`parent_id ${root} is not a post on #hall`);
    expect(await postRows(p)).toEqual([{ id: b.after, parent_id: null, body: "after" }]);
    expect(r.waited).toBe(true);
  });

  // Mutations: the prune's batch FOR UPDATE dropped (its null-the-children UPDATE misses the uncommitted reply, its
  // DELETE then waits on the reply's KEY SHARE and fails 23503); the null-the-children UPDATE dropped (23503 too).
  test("P1: a reply, then a prune of its parent: the prune waits and keeps the reply as a root", async () => {
    await using p = await pgPair();
    const root = await hall(p);
    const r = await race(p, tx => bs.insertPost(tx, np("reply", T0 + 5, root)), tx => bs.prunePosts(tx, T0 + 1));
    const reply = committed(r.a);
    expect(outcome(r.b)).toEqual(["hall"]);
    expect(await postRows(p)).toEqual([{ id: reply.id, parent_id: null, body: "reply" }]);
    expect(r.waited).toBe(true);
  });

  // Mutations: lockForPost's FOR KEY SHARE dropped, or setArchived's FOR UPDATE dropped (its UPDATE's FOR NO KEY
  // UPDATE doesn't conflict with KEY SHARE): either way the archive doesn't wait for the gated post, commits first and
  // counts no post, and the post lands on an archived board.
  test("P5: a post past its gate, then an archive: the archive waits and lands after the post", async () => {
    await using p = await pgPair();
    await hall(p);
    const r = await race(p,
      async tx => { expect((await bs.lockForPost(tx, "hall"))?.archived_at).toBeUndefined(); },
      async tx => {
        const after = await bs.setArchived(tx, "hall", FE, T0 + 10);
        return { archived_by: after?.archived_by, posts: (await bs.snapshotPage(tx, "hall", {})).posts.map(x => x.body) };
      },
      { then: async tx => (await bs.insertPost(tx, np("posted", T0 + 5))).id });
    committed(r.a);
    expect(outcome(r.b)).toEqual({ archived_by: FE, posts: ["root", "posted"] });
    expect(r.waited).toBe(true);
  });

  // Mutations: setArchived's FOR UPDATE dropped (the gate's KEY SHARE doesn't wait on the UPDATE's FOR NO KEY UPDATE,
  // reads the board open and posts); lockForPost's FOR KEY SHARE dropped (the gate reads the board open; its insert's
  // FK check then waits on the archive and posts).
  test("P5: an archive, then a post: the gate waits and refuses the board as archived", async () => {
    await using p = await pgPair();
    const root = await hall(p);
    const r = await race(p, tx => bs.setArchived(tx, "hall", BE, T0 + 10), tx => gatedPost(tx, "late"));
    expect(committed(r.a)?.archived_by).toBe(BE);
    expect(outcome(r.b)).toBe("refused archived");
    expect(await postRows(p)).toEqual([{ id: root, parent_id: null, body: "root" }]);
    expect(r.waited).toBe(true);
  });

  test("P5: two posts past their gates don't wait on each other", async () => {
    await using p = await pgPair();
    await hall(p);
    const r = await race(p, tx => gatedPost(tx, "one"), tx => gatedPost(tx, "two"));
    expect(committed(r.a)).toBe("posted");
    expect(outcome(r.b)).toBe("posted");
    expect((await postRows(p)).map((x: { body: string }) => x.body)).toEqual(["root", "one", "two"]);
    expect(r.waited).toBe(false);
  });

  // Mutation: setArchived as a read and then an unconditional UPDATE (B reads the board open while A's archive is
  // uncommitted, then overwrites A's stamp).
  test("A1: two archives: one board, the first's stamp; the second is null", async () => {
    await using p = await pgPair();
    await hall(p);
    const r = await race(p, tx => bs.setArchived(tx, "hall", BE, T0 + 10), tx => bs.setArchived(tx, "hall", FE, T0 + 20));
    expect(committed(r.a)).toMatchObject({ archived_by: BE, archived_at: T0 + 10 });
    expect(outcome(r.b)).toBeNull();
    expect(await bs.get(p.a.read, "hall")).toMatchObject({ archived_by: BE, archived_at: T0 + 10 });
    expect(r.waited).toBe(true);
  });

  // Mutations: the claim `ON CONFLICT DO UPDATE` (B takes the key over: true, a second take event, two pushes); the
  // push written before the claim is known (the serial contract row "on a free key" catches it: the winner's push
  // finds no claim yet).
  test("P3/P4: two redeliveries of one queue post, to two lanes or to one: one claim, one take event, one push", async () => {
    for (const [first, second] of [[FE, QA], [FE, FE]] as const) {
      await using p = await pgPair();
      const post = await hall(p, "queue");
      const claim = (lane: string, now: number) => (tx: Tx) => bs.claimQueuePost(tx, "hall", post, lane, now, { note: "queue post (redelivered)", push: true });
      const r = await race(p, claim(first, T0 + 5), claim(second, T0 + 6));
      expect(committed(r.a)).toBe(true);
      expect(outcome(r.b)).toBe(false);
      expect((await p.db.sql`SELECT key, holder, acquired_at FROM claims`).map((x: Row) => [x.key, x.holder, int8(x.acquired_at)]))
        .toEqual([[`queue:hall:${post}`, first, T0 + 5]]);
      expect((await p.db.sql`SELECT handle, event FROM claim_events ORDER BY id`).map((x: Row) => [x.handle, x.event])).toEqual([[first, "take"]]);
      expect((await p.db.sql`SELECT handle, post_id, wake, delivered_at FROM outbox ORDER BY handle COLLATE "C"`)
        .map((x: Row) => [x.handle, int8(x.post_id), x.wake, x.delivered_at])).toEqual([[first, post, true, null]]);
      expect(r.waited).toBe(true);
    }
  });

  // c10e2 audit 1. Mutation: claimQueuePost's post FOR KEY SHARE dropped. A sweep resets the push of a queue post its
  // lane already holds (an outbox UPDATE, no FK check), and a prune locks its batch and waits on that outbox row in its
  // delete; the sweep's next claim ends in an [unclaimed] reply under another old post, which waits on the prune's
  // batch: a deadlock, one side aborted. With the post locked first, the prune waits at its batch instead.
  test("P1: a sweep's redelivery and reply, around a prune of both posts: the prune waits, nothing deadlocks", async () => {
    await using p = await pgPair();
    const p1 = await hall(p, "queue");
    const p2 = (await p.a.write(tx => bs.insertPost(tx, np("other", T0)))).id;
    await p.db.sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (${`queue:hall:${p1}`}, ${FE}, 'queue post', 'hall', ${T0}, ${T0 + 60_000})`;
    await p.a.write(tx => bs.insertOutbox(tx, p1, [[FE, { reason: "subscription", wake: true }]]));
    const r = await race(p,
      tx => bs.claimQueuePost(tx, "hall", p1, FE, T0 + 5, { note: "queue post (redelivered)", push: true }),
      tx => bs.prunePosts(tx, T0 + 1),
      { then: async (tx, took) => ({ took, reply: (await bs.insertPost(tx, np("[unclaimed]", T0 + 5, p2))).id }) });
    const a = committed(r.a);
    expect(a.took).toBe(false);
    expect(outcome(r.b)).toEqual(["hall"]);
    expect(await postRows(p)).toEqual([{ id: a.reply, parent_id: null, body: "[unclaimed]" }]);
    expect((await p.db.sql`SELECT count(*)::int AS n FROM outbox`)[0].n).toBe(0);
    expect(r.waited).toBe(true);
  });

  // c10e2 audit 2. Mutation: read's cursor UPDATE before its outbox stamp. A forget of a handle holds its outbox rows
  // (here, its first half: an acknowledge's stamp) when the handle's read starts; a read that moved its cursor first
  // holds the subscription row forget deletes next, then waits on the outbox row: a deadlock. Outbox first, the read
  // waits holding nothing forget needs, and finds both rows gone.
  test("forget against the handle's read: the read waits, nothing deadlocks", async () => {
    await using p = await pgPair();
    const root = await hall(p);
    await p.a.write(async tx => {
      await bs.setSubscription(tx, FE, "hall", "push");
      await bs.insertOutbox(tx, root, [[FE, { reason: "mention", wake: true }]]);
    });
    const r = await race(p,
      tx => bs.acknowledge(tx, FE, { kind: "push", post_id: root }),
      async tx => (await bs.read(tx, "hall", FE, {})).posts.map(x => x.body),
      { then: tx => bs.forget(tx, FE) });
    committed(r.a);
    expect(outcome(r.b)).toEqual(["root"]);
    expect(await p.db.sql`SELECT handle FROM outbox UNION ALL SELECT handle FROM subscriptions`).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // #1595: a queue post's first acknowledge credits its take (a claim_events write on `queue:hall:<post>`), which a keyed
  // body may do only while it holds `board:hall`, as every keyed writer of that board's queue keys does: without it (root
  // only, or another board's key) the store refuses and the body rolls back; with it the ack commits and credits the
  // take to FE's holder. A broadcast post's acknowledge needs no board key. Mutations: the refusal dropped (the root-only
  // call commits); its needed key taken from anything but the post's board (the board:other call commits).
  test("a queue post's first acknowledge needs its board's key in a keyed body (its take credit); a broadcast post's runs on the root alone", async () => {
    await using p = await pgPair();
    const root = await hall(p, "queue");
    await p.a.write(tx => bs.claimQueuePost(tx, "hall", root, FE, T0, { note: "queue post", push: true }));
    // FE's holder from here on: the take was logged with none, and the credit names S1.
    await p.db.sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${FE}, 'S1', 1)`;
    const ack = (keys: string[]) => p.a.writeKeyed(keys, tx => bs.acknowledge(tx, FE, { kind: "push", post_id: root }));
    const state = async () => ({
      delivered: (await p.db.sql`SELECT delivered_at FROM outbox WHERE handle = ${FE} AND post_id = ${root}`)[0].delivered_at !== null,
      credited: (await p.db.sql`SELECT session_id FROM claim_events WHERE key = ${`queue:hall:${root}`} AND event = 'take'`)[0].session_id,
    });
    const e = await caught(() => ack(["root:a"]));
    expect((e as Error).message).toContain("boards.acknowledge's queue take credit (a claim_events write) refused in a keyed write body (keys root:a) without the key board:hall");
    expect(await caught(() => ack(["root:a", "board:other"]))).toBeInstanceOf(Error);
    expect(await state()).toEqual({ delivered: false, credited: null });
    await ack(["root:a", "board:hall"]);
    expect(await state()).toEqual({ delivered: true, credited: "S1" });
    await p.a.write(tx => bs.create(tx, { name: "news", purpose: "p", scope: null, kind: "broadcast", createdBy: BE, now: T0 }));
    const post = (await p.a.write(tx => bs.insertPost(tx, np("item", T0, null, "news")))).id;
    await p.a.write(tx => bs.insertOutbox(tx, post, [[FE, { reason: "subscription", wake: true }]]));
    await p.a.writeKeyed(["root:a"], tx => bs.acknowledge(tx, FE, { kind: "push", post_id: post }));
    expect((await p.db.sql`SELECT delivered_at FROM outbox WHERE post_id = ${post}`)[0].delivered_at).not.toBeNull();
  });

  // #1472: a receipt from S1 for FE, which S2 holds when it starts, so its first statement (delivered_at IS NULL)
  // marks nothing; FE's hold moves back to S1 at the pause before the repeat statement, which then sees S1 holding it.
  // The row stays undelivered and S2's, credited to no one. Mutation: the repeat's `delivered_at IS NOT NULL` dropped
  // marks it delivered with no credit.
  test("#1472: a hold moving back between acknowledge's two statements marks an undelivered push nothing", async () => {
    await using p = await pgPair();
    const root = await hall(p);
    await p.db.sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${FE}, 'S2', 1)`;
    await p.a.write(tx => bs.insertOutbox(tx, root, [[FE, { reason: "mention", wake: true }]]));
    const row = async () => (await p.db.sql`SELECT delivered_at, session_id FROM outbox WHERE handle = ${FE} AND post_id = ${root}`)
      .map((r: Row) => ({ delivered_at: int8OrNull(r.delivered_at), session_id: r.session_id }));
    expect(await row()).toEqual([{ delivered_at: null, session_id: "S2" }]);
    await hostedPause("boards:acknowledge:repeat",
      () => p.a.write(tx => bs.acknowledge(tx, FE, { kind: "push", post_id: root }, "S1")),
      async () => { await p.db.sql`UPDATE alias_holds SET id = 'S1' WHERE address = ${FE}`; });
    expect(await row()).toEqual([{ delivered_at: null, session_id: "S2" }]);
  });
});
