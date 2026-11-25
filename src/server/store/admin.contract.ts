// The admin dashboard reads' contract (#1651, store/admin.ts): every AdminStore method, written once over a harness so
// both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: admin.contract.sqlite.ts registers
// it through db.test.ts for SQLite, pg/admin.contract.pg.test.ts for Postgres.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids the fixtures returned are compared, never literals.
// - Every time is a fixed epoch passed in the row; nothing reads a wall clock.
// - Fixtures go in through the harness's `insert`, a plain INSERT with the backend's placeholders, so the rows hold
//   only columns both schemas have with the same type (no boolean columns: messages.pending keeps its default).
// - Text keys compare in byte order on both stores (Postgres COLLATE "C"), so mixed case and non-ASCII keys pin it.
import { expect, test } from "bun:test";
import { ADMIN_PAGE_MAX, adminLimit, type AdminStore, type AuditCursor } from "./admin.ts";
import type { Read } from "./tx_base.ts";

export type AdminHarness = {
  admin: AdminStore;
  read: Read;
  // INSERT one row into `table`; returns its id, or 0 for a table without one (boards, claims).
  insert(table: string, row: Record<string, string | number | null>): Promise<number>;
  close(): void | Promise<void>;
};

export type AdminBackend = { kind: "sqlite" | "postgres"; open(): Promise<AdminHarness> };

const T0 = 1_800_000_000_000;
type It = (name: string, fn: (h: AdminHarness) => Promise<void>) => void;

// Every page of a keyset read, by `next` from the last row, until an empty page; at most 50, so a cursor that never
// advances fails rather than loops.
async function pages<T, C>(first: C, read: (c: C) => Promise<T[]>, next: (last: T) => C): Promise<T[][]> {
  const out: T[][] = [];
  let c = first;
  for (let i = 0; i < 50; i++) {
    const p = await read(c);
    if (!p.length) return out;
    out.push(p);
    c = next(p[p.length - 1]!);
  }
  throw new Error("pages: the cursor never reached an empty page");
}

export function adminContract(backend: AdminBackend): void {
  const it: It = (name, fn) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  limits(it);
  identity(it);
  claims(it);
  boards(it);
  messages(it);
  audit(it);
}

function limits(it: It): void {
  test("adminLimit clamps to 1..ADMIN_PAGE_MAX and truncates", () => {
    expect([0, -5, 1, 2.9, 100, 101, 1e9, Number.NaN, Number.POSITIVE_INFINITY].map(adminLimit))
      .toEqual([1, 1, 1, 2, 100, ADMIN_PAGE_MAX, ADMIN_PAGE_MAX, ADMIN_PAGE_MAX, ADMIN_PAGE_MAX]);
  });
  it("a read applies the clamp: limit 0 is one row, a huge limit is every row under the cap", async h => {
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) await h.insert("users", { email: e, created_at: T0 });
    expect(await h.admin.users(h.read, 0, 0)).toHaveLength(1);
    expect(await h.admin.users(h.read, 0, 1e9)).toHaveLength(3);
  });
}

function identity(it: It): void {
  it("users: id order, each user once across pages, kind read with the row, empty past the end", async h => {
    const ids: number[] = [];
    for (const e of ["c@example.com", "a@example.com", "b@example.com", "e@example.com", "d@example.com"]) {
      ids.push(await h.insert("users", { email: e, display_name: null, created_at: T0, disabled_at: e === "a@example.com" ? T0 + 1 : null }));
    }
    const got = await pages(0, after => h.admin.users(h.read, after, 2), u => u.id);
    expect(got.map(p => p.length)).toEqual([2, 2, 1]);
    const flat = got.flat();
    expect(flat.map(u => u.id)).toEqual(ids);
    expect(flat.map(u => u.email)).toEqual(["c@example.com", "a@example.com", "b@example.com", "e@example.com", "d@example.com"]);
    expect(flat[1]).toMatchObject({ disabled_at: T0 + 1, kind: "user", created_at: T0 });
    expect(await h.admin.users(h.read, ids[4]!, 10)).toEqual([]);
  });
  it("teams: id order across pages, with policy", async h => {
    const owner = await h.insert("users", { email: "o@example.com", created_at: T0 });
    const ids: number[] = [];
    for (const [n, p] of [["be", "open"], ["fe", "collaborative"], ["sim", "delegating"]] as const) {
      ids.push(await h.insert("teams", { name: n, created_by: owner, policy: p, created_at: T0 }));
    }
    const flat = (await pages(0, after => h.admin.teams(h.read, after, 2), t => t.id)).flat();
    expect(flat).toEqual([
      { id: ids[0]!, name: "be", created_by: owner, policy: "open", created_at: T0 },
      { id: ids[1]!, name: "fe", created_by: owner, policy: "collaborative", created_at: T0 },
      { id: ids[2]!, name: "sim", created_by: owner, policy: "delegating", created_at: T0 },
    ]);
  });
}

function claims(it: It): void {
  it("claims: live ones in byte order across pages, a lapsed row skipped", async h => {
    const now = T0 + 1000;
    for (const k of ["ticket:b", "Ticket:Z", "ticket:é", "ticket:a", "lapsed"]) {
      await h.insert("claims", { key: k, holder: "be", note: null, board: null, acquired_at: T0, expires_at: k === "lapsed" ? now : now + 1 });
    }
    const got = await pages("", after => h.admin.claims(h.read, after, now, 2), c => c.key);
    // Byte order: uppercase before lowercase, the two-byte é after ASCII.
    expect(got.flat().map(c => c.key)).toEqual(["Ticket:Z", "ticket:a", "ticket:b", "ticket:é"]);
    expect(got.flat()[0]).toEqual({ key: "Ticket:Z", holder: "be", note: null, board: null, acquired_at: T0, expires_at: now + 1 });
  });
  it("claimEvents: one key's events newest first, paged by id", async h => {
    const ids: number[] = [];
    for (const [i, [key, event]] of ([["k", "take"], ["other", "take"], ["k", "renew"], ["k", "release"]] as const).entries()) {
      ids.push(await h.insert("claim_events", { key, handle: "be", event, note: `n${i}`, board: null, expires_at: T0 + 10, held_by: null, at: T0 + i }));
    }
    const got = await pages(0, before => h.admin.claimEvents(h.read, "k", before, 2), e => e.id);
    expect(got.map(p => p.map(e => e.id))).toEqual([[ids[3]!, ids[2]!], [ids[0]!]]);
    expect(got[0]![0]).toEqual({ id: ids[3]!, key: "k", handle: "be", event: "release", note: "n3", board: null, expires_at: T0 + 10, held_by: null, at: T0 + 3 });
  });
}

function boards(it: It): void {
  const post = (h: AdminHarness, board: string, parent: number | null, at: number) =>
    h.insert("posts", { board, author: "be", body: `body ${at}`, parent_id: parent, created_at: at, expires_at: null });

  it("threads: a board's roots newest first, replies and other boards left out, paged by id", async h => {
    for (const b of ["e2e", "other"]) await h.insert("boards", { name: b, purpose: "", scope: null, created_by: "test", created_at: T0 });
    const r1 = await post(h, "e2e", null, T0 + 1);
    await post(h, "e2e", r1, T0 + 2);
    await post(h, "other", null, T0 + 3);
    const r2 = await post(h, "e2e", null, T0 + 4);
    const r3 = await post(h, "e2e", null, T0 + 6);
    const first = await h.admin.threads(h.read, "e2e", 0, 2);
    expect(first).toEqual([{ id: r3, author: "be", created_at: T0 + 6 }, { id: r2, author: "be", created_at: T0 + 4 }]);
    // A root posted between two pages lands above the cursor: the next page neither repeats nor skips a row.
    await post(h, "e2e", null, T0 + 7);
    const rest = await pages(first[1]!.id, before => h.admin.threads(h.read, "e2e", before, 2), t => t.id);
    expect(rest.flat().map(t => t.id)).toEqual([r1]);
    expect(await h.admin.threads(h.read, "nope", 0, 10)).toEqual([]);
  });
  it("thread: the root and every reply below it, nested ones included, in id order, paged; another thread left out", async h => {
    await h.insert("boards", { name: "e2e", purpose: "", scope: null, created_by: "test", created_at: T0 });
    const root = await post(h, "e2e", null, T0 + 1);
    const a = await post(h, "e2e", root, T0 + 2);
    const other = await post(h, "e2e", null, T0 + 3);
    const aa = await post(h, "e2e", a, T0 + 4);
    await post(h, "e2e", other, T0 + 5);
    const b = await post(h, "e2e", root, T0 + 7);
    const got = await pages(0, after => h.admin.thread(h.read, root, after, 2), p => p.id);
    expect(got.map(p => p.map(x => x.id))).toEqual([[root, a], [aa, b]]);
    expect(got[1]![0]).toEqual({ id: aa, board: "e2e", author: "be", body: `body ${T0 + 4}`, parent_id: a, created_at: T0 + 4 });
    expect(await h.admin.thread(h.read, b + 1000, 0, 10)).toEqual([]);
  });
}

function messages(it: It): void {
  it("messages: newest first, paged by id, without a body", async h => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await h.insert("messages", {
        sender: "be", recipient_type: "user", recipient: i === 1 ? "fe" : "sim", body: `secret ${i}`, parent_id: i === 2 ? ids[0]! : null,
        created_at: T0 + i, delivered_at: i === 0 ? T0 + 9 : null, kind: null,
      }));
    }
    const got = await pages(0, before => h.admin.messages(h.read, before, 2), m => m.id);
    expect(got.map(p => p.map(m => m.id))).toEqual([[ids[2]!, ids[1]!], [ids[0]!]]);
    expect(got[0]![0]).toEqual({
      id: ids[2]!, sender: "be", recipient_type: "user", recipient: "sim", parent_id: ids[0]!, created_at: T0 + 2, delivered_at: null, pending: false, kind: null,
    });
    expect(got[1]![0]!.delivered_at).toBe(T0 + 9);
    for (const m of got.flat()) expect(Object.keys(m)).not.toContain("body");
  });
}

function audit(it: It): void {
  it("audit: newest first by (at, id) under each filter, ties on at split across pages without a repeat or a gap", async h => {
    const rows: { id: number; at: number; actor: string; action: string; target: string }[] = [];
    // Three rows share T0 + 5, so a page boundary falls inside the tie. The last two land after newer rows, as a
    // row whose `at` was taken before the write queue ran does, so id order isn't (at, id) order.
    const spec = [
      [T0 + 1, "a@example.com", "auth.login", "t1"], [T0 + 5, "b@example.com", "admin.read", "t1"],
      [T0 + 5, "a@example.com", "admin.read", "t2"], [T0 + 5, "a@example.com", "auth.login", "t1"],
      [T0 + 9, "b@example.com", "admin.read", "t1"], [T0 + 3, "a@example.com", "admin.read", "t1"],
      [T0 + 2, "b@example.com", "auth.login", "t2"],
    ] as const;
    for (const [at, actor, action, target] of spec) {
      const id = await h.insert("access_log", { at, actor, action, target, detail: JSON.stringify({ at }), ip: "10.0.0.1", ua: null, client_id: null });
      rows.push({ id, at, actor, action, target });
    }
    const newest = [...rows].sort((x, y) => y.at - x.at || y.id - x.id);
    const walk = async (filter: Parameters<AdminStore["audit"]>[1]) =>
      (await pages<{ id: number; at: number }, AuditCursor | null>(null, before => h.admin.audit(h.read, filter, before, 2), l => ({ at: l.at, id: l.id })))
        .flat().map(r => r.id);
    expect(await walk({})).toEqual(newest.map(r => r.id));
    expect(await walk({ actor: "a@example.com" })).toEqual(newest.filter(r => r.actor === "a@example.com").map(r => r.id));
    expect(await walk({ action: "admin.read" })).toEqual(newest.filter(r => r.action === "admin.read").map(r => r.id));
    expect(await walk({ action: "admin.read", target: "t1" })).toEqual(newest.filter(r => r.action === "admin.read" && r.target === "t1").map(r => r.id));
    const [top] = await h.admin.audit(h.read, {}, null, 1);
    expect({ ...top!, detail: JSON.parse(top!.detail!) }).toEqual({
      id: newest[0]!.id, at: T0 + 9, actor: "b@example.com", action: "admin.read", target: "t1", detail: { at: T0 + 9 }, ip: "10.0.0.1", ua: null, client_id: null,
    });
  });
}
