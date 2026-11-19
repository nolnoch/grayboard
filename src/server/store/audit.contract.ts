// The audit log's contract (#807 P3 C7, docs/future/postgres-server.md D9): every AuditStore method, written once over
// a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test file
// registers it under a describe() (audit.contract.sqlite.ts through db.test.ts for SQLite, pg/audit.contract.pg.test.ts
// for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: rows are compared by their order and contents.
// - Every time is a fixed epoch passed in the row; nothing reads a wall clock.
// - The rows are serial. Two owed-notice reads racing to write one notice are a backend's own test: Postgres runs them
//   on two connections (C67b's pg/audit.pg.test.ts), as it does a write the database refuses. What these rows pin is
//   A6h's contract for a synchronous write whatever the store's mechanism: in the transaction, in program order, seen
//   by `last` on the writing Tx, gone with a rolled-back savepoint.
// - `detail` is JSON text at the interface, and a store may normalize it (Postgres jsonb: spacing, key order), so rows
//   compare it parsed. The raw reads give detail_type, the stored JSON's type as the database computes it (SQLite
//   json_type, Postgres jsonb_typeof): an object written as a JSON string reads "text"/"string", not "object".
// - The store-direct row (insertAudit on that backend, as other groups write theirs) and the raw reads are the
//   harness's.
import { expect, test } from "bun:test";
import { inRequest } from "../request_context.ts";
import type { AccessLogRow, AuditStore } from "./audit.ts";
import type { Read, Tx } from "./tx_base.ts";

export type AuditRawRow = {
  at: number; actor: string | null; action: string; target: string | null; detail: unknown; detail_type: string | null;
  ip: string | null; ua: string | null; client_id: string | null;
};

// One store, fresh per row.
export type AuditHarness = {
  audit: AuditStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // A store-direct audit row on tx (insertAudit on that backend, stamped with the request's origin as audit.write's).
  direct(tx: Tx, row: AccessLogRow): Promise<void>;
  // Raw reads: every access_log row in id order, detail parsed.
  rows(): Promise<AuditRawRow[]>;
  close(): void | Promise<void>;
};

export type AuditBackend = { kind: "sqlite" | "postgres"; open(): Promise<AuditHarness> };

const T0 = 1_800_000_000_000;
const ACT = "auth.login";
const row = (target: string, at = T0, over: Partial<AccessLogRow> = {}): AccessLogRow =>
  ({ at, actor: "a@example.com", action: ACT, target, detail: null, ...over });
const parsed = (r: AccessLogRow | undefined) => r && { ...r, detail: r.detail === null ? null : JSON.parse(r.detail) as unknown };

async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}
// A synchronous call's throw, or "(no error)"; a returned promise counts as not throwing (the write must throw at once).
function thrown(f: () => unknown): string {
  try { f(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

export function auditContract(backend: AuditBackend): void {
  const it = (name: string, fn: (h: AuditHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  writes(it);
  reads(it);
}

type It = (name: string, fn: (h: AuditHarness) => Promise<void>) => void;

function writes(it: It): void {
  // U1.
  it("write on a Tx: last on that Tx sees it before the commit, and the pool after", async h => {
    const seen = await h.write(async tx => {
      const before = await h.audit.last(tx, ACT, "t");
      h.audit.write(tx, row("t", T0, { detail: JSON.stringify({ n: 1 }) }));
      return { before, after: await h.audit.last(tx, ACT, "t") };
    });
    expect(seen.before).toBeUndefined();
    expect(parsed(seen.after)).toEqual({ at: T0, actor: "a@example.com", action: ACT, target: "t", detail: { n: 1 } });
    expect(parsed(await h.audit.last(h.read, ACT, "t"))).toEqual({ at: T0, actor: "a@example.com", action: ACT, target: "t", detail: { n: 1 } });
    expect(await h.audit.last(h.read, ACT, "other")).toBeUndefined();
    expect(await h.audit.last(h.read, "auth.logout", "t")).toBeUndefined();
  });

  // U2.
  it("a rolled-back savepoint's row is gone and its parent's kept; a body that throws keeps none", async h => {
    const seen = await h.write(async tx => {
      h.audit.write(tx, row("in-body"));
      expect(await failure(() => tx.savepoint(async sp => {
        h.audit.write(sp, row("in-savepoint"));
        expect((await h.audit.last(sp, ACT, "in-savepoint"))?.target).toBe("in-savepoint");
        throw new Error("savepoint failed");
      }))).toBe("savepoint failed");
      await tx.savepoint(async sp => { h.audit.write(sp, row("released")); });
      return { gone: await h.audit.last(tx, ACT, "in-savepoint"), body: await h.audit.last(tx, ACT, "in-body") };
    });
    expect(seen.gone).toBeUndefined();
    expect(seen.body?.target).toBe("in-body");
    expect((await h.rows()).map(r => r.target)).toEqual(["in-body", "released"]);
    expect(await failure(() => h.write(async tx => {
      h.audit.write(tx, row("thrown"));
      await h.audit.last(tx, ACT, "thrown");
      throw new Error("body failed");
    }))).toBe("body failed");
    expect(await h.audit.last(h.read, ACT, "thrown")).toBeUndefined();
    expect((await h.rows()).map(r => r.target)).toEqual(["in-body", "released"]);
  });

  // U6.
  it("a row carries the origin of the request that wrote it, read when it is written", async h => {
    await h.write(async tx => {
      inRequest({ ip: "203.0.113.7", ua: "agent/1", client_id: "cli-1" }, () => h.audit.write(tx, row("first")));
      // The request's scope has ended before the body's next statement and its commit.
      await h.audit.last(tx, ACT, "first");
      inRequest({ ip: "203.0.113.8", ua: null }, () => h.audit.write(tx, row("second")));
      h.audit.write(tx, row("none"));
    });
    expect((await h.rows()).map(r => [r.target, r.ip, r.ua, r.client_id])).toEqual([
      ["first", "203.0.113.7", "agent/1", "cli-1"],
      ["second", "203.0.113.8", null, null],
      ["none", null, null, null],
    ]);
  });

  // U7.
  it("write on a settled Tx, or on a parent while its savepoint is open, throws synchronously and writes nothing", async h => {
    const kept = await h.write(async tx => tx);
    expect(thrown(() => h.audit.write(kept, row("late")))).toContain("Tx used after its transaction settled");
    await h.write(async tx => {
      await tx.savepoint(async () => {
        expect(thrown(() => h.audit.write(tx, row("parent")))).toContain("savepoint is open");
      });
    });
    expect(await h.rows()).toEqual([]);
  });

  // U8.
  it("a NUL or a lone surrogate in actor, target or a detail string commits as U+FFFD", async h => {
    const bad = "a\u0000b\uD800c\uDC00d";
    const safe = "a\uFFFDb\uFFFDc\uFFFDd";
    await h.write(async tx => {
      h.audit.write(tx, row(bad, T0, { actor: bad, detail: JSON.stringify({ name: bad, list: [bad, { [bad]: 1 }], n: 1, ok: true, none: null }) }));
    });
    const want = { name: safe, list: [safe, { [safe]: 1 }], n: 1, ok: true, none: null };
    expect(await h.rows()).toEqual([{ at: T0, actor: safe, action: ACT, target: safe, detail: want, detail_type: "object", ip: null, ua: null, client_id: null }]);
    expect(parsed(await h.audit.last(h.read, ACT, safe))?.detail).toEqual(want);
    // A paired surrogate (an emoji) is kept.
    await h.write(async tx => { h.audit.write(tx, row("😀", T0, { detail: JSON.stringify({ e: "😀" }) })); });
    expect(parsed(await h.audit.last(h.read, ACT, "😀"))?.detail).toEqual({ e: "😀" });
  });

  // U9.
  it("writes and store-direct rows land in program order", async h => {
    await h.write(async tx => {
      h.audit.write(tx, row("1"));
      await h.direct(tx, row("2", T0, { action: "role.granted" }));
      h.audit.write(tx, row("3"));
      await tx.savepoint(async sp => { h.audit.write(sp, row("4")); await h.direct(sp, row("5", T0, { action: "role.granted" })); });
      h.audit.write(tx, row("6"));
    });
    expect((await h.rows()).map(r => r.target)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
}

function reads(it: It): void {
  // U3.
  it("last is the newest by (at, id): of two rows at one at the later written wins; an older at written later loses", async h => {
    await h.write(async tx => {
      h.audit.write(tx, row("t", T0 + 2, { actor: "first" }));
      h.audit.write(tx, row("t", T0 + 2, { actor: "second" }));
      h.audit.write(tx, row("t", T0 + 1, { actor: "older" }));
      h.audit.write(tx, row("u", T0 + 9, { actor: "other target" }));
      h.audit.write(tx, row("t", T0 + 9, { action: "auth.logout", actor: "other action" }));
    });
    expect((await h.audit.last(h.read, ACT, "t"))?.actor).toBe("second");
    await h.write(async tx => { h.audit.write(tx, row("t", T0 + 3, { actor: "newest" })); });
    expect((await h.audit.last(h.read, ACT, "t"))?.actor).toBe("newest");
  });

  // U4.
  it("last returns the detail as the JSON text of the object written, stored as an object; null stays null; at a number", async h => {
    const detail = { z: 1, a: "x", nested: { list: [1, "two", null], flag: false } };
    await h.write(async tx => {
      h.audit.write(tx, row("obj", T0 + 1, { detail: JSON.stringify(detail) }));
      h.audit.write(tx, row("nul", T0 + 2, { actor: null }));
    });
    const got = await h.audit.last(h.read, ACT, "obj");
    expect(typeof got!.detail).toBe("string");
    expect(JSON.parse(got!.detail!)).toEqual(detail);
    expect(got!.at).toBe(T0 + 1);
    expect(typeof got!.at).toBe("number");
    expect(await h.audit.last(h.read, ACT, "nul")).toEqual({ at: T0 + 2, actor: null, action: ACT, target: "nul", detail: null });
    expect((await h.rows()).map(r => [r.target, r.detail_type])).toEqual([["obj", "object"], ["nul", null]]);
  });

  // U5.
  it("prune deletes rows strictly before the cutoff", async h => {
    await h.write(async tx => {
      h.audit.write(tx, row("old", T0 - 1));
      h.audit.write(tx, row("edge", T0));
      h.audit.write(tx, row("new", T0 + 1));
    });
    await h.write(tx => h.audit.prune(tx, T0));
    expect((await h.rows()).map(r => r.target)).toEqual(["edge", "new"]);
    expect(await h.audit.last(h.read, ACT, "old")).toBeUndefined();
    expect((await h.audit.last(h.read, ACT, "edge"))?.at).toBe(T0);
  });

  // U10.
  it("lock serially changes nothing, twice in one body included; a settled Tx is refused", async h => {
    await h.write(async tx => {
      h.audit.write(tx, row("t"));
      await h.audit.lock(tx, ACT, "t");
      await h.audit.lock(tx, ACT, "t");
      await h.audit.lock(tx, "bridge.notified", "a@example.com/human");
      expect((await h.audit.last(tx, ACT, "t"))?.target).toBe("t");
      h.audit.write(tx, row("u"));
    });
    expect((await h.rows()).map(r => r.target)).toEqual(["t", "u"]);
    const kept = await h.write(async tx => tx);
    expect(await failure(() => h.audit.lock(kept, ACT, "t"))).toContain("Tx used after its transaction settled");
    expect(await failure(() => h.audit.last(kept, ACT, "t"))).toContain("Tx used after its transaction settled");
    expect(await failure(() => h.audit.prune(kept, T0))).toContain("Tx used after its transaction settled");
  });
}
