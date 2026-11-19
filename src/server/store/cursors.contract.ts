// The read points' contract (#807 P3 C6, docs/future/postgres-server.md D9): every CursorsStore method, written once
// over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test
// file registers it under a describe() (cursors.contract.sqlite.ts through db.test.ts for SQLite,
// pg/cursors.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store; ids are plain numbers the row picks (a read point names no row).
// - The rows are serial. Two concurrent advances are a backend's own test: Postgres runs them on two connections
//   (C67b's pg/cursors.pg.test.ts), where a read-then-write regresses or fails on a first insert. What these rows pin
//   is each method's serial answer: a read point is a number and only moves forward.
// - A refusal is compared by its text, thrown or rejected: a store may check its handle before or after its first await.
import { expect, test } from "bun:test";
import type { CursorsStore } from "./cursors.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type CursorsHarness = {
  cursors: CursorsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  close(): void | Promise<void>;
};

export type CursorsBackend = { kind: "sqlite" | "postgres"; open(): Promise<CursorsHarness> };

const A = "a@example.com/fe", B = "b@example.com/be";

// The message a call throws or rejects with, or "(no error)".
async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

export function cursorsContract(backend: CursorsBackend): void {
  const it = (name: string, fn: (h: CursorsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  const advance = (h: CursorsHarness, address: string, type: "direct" | "team", ref: string, id: number) =>
    h.write(tx => h.cursors.advance(tx, address, type, ref, id));

  // K1.
  it("get and directFor answer 0 for an absent read point, and a number after an advance", async h => {
    expect(await h.cursors.get(h.read, A, "direct", A)).toBe(0);
    expect(await h.cursors.directFor(h.read, A)).toBe(0);
    await advance(h, A, "direct", A, 7);
    const got = await h.cursors.get(h.read, A, "direct", A);
    expect(got).toBe(7);
    expect(typeof got).toBe("number");
    expect(typeof (await h.cursors.directFor(h.read, A))).toBe("number");
    // A comparison a caller makes (handleRetract's `directFor(…) >= m.id`) holds numerically, not as text.
    expect((await h.cursors.directFor(h.read, A)) >= 10).toBe(false);
  });

  // K2.
  it("advance only moves forward: 10, then 5 stays 10, then 20 is 20; a repeat changes nothing", async h => {
    await advance(h, A, "direct", A, 10);
    await advance(h, A, "direct", A, 5);
    expect(await h.cursors.get(h.read, A, "direct", A)).toBe(10);
    await advance(h, A, "direct", A, 10);
    expect(await h.cursors.directFor(h.read, A)).toBe(10);
    await advance(h, A, "direct", A, 20);
    expect(await h.cursors.directFor(h.read, A)).toBe(20);
    // Within one body too: the second statement sees the first.
    await h.write(async tx => { await h.cursors.advance(tx, A, "direct", A, 30); await h.cursors.advance(tx, A, "direct", A, 25); });
    expect(await h.cursors.directFor(h.read, A)).toBe(30);
  });

  // K3.
  it("each (address, stream type, stream ref) is its own read point; directFor reads only the address's own direct stream", async h => {
    await advance(h, A, "direct", A, 10);
    await advance(h, A, "team", "eng", 20);
    await advance(h, A, "team", "ops", 30);
    await advance(h, A, "direct", B, 40);
    await advance(h, B, "direct", B, 50);
    expect(await h.cursors.get(h.read, A, "direct", A)).toBe(10);
    expect(await h.cursors.get(h.read, A, "team", "eng")).toBe(20);
    expect(await h.cursors.get(h.read, A, "team", "ops")).toBe(30);
    expect(await h.cursors.get(h.read, A, "direct", B)).toBe(40);
    expect(await h.cursors.get(h.read, B, "direct", B)).toBe(50);
    expect(await h.cursors.get(h.read, B, "team", "eng")).toBe(0);
    expect(await h.cursors.get(h.read, A, "direct", "eng")).toBe(0);
    expect(await h.cursors.directFor(h.read, A)).toBe(10);
    expect(await h.cursors.directFor(h.read, B)).toBe(50);
  });

  // K4.
  it("the body's own Tx sees its uncommitted advance; a settled Tx is refused and writes nothing; a body that throws keeps none", async h => {
    const kept = await h.write(async tx => {
      await h.cursors.advance(tx, A, "direct", A, 3);
      expect(await h.cursors.get(tx, A, "direct", A)).toBe(3);
      expect(await h.cursors.directFor(tx, A)).toBe(3);
      return tx;
    });
    const settled = "Tx used after its transaction settled";
    expect(await failure(() => h.cursors.advance(kept, A, "direct", A, 9))).toContain(settled);
    expect(await failure(() => h.cursors.get(kept, A, "direct", A))).toContain(settled);
    expect(await failure(() => h.cursors.directFor(kept, A))).toContain(settled);
    expect(await h.cursors.directFor(h.read, A)).toBe(3);
    expect(await failure(() => h.write(async tx => { await h.cursors.advance(tx, A, "direct", A, 9); throw new Error("rolled back"); }))).toBe("rolled back");
    expect(await h.cursors.directFor(h.read, A)).toBe(3);
  });
}
