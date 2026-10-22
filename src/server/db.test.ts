import { describe, test, expect, beforeEach } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "./db.ts";
import { startSession, laneStreamRef } from "../core/boards.ts";

// ── repository isolation ───────────────────────────────────────────────────────

test("bun:sqlite is only imported from src/server/db.ts (within the v1 server tree)", async () => {
  // src/local/ is the sanctioned same-machine mode (v0 preserved); it owns its own
  // SQLite layer by design. The migration seam this test guards is the v1 backend —
  // src/server, src/plugin, src/shared, src/cli — so src/local is excluded.
  // src/core/ (boards + claims, shared by both modes) takes a Database handle and
  // is part of the seam: a Postgres port reimplements it alongside db.ts.
  // src/bridge/ keeps a client-side file of its own (the Slack bridge's thread
  // map and outbox), never a backend store, so it's excluded like src/local.
  const offenders: string[] = [];
  const glob = new Glob("src/**/*.ts");
  const importPattern = /from\s+["']bun:sqlite["']/;
  for await (const file of glob.scan(".")) {
    if (file === "src/server/db.ts") continue;
    if (file.startsWith("src/local/")) continue;
    if (file.startsWith("src/core/")) continue;
    if (file.startsWith("src/bridge/")) continue;
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(file).text();
    if (importPattern.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("a pre-lanes database opens under the new code, lanes recreated additively", () => {
  // Simulate a database from before this feature: no lanes table, no
  // claim_events.lane column. Deployed databases must open under new code,
  // so reopen the same FILE and assert both come back and data survives.
  const path = join(mkdtempSync(join(tmpdir(), "gb-db-")), "bus.db");
  const { db, repo } = openDatabase(path);
  const user = repo.users.upsertByEmail("you@example.com", null);
  const identity = repo.identities.create(user.id, "be");
  // A pre-lanes writer's DM cursor: identity-scoped, no lane suffix.
  repo.cursors.advance(identity.id, "direct", "you@example.com/be", 42);
  db.exec("DROP TABLE lanes");
  db.exec("ALTER TABLE claim_events DROP COLUMN lane");
  db.close();

  const { db: db2, repo: repo2 } = openDatabase(path);
  const kept = repo2.identities.findByUserAndName(user.id, "be");
  expect(kept?.id).toBe(identity.id);
  // The identity-scoped row is the main lane's stream by format (backfill
  // without migration): reopened code reads it under the lane scheme, and
  // the lane read markers see it as the default lane.
  expect(repo2.cursors.get(kept!.id, "direct", laneStreamRef("you@example.com/be", "main"))).toBe(42);
  expect(repo2.cursors.lanesRead("you@example.com/be", 42)).toEqual(["main"]);
  // The re-created tables take writes through the real APIs.
  startSession(db2, `you@example.com/be`, null);
  db2.prepare(`INSERT INTO claim_events (key, handle, event, at, lane) VALUES ('k', 'you@example.com/be', 'take', ?, 'main')`).run(Date.now());
  db2.close();
});

// ── basic CRUD ────────────────────────────────────────────────────────────────

describe("Repo", () => {
  let db: ReturnType<typeof openDatabase>["db"];
  let repo: Repo;

  beforeEach(() => {
    // Use an in-memory DB for each test
    const { db: d, repo: r } = openDatabase(":memory:");
    db = d;
    repo = r;
  });

  test("upsertByEmail creates user on first call", () => {
    const u = repo.users.upsertByEmail("wade@example.com", "Wade");
    expect(u.email).toBe("wade@example.com");
    expect(u.display_name).toBe("Wade");
    expect(u.disabled_at).toBeNull();
  });

  test("upsertByEmail updates display_name on collision", () => {
    repo.users.upsertByEmail("wade@example.com", "Wade");
    const u = repo.users.upsertByEmail("wade@example.com", "Wade B");
    expect(u.display_name).toBe("Wade B");
  });

  test("sessions: create, findByTokenHash, revoke", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const s   = repo.sessions.create(u.id, "hash123", "test");
    const found = repo.sessions.findByTokenHash("hash123");
    expect(found?.id).toBe(s.id);
    repo.sessions.revoke(s.id);
    expect(repo.sessions.findByTokenHash("hash123")).toBeUndefined();
  });

  test("identities: create, list, remove", () => {
    const u  = repo.users.upsertByEmail("wade@example.com", null);
    repo.identities.create(u.id, "fe");
    repo.identities.create(u.id, "be");
    expect(repo.identities.listForUser(u.id)).toHaveLength(2);
    repo.identities.remove(u.id, "fe");
    expect(repo.identities.listForUser(u.id)).toHaveLength(1);
  });

  test("teams: create, join, leave, list members", () => {
    const u1 = repo.users.upsertByEmail("a@example.com", null);
    const u2 = repo.users.upsertByEmail("b@example.com", null);
    const t  = repo.teams.create("eng", u1.id);
    repo.teams.addMember(t.id, u1.id);
    repo.teams.addMember(t.id, u2.id);
    expect(repo.teams.listMembers(t.id)).toHaveLength(2);
    repo.teams.removeMember(t.id, u2.id);
    expect(repo.teams.listMembers(t.id)).toHaveLength(1);
  });

  test("messages: insert and thread", () => {
    const root  = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
    const reply = repo.messages.insert("b@example.com/be", "user", "a@example.com/fe", "hi",    root.id);
    const thread = repo.messages.thread(root.id);
    expect(thread).toHaveLength(2);
    expect(thread[0].id).toBe(root.id);
    expect(thread[1].id).toBe(reply.id);
    expect(repo.messages.thread(reply.id).map(m => m.id)).toEqual([root.id, reply.id]);
  });

  test("undeliveredFrom is lane-aware: a lane's reads count for the identity", () => {
    // After a rotation the acks land on the lane row (`full#lane`) and the
    // bare row freezes; sender-side delivery truth must follow the lanes
    // (the local twin's rule), or every sender gets false "undelivered".
    const beUser = repo.users.upsertByEmail("be@example.com", null);
    const be = repo.identities.create(beUser.id, "be");
    const sender = "fe@example.com/fe";
    for (const body of ["one", "two", "three", "four", "five"]) repo.messages.insert(sender, "user", "be@example.com/be", body, null);
    repo.cursors.advance(be.id, "direct", "be@example.com/be", 3);
    repo.cursors.advance(be.id, "direct", laneStreamRef("be@example.com/be", "research"), 5);
    expect(repo.messages.undeliveredFrom(sender)).toEqual([]);
    // Without the lane row, the bare cursor is the whole truth again.
    db.run("DELETE FROM cursors WHERE stream_ref = ?", [laneStreamRef("be@example.com/be", "research")]);
    expect(repo.messages.undeliveredFrom(sender)).toEqual([{ recipient: "be@example.com/be", n: 2, oldest_id: 4 }]);
  });

  test("the lane cursor queries use the stream index, not a table scan", () => {
    // directFor runs on every hello; lanesRead and undeliveredFrom's
    // subquery carry the same predicate. The PK leads with identity_id,
    // which these don't know — without idx_cursors_stream each was a full
    // cursors scan (EXPLAIN said "SCAN cursors"). A single range predicate
    // (`>= x AND < x || '$'`) keeps stream_ref INSIDE the index bounds; the
    // old `= x OR range` form left stream_ref out of the index constraints.
    const beUser = repo.users.upsertByEmail("be@example.com", null);
    repo.identities.create(beUser.id, "be");
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT MAX(last_seen_id) AS id FROM cursors
          WHERE stream_type = 'direct'
            AND (stream_ref >= ? AND stream_ref < ? || '$')`,
      )
      .all("be@example.com/be", "be@example.com/be") as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toContain("USING INDEX idx_cursors_stream");
    // The range must actually constrain the index: "SEARCH cursors USING
    // INDEX ... (stream_type=? AND stream_ref>? AND stream_ref<?)" — a
    // bare index mention with an unconstrained stream_ref is the old bug.
    expect(detail).toContain("stream_ref>");
    expect(detail).not.toContain("SCAN cursors");
  });

  test("previousBetween is the sender's previous message ADDRESSED TO the recipient, not the global id below", () => {
    // Message ids are global: an unrelated pair can hold the id just below
    // this one, so "caught up to just before it" must compare against the
    // sender's previous message to the recipient (N4). DIRECTIONAL — only
    // messages addressed TO the recipient: the recipient's own reply sits
    // above its receive cursor forever, so a bidirectional compare would
    // hide the read state after the first back-and-forth.
    const u = repo.users.upsertByEmail("you@example.com", null);
    repo.identities.create(u.id, "fe");
    repo.identities.create(u.id, "sim");
    repo.identities.create(u.id, "be");
    const fe = "you@example.com/fe", sim = "you@example.com/sim", other = "you@example.com/be";
    const one = repo.messages.insert(fe, "user", sim, "one", null);
    repo.messages.insert(fe, "user", other, "noise", null); // takes the id between, another pair
    const two = repo.messages.insert(fe, "user", sim, "two", null);
    expect(repo.messages.previousBetween(fe, sim, two.id)).toBe(one.id); // not two.id - 1
    expect(repo.messages.previousBetween(fe, sim, one.id)).toBe(0); // their first
    // The recipient's reply never counts as "the previous message": it
    // isn't addressed to it.
    const reply = repo.messages.insert(sim, "user", fe, "sim replies", null);
    const three = repo.messages.insert(fe, "user", sim, "three", null);
    expect(reply.id).toBeGreaterThan(two.id); // the reply sits above two
    expect(repo.messages.previousBetween(fe, sim, three.id)).toBe(two.id); // not the reply's id
  });

  test("cursors: advance is idempotent and takes MAX", () => {
    const u = repo.users.upsertByEmail("wade@example.com", null);
    const i = repo.identities.create(u.id, "fe");
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 10);
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 5);  // lower — should not regress
    expect(repo.cursors.get(i.id, "direct", "wade@example.com/fe")).toBe(10);
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 20);
    expect(repo.cursors.get(i.id, "direct", "wade@example.com/fe")).toBe(20);
  });

  test("unreadSince returns only messages after cursor", () => {
    const m1 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg1", null);
    const m2 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg2", null);
    const unread = repo.messages.unreadSince([{ type: "direct", ref: "b@example.com/be", since: m1.id }]);
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(m2.id);
  });

  test("audit.write and prune", () => {
    const oldTs = Date.now() - 100;
    repo.audit.write({ at: oldTs, actor: "wade@example.com", action: "auth.login", target: null, detail: null });
    repo.audit.prune(Date.now()); // prune everything older than now
    // No assertion on rows (no SELECT on audit in Repo) but prune should not throw
  });
});
