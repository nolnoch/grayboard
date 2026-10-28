import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFUSED_COALESCE_MS, holdAlias, logBinding } from "../core/bindings.ts";
import { IdCollision, createBoard, declareHuman, openAccess, prunePosts, setAccess } from "../core/boards.ts";
import { claim, watch } from "../core/claims.ts";
import { acquireName, attachSession, candidateNames, liveSessions, reap, registerSession, thisSession, type SessionRow } from "./binding.ts";
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
