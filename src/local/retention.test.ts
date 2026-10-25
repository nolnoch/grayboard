import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindAttachments, storeAttachment } from "../core/attachments.ts";
import { createBoard, post } from "../core/boards.ts";
import { DEFAULT_ATTACHMENT_LIMITS, UNBOUND_TTL_MS } from "../shared/attachments.ts";
import { SqliteBlobs } from "./blobs.ts";
import { openLocalDb } from "./open.ts";
import { retentionDays, runLocalRetention } from "./retention.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let dir: string, db: Database, blobs: SqliteBlobs;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-retention-"));
  db = openLocalDb(join(dir, "bus.db")).db;
  blobs = new SqliteBlobs(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => ({ filename: name, type: "text/plain", data: new TextEncoder().encode(`bytes of ${name}`) });
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

function message(createdAt: number, parent: number | null = null): number {
  const r = db
    .prepare(`INSERT INTO messages (sender, recipient, body, parent_id, created_at) VALUES ('be', 'fe', 'hi', ?, ?)`)
    .run(parent, createdAt);
  return Number(r.lastInsertRowid);
}

describe("runLocalRetention", () => {
  test("prunes old messages and posts with their attachments and bytes, keeps the rest", async () => {
    const old = message(NOW - 91 * DAY);
    const reply = message(NOW - 1 * DAY, old);
    db.prepare(`INSERT INTO dm_acks (reader, message_id, acked_at) VALUES ('fe', ?, ?)`).run(old, NOW - 91 * DAY);
    const a = await storeAttachment(db, blobs, "be", file("old.txt"), { now: NOW - 91 * DAY });
    bindAttachments(db, [a.id], "be", { message_id: old }, DEFAULT_ATTACHMENT_LIMITS);

    createBoard(db, "be", "e2e", "tests");
    const oldPost = post(db, "be", "e2e", "old").post.id;
    const newPost = post(db, "be", "e2e", "new", oldPost).post.id;
    db.prepare(`UPDATE posts SET created_at = ? WHERE id = ?`).run(NOW - 91 * DAY, oldPost);
    db.prepare(`UPDATE posts SET created_at = ? WHERE id = ?`).run(NOW - DAY, newPost);

    const stray = await storeAttachment(db, blobs, "be", file("stray.txt"), { now: NOW - UNBOUND_TTL_MS - 1 });
    const fresh = await storeAttachment(db, blobs, "be", file("fresh.txt"), { now: NOW });

    expect(await runLocalRetention(db, blobs, 90, NOW)).toBe(true);

    expect(db.prepare(`SELECT id, parent_id FROM messages`).all()).toEqual([{ id: reply, parent_id: null }]);
    expect(count(`SELECT COUNT(*) AS n FROM dm_acks`)).toBe(0);
    expect(db.prepare(`SELECT id, parent_id FROM posts WHERE board = 'e2e'`).all()).toEqual([{ id: newPost, parent_id: null }]);
    expect((db.prepare(`SELECT id FROM attachments`).all() as { id: number }[]).map((r) => r.id)).toEqual([fresh.id]);
    expect(count(`SELECT COUNT(*) AS n FROM attachment_bytes`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM attachment_blobs`)).toBe(1);
    await expect(blobs.get(a.sha256)).rejects.toThrow();
    await expect(blobs.get(stray.sha256)).rejects.toThrow();
  });

  test("runs at most once a day across the sessions sharing a bus", async () => {
    expect(await runLocalRetention(db, blobs, 90, NOW)).toBe(true);
    message(NOW - 91 * DAY);
    expect(await runLocalRetention(db, blobs, 90, NOW + DAY - 1)).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM messages`)).toBe(1);
    expect(await runLocalRetention(db, blobs, 90, NOW + DAY)).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM messages`)).toBe(0);
  });
});

describe("retentionDays", () => {
  test("defaults to the server's window and takes a positive whole number", () => {
    expect(retentionDays({})).toBe(90);
    expect(retentionDays({ BUS_RETENTION_DAYS: "" })).toBe(90);
    expect(retentionDays({ BUS_RETENTION_DAYS: "365" })).toBe(365);
    for (const bad of ["0", "-1", "1.5", "30d", " 7"]) expect(retentionDays({ BUS_RETENTION_DAYS: bad })).toBeNull();
  });
});
