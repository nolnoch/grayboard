// The session end store's contract (#807 P3 C10d1, docs/future/postgres-server.md D9): SessionEndStore's refusal and
// pruneEnded, and end's row step (#807 P3 C10d2-b), written once over a harness so both stores run the same rows (the
// composed end's are server/session_end.test.ts's and session_end.pg.test.ts's). Not a *.test.ts file, so Bun doesn't discover it: a backend's test
// file registers it under a describe() (session_end.contract.sqlite.ts through db.test.ts for SQLite,
// pg/session_end.contract.pg.test.ts for Postgres). The harness also serves the delegation contract
// (delegation.contract.ts): both groups read the same ids, aliases and holds.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: message ids are the ones the row's fixtures returned.
// - Every time is a fixed epoch passed in; neither group reads a clock.
// - The rows are serial. An interleaving (a send's refusal against an end's lock or a presence touch, a prune against a
//   send, two delegations at a launcher's cap-1) is Postgres's own test (pg/session_end.pg.test.ts): on SQLite the
//   single writer runs no two at once. What these rows pin is each statement's serial answer.
// - Fixture writes the stores don't offer (ids rows with their flags, aliases, holds, binding events, messages, acks,
//   delegation.requested audit rows, tombstones) and the raw reads are the harness's, so no row touches a connection.
import { expect, test } from "bun:test";
import { TOMBSTONE_HORIZON_MS } from "../../core/boards.ts";
import { Undeliverable } from "../../core/undeliverable.ts";
import type { DelegationStore } from "./delegation.ts";
import type { SessionEndStore } from "./session_end.ts";
import type { Read, Tx } from "./tx_base.ts";

// An ids row's columns as a fixture sets them; unset ones take the schema's defaults (a live, push-delivered,
// unkeyed root session with no principal and no launcher flag).
export type SessionFixture = {
  principal?: string | null; launcher?: boolean | null; viewer?: boolean; keyed?: boolean; delivery?: string;
  writesAs?: string | null; rootId?: string | null; endedAt?: number | null; held?: string[] | null;
};

// One store, fresh per row.
export type IdsHarness = {
  sessionEnd: SessionEndStore;
  delegation: DelegationStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: an ids row; an aliases row (`scope/name`, person scope); a hold; a
  // `bound` binding event; a direct message (returns its id); an ack; a delegation.requested access_log row naming a
  // message id; a pruned_ids tombstone.
  session(id: string, f?: SessionFixture): Promise<void>;
  alias(address: string, f?: { human?: boolean | null; lastSeen?: number | null }): Promise<void>;
  hold(address: string, id: string, boundAt: number): Promise<void>;
  bound(address: string, id: string, at: number): Promise<void>;
  message(sender: string, recipient: string, parentId?: number | null): Promise<number>;
  ack(reader: string, messageId: number): Promise<void>;
  requested(target: string, at: number, messageId: number): Promise<void>;
  tombstone(id: string, endedAt: number, prunedAt: number): Promise<void>;
  // Raw reads: every ids row's id, and every tombstone, by id.
  idRows(): Promise<string[]>;
  prunedRows(): Promise<{ id: string; ended_at: number; pruned_at: number }[]>;
  close(): void | Promise<void>;
};

export type IdsBackend = { kind: "sqlite" | "postgres"; open(): Promise<IdsHarness> };

export const T0 = 1_800_000_000_000;
const id = (n: number) => `id:${String(n).padStart(13, "0")}`;
export const ids = { s1: id(1), s2: id(2), s3: id(3), s4: id(4), s5: id(5), s6: id(6), s7: id(7), s8: id(8), s9: id(9) };
export const SETTLED = /used after its transaction settled/;
export const FOREIGN = /not a (SQLite|Postgres) store handle/;

export function idsRow(backend: IdsBackend) {
  return (name: string, fn: (h: IdsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
}

export function sessionEndContract(backend: IdsBackend): void {
  const it = idsRow(backend);
  refusal(it);
  prune(it);
  end(it);
}

type It = ReturnType<typeof idsRow>;

const refusalOf = (h: IdsHarness, of: string) => h.write(tx => h.sessionEnd.refusal(tx, of));
const iso = (ms: number) => new Date(ms).toISOString();

function refusal(it: It): void {
  it("refusal: null for a live push-delivered root ID; not_found for no row and for a viewer", async h => {
    const { s1, s2, s3 } = ids;
    await h.session(s1, { principal: "you@example.com" });
    await h.session(s2, { viewer: true });
    expect(await refusalOf(h, s1)).toBeNull();
    for (const [of, detail] of [[s2, `no session ${s2}`], [s3, `no session ${s3}`]] as const) {
      const why = await refusalOf(h, of);
      expect(why).toBeInstanceOf(Undeliverable);
      expect([why!.code, why!.detail, why!.message]).toEqual(["not_found", detail, `not_found: ${detail}`]);
    }
  });

  it("refusal: id_ended names the end time and what the ID held, or that it held none", async h => {
    const { s1, s2 } = ids;
    await h.session(s1, { endedAt: T0, held: ["you@example.com/be", "you@example.com/fe"] });
    await h.session(s2, { endedAt: T0 + 1 });
    const a = await refusalOf(h, s1), b = await refusalOf(h, s2);
    expect([a!.code, a!.detail]).toEqual(["id_ended", `${s1} ended at ${iso(T0)}; it held \`you@example.com/be\`, \`you@example.com/fe\``]);
    expect([b!.code, b!.detail]).toEqual(["id_ended", `${s2} ended at ${iso(T0 + 1)}; it held no alias`]);
  });

  it("refusal: no_delivery for a tools-only ID, naming the alias it writes as when it has one", async h => {
    const { s1, s2 } = ids;
    await h.session(s1, { delivery: "none", writesAs: "you@example.com/be" });
    await h.session(s2, { delivery: "none" });
    expect((await refusalOf(h, s1))!.detail).toBe(`${s1} is a tools-only session and receives nothing; send to you@example.com/be`);
    expect((await refusalOf(h, s2))!.detail).toBe(`${s2} is a tools-only session and receives nothing`);
    expect((await refusalOf(h, s2))!.code).toBe("no_delivery");
  });

  it("refusal: child_session names its root's primary: oldest hold, else writes_as, else (ended) its first held alias, else the root's ID", async h => {
    const { s1, s2, s3, s4, s5, s6, s7, s8, s9 } = ids;
    const child = (c: string, root: string) => h.session(c, { rootId: root });
    // s1 holds three aliases: the oldest holds win over a lower address, and the address breaks their tie.
    await h.session(s1);
    await h.hold("you@example.com/aa", s1, 100);
    await h.hold("you@example.com/qb", s1, 50);
    await h.hold("you@example.com/qa", s1, 50);
    await child(s2, s1);
    // s3 holds nothing and writes as an alias; s5 ended holding two; s7 is bare.
    await h.session(s3, { delivery: "none", writesAs: "you@example.com/ops" });
    await child(s4, s3);
    await h.session(s5, { endedAt: T0, held: ["you@example.com/old", "you@example.com/older"] });
    await child(s6, s5);
    await h.session(s7);
    await child(s8, s7);
    const text = (c: string, root: string, to: string) => `${c} is a subagent acting under session ${root} and receives nothing; send to ${to}`;
    expect([(await refusalOf(h, s2))!.code, (await refusalOf(h, s2))!.detail]).toEqual(["child_session", text(s2, s1, "you@example.com/qa")]);
    expect((await refusalOf(h, s4))!.detail).toBe(text(s4, s3, "you@example.com/ops"));
    expect((await refusalOf(h, s6))!.detail).toBe(text(s6, s5, "you@example.com/old"));
    expect((await refusalOf(h, s8))!.detail).toBe(text(s8, s7, s7));
    // A child whose root row is gone names the root's ID; an ended child is still a child; a viewer reads as no session.
    await child(s9, "id:0000000000099");
    expect((await refusalOf(h, s9))!.detail).toBe(text(s9, "id:0000000000099", "id:0000000000099"));
    await h.session("id:0000000000010", { rootId: s1, endedAt: T0 });
    expect((await refusalOf(h, "id:0000000000010"))!.code).toBe("child_session");
    await h.session("id:0000000000011", { rootId: s1, viewer: true });
    expect((await refusalOf(h, "id:0000000000011"))!.code).toBe("not_found");
  });

  it("refusal, pruneEnded and end refuse a settled Tx and another backend's handle", async h => {
    await h.session(ids.s1);
    const kept = await h.write(async tx => tx);
    await expect(h.sessionEnd.refusal(kept, ids.s1)).rejects.toThrow(SETTLED);
    await expect(h.sessionEnd.pruneEnded(kept, 1, 1)).rejects.toThrow(SETTLED);
    await expect(h.sessionEnd.end(kept, ids.s1, 1)).rejects.toThrow(SETTLED);
    await expect(h.sessionEnd.refusal({} as Tx, ids.s1)).rejects.toThrow(FOREIGN);
    await expect(h.sessionEnd.end({} as Tx, ids.s1, 1)).rejects.toThrow(FOREIGN);
    await expect(h.sessionEnd.pruneEnded({} as Tx, 1, 1)).rejects.toThrow(FOREIGN);
  });
}

function prune(it: It): void {
  it("pruneEnded deletes the rows ended before the cutoff, tombstones the keyed ones at `now`, and counts the deletes", async h => {
    const { s1, s2, s3, s4, s5 } = ids;
    await h.session(s1, { keyed: true, endedAt: T0 - 10 });
    await h.session(s2, { endedAt: T0 - 5 });
    // Ended at the cutoff, ended after it, and live: kept.
    await h.session(s3, { keyed: true, endedAt: T0 });
    await h.session(s4, { keyed: true, endedAt: T0 + 1 });
    await h.session(s5, { keyed: true });
    expect(await h.write(tx => h.sessionEnd.pruneEnded(tx, T0, T0 + 100))).toBe(2);
    expect(await h.idRows()).toEqual([s3, s4, s5]);
    // The unkeyed s2 leaves none.
    expect(await h.prunedRows()).toEqual([{ id: s1, ended_at: T0 - 10, pruned_at: T0 + 100 }]);
    expect(await h.write(tx => h.sessionEnd.pruneEnded(tx, T0, T0 + 200))).toBe(0);
    expect(await h.prunedRows()).toEqual([{ id: s1, ended_at: T0 - 10, pruned_at: T0 + 100 }]);
  });

  it("pruneEnded replaces a keyed ID's earlier tombstone with its later end and this prune's time", async h => {
    // The key came back after its first prune (registerId took its tombstone, or another left one), and ended again.
    await h.tombstone(ids.s1, T0 - 1000, T0 - 900);
    await h.session(ids.s1, { keyed: true, endedAt: T0 - 10 });
    expect(await h.write(tx => h.sessionEnd.pruneEnded(tx, T0, T0 + 100))).toBe(1);
    expect(await h.prunedRows()).toEqual([{ id: ids.s1, ended_at: T0 - 10, pruned_at: T0 + 100 }]);
  });

  it("pruneEnded drops tombstones older than the horizon and keeps one at it", async h => {
    const now = T0 + 100;
    await h.tombstone(ids.s1, 1, now - TOMBSTONE_HORIZON_MS - 1);
    await h.tombstone(ids.s2, 1, now - TOMBSTONE_HORIZON_MS);
    await h.tombstone(ids.s3, 1, now);
    expect(await h.write(tx => h.sessionEnd.pruneEnded(tx, T0, now))).toBe(0);
    expect((await h.prunedRows()).map(r => r.id)).toEqual([ids.s2, ids.s3]);
  });

  it("pruneEnded rolls back with its body; a refusal inside the body reads the body's prune", async h => {
    await h.session(ids.s1, { keyed: true, endedAt: T0 - 10 });
    await expect(h.write(async tx => {
      expect(await h.sessionEnd.pruneEnded(tx, T0, T0 + 100)).toBe(1);
      expect((await h.sessionEnd.refusal(tx, ids.s1))!.code).toBe("not_found");
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect(await h.idRows()).toEqual([ids.s1]);
    expect(await h.prunedRows()).toEqual([]);
    expect((await refusalOf(h, ids.s1))!.code).toBe("id_ended");
  });
}

function end(it: It): void {
  it("end: marks the ID ended with what it held (oldest hold first, as refusal reads it back), and returns its principal, holds and unended children by id", async h => {
    const { s1, s2, s3, s4, s5 } = ids;
    await h.session(s1, { principal: "you@example.com" });
    await h.hold("you@example.com/fe", s1, 20);
    await h.hold("you@example.com/be", s1, 10);
    // s3 and s2 live children (returned by id), s4 an ended one, s5 another root's.
    await h.session(s3, { rootId: s1 });
    await h.session(s2, { rootId: s1 });
    await h.session(s4, { rootId: s1, endedAt: T0 - 1 });
    await h.session(s5, { rootId: s2 });
    expect(await h.write(tx => h.sessionEnd.end(tx, s1, T0))).toEqual({ principal: "you@example.com", held: ["you@example.com/be", "you@example.com/fe"], children: [s2, s3] });
    const why = await refusalOf(h, s1);
    expect([why!.code, why!.detail]).toEqual(["id_ended", `${s1} ended at ${iso(T0)}; it held \`you@example.com/be\`, \`you@example.com/fe\``]);
    // The holds stay: releasing them is the composed end's (bindings.release).
    expect((await refusalOf(h, s2))!.code).toBe("child_session");
  });

  it("end: a second end returns null and changes nothing; an ID with no row returns principal null, nothing held", async h => {
    const { s1, s2 } = ids;
    await h.session(s1);
    expect(await h.write(tx => h.sessionEnd.end(tx, s1, T0))).toEqual({ principal: null, held: [], children: [] });
    expect(await h.write(tx => h.sessionEnd.end(tx, s1, T0 + 5))).toBeNull();
    expect((await refusalOf(h, s1))!.detail).toBe(`${s1} ended at ${iso(T0)}; it held no alias`);
    expect(await h.write(tx => h.sessionEnd.end(tx, s2, T0))).toEqual({ principal: null, held: [], children: [] });
    expect(await h.idRows()).toEqual([s1]);
  });

  it("end rolls back with its body", async h => {
    await h.session(ids.s1);
    await expect(h.write(async tx => {
      expect(await h.sessionEnd.end(tx, ids.s1, T0)).not.toBeNull();
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect(await refusalOf(h, ids.s1)).toBeNull();
  });
}
