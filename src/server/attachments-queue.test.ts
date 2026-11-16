// #807 P1b-4c-2: the server's attachment store, release and blob sweep write through its write queue (D4). One that
// starts while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, test } from "bun:test";
import { until } from "../../tests/support/until.ts";
import { seed } from "../../tests/support/seed.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, queuedTx } from "./db.ts";
import { releaseStored, storeUpload } from "./attachments.ts";
import { sweepBlobs } from "../core/attachments.ts";
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
  const stored = storeUpload(repo, db, "you@example.com", "be", file("hello"));
  await ticks();
  expect(rows(db)).toEqual([]);
  holder.release();
  await holder.done;
  const row = await stored;
  expect(rows(db)).toEqual([row.id]);
});

test("#807: an upload released while another body holds the write queue waits, then deletes it", async () => {
  const { db, repo } = setup();
  const row = await storeUpload(repo, db, "you@example.com", "be", file("hello"));
  const holder = hold(db);
  const released = releaseStored(repo, db, "you@example.com", "be", row.id);
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
  const swept = sweepBlobs(db, repo.blobs, queuedTx(repo));
  await until(() => deleted, 5000, "the sweep deleted the bytes");
  await ticks();
  expect(catalog(db)).toEqual([sha]);
  holder.release();
  await holder.done;
  expect(await swept).toBe(1);
  expect(catalog(db)).toEqual([]);
});
