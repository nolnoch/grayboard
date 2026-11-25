// The Slack bridge store's contract (#807 P3 C7, docs/future/postgres-server.md D9): every SlackStore method, written
// once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's
// test file registers it under a describe() (slack.contract.sqlite.ts through db.test.ts for SQLite,
// pg/slack.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: user ids are the ones the harness made.
// - Every time is a fixed epoch set on the store's clock (setNow); nothing reads a wall clock.
// - The rows are serial. Two links of one Slack account, and an unlink racing a relink, are a backend's own test:
//   Postgres runs them on two connections (C67b's pg/slack.pg.test.ts); the call sites' lock order is pinned by spies
//   (tests/integration/slack_org.test.ts). What these rows pin is each method's serial answer.
// - Progress is a JSON value: compared deep, key order ignored. The users rows (the links' foreign key and their email)
//   and the raw reads of slack_threads and slack_progress are the harness's.
import { expect, test } from "bun:test";
import type { SlackStore, SlackThread } from "./slack.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type SlackHarness = {
  slack: SlackStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // The store's clock, for linked_at.
  setNow(ms: number): void;
  // A users row with this email, its id.
  user(email: string): Promise<number>;
  // Raw reads: every thread row by (user_id, thread_ts); every progress row's key by (user_id, ref).
  threadRows(): Promise<{ user_id: number; thread_ts: string; kind: string; board: string; root_id: number; peer: string | null; last_id: number }[]>;
  progressRows(): Promise<{ user_id: number; ref: string }[]>;
  close(): void | Promise<void>;
};

export type SlackBackend = { kind: "sqlite" | "postgres"; open(): Promise<SlackHarness> };

const T0 = 1_800_000_000_000;
const dm = (ts: string, root: number, over: Partial<SlackThread> = {}): SlackThread =>
  ({ thread_ts: ts, kind: "dm", board: null, root_id: root, peer: null, last_id: root, ...over });

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

export function slackContract(backend: SlackBackend): void {
  const it = (name: string, fn: (h: SlackHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    h.setNow(T0);
    try { await fn(h); } finally { await h.close(); }
  });
  links(it);
  threads(it);
  progress(it);
}

type It = (name: string, fn: (h: SlackHarness) => Promise<void>) => void;

const link = (h: SlackHarness, userId: number, slackUser: string, channel: string) => h.write(tx => h.slack.link(tx, userId, slackUser, channel));
// A user with one thread and one progress row.
async function withRows(h: SlackHarness, userId: number, ts: string): Promise<void> {
  await h.write(async tx => {
    await h.slack.addThread(tx, userId, dm(ts, 1));
    await h.slack.setProgress(tx, userId, `dm:${ts}`, { posted: true });
  });
}

function links(it: It): void {
  // L1.
  it("link reads back through linkFor, linkBySlackUser and links (by user_id), with the user's email and numeric ids and times", async h => {
    const b = await h.user("b@example.com");
    const a = await h.user("a@example.com");
    h.setNow(T0 + 5);
    await link(h, b, "UB", "DB");
    h.setNow(T0 + 6);
    await link(h, a, "UA", "DA");
    const la = { user_id: a, email: "a@example.com", slack_user: "UA", dm_channel: "DA", linked_at: T0 + 6 };
    const lb = { user_id: b, email: "b@example.com", slack_user: "UB", dm_channel: "DB", linked_at: T0 + 5 };
    expect(await h.slack.linkFor(h.read, a)).toEqual(la);
    expect(await h.slack.linkBySlackUser(h.read, "UB")).toEqual(lb);
    expect(await h.slack.links(h.read)).toEqual([la, lb].sort((x, y) => x.user_id - y.user_id));
    const got = (await h.slack.linkFor(h.read, a))!;
    expect(typeof got.user_id).toBe("number");
    expect(typeof got.linked_at).toBe("number");
    expect(await h.slack.linkFor(h.read, a + b + 1000)).toBeUndefined();
    expect(await h.slack.linkBySlackUser(h.read, "UX")).toBeUndefined();
    // A relink replaces the row: one per user, the new account's.
    h.setNow(T0 + 7);
    await link(h, a, "UA2", "DA2");
    expect(await h.slack.linkFor(h.read, a)).toEqual({ ...la, slack_user: "UA2", dm_channel: "DA2", linked_at: T0 + 7 });
    expect(await h.slack.linkBySlackUser(h.read, "UA")).toBeUndefined();
    expect((await h.slack.links(h.read)).length).toBe(2);
    // Read inside the body that wrote it.
    await h.write(async tx => {
      await h.slack.link(tx, a, "UA3", "DA3");
      expect((await h.slack.linkFor(tx, a))?.slack_user).toBe("UA3");
    });
  });

  // L2.
  it("a link to another account or DM drops that user's threads and progress; the same link again keeps them; other users' rows stay", async h => {
    const a = await h.user("a@example.com");
    const b = await h.user("b@example.com");
    await link(h, a, "UA", "DA");
    await link(h, b, "UB", "DB");
    await withRows(h, a, "1.1");
    await withRows(h, b, "2.2");
    await link(h, a, "UA", "DA");
    expect((await h.threadRows()).map(r => [r.user_id, r.thread_ts])).toEqual([[a, "1.1"], [b, "2.2"]].sort((x, y) => (x[0] as number) - (y[0] as number)));
    expect((await h.progressRows()).length).toBe(2);
    // Another DM with the same account.
    await link(h, a, "UA", "DA2");
    expect((await h.threadRows()).map(r => [r.user_id, r.thread_ts])).toEqual([[b, "2.2"]]);
    expect(await h.progressRows()).toEqual([{ user_id: b, ref: "dm:2.2" }]);
    // Another account.
    await withRows(h, a, "3.3");
    await link(h, a, "UA2", "DA2");
    expect((await h.threadRows()).map(r => [r.user_id, r.thread_ts])).toEqual([[b, "2.2"]]);
    expect(await h.progressRows()).toEqual([{ user_id: b, ref: "dm:2.2" }]);
    // A first link with rows already there (a fixture, not a flow the bridge has) drops them too.
    const c = await h.user("c@example.com");
    await withRows(h, c, "4.4");
    await link(h, c, "UC", "DC");
    expect((await h.threadRows()).map(r => r.thread_ts)).toEqual(["2.2"]);
  });

  // L3.
  it("unlink removes that user's link, threads and progress only", async h => {
    const a = await h.user("a@example.com");
    const b = await h.user("b@example.com");
    await link(h, a, "UA", "DA");
    await link(h, b, "UB", "DB");
    await withRows(h, a, "1.1");
    await withRows(h, b, "2.2");
    await h.write(tx => h.slack.unlink(tx, a));
    expect(await h.slack.linkFor(h.read, a)).toBeUndefined();
    expect(await h.slack.linkBySlackUser(h.read, "UA")).toBeUndefined();
    expect((await h.slack.links(h.read)).map(l => l.user_id)).toEqual([b]);
    expect((await h.threadRows()).map(r => [r.user_id, r.thread_ts])).toEqual([[b, "2.2"]]);
    expect(await h.progressRows()).toEqual([{ user_id: b, ref: "dm:2.2" }]);
    // An unlink of a user with nothing writes nothing.
    await h.write(tx => h.slack.unlink(tx, a));
    expect((await h.slack.links(h.read)).map(l => l.user_id)).toEqual([b]);
    // An unlink in a body that throws rolls back with it.
    expect(await failure(() => h.write(async tx => { await h.slack.unlink(tx, b); throw new Error("rolled back"); }))).toBe("rolled back");
    expect((await h.slack.links(h.read)).map(l => l.user_id)).toEqual([b]);
    expect((await h.threadRows()).length).toBe(1);
  });

  // L9.
  it("lock serially changes nothing, twice in one body included; a settled Tx is refused", async h => {
    const a = await h.user("a@example.com");
    await h.write(async tx => {
      await h.slack.lock(tx);
      await h.slack.lock(tx);
      expect(await h.slack.linkFor(tx, a)).toBeUndefined();
      await h.slack.link(tx, a, "UA", "DA");
    });
    expect((await h.slack.linkFor(h.read, a))?.slack_user).toBe("UA");
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.slack.lock(kept))).toContain("Tx used after its transaction settled");
  });
}

function threads(it: It): void {
  // L4.
  it("addThread again with the same ts, or a new ts for the same (kind, board, root), inserts nothing and changes nothing", async h => {
    const a = await h.user("a@example.com");
    const first = dm("1.1", 10, { peer: "b@example.com/be", last_id: 12 });
    await h.write(tx => h.slack.addThread(tx, a, first));
    await h.write(async tx => {
      await h.slack.addThread(tx, a, { ...first, root_id: 20, last_id: 30, peer: "c@example.com/qa" });
      await h.slack.addThread(tx, a, { ...first, thread_ts: "9.9", last_id: 99 });
    });
    expect(await h.threadRows()).toEqual([{ user_id: a, thread_ts: "1.1", kind: "dm", board: "", root_id: 10, peer: "b@example.com/be", last_id: 12 }]);
    // Another kind, board or root is another thread.
    await h.write(async tx => {
      await h.slack.addThread(tx, a, { ...first, thread_ts: "2.2", kind: "board", board: "e2e" });
      await h.slack.addThread(tx, a, { ...first, thread_ts: "3.3", kind: "board", board: "ops" });
      await h.slack.addThread(tx, a, { ...first, thread_ts: "4.4", root_id: 11 });
    });
    expect((await h.threadRows()).map(r => r.thread_ts)).toEqual(["1.1", "2.2", "3.3", "4.4"]);
  });

  // L5.
  it("thread and threadByTs map a null board to '' and back, with numeric root_id and last_id", async h => {
    const a = await h.user("a@example.com");
    const b = await h.user("b@example.com");
    const d = dm("1.1", 10, { peer: "b@example.com/be", last_id: 12 });
    const p: SlackThread = { thread_ts: "2.2", kind: "board", board: "e2e", root_id: 20, peer: null, last_id: 21 };
    await h.write(async tx => { await h.slack.addThread(tx, a, d); await h.slack.addThread(tx, a, p); });
    expect(await h.slack.thread(h.read, a, "dm", null, 10)).toEqual(d);
    expect(await h.slack.threadByTs(h.read, a, "1.1")).toEqual(d);
    expect(await h.slack.thread(h.read, a, "board", "e2e", 20)).toEqual(p);
    expect(await h.slack.threadByTs(h.read, a, "2.2")).toEqual(p);
    const got = (await h.slack.threadByTs(h.read, a, "2.2"))!;
    expect([typeof got.root_id, typeof got.last_id]).toEqual(["number", "number"]);
    expect((await h.threadRows()).map(r => r.board)).toEqual(["", "e2e"]);
    // Each key column narrows: another user, kind, board or root; another ts.
    expect(await h.slack.thread(h.read, b, "dm", null, 10)).toBeUndefined();
    expect(await h.slack.thread(h.read, a, "board", null, 10)).toBeUndefined();
    expect(await h.slack.thread(h.read, a, "board", "ops", 20)).toBeUndefined();
    expect(await h.slack.thread(h.read, a, "dm", null, 11)).toBeUndefined();
    expect(await h.slack.threadByTs(h.read, b, "1.1")).toBeUndefined();
    expect(await h.slack.threadByTs(h.read, a, "3.3")).toBeUndefined();
    expect(await h.write(tx => h.slack.thread(tx, a, "dm", null, 10))).toEqual(d);
  });

  // L6.
  it("advanceThread: last_id never moves back; peer moves only with a newer id and a peer given", async h => {
    const a = await h.user("a@example.com");
    await h.write(tx => h.slack.addThread(tx, a, dm("1.1", 10, { peer: "p10", last_id: 10 })));
    const step = async (id: number, peer?: string) => {
      await h.write(tx => h.slack.advanceThread(tx, a, "1.1", id, peer));
      const t = (await h.slack.threadByTs(h.read, a, "1.1"))!;
      return [t.last_id, t.peer];
    };
    expect(await step(7, "p7")).toEqual([10, "p10"]);
    // The same id is not newer: the peer stays.
    expect(await step(10, "p10b")).toEqual([10, "p10"]);
    expect(await step(12)).toEqual([12, "p10"]);
    expect(await step(15, "p15")).toEqual([15, "p15"]);
    expect(await step(14, "p14")).toEqual([15, "p15"]);
    // A thread that isn't there, or another user's, changes nothing.
    await h.write(tx => h.slack.advanceThread(tx, a, "9.9", 99, "p99"));
    await h.write(tx => h.slack.advanceThread(tx, a + 1000, "1.1", 99, "p99"));
    expect(await h.threadRows()).toEqual([{ user_id: a, thread_ts: "1.1", kind: "dm", board: "", root_id: 10, peer: "p15", last_id: 15 }]);
  });
}

function progress(it: It): void {
  // L7.
  it("progress returns what setProgress stored; setProgress replaces; clearProgress removes; absent is undefined", async h => {
    const a = await h.user("a@example.com");
    const b = await h.user("b@example.com");
    expect(await h.slack.progress(h.read, a, "dm:1")).toBeUndefined();
    const first = { files: [{ id: "F1", title: "shot.png", attachment: 3, sha256: "ab" }], refused: [{ attachment: null, name: "x.bin", why: "too big" }], posted: false, error: null };
    await h.write(tx => h.slack.setProgress(tx, a, "dm:1", first));
    expect(await h.slack.progress(h.read, a, "dm:1")).toEqual(first);
    expect(await h.slack.progress(h.read, b, "dm:1")).toBeUndefined();
    expect(await h.slack.progress(h.read, a, "post:1")).toBeUndefined();
    const second = { posted: true, told: true };
    await h.write(async tx => {
      await h.slack.setProgress(tx, a, "dm:1", second);
      expect(await h.slack.progress(tx, a, "dm:1")).toEqual(second);
    });
    expect(await h.slack.progress(h.read, a, "dm:1")).toEqual(second);
    await h.write(tx => h.slack.setProgress(tx, b, "dm:1", first));
    await h.write(tx => h.slack.setProgress(tx, a, "post:2", second));
    await h.write(tx => h.slack.clearProgress(tx, a, "dm:1"));
    expect(await h.slack.progress(h.read, a, "dm:1")).toBeUndefined();
    expect(await h.slack.progress(h.read, a, "post:2")).toEqual(second);
    expect(await h.slack.progress(h.read, b, "dm:1")).toEqual(first);
    expect(await h.progressRows()).toEqual([{ user_id: a, ref: "post:2" }, { user_id: b, ref: "dm:1" }]);
  });

  // L8.
  it("a NUL or a lone surrogate in a progress string commits as U+FFFD", async h => {
    const a = await h.user("a@example.com");
    const bad = "a\u0000b\uD800c";
    await h.write(tx => h.slack.setProgress(tx, a, "dm:1", { refused: [{ attachment: 1, name: bad, why: bad }], error: bad, [bad]: true }));
    const safe = "a\uFFFDb\uFFFDc";
    expect(await h.slack.progress(h.read, a, "dm:1")).toEqual({ refused: [{ attachment: 1, name: safe, why: safe }], error: safe, [safe]: true });
  });
}
