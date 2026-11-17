import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { runRetention } from "./retention.ts";
import { dedupWrite, fingerprint, type DedupCall, type DedupOutcome, type Written } from "./write_dedup.ts";
import { canonicalJson, WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";
import type { CoreDb } from "../core/boards.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import type { Tx } from "./store/tx.ts";

describe("canonicalJson", () => {
  test("sorts keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("keeps array order: a list's order is part of the call", () => {
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
    expect(canonicalJson([[1, 2], []])).toBe("[[1,2],[]]");
  });

  test("encodes strings as JSON: quotes, backslashes, control characters and non-ASCII", () => {
    expect(canonicalJson('say "hi"\\\n\t\u0001')).toBe('"say \\"hi\\"\\\\\\n\\t\\u0001"');
    expect(canonicalJson("café 🎉")).toBe('"café 🎉"');
    // Keys are escaped as strings too.
    expect(canonicalJson({ 'k"': 1 })).toBe('{"k\\"":1}');
  });

  test("doesn't Unicode-normalize: NFC and NFD spellings differ", () => {
    const nfc = "café";
    const nfd = "café";
    expect(canonicalJson(nfc)).not.toBe(canonicalJson(nfd));
  });

  test("drops undefined keys, as JSON does, and refuses what JSON can't carry", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });

  test("the fingerprint covers tool, session, sender and args", () => {
    const base = fingerprint("dm_send", "s1", "a@example.com/be", { to: "b@example.com/fe", body: "x" });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint("dm_send", "s1", "a@example.com/be", { body: "x", to: "b@example.com/fe" })).toBe(base);
    expect(fingerprint("board_post", "s1", "a@example.com/be", { to: "b@example.com/fe", body: "x" })).not.toBe(base);
    expect(fingerprint("dm_send", "s2", "a@example.com/be", { to: "b@example.com/fe", body: "x" })).not.toBe(base);
    expect(fingerprint("dm_send", "s1", "a@example.com/sim", { to: "b@example.com/fe", body: "x" })).not.toBe(base);
    expect(fingerprint("dm_send", "s1", "a@example.com/be", { to: "b@example.com/fe", body: "y" })).not.toBe(base);
  });
});

describe("dedupWrite", () => {
  let dir: string;
  let repo: Repo;
  let db: CoreDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gb-dedup-"));
    ({ repo, db } = openDatabase(scratchDbPath(), { blobDir: join(dir, "blobs") }));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const SENDER = "a@example.com/be";
  const call = (over: Partial<DedupCall> = {}): DedupCall => ({
    tool: "dm_send", session: "s1", sender: SENDER, actor: "a@example.com", transport: "bridge",
    args: { to: "b@example.com/fe", body: "hi" }, resend: false, ...over,
  });
  const send = (body = "hi") => async (tx: Tx) => {
    const m = await repo.messages.insert(tx, SENDER, "user", "b@example.com/fe", body, null);
    return { payload: { message_id: m.id, delivered_now: false }, ref: { kind: "message" as const, id: m.id } };
  };
  // A tool call's dedup, inside a queued body as the application's handlers run it.
  const dedup = <W extends Written>(now: number, c: DedupCall, write: (tx: Tx) => W | Promise<W>) =>
    seed(repo, tx => dedupWrite(repo, tx, now, c, write)) as Promise<DedupOutcome<W>>;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const audits = (action: string) => db.prepare("SELECT target, actor, detail FROM access_log WHERE action = ?").all(action) as { target: string; actor: string; detail: string }[];

  test("a repeat in the window replays the stored payload, writes nothing but the audit row", async () => {
    const first = await dedup(1_000, call(), send());
    if (!("fresh" in first)) throw new Error("expected a fresh write");
    const id = first.fresh.payload.message_id;
    const again = await dedup(2_000, call(), (): Awaited<ReturnType<ReturnType<typeof send>>> => {
      throw new Error("must not run");
    });
    expect(again).toEqual({
      replay: {
        message_id: id,
        delivered_now: false,
        replayed: { first_at: new Date(1_000).toISOString(), ref: { kind: "message", id } },
        note: `already sent to b@example.com/fe at ${new Date(1_000).toISOString()} as message ${id}; this repeat was not sent. To send it again on purpose, call with resend: true.`,
      },
    });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
    const [row] = audits("request.replayed");
    expect(row).toMatchObject({ target: SENDER, actor: "a@example.com" });
    expect(JSON.parse(row!.detail)).toEqual({
      tool: "dm_send", fp: fingerprint("dm_send", "s1", SENDER, call().args), ref_kind: "message", ref_id: id,
      first_at: new Date(1_000).toISOString(), transport: "bridge", session: "s1",
    });
  });

  test("a write that throws leaves no receipt, so the retry writes", async () => {
    await expect(dedup(1_000, call(), tx => {
      send()(tx);
      throw new Error("bound attachment refused");
    })).rejects.toThrow("bound attachment refused");
    expect(count("SELECT COUNT(*) AS n FROM write_receipts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect("fresh" in await dedup(2_000, call(), send())).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
  });

  test("resend writes again, audits request.resent, and the receipt moves to the new row", async () => {
    const first = await dedup(1_000, call(), send());
    const forced = await dedup(2_000, call({ resend: true }), send());
    if (!("fresh" in first) || !("fresh" in forced)) throw new Error("expected fresh writes");
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(2);
    expect(audits("request.resent").map((r) => JSON.parse(r.detail))).toEqual([
      { tool: "dm_send", fp: fingerprint("dm_send", "s1", SENDER, call().args), ref_kind: "message", ref_id: forced.fresh.ref.id, session: "s1" },
    ]);
    const replay = await dedup(3_000, call(), send());
    expect("replay" in replay && replay.replay.replayed.ref.id).toBe(forced.fresh.ref.id);
  });

  test("a receipt whose row is gone is a miss, and is replaced", async () => {
    const first = await dedup(1_000, call(), send());
    if (!("fresh" in first)) throw new Error("expected a fresh write");
    expect(await seed(repo, tx => repo.messages.retract(tx, SENDER, first.fresh.ref.id, { actor: "a@example.com", session: "s1" }))).toBe(true);
    // The Repo's retract writes its own audit row (#306), whoever calls it.
    const [retracted] = audits("message.retracted");
    expect(retracted).toMatchObject({ target: `message:${first.fresh.ref.id}`, actor: "a@example.com" });
    expect(JSON.parse(retracted!.detail)).toEqual({ message_id: first.fresh.ref.id, sender: SENDER, recipient: expect.any(String), session: "s1" });
    const again = await dedup(2_000, call(), send());
    if (!("fresh" in again)) throw new Error("expected a fresh write");
    expect(again.fresh.ref.id).not.toBe(first.fresh.ref.id);
    expect(db.prepare("SELECT ref_id, at FROM write_receipts").all()).toEqual([{ ref_id: again.fresh.ref.id, at: 2_000 }]);
    // The fresh write after a stale receipt says why it wasn't a replay (#306).
    const stale = audits("request.receipt_stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ target: SENDER, actor: "a@example.com" });
    expect(JSON.parse(stale[0]!.detail)).toEqual({ tool: "dm_send", fp: expect.any(String), ref_kind: "message", ref_id: first.fresh.ref.id, first_at: new Date(1_000).toISOString(), session: "s1" });
    expect(audits("request.replayed")).toEqual([]);
  });

  // #807 P2-2 (D3): the receipt is claimed by one statement before the write, and a stale one is taken over only while
  // it still names the gone row. SQLite's single writer can't interleave two calls; these land the other call's
  // receipt where Postgres could, and the two-transaction tests come with P3.
  test("the receipt is claimed before the write runs", async () => {
    const fp = fingerprint("dm_send", "s1", SENDER, call().args);
    let seen: Promise<unknown> | undefined;
    await dedup(1_000, call(), tx => {
      seen = repo.writeReceipts.find(tx, "s1", SENDER, fp, 0);
      return send()(tx);
    });
    expect(await seen).toMatchObject({ ref_id: 0, at: 1_000 });
    expect(await seed(repo, tx => repo.writeReceipts.claim(tx, { session: "s1", sender: SENDER, fp }, "dm_send", 2_000))).toBe(false);
  });

  test("a stale receipt another call replaced after this one read it answers with that call's write", async () => {
    const first = await dedup(1_000, call(), send());
    if (!("fresh" in first)) throw new Error("expected a fresh write");
    await seed(repo, tx => repo.messages.retract(tx, SENDER, first.fresh.ref.id, { actor: "a@example.com", session: "s1" }));
    const receipts = repo.writeReceipts;
    const reclaim = receipts.reclaim;
    let winner = 0;
    // The other call's write and receipt land between this call's read of the stale receipt and its takeover.
    receipts.reclaim = async (tx, key, stale, at) => {
      const w = await send("hi")(tx);
      winner = w.ref.id;
      await receipts.upsert(tx, { ...key, tool: "dm_send", ref_kind: "message", ref_id: w.ref.id, result_json: JSON.stringify(w.payload), at });
      return reclaim(tx, key, stale, at);
    };
    let again: Awaited<ReturnType<typeof dedup>>;
    try {
      again = await dedup(2_000, call(), (): Awaited<ReturnType<ReturnType<typeof send>>> => { throw new Error("must not run"); });
    } finally {
      receipts.reclaim = reclaim;
    }
    expect("replay" in again && again.replay.replayed.ref.id).toBe(winner);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
    expect(audits("request.receipt_stale")).toEqual([]);
    expect(audits("request.replayed")).toHaveLength(1);
  });

  test("a receipt committed after the prune but already outside the window is pruned, not a lost claim", async () => {
    const receipts = repo.writeReceipts;
    const claim = receipts.claim;
    let landed = false;
    // Another call's receipt, stamped before this call's window, commits between this call's prune and its claim.
    receipts.claim = async (tx, key, tool, at) => {
      if (!landed) {
        landed = true;
        await receipts.upsert(tx, { ...key, tool, ref_kind: "message", ref_id: 99, result_json: "{}", at: at - WRITE_DEDUP_WINDOW_MS - 1 });
      }
      return claim(tx, key, tool, at);
    };
    let out: Awaited<ReturnType<typeof dedup>>;
    try {
      out = await dedup(1_000 + WRITE_DEDUP_WINDOW_MS, call(), send());
    } finally {
      receipts.claim = claim;
    }
    expect("fresh" in out).toBe(true);
    expect(audits("request.replayed")).toEqual([]);
  });

  test("a receipt that keeps changing under the call is refused after three passes, writing nothing", async () => {
    const receipts = repo.writeReceipts;
    const { claim, find } = receipts;
    let claims = 0;
    receipts.claim = async () => { claims++; return false; };
    receipts.find = async () => undefined;
    try {
      await expect(dedup(1_000, call(), send())).rejects.toThrow(/kept changing under this call; retry it/);
    } finally {
      Object.assign(receipts, { claim, find });
    }
    expect(claims).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
  });

  test("past the window a repeat writes again; another session or sender never collides", async () => {
    await dedup(1_000, call(), send());
    expect("fresh" in await dedup(1_000 + WRITE_DEDUP_WINDOW_MS, call(), send())).toBe(true);
    expect("fresh" in await dedup(1_000 + WRITE_DEDUP_WINDOW_MS, call({ session: "s2" }), send())).toBe(true);
    expect("fresh" in await dedup(1_000 + WRITE_DEDUP_WINDOW_MS, call({ sender: "a@example.com/sim" }), send())).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(4);
  });

  test("prune on write keeps one session's receipts to its window", async () => {
    for (let i = 0; i < 5; i++) await dedup(i * 60_000, call({ args: { body: `m${i}` } }), send(`m${i}`));
    await dedup(0, call({ session: "other" }), send());
    // Ten minutes after the third write: the first three are past the window.
    await dedup(2 * 60_000 + WRITE_DEDUP_WINDOW_MS, call({ args: { body: "late" } }), send("late"));
    expect(db.prepare("SELECT session, at FROM write_receipts ORDER BY session, at").all()).toEqual([
      { session: "other", at: 0 },
      { session: "s1", at: 3 * 60_000 },
      { session: "s1", at: 4 * 60_000 },
      { session: "s1", at: 2 * 60_000 + WRITE_DEDUP_WINDOW_MS },
    ]);
  });

  test("the nightly retention sweep removes every session's expired receipts", async () => {
    const now = Date.now();
    await dedup(now - WRITE_DEDUP_WINDOW_MS - 1, call({ session: "gone" }), send());
    await dedup(now, call(), send("kept"));
    await runRetention(repo, { messageRetentionDays: 30, auditRetentionDays: 90 } as Config, now);
    expect(db.prepare("SELECT session FROM write_receipts").all()).toEqual([{ session: "s1" }]);
  });

  test("the note names the post's board and the delegation's target", async () => {
    const post = () => ({ payload: { post_id: 7, board: "e2e" }, ref: { kind: "post" as const, id: 7 } });
    await seed(repo, () => {
      db.prepare("INSERT INTO boards (name, purpose, created_by, created_at) VALUES ('e2e', 'x', ?, 0)").run(SENDER);
      db.prepare("INSERT INTO posts (id, board, author, body, created_at) VALUES (7, 'e2e', ?, 'x', 0)").run(SENDER);
    });
    const c = call({ tool: "board_post", args: { board: "e2e", body: "x" } });
    await dedup(1_000, c, post);
    const r = await dedup(2_000, c, post);
    expect("replay" in r && r.replay.note).toBe(`already posted to #e2e at ${new Date(1_000).toISOString()} as post 7; this repeat was not posted. To send it again on purpose, call with resend: true.`);

    const d = call({ tool: "delegate", args: { to: null, persona: "p", task: "t" } });
    const deleg = async (tx: Tx) => {
      const w = await send("delegation")(tx);
      return { ...w, payload: { ...w.payload, to: "a@example.com/lx" } };
    };
    await dedup(1_000, d, deleg);
    const rd = await dedup(2_000, d, deleg);
    expect("replay" in rd && rd.replay.note).toMatch(/^already delegated to a@example\.com\/lx at .* as message \d+; this repeat was not sent\./);
  });
});
