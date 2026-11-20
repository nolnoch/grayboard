// The bindings store's contract (#807 P3 C10a-a, docs/future/postgres-server.md D9): every BindingsStore method,
// written once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a
// backend's test file registers it under a describe() (bindings.contract.sqlite.ts through db.test.ts for SQLite,
// pg/bindings.contract.pg.test.ts for Postgres, C10a-b).
//
// Portability rules the rows follow:
// - Each row opens a fresh store. No answer depends on a wall clock: every stamp a row asserts is passed in (take's
//   now, log's at, touch's now) or written by a fixture (started).
// - The rows are serial. An interleaving (two takes of one alias, a take against an end, two registrations of one ID,
//   two label writes) is a backend's own test: Postgres runs them on two connections (C10a-b's
//   pg/bindings.pg.test.ts). So dropping a lock passes here on every backend; what these rows pin is each method's
//   serial answer, and that a refusal (take's null, registerId's IdCollision) writes nothing and leaves the body
//   usable, so no caller needs a savepoint around a store call.
// - Fixture writes the store doesn't offer (an alias row, a hold at a given bound_at, an ended_at, a started_at, a
//   pruned ID's tombstone) and the raw reads are the harness's, so no row touches a connection. Raw reads return
//   booleans for the boolean columns whatever the store keeps.
import { expect, test } from "bun:test";
import { REFUSED_COALESCE_MS } from "../../core/bindings.ts";
import { IdCollision } from "../../core/errors.ts";
import type { BindingsStore, IdFacts } from "./bindings.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type BindingsHarness = {
  bindings: BindingsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: a person-scope alias row (its address); a hold at bound_at; a
  // session's ended_at; a session's started_at; a pruned keyed ID's tombstone.
  alias(scopeRef: string, name: string): Promise<string>;
  hold(address: string, id: string, boundAt: number): Promise<void>;
  end(id: string, at: number): Promise<void>;
  started(id: string, at: number): Promise<void>;
  tombstone(id: string, endedAt: number, prunedAt: number): Promise<void>;
  // Raw reads: every hold by address; every binding event in write order; an alias's presence, opt-out and labels; a
  // session's columns the reads above don't return; every tombstone by id; an action's access_log rows.
  holdRows(): Promise<{ address: string; id: string; bound_at: number }[]>;
  events(): Promise<{ session_id: string; name: string; event: string; at: number; detail: string | null; count: number | null; last_at: number | null }[]>;
  aliasRow(address: string): Promise<{ last_seen: number | null; queue_off: boolean; task: string | null; owner: string | null; source_board: string | null; spec_hash: string | null; description: string | null } | undefined>;
  idColumns(id: string): Promise<{ harness: string | null; cwd: string | null; delivery: string; keyed: boolean; local_resume: boolean; root_id: string | null; harness_session: string | null; started_at: number; last_seen: number } | undefined>;
  tombstones(): Promise<{ id: string; ended_at: number; pruned_at: number }[]>;
  audits(action: string): Promise<unknown[]>;
  close(): void | Promise<void>;
};

export type BindingsBackend = { kind: "sqlite" | "postgres"; open(): Promise<BindingsHarness> };

const B = "b@example.com", C = "c@example.com";
const SETTLED = "Tx used after its transaction settled";

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}
// The error a body's call rejects with, caught inside the body so the write commits.
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

export function bindingsContract(backend: BindingsBackend): void {
  const it = (name: string, fn: (h: BindingsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  reads(it);
  takes(it);
  registers(it);
  labels(it);
  writes(it);
}

type It = (name: string, fn: (h: BindingsHarness) => Promise<void>) => void;

const register = (h: BindingsHarness, f: IdFacts) => h.write(tx => h.bindings.registerId(tx, f));
const take = (h: BindingsHarness, address: string, id: string, principal: string, now: number) =>
  h.write(tx => h.bindings.take(tx, address, id, principal, now));

function reads(it: It): void {
  // From db.test.ts B1a.
  it("reads run on the handle they're given; the batched ones keep HOLD_ORDER and leave misses out", async h => {
    const b = h.bindings;
    const [s1, s2, idle, viewer, ended, cw] = ["id:0000000000001", "id:0000000000002", "id:0000000000003", "id:0000000000004", "id:0000000000005", "id:0000000000006"];
    const [fe, be, ops, zz] = [await h.alias(B, "fe"), await h.alias(B, "be"), await h.alias(B, "ops"), await h.alias(B, "zz")];
    const qa = await h.alias(C, "qa");
    const [old, gone] = [await h.alias(B, "old"), await h.alias(B, "gone")];
    for (const id of [s1, s2, idle]) await register(h, { id, principal: B, launcher: false });
    // An ended session that held old and wrote as gone before it ended: neither is a use (aliasUses, userOf).
    await register(h, { id: ended, principal: B, launcher: false, writesAs: gone });
    await h.hold(old, ended, 5);
    await register(h, { id: viewer, principal: B, launcher: false, viewer: true });
    await register(h, { id: cw, principal: C, launcher: false, writesAs: qa });
    await h.end(ended, 10);
    const kept = await h.write(async tx => {
      // s1's be is taken after its fe, in the same millisecond: HOLD_ORDER keeps fe first.
      await b.take(tx, fe, s1, B, 500);
      await b.take(tx, be, s1, B, 500);
      await b.take(tx, ops, s2, B, 100);
      await b.setStatus(tx, s2, "busy", 7);
      await b.touchId(tx, s2, 900);
      await b.touchAlias(tx, fe, 1000);
      // Inside the body that wrote them, on its Tx.
      expect(await b.holdsOf(tx, s1)).toEqual([fe, be]);
      expect(await b.holderOf(tx, ops)).toBe(s2);
      return tx;
    });
    // s2's zz is written after its ops but bound before it: HOLD_ORDER disagrees with insertion and address order.
    await h.hold(zz, s2, 50);
    for (const read of [
      () => b.holdsOf(kept, s1), () => b.holdsOfMany(kept, [s1]), () => b.holderOf(kept, fe), () => b.holdersOf(kept, [fe]),
      () => b.userOf(kept, fe), () => b.addressSet(kept, fe, B), () => b.idRow(kept, s1), () => b.unendedIds(kept),
      () => b.idStatuses(kept, [s2]), () => b.aliasUses(kept, null), () => b.lastSeen(kept, [fe]), () => b.viewerIds(kept),
      () => b.idFacts(kept, [s1]),
    ]) expect(await failure(read)).toContain(SETTLED);
    const r = h.read;
    expect(await b.holdsOf(r, s1)).toEqual([fe, be]);
    expect(await b.holdsOf(r, s2)).toEqual([zz, ops]);
    expect(await b.holdsOfMany(r, [s1, s2, idle])).toEqual(new Map([[s1, [fe, be]], [s2, [zz, ops]], [idle, []]]));
    expect(await b.holdersOf(r, [fe, ops, `${B}/none`])).toEqual(new Map([[fe, s1], [ops, s2]]));
    expect(await b.holderOf(r, `${B}/none`)).toBeNull();
    expect(await b.userOf(r, fe)).toBe(s1);
    expect(await b.userOf(r, fe, B)).toBeNull();
    expect(await b.userOf(r, qa)).toBe(cw);
    expect(await b.userOf(r, qa, B)).toBe(cw);
    expect(await b.userOf(r, old)).toBeNull();
    expect(await b.userOf(r, gone)).toBeNull();
    expect(await b.addressSet(r, be, B)).toEqual([be, fe, s1]);
    expect(await b.addressSet(r, s1, B)).toEqual([s1, fe, be]);
    expect(await b.addressSet(r, be, C)).toEqual([be]);
    expect(await b.addressSet(r, be, null)).toEqual([be]);
    expect(await b.idRow(r, s1)).toEqual({ principal: B, ended_at: null, place: null, writes_as: null, viewer: false });
    expect(await b.idRow(r, viewer)).toMatchObject({ viewer: true });
    expect(await b.idRow(r, ended)).toMatchObject({ ended_at: 10 });
    expect(await b.idRow(r, "id:000000000000Z")).toBeUndefined();
    expect((await b.unendedIds(r)).sort()).toEqual([s1, s2, idle, cw].sort());
    expect(await b.viewerIds(r)).toEqual(new Set([viewer]));
    expect(await b.idStatuses(r, [s1, s2, "id:000000000000Z"])).toEqual(new Map([[s2, { status: "busy", status_at: 7 }]]));
    const uses = (await b.aliasUses(r, null)).sort((x, y) => x.address < y.address ? -1 : 1);
    expect(uses).toEqual([
      { id: s1, principal: B, address: be, scope_kind: "person", scope_ref: B, held: true },
      { id: s1, principal: B, address: fe, scope_kind: "person", scope_ref: B, held: true },
      { id: s2, principal: B, address: ops, scope_kind: "person", scope_ref: B, held: true },
      { id: s2, principal: B, address: zz, scope_kind: "person", scope_ref: B, held: true },
      { id: cw, principal: C, address: qa, scope_kind: "person", scope_ref: C, held: false },
    ]);
    expect((await b.aliasUses(r, C)).map(u => u.address)).toEqual([qa]);
    // An alias's and a session's last-seen, a repeat once, a never-seen alias absent (an ids row always has one).
    expect(await b.lastSeen(r, [fe, s2, fe, be])).toEqual(new Map([[fe, 1000], [s2, 900]]));
    expect(await b.idFacts(r, [s1, cw, "id:000000000000Z"])).toEqual(new Map([
      [s1, { principal: B, harness: null, model: null, effort: null, launcher: 0 }],
      [cw, { principal: C, harness: null, model: null, effort: null, launcher: 0 }],
    ]));
  });
}

function takes(it: It): void {
  // From db.test.ts B1c, plus the refusal's body staying usable.
  it("take refuses another ID's hold and another user's writer, re-takes its own, and orders one ID's takes", async h => {
    const [s1, s2, bWriter, cWriter, cEnded] = ["id:0000000000001", "id:0000000000002", "id:0000000000003", "id:0000000000004", "id:0000000000005"];
    const [fe, be, ops, qa, dev] = [await h.alias(B, "fe"), await h.alias(B, "be"), await h.alias(B, "ops"), await h.alias(B, "qa"), await h.alias(B, "dev")];
    for (const id of [s1, s2]) await register(h, { id, principal: B, launcher: false });
    // A tools-only writer as fe of another user, one as be of the same user, and an ended one of another user as dev.
    await register(h, { id: cWriter, principal: C, launcher: false, writesAs: fe });
    await register(h, { id: bWriter, principal: B, launcher: false, writesAs: be });
    await register(h, { id: cEnded, principal: C, launcher: false, writesAs: dev });
    await h.end(cEnded, 50);
    expect(await take(h, ops, s2, B, 100)).toEqual({ bound_at: 100 });
    // Another ID's hold, the same user's: no take, and its row stays as it was.
    expect(await take(h, ops, s1, B, 200)).toBeNull();
    // Another user's unended writer: no take.
    expect(await take(h, fe, s1, B, 200)).toBeNull();
    expect(await h.holdRows()).toEqual([{ address: ops, id: s2, bound_at: 100 }]);
    // A refused take writes nothing and leaves its body usable: the body's next write commits.
    await h.write(async tx => {
      expect(await h.bindings.take(tx, ops, s1, B, 250)).toBeNull();
      await h.bindings.touchAlias(tx, ops, 250);
    });
    expect(await h.bindings.lastSeen(h.read, [ops])).toEqual(new Map([[ops, 250]]));
    expect(await h.holdRows()).toEqual([{ address: ops, id: s2, bound_at: 100 }]);
    // The same user's writer shares the alias with a holder; an ended writer uses nothing.
    expect(await take(h, be, s1, B, 300)).toEqual({ bound_at: 300 });
    expect(await take(h, dev, s2, B, 300)).toEqual({ bound_at: 300 });
    // Two takes by one ID in one millisecond keep their order (bound_at after the ID's other holds).
    expect(await take(h, qa, s1, B, 300)).toEqual({ bound_at: 301 });
    // The same ID's re-take restamps its own hold.
    expect(await take(h, be, s1, B, 400)).toEqual({ bound_at: 400 });
    // A re-take at or before its own bound_at stamps now: only the ID's other holds (qa at 301) bound it, so the
    // stamp stays at an equal now and moves back to an earlier one.
    expect(await take(h, be, s1, B, 400)).toEqual({ bound_at: 400 });
    expect(await take(h, be, s1, B, 350)).toEqual({ bound_at: 350 });
    expect(await h.holdRows()).toEqual([
      { address: be, id: s1, bound_at: 350 }, { address: dev, id: s2, bound_at: 300 },
      { address: ops, id: s2, bound_at: 100 }, { address: qa, id: s1, bound_at: 301 },
    ]);
    // A released hold frees the alias for another ID; a release by an ID that doesn't hold it changes nothing.
    await h.write(tx => h.bindings.release(tx, qa, s2));
    expect(await h.bindings.holderOf(h.read, qa)).toBe(s1);
    await h.write(tx => h.bindings.release(tx, qa, s1));
    expect(await take(h, qa, s2, B, 500)).toEqual({ bound_at: 500 });
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.bindings.take(kept, fe, s2, B, 600))).toContain(SETTLED);
    expect(await failure(() => h.bindings.release(kept, qa, s2))).toContain(SETTLED);
    expect(await h.bindings.holderOf(h.read, qa)).toBe(s2);
  });

  // userOf's one answer (#338): the holder before a writer, then started_at, then registration order (not ID order).
  it("userOf picks the holder, then the earliest started, then the first registered", async h => {
    const x = await h.alias(B, "x");
    const [cZ, cA, bH] = ["id:000000000000Z", "id:000000000000A", "id:000000000000M"];
    // Registered Z then A, with one started_at: the first registered wins, whichever ID sorts first.
    await register(h, { id: cZ, principal: C, launcher: false, writesAs: x });
    await register(h, { id: cA, principal: C, launcher: false, writesAs: x });
    for (const id of [cZ, cA]) await h.started(id, 1000);
    expect(await h.bindings.userOf(h.read, x)).toBe(cZ);
    expect(await h.bindings.userOf(h.read, x, B)).toBe(cZ);
    expect(await h.bindings.userOf(h.read, x, C)).toBeNull();
    // An earlier start wins over registration order.
    await h.started(cA, 999);
    expect(await h.bindings.userOf(h.read, x)).toBe(cA);
    // A holder registered last, and started last, wins over both writers; another principal's query skips it.
    await register(h, { id: bH, principal: B, launcher: false });
    await h.started(bH, 2000);
    await h.hold(x, bH, 2000);
    expect(await h.bindings.userOf(h.read, x)).toBe(bH);
    expect(await h.bindings.userOf(h.read, x, C)).toBe(bH);
    expect(await h.bindings.userOf(h.read, x, B)).toBe(cA);
    // An ended session uses nothing.
    await h.end(bH, 3000);
    await h.end(cA, 3000);
    expect(await h.bindings.userOf(h.read, x)).toBe(cZ);
    expect(await h.bindings.userOf(h.read, `${B}/none`)).toBeNull();
    // A session with no principal counts as another principal's for every exceptPrincipal.
    const [y, nW] = [await h.alias(B, "y"), "id:000000000000N"];
    await register(h, { id: nW, principal: null, launcher: false, writesAs: y });
    expect(await h.bindings.userOf(h.read, y, B)).toBe(nW);
    expect(await h.bindings.userOf(h.read, y, C)).toBe(nW);
    expect(await h.bindings.userOf(h.read, y)).toBe(nW);
  });
}

function registers(it: It): void {
  it("registerId writes the session's row from its facts, cleaned, and returns null for a new ID", async h => {
    const [s1, w, child, v] = ["id:0000000000001", "id:0000000000002", "id:0000000000003", "id:0000000000004"];
    const fe = await h.alias(B, "fe");
    expect(await register(h, {
      id: s1, principal: B, harness: "claude​\ncode", cwd: "/w", place: "host\u0007 /repo", launcher: true, keyed: true,
      model: " m ", effort: "high", harnessSession: "hs-1", localResume: true,
    })).toBeNull();
    expect(await h.bindings.idRow(h.read, s1)).toEqual({ principal: B, ended_at: null, place: "host /repo", writes_as: null, viewer: false });
    expect(await h.bindings.idFacts(h.read, [s1])).toEqual(new Map([[s1, { principal: B, harness: "claude code", model: "m", effort: "high", launcher: 1 }]]));
    // started_at and last_seen are one stamp (the store's clock, so only their equality is pinned).
    const cols = (await h.idColumns(s1))!;
    expect(cols.started_at).toBeGreaterThan(0);
    expect(cols).toEqual({ harness: "claude code", cwd: "/w", delivery: "push", keyed: true, local_resume: true, root_id: null, harness_session: "hs-1", started_at: cols.started_at, last_seen: cols.started_at });
    // A tools-only writer and a child receive nothing; a viewer is never unended.
    await register(h, { id: w, principal: B, launcher: false, writesAs: fe });
    await register(h, { id: child, principal: B, launcher: false, rootId: s1 });
    await register(h, { id: v, principal: null, launcher: false, viewer: true });
    expect(await h.bindings.idRow(h.read, w)).toMatchObject({ writes_as: fe });
    expect(await h.idColumns(w)).toMatchObject({ delivery: "none", keyed: false, local_resume: false, root_id: null });
    expect(await h.idColumns(child)).toMatchObject({ delivery: "none", root_id: s1 });
    expect(await h.bindings.idRow(h.read, v)).toMatchObject({ principal: null, viewer: true });
    expect((await h.bindings.unendedIds(h.read)).sort()).toEqual([s1, w, child].sort());
    expect(await h.bindings.idFacts(h.read, [w])).toEqual(new Map([[w, { principal: B, harness: null, model: null, effort: null, launcher: 0 }]]));
  });

  it("a second registerId of an ID rejects with IdCollision carrying its ended_at, writes nothing and leaves the body usable", async h => {
    const s1 = "id:0000000000001";
    await register(h, { id: s1, principal: B, harness: "pi", launcher: false });
    // Caught inside the body, which then writes and commits.
    const e = await h.write(async tx => {
      const err = await caught(() => h.bindings.registerId(tx, { id: s1, principal: C, harness: "other", launcher: true, writesAs: "x" }));
      await h.bindings.touchId(tx, s1, 77);
      return err;
    });
    expect(e).toBeInstanceOf(IdCollision);
    expect(e).toMatchObject({ id: s1, endedAt: null, why: "is a live session's" });
    expect(await h.bindings.idRow(h.read, s1)).toEqual({ principal: B, ended_at: null, place: null, writes_as: null, viewer: false });
    expect(await h.idColumns(s1)).toMatchObject({ harness: "pi", delivery: "push" });
    expect(await h.bindings.lastSeen(h.read, [s1])).toEqual(new Map([[s1, 77]]));
    // An ended row collides too, naming when it ended.
    await h.end(s1, 1_800_000_000_000);
    const ended = await caught(() => register(h, { id: s1, principal: B, launcher: false }));
    expect(ended).toBeInstanceOf(IdCollision);
    expect(ended).toMatchObject({ id: s1, endedAt: 1_800_000_000_000, why: `ended at ${new Date(1_800_000_000_000).toISOString()}` });
    expect(await h.bindings.idRow(h.read, s1)).toMatchObject({ ended_at: 1_800_000_000_000 });
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.bindings.registerId(kept, { id: "id:0000000000009", principal: B, launcher: false }))).toContain(SETTLED);
    expect(await h.bindings.idRow(h.read, "id:0000000000009")).toBeUndefined();
  });

  it("registerId of a pruned ID consumes its tombstone and returns it (ReusedId), keyed or not", async h => {
    const [k, nk, other] = ["id:000000000000K", "id:000000000000J", "id:000000000000L"];
    await h.tombstone(k, 5, 6);
    await h.tombstone(nk, 3, 4);
    await h.tombstone(other, 7, 8);
    expect(await register(h, { id: k, principal: B, launcher: false, keyed: true })).toEqual({ ended_at: 5, pruned_at: 6 });
    expect(await h.tombstones()).toEqual([{ id: nk, ended_at: 3, pruned_at: 4 }, { id: other, ended_at: 7, pruned_at: 8 }]);
    expect(await h.bindings.idRow(h.read, k)).toMatchObject({ principal: B, ended_at: null });
    // Only keyed IDs leave a tombstone, but a registration consumes one whether or not it is keyed.
    expect(await register(h, { id: nk, principal: B, launcher: false })).toEqual({ ended_at: 3, pruned_at: 4 });
    expect(await h.tombstones()).toEqual([{ id: other, ended_at: 7, pruned_at: 8 }]);
    // A register that collides writes nothing: a tombstone under its own ID stays.
    await h.tombstone(k, 9, 10);
    expect(await caught(() => register(h, { id: k, principal: B, launcher: false }))).toBeInstanceOf(IdCollision);
    expect(await h.tombstones()).toEqual([{ id: k, ended_at: 9, pruned_at: 10 }, { id: other, ended_at: 7, pruned_at: 8 }]);
  });
}

function labels(it: It): void {
  // #807 P3 C10a Q3: setMeta returns its diff and writes no audit row; the server audits it.
  it("setMeta writes only the changed labels and returns their before and after, null when nothing changed", async h => {
    const fe = await h.alias(B, "fe");
    const set = (meta: Parameters<BindingsStore["setMeta"]>[2]) => h.write(tx => h.bindings.setMeta(tx, fe, meta));
    const labels = async () => {
      const row = (await h.aliasRow(fe))!;
      return { task: row.task, owner: row.owner, source_board: row.source_board, spec_hash: row.spec_hash, description: row.description };
    };
    expect(await set({ task: "t", owner: "o" })).toEqual({ before: { task: null, owner: null }, after: { task: "t", owner: "o" } });
    expect(await labels()).toEqual({ task: "t", owner: "o", source_board: null, spec_hash: null, description: null });
    // The same values again, or no keys: no change, null.
    expect(await set({ task: "t", owner: "o" })).toBeNull();
    expect(await set({})).toBeNull();
    // Only the changed key is in the diff, and only it is written.
    expect(await set({ task: "t2", owner: "o" })).toEqual({ before: { task: "t" }, after: { task: "t2" } });
    expect(await labels()).toEqual({ task: "t2", owner: "o", source_board: null, spec_hash: null, description: null });
    // A null clears a label; clearing an unset one is no change.
    expect(await set({ owner: null, description: null })).toEqual({ before: { owner: "o" }, after: { owner: null } });
    expect(await labels()).toEqual({ task: "t2", owner: null, source_board: null, spec_hash: null, description: null });
    expect(await set({ source_board: "#ops", spec_hash: "abc" })).toEqual({ before: { source_board: null, spec_hash: null }, after: { source_board: "#ops", spec_hash: "abc" } });
    // An alias with no row rejects, writing nothing.
    expect(await failure(() => h.write(tx => h.bindings.setMeta(tx, `${B}/none`, { task: "t" })))).toContain(`no alias "${B}/none"`);
    // A diff rolls back with its body.
    expect(await failure(() => h.write(async tx => {
      expect(await h.bindings.setMeta(tx, fe, { task: "t3" })).toEqual({ before: { task: "t2" }, after: { task: "t3" } });
      throw new Error("rolled back");
    }))).toBe("rolled back");
    expect((await labels()).task).toBe("t2");
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.bindings.setMeta(kept, fe, { task: "t4" }))).toContain(SETTLED);
    expect((await labels()).task).toBe("t2");
    // The store audits nothing: the caller writes alias.meta_set from the diff.
    expect(await h.audits("alias.meta_set")).toEqual([]);
  });
}

function writes(it: It): void {
  it("log writes a binding event, and a repeated refusal within the window is one row with a count", async h => {
    const s1 = "id:0000000000001", s2 = "id:0000000000002", fe = `${B}/fe`, be = `${B}/be`;
    const log = (event: "bound" | "refused" | "released", detail: string | null, at: number) => h.write(tx => h.bindings.log(tx, s1, fe, event, detail, at));
    await log("refused", "held", 1000);
    // The same refusal by another session for the name, or by the session for another name, is its own row.
    await h.write(tx => h.bindings.log(tx, s2, fe, "refused", "held", 1001));
    await h.write(tx => h.bindings.log(tx, s1, be, "refused", "held", 1002));
    await log("refused", "held", 1000 + REFUSED_COALESCE_MS);
    // The window runs from the row's last stamp.
    await log("refused", "held", 1000 + 2 * REFUSED_COALESCE_MS);
    await log("refused", "other", 1000 + 2 * REFUSED_COALESCE_MS);
    await log("refused", "other", 1000 + 3 * REFUSED_COALESCE_MS + 1);
    await log("bound", null, 9_000_000);
    await log("refused", "other", 9_000_001);
    expect(await h.events()).toEqual([
      { session_id: s1, name: fe, event: "refused", at: 1000, detail: "held", count: 3, last_at: 1000 + 2 * REFUSED_COALESCE_MS },
      { session_id: s2, name: fe, event: "refused", at: 1001, detail: "held", count: null, last_at: null },
      { session_id: s1, name: be, event: "refused", at: 1002, detail: "held", count: null, last_at: null },
      { session_id: s1, name: fe, event: "refused", at: 1000 + 2 * REFUSED_COALESCE_MS, detail: "other", count: null, last_at: null },
      { session_id: s1, name: fe, event: "refused", at: 1000 + 3 * REFUSED_COALESCE_MS + 1, detail: "other", count: null, last_at: null },
      { session_id: s1, name: fe, event: "bound", at: 9_000_000, detail: null, count: null, last_at: null },
      { session_id: s1, name: fe, event: "refused", at: 9_000_001, detail: "other", count: null, last_at: null },
    ]);
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.bindings.log(kept, s1, fe, "bound", null, 1))).toContain(SETTLED);
    expect(await h.events()).toHaveLength(7);
  });

  it("presence, facts, place, status and queue participation write on the body's Tx", async h => {
    const b = h.bindings;
    const [s1, s2] = ["id:0000000000001", "id:0000000000002"];
    const [fe, free] = [await h.alias(B, "fe"), await h.alias(B, "free")];
    await register(h, { id: s1, principal: B, launcher: false, model: "m", effort: "e" });
    await register(h, { id: s2, principal: B, launcher: false });
    await take(h, fe, s1, B, 10);
    await h.write(async tx => {
      await b.touchAlias(tx, fe, 100);
      await b.touchId(tx, s1, 200);
      // A touch of an address that isn't an alias is left alone.
      await b.touchAlias(tx, `${B}/none`, 300);
      expect(await b.lastSeen(tx, [fe, s1, `${B}/none`])).toEqual(new Map([[fe, 100], [s1, 200]]));
    });
    // setIdFacts: the named facts, cleaned; null when nothing changed or no row.
    expect(await h.write(tx => b.setIdFacts(tx, s1, { model: "m" }))).toBeNull();
    expect(await h.write(tx => b.setIdFacts(tx, s1, {}))).toBeNull();
    expect(await h.write(tx => b.setIdFacts(tx, s1, { model: " m2​ " }))).toEqual({ before: { model: "m", effort: "e" }, after: { model: "m2", effort: "e" } });
    expect(await h.write(tx => b.setIdFacts(tx, s1, { effort: null }))).toEqual({ before: { model: "m2", effort: "e" }, after: { model: "m2", effort: null } });
    expect(await h.write(tx => b.setIdFacts(tx, "id:000000000000Z", { model: "x" }))).toBeNull();
    expect((await b.idFacts(h.read, [s1])).get(s1)).toMatchObject({ model: "m2", effort: null });
    // setPlace cleans; null clears.
    await h.write(tx => b.setPlace(tx, s1, "host\u0007 /repo"));
    expect((await b.idRow(h.read, s1))?.place).toBe("host /repo");
    await h.write(tx => b.setPlace(tx, s1, null));
    expect((await b.idRow(h.read, s1))?.place).toBeNull();
    // setStatus by ID and by a held alias (touching it); a free alias or an ended ID sets nothing; empty clears.
    expect(await h.write(tx => b.setStatus(tx, s2, "busy", 400))).toBe(true);
    expect(await h.write(tx => b.setStatus(tx, fe, "on it", 500))).toBe(true);
    expect(await b.lastSeen(h.read, [fe])).toEqual(new Map([[fe, 500]]));
    expect(await b.idStatuses(h.read, [s1, s2])).toEqual(new Map([[s1, { status: "on it", status_at: 500 }], [s2, { status: "busy", status_at: 400 }]]));
    expect(await h.write(tx => b.setStatus(tx, free, "x", 600))).toBe(false);
    await h.end(s2, 700);
    expect(await h.write(tx => b.setStatus(tx, s2, "late", 800))).toBe(false);
    expect(await h.write(tx => b.setStatus(tx, s1, "", 900))).toBe(true);
    expect(await b.idStatuses(h.read, [s1, s2])).toEqual(new Map([[s2, { status: "busy", status_at: 400 }]]));
    // Queue participation: off then on again, on the alias row (touching it at the wall clock).
    await h.write(tx => b.setQueueParticipation(tx, fe, false));
    expect((await h.aliasRow(fe))?.queue_off).toBe(true);
    await h.write(tx => b.setQueueParticipation(tx, fe, true));
    expect((await h.aliasRow(fe))?.queue_off).toBe(false);
    // A settled Tx is refused for each write, which changes nothing.
    const seen = await b.lastSeen(h.read, [fe, s1]);
    const kept = await h.write(async tx => tx);
    for (const write of [
      () => b.touchAlias(kept, fe, 1), () => b.touchId(kept, s1, 1), () => b.setIdFacts(kept, s1, { model: "z" }),
      () => b.setPlace(kept, s1, "z"), () => b.setStatus(kept, s1, "z", 1), () => b.setQueueParticipation(kept, fe, false),
    ]) expect(await failure(write)).toContain(SETTLED);
    expect(await b.lastSeen(h.read, [fe, s1])).toEqual(seen);
    expect((await h.aliasRow(fe))?.queue_off).toBe(false);
    expect(await b.idRow(h.read, s1)).toMatchObject({ place: null });
  });
}
