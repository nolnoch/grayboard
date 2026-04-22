import { describe, test, expect, beforeEach } from "bun:test";
import { pruneMessages, pruneAudit } from "./retention.ts";
import { openDatabase, type Repo } from "./db.ts";

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

  test("pruneAudit does not throw", () => {
    repo.audit.write({ at: Date.now() - 1000, actor: "system", action: "auth.login", target: null, detail: null });
    expect(() => pruneAudit(repo, Date.now())).not.toThrow();
  });
});
