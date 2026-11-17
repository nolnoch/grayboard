import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { pruneMessages, pruneAudit, reclaimFreePages, runRetention } from "./retention.ts";
import { openDatabase, queuedTx, type Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { storeAttachment } from "../core/attachments.ts";
import { createBoard, post, snapshot } from "../core/boards.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";

let blobDir: string;
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-blobs-"));
});
afterEach(() => rmSync(blobDir, { recursive: true, force: true }));
const open = () => openDatabase(scratchDbPath(), { blobDir });

describe("retention pruning", () => {
  let repo: Repo;

  beforeEach(() => {
    ({ repo } = open());
  });

  test("pruneMessages deletes messages older than cutoff", async () => {
    // Insert a message with a far-past timestamp by manipulating via direct insert
    // We use a trick: insert, then advance time via the prune cutoff
    const m = await seed(repo, tx => repo.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "old", null));
    // Prune everything up to and including now — should remove the message
    await seed(repo, tx => pruneMessages(repo, tx, Date.now() + 1));
    const gone = (await repo.messages.getById(repo.read, m.id));
    expect(gone).toBeUndefined();
  });

  test("pruneMessages keeps messages newer than cutoff", async () => {
    const m = await seed(repo, tx => repo.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "new", null));
    // Prune only things older than 1 hour ago — should keep the fresh message
    await seed(repo, tx => pruneMessages(repo, tx, Date.now() - 3_600_000));
    const still = (await repo.messages.getById(repo.read, m.id));
    expect(still).not.toBeUndefined();
  });

  test("pruneMessages keeps replies whose parent aged out", async () => {
    const { db, repo: r } = open();
    const { root, reply } = await seed(r, async tx => {
      const root = await r.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "old", null);
      db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [root.id]);
      return { root, reply: await r.messages.insert(tx, "b@example.com/be", "user", "a@example.com/fe", "reply", root.id) };
    });
    await expect(seed(r, tx => pruneMessages(r, tx, 1))).resolves.toBeUndefined(); // used to fail the parent_id foreign key
    expect((await r.messages.getById(r.read, root.id))).toBeUndefined();
    expect((await r.messages.getById(r.read, reply.id))?.parent_id).toBeNull();
  });

  test("retention takes a pruned message's files, and their bytes only once nothing names them", async () => {
    const { db, repo: r } = open();
    const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
    const file = { filename: "a.txt", type: "text/plain", data: new TextEncoder().encode("same bytes") };
    const quota = { principal: "a@example.com", unsent: 1_000_000, stored: 1_000_000 };
    const up = async (who: string) => (await storeAttachment(db, r.blobs, who, file, { quota, tx: queuedTx(r) })).id;
    const from = { addresses: ["a@example.com/fe"], principal: "a@example.com" };
    const oldFile = await up("a@example.com/fe");
    const old = await seed(r, tx => r.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "old", null, false, { ids: [oldFile], uploader: from }, null));
    const keptFile = await up("a@example.com/fe");
    const kept = await seed(r, async tx => {
      const kept = await r.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "new", null, false, { ids: [keptFile], uploader: from }, null);
      db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [old.id]);
      return kept;
    });
    await runRetention(r, config);
    expect(db.query("SELECT message_id FROM attachments").all()).toEqual([{ message_id: kept.id }]);
    expect((await r.messages.thread(r.read, kept.id))[0].attachments).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 1 });
    expect(readdirSync(blobDir).filter((d) => d !== "tmp")).toHaveLength(1);
    await runRetention(r, config, Date.now() + 2 * 86_400_000);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
    expect(readdirSync(join(blobDir, readdirSync(blobDir).find((d) => d !== "tmp")!))).toEqual([]);
  });

  test("post retention signals actual committed boards, isolates failed callbacks, and skips empty runs", async () => {
    const { db, repo: r } = open();
    const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
    // A board reads as missing to an address no principal owns (#284).
    await seed(r, async tx => {
      await r.users.upsertByEmail(tx, "a@example.com", null);
      await r.aliases.create(tx, { scope_kind: "person", scope_ref: "a@example.com", name: "be" }, "a@example.com");
      createBoard(db, "a@example.com/be", "e2e", "test");
      post(db, "a@example.com/be", "e2e", "old");
      db.run("UPDATE posts SET created_at = 0");
    });
    const seen: string[][] = [], snapshots: unknown[] = [];
    const callback = (boards: string[]) => {
      seen.push(boards);
      snapshots.push(snapshot(db, "a@example.com/be", "e2e").posts);
      if (seen.length === 1) throw new Error("sync hint failure");
      return Promise.reject(new Error("async hint failure"));
    };
    await runRetention(r, config, Date.now(), callback);
    await runRetention(r, config, Date.now(), callback);
    expect(seen).toEqual([["e2e"]]);
    await seed(r, () => {
      post(db, "a@example.com/be", "e2e", "old again");
      db.run("UPDATE posts SET created_at = 0");
    });
    await runRetention(r, config, Date.now(), callback);
    expect(seen).toEqual([["e2e"], ["e2e"]]);
    expect(snapshots).toEqual([[], []]);
  });

  test("pruneAudit does not throw", async () => {
    await seed(repo, (tx) => repo.audit.write(tx, { at: Date.now() - 1000, actor: "system", action: "auth.login", target: null, detail: null }));
    await expect(seed(repo, (tx) => pruneAudit(repo, tx, Date.now()))).resolves.toBeUndefined();
  });
});

// #137: the nightly run returns freed pages to the filesystem, bounded per run.
describe("reclaiming free pages", () => {
  // A file database with `rows` 4 KB rows written and then deleted: that many free pages, or more. Through db's write
  // queue, as two transactions (the fill, then the delete).
  const freed = async (db: import("bun:sqlite").Database, rows: number) => {
    await seed(db, () => {
      db.run("CREATE TABLE IF NOT EXISTS filler (x BLOB)");
      for (let i = 0; i < rows; i++) db.run("INSERT INTO filler VALUES (randomblob(4000))");
    });
    await seed(db, () => { db.run("DELETE FROM filler"); });
  };
  const freeCount = (db: import("bun:sqlite").Database) => db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
  const quiet = async <T>(f: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
    const lines: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { return { value: await f(), lines }; } finally { console.error = real; }
  };

  test("reclaimFreePages returns at most maxPages, and refuses a non-positive count", async () => {
    const { db, repo } = openDatabase(join(blobDir, "bus.db"), { blobDir: join(blobDir, "blobs") });
    await freed(db, 300);
    const before = freeCount(db);
    expect(before).toBeGreaterThanOrEqual(300);
    // As the queue's holder, as retention runs it.
    expect(await seed(repo, () => repo.storage.reclaimFreePages(100))).toEqual({ reclaimed: 100, remaining: before - 100, incremental: true });
    expect(freeCount(db)).toBe(before - 100);
    // incremental_vacuum(0) means every page: never passed through.
    await expect(seed(repo, () => repo.storage.reclaimFreePages(0))).rejects.toThrow(RangeError);
    expect(freeCount(db)).toBe(before - 100);
    db.close();
  });

  test("runRetention reclaims the free pages and says how many", async () => {
    const { db, repo } = openDatabase(join(blobDir, "bus.db"), { blobDir: join(blobDir, "blobs") });
    await freed(db, 300);
    const before = freeCount(db);
    const lines: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { await runRetention(repo, { messageRetentionDays: 90, auditRetentionDays: 90 } as Config); } finally { console.error = real; }
    expect(freeCount(db)).toBe(0);
    expect(lines).toContain(`[grayboard] retention: reclaimed ${before} free database pages (0 left)`);
    db.close();
  });

  test("a database from before #170 (auto_vacuum=NONE) reclaims nothing and says how to convert it", async () => {
    const path = join(blobDir, "old.db");
    const old = new Database(path);
    old.exec("PRAGMA journal_mode = WAL;");
    await freed(old, 500);
    old.close();
    // Opening adds the schema, which reuses some of those pages.
    const { db, repo } = openDatabase(path, { blobDir: join(blobDir, "blobs") });
    const before = freeCount(db);
    expect(before).toBeGreaterThan(0);
    const { value, lines } = await quiet(() => seed(repo, () => reclaimFreePages(repo)));
    expect(value).toBeUndefined();
    expect(freeCount(db)).toBe(before);
    expect(lines).toEqual([`[grayboard] retention: the database has ${before} free pages it can't reclaim (auto_vacuum is not INCREMENTAL); a one-time VACUUM converts it (docs/guide/server.md §Reclaiming disk space)`]);
    db.close();
  });
});
