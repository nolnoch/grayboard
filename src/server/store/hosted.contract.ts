// The hosted sessions store's contract (#807 P3 C8, docs/future/postgres-server.md D9): every HostedStore method, written
// once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's
// test file registers it under a describe() (hosted.contract.sqlite.ts through db.test.ts for SQLite,
// pg/hosted.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ownership and user ids are the ones the row made.
// - Every time is a fixed epoch passed to the call; nothing reads a wall clock an answer depends on.
// - The rows are serial. An interleaving (two admissions at the cap, two ends of one root, a renewal racing an expiry,
//   a registration racing its root's end, an insert racing its grant's revoke, two lost-hold takers, a park racing a
//   touch) is a backend's own test: Postgres runs them on two connections (C8b2's pg/hosted.pg.test.ts). So the lock
//   seams (`lock`, `lockCapacity`, `grantLive`) pass here on every backend whether or not they lock; what these rows pin
//   is each method's serial answer, and the guards an end, a park and an eviction check on the row they act on. The
//   call sites' seams are pinned by spies (hosted.test.ts).
// - A child's ID end is the backend's session end: core endSession on SQLite, the end port (a recorder in C8b's runner)
//   on Postgres. The rows observe it through `takeEnded`'s order and the harness's `idEnded`.
// - Fixture writes the store doesn't offer (users, grants, ids rows, holds) and the raw reads are the harness's.
import { expect, test } from "bun:test";
import type { HostedSession } from "../hosted-types.ts";
import type { HostedStore } from "./hosted.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type HostedHarness = {
  hosted: HostedStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: a users row (disabled or not), its id; an oauth_grants row; a
  // session's ids row; a hold (alias_holds).
  seedUser(email: string, disabled?: boolean): Promise<number>;
  seedGrant(id: string, user: number, expiresAt: number, revokedAt?: number | null): Promise<void>;
  seedIds(id: string, facts?: { rootId?: string | null; endedAt?: number | null; heldAliasesJson?: string | null; writesAs?: string | null; launcher?: boolean | null }): Promise<void>;
  seedHold(address: string, id: string, boundAt: number): Promise<void>;
  // Raw reads: an ids row's hosted facts; an ownership's end; every hold, binding event and audit row (in write order,
  // detail parsed); every hosted_alias_lost row's key.
  ids(id: string): Promise<{ root_id: string | null; ended_at: number | null; held_aliases_json: string | null; writes_as: string | null; launcher: boolean } | undefined>;
  ownership(id: number): Promise<{ session_id: string; ended_at: number | null; end_reason: string | null } | undefined>;
  holdRows(): Promise<{ address: string; id: string }[]>;
  bindingRows(): Promise<{ session_id: string; name: string; event: string; detail: string | null }[]>;
  auditRows(): Promise<{ actor: string | null; action: string; target: string | null; detail: Record<string, unknown> | null }[]>;
  lostRows(): Promise<{ session_id: string; alias: string }[]>;
  // When the session-end port ended this ID, or null: `ids.ended_at` through core endSession on SQLite, the recorder
  // port's call on Postgres (committed calls only).
  idEnded(id: string): Promise<number | null>;
  close(): void | Promise<void>;
};

export type HostedBackend = { kind: "sqlite" | "postgres"; open(): Promise<HostedHarness> };

const T0 = 1_800_000_000_000;
const ME = "you@example.com";

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

export function hostedContract(backend: HostedBackend): void {
  const it = (name: string, fn: (h: HostedHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  basics(it);
  counting(it);
  rowWrites(it);
  ends(it);
  audits(it);
  childEnds(it);
  lostHolds(it);
  facts(it);
  seams(it);
}

type It = (name: string, fn: (h: HostedHarness) => Promise<void>) => void;

const rowOf = (over: Partial<HostedSession> & Pick<HostedSession, "session_id" | "ownership_id" | "user_id">): HostedSession => ({
  client_id: "client", grant_id: "g1", source_session_id: over.session_id, writes_as: null, bind_gen: 0, root_session_id: null, place: null,
  lease_deadline: null, created_at: T0, last_seen_at: T0, suggested: null, parked_at: null, ...over,
});
// A root: its ownership and its row.
async function root(h: HostedHarness, id: string, user: number, over: Partial<HostedSession> = {}): Promise<HostedSession> {
  return h.write(async tx => {
    const ownership = await h.hosted.start(tx, id, user, over.client_id ?? "client", over.created_at ?? T0);
    const row = rowOf({ session_id: id, ownership_id: ownership, user_id: user, ...over });
    await h.hosted.insert(tx, row);
    return row;
  });
}
// A child under `parent`'s ownership.
async function child(h: HostedHarness, id: string, parent: HostedSession, over: Partial<HostedSession> = {}): Promise<HostedSession> {
  const row = rowOf({ session_id: id, ownership_id: parent.ownership_id, user_id: parent.user_id, root_session_id: parent.session_id, ...over });
  await h.write(tx => h.hosted.insert(tx, row));
  return row;
}
const ids = (rows: HostedSession[]) => rows.map(r => r.session_id);
const sorted = (rows: HostedSession[]) => ids(rows).sort();
// A row's HostedSession columns: SQLite's `SELECT *` also returns the legacy `name` column, which no caller reads.
const COLUMNS = Object.keys(rowOf({ session_id: "", ownership_id: 0, user_id: 0 })) as (keyof HostedSession)[];
const cols = (row: HostedSession | undefined) => row && Object.fromEntries(COLUMNS.map(k => [k, row[k]])) as HostedSession;
const get = async (h: HostedHarness, id: string) => cols(await h.hosted.get(h.read, id));

function basics(it: It): void {
  // H1.
  it("start returns increasing numeric ownership ids; insert round-trips every column; owned; all and ofOwnership skip parked rows, children doesn't", async h => {
    const u = await h.seedUser(ME);
    const [a, b] = await h.write(async tx => [await h.hosted.start(tx, "r1", u, "client", T0), await h.hosted.start(tx, "r2", u, "client", T0 + 1, "fe")]);
    expect(typeof a).toBe("number");
    expect(b).toBeGreaterThan(a!);
    const full = rowOf({ session_id: "r1", ownership_id: a!, user_id: u, client_id: "c9", grant_id: "g7", source_session_id: "src-1", writes_as: `${ME}/fe`,
      bind_gen: 3, place: "here", lease_deadline: T0 + 30_000, created_at: T0 + 2, last_seen_at: T0 + 3, suggested: "fe" });
    await h.write(tx => h.hosted.insert(tx, full));
    const got = await get(h, "r1");
    expect(got).toEqual(full);
    for (const k of ["ownership_id", "user_id", "bind_gen", "lease_deadline", "created_at", "last_seen_at"] as const) expect(typeof got![k]).toBe("number");
    expect(await get(h, "nope")).toBeUndefined();
    // An ownership with no rows still owns its ID; a child's row owns its own; an unknown ID is not hosted.
    expect(await h.hosted.owned(h.read, "r2")).toBe(true);
    const parent = (await get(h, "r1"))!;
    await child(h, "c1", parent, { last_seen_at: T0 });
    await child(h, "c2", parent, { last_seen_at: T0 });
    expect(await h.hosted.owned(h.read, "c1")).toBe(true);
    expect(await h.hosted.owned(h.read, "nope")).toBe(false);
    expect(await h.write(tx => h.hosted.park(tx, "c2", T0 + 5, T0 + 1))).toBe(true);
    expect(sorted(await h.hosted.all(h.read))).toEqual(["c1", "r1"]);
    expect(sorted(await h.hosted.ofOwnership(h.read, a!))).toEqual(["c1", "r1"]);
    expect(await h.hosted.ofOwnership(h.read, b!)).toEqual([]);
    expect(sorted(await h.hosted.children(h.read, "r1"))).toEqual(["c1", "c2"]);
    expect((await h.hosted.children(h.read, "r1")).find(r => r.session_id === "c2")?.parked_at).toBe(T0 + 5);
    expect(await h.hosted.children(h.read, "c1")).toEqual([]);
    // getMany (#1572): the rows that exist, parked ones too, each once however often its ID repeats; none for no IDs.
    const many = async (ids: string[], r: Read = h.read) => (await h.hosted.getMany(r, ids)).map(cols).sort((x, y) => x!.session_id < y!.session_id ? -1 : 1);
    expect(await many(["r1", "c2", "nope", "r1", "c2"])).toEqual([await get(h, "c2"), await get(h, "r1")]);
    expect(await many(["nope"])).toEqual([]);
    expect(await many([])).toEqual([]);
    // On the body's Tx it sees the body's own write.
    const before = (await get(h, "c1"))!;
    expect(await h.write(async tx => { await h.hosted.update(tx, "c1", { bind_gen: 7 }); return many(["c1"], tx); })).toEqual([{ ...before, bind_gen: 7 }]);
  });
}

function counting(it: It): void {
  // H2.
  it("counts count unparked rows per user and in total; roots are a user's roots by (created_at, session_id)", async h => {
    const u = await h.seedUser(ME), v = await h.seedUser("them@example.com");
    const r = await root(h, "r-b", u, { created_at: T0 + 5 });
    await root(h, "r-a", u, { created_at: T0 + 5 });
    await root(h, "r-z", u, { created_at: T0 + 1 });
    await root(h, "v-1", v, { created_at: T0 });
    await child(h, "c1", r, { created_at: T0 });
    await child(h, "c2", r, { created_at: T0 });
    expect(await h.hosted.counts(h.read, u)).toEqual({ total: 6, user: 5 });
    await h.write(tx => h.hosted.park(tx, "c2", T0 + 9, T0 + 1));
    expect(await h.hosted.counts(h.read, u)).toEqual({ total: 5, user: 4 });
    expect(await h.hosted.counts(h.read, v)).toEqual({ total: 5, user: 1 });
    expect(ids(await h.hosted.roots(h.read, u))).toEqual(["r-z", "r-a", "r-b"]);
    expect(ids(await h.hosted.roots(h.read, v))).toEqual(["v-1"]);
  });

  it("expired, idle and disabled select the sweep's candidates: roots by lease and by user; idle unparked children and unleased, unheld roots", async h => {
    const u = await h.seedUser(ME), off = await h.seedUser("off@example.com", true);
    const lapsed = await root(h, "lapsed", u, { lease_deadline: T0 + 10 });
    await root(h, "live", u, { lease_deadline: T0 + 11 });
    // A child with a deadline is never an expiry candidate.
    await child(h, "c-lease", lapsed, { lease_deadline: T0 });
    expect(sorted(await h.hosted.expired(h.read, T0 + 10))).toEqual(["lapsed"]);
    // Idle before T0 + 100: an old child; an old unleased root with no hold. Not: a recent row, a parked child, a held
    // root, a leased root.
    const old = await root(h, "old", u, { last_seen_at: T0 + 50 });
    await root(h, "recent", u, { last_seen_at: T0 + 100 });
    await root(h, "held", u, { last_seen_at: T0 + 50 });
    await h.seedHold(`${ME}/fe`, "held", T0);
    await child(h, "c-old", old, { last_seen_at: T0 + 50 });
    await child(h, "c-recent", old, { last_seen_at: T0 + 100 });
    await child(h, "c-parked", old, { last_seen_at: T0 + 50 });
    await h.write(tx => h.hosted.park(tx, "c-parked", T0 + 60, T0 + 100));
    expect(sorted(await h.hosted.idle(h.read, T0 + 100))).toEqual(["c-lease", "c-old", "old"]);
    // Disabled: that user's roots, not their children nor anyone else's roots.
    const d = await root(h, "off-root", off);
    await child(h, "off-child", d);
    expect(sorted(await h.hosted.disabled(h.read))).toEqual(["off-root"]);
  });
}

function rowWrites(it: It): void {
  // H3.
  it("park parks only an unparked child idle before the cutoff, and says so; unpark rewrites grant and last_seen_at", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u, { last_seen_at: T0 });
    await child(h, "c", r, { last_seen_at: T0 + 10 });
    // Seen at the cutoff: still active (a touch after the sweep's read).
    expect(await h.write(tx => h.hosted.park(tx, "c", T0 + 20, T0 + 10))).toBe(false);
    expect((await get(h, "c"))?.parked_at).toBeNull();
    // A root never parks.
    expect(await h.write(tx => h.hosted.park(tx, "r", T0 + 20, T0 + 99))).toBe(false);
    expect((await get(h, "r"))?.parked_at).toBeNull();
    expect(await h.write(tx => h.hosted.park(tx, "c", T0 + 20, T0 + 11))).toBe(true);
    expect((await get(h, "c"))?.parked_at).toBe(T0 + 20);
    // Already parked: keeps its first parked_at.
    expect(await h.write(tx => h.hosted.park(tx, "c", T0 + 30, T0 + 99))).toBe(false);
    expect((await get(h, "c"))?.parked_at).toBe(T0 + 20);
    await h.write(tx => h.hosted.unpark(tx, "c", "g2", T0 + 40));
    expect(await get(h, "c")).toEqual(rowOf({ session_id: "c", ownership_id: r.ownership_id, user_id: u, root_session_id: "r", grant_id: "g2", last_seen_at: T0 + 40 }));
  });

  it("touch and the update patch write only the columns they name; an empty patch writes nothing", async h => {
    const u = await h.seedUser(ME);
    const base = await root(h, "r", u, { bind_gen: 3, place: "p", lease_deadline: T0 + 5, grant_id: "g1", last_seen_at: T0 });
    const other = await root(h, "o", u, { bind_gen: 7 });
    await h.write(tx => h.hosted.touch(tx, "r", T0 + 1));
    expect(await get(h, "r")).toEqual({ ...base, last_seen_at: T0 + 1 });
    await h.write(tx => h.hosted.update(tx, "r", { lease_deadline: T0 + 9 }));
    expect(await get(h, "r")).toEqual({ ...base, last_seen_at: T0 + 1, lease_deadline: T0 + 9 });
    // null is a value: it clears the column.
    await h.write(tx => h.hosted.update(tx, "r", { place: null, lease_deadline: null }));
    expect(await get(h, "r")).toEqual({ ...base, last_seen_at: T0 + 1, lease_deadline: null, place: null });
    await h.write(tx => h.hosted.update(tx, "r", { bind_gen: 4, grant_id: "g2", last_seen_at: T0 + 7 }));
    const now = { ...base, place: null, lease_deadline: null, bind_gen: 4, grant_id: "g2", last_seen_at: T0 + 7 };
    expect(await get(h, "r")).toEqual(now);
    await h.write(tx => h.hosted.update(tx, "r", {}));
    expect(await get(h, "r")).toEqual(now);
    expect(await get(h, "o")).toEqual(other);
    // A patch for a missing row writes nothing.
    await h.write(tx => h.hosted.update(tx, "missing", { bind_gen: 1 }));
    expect(await get(h, "missing")).toBeUndefined();
  });
}

// A root with a lease, two children (inserted newest first), two holds and a launcher-marked ids row writing as an alias;
// and another user's root, which no end touches.
async function family(h: HostedHarness) {
  const u = await h.seedUser(ME), v = await h.seedUser("them@example.com");
  const r = await root(h, "r", u, { lease_deadline: T0 + 1_000 });
  await h.seedIds("r", { writesAs: `${ME}/fe`, launcher: true });
  await child(h, "c-new", r, { created_at: T0 + 20 });
  await child(h, "c-old", r, { created_at: T0 + 10 });
  for (const c of ["c-new", "c-old"]) await h.seedIds(c, { rootId: "r" });
  await h.seedHold(`${ME}/be`, "r", T0 + 2);
  await h.seedHold(`${ME}/fe`, "r", T0 + 1);
  const keep = await root(h, "keep", v);
  await h.seedHold("them@example.com/x", "keep", T0);
  return { u, r, keep };
}

function ends(it: It): void {
  // H4.
  it("end deletes the ownership's rows, ends it, clears the ids facts, drops each hold, ends each child in start order, and audits", async h => {
    const { r, keep } = await family(h);
    const before = (await h.auditRows()).length;
    expect(await h.write(tx => h.hosted.end(tx, "r", "closed", T0 + 50))).toBe(true);
    for (const id of ["r", "c-new", "c-old"]) expect(await get(h, id)).toBeUndefined();
    expect(await get(h, "keep")).toEqual(keep);
    expect(await h.ownership(r.ownership_id)).toEqual({ session_id: "r", ended_at: T0 + 50, end_reason: "closed" });
    expect(await h.ids("r")).toMatchObject({ writes_as: null, launcher: false, ended_at: null });
    expect(await h.holdRows()).toEqual([{ address: "them@example.com/x", id: "keep" }]);
    // Oldest hold first (HOLD_ORDER): fe was bound before be.
    expect((await h.bindingRows()).filter(b => b.session_id === "r").map(b => [b.name, b.event, b.detail]))
      .toEqual([[`${ME}/fe`, "released", "closed"], [`${ME}/be`, "released", "closed"]]);
    expect(h.hosted.takeEnded().map(e => e.id)).toEqual(["c-old", "c-new"]);
    for (const c of ["c-new", "c-old"]) expect(await h.idEnded(c)).toBe(T0 + 50);
    // Each child's id.ended, through the sink the store hands its session end: access_log on both backends.
    expect((await h.auditRows()).slice(before).filter(a => a.action === "id.ended").map(a => [a.actor, a.target, a.detail?.why]))
      .toEqual([["c-old", "c-old", "closed"], ["c-new", "c-new", "closed"]]);
    const audit = (await h.auditRows()).slice(before).filter(a => a.action.startsWith("hosted.") || a.action === "handle.launcher_set");
    expect(audit.map(a => [a.action, a.target, a.detail?.child ?? a.detail?.on ?? a.detail?.reason])).toEqual([
      ["handle.launcher_set", "r", false],
      ["hosted.child_released", "r", "c-old"],
      ["hosted.child_released", "r", "c-new"],
      ["hosted.lease_closed", "r", "closed"],
    ]);
    expect(audit.every(a => a.actor === ME && a.detail?.client_id === "client")).toBe(true);
    // A second end finds nothing: false, no audit, no child end.
    const after = (await h.auditRows()).length;
    expect(await h.write(tx => h.hosted.end(tx, "r", "closed", T0 + 60))).toBe(false);
    expect((await h.auditRows()).length).toBe(after);
    expect(h.hosted.takeEnded()).toEqual([]);
    expect(await h.ownership(r.ownership_id)).toMatchObject({ ended_at: T0 + 50, end_reason: "closed" });
  });

  it("end ends children that started together in session_id order", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u);
    // Inserted against the tiebreak's order, so neither insertion order nor a reversed tiebreak passes.
    for (const c of ["c-b", "c-a"]) await child(h, c, r, { created_at: T0 + 10 });
    expect(await h.write(tx => h.hosted.end(tx, "r", "closed", T0 + 50))).toBe(true);
    expect(h.hosted.takeEnded().map(e => e.id)).toEqual(["c-a", "c-b"]);
  });

  it("end refuses a child, a missing row, a deadline that moved and a row seen since the idle cutoff; an unleased root's end audits no lease_closed", async h => {
    const u = await h.seedUser(ME);
    const leased = await root(h, "leased", u, { lease_deadline: T0 + 10, last_seen_at: T0 + 5 });
    await child(h, "c", leased);
    const ended = (end: (tx: Tx) => Promise<boolean>) => h.write(end);
    expect(await ended(tx => h.hosted.end(tx, "c", "closed", T0))).toBe(false);
    expect(await ended(tx => h.hosted.end(tx, "missing", "closed", T0))).toBe(false);
    // An expiry that read deadline T0 + 9: the lease was renewed since.
    expect(await ended(tx => h.hosted.end(tx, "leased", "expired", T0 + 20, T0 + 9))).toBe(false);
    // An idle end whose cutoff the row was seen at or after.
    expect(await ended(tx => h.hosted.end(tx, "leased", "idle", T0 + 20, undefined, T0 + 5))).toBe(false);
    expect(await get(h, "leased")).toEqual(leased);
    expect(await get(h, "c")).toBeDefined();
    expect(await ended(tx => h.hosted.end(tx, "leased", "expired", T0 + 20, T0 + 10, T0 + 6))).toBe(true);
    expect(await get(h, "leased")).toBeUndefined();
    const idle = await root(h, "idle", u, { last_seen_at: T0 });
    const before = (await h.auditRows()).length;
    expect(await ended(tx => h.hosted.end(tx, "idle", "idle", T0 + 20, undefined, T0 + 1))).toBe(true);
    expect(await h.ownership(idle.ownership_id)).toMatchObject({ ended_at: T0 + 20, end_reason: "idle" });
    expect((await h.auditRows()).slice(before).map(a => a.action)).not.toContain("hosted.lease_closed");
  });
}

function audits(it: It): void {
  it("the store's audits name the session's latest ownership's user and client; ownership_started details a suggested name only when given", async h => {
    const u = await h.seedUser(ME), v = await h.seedUser("them@example.com");
    const before = (await h.auditRows()).length;
    const first = await root(h, "r", u, { client_id: "old" });
    expect(await h.write(tx => h.hosted.end(tx, "r", "closed", T0 + 5))).toBe(true);
    // The same session ID again, under another user and client: its rows name the new ownership's, not the first's.
    const second = await h.write(async tx => {
      const ownership = await h.hosted.start(tx, "r", v, "new", T0 + 6, "fe");
      await h.hosted.insert(tx, rowOf({ session_id: "r", ownership_id: ownership, user_id: v, client_id: "new", lease_deadline: T0 + 100 }));
      return ownership;
    });
    expect(await h.write(tx => h.hosted.end(tx, "r", "closed", T0 + 7))).toBe(true);
    expect((await h.auditRows()).slice(before).filter(a => a.action.startsWith("hosted.")).map(a => [a.action, a.actor, a.target, a.detail])).toEqual([
      ["hosted.ownership_started", ME, "r", { ownership: first.ownership_id, client_id: "old" }],
      ["hosted.ownership_started", "them@example.com", "r", { ownership: second, suggested: "fe", client_id: "new" }],
      ["hosted.lease_closed", "them@example.com", "r", { reason: "closed", ownership: second, client_id: "new" }],
    ]);
  });
}

function childEnds(it: It): void {
  // H5.
  it("childEnd ends a child (its row, an audit, its ID) and hands it to takeEnded only after commit; on a root it does nothing", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u);
    await child(h, "c", r);
    await h.seedIds("c", { rootId: "r" });
    const before = (await h.auditRows()).length;
    await h.write(tx => h.hosted.childEnd(tx, "r", T0 + 5, "closed"));
    expect(await get(h, "r")).toEqual(r);
    expect((await h.auditRows()).length).toBe(before);
    const inside = await h.write(async tx => {
      await h.hosted.childEnd(tx, "c", T0 + 6, "closed");
      return h.hosted.takeEnded();
    });
    expect(inside).toEqual([]);
    expect(await get(h, "c")).toBeUndefined();
    expect(await h.idEnded("c")).toBe(T0 + 6);
    expect(h.hosted.takeEnded().map(e => [e.id, e.at])).toEqual([["c", T0 + 6]]);
    expect(h.hosted.takeEnded()).toEqual([]);
    // The ID end's own audit is the end port's, not this group's.
    expect((await h.auditRows()).slice(before).filter(a => a.action.startsWith("hosted.")).map(a => [a.action, a.target, a.detail?.child, a.detail?.reason]))
      .toEqual([["hosted.child_released", "r", "c", "closed"]]);
    // That end writes its id.ended through the sink the store hands it, to access_log on both backends.
    expect((await h.auditRows()).slice(before).filter(a => a.action === "id.ended").map(a => [a.actor, a.target, a.detail]))
      .toEqual([["c", "c", { principal: null, held: [], why: "closed", bounced: 0 }]]);
    // Again: nothing left to end.
    await h.write(tx => h.hosted.childEnd(tx, "c", T0 + 7, "closed"));
    expect(h.hosted.takeEnded()).toEqual([]);
  });

  it("a rolled-back childEnd leaves its row and takeEnded empty; an eviction ends only a child still parked", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u);
    await child(h, "c", r, { last_seen_at: T0 });
    await h.seedIds("c", { rootId: "r" });
    const message = await failure(() => h.write(async tx => { await h.hosted.childEnd(tx, "c", T0 + 1, "closed"); throw new Error("rolled back"); }));
    expect(message).toBe("rolled back");
    expect(h.hosted.takeEnded()).toEqual([]);
    expect(await get(h, "c")).toBeDefined();
    expect(await h.idEnded("c")).toBeNull();
    // Woken since the sweep read it parked: the eviction keeps it.
    await h.write(tx => h.hosted.childEnd(tx, "c", T0 + 2, "evicted"));
    expect(await get(h, "c")).toBeDefined();
    expect(h.hosted.takeEnded()).toEqual([]);
    await h.write(tx => h.hosted.park(tx, "c", T0 + 3, T0 + 1));
    await h.write(tx => h.hosted.childEnd(tx, "c", T0 + 4, "evicted"));
    expect(await get(h, "c")).toBeUndefined();
    expect(h.hosted.takeEnded().map(e => e.id)).toEqual(["c"]);
  });
}

function lostHolds(it: It): void {
  // H6.
  it("lost holds: each reader takes a row once, oldest first by (at, insertion); reportLost repeats until seeLost; a row both took is gone", async h => {
    const u = await h.seedUser(ME);
    await root(h, "r", u);
    const lose = (alias: string, at: number, primary = false, reason = "revoked") => h.write(tx => h.hosted.lose(tx, "r", { alias, reason, primary }, at));
    // Two at one time keep their insertion order, not their names'.
    await lose("z", T0 + 1, true);
    await lose("y", T0 + 1);
    await lose("a", T0 + 2);
    const all = [{ alias: "z", reason: "revoked", primary: true }, { alias: "y", reason: "revoked", primary: false }, { alias: "a", reason: "revoked", primary: false }];
    expect(await h.hosted.lost(h.read, "r", "agent")).toEqual(all);
    expect(await h.hosted.lost(h.read, "r", "controller")).toEqual(all);
    expect(await h.write(tx => h.hosted.tellLost(tx, "r", T0 + 3))).toEqual(all);
    expect(await h.write(tx => h.hosted.tellLost(tx, "r", T0 + 4))).toEqual([]);
    expect(await h.hosted.lost(h.read, "r", "agent")).toEqual([]);
    // Not reported yet: seeLost takes nothing.
    expect(await h.write(tx => h.hosted.seeLost(tx, "r", T0 + 5))).toEqual([]);
    expect(await h.write(tx => h.hosted.reportLost(tx, "r", T0 + 5))).toEqual(all);
    expect(await h.write(tx => h.hosted.reportLost(tx, "r", T0 + 6))).toEqual(all);
    expect(await h.write(tx => h.hosted.seeLost(tx, "r", T0 + 7))).toEqual(all);
    expect(await h.write(tx => h.hosted.seeLost(tx, "r", T0 + 8))).toEqual([]);
    expect(await h.write(tx => h.hosted.reportLost(tx, "r", T0 + 9))).toEqual([]);
    expect(await h.lostRows()).toEqual([]);
  });

  it("lose re-arms a pending or taken alias for both readers, ordered by its new time; forgetLost drops one; a row only one reader took stays", async h => {
    const u = await h.seedUser(ME);
    await root(h, "r", u);
    await root(h, "other", u);
    await h.write(tx => h.hosted.lose(tx, "r", { alias: "a", reason: "first", primary: false }, T0 + 1));
    await h.write(tx => h.hosted.lose(tx, "r", { alias: "b", reason: "first", primary: false }, T0 + 2));
    await h.write(tx => h.hosted.lose(tx, "other", { alias: "a", reason: "first", primary: false }, T0 + 1));
    expect((await h.write(tx => h.hosted.tellLost(tx, "r", T0 + 3))).map(l => l.alias)).toEqual(["a", "b"]);
    // a again, later: both readers again, after b for the Controller.
    await h.write(tx => h.hosted.lose(tx, "r", { alias: "a", reason: "again", primary: true }, T0 + 4));
    expect(await h.hosted.lost(h.read, "r", "agent")).toEqual([{ alias: "a", reason: "again", primary: true }]);
    expect(await h.hosted.lost(h.read, "r", "controller")).toEqual([{ alias: "b", reason: "first", primary: false }, { alias: "a", reason: "again", primary: true }]);
    // The Controller's take: by time, so b (inserted after a, lost before a's restatement) first.
    expect((await h.write(tx => h.hosted.reportLost(tx, "r", T0 + 5))).map(l => l.alias)).toEqual(["b", "a"]);
    expect((await h.write(tx => h.hosted.seeLost(tx, "r", T0 + 6))).map(l => l.alias)).toEqual(["b", "a"]);
    // b: both took it, so it is gone; a: the agent hasn't, so it stays until forgotten. other's a is another session's.
    expect((await h.lostRows()).map(l => `${l.session_id} ${l.alias}`).sort()).toEqual(["other a", "r a"]);
    await h.write(tx => h.hosted.forgetLost(tx, "r", "a"));
    expect(await h.hosted.lost(h.read, "r", "agent")).toEqual([]);
    expect((await h.lostRows()).map(l => `${l.session_id} ${l.alias}`)).toEqual(["other a"]);
    expect(await h.hosted.lost(h.read, "other", "agent")).toEqual([{ alias: "a", reason: "first", primary: false }]);
  });
}

function facts(it: It): void {
  // H7.
  it("server liveness and the ids facts: aliveAt, setRoot, restateWritesAs, declareLauncher, launcher, reopenId, holds in (bound_at, address) order", async h => {
    expect(await h.hosted.aliveAt(h.read)).toBeUndefined();
    await h.write(tx => h.hosted.heartbeat(tx, T0));
    expect(await h.hosted.aliveAt(h.read)).toBe(T0);
    await h.write(tx => h.hosted.heartbeat(tx, T0 + 5));
    expect(await h.hosted.aliveAt(h.read)).toBe(T0 + 5);
    await h.seedIds("s", { writesAs: "a/fe", endedAt: T0, heldAliasesJson: '["a/fe"]' });
    await h.seedIds("t");
    // A row from before the launcher flag: NULL, not false.
    await h.seedIds("n", { launcher: null });
    await h.write(tx => h.hosted.setRoot(tx, "s", "root-1"));
    expect((await h.ids("s"))?.root_id).toBe("root-1");
    await h.write(tx => h.hosted.setRoot(tx, "s", null));
    expect((await h.ids("s"))?.root_id).toBeNull();
    // restateWritesAs fills only an empty writes_as.
    await h.write(tx => h.hosted.restateWritesAs(tx, "s", "a/be"));
    expect((await h.ids("s"))?.writes_as).toBe("a/fe");
    await h.write(tx => h.hosted.restateWritesAs(tx, "t", "a/be"));
    expect((await h.ids("t"))?.writes_as).toBe("a/be");
    expect(await h.hosted.launcher(h.read, "s")).toBe(false);
    expect(await h.write(tx => h.hosted.declareLauncher(tx, "s"))).toBe(true);
    expect(await h.write(tx => h.hosted.declareLauncher(tx, "s"))).toBe(false);
    expect(await h.hosted.launcher(h.read, "s")).toBe(true);
    expect(await h.hosted.launcher(h.read, "missing")).toBe(false);
    expect(await h.hosted.launcher(h.read, "n")).toBe(false);
    expect(await h.write(tx => h.hosted.declareLauncher(tx, "n"))).toBe(true);
    expect(await h.hosted.launcher(h.read, "n")).toBe(true);
    await h.write(tx => h.hosted.reopenId(tx, "s"));
    expect(await h.ids("s")).toMatchObject({ ended_at: null, held_aliases_json: null, writes_as: "a/fe", launcher: true });
    await h.seedHold("a/b", "s", T0 + 2);
    await h.seedHold("a/a", "t", T0 + 2);
    await h.seedHold("a/z", "t", T0 + 1);
    expect(await h.hosted.holds(h.read)).toEqual([{ id: "t", address: "a/z" }, { id: "t", address: "a/a" }, { id: "s", address: "a/b" }]);
  });
}

function seams(it: It): void {
  // H8.
  it("grantLive is true only for an unrevoked grant expiring after now; lock returns the row or undefined; the seams refuse a settled Tx", async h => {
    const u = await h.seedUser(ME);
    await h.seedGrant("live", u, T0 + 10);
    await h.seedGrant("revoked", u, T0 + 10, T0 - 1);
    await h.seedGrant("expired", u, T0);
    const live = (id: string, now = T0) => h.write(tx => h.hosted.grantLive(tx, id, now));
    expect(await live("live")).toBe(true);
    expect(await live("live", T0 + 9)).toBe(true);
    expect(await live("live", T0 + 10)).toBe(false);
    expect(await live("revoked")).toBe(false);
    expect(await live("expired")).toBe(false);
    expect(await live("missing")).toBe(false);
    const r = await root(h, "r", u);
    const c = await child(h, "c", r);
    expect(cols(await h.write(tx => h.hosted.lock(tx, "r")))).toEqual(r);
    expect(cols(await h.write(tx => h.hosted.lock(tx, "c")))).toEqual(c);
    expect(await h.write(tx => h.hosted.lock(tx, "missing"))).toBeUndefined();
    // Inside a body, after its own write.
    expect(await h.write(async tx => { await h.hosted.update(tx, "r", { bind_gen: 5 }); return (await h.hosted.lock(tx, "r"))?.bind_gen; })).toBe(5);
    await h.write(tx => h.hosted.lockCapacity(tx));
  });

  it("the lock seams refuse the store's pool Read: a lock outside a transaction would hold nothing", async h => {
    const u = await h.seedUser(ME);
    await h.seedGrant("live", u, T0 + 10);
    await root(h, "r", u);
    const pool = h.read as Tx;
    for (const [name, call] of [["lock", () => h.hosted.lock(pool, "r")], ["lockCapacity", () => h.hosted.lockCapacity(pool)], ["grantLive", () => h.hosted.grantLive(pool, "live", T0)]] as const)
      expect(`${name}: ${await failure(call)}`).toMatch(new RegExp(`^${name}: .*(Tx|transaction)`));
  });

  // Moved from db.test.ts's P1c-11/P1c-12: every method resolves its handle before it reads an argument, so a kept Tx
  // is refused whatever the rest of the call says, and writes nothing.
  it("every method refuses a Tx kept past its body, and writes nothing", async h => {
    const u = await h.seedUser(ME);
    await h.seedGrant("live", u, T0 + 10);
    const r = await root(h, "r", u, { lease_deadline: T0 + 5 });
    const c = await child(h, "c", r, { last_seen_at: T0 });
    const kept = await h.write(async tx => tx);
    const settled = /used after its transaction settled/;
    const lost = { alias: `${ME}/fe`, reason: "r", primary: true };
    const calls: [string, () => unknown][] = [
      ["lock", () => h.hosted.lock(kept, "r")], ["lockCapacity", () => h.hosted.lockCapacity(kept)], ["grantLive", () => h.hosted.grantLive(kept, "live", T0)],
      ["park", () => h.hosted.park(kept, "c", T0 + 1, T0 + 1)], ["unpark", () => h.hosted.unpark(kept, "c", "g9", T0 + 1)],
      ["start", () => h.hosted.start(kept, "r2", u, "client", T0)], ["insert", () => h.hosted.insert(kept, { ...r, session_id: "r2" })],
      ["update", () => h.hosted.update(kept, "r", { bind_gen: 9 })], ["touch", () => h.hosted.touch(kept, "r", T0 + 9)],
      ["end", () => h.hosted.end(kept, "r", "closed", T0 + 9)], ["childEnd", () => h.hosted.childEnd(kept, "c", T0 + 9, "closed")],
      ["lose", () => h.hosted.lose(kept, "r", lost, T0 + 9)], ["tellLost", () => h.hosted.tellLost(kept, "r", T0 + 9)],
      ["reportLost", () => h.hosted.reportLost(kept, "r", T0 + 9)], ["seeLost", () => h.hosted.seeLost(kept, "r", T0 + 9)],
      ["forgetLost", () => h.hosted.forgetLost(kept, "r", lost.alias)], ["heartbeat", () => h.hosted.heartbeat(kept, T0 + 9)],
      ["setRoot", () => h.hosted.setRoot(kept, "c", "r")], ["reopenId", () => h.hosted.reopenId(kept, "c")],
      ["restateWritesAs", () => h.hosted.restateWritesAs(kept, "r", lost.alias)], ["declareLauncher", () => h.hosted.declareLauncher(kept, "r")],
      ["get", () => h.hosted.get(kept, "r")], ["owned", () => h.hosted.owned(kept, "r")], ["all", () => h.hosted.all(kept)],
      ["counts", () => h.hosted.counts(kept, u)], ["ofOwnership", () => h.hosted.ofOwnership(kept, r.ownership_id)],
      ["children", () => h.hosted.children(kept, "r")], ["roots", () => h.hosted.roots(kept, u)], ["expired", () => h.hosted.expired(kept, T0 + 9)],
      ["idle", () => h.hosted.idle(kept, T0 + 9)], ["disabled", () => h.hosted.disabled(kept)], ["lost", () => h.hosted.lost(kept, "r", "agent")],
      ["aliveAt", () => h.hosted.aliveAt(kept)], ["launcher", () => h.hosted.launcher(kept, "r")], ["holds", () => h.hosted.holds(kept)],
    ];
    for (const [name, call] of calls) expect(`${name}: ${await failure(call)}`).toMatch(new RegExp(`^${name}: .*${settled.source}`));
    expect(await get(h, "r")).toEqual(r);
    expect(await get(h, "c")).toEqual(c);
    expect(await get(h, "r2")).toBeUndefined();
    expect(await h.hosted.owned(h.read, "r2")).toBe(false);
    expect(await h.lostRows()).toEqual([]);
    expect(await h.hosted.aliveAt(h.read)).toBeUndefined();
    expect(await h.ids("r")).toBeUndefined();
  });
}
