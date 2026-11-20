// The boards store's contract (#807 P3 C10e-a, docs/future/postgres-server.md D9): every BoardsStore method, written
// once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's
// test file registers it under a describe() (boards.contract.sqlite.ts through db.test.ts for SQLite,
// pg/boards.contract.pg.test.ts for Postgres, C10e1/C10e2). The board rows of db.test.ts's B5a1..B5b3b moved here.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: post ids are what insertPost returned.
// - No answer depends on a wall clock. Every stamp a row asserts is passed in (a post's now, create's now, archive's
//   now, a claim's now) or written by a fixture. ensure, read and acknowledge stamp the store's clock: rows assert
//   only whether their stamp is set.
// - The rows are serial. An interleaving (a reply racing a prune, a post racing an archive, two archives, two
//   redeliveries of one queue post) is a backend's own test: Postgres runs them on two connections (C10e2's
//   pg/boards.pg.test.ts, races P1, P5, A1, P3/P4). What these rows pin is each method's serial answer, and that a
//   refusal (insertPost's MissingPost, setSubscription's mode) writes nothing and leaves the body usable.
// - Fixture writes the store doesn't offer (an alias row, a session's ids row, a hold, a claim, a claim or binding
//   event, an unsent upload, a watch) and the raw reads are the harness's, so no row touches a connection. Raw reads
//   return booleans for the boolean columns whatever the store keeps.
// - Order a method promises is asserted with fixtures written out of that order; order it doesn't (authorAddresses,
//   pendingDigests' boards, threadFacts' muted) is compared sorted.
import { expect, test } from "bun:test";
import { CoreError } from "../../core/errors.ts";
import { MissingPost } from "./errors.ts";
import type { BoardsStore, NewPost, PostTarget } from "./boards.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type BoardsHarness = {
  boards: BoardsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: a person-scope alias row for `address` (`<email>/<name>`); a
  // session's ids row; a hold at bound_at; a claims row; a claim_events row; a binding_events row; a claim watch;
  // an unsent upload by `uploader` for `principal` of `size` bytes (its id).
  alias(address: string, o?: { human?: boolean; queueOff?: boolean; lastSeen?: number }): Promise<void>;
  session(id: string, principal: string | null, o?: { viewer?: boolean; endedAt?: number; rootId?: string; status?: string }): Promise<void>;
  hold(address: string, id: string, boundAt: number): Promise<void>;
  claim(c: { key: string; holder: string; board: string | null; at: number }): Promise<void>;
  // session: claim_events.session_id (#1351), the session that took it; absent, a row from before the column (null).
  claimEvent(e: { key: string; handle: string; event: string; board: string | null; at: number; session?: string }): Promise<void>;
  // An undelivered waking push of `postId` to `handle`; session: outbox.session_id (#1370), absent a row from before it.
  push(handle: string, postId: number, session?: string): Promise<void>;
  bindingEvent(e: { session: string; name: string; event: string; at: number }): Promise<void>;
  watch(key: string, handle: string): Promise<void>;
  upload(uploader: string, principal: string | null, size: number): Promise<number>;
  // Raw reads: a subscription; every outbox row by post id then handle (delivered: delivered_at set); every mute by
  // handle then root; a post's parent and human mark (null: a NULL mark); every claim by key; every claim event and
  // binding event in write order; every watch by key then handle; every hold by address; each attachment's post by id.
  subscription(board: string, handle: string): Promise<{ mode: string; cursor: number; notified_id: number } | undefined>;
  outboxRows(): Promise<{ handle: string; post_id: number; reason: string; wake: boolean; delivered: boolean }[]>;
  // Every outbox row's receiving session (#1370), by post id then handle.
  outboxSessions(): Promise<{ handle: string; post_id: number; session_id: string | null }[]>;
  muteRows(): Promise<{ handle: string; root_id: number }[]>;
  postRow(id: number): Promise<{ parent_id: number | null; human: boolean | null } | undefined>;
  claimRows(): Promise<{ key: string; holder: string; note: string | null; board: string | null; acquired_at: number; expires_at: number; holder_user: string | null }[]>;
  eventRows(): Promise<{ key: string; handle: string; event: string; note: string | null; board: string | null; at: number }[]>;
  watchRows(): Promise<{ key: string; handle: string }[]>;
  holdRows(): Promise<{ address: string; id: string }[]>;
  bindingEventRows(): Promise<{ name: string; event: string; at: number }[]>;
  attachmentRows(): Promise<{ id: number; post_id: number | null }[]>;
  close(): void | Promise<void>;
};

// `pending`: rows a backend doesn't run yet, by name, each with its reason (none today: every row runs on both). A
// name that matches no row fails registration, so a renamed row can't slip out of the run.
export type BoardsBackend = { kind: "sqlite" | "postgres"; open(): Promise<BoardsHarness>; pending?: Readonly<Record<string, string>> };

const ME = "a@example.com", OTHER = "b@example.com";
const BE = `${ME}/be`, FE = `${ME}/fe`, OPS = `${ME}/ops`, QA = `${OTHER}/qa`;
const S1 = "id:0000000000001", S2 = "id:0000000000002", S3 = "id:0000000000003", CHILD = "id:0000000000004";
const T0 = 1_800_000_000_000;
const QUEUE_TTL = 30 * 60_000;
const SETTLED = "Tx used after its transaction settled";
const LIMITS = { file: 1 << 20, total: 1 << 20 };
// Byte order, as SQLite's BINARY collation and Postgres's COLLATE "C" compare.
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}
// The error a body's call rejects with, caught inside the body so the write commits.
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

export function boardsContract(backend: BoardsBackend): void {
  const pending = new Set(Object.keys(backend.pending ?? {}));
  const it = (name: string, fn: (h: BoardsHarness) => Promise<void>) => {
    if (pending.delete(name)) return test.skip(name, () => {});
    test(name, async () => {
      const h = await backend.open();
      try { await fn(h); } finally { await h.close(); }
    });
  };
  handles(it);
  boardRows(it);
  postRows(it);
  subscriptions(it);
  delivery(it);
  reads(it);
  roster(it);
  threads(it);
  queue(it);
  retention(it);
  if (pending.size) throw new Error(`boards contract: pending rows that match no row: ${[...pending].join("; ")}`);
}

type It = (name: string, fn: (h: BoardsHarness) => Promise<void>) => void;

const np = (board: string, author: string, body: string, now: number, more: Partial<NewPost> = {}): NewPost =>
  ({ board, author, body, parentId: null, now, expiresAt: null, authorId: null, via: null, authorUser: null, human: false, ...more });
const board = (h: BoardsHarness, name: string, o: { kind?: string; scope?: string | null; by?: string; now?: number } = {}) =>
  h.write(tx => h.boards.create(tx, { name, purpose: `${name} purpose`, scope: o.scope ?? null, kind: o.kind ?? "broadcast", createdBy: o.by ?? BE, now: o.now ?? T0 }));
const write = (h: BoardsHarness, p: NewPost) => h.write(tx => h.boards.insertPost(tx, p)).then(r => r.id);
const sub = (h: BoardsHarness, handle: string, name: string, mode: "push" | "digest" | "quiet" | "off") =>
  h.write(tx => h.boards.setSubscription(tx, handle, name, mode));
const target = (reason: PostTarget["reason"], wake: boolean): PostTarget => ({ reason, wake });

function handles(it: It): void {
  // From db.test.ts B5a1, B5b1, B5b1b1, B5b1b2, B5b2b and B5b3b: each method on a kept (settled) Tx is refused.
  it("every method refuses a Tx whose body settled", async h => {
    await board(h, "hall");
    const root = await write(h, np("hall", BE, "root", T0));
    const kept = await h.write(async tx => tx);
    const b = h.boards;
    for (const call of [
      () => b.get(kept, "hall"), () => b.post(kept, root), () => b.catalogPage(kept, ""), () => b.snapshotPage(kept, "hall", {}),
      () => b.pendingPushes(kept, FE), () => b.pendingDigests(kept, FE), () => b.acknowledge(kept, FE, { kind: "push", post_id: root }),
      () => b.ensure(kept, "x", "p", null, BE), () => b.isSubscribed(kept, FE, "hall"), () => b.setSubscription(kept, FE, "hall", "push"),
      () => b.unsubscribeScope(kept, FE, "team:x"), () => b.forget(kept, FE), () => b.prunePosts(kept, 0),
      () => b.views(kept, [FE], null), () => b.openSummaries(kept), () => b.roster(kept, null),
      () => b.create(kept, { name: "x", purpose: "p", scope: null, kind: "broadcast", createdBy: BE, now: T0 }),
      () => b.setArchived(kept, "hall", BE, T0), () => b.read(kept, "hall", FE, {}), () => b.threadRoot(kept, root),
      () => b.mute(kept, FE, root, true), () => b.lockForPost(kept, "hall"), () => b.insertPost(kept, np("hall", BE, "x", T0)),
      () => b.bindAttachments(kept, [1], { addresses: [BE], principal: ME }, root, LIMITS), () => b.authorAddresses(kept, BE, null),
      () => b.subscribers(kept, "hall"), () => b.threadFacts(kept, root), () => b.laneRows(kept, "hall", [BE]),
      () => b.claimQueuePost(kept, "hall", root, FE, T0, { note: "n", push: true }), () => b.insertOutbox(kept, root, [[FE, target("subscription", true)]]),
      () => b.redeliveryFacts(kept, `queue:hall:${root}`, FE),
    ]) expect(await failure(call)).toContain(SETTLED);
    expect(await b.get(h.read, "x")).toBeUndefined();
    expect(await b.isSubscribed(h.read, FE, "hall")).toBe(false);
  });

  it("a body's reads see its writes, and a body that throws leaves none of them", async h => {
    await board(h, "hall");
    const root = await write(h, np("hall", BE, "root", T0));
    const b = h.boards;
    await expect(h.write(async tx => {
      expect(await b.ensure(tx, "team", "p", "team:x", BE)).toBe(true);
      expect((await b.create(tx, { name: "fresh", purpose: "p", scope: null, kind: "queue", createdBy: BE, now: T0 }))?.name).toBe("fresh");
      expect(await b.get(tx, "fresh")).toMatchObject({ purpose: "p", created_by: BE, kind: "queue" });
      expect((await b.setArchived(tx, "hall", BE, T0 + 1))?.archived_by).toBe(BE);
      await b.setSubscription(tx, FE, "hall", "push");
      expect(await b.isSubscribed(tx, FE, "hall")).toBe(true);
      const p = await b.insertPost(tx, np("fresh", BE, "job", T0 + 2));
      expect(await b.post(tx, p.id)).toMatchObject({ body: "job" });
      expect(await b.claimQueuePost(tx, "fresh", p.id, FE, T0 + 3, { note: "n", push: true })).toBe(true);
      await b.insertOutbox(tx, root, [[FE, target("subscription", true)]]);
      expect((await b.pendingPushes(tx, FE)).map(r => r.post.id)).toEqual([root, p.id]);
      await b.acknowledge(tx, FE, { kind: "push", post_id: root });
      await b.mute(tx, FE, root, true);
      expect((await b.read(tx, "hall", FE, {})).posts.map(x => x.id)).toEqual([root]);
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect(await b.get(h.read, "team")).toBeUndefined();
    expect(await b.get(h.read, "fresh")).toBeUndefined();
    expect((await b.get(h.read, "hall"))?.archived_at).toBeUndefined();
    expect(await b.isSubscribed(h.read, FE, "hall")).toBe(false);
    expect(await h.outboxRows()).toEqual([]);
    expect(await h.muteRows()).toEqual([]);
    expect(await h.claimRows()).toEqual([]);
    expect(await h.eventRows()).toEqual([]);
  });
}

function boardRows(it: It): void {
  it("create returns the board (null when the name is taken); get shows an open board without archive keys; ensure normalizes the name and never overwrites", async h => {
    const b = h.boards;
    const made = await board(h, "hall", { scope: "team:x", kind: "queue", now: T0 + 5 });
    expect(made).toEqual({ name: "hall", purpose: "hall purpose", scope: "team:x", created_by: BE, created_at: T0 + 5, kind: "queue" });
    expect(Object.keys(made!)).not.toContain("archived_at");
    expect(await board(h, "hall", { by: FE })).toBeNull();
    expect(await b.get(h.read, "hall")).toEqual(made!);
    expect(await b.get(h.read, "none")).toBeUndefined();
    expect(await h.write(tx => b.ensure(tx, "#Ops", "ops board", null, FE))).toBe(true);
    expect(await h.write(tx => b.ensure(tx, "hall", "other", null, FE))).toBe(false);
    expect(await b.get(h.read, "hall")).toEqual(made!);
    // A mode's board: no kind given is a broadcast board, stamped by the store.
    const ops = await b.get(h.read, "ops");
    expect(ops).toMatchObject({ name: "ops", purpose: "ops board", scope: null, created_by: FE, kind: "broadcast" });
    expect(typeof ops!.created_at).toBe("number");
    // No creator subscription either way.
    expect(await b.subscribers(h.read, "hall")).toEqual([]);
    expect(await b.subscribers(h.read, "ops")).toEqual([]);
  });

  it("catalogPage: up to 100 boards named after the cursor, in byte order, archived ones included", async h => {
    const names = Array.from({ length: 103 }, (_, n) => `b${String(102 - n).padStart(3, "0")}`);
    await h.write(async tx => {
      for (const name of names) await h.boards.create(tx, { name, purpose: "p", scope: null, kind: "broadcast", createdBy: BE, now: T0 });
      for (const name of ["a-z", "a_z", "aZ"]) await h.boards.create(tx, { name, purpose: "p", scope: null, kind: "broadcast", createdBy: BE, now: T0 });
      await h.boards.setArchived(tx, "b000", BE, T0);
    });
    const all = [...names, "a-z", "a_z", "aZ"].sort(bytewise);
    const first = await h.boards.catalogPage(h.read, "");
    expect(first.map(x => x.name)).toEqual(all.slice(0, 100));
    expect(first.find(x => x.name === "b000")?.archived_by).toBe(BE);
    expect((await h.boards.catalogPage(h.read, first[99]!.name)).map(x => x.name)).toEqual(all.slice(100));
    expect(await h.boards.catalogPage(h.read, "zzz")).toEqual([]);
  });

  // #807 P3 C10 A1: the conditional write is the check.
  it("archive twice: the second is null and keeps the first's stamp; reopen twice the same; a missing board is null", async h => {
    const b = h.boards;
    await board(h, "hall");
    const archived = await h.write(tx => b.setArchived(tx, "hall", BE, T0 + 10));
    expect(archived).toMatchObject({ name: "hall", archived_at: T0 + 10, archived_by: BE });
    expect(await h.write(tx => b.setArchived(tx, "hall", FE, T0 + 20))).toBeNull();
    expect(await b.get(h.read, "hall")).toMatchObject({ archived_at: T0 + 10, archived_by: BE });
    const reopened = await h.write(tx => b.setArchived(tx, "hall", null, T0 + 30));
    expect(reopened?.name).toBe("hall");
    expect(Object.keys(reopened!)).not.toContain("archived_at");
    expect(await h.write(tx => b.setArchived(tx, "hall", null, T0 + 40))).toBeNull();
    expect(Object.keys((await b.get(h.read, "hall"))!)).not.toContain("archived_by");
    expect(await h.write(tx => b.setArchived(tx, "none", BE, T0))).toBeNull();
  });

  // #807 P3 C10e2 P5's serial half: the gate's read is get's answer (the lock is Postgres's, pg/boards.pg.test.ts).
  it("lockForPost reads the board as get does: open without archive keys, archived with them, a body's own archive, missing undefined", async h => {
    const b = h.boards;
    const made = await board(h, "hall");
    expect(await h.write(tx => b.lockForPost(tx, "hall"))).toEqual(made!);
    await h.write(tx => b.setArchived(tx, "hall", FE, T0 + 10));
    expect(await h.write(tx => b.lockForPost(tx, "hall"))).toEqual({ ...made!, archived_at: T0 + 10, archived_by: FE });
    await board(h, "ops");
    expect(await h.write(async tx => {
      await b.setArchived(tx, "ops", BE, T0 + 20);
      return b.lockForPost(tx, "ops");
    })).toMatchObject({ name: "ops", archived_at: T0 + 20, archived_by: BE });
    expect(await h.write(tx => b.lockForPost(tx, "none"))).toBeUndefined();
  });
}

function postRows(it: It): void {
  it("insertPost returns the post as readers see it (via only for a child's); post reads it back", async h => {
    await board(h, "hall");
    const b = h.boards;
    const root = await h.write(tx => b.insertPost(tx, np("hall", BE, "root", T0, { authorId: S1, authorUser: ME })));
    expect(root).toEqual({ id: root.id, board: "hall", author: BE, body: "root", parent_id: null, created_at: T0, expires_at: null });
    const reply = await h.write(tx => b.insertPost(tx, np("hall", FE, "reply", T0 + 1, { parentId: root.id, via: CHILD, expiresAt: T0 + 99 })));
    expect(reply).toEqual({ id: reply.id, board: "hall", author: FE, via: CHILD, body: "reply", parent_id: root.id, created_at: T0 + 1, expires_at: T0 + 99 });
    expect(reply.id).toBeGreaterThan(root.id);
    expect(await b.post(h.read, root.id)).toEqual(root);
    expect(await b.post(h.read, reply.id)).toEqual(reply);
    expect(await b.post(h.read, reply.id + 100)).toBeUndefined();
  });

  // #1355 (#1366): the row's mark is what the write said, not whether the author is human now.
  it("insertPost records the human mark as given: true reads marked, false or absent unmarked", async h => {
    await board(h, "hall");
    await h.alias(FE, { human: true });
    const marked = await write(h, np("hall", BE, "mine", T0, { human: true }));
    const plain = await write(h, np("hall", FE, "a human's system post", T0, { human: false }));
    const absent = await write(h, { ...np("hall", BE, "old caller", T0), human: undefined } as unknown as NewPost);
    expect(await h.postRow(marked)).toEqual({ parent_id: null, human: true });
    expect(await h.postRow(plain)).toEqual({ parent_id: null, human: false });
    expect(await h.postRow(absent)).toEqual({ parent_id: null, human: false });
  });

  // #807 P3 C10 P1's serial half: a reply whose parent is gone is the gate's refusal, never a constraint failure.
  it("insertPost refuses a parent that isn't a post with the gate's text, writing nothing and leaving the body usable", async h => {
    await board(h, "hall");
    const root = await write(h, np("hall", BE, "root", T0));
    const gone = root + 1000;
    const { e, after } = await h.write(async tx => {
      const e = await caught(() => h.boards.insertPost(tx, np("hall", FE, "orphan", T0 + 1, { parentId: gone })));
      return { e, after: await h.boards.insertPost(tx, np("hall", FE, "next", T0 + 2, { parentId: root })) };
    });
    expect(e).toBeInstanceOf(MissingPost);
    expect(e).toBeInstanceOf(CoreError);
    expect((e as Error).message).toBe(`parent_id ${gone} is not a post on #hall`);
    expect((await h.boards.snapshotPage(h.read, "hall", {})).posts.map(p => [p.body, p.parent_id])).toEqual([["root", null], ["next", root]]);
  });

  // The mapping is narrow: a reply whose parent exists fails for its own reason (here a board that doesn't exist, as a
  // board gone between the gate and the insert would), never as MissingPost.
  it("insertPost of a reply to an existing parent on a board that doesn't exist rejects, not as MissingPost, writing nothing", async h => {
    await board(h, "hall");
    const root = await write(h, np("hall", BE, "root", T0));
    const e = await caught(() => h.write(tx => h.boards.insertPost(tx, np("nope", FE, "reply", T0 + 1, { parentId: root }))));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(MissingPost);
    expect((e as Error).message).not.toContain("is not a post on");
    expect((await h.boards.snapshotPage(h.read, "hall", {})).posts.map(p => p.id)).toEqual([root]);
    expect(await h.boards.snapshotPage(h.read, "nope", {})).toEqual({ posts: [], next_before_id: null });
  });

  it("snapshotPage: options checked first; pages oldest first within a page, next_before_id while older posts remain; attachments ride along", async h => {
    await board(h, "hall");
    await board(h, "other");
    const ids: number[] = [];
    for (let n = 0; n < 5; n++) {
      ids.push(await write(h, np("hall", BE, `p${n}`, T0 + n)));
      await write(h, np("other", BE, `o${n}`, T0 + n));
    }
    const f = await h.upload(BE, ME, 7);
    await h.write(tx => h.boards.bindAttachments(tx, [f], { addresses: [BE], principal: ME }, ids[3]!, LIMITS));
    const b = h.boards;
    const page = await b.snapshotPage(h.read, "hall", { limit: 2 });
    expect(page.posts.map(p => p.id)).toEqual([ids[3], ids[4]]);
    expect(page.next_before_id).toBe(ids[3]!);
    expect(page.posts[0]!.attachments?.map(a => [a.id, a.size])).toEqual([[f, 7]]);
    expect(page.posts[1]!.attachments).toBeUndefined();
    const older = await b.snapshotPage(h.read, "hall", { limit: 2, before_id: page.next_before_id! });
    expect(older.posts.map(p => p.id)).toEqual([ids[1], ids[2]]);
    const last = await b.snapshotPage(h.read, "hall", { limit: 2, before_id: older.next_before_id! });
    expect(last).toEqual({ posts: [expect.objectContaining({ id: ids[0] })], next_before_id: null });
    expect((await b.snapshotPage(h.read, "hall", {})).posts.map(p => p.body)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(await b.snapshotPage(h.read, "empty", {})).toEqual({ posts: [], next_before_id: null });
    for (const [opts, text] of [
      [{ limit: 0 }, "snapshot limit must be an integer from 1 to 100"], [{ limit: 101 }, "snapshot limit must be an integer from 1 to 100"],
      [{ limit: 1.5 }, "snapshot limit must be an integer from 1 to 100"], [{ before_id: 0 }, "snapshot before_id must be a positive safe integer"],
    ] as const) {
      const e = await caught(() => b.snapshotPage(h.read, "hall", opts));
      expect(e).toBeInstanceOf(CoreError);
      expect((e as Error).message).toBe(text);
    }
  });

  it("bindAttachments binds the sender's unsent uploads in call order; an unknown id refuses with CoreError and binds none", async h => {
    await board(h, "hall");
    const p = await write(h, np("hall", BE, "files", T0));
    const [f1, f2] = [await h.upload(BE, ME, 10), await h.upload(S1, ME, 20)];
    const from = { addresses: [BE, S1], principal: ME };
    const { e, bound } = await h.write(async tx => {
      const e = await caught(() => h.boards.bindAttachments(tx, [f1, f2 + 100], from, p, LIMITS));
      return { e, bound: await h.boards.bindAttachments(tx, [f2, f1], from, p, LIMITS) };
    });
    expect(e).toBeInstanceOf(CoreError);
    expect(bound.map(a => [a.id, a.size])).toEqual([[f2, 20], [f1, 10]]);
    expect(await h.attachmentRows()).toEqual([{ id: f1, post_id: p }, { id: f2, post_id: p }]);
    expect(await h.write(tx => h.boards.bindAttachments(tx, [], from, p, LIMITS))).toEqual([]);
  });
}

function subscriptions(it: It): void {
  // From db.test.ts B5b1.
  it("setSubscription starts at the tip, changes only the mode after, refuses a bad mode; off, unsubscribeScope and isSubscribed", async h => {
    const b = h.boards;
    await board(h, "hall");
    await board(h, "crew", { scope: "team:x" });
    await board(h, "dock", { scope: "team:y" });
    expect(await h.write(tx => b.setSubscription(tx, FE, "crew", "push"))).toBeUndefined();
    expect(await h.subscription("crew", FE)).toEqual({ mode: "push", cursor: 0, notified_id: 0 });
    await write(h, np("hall", BE, "before", T0));
    const tip = await write(h, np("hall", BE, "tip", T0 + 1));
    await sub(h, FE, "hall", "digest");
    expect(await h.subscription("hall", FE)).toEqual({ mode: "digest", cursor: tip, notified_id: tip });
    await write(h, np("hall", BE, "after", T0 + 2));
    await sub(h, FE, "hall", "quiet");
    expect(await h.subscription("hall", FE)).toEqual({ mode: "quiet", cursor: tip, notified_id: tip });
    const e = await h.write(async tx => {
      const e = await caught(() => b.setSubscription(tx, FE, "hall", "loud" as "push"));
      expect(await b.isSubscribed(tx, FE, "hall")).toBe(true);
      return e;
    });
    expect(e).toBeInstanceOf(CoreError);
    expect((e as Error).message).toBe("mode must be push, digest, quiet, or off");
    expect((await h.subscription("hall", FE))?.mode).toBe("quiet");
    // off deletes; a second off is a no-op.
    await sub(h, FE, "hall", "off");
    await sub(h, FE, "hall", "off");
    expect(await b.isSubscribed(h.read, FE, "hall")).toBe(false);
    expect(await b.isSubscribed(h.read, FE, "crew")).toBe(true);
    // A scope's drop deletes its boards' subscriptions of the handle only.
    await sub(h, FE, "dock", "push");
    await sub(h, BE, "crew", "push");
    await h.write(tx => b.unsubscribeScope(tx, FE, "team:other"));
    expect(await b.isSubscribed(h.read, FE, "crew")).toBe(true);
    await h.write(tx => b.unsubscribeScope(tx, FE, "team:x"));
    expect(await b.isSubscribed(h.read, FE, "crew")).toBe(false);
    expect(await b.isSubscribed(h.read, FE, "dock")).toBe(true);
    expect(await b.isSubscribed(h.read, BE, "crew")).toBe(true);
  });

  it("subscribers lists a board's subscriptions in handle byte order", async h => {
    await board(h, "hall");
    for (const [handle, mode] of [[QA, "quiet"], [FE, "push"], ["Zed", "digest"], [BE, "push"]] as const) await sub(h, handle, "hall", mode);
    expect(await h.boards.subscribers(h.read, "hall")).toEqual(
      ([[BE, "push"], [FE, "push"], [QA, "quiet"], ["Zed", "digest"]] as const).map(([handle, mode]) => ({ handle, mode })).sort((x, y) => bytewise(x.handle, y.handle)));
    expect(await h.boards.subscribers(h.read, "none")).toEqual([]);
  });

  it("forget deletes a handle's pushes, subscriptions, mutes, watches and hold; its posts and claims and others' rows stay", async h => {
    await board(h, "hall");
    await h.alias(FE);
    await h.session(S1, ME);
    await h.hold(FE, S1, T0);
    await h.hold(BE, S1, T0 + 1);
    const p = await write(h, np("hall", FE, "mine", T0));
    // A post nothing references (no push, mute or reply) stays too.
    const lone = await write(h, np("hall", FE, "unreferenced", T0 + 1));
    await sub(h, FE, "hall", "push");
    await sub(h, BE, "hall", "push");
    await h.write(async tx => {
      await h.boards.insertOutbox(tx, p, [[FE, target("mention", true)], [BE, target("subscription", true)]]);
      await h.boards.mute(tx, FE, p, true);
      await h.boards.mute(tx, BE, p, true);
    });
    await h.claim({ key: "ticket:1", holder: FE, board: "hall", at: T0 });
    await h.watch("ticket:1", FE);
    await h.watch("ticket:1", BE);
    await h.write(tx => h.boards.forget(tx, FE));
    expect(await h.outboxRows()).toEqual([{ handle: BE, post_id: p, reason: "subscription", wake: true, delivered: false }]);
    expect(await h.boards.subscribers(h.read, "hall")).toEqual([{ handle: BE, mode: "push" }]);
    expect(await h.muteRows()).toEqual([{ handle: BE, root_id: p }]);
    expect(await h.watchRows()).toEqual([{ key: "ticket:1", handle: BE }]);
    expect(await h.holdRows()).toEqual([{ address: BE, id: S1 }]);
    expect((await h.boards.post(h.read, p))?.author).toBe(FE);
    expect(await h.boards.post(h.read, lone)).toMatchObject({ author: FE, body: "unreferenced" });
    expect((await h.claimRows()).map(c => c.holder)).toEqual([FE]);
  });
}

function delivery(it: It): void {
  // #807 P3 C10e1: a handle named twice in one call keeps its first target, as one insert per target in order does.
  it("insertOutbox with a handle named twice keeps the first target", async h => {
    await board(h, "hall");
    const p = await write(h, np("hall", BE, "one", T0));
    await h.write(tx => h.boards.insertOutbox(tx, p, [[FE, target("mention", true)], [QA, target("thread", false)], [FE, target("thread", false)]]));
    expect(await h.outboxRows()).toEqual([
      { handle: FE, post_id: p, reason: "mention", wake: true, delivered: false },
      { handle: QA, post_id: p, reason: "thread", wake: false, delivered: false },
    ].sort((x, y) => bytewise(x.handle, y.handle)));
  });

  // From db.test.ts B5a1, B5b2b.
  it("insertOutbox keeps a row already there; pendingPushes is the undelivered ones by post id with wake; acknowledge marks one", async h => {
    const b = h.boards;
    await board(h, "hall");
    await board(h, "dock");
    const p1 = await write(h, np("hall", BE, "one", T0));
    const p2 = await write(h, np("dock", BE, "two", T0 + 1));
    const p3 = await write(h, np("hall", BE, "three", T0 + 2));
    await h.write(async tx => {
      // Written out of post order.
      await b.insertOutbox(tx, p3, [[FE, target("thread", false)], [QA, target("subscription", true)]]);
      await b.insertOutbox(tx, p1, [[FE, target("mention", true)]]);
      await b.insertOutbox(tx, p2, [[FE, target("subscription", true)]]);
      // A row already there stays as it is.
      await b.insertOutbox(tx, p1, [[FE, target("subscription", false)]]);
    });
    const pushes = await b.pendingPushes(h.read, FE);
    expect(pushes.map(r => [r.post.id, r.reason, r.wake])).toEqual([[p1, "mention", true], [p2, "subscription", true], [p3, "thread", false]]);
    expect(pushes[0]!.post).toEqual({ id: p1, board: "hall", author: BE, body: "one", parent_id: null, created_at: T0, expires_at: null });
    await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: p2 }));
    expect((await b.pendingPushes(h.read, FE)).map(r => r.post.id)).toEqual([p1, p3]);
    expect((await h.outboxRows()).find(r => r.handle === FE && r.post_id === p2)?.delivered).toBe(true);
    // An ack with no outbox row is a no-op.
    await h.write(tx => b.acknowledge(tx, BE, { kind: "push", post_id: p1 }));
    expect((await b.pendingPushes(h.read, QA)).map(r => r.post.id)).toEqual([p3]);
    expect(await b.pendingPushes(h.read, BE)).toEqual([]);
  });

  it("acknowledge: a subscription push moves a push-mode cursor and notified_id up, never back; a digest moves notified_id", async h => {
    const b = h.boards;
    await board(h, "hall");
    await sub(h, FE, "hall", "push");
    await sub(h, QA, "hall", "digest");
    const [p1, p2] = [await write(h, np("hall", BE, "one", T0)), await write(h, np("hall", BE, "two", T0 + 1))];
    const p3 = await write(h, np("hall", BE, "three", T0 + 2));
    await h.write(async tx => {
      for (const p of [p1, p2]) await b.insertOutbox(tx, p, [[FE, target("subscription", true)], [QA, target("subscription", true)]]);
      await b.insertOutbox(tx, p3, [[FE, target("mention", true)]]);
    });
    await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: p2 }));
    expect(await h.subscription("hall", FE)).toEqual({ mode: "push", cursor: p2, notified_id: p2 });
    await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: p1 }));
    expect(await h.subscription("hall", FE)).toEqual({ mode: "push", cursor: p2, notified_id: p2 });
    // A mention's ack moves no cursor; a digest subscriber's subscription push moves none either.
    await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: p3 }));
    expect(await h.subscription("hall", FE)).toEqual({ mode: "push", cursor: p2, notified_id: p2 });
    await h.write(tx => b.acknowledge(tx, QA, { kind: "push", post_id: p2 }));
    expect(await h.subscription("hall", QA)).toEqual({ mode: "digest", cursor: 0, notified_id: 0 });
    await h.write(tx => b.acknowledge(tx, QA, { kind: "digest", board: "hall", latest_id: p3 }));
    expect(await h.subscription("hall", QA)).toEqual({ mode: "digest", cursor: 0, notified_id: p3 });
    await h.write(tx => b.acknowledge(tx, QA, { kind: "digest", board: "hall", latest_id: p1 }));
    expect((await h.subscription("hall", QA))?.notified_id).toBe(p3);
    expect((await h.outboxRows()).filter(r => r.delivered).map(r => [r.handle, r.post_id])).toEqual([[FE, p1], [FE, p2], [QA, p2], [FE, p3]]);
  });

  it("pendingDigests: a digest subscription with unread, nothing sent since its catch-up, and no queue board; latest is the newest unread", async h => {
    const b = h.boards;
    await h.session(S1, ME);
    await h.hold(FE, S1, T0);
    for (const name of ["hall", "dock", "jobs", "calm"]) await board(h, name, { kind: name === "jobs" ? "queue" : "broadcast" });
    for (const name of ["hall", "dock", "jobs", "calm"]) await sub(h, FE, name, "digest");
    await sub(h, QA, "hall", "digest");
    const h1 = await write(h, np("hall", BE, "h1", T0));
    const h2 = await write(h, np("hall", BE, "h2", T0 + 1));
    // Its own posts (by address or by its session) and a post pushed to it don't count.
    await write(h, np("hall", FE, "mine", T0 + 2));
    await write(h, np("hall", `${ME}/other`, "by my session", T0 + 3, { authorId: S1 }));
    const pushed = await write(h, np("hall", BE, "pushed", T0 + 4));
    await h.write(tx => b.insertOutbox(tx, pushed, [[FE, target("thread", false)]]));
    const d1 = await write(h, np("dock", BE, "d1", T0 + 5));
    await write(h, np("jobs", BE, "job", T0 + 6));
    const digests = (await b.pendingDigests(h.read, FE)).sort((x, y) => bytewise(x.board, y.board));
    expect(digests.map(d => [d.board, d.unread, d.latest.id])).toEqual([["dock", 1, d1], ["hall", 2, h2]]);
    expect(digests[1]!.latest).toEqual({ id: h2, board: "hall", author: BE, body: "h2", parent_id: null, created_at: T0 + 1, expires_at: null });
    expect((await b.pendingDigests(h.read, QA)).map(d => [d.board, d.unread])).toEqual([["hall", 5]]);
    // Sent (notified past the cursor): not due again until the reader catches up.
    await h.write(tx => b.acknowledge(tx, FE, { kind: "digest", board: "hall", latest_id: h2 }));
    expect((await b.pendingDigests(h.read, FE)).map(d => d.board)).toEqual(["dock"]);
    await h.write(tx => b.read(tx, "hall", FE, {}));
    await write(h, np("hall", BE, "h3", T0 + 7));
    expect((await b.pendingDigests(h.read, FE)).map(d => d.board).sort(bytewise)).toEqual(["dock", "hall"]);
    expect(h1).toBeLessThan(h2);
  });
}

function reads(it: It): void {
  // From db.test.ts B5b1b2.
  it("read: unread oldest first, else the latest; the cursor moves up and the read posts' pushes are delivered; a peek changes nothing", async h => {
    const b = h.boards;
    await board(h, "hall");
    await board(h, "other");
    await sub(h, FE, "hall", "push");
    const ids: number[] = [];
    for (let n = 0; n < 4; n++) ids.push(await write(h, np("hall", BE, `p${n}`, T0 + n)));
    await write(h, np("other", BE, "elsewhere", T0));
    const mine = await write(h, np("hall", FE, "mine", T0 + 9));
    await h.write(async tx => {
      await b.insertOutbox(tx, ids[1]!, [[FE, target("subscription", true)]]);
      // Delivered already: not unread.
      await b.insertOutbox(tx, ids[2]!, [[FE, target("mention", true)]]);
      await b.acknowledge(tx, FE, { kind: "push", post_id: ids[2]! });
      // A deferred push still waiting counts as unread.
      await b.insertOutbox(tx, ids[3]!, [[FE, target("thread", false)]]);
    });
    // A peek: the latest, nothing moves.
    const peek = await h.write(tx => b.read(tx, "hall", null, {}));
    expect(peek).toEqual({ board: "hall", posts: expect.any(Array), unread_remaining: 0 });
    expect(peek.posts.map(p => p.id)).toEqual([...ids, mine]);
    expect(await h.subscription("hall", FE)).toEqual({ mode: "push", cursor: 0, notified_id: 0 });
    // Unread, oldest first, limited: not its own, not pushed and woken (ids[1]'s row waits but woke; ids[2] delivered).
    const first = await h.write(tx => b.read(tx, "hall", FE, { limit: 1 }));
    expect(first.posts.map(p => p.id)).toEqual([ids[0]]);
    expect(first.unread_remaining).toBe(1);
    expect((await h.subscription("hall", FE))?.cursor).toBe(ids[0]);
    const second = await h.write(tx => b.read(tx, "hall", FE, {}));
    expect(second.posts.map(p => p.id)).toEqual([ids[3]]);
    expect(second.unread_remaining).toBe(0);
    expect((await h.subscription("hall", FE))?.cursor).toBe(ids[3]);
    expect((await h.outboxRows()).filter(r => r.handle === FE).map(r => [r.post_id, r.delivered])).toEqual([[ids[1], false], [ids[2], true], [ids[3], true]]);
    // Nothing unread: the latest 10 (here all five), oldest first; the cursor never moves back.
    const latest = await h.write(tx => b.read(tx, "hall", FE, { limit: 2 }));
    expect(latest.posts.map(p => p.id)).toEqual([ids[3], mine]);
    expect((await h.subscription("hall", FE))?.cursor).toBe(mine);
    await h.write(tx => b.read(tx, "hall", FE, { before_id: ids[2] }));
    expect((await h.subscription("hall", FE))?.cursor).toBe(mine);
    // An unsubscribed reader gets the latest and moves no cursor of its own.
    expect((await h.write(tx => b.read(tx, "hall", QA, {}))).posts.map(p => p.id)).toEqual([...ids, mine]);
    expect(await h.subscription("hall", QA)).toBeUndefined();
  });

  it("read with before_id pages back oldest first; with thread, the whole thread on this board by id", async h => {
    const b = h.boards;
    await board(h, "hall");
    const root = await write(h, np("hall", BE, "root", T0));
    const other = await write(h, np("hall", BE, "other root", T0 + 1));
    const r1 = await write(h, np("hall", FE, "r1", T0 + 2, { parentId: root }));
    const r2 = await write(h, np("hall", BE, "r2", T0 + 3, { parentId: r1 }));
    const r3 = await write(h, np("hall", QA, "r3", T0 + 4, { parentId: root }));
    expect((await h.write(tx => b.read(tx, "hall", null, { before_id: r2, limit: 2 }))).posts.map(p => p.id)).toEqual([other, r1]);
    expect((await h.write(tx => b.read(tx, "hall", null, { before_id: r1 }))).posts.map(p => p.id)).toEqual([root, other]);
    expect((await h.write(tx => b.read(tx, "hall", null, { thread: r2 }))).posts.map(p => p.id)).toEqual([root, r1, r2, r3]);
    expect((await h.write(tx => b.read(tx, "elsewhere", null, { thread: r2 }))).posts).toEqual([]);
  });

  // From db.test.ts B5b1b1.
  it("views: each handle's view of each board in handle order then board name, with mode, post count and unread", async h => {
    const b = h.boards;
    await h.session(S1, ME);
    await h.hold(BE, S1, T0);
    for (const name of ["hall", "dock", "aisle"]) await board(h, name);
    await sub(h, FE, "hall", "digest");
    await sub(h, QA, "dock", "push");
    await write(h, np("hall", BE, "hi", T0));
    await write(h, np("hall", `${ME}/x`, "by be's session", T0 + 1, { authorId: S1 }));
    const pushed = await write(h, np("hall", QA, "pushed", T0 + 2));
    await h.write(tx => b.insertOutbox(tx, pushed, [[FE, target("mention", true)]]));
    await write(h, np("dock", BE, "d", T0 + 3));
    const views = await b.views(h.read, [QA, FE], null);
    expect(views.map(v => [v.handle, v.row.name, v.row.mode, v.row.posts, v.row.unread])).toEqual([
      [QA, "aisle", null, 0, 0], [QA, "dock", "push", 1, 1], [QA, "hall", null, 3, 0],
      [FE, "aisle", null, 0, 0], [FE, "dock", null, 1, 0], [FE, "hall", "digest", 3, 2],
    ]);
    expect(views[0]!.row).toMatchObject({ purpose: "aisle purpose", created_by: BE });
    expect((await b.views(h.read, [BE, FE], "hall")).map(v => [v.handle, v.row.unread])).toEqual([[BE, 0], [FE, 2]]);
    expect(await b.views(h.read, [FE], "nope")).toEqual([]);
    expect(await b.views(h.read, [], null)).toEqual([]);
  });

  // #807 P3 C10e1: a push that neither woke nor was delivered (a deferred thread push) still counts as unread; one that
  // woke doesn't. A post by a child of the reader's session is its own.
  it("views counts a deferred push as unread, not a waking one, and leaves out a child session's posts", async h => {
    const b = h.boards;
    await h.session(S1, ME);
    await h.session(CHILD, ME, { rootId: S1 });
    await h.hold(BE, S1, T0);
    await board(h, "hall");
    await sub(h, BE, "hall", "digest");
    const deferred = await write(h, np("hall", QA, "deferred", T0));
    const woke = await write(h, np("hall", QA, "woke", T0 + 1));
    await write(h, np("hall", `${ME}/kid`, "by a child", T0 + 2, { authorId: CHILD }));
    await h.write(async tx => {
      await b.insertOutbox(tx, deferred, [[BE, target("thread", false)]]);
      await b.insertOutbox(tx, woke, [[BE, target("mention", true)]]);
    });
    expect((await b.views(h.read, [BE], "hall")).map(v => [v.row.posts, v.row.unread])).toEqual([[3, 1]]);
  });

  // #807 P3 C10e1: the views row's subscribed readers own no post, so this pins NOT_OWN in views' and read's counts.
  it("views and read leave out a subscribed reader's own posts, as its address or as its session", async h => {
    const b = h.boards;
    await h.session(S1, ME);
    await h.hold(BE, S1, T0);
    await board(h, "hall");
    await sub(h, BE, "hall", "digest");
    await write(h, np("hall", BE, "mine", T0));
    await write(h, np("hall", `${ME}/x`, "my session's", T0 + 1, { authorId: S1 }));
    const theirs = await write(h, np("hall", QA, "theirs", T0 + 2));
    expect((await b.views(h.read, [BE], "hall")).map(v => [v.row.posts, v.row.unread])).toEqual([[3, 1]]);
    const got = await h.write(tx => b.read(tx, "hall", BE, {}));
    expect([got.posts.map(p => p.id), got.unread_remaining]).toEqual([[theirs], 0]);
  });

  it("openSummaries: every open board by name, its post count, no mode, nothing unread", async h => {
    for (const name of ["hall", "dock", "attic"]) await board(h, name);
    await write(h, np("dock", BE, "d", T0));
    await h.write(tx => h.boards.setArchived(tx, "attic", BE, T0));
    expect((await h.boards.openSummaries(h.read)).map(r => [r.name, r.mode, r.unread, r.posts])).toEqual([["dock", null, 0, 1], ["hall", null, 0, 0]]);
  });
}

function roster(it: It): void {
  it("roster without a board: every alias ever seen, by address, with its holder's facts and status", async h => {
    await h.alias(QA, { lastSeen: T0 + 3 });
    await h.alias(FE, { lastSeen: T0 + 2, human: true });
    await h.alias(BE, { lastSeen: T0 + 1, queueOff: true });
    await h.alias(OPS);
    await h.session(S1, ME, { status: "busy" });
    await h.hold(BE, S1, T0);
    const rows = await h.boards.roster(h.read, null);
    expect(rows.map(r => r.handle)).toEqual([BE, FE, QA].sort(bytewise));
    expect(rows.find(r => r.handle === BE)).toMatchObject({ last_seen: T0 + 1, id: S1, principal: ME, status: "busy", queue_off: 1, scope_kind: "person", scope_ref: ME });
    expect(rows.find(r => r.handle === FE)).toMatchObject({ id: null, status: null, human: 1 });
  });

  // #807 P3 C10e1: a flag never set reads null, not 0; an alias no session holds names the ended session that last
  // bound it, but its status only while held.
  it("roster without a board: unset flags read null; an unheld alias's last session shows no status", async h => {
    await h.alias(QA, { lastSeen: T0 });
    await h.alias(OPS, { lastSeen: T0 });
    await h.session(S1, ME, { status: "busy" });
    await h.session(S2, ME, { status: "away", endedAt: T0 });
    await h.hold(QA, S1, T0);
    await h.bindingEvent({ session: S2, name: OPS, event: "bound", at: T0 });
    const rows = await h.boards.roster(h.read, null);
    expect(rows.find(r => r.handle === QA)).toMatchObject({ id: S1, status: "busy", human: null, queue_off: null, launcher: null });
    expect(rows.find(r => r.handle === OPS)).toMatchObject({ id: S2, status: null, status_at: null });
  });

  it("roster of a board: its subscribers by handle, an ID's subscription under its primary hold, one row each", async h => {
    await board(h, "hall");
    await h.alias(BE);
    await h.alias(FE);
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.hold(FE, S1, T0 + 1);
    await h.hold(BE, S1, T0);
    await sub(h, S1, "hall", "push");
    await sub(h, FE, "hall", "digest");
    await sub(h, S2, "hall", "quiet");
    await sub(h, QA, "hall", "push");
    const rows = await h.boards.roster(h.read, "hall");
    expect(rows.map(r => [r.handle, r.mode, r.id])).toEqual(
      [[BE, "push", S1], [FE, "digest", S1], [QA, "push", null], [S2, "quiet", S2]].sort((x, y) => bytewise(x[0]!, y[0]!)));
    // The primary's own subscription wins over its session ID's.
    await sub(h, BE, "hall", "quiet");
    expect((await h.boards.roster(h.read, "hall")).filter(r => r.handle === BE).map(r => r.mode)).toEqual(["quiet"]);
    expect(await h.boards.roster(h.read, "none")).toEqual([]);
  });
}

function threads(it: It): void {
  it("threadRoot, threadFacts and mute: a reply's root, the thread's authors by first post, the parent's and root's authors, who muted it", async h => {
    const b = h.boards;
    await board(h, "hall");
    const root = await write(h, np("hall", QA, "root", T0));
    const r1 = await write(h, np("hall", FE, "r1", T0 + 1, { parentId: root }));
    const r2 = await write(h, np("hall", BE, "r2", T0 + 2, { parentId: r1 }));
    await write(h, np("hall", FE, "r3", T0 + 3, { parentId: root }));
    const other = await write(h, np("hall", OPS, "other", T0 + 4));
    expect(await b.threadRoot(h.read, r2)).toBe(root);
    expect(await b.threadRoot(h.read, root)).toBe(root);
    expect(await b.threadRoot(h.read, other + 50)).toBe(other + 50);
    await h.write(async tx => {
      await b.mute(tx, OPS, root, true);
      await b.mute(tx, BE, root, true);
      await b.mute(tx, BE, root, true);
      await b.mute(tx, FE, other, true);
    });
    expect(await h.muteRows()).toEqual([{ handle: BE, root_id: root }, { handle: FE, root_id: other }, { handle: OPS, root_id: root }].sort((x, y) => bytewise(x.handle, y.handle)));
    const f = await b.threadFacts(h.read, r2);
    expect({ ...f, muted: [...f.muted].sort(bytewise) }).toEqual({ root, authors: [QA, FE, BE], parentAuthor: BE, rootAuthor: QA, muted: [BE, OPS].sort(bytewise) });
    await h.write(tx => b.mute(tx, BE, root, false));
    expect((await b.threadFacts(h.read, root)).muted).toEqual([OPS]);
  });

  // #807 P3 C10e1: with nothing unread and no limit, a read is the latest 10; a limit is clamped to 1..200.
  it("read with nothing unread and no limit is the latest 10, oldest first", async h => {
    await board(h, "hall");
    const ids: number[] = [];
    for (let n = 0; n < 12; n++) ids.push(await write(h, np("hall", QA, `p${n}`, T0 + n)));
    expect((await h.write(tx => h.boards.read(tx, "hall", null, {}))).posts.map(p => p.id)).toEqual(ids.slice(2));
    expect((await h.write(tx => h.boards.read(tx, "hall", null, { limit: 0 }))).posts.map(p => p.id)).toEqual(ids.slice(11));
  });

  // #807 P3 C10e1: the row above is two replies deep, where a walk one level short still lands on the root; eight
  // deep catches a walk cut off at any depth up to six.
  it("threadRoot, threadFacts and a thread read reach the root from eight replies down", async h => {
    const b = h.boards;
    await board(h, "hall");
    let id = await write(h, np("hall", QA, "root", T0));
    const ids = [id];
    for (const [n, who] of [[1, FE], [2, BE], [3, OPS], [4, FE], [5, BE], [6, OPS], [7, FE], [8, BE]] as const) ids.push(id = await write(h, np("hall", who, `r${n}`, T0 + n, { parentId: id })));
    expect(await b.threadRoot(h.read, id)).toBe(ids[0]);
    expect(await b.threadFacts(h.read, id)).toMatchObject({ root: ids[0], authors: [QA, FE, BE, OPS], parentAuthor: BE, rootAuthor: QA });
    expect(await b.threadRoot(h.read, ids[1]!)).toBe(ids[0]);
    expect((await h.write(tx => b.read(tx, "hall", null, { thread: id }))).posts.map(p => p.id)).toEqual(ids);
  });
}

function queue(it: It): void {
  it("authorAddresses: the author, its session's ID and holds, a child's root's ID and holds; a set", async h => {
    await h.session(S1, ME);
    await h.session(CHILD, ME, { rootId: S1 });
    await h.hold(BE, S1, T0);
    await h.hold(FE, S1, T0 + 1);
    const set = async (author: string, id: string | null) => (await h.boards.authorAddresses(h.read, author, id)).sort(bytewise);
    expect(await set(OPS, null)).toEqual([OPS]);
    expect(await set(BE, S1)).toEqual([BE, FE, S1].sort(bytewise));
    expect(await set(OPS, CHILD)).toEqual([OPS, CHILD, S1, BE, FE].sort(bytewise));
  });

  it("laneRows: push subscribers as their session's primary, less the poster, opted-out, ended and human ones, least recently woken first", async h => {
    await board(h, "jobs", { kind: "queue" });
    await board(h, "other", { kind: "queue" });
    for (const a of [BE, FE, OPS, QA, `${ME}/quiet`, `${ME}/off`, `${ME}/human`, `${ME}/never`]) {
      await h.alias(a, { queueOff: a.endsWith("/off"), human: a.endsWith("/human") });
    }
    await h.session(S1, ME);
    await h.session(S2, ME, { endedAt: T0 });
    await h.session(S3, ME);
    await h.hold(OPS, S1, T0);
    await h.hold(`${ME}/z-second`, S1, T0 + 1);
    for (const handle of [BE, FE, S1, QA, S2, S3, `${ME}/off`, `${ME}/human`, `${ME}/never`, "unknown"]) await sub(h, handle, "jobs", "push");
    await sub(h, `${ME}/quiet`, "jobs", "quiet");
    // Woken: BE by a queue take at T0+30; QA by a push of a jobs post at T0+20; S1's session by a take as its second
    // hold at T0+10; FE by a take on another board (doesn't count) and a non-queue key (doesn't count); never by a
    // release, and by a take of a key that only starts like a queue key (neither counts).
    const post = await write(h, np("jobs", OPS, "job", T0 + 20));
    await h.write(tx => h.boards.insertOutbox(tx, post, [[QA, target("subscription", true)]]));
    await h.claimEvent({ key: "queue:jobs:1", handle: BE, event: "take", board: "jobs", at: T0 + 30 });
    await h.claimEvent({ key: "queue:jobs:2", handle: `${ME}/z-second`, event: "take", board: "jobs", at: T0 + 10 });
    await h.claimEvent({ key: "queue:other:3", handle: FE, event: "take", board: "other", at: T0 + 40 });
    await h.claimEvent({ key: "ticket:9", handle: FE, event: "take", board: "jobs", at: T0 + 50 });
    await h.claimEvent({ key: "queue:jobs:4", handle: `${ME}/never`, event: "release", board: "jobs", at: T0 + 60 });
    await h.claimEvent({ key: "queues:jobs:5", handle: `${ME}/never`, event: "take", board: "jobs", at: T0 + 70 });
    const lanes = await h.boards.laneRows(h.read, "jobs", []);
    const never = [FE, `${ME}/never`, S3].sort(bytewise);
    expect(lanes).toEqual([...never, OPS, QA, BE]);
    // The poster's addresses are left out.
    expect(await h.boards.laneRows(h.read, "jobs", [QA, FE])).toEqual([...never.filter(x => x !== FE), OPS, BE]);
    expect(await h.boards.laneRows(h.read, "other", [])).toEqual([]);
  });


  // #1351: the row above's takes carry no session. A live session's take counts for its lane under whatever name it
  // took it as; an ended session's counts under its handle's holder now.
  // #807 P3 C10e1: a push of a post on another board doesn't wake a lane here.
  it("laneRows: a push of another board's post doesn't count as waking a lane on this one", async h => {
    await board(h, "jobs", { kind: "queue" });
    await board(h, "hall");
    await h.alias(BE);
    await h.alias(FE);
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.hold(BE, S1, T0);
    await h.hold(FE, S2, T0);
    await sub(h, S1, "jobs", "push");
    await sub(h, S2, "jobs", "push");
    await h.claimEvent({ key: "queue:jobs:1", handle: FE, event: "take", board: "jobs", at: T0 + 10 });
    const elsewhere = await write(h, np("hall", QA, "elsewhere", T0 + 50));
    await h.write(tx => h.boards.insertOutbox(tx, elsewhere, [[BE, target("mention", true)]]));
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([BE, FE]);
  });

  it("laneRows with session-keyed takes: a live session's take counts for its lane, an ended one's for its handle's holder now", async h => {
    await board(h, "jobs", { kind: "queue" });
    const OLD = `${ME}/old`;
    await h.alias(BE);
    await h.alias(FE);
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.session(S3, ME, { endedAt: T0 });
    await h.hold(BE, S1, T0);
    await h.hold(FE, S2, T0);
    await sub(h, S1, "jobs", "push");
    await sub(h, S2, "jobs", "push");
    // S1 took one as OLD, an alias it has since let go: still S1's, so BE's lane, at T0+50.
    await h.claimEvent({ key: "queue:jobs:1", handle: OLD, event: "take", board: "jobs", at: T0 + 50, session: S1 });
    // An old row as FE at T0+10, and one by S3 (ended) as FE at T0+20: both FE's now.
    await h.claimEvent({ key: "queue:jobs:2", handle: FE, event: "take", board: "jobs", at: T0 + 10 });
    await h.claimEvent({ key: "queue:jobs:3", handle: FE, event: "take", board: "jobs", at: T0 + 20, session: S3 });
    // A session-keyed take of a key that only starts like a queue key doesn't count.
    await h.claimEvent({ key: "queues:jobs:9", handle: FE, event: "take", board: "jobs", at: T0 + 90, session: S2 });
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
    // S2's own take as FE, later than BE's: FE goes last.
    await h.claimEvent({ key: "queue:jobs:4", handle: FE, event: "take", board: "jobs", at: T0 + 60, session: S2 });
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([BE, FE]);
    // S1's take as FE, which S2 holds now (as a moved alias): S1's turn, so BE's lane, never FE's.
    await h.claimEvent({ key: "queue:jobs:5", handle: FE, event: "take", board: "jobs", at: T0 + 70, session: S1 });
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
  });
  // #1370: the push half follows the receiving session as the take half does (#1351).
  it("laneRows with session-keyed pushes: a live session's push counts for its lane, an ended one's or an old row's for its handle's holder now", async h => {
    await board(h, "jobs", { kind: "queue" });
    const OLD = `${ME}/old`;
    await h.alias(BE);
    await h.alias(FE);
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.session(S3, ME, { endedAt: T0 });
    await h.hold(BE, S1, T0);
    await h.hold(FE, S2, T0);
    await sub(h, S1, "jobs", "push");
    await sub(h, S2, "jobs", "push");
    const at = (t: number) => write(h, np("jobs", QA, "job", T0 + t));
    // S1 was pushed one as OLD, an alias it has since let go: still S1's, so BE's lane, at T0+50.
    await h.push(OLD, await at(50), S1);
    // An old row to FE at T0+10, and one S3 (ended) received as FE at T0+20: both FE's now.
    await h.push(FE, await at(10));
    await h.push(FE, await at(20), S3);
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
    // S2's own push as FE, later than BE's: FE goes last.
    await h.push(FE, await at(60), S2);
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([BE, FE]);
    // S1's push as FE, which S2 holds now (a moved alias): S1's turn, so BE's lane, never FE's.
    await h.push(FE, await at(70), S1);
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
  });

  // #1461: a push still unread when its alias moved is the reader's. OPS's queue post was taken and pushed while S1 held
  // OPS (the fixtures' session S1); S2 holds OPS now and receives it, by acknowledge or by a read that shows it. Its
  // outbox row and its take then name S2, so the rotation credits S2's lane (FE), not S1's (BE).
  for (const via of ["acknowledge", "read"] as const) {
    it(`a push delivered (${via}) after its alias moved: the outbox row and the take re-record the reader's session`, async h => {
      await board(h, "jobs", { kind: "queue" });
      for (const a of [BE, FE, OPS]) await h.alias(a);
      await h.session(S1, ME);
      await h.session(S2, ME);
      await h.hold(BE, S1, T0);
      await h.hold(FE, S2, T0);
      await h.hold(OPS, S2, T0 + 1); // S2's lane stays FE, its older hold
      await sub(h, S1, "jobs", "push");
      await sub(h, S2, "jobs", "push");
      const p = await write(h, np("jobs", QA, "job", T0 + 50));
      await h.claim({ key: `queue:jobs:${p}`, holder: OPS, board: "jobs", at: T0 + 60 });
      await h.claimEvent({ key: `queue:jobs:${p}`, handle: OPS, event: "take", board: "jobs", at: T0 + 60, session: S1 });
      await h.push(OPS, p, S1);
      // Undelivered, both still S1's: BE was woken (the take at T0+60, the push at T0+50), FE never.
      expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
      await h.write(tx => via === "acknowledge"
        ? h.boards.acknowledge(tx, OPS, { kind: "push", post_id: p })
        : h.boards.read(tx, "jobs", OPS, {}).then(() => {}));
      expect(await h.outboxSessions()).toEqual([{ handle: OPS, post_id: p, session_id: S2 }]);
      // S2 (FE) received it; S1 (BE) was never woken. A take left S1's would keep BE at T0+60, after FE's push.
      expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([BE, FE]);
    });
  }

  // #1461 audit L1: a stale push, read after the post's claim stopped naming OPS (lapsed and gone, or redelivered to
  // another lane): the outbox row is the reader's, but the take stays S1's, so BE keeps its turn at T0+60, after FE's
  // push at T0+50. Mutation: creditQueueTakes without its claims condition gives the take to S2 ([BE, FE]).
  for (const claim of ["lapsed", "redelivered"] as const) {
    it(`a push delivered after its claim ${claim}: the take keeps the session whose turn it was`, async h => {
      await board(h, "jobs", { kind: "queue" });
      for (const a of [BE, FE, OPS, QA]) await h.alias(a);
      await h.session(S1, ME);
      await h.session(S2, ME);
      await h.hold(BE, S1, T0);
      await h.hold(FE, S2, T0);
      await h.hold(OPS, S2, T0 + 1);
      await sub(h, S1, "jobs", "push");
      await sub(h, S2, "jobs", "push");
      const p = await write(h, np("jobs", QA, "job", T0 + 50));
      if (claim === "redelivered") await h.claim({ key: `queue:jobs:${p}`, holder: QA, board: "jobs", at: T0 + 70 });
      await h.claimEvent({ key: `queue:jobs:${p}`, handle: OPS, event: "take", board: "jobs", at: T0 + 60, session: S1 });
      await h.push(OPS, p, S1);
      await h.write(tx => h.boards.acknowledge(tx, OPS, { kind: "push", post_id: p }));
      expect(await h.outboxSessions()).toEqual([{ handle: OPS, post_id: p, session_id: S2 }]);
      expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual([FE, BE]);
    });
  }

  // #1461 audit L2: only a push's first delivery credits. Delivered while no session held OPS (both rows NULL), then S2
  // binds it and the push is acknowledged again: neither row moves to S2. Mutation: pg acknowledge without its
  // first-delivery guard re-records both.
  it("a repeat acknowledge after the address's holder changed credits nothing", async h => {
    await board(h, "jobs", { kind: "queue" });
    for (const a of [BE, FE, OPS]) await h.alias(a);
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.hold(BE, S1, T0);
    await h.hold(FE, S2, T0);
    await sub(h, S1, "jobs", "push");
    await sub(h, S2, "jobs", "push");
    const p = await write(h, np("jobs", QA, "job", T0 + 50));
    await h.claim({ key: `queue:jobs:${p}`, holder: OPS, board: "jobs", at: T0 + 60 });
    await h.claimEvent({ key: `queue:jobs:${p}`, handle: OPS, event: "take", board: "jobs", at: T0 + 60, session: S1 });
    await h.push(OPS, p, S1);
    const ack = () => h.write(tx => h.boards.acknowledge(tx, OPS, { kind: "push", post_id: p }));
    await ack();
    expect(await h.outboxSessions()).toEqual([{ handle: OPS, post_id: p, session_id: null }]);
    const before = await h.boards.laneRows(h.read, "jobs", []);
    await h.hold(OPS, S2, T0 + 1);
    await ack();
    expect(await h.outboxSessions()).toEqual([{ handle: OPS, post_id: p, session_id: null }]);
    expect(await h.boards.laneRows(h.read, "jobs", [])).toEqual(before);
  });

  it("insertOutbox and claimQueuePost record the receiving session: an alias's holder, a session ID itself, null for an alias no session holds", async h => {
    await board(h, "jobs", { kind: "queue" });
    await h.session(S1, ME);
    await h.session(S2, ME);
    await h.hold(FE, S1, T0);
    const [p1, p2] = [await write(h, np("jobs", QA, "one", T0)), await write(h, np("jobs", QA, "two", T0))];
    await h.write(tx => h.boards.insertOutbox(tx, p1, [[FE, target("mention", true)], [S2, target("subscription", true)], [BE, target("thread", false)]]));
    expect(await h.write(tx => h.boards.claimQueuePost(tx, "jobs", p2, FE, T0 + 5, { note: "queue post", push: true }))).toBe(true);
    expect(await h.outboxSessions()).toEqual([
      ...[{ handle: BE, post_id: p1, session_id: null }, { handle: FE, post_id: p1, session_id: S1 }, { handle: S2, post_id: p1, session_id: S2 }]
        .sort((x, y) => bytewise(x.handle, y.handle)),
      { handle: FE, post_id: p2, session_id: S1 },
    ]);
  });

  it("claimQueuePost on a free key: the claim with its holder's user, a take event and the lane's waking push; push false writes no push", async h => {
    const b = h.boards;
    await board(h, "jobs", { kind: "queue" });
    await h.session(S1, ME);
    await h.hold(FE, S1, T0);
    const [p1, p2] = [await write(h, np("jobs", BE, "one", T0)), await write(h, np("jobs", BE, "two", T0))];
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p1, FE, T0 + 5, { note: "queue post", push: true }))).toBe(true);
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p2, S1, T0 + 6, { note: "by mention", push: false }))).toBe(true);
    expect(await h.claimRows()).toEqual([
      { key: `queue:jobs:${p1}`, holder: FE, note: "queue post", board: "jobs", acquired_at: T0 + 5, expires_at: T0 + 5 + QUEUE_TTL, holder_user: ME },
      { key: `queue:jobs:${p2}`, holder: S1, note: "by mention", board: "jobs", acquired_at: T0 + 6, expires_at: T0 + 6 + QUEUE_TTL, holder_user: ME },
    ].sort((x, y) => bytewise(x.key, y.key)));
    expect(await h.eventRows()).toEqual([
      { key: `queue:jobs:${p1}`, handle: FE, event: "take", note: "queue post", board: "jobs", at: T0 + 5 },
      { key: `queue:jobs:${p2}`, handle: S1, event: "take", note: "by mention", board: "jobs", at: T0 + 6 },
    ]);
    expect(await h.outboxRows()).toEqual([{ handle: FE, post_id: p1, reason: "subscription", wake: true, delivered: false }]);
  });

  // #1357 (#807 P3 C10 Q5): the claim goes first; a key another lane holds is no offer to this one.
  it("claimQueuePost on a key another lane holds: false, and no claim, event or outbox row for the lane", async h => {
    const b = h.boards;
    await board(h, "jobs", { kind: "queue" });
    const p = await write(h, np("jobs", BE, "job", T0));
    await h.claim({ key: `queue:jobs:${p}`, holder: QA, board: "jobs", at: T0 });
    const before = await h.claimRows();
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p, FE, T0 + 5, { note: "queue post (redelivered)", push: true }))).toBe(false);
    expect(await h.claimRows()).toEqual(before);
    expect(await h.eventRows()).toEqual([]);
    expect(await h.outboxRows()).toEqual([]);
    // The lane's own delivered push of the post stays delivered.
    await h.write(async tx => {
      await b.insertOutbox(tx, p, [[FE, target("subscription", true)]]);
      await b.acknowledge(tx, FE, { kind: "push", post_id: p });
    });
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p, FE, T0 + 6, { note: "queue post (redelivered)", push: true }))).toBe(false);
    expect(await h.outboxRows()).toEqual([{ handle: FE, post_id: p, reason: "subscription", wake: true, delivered: true }]);
  });

  // #1357's kept case: a re-offer to the key's own holder still reaches it (at-least-once).
  it("claimQueuePost on a key the lane already holds: false, no new event, and its push reset to undelivered and waking", async h => {
    const b = h.boards;
    await board(h, "jobs", { kind: "queue" });
    const p = await write(h, np("jobs", BE, "job", T0));
    await h.claim({ key: `queue:jobs:${p}`, holder: FE, board: "jobs", at: T0 });
    await h.write(async tx => {
      await b.insertOutbox(tx, p, [[FE, target("subscription", false)]]);
      await b.acknowledge(tx, FE, { kind: "push", post_id: p });
    });
    const before = await h.claimRows();
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p, FE, T0 + 5, { note: "queue post (redelivered)", push: true }))).toBe(false);
    expect(await h.claimRows()).toEqual(before);
    expect(await h.eventRows()).toEqual([]);
    expect(await h.outboxRows()).toEqual([{ handle: FE, post_id: p, reason: "subscription", wake: true, delivered: false }]);
    // With push false, nothing at all.
    await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: p }));
    expect(await h.write(tx => b.claimQueuePost(tx, "jobs", p, FE, T0 + 6, { note: "n", push: false }))).toBe(false);
    expect((await h.outboxRows())[0]?.delivered).toBe(true);
  });

  // c10e2 audit 1: on Postgres a prune may delete the post between the sweep's read and its claim.
  it("claimQueuePost on a post that's gone: false, and no claim, event or outbox row", async h => {
    await board(h, "jobs", { kind: "queue" });
    const p = await write(h, np("jobs", BE, "job", T0));
    await h.write(tx => h.boards.prunePosts(tx, T0 + 1));
    expect(await h.write(tx => h.boards.claimQueuePost(tx, "jobs", p, FE, T0 + 5, { note: "queue post (redelivered)", push: true }))).toBe(false);
    expect(await h.claimRows()).toEqual([]);
    expect(await h.eventRows()).toEqual([]);
    expect(await h.outboxRows()).toEqual([]);
  });

  // From db.test.ts B5b3b. The claimEvent fixture writes no session_id, so these takes map by address as today;
  // a take under a live session (an alias that moved between sessions) is pending #1351, which maps it to that
  // session's addresses and counts takers by session: add its row with that change, not here.
  it("redeliveryFacts: the board, post, author addresses and writer, sessions that took it, every address that held it; null for a non-queue key", async h => {
    await board(h, "jobs", { kind: "queue" });
    await board(h, "hall");
    await h.session(S1, ME);
    await h.session(S2, OTHER);
    await h.hold(FE, S1, T0);
    await h.hold(OPS, S1, T0 + 1);
    const p = await write(h, np("jobs", BE, "job", T0, { authorId: S2, authorUser: OTHER }));
    const key = `queue:jobs:${p}`;
    await h.claimEvent({ key, handle: FE, event: "take", board: "jobs", at: T0 + 1 });
    await h.claimEvent({ key, handle: QA, event: "take", board: "jobs", at: T0 + 2 });
    await h.claimEvent({ key, handle: "eng/zz", event: "release", board: "jobs", at: T0 + 3 });
    const f = await h.boards.redeliveryFacts(h.read, key, `${OTHER}/prev`);
    expect(f && { ...f, poster: [...f.poster].sort(bytewise), held: [...f.held].sort(bytewise) }).toEqual({
      board: expect.objectContaining({ name: "jobs", kind: "queue" }), postId: p, poster: [BE, S2].sort(bytewise),
      author: { handle: BE, id: S2, user: OTHER }, takers: 3, held: [FE, OPS, QA, S1, `${OTHER}/prev`].sort(bytewise),
    });
    expect(await h.boards.redeliveryFacts(h.read, "ticket:1", FE)).toBeNull();
    expect(await h.boards.redeliveryFacts(h.read, `queue:hall:${p}`, FE)).toBeNull();
    expect(await h.boards.redeliveryFacts(h.read, `queue:jobs:${p + 100}`, FE)).toBeNull();
    expect(await h.boards.redeliveryFacts(h.read, `queue:none:${p}`, FE)).toBeNull();
  });

  // #1351: the row above's takes carry no session (address-keyed). A live session's take is its taking session's turn,
  // as that session's addresses now; its handle counts only while no other session holds it. An ended session's take
  // maps through its handle's holder now, as an old row does.
  it("redeliveryFacts with session-keyed takes: a live session's turn under its addresses now, an ended one's by its handle", async h => {
    await board(h, "jobs", { kind: "queue" });
    const MOVED = `${ME}/moved`, LOOSE = `${ME}/loose`, GONE = `${ME}/gone`, ZED = `${OTHER}/zed`;
    await h.session(S1, ME);
    await h.session(S2, OTHER);
    await h.session(S3, ME, { endedAt: T0 });
    await h.hold(FE, S1, T0);
    await h.hold(MOVED, S2, T0 + 1); // S1 took it as MOVED; it's S2's now
    await h.hold(ZED, S2, T0 + 2);
    const p = await write(h, np("jobs", BE, "job", T0));
    const key = `queue:jobs:${p}`;
    await h.claimEvent({ key, handle: MOVED, event: "take", board: "jobs", at: T0 + 1, session: S1 });
    await h.claimEvent({ key, handle: LOOSE, event: "take", board: "jobs", at: T0 + 2, session: S1 }); // held by no one now
    await h.claimEvent({ key, handle: GONE, event: "take", board: "jobs", at: T0 + 3, session: S3 }); // S3 has ended
    const facts = async (prev: string) => {
      const f = (await h.boards.redeliveryFacts(h.read, key, prev))!;
      return { takers: f.takers, held: [...f.held].sort(bytewise) };
    };
    // The last holder MOVED has a take row, so that row decides: S1's turn, not S2's.
    expect(await facts(MOVED)).toEqual({ takers: 2, held: [FE, GONE, LOOSE, S1].sort(bytewise) });
    // A last holder with no take row maps through who holds it now: S2 and every address of it.
    expect(await facts(ZED)).toEqual({ takers: 3, held: [FE, GONE, LOOSE, MOVED, S1, S2, ZED].sort(bytewise) });
  });
}

function retention(it: It): void {
  it("prunePosts: old posts with their pushes, mutes and attachments go, a reply becomes a root; old claim events and binding events go but each name's latest bind", async h => {
    const b = h.boards;
    for (const name of ["zeta", "hall", "alpha", "kept"]) await board(h, name);
    const CUT = T0 + 100;
    const old = await write(h, np("hall", BE, "old", T0));
    const oldZ = await write(h, np("zeta", BE, "old z", T0 + 1));
    const oldA = await write(h, np("alpha", BE, "old a", T0 + 2));
    const reply = await write(h, np("hall", FE, "reply", CUT, { parentId: old }));
    const fresh = await write(h, np("kept", BE, "fresh", CUT + 1));
    const f = await h.upload(BE, ME, 5);
    await h.write(async tx => {
      await b.insertOutbox(tx, old, [[FE, target("subscription", true)]]);
      await b.insertOutbox(tx, reply, [[BE, target("thread", true)]]);
      await b.mute(tx, FE, old, true);
      await b.mute(tx, FE, fresh, true);
      await b.bindAttachments(tx, [f], { addresses: [BE], principal: ME }, old, LIMITS);
    });
    await h.claimEvent({ key: "k", handle: BE, event: "take", board: "hall", at: T0 });
    await h.claimEvent({ key: "k", handle: BE, event: "release", board: "hall", at: CUT });
    await h.bindingEvent({ session: S1, name: FE, event: "bound", at: T0 });
    await h.bindingEvent({ session: S1, name: FE, event: "released", at: T0 + 1 });
    await h.bindingEvent({ session: S1, name: BE, event: "bound", at: T0 + 2 });
    await h.bindingEvent({ session: S2, name: BE, event: "moved", at: T0 + 3 });
    await h.bindingEvent({ session: S2, name: BE, event: "released", at: CUT });
    await h.claim({ key: "ticket:1", holder: BE, board: "hall", at: T0 });
    expect(await h.write(tx => b.prunePosts(tx, CUT))).toEqual(["alpha", "hall", "zeta"]);
    for (const id of [old, oldZ, oldA]) expect(await b.post(h.read, id)).toBeUndefined();
    expect(await h.postRow(reply)).toEqual({ parent_id: null, human: false });
    expect(await b.threadRoot(h.read, reply)).toBe(reply);
    expect(await h.outboxRows()).toEqual([{ handle: BE, post_id: reply, reason: "thread", wake: true, delivered: false }]);
    expect(await h.muteRows()).toEqual([{ handle: FE, root_id: fresh }]);
    expect(await h.attachmentRows()).toEqual([]);
    expect((await h.eventRows()).map(e => e.event)).toEqual(["release"]);
    expect(await h.bindingEventRows()).toEqual([{ name: FE, event: "bound", at: T0 }, { name: BE, event: "moved", at: T0 + 3 }, { name: BE, event: "released", at: CUT }]);
    expect((await h.claimRows()).map(c => c.key)).toEqual(["ticket:1"]);
    expect(await h.write(tx => b.prunePosts(tx, CUT))).toEqual([]);
  });
}
