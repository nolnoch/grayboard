// The claims store's contract (#807 P3 C10b, docs/future/postgres-server.md D9): every ClaimsStore method, written once
// over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test
// file registers it under a describe() (claims.contract.sqlite.ts through db.test.ts for SQLite,
// pg/claims.contract.pg.test.ts for Postgres). The serial rules of core's claim SQL (src/core/claims.ts) moved here from
// core's claims_sql.test.ts, so they run on both stores.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id.
// - Times are fixed epochs passed in. The one method that reads a clock is list (SQLite's core reads Date.now(), the
//   Postgres store its clock, set to CLOCK): its live claims expire at LIVE and its lapsed ones at LAPSED, far either side
//   of both, so the answer is the same on each. CLOCK is far from T0, every other method's `now`, so a method that read
//   the store's clock in place of its argument fails its row.
// - The rows are serial. An interleaving (two takes of one key, an ack racing a takeover, a watch racing a release) is
//   Postgres's own test (pg/claims.pg.test.ts, races K1-K6): on SQLite the single writer runs no two of these at once.
//   What these rows pin is each statement's serial answer, which the race rows then hold under concurrency.
// - Fixture writes the store doesn't offer (a board, a session's ids row, a hold, a claim row as written) and the raw
//   reads are the harness's, so no row touches a connection.
import { expect, test } from "bun:test";
import type { ClaimRow, ClaimsStore, TakeRow } from "./claims.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type ClaimsHarness = {
  claims: ClaimsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // The store's clock (Postgres's list); SQLite's list reads Date.now().
  setNow(ms: number): void;
  // Fixture writes, each in its own transaction: a board (claims.board's foreign key); a session's ids row; a hold
  // (alias_holds); a claims row as given.
  board(name: string): Promise<void>;
  session(id: string, principal: string | null): Promise<void>;
  hold(address: string, id: string): Promise<void>;
  claim(row: ClaimRow): Promise<void>;
  // Raw reads: every claims row by key (byte order), every watch by key then handle, every event in insertion order.
  claimRows(): Promise<ClaimRow[]>;
  watchRows(): Promise<{ key: string; handle: string }[]>;
  eventRows(): Promise<{ key: string; handle: string; event: string; note: string | null; board: string | null; expires_at: number | null; held_by: string | null; at: number }[]>;
  close(): void | Promise<void>;
};

export type ClaimsBackend = { kind: "sqlite" | "postgres"; open(): Promise<ClaimsHarness> };

const T0 = 1_800_000_000_000;
// Far either side of T0 and of any wall clock this suite runs under: list's live and lapsed claims.
const LIVE = T0 + 100_000_000_000, LAPSED = 1_000;
// The store's clock: between LAPSED and LIVE, far from T0.
const CLOCK = T0 + 1_000_000_000;
const ME = "you@example.com";
const FE = `${ME}/fe`, BE = `${ME}/be`;

const take = (t: Partial<TakeRow>): TakeRow => ({ key: "k", as: FE, note: null, board: null, now: T0, expires: T0 + 60_000, user: null, ...t });
const row = (key: string, holder: string, expires: number, more: Partial<ClaimRow> = {}): ClaimRow =>
  ({ key, holder, note: "held", board: null, acquired_at: 1, expires_at: expires, holder_user: null, ...more });
// Byte order, as SQLite's BINARY collation and Postgres's COLLATE "C" compare.
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function claimsContract(backend: ClaimsBackend): void {
  const it = (name: string, fn: (h: ClaimsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    h.setNow(CLOCK);
    try { await fn(h); } finally { await h.close(); }
  });
  takeAndRelease(it);
  readsAndWatches(it);
  ack(it);
}

type It = (name: string, fn: (h: ClaimsHarness) => Promise<void>) => void;

function takeAndRelease(it: It): void {
  // K-1.
  it("take inserts a new claim and returns its caller's columns, as numbers; get returns the whole row", async h => {
    await h.board("hall");
    const t = take({ note: "n", board: "hall", user: ME });
    const got = await h.write(tx => h.claims.take(tx, t));
    expect(got).toEqual({ key: "k", holder: FE, note: "n", board: "hall", acquired_at: T0, expires_at: T0 + 60_000 });
    expect(typeof got!.expires_at).toBe("number");
    expect(await h.claims.get(h.read, "k")).toEqual({ ...got!, holder_user: ME });
    expect(await h.claims.get(h.read, "none")).toBeUndefined();
    // Read inside the body that wrote it, on its Tx.
    await h.write(async tx => {
      await h.claims.take(tx, take({ key: "k2" }));
      expect((await h.claims.get(tx, "k2"))?.holder).toBe(FE);
    });
  });

  // K-2 (moved from core's claims_sql.test.ts).
  it("a take over someone else's live claim writes nothing and answers null, and its body goes on to commit", async h => {
    await h.claim(row("k", BE, T0 + 1));
    const out = await h.write(async tx => ({ held: await h.claims.take(tx, take({})), next: await h.claims.take(tx, take({ key: "k2" })) }));
    expect(out.held).toBeNull();
    expect(out.next?.key).toBe("k2");
    expect(await h.claimRows()).toEqual([
      row("k", BE, T0 + 1),
      { key: "k2", holder: FE, note: null, board: null, acquired_at: T0, expires_at: T0 + 60_000, holder_user: null },
    ]);
  });

  // K-3 (moved from core's claims_sql.test.ts).
  it("a take over a lapsed claim (expiry at now) starts afresh; the holder's live renewal keeps its note, board and acquired time", async h => {
    await h.board("hall");
    await h.claim(row("k", BE, T0, { board: "hall", holder_user: "be@example.com" }));
    expect(await h.write(tx => h.claims.take(tx, take({ user: ME })))).toEqual({ key: "k", holder: FE, note: null, board: null, acquired_at: T0, expires_at: T0 + 60_000 });
    expect((await h.claims.get(h.read, "k"))?.holder_user).toBe(ME);
    await h.write(tx => h.claims.take(tx, take({ note: "first", board: "hall" })));
    // A live renewal that leaves the note and board out keeps them and its acquired time.
    expect(await h.write(tx => h.claims.take(tx, take({ now: T0 + 5, expires: T0 + 90_000 }))))
      .toEqual({ key: "k", holder: FE, note: "first", board: "hall", acquired_at: T0, expires_at: T0 + 90_000 });
    // The holder's own lapsed row: its note and board stay, the acquired time restarts.
    expect(await h.write(tx => h.claims.take(tx, take({ now: T0 + 90_000, expires: T0 + 99_000 }))))
      .toEqual({ key: "k", holder: FE, note: "first", board: "hall", acquired_at: T0 + 90_000, expires_at: T0 + 99_000 });
  });

  // K-4 (moved from core's claims_sql.test.ts).
  it("a release ends only the named holder's live claim and returns the whole row", async h => {
    await h.claim(row("lapsed", BE, T0));
    await h.claim(row("theirs", "sim", T0 + 1));
    await h.claim(row("mine", BE, T0 + 1, { holder_user: ME }));
    const [lapsed, theirs, mine] = await h.write(async tx => [
      await h.claims.release(tx, "lapsed", BE, T0), await h.claims.release(tx, "theirs", BE, T0), await h.claims.release(tx, "mine", BE, T0),
    ]);
    expect([lapsed, theirs]).toEqual([null, null]);
    expect(mine).toEqual(row("mine", BE, T0 + 1, { holder_user: ME }));
    expect((await h.claimRows()).map(c => c.key)).toEqual(["lapsed", "theirs"]);
    expect(await h.write(tx => h.claims.release(tx, "mine", BE, T0))).toBeNull();
  });

  // K-5 (moved from core's claims_sql.test.ts).
  it("expire deletes the claims lapsed at now and returns them in lapse order, by key within a tie, logging nothing", async h => {
    for (const k of ["c", "a", "B", "b"]) await h.claim(row(k, BE, T0));
    await h.claim(row("queue:work:10", BE, T0 - 1));
    await h.claim(row("queue:work:9", BE, T0 - 2, { holder_user: ME }));
    await h.claim(row("live", BE, T0 + 1));
    const gone = await h.write(tx => h.claims.expire(tx, T0));
    expect(gone.map(c => c.key)).toEqual(["queue:work:9", "queue:work:10", "B", "a", "b", "c"]);
    expect(gone[0]).toEqual(row("queue:work:9", BE, T0 - 2, { holder_user: ME }));
    expect((await h.claimRows()).map(c => c.key)).toEqual(["live"]);
    expect(await h.eventRows()).toEqual([]);
    expect(await h.write(tx => h.claims.expire(tx, T0))).toEqual([]);
  });
}

function readsAndWatches(it: It): void {
  // K-6.
  it("list returns live claims in byte order, without holder_user; a prefix matches ASCII in either case and %, _ and \\ literally", async h => {
    const keys = ["ticket:1", "TICKET:2", "t_x", "tax", "t%y", "tab", "a\\b", "ab", "é1", "É2", "B", "a"];
    for (const k of keys) await h.claim(row(k, BE, LIVE, { holder_user: ME }));
    await h.claim(row("ticket:old", BE, LAPSED));
    const all = await h.claims.list(h.read);
    expect(all.map(c => c.key)).toEqual([...keys].sort(bytewise));
    expect(all.find(c => c.key === "B")).toEqual({ key: "B", holder: BE, note: "held", board: null, acquired_at: 1, expires_at: LIVE });
    const keysOf = async (prefix: string) => (await h.claims.list(h.read, prefix)).map(c => c.key);
    expect(await keysOf("ticket:")).toEqual(["TICKET:2", "ticket:1"]);
    expect(await keysOf("TiCkEt:")).toEqual(["TICKET:2", "ticket:1"]);
    expect(await keysOf("t_")).toEqual(["t_x"]);
    expect(await keysOf("t%")).toEqual(["t%y"]);
    expect(await keysOf("a\\")).toEqual(["a\\b"]);
    // Only ASCII folds: SQLite's LIKE, and Postgres's ILIKE on these columns.
    expect(await keysOf("é")).toEqual(["é1"]);
    expect(await keysOf("É")).toEqual(["É2"]);
    expect(await keysOf("")).toEqual(all.map(c => c.key));
    expect(await keysOf("nothing")).toEqual([]);
  });

  // K-7.
  it("nextExpiry is the earliest expiry of a claim with a board, lapsed or not, as a number; null with none", async h => {
    expect(await h.claims.nextExpiry(h.read)).toBeNull();
    await h.board("hall");
    await h.claim(row("boardless", BE, T0 - 10));
    expect(await h.claims.nextExpiry(h.read)).toBeNull();
    await h.claim(row("later", BE, T0 + 50, { board: "hall" }));
    await h.claim(row("sooner", BE, T0 - 5, { board: "hall" }));
    const next = await h.claims.nextExpiry(h.read);
    expect(next).toBe(T0 - 5);
    expect(typeof next).toBe("number");
  });

  // K-8.
  it("watches: addWatch is idempotent, watchers come in byte order, unwatch drops one, takeWatchers returns and deletes the key's", async h => {
    await h.claim(row("k", BE, T0 + 1));
    await h.write(async tx => {
      for (const w of ["fe", "Zed", "be", "fe"]) await h.claims.addWatch(tx, "k", w);
      await h.claims.addWatch(tx, "other", "fe");
    });
    expect(await h.claims.watchers(h.read, "k")).toEqual(["Zed", "be", "fe"]);
    await h.write(tx => h.claims.unwatch(tx, "k", "be"));
    await h.write(tx => h.claims.unwatch(tx, "k", "nobody"));
    expect(await h.claims.watchers(h.read, "k")).toEqual(["Zed", "fe"]);
    expect(await h.write(tx => h.claims.takeWatchers(tx, "k"))).toEqual(["Zed", "fe"]);
    expect(await h.write(tx => h.claims.takeWatchers(tx, "k"))).toEqual([]);
    expect(await h.watchRows()).toEqual([{ key: "other", handle: "fe" }]);
    expect(await h.claims.watchers(h.read, "none")).toEqual([]);
  });

  // K-9.
  it("liveForWatch returns the key's live row; a lapsed or missing one is undefined", async h => {
    await h.claim(row("live", BE, T0 + 1, { holder_user: ME }));
    await h.claim(row("lapsed", BE, T0));
    await h.write(async tx => {
      expect(await h.claims.liveForWatch(tx, "live", T0)).toEqual(row("live", BE, T0 + 1, { holder_user: ME }));
      expect(await h.claims.liveForWatch(tx, "lapsed", T0)).toBeUndefined();
      expect(await h.claims.liveForWatch(tx, "none", T0)).toBeUndefined();
    });
  });

  // K-10.
  it("logEvent appends a row from the claim's columns; recentEvents is the key's latest two, newest first", async h => {
    await h.board("hall");
    await h.write(async tx => {
      await h.claims.logEvent(tx, "take", FE, { key: "k", note: "n", board: "hall", expires_at: T0 + 9 }, T0 + 1);
      await h.claims.logEvent(tx, "refused", BE, { key: "k" }, T0 + 2, FE);
      await h.claims.logEvent(tx, "release", FE, { key: "k", note: null }, T0 + 3);
      await h.claims.logEvent(tx, "take", BE, { key: "other" }, T0 + 4);
    });
    expect(await h.eventRows()).toEqual([
      { key: "k", handle: FE, event: "take", note: "n", board: "hall", expires_at: T0 + 9, held_by: null, at: T0 + 1 },
      { key: "k", handle: BE, event: "refused", note: null, board: null, expires_at: null, held_by: FE, at: T0 + 2 },
      { key: "k", handle: FE, event: "release", note: null, board: null, expires_at: null, held_by: null, at: T0 + 3 },
      { key: "other", handle: BE, event: "take", note: null, board: null, expires_at: null, held_by: null, at: T0 + 4 },
    ]);
    expect(await h.claims.recentEvents(h.read, "k")).toEqual([
      { handle: FE, event: "release", note: null, at: T0 + 3 },
      { handle: BE, event: "refused", note: null, at: T0 + 2 },
    ]);
    expect(await h.claims.recentEvents(h.read, "none")).toEqual([]);
  });

  // K-11.
  it("holderUser: the row's own user, else the ID holder's principal, else the holding session's, else a person alias's person", async h => {
    const sid = "id:0123456789abc";
    await h.session(sid, "id@example.com");
    await h.session("id:holder0000000", "held@example.com");
    await h.hold(FE, "id:holder0000000");
    const user = (holder: string, holder_user: string | null = null) => h.claims.holderUser(h.read, row("k", holder, T0, { holder_user }));
    expect(await user(FE, "own@example.com")).toBe("own@example.com");
    expect(await user(sid)).toBe("id@example.com");
    expect(await user(FE)).toBe("held@example.com");
    expect(await user(BE)).toBe(ME);
    expect(await user("eng/be")).toBeUndefined();
    await h.session("id:noprincipal00", null);
    expect(await user("id:noprincipal00")).toBeUndefined();
    // The ID's own principal before a holding session's (no real ID is also held as an address; this pins the order).
    await h.hold(sid, "id:holder0000000");
    expect(await user(sid)).toBe("id@example.com");
  });
}

function ack(it: It): void {
  // K-12.
  it("ackQueue releases a claim one of the addresses holds, lapsed or not, with its watches and an ack event; another's is left", async h => {
    await h.board("jobs");
    await h.claim(row("queue:jobs:1", FE, T0 + 1, { board: "jobs", note: "redelivered" }));
    await h.claim(row("queue:jobs:2", BE, T0 + 1, { board: "jobs" }));
    await h.claim(row("queue:jobs:3", FE, T0, { board: "jobs" }));
    await h.write(async tx => {
      await h.claims.addWatch(tx, "queue:jobs:1", "w1");
      await h.claims.addWatch(tx, "queue:jobs:2", "w2");
    });
    // Someone else's claim, a missing one: nothing happens.
    expect(await h.write(tx => h.claims.ackQueue(tx, [FE, "other"], "queue:jobs:2", T0))).toBe(false);
    expect(await h.write(tx => h.claims.ackQueue(tx, [FE], "queue:jobs:9", T0))).toBe(false);
    expect(await h.eventRows()).toEqual([]);
    expect(await h.write(tx => h.claims.ackQueue(tx, ["other", FE], "queue:jobs:1", T0))).toBe(true);
    // A lapsed row the sweep hasn't reached is still the holder's: a late ack.
    expect(await h.write(tx => h.claims.ackQueue(tx, [FE], "queue:jobs:3", T0))).toBe(true);
    expect((await h.claimRows()).map(c => c.key)).toEqual(["queue:jobs:2"]);
    expect(await h.watchRows()).toEqual([{ key: "queue:jobs:2", handle: "w2" }]);
    expect(await h.eventRows()).toEqual([
      { key: "queue:jobs:1", handle: FE, event: "release", note: "ack", board: "jobs", expires_at: T0 + 1, held_by: null, at: T0 },
      { key: "queue:jobs:3", handle: FE, event: "release", note: "ack (late)", board: "jobs", expires_at: T0, held_by: null, at: T0 },
    ]);
  });
}
