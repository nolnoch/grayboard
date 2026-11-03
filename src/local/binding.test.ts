import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_IDLE_SECONDS, MAX_CHILDREN, REFUSED_COALESCE_MS, childCapacity, childSessionId, holdAlias, idAddress, logBinding } from "../core/bindings.ts";
import { IdCollision, createBoard, declareHuman, openAccess, prunePosts, setAccess, touchId } from "../core/boards.ts";
import { claim, watch } from "../core/claims.ts";
import { ChildSessions, acquireName, attachSession, candidateNames, childFallback, liveSessions, reap, registerChild, registerSession, runnerRoot, runnerRootLive, thisSession, type SessionRow } from "./binding.ts";
import { procStart } from "../shared/proc.ts";
import { openLocalDb } from "./open.ts";

// #182 audit 29: two processes that read the same dead row both reap it;
// only the one whose delete removed it logs the release.
test("a dead row reaped twice logs one release", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const id = "id:0123456789abc";
  registerSession(db, { session_id: id, name: null, names: [], pid: 999999, proc_start: null, harness: null, harness_pid: null, cwd: null, started_at: 1, harness_rule: null, attached_pid: null, attached_start: null });
  holdAlias(db, "fe", id);
  const rows = db.prepare(`SELECT * FROM bindings`).all() as SessionRow[];
  db.transaction(() => reap(db, rows, 2)).immediate();
  db.transaction(() => reap(db, rows, 3)).immediate();
  expect(db.prepare(`SELECT name, event, detail FROM binding_events`).all()).toEqual([{ name: "fe", event: "released", detail: "session_end: reaped: pid 999999 is gone" }]);
  // The reap ends the session (#284): its hold goes and its ID is never taken again.
  expect(db.prepare(`SELECT * FROM alias_holds`).all()).toEqual([]);
  expect(db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(id)).toEqual({ ended_at: 2 });
});

// #284 S7: a session holding two aliases is one live row, its primary the
// one it bound first, and a bind of either by another session is refused.
test("a session with two holds is one live row; neither name is offered or free", async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const me = "id:0123456789abf";
  registerSession(db, { ...thisSession(me), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  // One millisecond, bound zed then alpha: bind order, not the address, picks the primary.
  holdAlias(db, "zed", me, 7);
  holdAlias(db, "alpha", me, 7);
  expect(liveSessions(db).alive).toEqual([expect.objectContaining({ session_id: me, name: "zed", names: ["zed", "alpha"] })]);
  expect((await candidateNames(db, "alpha")).map((c) => c.name)).not.toContain("alpha");
  const other = "id:0123456789abg";
  registerSession(db, { ...thisSession(other), pid: 999999, proc_start: null });
  for (const name of ["zed", "alpha"]) {
    expect(await acquireName(db, other, name, { create: true })).toMatchObject({ ok: false, error: expect.stringContaining(me) });
  }
});

// #284 decision 2: an ID with any ids row, live or ended, is never registered again.
test("registering an ID that has a row, live or ended, throws IdCollision", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const s = { ...thisSession("id:0123456789abe"), pid: 999999, proc_start: null };
  registerSession(db, s);
  expect(() => registerSession(db, s)).toThrow(new IdCollision(s.session_id, null));
  db.prepare(`UPDATE ids SET ended_at = 5 WHERE id = ?`).run(s.session_id);
  expect(() => registerSession(db, s)).toThrow(new IdCollision(s.session_id, 5));
  expect(db.prepare(`SELECT COUNT(*) AS n FROM bindings`).get()).toEqual({ n: 1 });
});

// #284 audit A2: a 1.x process sharing the file holds a name by its bindings
// row's name alone. A HEAD acquire treats that live row as the holder, and a
// HEAD hold writes bindings.name too, so the 1.x holder check sees it.
test("a live 1.x holder blocks a HEAD acquire; a HEAD hold mirrors into bindings.name", async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const name = `a2-${process.pid}`;
  db.prepare(`INSERT INTO bindings (session_id, name, pid, proc_start, harness_pid, started_at, bound_at) VALUES ('0123456789abcdef', ?, ?, ?, NULL, 1, 1)`)
    .run(name, process.pid, procStart(process.pid) ?? null);
  const me = "id:0123456789abd";
  registerSession(db, { ...thisSession(me), pid: 999999, proc_start: null });
  const r = await acquireName(db, me, name, { create: true });
  expect(r).toMatchObject({ ok: false, error: expect.stringContaining("0123456789abcdef") });
  // The 1.x process exits uncleanly: its row is dead, reaped, its release logged.
  db.prepare(`UPDATE bindings SET pid = 999998, proc_start = NULL WHERE session_id = '0123456789abcdef'`).run();
  expect(await acquireName(db, me, name, { create: true })).toMatchObject({ ok: true });
  expect(db.prepare(`SELECT session_id, event FROM binding_events WHERE name = ? AND event != 'refused' ORDER BY id`).all(name)).toEqual([
    { session_id: "0123456789abcdef", event: "released" },
    { session_id: me, event: "bound" },
  ]);
  expect(db.prepare(`SELECT name FROM bindings WHERE session_id = ?`).get(me)).toEqual({ name });
});

// #284 audit A4: a 1.x reap deletes only the bindings row. The hold it left
// is swept, and its session ended, by the next HEAD read of live sessions.
test("a hold whose bindings row a 1.x reap deleted is swept and its session ended", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const id = "id:0123456789abe";
  registerSession(db, { ...thisSession(id), pid: 999999, proc_start: null });
  holdAlias(db, "fe", id);
  db.prepare(`DELETE FROM bindings WHERE session_id = ?`).run(id);
  expect(liveSessions(db)).toMatchObject({ alive: [], ended: [id] });
  expect(db.prepare(`SELECT * FROM alias_holds`).all()).toEqual([]);
  expect((db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(id) as { ended_at: number | null }).ended_at).not.toBeNull();
});

// Audit A6 (#329): one dead session whose end throws doesn't roll back the
// others' ends or fail the opener; the failure is audited.
test("a dead session whose end fails is audited and the others still end", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const bad = "id:0123456789abe", good = "id:0123456789abf";
  for (const id of [bad, good]) registerSession(db, { ...thisSession(id), pid: 999999, proc_start: null });
  createBoard(db, "be", "work", "work items");
  claim(db, bad, "ticket:ENG-5", { board: "work" });
  watch(db, "qa", "ticket:ENG-5");
  setAccess(db, { ...openAccess(db), resolveMention: () => { throw new Error("disk on fire"); } });

  expect(liveSessions(db)).toMatchObject({ alive: [], ended: [good] });
  expect(db.prepare(`SELECT id FROM ids WHERE ended_at IS NOT NULL`).all()).toEqual([{ id: good }]);
  const failed = db.prepare(`SELECT target, detail FROM audit_log WHERE action = 'id.end_failed'`).get() as { target: string; detail: string };
  expect(failed.target).toBe(bad);
  expect(JSON.parse(failed.detail)).toMatchObject({ error: "Error: disk on fire", by_pid: process.pid });
});

// Audit S3 (#329): a keyed restart takes back the human's handle only as the
// human's bridge, and the bridge takes back only the human's handle.
test("a keyed attach is refused when the held handle and BUS_HUMAN disagree", async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const id = "id:0123456789abe";
  const self = thisSession(id, { pid: process.pid, proc_start: procStart(process.pid) ?? null, rule: "env" });
  registerSession(db, self);
  declareHuman(db, "boss");
  holdAlias(db, "boss", id);
  // The previous child is gone; the harness (this process) lives.
  db.prepare(`UPDATE bindings SET attached_pid = 999999, attached_start = NULL WHERE session_id = ?`).run(id);

  expect(await attachSession(db, self, false)).toMatchObject({ ok: false, error: expect.stringContaining(`holds the human handle "boss", and this process isn't BUS_HUMAN=1`) });
  expect(await attachSession(db, self, true)).toEqual({ ok: true, held: ["boss"] });
  db.prepare(`UPDATE bindings SET attached_pid = 999999, attached_start = NULL WHERE session_id = ?`).run(id);
  holdAlias(db, "fe", id);
  db.prepare(`DELETE FROM alias_holds WHERE address = 'boss'`).run();
  expect(await attachSession(db, self, true)).toMatchObject({ ok: false, error: expect.stringContaining(`holds "fe", which isn't the declared human handle`) });
});

// #210: a retry loop refused for the same reason is one row with a count.
test("a session's identical refusals within the window share a row; anything else inserts", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const s1 = "0123456789abcdef", s2 = "fedcba9876543210";
  logBinding(db, s1, "fe", "refused", "held by be", 1000);
  logBinding(db, s1, "fe", "refused", "held by be", 2000);
  logBinding(db, s1, "fe", "refused", "held by be", 2000 + REFUSED_COALESCE_MS);
  // Another session, another detail, another name: their own rows.
  logBinding(db, s2, "fe", "refused", "held by be", 3000);
  logBinding(db, s1, "fe", "refused", "held by sim", 4000);
  // The detail changed back: the latest row for the session is the new one.
  logBinding(db, s1, "fe", "refused", "held by be", 5000);
  // Past the window from the last repeat.
  logBinding(db, s1, "fe", "refused", "held by be", 5001 + REFUSED_COALESCE_MS);
  // Only refusals coalesce.
  logBinding(db, s1, "fe", "bound", null, 70_000);
  logBinding(db, s1, "fe", "bound", null, 70_001);
  const rows = db.prepare(`SELECT session_id, detail, event, at, count, last_at FROM binding_events ORDER BY id`).all();
  expect(rows).toEqual([
    { session_id: s1, detail: "held by be", event: "refused", at: 1000, count: 3, last_at: 2000 + REFUSED_COALESCE_MS },
    { session_id: s2, detail: "held by be", event: "refused", at: 3000, count: null, last_at: null },
    { session_id: s1, detail: "held by sim", event: "refused", at: 4000, count: null, last_at: null },
    { session_id: s1, detail: "held by be", event: "refused", at: 5000, count: null, last_at: null },
    { session_id: s1, detail: "held by be", event: "refused", at: 5001 + REFUSED_COALESCE_MS, count: null, last_at: null },
    { session_id: s1, detail: null, event: "bound", at: 70_000, count: null, last_at: null },
    { session_id: s1, detail: null, event: "bound", at: 70_001, count: null, last_at: null },
  ]);
  // Retention keeps a coalesced row while its last repeat is inside the window.
  prunePosts(db, 2000 + REFUSED_COALESCE_MS);
  expect(db.prepare(`SELECT at FROM binding_events WHERE count = 3`).all()).toEqual([{ at: 1000 }]);
});

// #211: retention keeps each name's latest bound or moved event, which says
// who holds the name by the record; everything else past the window goes.
test("retention keeps each name's latest bound or moved event", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const [s1, s2] = ["0123456789abcdef", "fedcba9876543210"];
  logBinding(db, s1, "fe", "bound", null, 1000);
  logBinding(db, s2, "fe", "bound", null, 2000);
  logBinding(db, s2, "fe", "released", null, 3000);
  logBinding(db, s1, "be", "moved", "fe", 4000);
  logBinding(db, s1, "be", "refused", "held", 5000);
  prunePosts(db, 10_000);
  expect(db.prepare(`SELECT session_id, name, event FROM binding_events ORDER BY id`).all()).toEqual([
    { session_id: s2, name: "fe", event: "bound" },
    { session_id: s1, name: "be", event: "moved" },
  ]);
});

// #523: a child session's first sight writes its ids row (the root's facts,
// delivery 'none', root_id), a copy of the root's liveness row (#539) and one
// id.child_seen row; a second sight is the same child; a row that isn't this
// root's live child is refused.
test("registerChild records a child once, audited; another root's ID or an ended child is refused", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const [root, child, other] = ["id:0123456789abc", "id:0123456789abd", "id:0123456789abe"];
  registerSession(db, { ...thisSession(root, null, "/work/repo"), pid: process.pid, proc_start: procStart(process.pid) ?? null, harness: "omp" }, { keyed: true });
  registerChild(db, root, child, "reviewer-1");
  registerChild(db, root, child, "reviewer-1");
  expect(db.prepare(`SELECT harness, cwd, keyed, delivery, root_id, ended_at FROM ids WHERE id = ?`).get(child)).toEqual({ harness: "omp", cwd: "/work/repo", keyed: 1, delivery: "none", root_id: root, ended_at: null });
  const seen = db.prepare(`SELECT actor, target, detail FROM audit_log WHERE action = 'id.child_seen'`).all() as { actor: string; target: string; detail: string }[];
  expect(seen.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([{ actor: root, target: child, detail: { child, root, raw: "reviewer-1", pid: process.pid, liveness_pid: process.pid } }]);
  // Its process row is its root's liveness, unbound and with nothing attached: never a live receiver here.
  const liveness = `SELECT name, pid, proc_start, harness_pid, harness_rule, attached_pid, attached_start, detached_at FROM bindings WHERE session_id = ?`;
  expect(db.prepare(liveness).get(child)).toEqual({ ...(db.prepare(liveness).get(root) as object), attached_pid: null, attached_start: null });
  expect(liveSessions(db).alive.map((r) => r.session_id)).toEqual([root]);

  registerSession(db, { ...thisSession(other), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  expect(() => registerChild(db, root, other, "reviewer-2")).toThrow(`id_collision: ${other} is another session's ID, not a child of ${root}`);
  expect(() => registerChild(db, other, child, "reviewer-1")).toThrow(`id_collision: ${child} is another session's ID, not a child of ${other}`);
  db.prepare(`UPDATE ids SET ended_at = 5 WHERE id = ?`).run(child);
  expect(() => registerChild(db, root, child, "reviewer-1")).toThrow(`id_ended: child session ${child} ended at 1970-01-01T00:00:00.005Z`);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'id.child_seen'`).get()).toEqual({ n: 1 });
});

// #523 step 5: a runner's root is the live session that recorded its parent
// session, only if that session's harness is among the runner's ancestors
// (the nearest when several are; a dead one never); the runner acts under it
// while both live, and with it gone it is a session of its own.
test("runnerRoot finds a live root among the runner's ancestors; runnerRootLive and childFallback follow the root's liveness", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const [far, near, dead, child, self] = ["id:0123456789abc", "id:0123456789abd", "id:0123456789abe", "id:0123456789abf", "id:0123456789ab0"];
  const live = { pid: process.pid, proc_start: procStart(process.pid) ?? null };
  registerSession(db, { ...thisSession(far), ...live, harness_pid: 4242 }, { harnessSession: "pi-1" });
  registerSession(db, { ...thisSession(near), ...live, harness_pid: 4244 }, { harnessSession: "pi-1" });
  registerSession(db, { ...thisSession(dead), pid: 999999, proc_start: null, harness_pid: 4243 }, { harnessSession: "pi-1" });
  expect(runnerRoot(db, "pi-1", [4243, 4244, 4242])).toEqual({ root: near });
  expect(runnerRoot(db, "pi-1", [4242])).toEqual({ root: far });
  expect(runnerRoot(db, "pi-1", [4243, 1234])).toEqual({ why: `the live session ${far} recorded harness session pi-1, but its harness pid 4242 isn't an ancestor of this process` });
  expect(runnerRoot(db, "pi-2", [4242])).toEqual({ why: "no live session recorded harness session pi-2" });

  registerChild(db, far, child, "runner-1", Date.now(), { harness: "pi", cwd: "/work/repo", harnessSession: "runner-1", detail: { parent_session: "pi-1" } });
  expect(db.prepare(`SELECT harness, cwd, harness_session, root_id FROM ids WHERE id = ?`).get(child)).toEqual({ harness: "pi", cwd: "/work/repo", harness_session: "runner-1", root_id: far });
  expect(runnerRootLive(db, child, far)).toBe(true);
  expect(runnerRootLive(db, child, near)).toBe(false);
  // The root's process exits while the runner lives on.
  db.prepare(`UPDATE bindings SET pid = 999999, proc_start = NULL WHERE session_id = ?`).run(far);
  expect(runnerRootLive(db, child, far)).toBe(false);
  childFallback(db, { child, root: far, self: { ...thisSession(self), ...live }, kind: { harnessSession: "runner-1" }, detail: { parent_session: "pi-1" } });
  expect(db.prepare(`SELECT root_id, ended_at IS NOT NULL AS ended FROM ids WHERE id = ?`).get(child)).toEqual({ root_id: far, ended: 1 });
  expect(db.prepare(`SELECT root_id, harness_session, delivery FROM ids WHERE id = ?`).get(self)).toEqual({ root_id: null, harness_session: "runner-1", delivery: "push" });
  const fallback = db.prepare(`SELECT actor, target, detail FROM audit_log WHERE action = 'id.child_fallback'`).all() as { actor: string; target: string; detail: string }[];
  expect(fallback.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([{ actor: self, target: self, detail: { child, root: far, pid: process.pid, parent_session: "pi-1" } }]);
});

// #523 audit 3: a root has at most MAX_CHILDREN child sessions at once, as
// hosted. A local child has no end of its own, so the root's other children
// count only while seen inside the idle window; a known child seen again
// keeps its own place.
test("a root's child past MAX_CHILDREN is refused while the others are fresh, and accepted once they've gone idle", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const root = "id:0123456789abc";
  registerSession(db, { ...thisSession(root), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  const kid = (i: number) => `id:k${String(i).padStart(12, "0")}`;
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < MAX_CHILDREN; i++) registerChild(db, root, kid(i), `sub-${i}`, t0);
  expect(() => registerChild(db, root, kid(MAX_CHILDREN), "sub-overflow", t0 + 1000)).toThrow(childCapacity(root));
  expect(db.prepare(`SELECT 1 FROM ids WHERE id = ?`).get(kid(MAX_CHILDREN))).toBeNull();
  registerChild(db, root, kid(0), "sub-0", t0 + 1000);
  // At the window's edge the others still count; one past it, only the two seen since do.
  const window = DEFAULT_IDLE_SECONDS * 1000;
  expect(() => registerChild(db, root, kid(MAX_CHILDREN), "sub-overflow", t0 + window)).toThrow(childCapacity(root));
  touchId(db, kid(1), t0 + window + 1);
  registerChild(db, root, kid(MAX_CHILDREN), "sub-overflow", t0 + window + 1);
  expect(db.prepare(`SELECT root_id, ended_at FROM ids WHERE id = ?`).get(kid(MAX_CHILDREN))).toEqual({ root_id: root, ended_at: null });
  expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'id.child_seen'`).get()).toEqual({ n: MAX_CHILDREN + 1 });
});

// #523 audit 3: the root process's child cache derives each child's ID from
// the root's key, registers it once and touches it per call; it forgets a
// child idle past the window, so its memory stays bounded by the cap, and the
// forgotten child seen again is the same child, with no second audit row.
test("ChildSessions keeps only the children seen inside the idle window, refusing past MAX_CHILDREN", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const key = "ab".repeat(32);
  const root = idAddress(key);
  registerSession(db, { ...thisSession(root), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  const children = new ChildSessions(db, root, key);
  const t0 = 1_800_000_000_000, window = DEFAULT_IDLE_SECONDS * 1000;
  const first = children.resolve("sub-0", t0);
  expect(first).toBe(childSessionId(key, "sub-0"));
  for (let i = 1; i < MAX_CHILDREN; i++) children.resolve(`sub-${i}`, t0);
  expect(children.size).toBe(MAX_CHILDREN);
  expect(() => children.resolve("sub-overflow", t0 + 1)).toThrow(childCapacity(root));
  // A known child resolves again, keeping its place, and is touched.
  expect(children.resolve("sub-0", t0 + 2)).toBe(first);
  expect(db.prepare(`SELECT last_seen FROM ids WHERE id = ?`).get(first)).toEqual({ last_seen: t0 + 2 });
  // Past the window every child but sub-0 is forgotten; the newcomer takes a place.
  children.resolve("sub-overflow", t0 + window + 1);
  expect(children.size).toBe(2);
  // sub-1, forgotten, comes back as the same child: no second id.child_seen.
  expect(children.resolve("sub-1", t0 + window + 2)).toBe(childSessionId(key, "sub-1"));
  expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'id.child_seen'`).get()).toEqual({ n: MAX_CHILDREN + 1 });
});

// #523: a live root's children stay live; a child whose root is gone, ended
// by a reap, by an older grayboard that knew no children, or pruned, ends.
// HEAD judges a child by its root, never by its own row (#539: a copy of the
// root's liveness for older releases), which goes when the child ends. Here
// each copy names this live process, so only the root can end it, except the
// live root's child's, whose dead copy must not end it.
test("reading live sessions keeps a live root's children and ends those whose root is dead, ended or pruned", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const live = "id:0123456789abc", dead = "id:0123456789abd", old = "id:0123456789abe", pruned = "id:0123456789abf";
  registerSession(db, { ...thisSession(live), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  for (const id of [dead, old, pruned]) registerSession(db, { ...thisSession(id), pid: process.pid, proc_start: procStart(process.pid) ?? null });
  const childOf = (root: string) => `id:${root.slice(-3)}0000000000`;
  for (const root of [live, dead, old, pruned]) registerChild(db, root, childOf(root), `child-of-${root}`);
  // dead: its process is gone, so a reap ends it. old: an older grayboard ended it and dropped its row.
  // pruned: its ids row is past retention.
  db.prepare(`UPDATE bindings SET pid = 999999, proc_start = NULL WHERE session_id = ?`).run(dead);
  db.prepare(`UPDATE ids SET ended_at = 5 WHERE id = ?`).run(old);
  db.prepare(`DELETE FROM bindings WHERE session_id IN (?, ?)`).run(old, pruned);
  db.prepare(`DELETE FROM ids WHERE id = ?`).run(pruned);
  db.prepare(`UPDATE bindings SET pid = 999999, proc_start = NULL WHERE session_id = ?`).run(childOf(live));

  const r = liveSessions(db);
  expect(r.alive.map((s) => s.session_id)).toEqual([live]);
  const ended = (id: string) => (db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(id) as { ended_at: number | null }).ended_at;
  expect(ended(childOf(live))).toBeNull();
  for (const root of [dead, old, pruned]) expect(ended(childOf(root))).not.toBeNull();
  const whys = Object.fromEntries((db.prepare(`SELECT target, detail FROM audit_log WHERE action = 'id.ended'`).all() as { target: string; detail: string }[])
    .map((a) => [a.target, JSON.parse(a.detail).why]));
  expect(whys).toMatchObject({ [childOf(dead)]: `its root ${dead} ended`, [childOf(old)]: `its root ${old} ended`, [childOf(pruned)]: `its root ${pruned} ended` });
  expect(whys).not.toHaveProperty(childOf(live));
  // The ended children's rows went with them; the live root's child keeps its copy.
  expect(db.prepare(`SELECT session_id FROM bindings ORDER BY session_id`).all()).toEqual([{ session_id: live }, { session_id: childOf(live) }]);
  // A second read finds nothing more to end.
  expect(liveSessions(db)).toMatchObject({ alive: [{ session_id: live }], ended: [] });
});
