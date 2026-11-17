// #807 P1b-4c-2: the server's attachment store, release and blob sweep write through its write queue (D4). One that
// starts while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, test } from "bun:test";
import { until } from "../../tests/support/until.ts";
import { seed } from "../../tests/support/seed.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { releaseStored, storeUpload, sweepStoredBlobs } from "./attachments.ts";
import { sha256Hex } from "../shared/hash.ts";
import { queueFor } from "./store/queue.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gb-attq-"));
  const opened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => opened.db.close());
  return opened;
}

function hold(db: object): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  return { release, done };
}

const rows = (db: ReturnType<typeof setup>["db"]) => (db.prepare(`SELECT id FROM attachments`).all() as { id: number }[]).map(r => r.id);
const catalog = (db: ReturnType<typeof setup>["db"]) => (db.prepare(`SELECT sha256 FROM attachment_blobs`).all() as { sha256: string }[]).map(r => r.sha256);
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const file = (text: string) => ({ filename: "a.txt", type: "text/plain", data: new TextEncoder().encode(text) });

test("#807: an upload stored while another body holds the write queue waits, then commits", async () => {
  const { db, repo } = setup();
  const holder = hold(db);
  const stored = storeUpload(repo, "you@example.com", "be", file("hello"));
  await ticks();
  expect(rows(db)).toEqual([]);
  holder.release();
  await holder.done;
  const row = await stored;
  expect(rows(db)).toEqual([row.id]);
});

test("#807: an upload released while another body holds the write queue waits, then deletes it", async () => {
  const { db, repo } = setup();
  const row = await storeUpload(repo, "you@example.com", "be", file("hello"));
  const holder = hold(db);
  const released = releaseStored(repo, "you@example.com", "be", row.id);
  await ticks();
  expect(rows(db)).toEqual([row.id]);
  holder.release();
  await holder.done;
  expect((await released)?.id).toBe(row.id);
  expect(rows(db)).toEqual([]);
});

test("#807: a server blob sweep's catalog delete waits behind another body holding the write queue", async () => {
  const { db, repo } = setup();
  const sha = sha256Hex(new TextEncoder().encode("orphan"));
  await seed(repo, () => { db.prepare(`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, 6, 0)`).run(sha); });
  let deleted = false;
  const del = repo.blobs.delete.bind(repo.blobs);
  repo.blobs.delete = async (s: string) => { await del(s); deleted = true; };
  const holder = hold(db);
  const swept = sweepStoredBlobs(repo);
  await until(() => deleted, 5000, "the sweep deleted the bytes");
  await ticks();
  expect(catalog(db)).toEqual([sha]);
  holder.release();
  await holder.done;
  expect(await swept).toBe(1);
  expect(catalog(db)).toEqual([]);
});

// #965: an upload whose `attachment.uploaded` audit row fails is released, guarded or not (the Slack bridge's uploads
// pass no guard): no bytes stay that no audit row records.
test("#965: an unguarded upload whose audit row fails is released and rejects", async () => {
  const { db, repo } = setup();
  db.run(`CREATE TRIGGER fail_upload_audit BEFORE INSERT ON access_log WHEN NEW.action = 'attachment.uploaded' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`);
  await expect(storeUpload(repo, "you@example.com", "be", file("hello"))).rejects.toThrow("audit refused");
  expect(rows(db)).toEqual([]);
});

// #974: an upload's cleanup writes go through the write queue too: the row delete after a failed blob put, and the
// release after a refused guard. Each is held here as it starts, and waits for the holder.
test("#974: a failed blob put's row delete waits behind another body holding the write queue", async () => {
  const { db, repo } = setup();
  let holder: ReturnType<typeof hold> | undefined;
  repo.blobs.put = async () => { holder = hold(db); throw new Error("disk full"); };
  const stored = storeUpload(repo, "you@example.com", "be", file("hello"));
  await until(() => holder, 5000, "the put failed");
  await ticks();
  expect(rows(db)).toHaveLength(1);
  holder!.release();
  await holder!.done;
  await expect(stored).rejects.toThrow("disk full");
  expect(rows(db)).toEqual([]);
  // P3 B3: the dropped row's catalog entry is swept with it: no entry names bytes that were never put.
  expect(catalog(db)).toEqual([]);
});

// #807 P3 A7d2a: the guard is async; each body awaits it on its own Tx, so a refusal that settles after a microtask
// still fails the body. Here the store body's check passes and the audit body's refuses.
test("#807 P3 A7d2a: an async guard's refusal in the audit body fails the upload, which is released", async () => {
  const { db, repo } = setup();
  const seen: boolean[] = [];
  const guard = async (r: unknown) => {
    seen.push(r === repo.read);
    await Promise.resolve();
    if (seen.length === 2) throw new Error("revoked");
  };
  await expect(storeUpload(repo, "you@example.com", "be", file("hello"), {}, guard)).rejects.toThrow("revoked");
  // Both checks ran inside a body, on its Tx.
  expect(seen).toEqual([false, false]);
  expect(rows(db)).toEqual([]);
});

test("#974: an upload whose guard refuses is released through the write queue", async () => {
  const { db, repo } = setup();
  let calls = 0, started = false;
  let holder: ReturnType<typeof hold> | undefined;
  // The guard runs in the store's insert, then in the audit write: refused there, with a hold queued behind that
  // write, and so ahead of the release.
  const guard = () => {
    if (++calls !== 2) return;
    let release!: () => void;
    const done = queueFor(db).run(() => { started = true; return new Promise<void>(r => { release = r; }); });
    holder = { release: () => release(), done };
    throw new Error("revoked");
  };
  const stored = storeUpload(repo, "you@example.com", "be", file("hello"), {}, guard);
  await until(() => started, 5000, "the hold behind the refused write began");
  await ticks();
  expect(rows(db)).toHaveLength(1);
  holder!.release();
  await holder!.done;
  await expect(stored).rejects.toThrow("revoked");
  expect(rows(db)).toEqual([]);
});

// #807 P3 B3: the server's store checks its principal's quotas in the row's write, through repo.attachments: a refused
// upload leaves no row, no catalog entry and no bytes.
test("#807 P3 B3: an upload over the stored-byte quota is refused before anything is stored", async () => {
  const { db, repo } = setup();
  repo.attachmentUserQuota = 8;
  await storeUpload(repo, "you@example.com", "be", file("hello"));
  let puts = 0;
  const put = repo.blobs.put.bind(repo.blobs);
  repo.blobs.put = async (sha: string, data: Uint8Array) => { puts++; await put(sha, data); };
  await expect(storeUpload(repo, "you@example.com", "be", file("world"))).rejects.toThrow("your stored attachments would exceed");
  expect(puts).toBe(0);
  expect(rows(db)).toHaveLength(1);
  expect(catalog(db)).toEqual([sha256Hex(new TextEncoder().encode("hello"))]);
});

// #807 P3 B3: the sweep reads its candidates on the pool, then rechecks each under the blob's lock: an upload that
// named the sha256 after the first read keeps its bytes and its catalog entry.
test("#807 P3 B3: a blob an upload names after the sweep's first read is kept", async () => {
  const { db, repo } = setup();
  const named = await storeUpload(repo, "you@example.com", "be", file("kept"));
  const orphan = sha256Hex(new TextEncoder().encode("orphan"));
  await seed(repo, () => { db.prepare(`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, 6, 0)`).run(orphan); });
  // A stale first read: it lists the named blob as unnamed too.
  repo.attachments.unnamedBlobs = async () => [named.sha256, orphan];
  const deleted: string[] = [];
  const del = repo.blobs.delete.bind(repo.blobs);
  repo.blobs.delete = async (sha: string) => { deleted.push(sha); await del(sha); };
  expect(await sweepStoredBlobs(repo)).toBe(1);
  expect(deleted).toEqual([orphan]);
  expect(catalog(db)).toEqual([named.sha256]);
});
