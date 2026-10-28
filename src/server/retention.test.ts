import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneMessages, pruneAudit, runRetention } from "./retention.ts";
import { openDatabase, type Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { storeAttachment } from "../core/attachments.ts";
import { createBoard, post, snapshot } from "../core/boards.ts";

let blobDir: string;
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-blobs-"));
});
afterEach(() => rmSync(blobDir, { recursive: true, force: true }));
const open = () => openDatabase(":memory:", { blobDir });

describe("retention pruning", () => {
  let repo: Repo;

  beforeEach(() => {
    ({ repo } = open());
  });

  test("pruneMessages deletes messages older than cutoff", () => {
    // Insert a message with a far-past timestamp by manipulating via direct insert
    // We use a trick: insert, then advance time via the prune cutoff
    const m = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null);
    // Prune everything up to and including now — should remove the message
    pruneMessages(repo, Date.now() + 1);
    const gone = repo.messages.getById(m.id);
    expect(gone).toBeUndefined();
  });

  test("pruneMessages keeps messages newer than cutoff", () => {
    const m = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "new", null);
    // Prune only things older than 1 hour ago — should keep the fresh message
    pruneMessages(repo, Date.now() - 3_600_000);
    const still = repo.messages.getById(m.id);
    expect(still).not.toBeUndefined();
  });

  test("pruneMessages keeps replies whose parent aged out", () => {
    const { db, repo: r } = open();
    const root = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [root.id]);
    const reply = r.messages.insert("b@example.com/be", "user", "a@example.com/fe", "reply", root.id);
    expect(() => pruneMessages(r, 1)).not.toThrow(); // used to fail the parent_id foreign key
    expect(r.messages.getById(root.id)).toBeUndefined();
    expect(r.messages.getById(reply.id)?.parent_id).toBeNull();
  });

  test("retention takes a pruned message's files, and their bytes only once nothing names them", async () => {
    const { db, repo: r } = open();
    const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
    const file = { filename: "a.txt", type: "text/plain", data: new TextEncoder().encode("same bytes") };
    const quota = { principal: "a@example.com", unsent: 1_000_000, stored: 1_000_000 };
    const up = async (who: string) => (await storeAttachment(db, r.blobs, who, file, { quota })).id;
    const from = { addresses: ["a@example.com/fe"], principal: "a@example.com" };
    const old = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null, false, [await up("a@example.com/fe")], null, from);
    const kept = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "new", null, false, [await up("a@example.com/fe")], null, from);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [old.id]);
    await runRetention(r, db, config);
    expect(db.query("SELECT message_id FROM attachments").all()).toEqual([{ message_id: kept.id }]);
    expect(r.messages.thread(kept.id)[0].attachments).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 1 });
    expect(readdirSync(blobDir).filter((d) => d !== "tmp")).toHaveLength(1);
    await runRetention(r, db, config, Date.now() + 2 * 86_400_000);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
    expect(readdirSync(join(blobDir, readdirSync(blobDir).find((d) => d !== "tmp")!))).toEqual([]);
  });

  test("post retention signals actual committed boards, isolates failed callbacks, and skips empty runs", async () => {
    const { db, repo: r } = open();
    const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
    // A board reads as missing to an address no principal owns (#284).
    r.users.upsertByEmail("a@example.com", null);
    r.aliases.create({ scope_kind: "person", scope_ref: "a@example.com", name: "be" }, "a@example.com");
    createBoard(db, "a@example.com/be", "e2e", "test");
    post(db, "a@example.com/be", "e2e", "old");
    db.run("UPDATE posts SET created_at = 0");
    const seen: string[][] = [], snapshots: unknown[] = [];
    const callback = (boards: string[]) => {
      seen.push(boards);
      snapshots.push(snapshot(db, "a@example.com/be", "e2e").posts);
      if (seen.length === 1) throw new Error("sync hint failure");
      return Promise.reject(new Error("async hint failure"));
    };
    await runRetention(r, db, config, Date.now(), callback);
    await runRetention(r, db, config, Date.now(), callback);
    expect(seen).toEqual([["e2e"]]);
    post(db, "a@example.com/be", "e2e", "old again");
    db.run("UPDATE posts SET created_at = 0");
    await runRetention(r, db, config, Date.now(), callback);
    expect(seen).toEqual([["e2e"], ["e2e"]]);
    expect(snapshots).toEqual([[], []]);
  });

  test("pruneAudit does not throw", () => {
    repo.audit.write({ at: Date.now() - 1000, actor: "system", action: "auth.login", target: null, detail: null });
    expect(() => pruneAudit(repo, Date.now())).not.toThrow();
  });
});
