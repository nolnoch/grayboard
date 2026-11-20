// #807 P3 C10e2: the boards store's races on Postgres (c10-scope §2 C10e2: P1, P5, A1, P3/P4; docs/future/postgres-
// server.md D3), each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's
// starts, and the race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race
// whose lock is gone fails on what it broke (a raw 23503, an aborted body, a post on an archived board, a second
// archive or take), not on a timeout. The gate's board read is board_post's (postGateOn: lockForPost, then core's
// archived refusal), restated over the store, since no Postgres Repo exists before C11. Without GRAYBOARD_TEST_PG_URL
// they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { blockedOrSettled, committed, gate, outcome, pgPair, race, settle, type PgPair, type Settled } from "../../../../tests/support/pg_race.ts";
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

// race() with A's body going on after B blocks or settles: `first` runs on A and holds, B's `second` starts, and once
// B is blocked or settled A is released into `then` on the same transaction. For a post whose gate read (`first`)
// and insert (`then`) straddle a concurrent archive.
async function raceThrough<TA, TB>(p: PgPair, first: (tx: Tx) => Promise<void>, then: (tx: Tx) => Promise<TA>, second: (tx: Tx) => Promise<TB>):
  Promise<{ a: Settled<TA>; b: Settled<TB>; waited: boolean }> {
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => { await first(tx); held.open(); await release.wait; return then(tx); }));
  let b: Promise<Settled<TB>>, waitEvent: string | null;
  try {
    await Promise.race([held.wait, a]);
    let done = false;
    b = settle(p.b.write(second)).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
  } finally {
    release.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null };
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
    const r = await raceThrough(p,
      async tx => { expect((await bs.lockForPost(tx, "hall"))?.archived_at).toBeUndefined(); },
      async tx => (await bs.insertPost(tx, np("posted", T0 + 5))).id,
      async tx => {
        const after = await bs.setArchived(tx, "hall", FE, T0 + 10);
        return { archived_by: after?.archived_by, posts: (await bs.snapshotPage(tx, "hall", {})).posts.map(x => x.body) };
      });
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
});
