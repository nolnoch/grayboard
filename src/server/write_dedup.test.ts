import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { runRetention } from "./retention.ts";
import { WRITE_DEDUP_WINDOW_MS, canonicalJson, dedupWrite, fingerprint, type DedupCall } from "./write_dedup.ts";
import type { CoreDb } from "../core/boards.ts";

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
    ({ repo, db } = openDatabase(":memory:", { blobDir: join(dir, "blobs") }));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const SENDER = "a@example.com/be";
  const call = (over: Partial<DedupCall> = {}): DedupCall => ({
    tool: "dm_send", session: "s1", sender: SENDER, actor: "a@example.com", transport: "wss",
    args: { to: "b@example.com/fe", body: "hi" }, resend: false, ...over,
  });
  const send = (body = "hi") => () => {
    const m = repo.messages.insert(SENDER, "user", "b@example.com/fe", body, null);
    return { payload: { message_id: m.id, delivered_now: false }, ref: { kind: "message" as const, id: m.id } };
  };
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const audits = (action: string) => db.prepare("SELECT target, actor, detail FROM access_log WHERE action = ?").all(action) as { target: string; actor: string; detail: string }[];

  test("a repeat in the window replays the stored payload, writes nothing but the audit row", () => {
    const first = dedupWrite(repo, 1_000, call(), send());
    if (!("fresh" in first)) throw new Error("expected a fresh write");
    const id = first.fresh.payload.message_id;
    const again = dedupWrite(repo, 2_000, call(), (): ReturnType<ReturnType<typeof send>> => {
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
      first_at: new Date(1_000).toISOString(), transport: "wss", session: "s1",
    });
  });

  test("a write that throws leaves no receipt, so the retry writes", () => {
    expect(() => dedupWrite(repo, 1_000, call(), () => {
      send()();
      throw new Error("bound attachment refused");
    })).toThrow("bound attachment refused");
    expect(count("SELECT COUNT(*) AS n FROM write_receipts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect("fresh" in dedupWrite(repo, 2_000, call(), send())).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
  });

  test("resend writes again, audits request.resent, and the receipt moves to the new row", () => {
    const first = dedupWrite(repo, 1_000, call(), send());
    const forced = dedupWrite(repo, 2_000, call({ resend: true }), send());
    if (!("fresh" in first) || !("fresh" in forced)) throw new Error("expected fresh writes");
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(2);
    expect(audits("request.resent").map((r) => JSON.parse(r.detail))).toEqual([
      { tool: "dm_send", fp: fingerprint("dm_send", "s1", SENDER, call().args), ref_kind: "message", ref_id: forced.fresh.ref.id, session: "s1" },
    ]);
    const replay = dedupWrite(repo, 3_000, call(), send());
    expect("replay" in replay && replay.replay.replayed.ref.id).toBe(forced.fresh.ref.id);
  });

  test("a receipt whose row is gone is a miss, and is replaced", () => {
    const first = dedupWrite(repo, 1_000, call(), send());
    if (!("fresh" in first)) throw new Error("expected a fresh write");
    expect(repo.messages.retract(SENDER, first.fresh.ref.id)).toBe(true);
    const again = dedupWrite(repo, 2_000, call(), send());
    if (!("fresh" in again)) throw new Error("expected a fresh write");
    expect(again.fresh.ref.id).not.toBe(first.fresh.ref.id);
    expect(db.prepare("SELECT ref_id, at FROM write_receipts").all()).toEqual([{ ref_id: again.fresh.ref.id, at: 2_000 }]);
  });

  test("past the window a repeat writes again; another session or sender never collides", () => {
    dedupWrite(repo, 1_000, call(), send());
    expect("fresh" in dedupWrite(repo, 1_000 + WRITE_DEDUP_WINDOW_MS, call(), send())).toBe(true);
    expect("fresh" in dedupWrite(repo, 1_000 + WRITE_DEDUP_WINDOW_MS, call({ session: "s2" }), send())).toBe(true);
    expect("fresh" in dedupWrite(repo, 1_000 + WRITE_DEDUP_WINDOW_MS, call({ sender: "a@example.com/sim" }), send())).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(4);
  });

  test("prune on write keeps one session's receipts to its window", () => {
    for (let i = 0; i < 5; i++) dedupWrite(repo, i * 60_000, call({ args: { body: `m${i}` } }), send(`m${i}`));
    dedupWrite(repo, 0, call({ session: "other" }), send());
    // Ten minutes after the third write: the first three are past the window.
    dedupWrite(repo, 2 * 60_000 + WRITE_DEDUP_WINDOW_MS, call({ args: { body: "late" } }), send("late"));
    expect(db.prepare("SELECT session, at FROM write_receipts ORDER BY session, at").all()).toEqual([
      { session: "other", at: 0 },
      { session: "s1", at: 3 * 60_000 },
      { session: "s1", at: 4 * 60_000 },
      { session: "s1", at: 2 * 60_000 + WRITE_DEDUP_WINDOW_MS },
    ]);
  });

  test("the nightly retention sweep removes every session's expired receipts", async () => {
    const now = Date.now();
    dedupWrite(repo, now - WRITE_DEDUP_WINDOW_MS - 1, call({ session: "gone" }), send());
    dedupWrite(repo, now, call(), send("kept"));
    await runRetention(repo, db, { messageRetentionDays: 30, auditRetentionDays: 90 } as Config, now);
    expect(db.prepare("SELECT session FROM write_receipts").all()).toEqual([{ session: "s1" }]);
  });

  test("the note names the post's board and the delegation's target", () => {
    const post = () => ({ payload: { post_id: 7, board: "e2e" }, ref: { kind: "post" as const, id: 7 } });
    db.prepare("INSERT INTO boards (name, purpose, created_by, created_at) VALUES ('e2e', 'x', ?, 0)").run(SENDER);
    db.prepare("INSERT INTO posts (id, board, author, body, created_at) VALUES (7, 'e2e', ?, 'x', 0)").run(SENDER);
    const c = call({ tool: "board_post", args: { board: "e2e", body: "x" } });
    dedupWrite(repo, 1_000, c, post);
    const r = dedupWrite(repo, 2_000, c, post);
    expect("replay" in r && r.replay.note).toBe(`already posted to #e2e at ${new Date(1_000).toISOString()} as post 7; this repeat was not posted. To send it again on purpose, call with resend: true.`);

    const d = call({ tool: "delegate", args: { to: null, persona: "p", task: "t" } });
    const deleg = () => {
      const w = send("delegation")();
      return { ...w, payload: { ...w.payload, to: "a@example.com/lx" } };
    };
    dedupWrite(repo, 1_000, d, deleg);
    const rd = dedupWrite(repo, 2_000, d, deleg);
    expect("replay" in rd && rd.replay.note).toMatch(/^already delegated to a@example\.com\/lx at .* as message \d+; this repeat was not sent\./);
  });
});
