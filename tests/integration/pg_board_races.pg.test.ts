// #807 P3 C11a: board_post's gate against board_archive on Postgres, through a server (pg_server.ts: a TestServer on
// makePgRepo, its pool on side b) and a second transaction store on its database (side a), in T-P12's shape
// (tests/support/pg_race.ts raceRequest): A runs the server's own composed code over its Repo on A's Tx and holds its
// transaction open, B is a hosted session's request, and the race waits until B is blocked on a lock or done. P5
// (store/pg/boards.ts header): the gate reads its board through lockForPost (FOR KEY SHARE) and setArchived locks the
// board FOR UPDATE first, so an archive and a post past its gate serialize. The end state is asserted before `waited`,
// so a race whose lock is gone fails on what it broke (a post on an archived board, a post written after the archive
// its gate didn't see), not on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describePg, type PgDatabase } from "../support/pg.ts";
import { blockedOrSettled, committed, gate, outcome, raceRequest, settle, type Settled } from "../support/pg_race.ts";
import { pgServers, type PgServers } from "../support/pg_server.ts";
import type { TestServer } from "../support/server.ts";
import { postGateOn, serverPost } from "../../src/server/board_post.ts";
import { callBoardTool } from "../../src/server/boards.ts";
import { makePgTransactions, type PgTransactions } from "../../src/server/store/pg/tx.ts";
import type { Tx } from "../../src/server/store/tx_base.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03 or 40P01, not on Bun's timeout.
setDefaultTimeout(30_000);

type Row = Record<string, unknown>;
const W = "w@example.com", B = "b@example.com";
const BE = `${W}/be`, LANE = `${W}/lane`;
const LIMITS = { hostedRequestLimit: { burst: 10_000, perSec: 10_000 } };
// The kinds a wait on another transaction's row lock shows: the tuple lock, or the holder's xid once queued behind it.
const ROW_LOCK = ["tuple", "transactionid"];

// The server on side b, and store A (side a) on its database, closed before the database is dropped.
async function world(): Promise<{ pg: PgServers; srv: TestServer; a: PgTransactions; [Symbol.asyncDispose](): Promise<void> }> {
  const pg = await pgServers(1, { sides: ["b"], overrides: LIMITS });
  const a = makePgTransactions(pg.db.url, { max: 2, applicationName: "gb-test-a" });
  return { pg, srv: pg.servers[0]!, a, async [Symbol.asyncDispose]() { await a.close(); await pg[Symbol.asyncDispose](); } };
}

// The server's board_archive arm (boards.ts callBoardTool) on A's Tx, as `actor`.
const archive = (srv: TestServer, actor: string, board: string) => (tx: Tx) =>
  callBoardTool(srv.app.repo, srv.app.application.access, tx, actor, "board_archive", { board }, { addresses: [actor] });

const sql = (pg: PgServers) => pg.db.sql;
const postsOn = async (pg: PgServers, board: string) =>
  (await sql(pg)`SELECT body, parent_id, author FROM posts WHERE board = ${board} ORDER BY id`) as Row[];
const archivedAt = async (pg: PgServers, board: string) => (await sql(pg)`SELECT archived_at FROM boards WHERE name = ${board}`)[0]?.archived_at;
const textOf = (r: CallToolResult) => r.content?.find(c => c.type === "text")?.text;

// raceRequest with A's body in two halves straddling B: `first` holds, then `then` runs on the same Tx with its value
// (a post's gate, then its write), and A's result is `then`'s.
async function raceThen<TA, TT, TB>(p: { db: PgDatabase; a: PgTransactions }, first: (tx: Tx) => Promise<TA>,
  then: (tx: Tx, held: TA) => Promise<TT>, request: () => Promise<TB>):
  Promise<{ a: Settled<TT>; b: Settled<TB>; waited: boolean; waitEvent: string | null }> {
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => {
    const v = await first(tx);
    held.open();
    await release.wait;
    return then(tx, v);
  }));
  let b: Promise<Settled<TB>>, waitEvent: string | null;
  try {
    await Promise.race([held.wait, a]);
    let done = false;
    b = settle(request()).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
  } finally {
    release.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null, waitEvent };
}

describePg("board_post against board_archive, through a server on Postgres", () => {
  // Mutation: postGateOn without lockForPost (`const board = seen;`): B's gate reads the board open past A's uncommitted
  // archive, its insert's FK check waits on A's FOR UPDATE, and the post lands on the archived board.
  test("a post behind an in-flight archive waits on the board row, then is refused: the board is archived", async () => {
    await using w = await world();
    const { pg, srv } = w;
    const s = await srv.hosted(W, "be");
    await s.call("board_create", { name: "general", purpose: "p" });
    const r = await raceRequest({ db: pg.db, a: w.a }, archive(srv, BE, "general"), () => s.callRaw("board_post", { board: "general", body: "late" }));
    expect((committed(r.a).result as Row).archived_at).toEqual(expect.any(Number));
    const b = outcome(r.b) as CallToolResult;
    expect(b.isError).toBe(true);
    expect(textOf(b)).toContain("#general is archived; reply in one of its threads");
    expect(await postsOn(pg, "general")).toEqual([]);
    expect(await archivedAt(pg, "general")).not.toBeNull();
    expect(r.waited).toBe(true);
    expect(ROW_LOCK).toContain(r.waitEvent ?? "none");
  });

  // Mutation: setArchived without its FOR UPDATE select: its UPDATE takes FOR NO KEY UPDATE, which the gate's KEY SHARE
  // doesn't block (probe D5), so the archive commits between A's gate and its insert and A writes on an archived board.
  test("an archive behind a post past its gate waits for the post to commit, then archives", async () => {
    await using w = await world();
    const { pg, srv } = w;
    const repo = srv.app.repo, access = srv.app.application.access;
    const s = await srv.hosted(W, "be");
    await s.call("board_create", { name: "general", purpose: "p" });
    const r = await raceThen({ db: pg.db, a: w.a },
      tx => postGateOn(repo, access, tx, BE, "general", null),
      async (tx, g) => {
        const { result } = await serverPost(repo, access, tx, BE, g.board, g.gate, { board: "general", body: "first" }, { addresses: [BE] });
        // What the board was when the post was written: a READ COMMITTED read sees an archive that committed meanwhile.
        return { post: result.post_id, archivedAtWrite: (await repo.boards.get(tx, "general"))!.archived_at ?? null };
      },
      () => s.call<Row>("board_archive", { board: "general" }));
    expect(committed(r.a)).toEqual({ post: expect.any(Number), archivedAtWrite: null });
    expect(outcome(r.b)).toMatchObject({ name: "general", archived_at: expect.any(Number), archived_by: BE });
    expect((await postsOn(pg, "general")).map(p => p.body)).toEqual(["first"]);
    expect(r.waited).toBe(true);
    expect(ROW_LOCK).toContain(r.waitEvent ?? "none");
  });
});

describePg("a claim's system post on a board being archived, through a server on Postgres", () => {
  // The [unclaimed] reply is a reply, which an archived board takes anyway (core postGateRule): this pins that the
  // requeue's post waits on the archive's row lock and still lands, not allowArchived itself (the next test does).
  // Mutation: setArchived without its FOR UPDATE, or the gate without lockForPost: the release doesn't wait (`waited`).
  test("a queue lane's release behind an in-flight archive waits, then writes [unclaimed] in the post's thread", async () => {
    await using w = await world();
    const { pg, srv } = w;
    const lane = await srv.hosted(W, "lane");
    await lane.call("board_create", { name: "jobs", purpose: "p", kind: "queue" });
    const poster = await srv.hosted(B, "fe");
    const { post_id: postId } = await poster.call<{ post_id: number }>("board_post", { board: "jobs", body: "a job" });
    const key = `queue:jobs:${postId}`;
    expect(await sql(pg)`SELECT holder FROM claims WHERE key = ${key}`).toEqual([{ holder: LANE }]);
    const r = await raceRequest({ db: pg.db, a: w.a }, archive(srv, LANE, "jobs"), () => lane.call("claim_release", { key, note: "pass" }));
    committed(r.a);
    expect(r.b.ok ? "released" : outcome(r.b)).toBe("released");
    expect(await sql(pg)`SELECT holder FROM claims WHERE key = ${key}`).toEqual([]);
    expect(await postsOn(pg, "jobs")).toEqual([
      { body: "a job", parent_id: null, author: `${B}/fe` },
      { body: `[unclaimed] ${key}: its one lane passed on it, and no other lane is left; it stays here unclaimed`, parent_id: String(postId), author: LANE },
    ]);
    expect(await archivedAt(pg, "jobs")).not.toBeNull();
    expect(r.waited).toBe(true);
    expect(ROW_LOCK).toContain(r.waitEvent ?? "none");
  });

  // Mutation: serverRelease's announcement without allowArchived: the gate refuses the top-level [release] post on the
  // board A archived, and the release rolls back with it (the claim stays held).
  test("a ticket claim's release behind an in-flight archive waits, then announces [release] top-level on the archived board", async () => {
    await using w = await world();
    const { pg, srv } = w;
    const s = await srv.hosted(W, "be");
    await s.call("board_create", { name: "general", purpose: "p" });
    await s.call("claim_take", { key: "ticket:ENG-142", board: "general", note: "on it" });
    const r = await raceRequest({ db: pg.db, a: w.a }, archive(srv, BE, "general"), () => s.call("claim_release", { key: "ticket:ENG-142", note: "done" }));
    committed(r.a);
    expect(r.b.ok ? "released" : outcome(r.b)).toBe("released");
    expect(await sql(pg)`SELECT key FROM claims`).toEqual([]);
    const posts = await postsOn(pg, "general");
    expect(posts.at(-1)).toEqual({ body: "[release] ticket:ENG-142 — done", parent_id: null, author: BE });
    expect(await archivedAt(pg, "general")).not.toBeNull();
    expect(r.waited).toBe(true);
    expect(ROW_LOCK).toContain(r.waitEvent ?? "none");
  });
});
