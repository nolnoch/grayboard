// The aliases store's contract (#807 P3 C5, docs/future/postgres-server.md D9): every AliasesStore method and the scope
// cap's refusal over it (alias_cap.ts), written once over a harness so both stores run the same rows. Not a *.test.ts
// file, so Bun doesn't discover it: a backend's test file registers it under a describe() (aliases.contract.sqlite.ts
// through db.test.ts for SQLite, pg/aliases.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids are compared to the rows the row itself made.
// - Every time is a fixed epoch set on the store's clock (setNow); nothing reads a wall clock an answer depends on.
// - The rows are serial. An interleaving (two creators at a scope's last slot, a delete racing a bind's take) is a
//   backend's own test: Postgres runs them on two connections (C5b's pg/aliases.pg.test.ts). So dropping a lock passes
//   here on every backend; what these rows pin is each method's serial answer, and that the cap's refusal takes the
//   scope lock before it counts and looks the name up again after it.
// - Fixture writes the store doesn't offer (a session's ids row, a hold, a binding event, a read point, a last_seen)
//   and the raw reads are the harness's, so no row touches a connection.
import { expect, test } from "bun:test";
import { aliasCapRefusal } from "../alias_cap.ts";
import type { AliasesStore, AliasTarget } from "./aliases.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type AliasesHarness = {
  aliases: AliasesStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // The store's clock, for the rows it stamps (created_at).
  setNow(ms: number): void;
  // Fixture writes, each in its own transaction: a session's ids row; a hold (alias_holds); a `bound` binding event; a
  // direct read point (mailbox_cursors, stream_ref = the address unless given); an alias's last_seen.
  session(id: string, facts: { cwd?: string | null; place?: string | null; endedAt?: number | null }): Promise<void>;
  hold(address: string, id: string): Promise<void>;
  bound(address: string, id: string, at: number): Promise<void>;
  cursor(address: string, lastSeenId: number, streamRef?: string): Promise<void>;
  touch(address: string, at: number): Promise<void>;
  // Raw reads, any order: every aliases row's address and creator; every read point's address and stream_ref.
  aliasRows(): Promise<{ address: string; created_by_principal: string | null }[]>;
  cursorRows(): Promise<{ address: string; stream_ref: string }[]>;
  close(): void | Promise<void>;
};

export type AliasesBackend = { kind: "sqlite" | "postgres"; open(): Promise<AliasesHarness> };

const T0 = 1_800_000_000_000;
const ME = "you@example.com", THEM = "them@example.com";
const person = (ref: string, name: string): AliasTarget => ({ scope_kind: "person", scope_ref: ref, name });
const team = (ref: string, name: string): AliasTarget => ({ scope_kind: "team", scope_ref: ref, name });

export function aliasesContract(backend: AliasesBackend): void {
  const it = (name: string, fn: (h: AliasesHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    h.setNow(T0);
    try { await fn(h); } finally { await h.close(); }
  });
  rowsAndReads(it);
  marksAndLocks(it);
  cap(it);
}

type It = (name: string, fn: (h: AliasesHarness) => Promise<void>) => void;

const create = (h: AliasesHarness, t: AliasTarget, by = t.scope_kind === "person" ? t.scope_ref : ME) => h.write(tx => h.aliases.create(tx, t, by));

function rowsAndReads(it: It): void {
  // A1.
  it("create returns the row, at address scope_ref/name, with numeric id and created_at; find finds it", async h => {
    h.setNow(T0 + 5);
    const fe = await create(h, person(ME, "fe"));
    expect(fe).toEqual({ id: expect.any(Number), address: `${ME}/fe`, scope_kind: "person", scope_ref: ME, name: "fe", created_at: T0 + 5 });
    expect(typeof fe!.id).toBe("number");
    expect(await h.aliases.find(h.read, `${ME}/fe`)).toEqual(fe!);
    expect(await h.aliases.find(h.read, `${ME}/be`)).toBeUndefined();
    // Read inside the body that wrote it, on its Tx.
    await h.write(async tx => {
      const be = await h.aliases.create(tx, person(ME, "be"), ME);
      expect(await h.aliases.find(tx, `${ME}/be`)).toEqual(be!);
    });
    // A team scope's alias is its own address.
    expect(await create(h, team("eng", "be"))).toMatchObject({ address: "eng/be", scope_kind: "team", scope_ref: "eng", name: "be" });
  });

  // A2.
  it("create of an existing address returns null, writes nothing, and the body goes on to commit", async h => {
    const fe = await create(h, person(ME, "fe"));
    h.setNow(T0 + 9);
    const out = await h.write(async tx => {
      const again = await h.aliases.create(tx, person(ME, "fe"), "other@example.com");
      // The body is still usable after the refused insert: a later write in it commits.
      const be = await h.aliases.create(tx, person(ME, "be"), ME);
      return { again, be };
    });
    expect(out.again).toBeNull();
    expect(out.be?.address).toBe(`${ME}/be`);
    expect(await h.aliases.find(h.read, `${ME}/fe`)).toEqual(fe!);
    expect((await h.aliasRows()).sort((a, b) => a.address < b.address ? -1 : 1)).toEqual([
      { address: `${ME}/be`, created_by_principal: ME },
      { address: `${ME}/fe`, created_by_principal: ME },
    ]);
  });

  // A3.
  it("listForScope lists one scope's names in byte order", async h => {
    for (const n of ["a_b", "aB", "A"]) await create(h, person(ME, n));
    await create(h, person(THEM, "zz"));
    await create(h, team(ME, "tt"));
    expect((await h.aliases.listForScope(h.read, "person", ME)).map(a => a.name)).toEqual(["A", "aB", "a_b"]);
    expect((await h.aliases.listForScope(h.read, "team", ME)).map(a => a.address)).toEqual([`${ME}/tt`]);
    expect(await h.aliases.listForScope(h.read, "person", "nobody@example.com")).toEqual([]);
  });

  // A4.
  it("countForScope counts every name in the scope but the Slack human, as a number", async h => {
    expect(await h.aliases.countForScope(h.read, "person", ME)).toBe(0);
    for (const n of ["fe", "be", "human"]) await create(h, person(ME, n));
    await create(h, person(THEM, "fe"));
    await create(h, team(ME, "fe"));
    const n = await h.aliases.countForScope(h.read, "person", ME);
    expect(n).toBe(2);
    expect(typeof n).toBe("number");
  });

  // A5.
  it("findAllByName returns every scope's alias of the name, by address", async h => {
    await create(h, person(ME, "be"));
    await create(h, team("eng", "be"));
    await create(h, person(THEM, "be"));
    await create(h, person(THEM, "fe"));
    expect((await h.aliases.findAllByName(h.read, "be")).map(a => a.address)).toEqual(["eng/be", `${THEM}/be`, `${ME}/be`]);
    expect(await h.aliases.findAllByName(h.read, "none")).toEqual([]);
  });

  // A6.
  it("seen reports last_seen and the holding, or last ended binding, session's place; unused and unknown addresses are absent", async h => {
    for (const n of ["held", "ended", "live", "unused"]) await create(h, person(ME, n));
    await h.session("s-held", { cwd: "/w/held", place: "box-1" });
    await h.session("s-ended", { cwd: "/w/ended", place: "box-2", endedAt: T0 + 50 });
    await h.session("s-live", { cwd: "/w/live", place: "box-3" });
    await h.hold(`${ME}/held`, "s-held");
    await h.bound(`${ME}/ended`, "s-held", T0 + 1);
    await h.bound(`${ME}/ended`, "s-ended", T0 + 2);
    // A binding by a session that hasn't ended, with no hold, names no session.
    await h.bound(`${ME}/live`, "s-live", T0 + 3);
    await h.touch(`${ME}/held`, T0 + 10);
    await h.touch(`${ME}/ended`, T0 + 20);
    await h.touch(`${ME}/live`, T0 + 30);
    const seen = await h.aliases.seen(h.read, [`${ME}/held`, `${ME}/ended`, `${ME}/live`, `${ME}/unused`, `${ME}/nobody`]);
    expect(seen).toEqual(new Map([
      [`${ME}/held`, { last_seen: T0 + 10, cwd: "/w/held", place: "box-1" }],
      [`${ME}/ended`, { last_seen: T0 + 20, cwd: "/w/ended", place: "box-2" }],
      [`${ME}/live`, { last_seen: T0 + 30, cwd: null, place: null }],
    ]));
    expect(await h.aliases.seen(h.read, [])).toEqual(new Map());
  });

  // A7.
  it("remove deletes the alias and its read points, and nothing else", async h => {
    await create(h, person(ME, "fe"));
    await create(h, person(ME, "be"));
    await h.cursor(`${ME}/fe`, 7);
    await h.cursor(`${ME}/fe`, 3, "eng");
    await h.cursor(`${ME}/be`, 4);
    await h.write(tx => h.aliases.remove(tx, `${ME}/fe`));
    expect(await h.aliases.find(h.read, `${ME}/fe`)).toBeUndefined();
    expect((await h.aliasRows()).map(r => r.address)).toEqual([`${ME}/be`]);
    expect(await h.cursorRows()).toEqual([{ address: `${ME}/be`, stream_ref: `${ME}/be` }]);
    // A new alias of the name starts from scratch.
    expect(await create(h, person(ME, "fe"))).not.toBeNull();
    // Removing what isn't there is a no-op.
    await h.write(tx => h.aliases.remove(tx, `${ME}/none`));
  });

  // A9.
  it("scopesOf returns each address's scope columns; an address with no row is absent", async h => {
    await create(h, person(ME, "fe"));
    await create(h, team("eng", "be"));
    expect(await h.aliases.scopesOf(h.read, [`${ME}/fe`, "eng/be", "eng/none", `${ME}/fe`])).toEqual(new Map([
      [`${ME}/fe`, { scope_kind: "person", scope_ref: ME }],
      ["eng/be", { scope_kind: "team", scope_ref: "eng" }],
    ]));
    expect(await h.aliases.scopesOf(h.read, [])).toEqual(new Map());
  });
}

function marksAndLocks(it: It): void {
  // A8.
  it("markHuman sets and clears the mark: isHuman and humansAmong follow, and last_seen is touched", async h => {
    await create(h, person(ME, "human"));
    await create(h, person(THEM, "human"));
    const mine = `${ME}/human`, theirs = `${THEM}/human`;
    expect(await h.aliases.isHuman(h.read, mine)).toBe(false);
    expect((await h.aliases.seen(h.read, [mine])).has(mine)).toBe(false);
    await h.write(async tx => {
      await h.aliases.markHuman(tx, mine, true);
      await h.aliases.markHuman(tx, theirs, true);
    });
    expect(await h.aliases.isHuman(h.read, mine)).toBe(true);
    expect((await h.aliases.seen(h.read, [mine])).has(mine)).toBe(true);
    expect(await h.aliases.humansAmong(h.read, [mine, theirs, `${ME}/none`, mine])).toEqual(new Set([mine, theirs]));
    await h.write(tx => h.aliases.markHuman(tx, mine, false));
    expect(await h.aliases.isHuman(h.read, mine)).toBe(false);
    expect(await h.aliases.humansAmong(h.read, [mine, theirs])).toEqual(new Set([theirs]));
    expect(await h.aliases.humansAmong(h.read, [])).toEqual(new Set());
    expect(await h.aliases.isHuman(h.read, `${ME}/none`)).toBe(false);
  });

  // A10.
  it("lock returns the row as find does, in either mode, and undefined once it's gone in the same body", async h => {
    const fe = await create(h, person(ME, "fe"));
    await h.write(async tx => {
      expect(await h.aliases.lock(tx, `${ME}/fe`, "use")).toEqual(fe!);
      expect(await h.aliases.lock(tx, `${ME}/fe`, "delete")).toEqual(fe!);
      expect(await h.aliases.lock(tx, `${ME}/none`, "delete")).toBeUndefined();
      await h.aliases.remove(tx, `${ME}/fe`);
      expect(await h.aliases.lock(tx, `${ME}/fe`, "delete")).toBeUndefined();
      // Made again in the body: the new row, not the one locked before.
      const again = await h.aliases.create(tx, person(ME, "fe"), ME);
      expect(again!.id).not.toBe(fe!.id);
      expect(await h.aliases.lock(tx, `${ME}/fe`, "use")).toEqual(again!);
    });
  });

  // A11.
  it("lockScope, then countForScope in one body, counts that body's own creates", async h => {
    await create(h, person(ME, "fe"));
    await h.write(async tx => {
      await h.aliases.lockScope(tx, { scope_kind: "person", scope_ref: ME });
      await h.aliases.create(tx, person(ME, "be"), ME);
      expect(await h.aliases.countForScope(tx, "person", ME)).toBe(2);
      // A second take of the same scope's lock in one body doesn't block it.
      await h.aliases.lockScope(tx, { scope_kind: "person", scope_ref: ME });
      await h.aliases.lockScope(tx, { scope_kind: "team", scope_ref: ME });
      await h.aliases.create(tx, person(ME, "qa"), ME);
      expect(await h.aliases.countForScope(tx, "person", ME)).toBe(3);
    });
  });
}

function cap(it: It): void {
  it("aliasCapRefusal refuses a new name at the cap, naming the way to free one; under it, or the human, it allows", async h => {
    const refusal = (t: AliasTarget, n: number) => h.write(tx => aliasCapRefusal(h.aliases, tx, t, n));
    await create(h, person(ME, "fe"));
    await create(h, person(ME, "human"));
    expect(await refusal(person(ME, "be"), 2)).toBeNull();
    expect(await refusal(person(ME, "be"), 1)).toBe("your scope already has 1 names, the server's cap of 1; bind an existing name, or free one with grayboard identity rm <name>");
    await create(h, team("eng", "a"));
    expect(await refusal(team("eng", "b"), 1)).toBe(`team "eng" already has 1 names, the server's cap of 1; bind an existing name, or a team owner frees one with grayboard team delete-alias eng <name>`);
    await create(h, { scope_kind: "service", scope_ref: "svc", name: "a" });
    expect(await refusal({ scope_kind: "service", scope_ref: "svc", name: "b" }, 1)).toBe(`service "svc" already has 1 names, the server's cap of 1; bind an existing name, or an admin frees one with grayboard admin service delete-alias svc <name>`);
  });

  // The serial half of T-C5-2: a creator whose pre-check missed a name a same-name creator then committed finds it
  // after the scope lock, and binds it as an existing name instead of being capped.
  it("aliasCapRefusal allows a name that exists, at or past the cap: it looks the name up after the scope lock", async h => {
    await create(h, person(ME, "fe"));
    await create(h, person(ME, "be"));
    expect(await h.write(tx => aliasCapRefusal(h.aliases, tx, person(ME, "fe"), 2))).toBeNull();
    expect(await h.write(tx => aliasCapRefusal(h.aliases, tx, person(ME, "fe"), 1))).toBeNull();
    expect(await h.write(tx => aliasCapRefusal(h.aliases, tx, person(ME, "qa"), 2))).not.toBeNull();
  });

  // Decision 1: the lock comes first, on the body's Tx, then the re-find and the count on that same Tx.
  it("aliasCapRefusal takes the scope's lock on the body's Tx before it looks up or counts", async h => {
    await create(h, team("eng", "a"));
    const calls: string[] = [];
    const spy: Pick<AliasesStore, "lockScope" | "find" | "countForScope"> = {
      lockScope: async (tx, scope) => { calls.push(`lockScope:${scope.scope_kind}:${scope.scope_ref}:${tx === seen ? "tx" : "other"}`); return h.aliases.lockScope(tx, scope); },
      find: async (r, address) => { calls.push(`find:${address}:${r === seen ? "tx" : "other"}`); return h.aliases.find(r, address); },
      countForScope: async (r, kind, ref) => { calls.push(`count:${kind}:${ref}:${r === seen ? "tx" : "other"}`); return h.aliases.countForScope(r, kind, ref); },
    };
    let seen: Tx | undefined;
    await h.write(async tx => { seen = tx; return aliasCapRefusal(spy, tx, team("eng", "b"), 5); });
    expect(calls).toEqual(["lockScope:team:eng:tx", "find:eng/b:tx", "count:team:eng:tx"]);
  });
}
