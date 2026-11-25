// The write receipts' contract (#807 P3 C6, docs/future/postgres-server.md D9): every WriteReceiptsStore method,
// written once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a
// backend's test file registers it under a describe() (write_receipts.contract.sqlite.ts through db.test.ts for SQLite,
// pg/write_receipts.contract.pg.test.ts for Postgres). src/server/write_dedup.test.ts tests dedupWrite over them.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: a receipt's ref is a row the row itself made.
// - Every time is a fixed epoch passed in; nothing reads a wall clock.
// - The rows are serial. Two identical claims, a reclaim race and a prune race are a backend's own test: Postgres runs
//   them on two connections (C67b's pg/write_receipts.pg.test.ts). What these rows pin is each method's serial answer.
// - Fixture writes the store doesn't offer (a message, a post, and deleting either) are the harness's.
// - A refusal is compared by its text, thrown or rejected.
import { expect, test } from "bun:test";
import type { Read, Tx } from "./tx_base.ts";
import type { WriteReceipt, WriteReceiptKey, WriteReceiptsStore } from "./write_receipts.ts";

// One store, fresh per row.
export type WriteReceiptsHarness = {
  writeReceipts: WriteReceiptsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: a direct message, or a board post, its id; deleting either by id.
  message(): Promise<number>;
  post(): Promise<number>;
  drop(kind: "message" | "post", id: number): Promise<void>;
  close(): void | Promise<void>;
};

export type WriteReceiptsBackend = { kind: "sqlite" | "postgres"; open(): Promise<WriteReceiptsHarness> };

const T0 = 1_800_000_000_000;
const S = "sess-1", A = "a@example.com/fe", FP = "fp-1";
const KEY: WriteReceiptKey = { session: S, sender: A, fp: FP };
const receipt = (over: Partial<WriteReceipt> = {}): WriteReceipt =>
  ({ ...KEY, tool: "dm_send", ref_kind: "message", ref_id: 1, result_json: '{"message_id":1}', at: T0, ...over });

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

export function writeReceiptsContract(backend: WriteReceiptsBackend): void {
  const it = (name: string, fn: (h: WriteReceiptsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  const w = (h: WriteReceiptsHarness) => h.writeReceipts;

  // W1.
  it("claim on an empty key takes it; find returns the placeholder with numeric ref_id 0, result_json '' and numeric at", async h => {
    expect(await h.write(tx => w(h).claim(tx, KEY, "dm_send", T0 + 5))).toBe(true);
    const found = await w(h).find(h.read, S, A, FP, 0);
    expect(found).toEqual({ ...KEY, tool: "dm_send", ref_kind: "message", ref_id: 0, result_json: "", at: T0 + 5 });
    expect(typeof found!.ref_id).toBe("number");
    expect(typeof found!.at).toBe("number");
    expect(await w(h).find(h.read, S, A, "other", 0)).toBeUndefined();
  });

  // W2.
  it("a second claim of one key is refused; another session, sender or fp claims", async h => {
    expect(await h.write(tx => w(h).claim(tx, KEY, "dm_send", T0))).toBe(true);
    expect(await h.write(tx => w(h).claim(tx, KEY, "board_post", T0 + 1))).toBe(false);
    // The refused claim changed nothing.
    expect(await w(h).find(h.read, S, A, FP, 0)).toMatchObject({ tool: "dm_send", at: T0 });
    for (const other of [{ ...KEY, session: "sess-2" }, { ...KEY, sender: "b@example.com/be" }, { ...KEY, fp: "fp-2" }]) {
      expect(await h.write(tx => w(h).claim(tx, other, "dm_send", T0))).toBe(true);
    }
    // In one body: the second claim sees the first.
    expect(await h.write(async tx => [await w(h).claim(tx, { ...KEY, fp: "fp-3" }, "dm_send", T0), await w(h).claim(tx, { ...KEY, fp: "fp-3" }, "dm_send", T0)])).toEqual([true, false]);
  });

  // W3.
  it("find is strict in at > since", async h => {
    await h.write(tx => w(h).upsert(tx, receipt({ at: T0 })));
    expect(await w(h).find(h.read, S, A, FP, T0 - 1)).toMatchObject({ at: T0 });
    expect(await w(h).find(h.read, S, A, FP, T0)).toBeUndefined();
    expect(await w(h).find(h.read, S, A, FP, T0 + 1)).toBeUndefined();
  });

  // W4.
  it("upsert replaces every column of the key's receipt; result_json reads back byte for byte", async h => {
    const first = receipt();
    await h.write(tx => w(h).upsert(tx, first));
    expect(await w(h).find(h.read, S, A, FP, 0)).toEqual(first);
    // Spacing, key order and escapes a JSON column would normalize.
    const json = '{ "z": 1,  "a": [1,2], "s": "\\u00e9" }';
    const second = receipt({ tool: "board_post", ref_kind: "post", ref_id: 42, result_json: json, at: T0 + 9 });
    await h.write(tx => w(h).upsert(tx, second));
    const found = await w(h).find(h.read, S, A, FP, 0);
    expect(found).toEqual(second);
    expect(found!.result_json).toBe(json);
    // A claim's placeholder filled in the same body.
    await h.write(async tx => {
      expect(await w(h).claim(tx, { ...KEY, fp: "fp-2" }, "dm_send", T0)).toBe(true);
      await w(h).upsert(tx, receipt({ fp: "fp-2", ref_id: 7, result_json: "{}", at: T0 }));
      expect(await w(h).find(tx, S, A, "fp-2", 0)).toMatchObject({ ref_id: 7, result_json: "{}" });
    });
  });

  // W5.
  it("reclaim takes a receipt only while it names the stale ref: it resets ref_id, result_json and at; otherwise false, changing nothing", async h => {
    await h.write(tx => w(h).upsert(tx, receipt({ ref_kind: "message", ref_id: 5, result_json: '{"message_id":5}', at: T0 })));
    // Another id, or the same id of the other kind, is not the stale ref.
    expect(await h.write(tx => w(h).reclaim(tx, KEY, { ref_kind: "message", ref_id: 6 }, T0 + 1))).toBe(false);
    expect(await h.write(tx => w(h).reclaim(tx, KEY, { ref_kind: "post", ref_id: 5 }, T0 + 1))).toBe(false);
    expect(await h.write(tx => w(h).reclaim(tx, { ...KEY, fp: "fp-2" }, { ref_kind: "message", ref_id: 5 }, T0 + 1))).toBe(false);
    expect(await w(h).find(h.read, S, A, FP, 0)).toMatchObject({ ref_id: 5, result_json: '{"message_id":5}', at: T0 });
    expect(await h.write(tx => w(h).reclaim(tx, KEY, { ref_kind: "message", ref_id: 5 }, T0 + 2))).toBe(true);
    expect(await w(h).find(h.read, S, A, FP, 0)).toEqual({ ...KEY, tool: "dm_send", ref_kind: "message", ref_id: 0, result_json: "", at: T0 + 2 });
    // A second reclaim naming the old ref finds it replaced.
    expect(await h.write(tx => w(h).reclaim(tx, KEY, { ref_kind: "message", ref_id: 5 }, T0 + 3))).toBe(false);
    expect(await w(h).find(h.read, S, A, FP, 0)).toMatchObject({ at: T0 + 2 });
  });

  // W6.
  it("refExists looks each kind up in its own table, present and gone", async h => {
    const m = await h.message();
    const p = await h.post();
    expect(await w(h).refExists(h.read, "message", m)).toBe(true);
    expect(await w(h).refExists(h.read, "post", p)).toBe(true);
    expect(await h.write(tx => w(h).refExists(tx, "post", p))).toBe(true);
    // With the messages table empty, no id is a message, the post's included; and the reverse.
    await h.drop("message", m);
    expect(await w(h).refExists(h.read, "message", m)).toBe(false);
    expect(await w(h).refExists(h.read, "message", p)).toBe(false);
    expect(await w(h).refExists(h.read, "post", p)).toBe(true);
    const m2 = await h.message();
    await h.drop("post", p);
    expect(await w(h).refExists(h.read, "post", p)).toBe(false);
    expect(await w(h).refExists(h.read, "post", m2)).toBe(false);
    expect(await w(h).refExists(h.read, "message", m2)).toBe(true);
  });

  // W7.
  it("pruneSession deletes its session's receipts at or before `before` and counts them; prune does so across sessions", async h => {
    await h.write(async tx => {
      for (const [session, fp, at] of [[S, "f1", T0], [S, "f2", T0 + 1], [S, "f3", T0 + 2], ["sess-2", "f1", T0], ["sess-2", "f2", T0 + 5]] as const) {
        await w(h).upsert(tx, receipt({ session, fp, at }));
      }
    });
    expect(await h.write(tx => w(h).pruneSession(tx, S, T0 + 1))).toBe(2);
    expect(await w(h).find(h.read, S, A, "f1", 0)).toBeUndefined();
    expect(await w(h).find(h.read, S, A, "f2", 0)).toBeUndefined();
    expect(await w(h).find(h.read, S, A, "f3", 0)).toMatchObject({ at: T0 + 2 });
    expect(await w(h).find(h.read, "sess-2", A, "f1", 0)).toMatchObject({ at: T0 });
    expect(await h.write(tx => w(h).pruneSession(tx, S, T0 + 1))).toBe(0);
    expect(await h.write(tx => w(h).prune(tx, T0 + 2))).toBe(2);
    expect(await w(h).find(h.read, S, A, "f3", 0)).toBeUndefined();
    expect(await w(h).find(h.read, "sess-2", A, "f1", 0)).toBeUndefined();
    expect(await w(h).find(h.read, "sess-2", A, "f2", 0)).toMatchObject({ at: T0 + 5 });
    expect(await h.write(tx => w(h).prune(tx, T0 + 5))).toBe(1);
    expect(await h.write(tx => w(h).prune(tx, T0 + 5))).toBe(0);
  });

  // The P1c-5 handle rows: each method runs on the handle it's given.
  it("a settled Tx is refused by every method and writes nothing", async h => {
    const kept = await h.write(async tx => { await w(h).upsert(tx, receipt()); return tx; });
    const settled = "Tx used after its transaction settled";
    const calls: (() => unknown)[] = [
      () => w(h).find(kept, S, A, FP, 0),
      () => w(h).claim(kept, { ...KEY, fp: "f9" }, "dm_send", T0),
      () => w(h).reclaim(kept, KEY, { ref_kind: "message", ref_id: 1 }, T0),
      () => w(h).upsert(kept, receipt({ fp: "f9" })),
      () => w(h).refExists(kept, "message", 1),
      () => w(h).pruneSession(kept, S, T0 + 10),
      () => w(h).prune(kept, T0 + 10),
    ];
    for (const call of calls) expect(await failure(call)).toContain(settled);
    expect(await w(h).find(h.read, S, A, FP, 0)).toEqual(receipt());
    expect(await w(h).find(h.read, S, A, "f9", 0)).toBeUndefined();
  });
}
