import { describe, test, expect, beforeEach } from "bun:test";
import { pruneMessages, pruneAudit } from "./retention.ts";
import { openDatabase, type Repo } from "./db.ts";
import { storeAttachment } from "../core/attachments.ts";

describe("retention pruning", () => {
  let repo: Repo;

  beforeEach(() => {
    ({ repo } = openDatabase(":memory:"));
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
    const { db, repo: r } = openDatabase(":memory:");
    const root = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [root.id]);
    const reply = r.messages.insert("b@example.com/be", "user", "a@example.com/fe", "reply", root.id);
    expect(() => pruneMessages(r, 1)).not.toThrow(); // used to fail the parent_id foreign key
    expect(r.messages.getById(root.id)).toBeUndefined();
    expect(r.messages.getById(reply.id)?.parent_id).toBeNull();
  });

  test("pruneMessages takes a pruned message's files, and a blob only once nothing names it", () => {
    const { db, repo: r } = openDatabase(":memory:");
    const file = { filename: "a.txt", type: "text/plain", data: new TextEncoder().encode("same bytes") };
    const up = (who: string) => storeAttachment(db, who, file).id;
    const old = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null, false, [up("a@example.com/fe")]);
    const kept = r.messages.insert("a@example.com/fe", "user", "b@example.com/be", "new", null, false, [up("a@example.com/fe")]);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [old.id]);
    expect(() => pruneMessages(r, 1)).not.toThrow();
    expect(db.query("SELECT message_id FROM attachments").all()).toEqual([{ message_id: kept.id }]);
    expect(r.messages.getById(kept.id)?.attachments).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 1 });
    pruneMessages(r, Date.now() + 1);
    expect(db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
  });

  test("pruneAudit does not throw", () => {
    repo.audit.write({ at: Date.now() - 1000, actor: "system", action: "auth.login", target: null, detail: null });
    expect(() => pruneAudit(repo, Date.now())).not.toThrow();
  });
});
