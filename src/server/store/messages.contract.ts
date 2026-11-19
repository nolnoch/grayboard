// The messages store's contract (#807 P3 C5, docs/future/postgres-server.md D9): every MessagesStore method, written once
// over a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test
// file registers it under a describe() (messages.contract.sqlite.ts through db.test.ts for SQLite,
// pg/messages.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids are compared to the rows the row itself made.
// - Every time is a fixed epoch set on the store's clock (setNow) or passed in; nothing reads a wall clock.
// - The rows are serial. An interleaving (a retract racing a reply, an ack or a delivery stamp; a prune racing a reply;
//   two sends binding one upload) is a backend's own test: Postgres runs them on two connections (C5b's
//   pg/messages.pg.test.ts). What these rows pin is each method's serial answer, and that a refusal leaves nothing
//   behind even when the caller catches it and commits, so no caller needs a savepoint around a store call.
// - The store is opened with MESSAGE_LIMITS as its attachment caps.
// - Fixture writes the store doesn't offer (an upload, a read point, a board and post, a delegation's audit row, a
//   bounce) and the raw reads (ids, acks, attachment rows, an action's audit rows) are the harness's. Audit detail
//   comes back parsed, with detail_type the stored JSON's type as the database computes it (SQLite json_type, Postgres
//   jsonb_typeof): a double-stringified object reads "text"/"string", not "object".
import { expect, test } from "bun:test";
import { CoreError, TooLargeError } from "../../core/errors.ts";
import type { AttachmentLimits } from "../../shared/attachments.ts";
import { MissingParent } from "./errors.ts";
import type { MessageRow, MessagesStore } from "./messages.ts";
import type { Read, Tx } from "./tx_base.ts";

export const MESSAGE_LIMITS: AttachmentLimits = { file: 100, total: 150 };

// One store, fresh per row.
export type MessagesHarness = {
  messages: MessagesStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // The store's clock, for the rows it stamps (created_at, acked_at, the retract's audit row).
  setNow(ms: number): void;
  // Fixture writes, each in its own transaction:
  // - an unsent upload by `uploader` (an address) for `principal` (its user, or null), of `size` bytes, its id;
  // - a direct read point (mailbox_cursors) for the address;
  // - a post on `board` (made with `scope` if absent) by `author`, with its writer's user or null, its id;
  // - a delegation.requested audit row at `at` targeting `target`, detail { message_id }, as delegate writes it;
  // - a bounce from `sender` (kind 'bounce') to `recipient` at `at`, its id.
  upload(uploader: string, principal: string | null, size: number): Promise<number>;
  cursor(address: string, lastSeenId: number): Promise<void>;
  post(board: string, scope: string | null, author: string, authorUser: string | null): Promise<number>;
  delegation(target: string, at: number, messageId: number): Promise<void>;
  bounce(sender: string, recipient: string, parentId: number | null, at: number): Promise<number>;
  // Raw reads: every message's id and parent_id, by id; every ack; every attachment's id and message_id, by id; an
  // action's access_log rows in write order.
  messageRows(): Promise<{ id: number; parent_id: number | null }[]>;
  ackRows(): Promise<{ reader: string; message_id: number }[]>;
  attachmentRows(): Promise<{ id: number; message_id: number | null }[]>;
  audits(action: string): Promise<{ actor: string | null; target: string | null; detail: unknown; detail_type: string | null }[]>;
  close(): void | Promise<void>;
};

export type MessagesBackend = { kind: "sqlite" | "postgres"; open(): Promise<MessagesHarness> };

const T0 = 1_800_000_000_000;
const A = "a@example.com/fe", B = "b@example.com/be", C = "c@example.com/qa", ID = "id:s1";
const ids = (rows: { id: number }[]) => rows.map(m => m.id);

export function messagesContract(backend: MessagesBackend): void {
  const it = (name: string, fn: (h: MessagesHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    h.setNow(T0);
    try { await fn(h); } finally { await h.close(); }
  });
  inserts(it);
  reads(it);
  acksAndRetract(it);
}

type It = (name: string, fn: (h: MessagesHarness) => Promise<void>) => void;

const send = (h: MessagesHarness, from: string, to: string, body: string, parentId: number | null = null, pending = false) =>
  h.write(tx => h.messages.insert(tx, from, "user", to, body, parentId, pending));
// The error a body's call rejects with, caught inside the body so the write commits.
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

function inserts(it: It): void {
  // M1.
  it("insert returns the row: numeric ids and times, pending 0 or 1, the columns it was given; getById reads it back", async h => {
    h.setNow(T0 + 7);
    const root = await send(h, A, B, "hello");
    expect(root).toEqual({ id: expect.any(Number), sender: A, recipient_type: "user", recipient: B, body: "hello", parent_id: null, created_at: T0 + 7, delivered_at: null, pending: 0, kind: null, via: null });
    h.setNow(T0 + 8);
    const reply = await h.write(tx => h.messages.insert(tx, B, "user", A, "hi", root.id, true, undefined, "sess-1", "child-1", "b@example.com"));
    expect(reply).toEqual({ id: expect.any(Number), sender: B, recipient_type: "user", recipient: A, body: "hi", parent_id: root.id, created_at: T0 + 8, delivered_at: null, pending: 1, kind: null, via: "child-1" });
    expect(reply.id).toBeGreaterThan(root.id);
    const team = await h.write(tx => h.messages.insert(tx, A, "team", "eng", "all", null));
    expect(team.recipient_type).toBe("team");
    for (const m of [root, reply, team]) expect(await h.messages.getById(h.read, m.id)).toEqual(m);
    expect(await h.messages.getById(h.read, team.id + 1000)).toBeUndefined();
    // Read inside the body that wrote it, on its Tx.
    await h.write(async tx => {
      const m = await h.messages.insert(tx, A, "user", B, "inside", null);
      expect(await h.messages.getById(tx, m.id)).toEqual(m);
    });
  });

  // M2.
  it("insert binds the sender's unsent uploads and returns them in call order; every read that returns rows carries them", async h => {
    const f1 = await h.upload(A, "a@example.com", 10);
    const f2 = await h.upload(ID, "a@example.com", 20);
    const m = await h.write(tx => h.messages.insert(tx, A, "user", B, "files", null, true, { ids: [f2, f1], uploader: { addresses: [A, ID], principal: "a@example.com" } }));
    expect(m.attachments).toEqual([
      { id: f2, filename: expect.any(String), type: expect.any(String), size: 20, sha256: expect.any(String) },
      { id: f1, filename: expect.any(String), type: expect.any(String), size: 10, sha256: expect.any(String) },
    ]);
    expect(await h.attachmentRows()).toEqual([{ id: f1, message_id: m.id }, { id: f2, message_id: m.id }]);
    const plain = await send(h, B, A, "no files", m.id);
    // Reads list a message's files in id order; a message without any has no attachments key.
    const files = [f1, f2];
    const att = (rows: MessageRow[]) => rows.map(r => [r.id, r.attachments?.map(a => a.id)]);
    expect(att(await h.messages.history(h.read, [A]))).toEqual([[plain.id, undefined], [m.id, files]]);
    expect(att(await h.messages.thread(h.read, plain.id))).toEqual([[m.id, files], [plain.id, undefined]]);
    expect(att(await h.messages.unreadSince(h.read, [{ type: "direct", ref: B, since: 0 }]))).toEqual([[m.id, files]]);
    expect(att(await h.messages.receivedUnacked(h.read, [B], 0))).toEqual([[m.id, files]]);
    expect(att(await h.messages.sentPending(h.read, [A], 0))).toEqual([[m.id, files]]);
    expect((await h.messages.getById(h.read, m.id))?.attachments).toBeUndefined();
    // No files, and an empty list, bind nothing.
    const none = await h.write(tx => h.messages.insert(tx, A, "user", B, "empty", null, false, { ids: [], uploader: { addresses: [A], principal: "a@example.com" } }));
    expect(none.attachments).toBeUndefined();
  });

  // M3.
  it("insert refuses an unknown, foreign, other user's or already-sent upload with CoreError, leaving no message and no bind even when the caller commits", async h => {
    const mine = await h.upload(A, "a@example.com", 10);
    const theirs = await h.upload(B, "b@example.com", 10);
    const otherUser = await h.upload(A, "x@example.com", 10);
    const sent = await h.upload(A, "a@example.com", 10);
    const first = await h.write(tx => h.messages.insert(tx, A, "user", B, "first", null, false, { ids: [sent], uploader: { addresses: [A], principal: "a@example.com" } }));
    const before = await h.messageRows();
    for (const bad of [mine + theirs + otherUser + sent + 1000, theirs, otherUser, sent]) {
      const e = await h.write(tx => caught(() => h.messages.insert(tx, A, "user", B, "refused", null, false, { ids: [mine, bad], uploader: { addresses: [A], principal: "a@example.com" } })));
      expect(e).toBeInstanceOf(CoreError);
      expect((e as Error).message).toBe(`attachment ${bad} isn't an unsent upload of yours`);
    }
    expect(await h.messageRows()).toEqual(before);
    expect(await h.attachmentRows()).toEqual([
      { id: mine, message_id: null }, { id: theirs, message_id: null }, { id: otherUser, message_id: null }, { id: sent, message_id: first.id },
    ].sort((x, y) => x.id - y.id));
    // The upload a refused send named stays free for the next.
    const ok = await h.write(tx => h.messages.insert(tx, A, "user", B, "ok", null, false, { ids: [mine], uploader: { addresses: [A], principal: "a@example.com" } }));
    expect(ok.attachments?.map(a => a.id)).toEqual([mine]);
  });

  // M4.
  it("insert refuses files over the per-message total with TooLargeError, binding nothing", async h => {
    const f1 = await h.upload(A, null, 80);
    const f2 = await h.upload(A, null, 80);
    const before = await h.messageRows();
    const e = await h.write(tx => caught(() => h.messages.insert(tx, A, "user", B, "big", null, false, { ids: [f1, f2], uploader: { addresses: [A], principal: null } })));
    expect(e).toBeInstanceOf(TooLargeError);
    expect((e as Error).message).toMatch(/^attachments exceed .* in all$/);
    expect(await h.messageRows()).toEqual(before);
    expect(await h.attachmentRows()).toEqual([{ id: f1, message_id: null }, { id: f2, message_id: null }]);
    // At the total, it binds (principal null: local-mode uploads, any principal's).
    const f3 = await h.upload(A, null, 70);
    const m = await h.write(tx => h.messages.insert(tx, A, "user", B, "fits", null, false, { ids: [f1, f3], uploader: { addresses: [A], principal: null } }));
    expect(m.attachments?.map(a => a.id)).toEqual([f1, f3]);
  });

  // M5.
  it("insert with a parent_id naming no message refuses as a missing parent, writing nothing", async h => {
    const root = await send(h, A, B, "root");
    const f = await h.upload(A, "a@example.com", 10);
    const e = await h.write(tx => caught(() => h.messages.insert(tx, B, "user", A, "orphan", root.id + 1000, false, { ids: [f], uploader: { addresses: [A], principal: "a@example.com" } })));
    expect(e).toBeInstanceOf(MissingParent);
    expect((e as Error).message).toBe(`parent_id ${root.id + 1000} is not a message you sent or received`);
    expect(await h.messageRows()).toEqual([{ id: root.id, parent_id: null }]);
    expect(await h.attachmentRows()).toEqual([{ id: f, message_id: null }]);
  });

  // M21.
  it("a store refusal a body doesn't catch rolls the whole body back", async h => {
    const before = await h.messageRows();
    await expect(h.write(async tx => {
      await h.messages.insert(tx, A, "user", B, "first", null);
      await h.messages.insert(tx, A, "user", B, "second", null, false, { ids: [4242], uploader: { addresses: [A], principal: null } });
    })).rejects.toBeInstanceOf(CoreError);
    expect(await h.messageRows()).toEqual(before);
  });
}

function reads(it: It): void {
  // M6.
  it("writerUsers maps each message and post to its writer's user where one was recorded, and service-board posts to author, board and scope", async h => {
    const withUser = await h.write(tx => h.messages.insert(tx, A, "user", B, "m", null, false, undefined, null, null, "a@example.com"));
    const without = await send(h, A, B, "no user");
    const open = await h.post("open", null, A, "a@example.com");
    const anon = await h.post("open", null, B, null);
    const svc = await h.post("svc-board", "service:svc", "svc/w", "owner@example.com");
    const svcAnon = await h.post("svc-board", "service:svc", "svc/x", null);
    const teamPost = await h.post("eng", "team:eng", C, "c@example.com");
    const lookalike = await h.post("odd", "team:service:x", C, null);
    const out = await h.messages.writerUsers(h.read, [withUser.id, without.id, without.id + 1000], [open, anon, svc, svcAnon, teamPost, lookalike]);
    expect(out.messages).toEqual(new Map([[withUser.id, "a@example.com"]]));
    expect(out.posts).toEqual(new Map([[open, "a@example.com"], [svc, "owner@example.com"], [teamPost, "c@example.com"]]));
    expect(out.servicePosts).toEqual(new Map([
      [svc, { author: "svc/w", board: "svc-board", scope: "service:svc" }],
      [svcAnon, { author: "svc/x", board: "svc-board", scope: "service:svc" }],
    ]));
    expect(await h.messages.writerUsers(h.read, [], [])).toEqual({ messages: new Map(), posts: new Map(), servicePosts: new Map() });
  });

  // M7.
  it("delegationIds names the messages with a delegation.requested row for their recipient within a minute of them", async h => {
    h.setNow(T0);
    const hit = await send(h, A, B, "delegated");
    const early = await send(h, A, B, "window, before");
    const late = await send(h, A, B, "outside");
    const wrongTarget = await send(h, A, B, "other target");
    const plain = await send(h, A, B, "not delegated");
    const twice = await send(h, A, C, "two rows");
    await h.delegation(B, T0 + 30_000, hit.id);
    await h.delegation(B, T0 - 60_000, early.id);
    await h.delegation(B, T0 + 61_000, late.id);
    await h.delegation(C, T0, wrongTarget.id);
    await h.delegation(B, T0, twice.id);
    await h.delegation(C, T0 + 1, twice.id);
    await h.delegation(C, T0 + 2, twice.id);
    expect(await h.messages.delegationIds(h.read, [hit.id, early.id, late.id, wrongTarget.id, plain.id, twice.id])).toEqual(new Set([hit.id, early.id, twice.id]));
    expect(await h.messages.delegationIds(h.read, [plain.id])).toEqual(new Set());
    expect(await h.messages.delegationIds(h.read, [])).toEqual(new Set());
  });

  // M8.
  it("bouncesFrom returns an ID's bounces at or after since, by id", async h => {
    const m = await send(h, B, ID, "to the id");
    const b1 = await h.bounce(ID, B, m.id, T0 + 10);
    const b2 = await h.bounce(ID, A, null, T0 + 20);
    await h.bounce("id:other", B, null, T0 + 20);
    await send(h, ID, B, "a plain message from the id");
    expect(ids(await h.messages.bouncesFrom(h.read, ID))).toEqual([b1, b2]);
    expect(ids(await h.messages.bouncesFrom(h.read, ID, T0 + 20))).toEqual([b2]);
    expect(await h.messages.bouncesFrom(h.read, ID, T0 + 21)).toEqual([]);
    expect((await h.messages.bouncesFrom(h.read, ID))[0]).toMatchObject({ sender: ID, recipient: B, parent_id: m.id, created_at: T0 + 10, kind: "bounce", pending: 0 });
  });

  // M9, M13, M14: a session reads as every address it has, its ID and its alias (#284 S8).
  it("history, undeliveredFrom, receivedUnacked and sentPending take an address set", async h => {
    const set = [ID, A];
    const toId = await send(h, B, ID, "to the id");
    const fromAlias = await send(h, A, B, "from the alias", null, true);
    const toAlias = await send(h, B, A, "to the alias");
    const fromId = await send(h, ID, C, "from the id", null, true);
    await send(h, B, C, "not ours");
    expect(ids(await h.messages.history(h.read, set))).toEqual([fromId.id, toAlias.id, fromAlias.id, toId.id]);
    expect(ids(await h.messages.history(h.read, set, B))).toEqual([toAlias.id, fromAlias.id, toId.id]);
    expect(ids(await h.messages.history(h.read, set, B, 20, toAlias.id))).toEqual([fromAlias.id, toId.id]);
    expect(ids(await h.messages.history(h.read, [A]))).toEqual([toAlias.id, fromAlias.id]);
    expect(await h.messages.undeliveredFrom(h.read, set)).toEqual([
      { recipient: B, n: 1, oldest_id: fromAlias.id },
      { recipient: C, n: 1, oldest_id: fromId.id },
    ]);
    expect(ids(await h.messages.receivedUnacked(h.read, set, 0))).toEqual([toId.id, toAlias.id]);
    expect(ids(await h.messages.sentPending(h.read, set, 0))).toEqual([fromAlias.id, fromId.id]);
    // An ack counts for the address the row names, not any address of the set.
    await h.write(tx => h.messages.ack(tx, A, toId.id));
    expect(ids(await h.messages.receivedUnacked(h.read, set, 0))).toEqual([toId.id, toAlias.id]);
    await h.write(async tx => {
      await h.messages.ack(tx, ID, toId.id);
      await h.messages.ack(tx, ID, fromId.id);
    });
    expect(ids(await h.messages.receivedUnacked(h.read, set, 0))).toEqual([toAlias.id]);
    expect(ids(await h.messages.sentPending(h.read, set, 0))).toEqual([fromAlias.id]);
  });

  // M9.
  it("history: newest first, at most 200 whatever the limit, before beforeId; a team message to the set isn't received", async h => {
    const sent = await h.write(async tx => {
      const out: number[] = [];
      for (let i = 0; i < 201; i++) out.push((await h.messages.insert(tx, A, "user", B, `m${i}`, null)).id);
      return out;
    });
    const newest = [...sent].reverse();
    expect(ids(await h.messages.history(h.read, [A]))).toEqual(newest.slice(0, 20));
    expect(ids(await h.messages.history(h.read, [A], undefined, 1000))).toEqual(newest.slice(0, 200));
    expect(ids(await h.messages.history(h.read, [A], B, 1000))).toEqual(newest.slice(0, 200));
    expect(ids(await h.messages.history(h.read, [A], undefined, 3, sent[10]))).toEqual([sent[9], sent[8], sent[7]]);
    expect(ids(await h.messages.history(h.read, [B], A, 2, sent[1]))).toEqual([sent[0]]);
    const team = await h.write(tx => h.messages.insert(tx, C, "team", B, "a team stream named like B", null));
    expect(ids(await h.messages.history(h.read, [B], undefined, 1))).toEqual([sent[200]]);
    expect(ids(await h.messages.history(h.read, [B], C))).toEqual([]);
    expect(team.id).toBeGreaterThan(sent[200]!);
  });

  // M10.
  it("thread from any node returns the whole thread, root to leaves, by id", async h => {
    const root = await send(h, A, B, "root");
    const mid = await send(h, B, A, "mid", root.id);
    await send(h, C, A, "unrelated");
    const leaf = await send(h, A, B, "leaf", mid.id);
    const side = await send(h, A, B, "side", root.id);
    const all = [root.id, mid.id, leaf.id, side.id];
    expect(ids(await h.messages.thread(h.read, mid.id))).toEqual(all);
    expect(ids(await h.messages.thread(h.read, leaf.id))).toEqual(all);
    expect(ids(await h.messages.thread(h.read, root.id))).toEqual(all);
    expect(await h.messages.thread(h.read, side.id + 1000)).toEqual([]);
  });

  // M11.
  it("unreadSince returns each stream's messages past its point, merged by id", async h => {
    const d1 = await send(h, A, B, "d1");
    const t1 = await h.write(tx => h.messages.insert(tx, A, "team", "eng", "t1", null));
    const d2 = await send(h, C, B, "d2");
    const t2 = await h.write(tx => h.messages.insert(tx, C, "team", "eng", "t2", null));
    await h.write(tx => h.messages.insert(tx, A, "team", B, "team stream named like B", null));
    const d3 = await send(h, A, B, "d3");
    expect(ids(await h.messages.unreadSince(h.read, [{ type: "team", ref: "eng", since: 0 }, { type: "direct", ref: B, since: d1.id }]))).toEqual([t1.id, d2.id, t2.id, d3.id]);
    expect(ids(await h.messages.unreadSince(h.read, [{ type: "direct", ref: B, since: d2.id }]))).toEqual([d3.id]);
    expect(await h.messages.unreadSince(h.read, [])).toEqual([]);
  });

  // M12.
  it("queuedTo counts each recipient's direct messages past its read point from others; none is absent", async h => {
    const first = await send(h, A, B, "1");
    await send(h, C, B, "2");
    await send(h, A, B, "3");
    await send(h, B, B, "to itself");
    await h.write(tx => h.messages.insert(tx, A, "team", B, "team", null));
    await send(h, A, C, "to C");
    await h.cursor(B, first.id);
    const q = await h.messages.queuedTo(h.read, [B, C, ID]);
    expect(q).toEqual(new Map([[B, 2], [C, 1]]));
    expect(typeof q.get(B)).toBe("number");
    expect(await h.messages.queuedTo(h.read, [])).toEqual(new Map());
  });

  // M13.
  it("undeliveredFrom: per recipient in byte order, numeric counts, past the read point, undelivered, older than the bound", async h => {
    const lower = "a@example.com/a_b", upper = "a@example.com/aB", cap = "A@example.com/x";
    h.setNow(T0);
    const toLower = await send(h, C, lower, "1");
    await send(h, C, lower, "2");
    const toUpper = await send(h, C, upper, "3");
    const toCap = await send(h, C, cap, "4");
    await send(h, C, C, "to itself");
    h.setNow(T0 + 100);
    const young = await send(h, C, ID, "young");
    const read = await send(h, C, B, "read");
    const delivered = await send(h, C, A, "delivered");
    await h.cursor(B, read.id);
    await h.write(tx => h.messages.markDelivered(tx, delivered.id, T0 + 101));
    const out = await h.messages.undeliveredFrom(h.read, [C]);
    expect(out).toEqual([
      { recipient: cap, n: 1, oldest_id: toCap.id },
      { recipient: upper, n: 1, oldest_id: toUpper.id },
      { recipient: lower, n: 2, oldest_id: toLower.id },
      { recipient: ID, n: 1, oldest_id: young.id },
    ]);
    expect(typeof out[0]!.n).toBe("number");
    expect(typeof out[0]!.oldest_id).toBe("number");
    expect((await h.messages.undeliveredFrom(h.read, [C], T0 + 100)).map(u => u.recipient)).toEqual([cap, upper, lower]);
    expect(await h.messages.undeliveredFrom(h.read, [A])).toEqual([]);
  });

  // M14.
  it("receivedUnacked and sentPending: since bounds them; sentPending is only pending, receivedUnacked leaves out self-sends; team messages are neither", async h => {
    h.setNow(T0);
    const old = await send(h, A, B, "old", null, true);
    h.setNow(T0 + 10);
    const fresh = await send(h, A, B, "fresh", null, true);
    const notPending = await send(h, A, B, "not pending");
    const self = await send(h, B, B, "to itself", null, true);
    await h.write(tx => h.messages.insert(tx, A, "team", B, "team", null, true));
    expect(ids(await h.messages.receivedUnacked(h.read, [B], 0))).toEqual([old.id, fresh.id, notPending.id]);
    expect(ids(await h.messages.receivedUnacked(h.read, [B], T0 + 10))).toEqual([fresh.id, notPending.id]);
    expect(ids(await h.messages.sentPending(h.read, [A], 0))).toEqual([old.id, fresh.id]);
    expect(ids(await h.messages.sentPending(h.read, [A], T0 + 10))).toEqual([fresh.id]);
    // The sender's ack ends its pending; the recipient's, its unacked.
    await h.write(tx => h.messages.ack(tx, A, old.id));
    await h.write(tx => h.messages.ack(tx, B, fresh.id));
    expect(ids(await h.messages.sentPending(h.read, [A], 0))).toEqual([fresh.id]);
    expect(ids(await h.messages.receivedUnacked(h.read, [B], 0))).toEqual([old.id, notPending.id]);
    // A pending self-send waits on its sender's ack like any other.
    expect(ids(await h.messages.sentPending(h.read, [B], 0))).toEqual([self.id]);
  });
}

function acksAndRetract(it: It): void {
  // M15, M16.
  it("ack twice is one row; an ack of an absent message writes nothing", async h => {
    const m = await send(h, A, B, "m");
    await h.write(async tx => {
      await h.messages.ack(tx, B, m.id);
      await h.messages.ack(tx, B, m.id);
    });
    await h.write(tx => h.messages.ack(tx, B, m.id));
    await h.write(tx => h.messages.ack(tx, A, m.id));
    await h.write(tx => h.messages.ack(tx, B, m.id + 1000));
    expect(await h.ackRows()).toEqual(expect.arrayContaining([{ reader: B, message_id: m.id }, { reader: A, message_id: m.id }]));
    expect(await h.ackRows()).toHaveLength(2);
  });

  // M17.
  it("markDelivered stamps a message once: the first stamp stands", async h => {
    const m = await send(h, A, B, "m");
    await h.write(tx => h.messages.markDelivered(tx, m.id, T0 + 5));
    await h.write(tx => h.messages.markDelivered(tx, m.id, T0 + 9));
    expect((await h.messages.getById(h.read, m.id))?.delivered_at).toBe(T0 + 5);
    await h.write(tx => h.messages.markDelivered(tx, m.id + 1000, T0 + 9));
  });

  // M18.
  it("retract deletes an unread, unanswered message with its acks and files, and audits it once as an object", async h => {
    const f = await h.upload(A, "a@example.com", 10);
    const m = await h.write(tx => h.messages.insert(tx, A, "user", B, "oops", null, false, { ids: [f], uploader: { addresses: [A], principal: "a@example.com" } }));
    const kept = await send(h, A, B, "kept");
    await h.write(tx => h.messages.ack(tx, A, m.id));
    await h.write(tx => h.messages.ack(tx, A, kept.id));
    h.setNow(T0 + 40);
    expect(await h.write(tx => h.messages.retract(tx, A, m.id, { actor: "a@example.com", session: "sess-1" }))).toBe("retracted");
    expect(await h.messages.getById(h.read, m.id)).toBeUndefined();
    expect(await h.messageRows()).toEqual([{ id: kept.id, parent_id: null }]);
    expect(await h.ackRows()).toEqual([{ reader: A, message_id: kept.id }]);
    expect(await h.attachmentRows()).toEqual([]);
    expect(await h.audits("message.retracted")).toEqual([{
      actor: "a@example.com", target: `message:${m.id}`, detail_type: "object",
      detail: { message_id: m.id, sender: A, recipient: B, session: "sess-1" },
    }]);
  });

  // M19.
  it("retract says why it didn't: gone, read or replied, writing nothing", async h => {
    const mine = await send(h, A, B, "mine");
    const team = await h.write(tx => h.messages.insert(tx, A, "team", "eng", "team", null));
    const delivered = await send(h, A, B, "delivered");
    const replied = await send(h, A, B, "replied");
    await send(h, B, A, "the reply", replied.id);
    const both = await send(h, A, B, "delivered and replied");
    await send(h, B, A, "its reply", both.id);
    const toC = await send(h, A, C, "past C's read point");
    const toC2 = await send(h, A, C, "at C's read point");
    const toC3 = await send(h, A, C, "past it still");
    await h.write(async tx => {
      await h.messages.markDelivered(tx, delivered.id, T0 + 1);
      await h.messages.markDelivered(tx, both.id, T0 + 1);
    });
    await h.cursor(C, toC2.id);
    const before = await h.messageRows();
    const retract = (sender: string, id: number) => h.write(tx => h.messages.retract(tx, sender, id, { actor: null, session: null }));
    expect(await retract(B, mine.id)).toBe("gone");
    expect(await retract(A, team.id)).toBe("gone");
    expect(await retract(A, toC3.id + 1000)).toBe("gone");
    expect(await retract(A, delivered.id)).toBe("read");
    expect(await retract(A, toC.id)).toBe("read");
    expect(await retract(A, toC2.id)).toBe("read");
    expect(await retract(A, replied.id)).toBe("replied");
    expect(await retract(A, both.id)).toBe("read");
    expect(await h.messageRows()).toEqual(before);
    expect(await h.audits("message.retracted")).toEqual([]);
    expect(await retract(A, toC3.id)).toBe("retracted");
    expect(await retract(A, mine.id)).toBe("retracted");
    expect(await retract(A, mine.id)).toBe("gone");
  });

  // M20.
  it("prune deletes old messages with their acks and files; a young reply to one stays, as a root", async h => {
    h.setNow(T0);
    const f = await h.upload(A, "a@example.com", 10);
    const old = await h.write(tx => h.messages.insert(tx, A, "user", B, "old", null, false, { ids: [f], uploader: { addresses: [A], principal: "a@example.com" } }));
    const oldReply = await send(h, B, A, "old reply", old.id);
    h.setNow(T0 + 100);
    const reply = await send(h, B, A, "young reply", old.id);
    const young = await send(h, A, B, "young");
    const g = await h.upload(A, "a@example.com", 10);
    const youngFile = await h.write(tx => h.messages.insert(tx, A, "user", B, "young file", null, false, { ids: [g], uploader: { addresses: [A], principal: "a@example.com" } }));
    await h.write(async tx => {
      await h.messages.ack(tx, B, old.id);
      await h.messages.ack(tx, A, oldReply.id);
      await h.messages.ack(tx, B, young.id);
    });
    await h.write(tx => h.messages.prune(tx, T0 + 50));
    expect(await h.messageRows()).toEqual([{ id: reply.id, parent_id: null }, { id: young.id, parent_id: null }, { id: youngFile.id, parent_id: null }]);
    expect(await h.ackRows()).toEqual([{ reader: B, message_id: young.id }]);
    expect(await h.attachmentRows()).toEqual([{ id: g, message_id: youngFile.id }]);
    expect(ids(await h.messages.thread(h.read, reply.id))).toEqual([reply.id]);
    // Nothing old left: a second prune is a no-op.
    await h.write(tx => h.messages.prune(tx, T0 + 50));
    expect(await h.messageRows()).toHaveLength(3);
  });
}
