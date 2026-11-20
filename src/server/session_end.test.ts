// The server's composed session end (#807 P3 C10d2-a) writes what core endSession writes: both run on one fixture, each
// in a write body rolled back after, and leave the same rows (ids, holds, binding events, messages and bounces, read
// points, acks, claims and their events and watches, subscriptions, outbox, posts, uploads, the id.ended audit rows)
// and the same answer. Core runs here as the server ran it before C10d2-a: over the synchronous oracle Access
// (tests/support/sync_access.ts, installed by openBoardParity) with the server's mail tables behind a MailPort.
// The fixture: an ID holding two aliases with a child; unread direct mail to both from a live alias, a live ID, a
// human and an ended ID (unbounced), beside read and acked mail; a queue claim with a watcher, a ticket claim and a
// lapsed one; unbound and bound uploads; subscriptions.
import { beforeEach, expect, test } from "bun:test";
import { createBoard, post, registerId, subscribe, type CoreDb } from "../core/boards.ts";
import { insertUpload } from "../core/attachments.ts";
import { endSession, type MailPort } from "../core/session_end.ts";
import { boardAccess } from "./access.ts";
import { writeAudit } from "./audit.ts";
import type { Repo } from "./db.ts";
import { endSessionServer } from "./session_end.ts";
import type { Tx } from "./store/tx.ts";
import { B, BOB_ID, CHILD_ID, E, ENDED_ID, EVE_ID, openPostParity, settleTime, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

let repo: Repo;
let T1: number;
let NOW: number;

beforeEach(async () => {
  let db: CoreDb;
  ({ repo, db, T1 } = await openPostParity());
  void db;
  const at = T1 - 1_000;
  await seed(repo, async tx => {
    const core = repo.coreOn(tx);
    // Mail to WADE_ID: read (behind its read point), acked (still unread), and unread from four senders.
    const dm = (from: string, to: string, body: string) => repo.messages.insert(tx, from, "user", to, body, null);
    const read = await dm(`${B}/be`, WADE_ID, "read");
    const acked = await dm(`${B}/be`, WADE_ID, "acked");
    await dm(`${B}/be`, WADE_ID, "unread 1");
    await dm(EVE_ID, WADE_ID, "from a live ID");
    await dm(`${B}/human`, WADE_ID, "from a human");
    await dm(ENDED_ID, WADE_ID, "from an ended ID");
    await dm(`${B}/be`, WADE_ID, "unread 2");
    await dm(WADE_ID, WADE_ID, "to itself");
    await dm(WADE_ID, `${B}/be`, "sent by it");
    await dm(`${E}/be`, CHILD_ID, "to the child");
    await repo.cursors.advance(tx, WADE_ID, "direct", WADE_ID, read.id);
    await repo.messages.ack(tx, WADE_ID, acked.id);
    await repo.messages.ack(tx, `${B}/be`, read.id);
    // Claims held by the IDs: a queue claim on q with a watcher, a ticket claim, a lapsed one, the child's.
    const qp = post(core, `${E}/be`, "q", "for wade", null, { strictIds: true }).post.id;
    const claim = (key: string, holder: string, board: string | null, expires: number) =>
      core.prepare(`INSERT OR REPLACE INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, 'held', ?, ?, ?)`).run(key, holder, board, at, expires);
    claim(`queue:q:${qp}`, WADE_ID, "q", T1 + 3_600_000);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:q:${qp}`, `${B}/be`);
    claim("ticket:ENG-142", WADE_ID, "general", T1 + 3_600_000);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:ENG-142", `${E}/be`);
    claim("ticket:ENG-143", WADE_ID, null, at + 1);
    claim("ticket:CHILD", CHILD_ID, null, T1 + 3_600_000);
    // Uploads: unbound by each ID, one by WADE_ID bound to a message, one by another uploader.
    const up = (uploader: string, name: string) =>
      insertUpload(core, { sha256: name.padEnd(64, "0"), filename: `${name}.txt`, type: "text/plain", size: 10, uploader, quota: { principal: W, unsent: 1e9, stored: 1e9 }, now: at }).row.id;
    up(WADE_ID, "w1");
    up(CHILD_ID, "c1");
    const bound = up(WADE_ID, "w2");
    const carrier = await dm(WADE_ID, `${B}/be`, "with a file");
    core.prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`).run(carrier.id, bound);
    up(BOB_ID, "b1");
    // Subscriptions and a board of its own.
    subscribe(core, WADE_ID, "general", "push");
    subscribe(core, CHILD_ID, "q", "push");
    createBoard(core, `${W}/be`, "wade-only", "mine");
    subscribe(core, WADE_ID, "wade-only", "digest");
    // ENDED_ID is ended (openBoardParity); a second child of WADE_ID's, already ended, stays as it is.
    registerId(core, { id: "id:" + "4".repeat(64), principal: W, launcher: false, rootId: WADE_ID });
    core.prepare(`UPDATE ids SET ended_at = ? WHERE id = ?`).run(at, "id:" + "4".repeat(64));
  });
  NOW = Date.now() + 5;
});

// The server's mail tables as core's MailPort, synchronously on the body's connection (the deleted db.ts mailPort).
const mail = (db: CoreDb): MailPort => ({
  unread: id => db.query<{ id: number; sender: string }, [string]>(
    `SELECT m.id, m.sender FROM messages m WHERE m.recipient_type = 'user' AND m.recipient = ?1 AND m.sender <> ?1
       AND m.id > COALESCE((SELECT last_seen_id FROM mailbox_cursors WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1), 0)
     ORDER BY m.id`).all(id),
  bounce: (from, to, parentId, body, now) => {
    db.run(`INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind, human)
      VALUES (?1, ?1, 'user', ?2, ?3, ?4, ?5, 0, 'bounce', 0)`, [from, to, body, parentId, now]);
  },
  dropReader: id => {
    db.run(`DELETE FROM mailbox_cursors WHERE address = ?`, [id]);
    db.run(`DELETE FROM dm_acks WHERE reader = ?`, [id]);
  },
});

// Every table an end touches; a time past T1 settles by board_parity's rule ("now", an expiry "later+<minutes>m"), ids of
// rows the end wrote compare by order.
function rows(db: CoreDb): Record<string, unknown> {
  const q = (sql: string) => db.query(sql).all();
  const out = {
    ids: q(`SELECT id, principal, root_id, ended_at, held_aliases_json FROM ids ORDER BY id`),
    alias_holds: q(`SELECT address, id FROM alias_holds ORDER BY address`),
    binding_events: q(`SELECT session_id, name, event, detail, at FROM binding_events ORDER BY id`),
    messages: q(`SELECT id, sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind, human FROM messages ORDER BY id`),
    mailbox_cursors: q(`SELECT * FROM mailbox_cursors ORDER BY address, stream_type, stream_ref`),
    dm_acks: q(`SELECT reader, message_id FROM dm_acks ORDER BY reader, message_id`),
    claims: q(`SELECT * FROM claims ORDER BY key`),
    claim_events: q(`SELECT key, handle, event, note, board, expires_at, held_by, at, session_id FROM claim_events ORDER BY id`),
    claim_watches: q(`SELECT * FROM claim_watches ORDER BY key, handle`),
    subscriptions: q(`SELECT board, handle, mode, cursor, notified_id FROM subscriptions ORDER BY board, handle`),
    outbox: q(`SELECT * FROM outbox ORDER BY handle, post_id`),
    posts: q(`SELECT * FROM posts ORDER BY id`),
    attachments: q(`SELECT id, uploader, post_id, message_id FROM attachments ORDER BY id`),
    access_log: q(`SELECT actor, action, target, detail, at FROM access_log ORDER BY id`),
  };
  return JSON.parse(JSON.stringify(out, (k, x) => typeof x === "number" && x > T1 ? settleTime(T1, k, x) : x));
}

class Rollback { constructor(readonly value: unknown) {} }
async function rolledBack(f: (tx: Tx) => Promise<{ ended: boolean; held: string[]; wake: string[] }>): Promise<{ out: unknown; rows: Record<string, unknown> }> {
  try {
    await repo.write(async tx => {
      const r = await f(tx);
      throw new Rollback({ out: { ...r, held: [...r.held].sort(), wake: [...r.wake].sort() }, rows: rows(repo.coreOn(tx)) });
    });
  } catch (e) { if (e instanceof Rollback) return e.value as { out: unknown; rows: Record<string, unknown> }; throw e; }
  throw new Error("unreachable");
}

const audit = (tx: Tx) => (action: string, actor: string | null, target: string | null, detail?: Record<string, unknown>) =>
  writeAudit(repo, tx, action as never, actor, target, detail);
const coreEnd = (id: string, why: string) => rolledBack(async tx => endSession(repo.coreOn(tx), mail(repo.coreOn(tx)), id, { why, now: NOW, audit: audit(tx) }));
const serverEnd = (id: string, why: string) => rolledBack(tx => endSessionServer(repo, boardAccess(repo), tx, id, { why, now: NOW, audit: async (...a) => audit(tx)(...a) }));

test("the server's end leaves core endSession's rows and answer: a root with a child, every step", async () => {
  const core = await coreEnd(WADE_ID, "test");
  const server = await serverEnd(WADE_ID, "test");
  expect(server.out).toEqual(core.out);
  for (const t of Object.keys(core.rows)) expect({ t, rows: server.rows[t] }).toEqual({ t, rows: core.rows[t] });
  // The fixture reaches every step: bounces (one per live sender, a human's among them; the ended sender's unbounced),
  // the child's end, the claims' release and lapse, the watchers told, the subscriptions, read point, acks and unbound
  // uploads gone, both holds released, and two id.ended rows.
  const c = core.rows as Record<string, Record<string, unknown>[]>;
  const bounces = c.messages!.filter(m => m.kind === "bounce");
  expect(bounces.map(b => b.recipient).sort()).toEqual([`${B}/be`, `${B}/human`, `${E}/be`, EVE_ID].sort());
  expect(bounces.every(b => b.human === 0 && b.pending === 0)).toBe(true);
  const ended = c.access_log!.filter(a => a.action === "id.ended");
  expect(ended.map(a => a.target)).toEqual([CHILD_ID, WADE_ID]);
  expect(JSON.parse(ended[1]!.detail as string)).toMatchObject({ held: [`${W}/be`, "eng/deploy"], bounced: 5, unbounced: 1, children: [CHILD_ID] });
  expect(c.claims!.map(r => r.key)).not.toContain("ticket:ENG-142");
  expect(c.claims!.map(r => r.key)).not.toContain("ticket:CHILD");
  expect(c.claim_events!.map(e => e.event)).toEqual(expect.arrayContaining(["release", "expire"]));
  expect(c.claim_watches!.some(w => w.key === "ticket:ENG-142")).toBe(false);
  expect(c.subscriptions!.some(s => s.handle === WADE_ID || s.handle === CHILD_ID)).toBe(false);
  expect(c.mailbox_cursors!.some(r => r.address === WADE_ID)).toBe(false);
  expect(c.dm_acks!.some(r => r.reader === WADE_ID)).toBe(false);
  expect(c.attachments!.filter(a => a.uploader === WADE_ID || a.uploader === CHILD_ID).map(a => a.message_id)).toEqual([expect.any(Number)]);
  expect(c.alias_holds!.some(h => h.id === WADE_ID)).toBe(false);
  expect(c.posts!.length).toBeGreaterThan((await seed(repo, async tx => repo.coreOn(tx).query("SELECT COUNT(*) AS n FROM posts").get() as { n: number })).n);
  expect(core.out).toMatchObject({ ended: true });
});

test("a child alone, an ended ID and an ID with no row end the same way on both", async () => {
  for (const [id, why] of [[CHILD_ID, "released"], [ENDED_ID, "again"], ["id:" + "9".repeat(64), "unknown"], [BOB_ID, ""]] as const) {
    const core = await coreEnd(id, why);
    const server = await serverEnd(id, why);
    expect({ id, out: server.out }).toEqual({ id, out: core.out });
    for (const t of Object.keys(core.rows)) expect({ id, t, rows: server.rows[t] }).toEqual({ id, t, rows: core.rows[t] });
  }
});

// A sender's latest unread message retracted after the end read it (Postgres's READ COMMITTED; SQLite's single writer
// can't interleave, so the store's bounce is stubbed to answer as a gone parent does): the bounce threads under the
// next-latest and names only what's left; with every parent gone the sender gets nothing, and none of it counts.
test("a bounce whose parent is gone retries under the next-latest unread message from that sender", async () => {
  const fromBe = await seed(repo, async tx => (await repo.messages.unreadFor(tx, WADE_ID)).filter(m => m.sender === `${B}/be`).map(m => m.id).sort((a, b) => a - b));
  expect(fromBe).toHaveLength(3);
  const run = (gone: Set<number>) => rolledBack(tx => {
    const stub: Repo = { ...repo, messages: { ...repo.messages, bounce: (t, from, to, parentId, body, now) =>
      to === `${B}/be` && gone.has(parentId) ? Promise.resolve(null) : repo.messages.bounce(t, from, to, parentId, body, now) } };
    return endSessionServer(stub, boardAccess(repo), tx, WADE_ID, { why: "test", now: NOW, audit: async (...a) => audit(tx)(...a) });
  });
  const detail = (r: { rows: Record<string, unknown> }) =>
    JSON.parse((r.rows.access_log as { action: string; target: string; detail: string }[]).find(a => a.action === "id.ended" && a.target === WADE_ID)!.detail);
  const toBe = (r: { rows: Record<string, unknown> }) => (r.rows.messages as { kind: string; recipient: string; parent_id: number; body: string }[])
    .filter(m => m.kind === "bounce" && m.recipient === `${B}/be`);

  const one = await run(new Set([fromBe[2]!]));
  expect(toBe(one).map(m => m.parent_id)).toEqual([fromBe[1]!]);
  expect(toBe(one)[0]!.body).toMatch(new RegExp(`earlier message ${fromBe[0]};`));
  expect(detail(one)).toMatchObject({ bounced: 4, unbounced: 1 });
  expect((one.out as { wake: string[] }).wake).toContain(`${B}/be`);

  const all = await run(new Set(fromBe));
  expect(toBe(all)).toEqual([]);
  expect(detail(all)).toMatchObject({ bounced: 2, unbounced: 1 });
  expect((all.out as { wake: string[] }).wake).not.toContain(`${B}/be`);
});
