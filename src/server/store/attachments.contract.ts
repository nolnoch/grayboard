// The attachments store's contract, upload side (#807 P3 C10c, docs/future/postgres-server.md D9): every
// AttachmentsStore method, written once over a harness so both stores run the same rows. Not a *.test.ts file, so Bun
// doesn't discover it: a backend's test file registers it under a describe() (attachments.contract.sqlite.ts through
// db.test.ts for SQLite, pg/attachments.contract.pg.test.ts for Postgres). Core's own tests
// (src/core/attachments.test.ts) keep the local-mode flows over these statements (store, bind, release, sweep).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids are read back from the fixture or the store.
// - Times are fixed epochs passed in; no method here reads a clock.
// - The rows are serial. An interleaving (two uploads against one quota, a catalog drop racing an upload, a prune
//   racing a send's bind) is Postgres's own test (pg/attachments.pg.test.ts, races Q1-Q3): on SQLite the single writer
//   runs no two of these at once. What these rows pin is each statement's serial answer.
// - Fixture writes the store doesn't offer (a message to bind to, an attachment row as written, a bare catalog entry)
//   and the raw reads are the harness's, so no row touches a connection.
// - Owners come in both kinds: an upload bound to a post is as sent as one bound to a message.
import { expect, test } from "bun:test";
import { TooLargeError } from "../../core/errors.ts";
import { UNBOUND_TTL_MS } from "../../shared/attachments.ts";
import type { AttachmentRow, AttachmentsStore, NewUpload, Uploader } from "./attachments.ts";
import type { Read, Tx } from "./tx_base.ts";

// An attachment row as the fixture writes it; its catalog entry is added if absent.
export type UploadFixture = { sha256: string; size: number; uploader: string; principal: string | null; created_at: number; message_id?: number; post_id?: number };

// One store, fresh per row.
export type AttachmentsHarness = {
  attachments: AttachmentsStore;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction: a message or a board post (an attachment's owner), returning its id;
  // an attachment row (and its blob's catalog entry, if absent), returning its id; a catalog entry alone.
  message(): Promise<number>;
  post(): Promise<number>;
  upload(row: UploadFixture): Promise<number>;
  blob(sha256: string, size: number, createdAt: number): Promise<void>;
  // Raw reads: every attachment row by id; every catalog entry by sha256.
  rows(): Promise<AttachmentRow[]>;
  blobs(): Promise<{ sha256: string; size: number; created_at: number }[]>;
  close(): void | Promise<void>;
};

export type AttachmentsBackend = { kind: "sqlite" | "postgres"; open(): Promise<AttachmentsHarness> };

const T0 = 1_800_000_000_000;
const ME = "you@example.com", THEM = "them@example.com";
const FE = `${ME}/fe`, BE = `${ME}/be`, SIM = `${THEM}/sim`;
const SHA = (c: string) => c.repeat(64);
const mine: Uploader = { addresses: [FE, BE], principal: ME };
const BIG = { principal: ME, unsent: 1_000_000, stored: 1_000_000 };

const upload = (u: Partial<NewUpload>): NewUpload => ({ sha256: SHA("a"), filename: "a.txt", type: "text/plain", size: 10, uploader: FE, now: T0, ...u });
const fixture = (u: Partial<UploadFixture>): UploadFixture => ({ sha256: SHA("a"), size: 10, uploader: FE, principal: ME, created_at: T0, ...u });
const UNSENT_FULL = "your unsent uploads would exceed 100B; send or wait for them to expire";
const STORED_FULL = "your stored attachments would exceed 100B; they're freed as their messages and posts age out";

export function attachmentsContract(backend: AttachmentsBackend): void {
  const it = (name: string, fn: (h: AttachmentsHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  uploads(it);
  quota(it);
  unsentAndDrops(it);
  catalog(it);
}

type It = (name: string, fn: (h: AttachmentsHarness) => Promise<void>) => void;

function uploads(it: It): void {
  // AC-1.
  it("insertUpload stores the row and its catalog entry, as numbers; get returns it; the principal is the quota's or null", async h => {
    const { row, pruned } = await h.write(tx => h.attachments.insertUpload(tx, upload({ quota: BIG })));
    expect(pruned).toBe(false);
    expect(row).toEqual({
      id: row.id, sha256: SHA("a"), filename: "a.txt", type: "text/plain", size: 10, uploader: FE, uploader_principal: ME,
      message_id: null, post_id: null, created_at: T0,
    });
    expect(typeof row.id).toBe("number");
    expect(typeof row.size).toBe("number");
    expect(await h.attachments.get(h.read, row.id)).toEqual(row);
    expect(await h.attachments.get(h.read, row.id + 1000)).toBeUndefined();
    // A sent upload reads back with its owner.
    const msg = await h.message();
    const sent = await h.upload(fixture({ sha256: SHA("c"), message_id: msg }));
    expect(await h.attachments.get(h.read, sent)).toMatchObject({ id: sent, message_id: msg, post_id: null, uploader_principal: ME });
    expect((await h.blobs())[0]).toEqual({ sha256: SHA("a"), size: 10, created_at: T0 });
    // Without a quota, no principal; read inside the body that wrote it, on its Tx.
    await h.write(async tx => {
      const { row: other } = await h.attachments.insertUpload(tx, upload({ sha256: SHA("b"), uploader: BE }));
      expect(other.uploader_principal).toBeNull();
      expect((await h.attachments.get(tx, other.id))?.uploader).toBe(BE);
    });
  });

  // AC-2.
  it("identical bytes share one catalog entry, the first upload's; each upload is its own row", async h => {
    const first = await h.write(tx => h.attachments.insertUpload(tx, upload({ quota: BIG })));
    const second = await h.write(tx => h.attachments.insertUpload(tx, upload({ uploader: BE, filename: "b.txt", now: T0 + 5, quota: BIG })));
    expect(second.row.id).not.toBe(first.row.id);
    expect(await h.blobs()).toEqual([{ sha256: SHA("a"), size: 10, created_at: T0 }]);
    expect((await h.rows()).map(r => [r.filename, r.uploader, r.created_at])).toEqual([["a.txt", FE, T0], ["b.txt", BE, T0 + 5]]);
    // A catalog entry no row names (a swept upload's) is reused too.
    await h.blob(SHA("c"), 7, 1);
    await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("c"), size: 7 })));
    expect((await h.blobs()).find(b => b.sha256 === SHA("c"))).toEqual({ sha256: SHA("c"), size: 7, created_at: 1 });
  });

  // AC-3.
  it("insertUpload prunes the uploads left unbound since before its TTL, never a bound or fresher one, and says so", async h => {
    const msg = await h.message();
    const post = await h.post();
    const cut = T0 - UNBOUND_TTL_MS;
    await h.upload(fixture({ created_at: cut - 1 }));
    const edge = await h.upload(fixture({ created_at: cut, uploader: BE }));
    const sent = await h.upload(fixture({ created_at: 1, message_id: msg }));
    const posted = await h.upload(fixture({ created_at: 1, post_id: post }));
    await h.upload(fixture({ created_at: 2, uploader: SIM, principal: THEM }));
    const { row, pruned } = await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("b") })));
    expect(pruned).toBe(true);
    expect((await h.rows()).map(r => r.id)).toEqual([edge, sent, posted, row.id]);
    expect((await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("c") })))).pruned).toBe(false);
    // pruneUnbound alone: how many went.
    expect(await h.write(tx => h.attachments.pruneUnbound(tx, T0 + 1))).toBe(3);
    expect((await h.rows()).map(r => r.id)).toEqual([sent, posted]);
    expect(await h.write(tx => h.attachments.pruneUnbound(tx, T0 + 1))).toBe(0);
  });

  // AC-4.
  it("remove deletes one row and leaves its catalog entry for the sweep", async h => {
    const { row } = await h.write(tx => h.attachments.insertUpload(tx, upload({})));
    const keep = await h.upload(fixture({ sha256: SHA("b") }));
    await h.write(tx => h.attachments.remove(tx, row.id));
    expect((await h.rows()).map(r => r.id)).toEqual([keep]);
    expect((await h.blobs()).map(b => b.sha256)).toEqual([SHA("a"), SHA("b")]);
  });
}

function quota(it: It): void {
  // AC-5.
  it("the unsent quota counts the principal's unbound bytes only, whoever uploaded them, and refuses one that would pass it", async h => {
    const msg = await h.message();
    const post = await h.post();
    const q = { principal: ME, unsent: 100, stored: 1_000_000 };
    await h.upload(fixture({ sha256: SHA("a"), size: 60, uploader: BE }));
    // Bound bytes (a message's or a post's), and another principal's, don't count.
    await h.upload(fixture({ sha256: SHA("b"), size: 500, message_id: msg }));
    await h.upload(fixture({ sha256: SHA("g"), size: 500, post_id: post }));
    await h.upload(fixture({ sha256: SHA("c"), size: 50, uploader: SIM, principal: THEM }));
    const before = await h.rows();
    await expect(h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("d"), size: 41, quota: q })))).rejects.toThrow(TooLargeError);
    await expect(h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("d"), size: 41, quota: q })))).rejects.toThrow(UNSENT_FULL);
    // A blob another principal holds is still new to this one: its bytes count (60 + 50 > 100).
    await expect(h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("c"), size: 50, quota: q })))).rejects.toThrow(UNSENT_FULL);
    expect(await h.rows()).toEqual(before);
    // Up to the cap fits; the same blob again adds nothing.
    await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("d"), size: 40, quota: q })));
    await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("a"), size: 60, quota: q })));
    await expect(h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("e"), size: 1, quota: q })))).rejects.toThrow(UNSENT_FULL);
    expect((await h.rows()).length).toBe(before.length + 2);
  });

  // AC-6.
  it("the stored quota counts each of the principal's blobs once, sent or not, and refuses one that would pass it", async h => {
    const msg = await h.message();
    const post = await h.post();
    const q = { principal: ME, unsent: 1_000_000, stored: 100 };
    // One blob, uploaded twice (once sent): 30 bytes, not 60.
    await h.upload(fixture({ sha256: SHA("a"), size: 30, message_id: msg }));
    await h.upload(fixture({ sha256: SHA("a"), size: 30, uploader: BE }));
    // A sent-only blob (on a post): stored, never unsent.
    await h.upload(fixture({ sha256: SHA("f"), size: 30, post_id: post }));
    await h.upload(fixture({ sha256: SHA("b"), size: 500, uploader: SIM, principal: THEM }));
    await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("c"), size: 40, quota: q })));
    // Full at 100 stored (30 + 30 + 40), with 70 unsent: a new blob is refused over the stored cap, one the principal
    // already stores isn't.
    await expect(h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("d"), size: 1, quota: q })))).rejects.toThrow(STORED_FULL);
    await h.write(tx => h.attachments.insertUpload(tx, upload({ sha256: SHA("a"), size: 30, quota: q })));
    expect((await h.rows()).filter(r => r.uploader_principal === ME).map(r => r.sha256)).toEqual([SHA("a"), SHA("a"), SHA("f"), SHA("c"), SHA("a")]);
  });
}

function unsentAndDrops(it: It): void {
  // AC-7.
  it("unsentDigests answers in call order, over any of the uploader's addresses, and refuses an id that isn't its unsent upload", async h => {
    const msg = await h.message();
    const a = await h.upload(fixture({ sha256: SHA("a") }));
    const b = await h.upload(fixture({ sha256: SHA("b"), uploader: BE }));
    const c = await h.upload(fixture({ sha256: SHA("c") }));
    const sent = await h.upload(fixture({ sha256: SHA("d"), message_id: msg }));
    const theirs = await h.upload(fixture({ sha256: SHA("e"), uploader: SIM, principal: THEM }));
    // Another user's upload from one of my addresses (a team alias rebound, #367).
    const rebound = await h.upload(fixture({ sha256: SHA("f"), principal: THEM }));
    expect(await h.attachments.unsentDigests(h.read, [c, a, b], mine)).toEqual([SHA("c"), SHA("a"), SHA("b")]);
    expect(await h.attachments.unsentDigests(h.read, [], mine)).toEqual([]);
    for (const id of [sent, theirs, rebound, theirs + 1000]) {
      await expect(h.attachments.unsentDigests(h.read, [a, id], mine)).rejects.toThrow(`attachment ${id} isn't an unsent upload of yours`);
    }
    // Local mode (no principal) matches by address alone.
    expect(await h.attachments.unsentDigests(h.read, [rebound], { addresses: [FE], principal: null })).toEqual([SHA("f")]);
    // On the body's Tx.
    expect(await h.write(tx => h.attachments.unsentDigests(tx, [b], mine))).toEqual([SHA("b")]);
  });

  // AC-8.
  it("dropUnsent deletes only the uploader's unsent uploads among ids and returns them, in no set order", async h => {
    const msg = await h.message();
    const a = await h.upload(fixture({ sha256: SHA("a") }));
    const b = await h.upload(fixture({ sha256: SHA("b"), uploader: BE }));
    const sent = await h.upload(fixture({ sha256: SHA("c"), message_id: msg }));
    const theirs = await h.upload(fixture({ sha256: SHA("d"), uploader: SIM, principal: THEM }));
    const keep = await h.upload(fixture({ sha256: SHA("e") }));
    const gone = (await h.write(tx => h.attachments.dropUnsent(tx, [b, sent, theirs, a, 9_999], mine))).sort((x, y) => x.id - y.id);
    expect(gone.map(r => [r.id, r.sha256, r.uploader_principal, r.message_id])).toEqual([[a, SHA("a"), ME, null], [b, SHA("b"), ME, null]]);
    expect(gone[0]).toEqual({ id: a, sha256: SHA("a"), filename: expect.any(String), type: expect.any(String), size: 10, uploader: FE, uploader_principal: ME, message_id: null, post_id: null, created_at: T0 });
    expect((await h.rows()).map(r => r.id)).toEqual([sent, theirs, keep]);
    expect(await h.write(tx => h.attachments.dropUnsent(tx, [], mine))).toEqual([]);
    expect(await h.write(tx => h.attachments.dropUnsent(tx, [a], mine))).toEqual([]);
  });
}

function catalog(it: It): void {
  // AC-9.
  it("the catalog's unnamed blobs, named, and dropBlobEntry: an unnamed entry goes once; a named one answers 0 and stays", async h => {
    await h.upload(fixture({ sha256: SHA("a") }));
    await h.blob(SHA("b"), 5, 1);
    await h.blob(SHA("c"), 6, 2);
    expect([...await h.attachments.unnamedBlobs(h.read)].sort()).toEqual([SHA("b"), SHA("c")]);
    expect(await h.attachments.named(h.read, SHA("a"))).toBe(true);
    expect(await h.attachments.named(h.read, SHA("b"))).toBe(false);
    expect(await h.attachments.named(h.read, SHA("z"))).toBe(false);
    // A named blob's drop answers 0, and the body goes on to commit its other drop.
    const out = await h.write(async tx => [await h.attachments.dropBlobEntry(tx, SHA("a")), await h.attachments.dropBlobEntry(tx, SHA("b"))]);
    expect(out).toEqual([0, 1]);
    expect(await h.write(tx => h.attachments.dropBlobEntry(tx, SHA("b")))).toBe(0);
    expect(await h.write(tx => h.attachments.dropBlobEntry(tx, SHA("z")))).toBe(0);
    expect((await h.blobs()).map(b => b.sha256)).toEqual([SHA("a"), SHA("c")]);
    expect(await h.attachments.unnamedBlobs(h.read)).toEqual([SHA("c")]);
  });
}
