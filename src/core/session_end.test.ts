import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { storeAttachment } from "./attachments.ts";
import { holdAlias } from "./bindings.ts";
import { createBoard, ensureAlias, openAccess, post, registerId, setAccess, subscribe } from "./boards.ts";
import { claim, sweepExpired, watch } from "./claims.ts";
import { CoreError } from "./errors.ts";
import { assertDeliverableId, endSession } from "./session_end.ts";
import { SqliteBlobs } from "../local/blobs.ts";
import { localMail } from "../local/mailbox.ts";
import { openLocalDb } from "../local/open.ts";

const ID = "id:0123456789abc";
const OTHER = "id:0123456789abd";

function bus() {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-end-")), "bus.db")).db;
  for (const id of [ID, OTHER]) registerId(db, { id, principal: null, launcher: false }, 1);
  for (const a of ["be", "fe", "qa"]) ensureAlias(db, a, a, 1);
  return db;
}

function send(db: ReturnType<typeof bus>, sender: string, recipient: string, body: string): number {
  return Number(db.prepare(`INSERT INTO messages (sender, sender_id, recipient, body, created_at) VALUES (?, NULL, ?, ?, 1)`).run(sender, recipient, body).lastInsertRowid);
}

function end(db: ReturnType<typeof bus>, id = ID, now = 10_000) {
  return db.transaction(() => endSession(db, localMail(db), id, { now })).immediate();
}

// #284 decision 10 / AC 2: unread ID mail bounces to the sent-as address,
// threaded under it, with the held-aliases hint; read mail, self-sends and
// mail from an ended ID don't.
test("unread mail to an ended ID bounces to its senders; nothing else does", () => {
  const db = bus();
  holdAlias(db, "fe", ID, 5);
  const read = send(db, "be", ID, "already read");
  db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES (?, ?)`).run(ID, read);
  const unread = send(db, "be", ID, "unread");
  send(db, ID, ID, "note to self");
  db.prepare(`UPDATE ids SET ended_at = 3 WHERE id = ?`).run(OTHER);
  send(db, OTHER, ID, "from a dead ID");

  const r = end(db);
  expect(r).toEqual({ ended: true, held: ["fe"], wake: ["be"] });
  expect(JSON.parse((db.prepare(`SELECT detail FROM audit_log WHERE action = 'id.ended'`).get() as { detail: string }).detail)).toMatchObject({ bounced: 1, unbounced: 1 });
  expect(db.prepare(`SELECT sender, sender_id, recipient, parent_id, kind, body FROM messages WHERE kind IS NOT NULL`).all()).toEqual([
    { sender: ID, sender_id: ID, recipient: "be", parent_id: unread, kind: "bounce", body: `${ID} ended at 1970-01-01T00:00:10.000Z before reading this; it held \`fe\`.` },
  ]);
});

// #284 decision 4 / AC 2: no row is left for the ID in any table that holds
// an address; its holds are released with detail session_end; its ids row
// is the one durable record.
test("the end leaves no row for the ID and releases its aliases", async () => {
  const db = bus();
  holdAlias(db, "fe", ID, 5);
  createBoard(db, "be", "work", "work items");
  subscribe(db, ID, "work", "push");
  const p = post(db, "be", "work", "a work item");
  expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE handle = ?`).get(ID)).toEqual({ n: 1 });
  db.prepare(`INSERT INTO thread_mutes (handle, root_id) VALUES (?, ?)`).run(ID, p.post.id);
  db.prepare(`INSERT INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, 1)`).run(ID, send(db, "be", ID, "x"));
  db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES (?, 999)`).run(ID);
  await storeAttachment(db, new SqliteBlobs(db), ID, { filename: "a.txt", type: "text/plain", data: new TextEncoder().encode("hi") });
  claim(db, "be", "ticket:ENG-1", { ttl_minutes: 60, board: "work" });
  watch(db, ID, "ticket:ENG-1");

  end(db);
  for (const [table, col] of [["subscriptions", "handle"], ["outbox", "handle"], ["thread_mutes", "handle"], ["claim_watches", "handle"], ["dm_acks", "reader"], ["cursors", "reader"], ["attachments", "uploader"], ["alias_holds", "id"], ["claims", "holder"]]) {
    expect({ table, rows: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(ID) }).toEqual({ table, rows: { n: 0 } });
  }
  expect(db.prepare(`SELECT ended_at, held_aliases_json FROM ids WHERE id = ?`).get(ID)).toEqual({ ended_at: 10_000, held_aliases_json: `["fe"]` });
  expect(db.prepare(`SELECT name, event, detail FROM binding_events WHERE session_id = ?`).all(ID)).toEqual([{ name: "fe", event: "released", detail: "session_end" }]);
  expect(db.prepare(`SELECT action, target FROM audit_log WHERE action = 'id.ended'`).all()).toEqual([{ action: "id.ended", target: ID }]);
  // Ending it again changes nothing.
  expect(end(db, ID, 20_000)).toEqual({ ended: false, held: [], wake: [] });
});

// #284 decision 4: claims held by the ID are released through release(), so
// watchers get the release mention; a boardless claim that already lapsed
// is swept, not left behind or allowed to roll the end back.
test("the ID's live claims are released with their watchers told; lapsed ones are swept", () => {
  const db = bus();
  createBoard(db, "be", "work", "work items");
  subscribe(db, "be", "work", "push");
  claim(db, ID, "ticket:ENG-2", { board: "work", ttl_minutes: 60 });
  watch(db, "qa", "ticket:ENG-2");
  claim(db, ID, "ticket:ENG-3", { ttl_minutes: 1 });
  db.prepare(`UPDATE claims SET expires_at = 1 WHERE key = 'ticket:ENG-3'`).run();

  const r = end(db, ID, Date.now());
  expect(r.wake).toContain("qa");
  expect(db.prepare(`SELECT key FROM claims`).all()).toEqual([]);
  expect(db.prepare(`SELECT key, event FROM claim_events WHERE event IN ('release', 'expire') ORDER BY key`).all()).toEqual([
    { key: "ticket:ENG-2", event: "release" },
    { key: "ticket:ENG-3", event: "expire" },
  ]);
  expect((db.prepare(`SELECT body FROM posts WHERE author = ? ORDER BY id DESC LIMIT 1`).get(ID) as { body: string }).body).toContain("[release] ticket:ENG-2 — session ended cc @qa");
});

test("a send to an ID is refused when it ended, has no row, is a viewer or receives nothing", () => {
  const db = bus();
  expect(() => assertDeliverableId(db, ID)).not.toThrow();
  holdAlias(db, "fe", ID, 5);
  end(db);
  expect(() => assertDeliverableId(db, ID)).toThrow(`id_ended: ${ID} ended at 1970-01-01T00:00:10.000Z; it held \`fe\``);
  expect(() => assertDeliverableId(db, "id:0123456789abz")).toThrow("not_found");
  db.prepare(`UPDATE ids SET viewer = 1 WHERE id = ?`).run(OTHER);
  expect(() => assertDeliverableId(db, OTHER)).toThrow("not_found");
  db.prepare(`UPDATE ids SET viewer = 0, delivery = 'none', writes_as = 'be' WHERE id = ?`).run(OTHER);
  expect(() => assertDeliverableId(db, OTHER)).toThrow(`no_delivery: ${OTHER} is a tools-only session and receives nothing; send to be`);
});

// #523: a child's ID is never an address, live or ended: the refusal names
// the address its root writes as, whatever state the root is in.
test("a send to a child session's ID is refused child_session, naming its root's primary", () => {
  const db = bus();
  const child = "id:0123456789abe";
  registerId(db, { id: child, principal: null, launcher: false, rootId: ID }, 2);
  expect(db.prepare(`SELECT delivery, root_id FROM ids WHERE id = ?`).get(child)).toEqual({ delivery: "none", root_id: ID });
  const refused = (primary: string) => `child_session: ${child} is a subagent acting under session ${ID} and receives nothing; send to ${primary}`;
  // An unbound root writes as its ID; a bound one as the hold it bound first (not the alphabetically first).
  expect(() => assertDeliverableId(db, child)).toThrow(refused(ID));
  holdAlias(db, "qa", ID, 7);
  holdAlias(db, "fe", ID, 5);
  expect(() => assertDeliverableId(db, child)).toThrow(refused("qa"));
  // A tools-only root writes as its alias.
  db.prepare(`DELETE FROM alias_holds WHERE id = ?`).run(ID);
  db.prepare(`UPDATE ids SET writes_as = 'be' WHERE id = ?`).run(ID);
  expect(() => assertDeliverableId(db, child)).toThrow(refused("be"));
  db.prepare(`UPDATE ids SET writes_as = NULL WHERE id = ?`).run(ID);
  // Ended, root and child: still child_session (not id_ended), naming the first alias the root held.
  holdAlias(db, "fe", ID, 5);
  end(db);
  expect(db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(child)).toEqual({ ended_at: 10_000 });
  expect(() => assertDeliverableId(db, child)).toThrow(refused("fe"));
  // A mention is refused alike, and nothing is posted.
  createBoard(db, "be", "work", "work items");
  expect(() => post(db, "be", "work", `ping @${child}`, null, { strictIds: true })).toThrow(refused("fe"));
  expect(db.prepare(`SELECT COUNT(*) AS n FROM posts`).get()).toEqual({ n: 0 });
});

// #523: a root's end ends its live children in the same transaction, each
// audited with why; the root's id.ended lists them; an ended child is left alone.
test("a root's end ends its live child sessions, audited, and wakes what their ends wake", () => {
  const db = bus();
  const [live, gone, unrelated] = ["id:0123456789abe", "id:0123456789abf", "id:0123456789abg"];
  registerId(db, { id: live, principal: null, launcher: false, rootId: ID }, 2);
  registerId(db, { id: gone, principal: null, launcher: false, rootId: ID }, 2);
  registerId(db, { id: unrelated, principal: null, launcher: false, rootId: OTHER }, 2);
  db.prepare(`UPDATE ids SET ended_at = 3 WHERE id = ?`).run(gone);
  // A claim the child took as itself is released by its end, waking the watcher.
  createBoard(db, "be", "work", "work items");
  claim(db, live, "ticket:ENG-6", { board: "work", ttl_minutes: 60 });
  watch(db, "qa", "ticket:ENG-6");

  const r = end(db, ID, Date.now());
  expect(r.wake).toContain("qa");
  const ended = (db.prepare(`SELECT id, ended_at FROM ids WHERE id IN (?, ?, ?) ORDER BY id`).all(live, gone, unrelated) as { id: string; ended_at: number | null }[]);
  expect(ended.map((e) => [e.id, e.ended_at === null ? null : e.ended_at === 3 ? 3 : "now"])).toEqual([[live, "now"], [gone, 3], [unrelated, null]]);
  const audits = (db.prepare(`SELECT target, detail FROM audit_log WHERE action = 'id.ended' ORDER BY rowid`).all() as { target: string; detail: string }[])
    .map((a) => ({ target: a.target, detail: JSON.parse(a.detail) }));
  expect(audits.map((a) => a.target)).toEqual([live, ID]);
  expect(audits[0]!.detail).toMatchObject({ held: [], why: `its root ${ID} ended` });
  expect(audits[1]!.detail).toMatchObject({ children: [live] });
  expect(db.prepare(`SELECT key FROM claims`).all()).toEqual([]);
});

// Audit S1 (#329): a claim event quotes its key, so a key naming an ID that
// later ended must not refuse the sweep, every other claim, or the holder's
// end. An author's own post naming that ID is still refused.
test("a claim key quoting a since-ended ID leaves sweeps, claims and ends working", () => {
  const db = bus();
  createBoard(db, "be", "work", "work items");
  const key = `review @${OTHER} output`;
  expect(claim(db, ID, key, { board: "work", addresses: [ID], session: ID }).ok).toBe(true);
  end(db, OTHER, Date.now());
  db.prepare(`UPDATE claims SET expires_at = ?`).run(Date.now() - 1);

  expect(() => sweepExpired(db)).not.toThrow();
  expect(claim(db, "be", "unrelated", {}).ok).toBe(true);
  expect(claim(db, ID, key, { board: "work", addresses: [ID], session: ID }).ok).toBe(true);
  end(db, ID, Date.now());
  expect(db.prepare(`SELECT key FROM claims WHERE holder = ?`).all(ID)).toEqual([]);
  expect(post(db, "be", "work", `ping @${OTHER}`).unresolved).toEqual([OTHER]);
  expect(() => post(db, "be", "work", `ping @${OTHER}`, null, { strictIds: true })).toThrow(`id_ended: ${OTHER}`);
});

// Audit S2 (#329): a release whose announcement fails still frees the claim,
// and the end's audit names it.
test("a claim whose release post fails is freed and recorded in id.ended", () => {
  const db = bus();
  createBoard(db, "be", "work", "work items");
  claim(db, ID, "ticket:ENG-4", { board: "work", ttl_minutes: 60 });
  watch(db, "qa", "ticket:ENG-4");
  setAccess(db, { ...openAccess(db), resolveMention: () => { throw new CoreError("mention refused"); } });

  end(db, ID, Date.now());
  expect(db.prepare(`SELECT key FROM claims`).all()).toEqual([]);
  expect(db.prepare(`SELECT key FROM claim_watches`).all()).toEqual([]);
  expect(db.prepare(`SELECT event, note FROM claim_events WHERE key = 'ticket:ENG-4' AND event = 'release'`).all()).toEqual([
    { event: "release", note: "session ended; announce failed: mention refused" },
  ]);
  const detail = JSON.parse((db.prepare(`SELECT detail FROM audit_log WHERE action = 'id.ended'`).get() as { detail: string }).detail);
  expect(detail.release_failed).toEqual([{ key: "ticket:ENG-4", error: "mention refused" }]);
});
