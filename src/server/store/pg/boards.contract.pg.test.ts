// #807 P3 C10e1, C10e2: the boards contract (boards.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgBoards on a fixed clock. Each row gets its own database (the raw reads read whole tables). Without
// GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts). The races are pg/boards.pg.test.ts's.
// Also here: the store's clock stamps (ensure's created_at, read's and acknowledge's delivered_at), the restated
// normalizeBoard is core's, and laneRows' take subquery keeps idx_claim_events_take.
import { expect, test } from "bun:test";
import { describePg, pgDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { normalizeBoard as coreNormalizeBoard } from "../../../core/boards.ts";
import { boardsContract, type BoardsBackend, type BoardsHarness } from "../boards.contract.ts";
import { laneRowsStatement, makePgBoards, normalizeBoard } from "./boards.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions, pgOf } from "./tx.ts";

type Row = Record<string, unknown>;
// The store's clock: ensure's created_at, and read's and acknowledge's delivered_at stamps.
const CLOCK = 1_800_000_000_000;

const pgBoardsBackend: BoardsBackend = {
  kind: "postgres",
  open: async () => (await openPg()).h,
};

// The harness, and its database's read-write pool for the clock checks' raw reads.
async function openPg(): Promise<{ h: BoardsHarness; sql: PgDatabase["sql"] }> {
  const db = await pgDatabase({ max: 2 });
  const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-boards" });
  // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
  const sql = db.sql;
  let blob = 0;
  const rows = async <T>(q: Promise<Row[]>, f: (r: Row) => T) => (await q).map(f);
  const h: BoardsHarness = {
    boards: makePgBoards({ clock: () => CLOCK }),
    write: fn => s.write(fn),
    read: s.read,
    async alias(address, o = {}) {
      const cut = address.lastIndexOf("/");
      await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, human, queue_off, created_at, last_seen)
        VALUES (${address}, 'person', ${address.slice(0, cut)}, ${address.slice(cut + 1)}, ${o.human ? true : null}::boolean,
          ${o.queueOff ? true : null}::boolean, 0, ${o.lastSeen ?? null}::int8)`;
    },
    async session(id, principal, o = {}) {
      await sql`INSERT INTO ids (id, principal, started_at, last_seen, ended_at, viewer, root_id, status, status_at)
        VALUES (${id}, ${principal}::text, 0, 0, ${o.endedAt ?? null}::int8, ${o.viewer === true}, ${o.rootId ?? null}::text,
          ${o.status ?? null}::text, ${o.status === undefined ? null : 1}::int8)`;
    },
    async hold(address, id, boundAt) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, ${boundAt})`; },
    async claim(c) {
      await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user)
        VALUES (${c.key}, ${c.holder}, 'held', ${c.board}::text, ${c.at}, ${c.at + 60_000}, NULL)`;
    },
    async claimEvent(e) {
      await sql`INSERT INTO claim_events (key, handle, event, board, at, session_id)
        VALUES (${e.key}, ${e.handle}, ${e.event}, ${e.board}::text, ${e.at}, ${e.session ?? null}::text)`;
    },
    async push(handle, postId, session) {
      await sql`INSERT INTO outbox (handle, post_id, reason, session_id) VALUES (${handle}, ${postId}, 'subscription', ${session ?? null}::text)`;
    },
    async bindingEvent(e) {
      await sql`INSERT INTO binding_events (session_id, name, event, at) VALUES (${e.session}, ${e.name}, ${e.event}, ${e.at})`;
    },
    async watch(key, handle) { await sql`INSERT INTO claim_watches (key, handle) VALUES (${key}, ${handle})`; },
    upload: (uploader, principal, size) => sql.begin(async t => {
      const sha = `sha-${++blob}`;
      await t`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${sha}, ${size}, 0)`;
      const [r] = await t`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
        VALUES (${sha}, 'f.txt', 'text/plain', ${size}, ${uploader}, ${principal}::text, 0) RETURNING id`;
      return int8(r.id);
    }),
    subscription: async (board, handle) => (await rows(sql`SELECT mode, cursor, notified_id FROM subscriptions WHERE board = ${board} AND handle = ${handle}`,
      r => ({ mode: r.mode as string, cursor: int8(r.cursor), notified_id: int8(r.notified_id) })))[0],
    outboxRows: () => rows(sql`SELECT handle, post_id, reason, wake, delivered_at IS NOT NULL AS delivered FROM outbox ORDER BY post_id, handle COLLATE "C"`,
      r => ({ handle: r.handle as string, post_id: int8(r.post_id), reason: r.reason as string, wake: r.wake === true, delivered: r.delivered === true })),
    outboxSessions: () => rows(sql`SELECT handle, post_id, session_id FROM outbox ORDER BY post_id, handle COLLATE "C"`,
      r => ({ handle: r.handle as string, post_id: int8(r.post_id), session_id: r.session_id as string | null })),
    muteRows: () => rows(sql`SELECT handle, root_id FROM thread_mutes ORDER BY handle COLLATE "C", root_id`,
      r => ({ handle: r.handle as string, root_id: int8(r.root_id) })),
    postRow: async id => (await rows(sql`SELECT parent_id, human FROM posts WHERE id = ${id}`,
      r => ({ parent_id: int8OrNull(r.parent_id), human: r.human as boolean | null })))[0],
    claimRows: () => rows(sql`SELECT key, holder, note, board, acquired_at, expires_at, holder_user FROM claims ORDER BY key COLLATE "C"`,
      r => ({ key: r.key as string, holder: r.holder as string, note: r.note as string | null, board: r.board as string | null,
        acquired_at: int8(r.acquired_at), expires_at: int8(r.expires_at), holder_user: r.holder_user as string | null })),
    eventRows: () => rows(sql`SELECT key, handle, event, note, board, at FROM claim_events ORDER BY id`,
      r => ({ key: r.key as string, handle: r.handle as string, event: r.event as string, note: r.note as string | null, board: r.board as string | null, at: int8(r.at) })),
    watchRows: () => rows(sql`SELECT key, handle FROM claim_watches ORDER BY key COLLATE "C", handle COLLATE "C"`,
      r => ({ key: r.key as string, handle: r.handle as string })),
    holdRows: () => rows(sql`SELECT address, id FROM alias_holds ORDER BY address COLLATE "C"`, r => ({ address: r.address as string, id: r.id as string })),
    bindingEventRows: () => rows(sql`SELECT name, event, at FROM binding_events ORDER BY id`, r => ({ name: r.name as string, event: r.event as string, at: int8(r.at) })),
    attachmentRows: () => rows(sql`SELECT id, post_id FROM attachments ORDER BY id`, r => ({ id: int8(r.id), post_id: int8OrNull(r.post_id) })),
    async close() {
      await s.close();
      await db[Symbol.asyncDispose]();
    },
  };
  return { h, sql };
}

describePg("boards contract (Postgres)", () => boardsContract(pgBoardsBackend));

// The contract asserts only that ensure, read and acknowledge stamp a time (SQLite's core reads Date.now()); the
// Postgres store's is its clock.
describePg("boards store clock (Postgres)", () => {
  test("ensure stamps created_at from the store's clock", async () => {
    const { h } = await openPg();
    try {
      expect(await h.write(tx => h.boards.ensure(tx, "#Hall", "p", null, "a@example.com/be"))).toBe(true);
      expect((await h.boards.get(h.read, "hall"))?.created_at).toBe(CLOCK);
    } finally {
      await h.close();
    }
  });

  test("read and acknowledge stamp delivered_at from the store's clock", async () => {
    const { h, sql } = await openPg();
    try {
      const b = h.boards, BE = "a@example.com/be", FE = "a@example.com/fe", T0 = 1_700_000_000_000;
      const np = (body: string) => ({ board: "hall", author: BE, body, parentId: null, now: T0, expiresAt: null, authorId: null, via: null, authorUser: null, human: false });
      await h.write(tx => b.create(tx, { name: "hall", purpose: "p", scope: null, kind: "broadcast", createdBy: BE, now: T0 }));
      await h.write(tx => b.setSubscription(tx, FE, "hall", "push"));
      const read = (await h.write(tx => b.insertPost(tx, np("read")))).id;
      const acked = (await h.write(tx => b.insertPost(tx, np("acked")))).id;
      await h.write(tx => b.insertOutbox(tx, read, [[FE, { reason: "subscription", wake: false }]]));
      await h.write(tx => b.insertOutbox(tx, acked, [[FE, { reason: "mention", wake: true }]]));
      await h.write(tx => b.acknowledge(tx, FE, { kind: "push", post_id: acked }));
      await h.write(tx => b.read(tx, "hall", FE, { before_id: acked }));
      const stamps = (await sql`SELECT post_id, delivered_at FROM outbox WHERE handle = ${FE} ORDER BY post_id`)
        .map((r: Row) => [int8(r.post_id), int8OrNull(r.delivered_at)]);
      expect(stamps).toEqual([[read, CLOCK], [acked, CLOCK]]);
    } finally {
      await h.close();
    }
  });
});

test("the Postgres store's normalizeBoard is core's", () => {
  for (const input of ["hall", "#Hall", "#OPS_1-x", "a".repeat(32), "a".repeat(33), "", "#", "bad name", "é", "##hall", "HALL#"]) {
    let core: string, pg: string;
    try { core = coreNormalizeBoard(input); } catch (e) { core = `throws ${(e as Error).message}`; }
    try { pg = normalizeBoard(input); } catch (e) { pg = `throws ${(e as Error).message}`; }
    expect(pg).toBe(core);
  }
});

// #807 P3 C10 §1.6 (#1174 audit H1's index, without SQLite's `+e.key` pin): on a seeded, analyzed claim_events, the
// take subqueries still read idx_claim_events_take (board, handle, at) and, for the session-keyed takes (#1351),
// idx_claim_events_take_sid (board, session_id, at), not idx_claim_events_key's prefix range; the session-keyed pushes
// (#1370) read idx_outbox_session.
describePg("laneRows' plan (Postgres)", () => {
  test("the take subqueries use idx_claim_events_take and idx_claim_events_take_sid on a seeded table", async () => {
    const db = await pgDatabase({ max: 2 });
    try {
      const sql = db.sql;
      await sql`INSERT INTO boards (name, purpose, created_by, created_at, kind)
        SELECT 'q' || n, '', 'x', 0, 'queue' FROM generate_series(0, 49) n`;
      await sql`INSERT INTO subscriptions (board, handle, mode, cursor, notified_id)
        SELECT 'q0', 'h' || n, 'push', 0, 0 FROM generate_series(0, 19) n`;
      await sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_at)
        SELECT 'h' || n, 'person', 'x', 'h' || n, 0 FROM generate_series(0, 19) n`;
      // Every take a queue key: 50 boards x 200 handles x 10 takes, so the key prefix selects them all. Half carry
      // their taking session (#1351), half are from before the column.
      await sql`INSERT INTO claim_events (key, handle, event, board, at, session_id)
        SELECT 'queue:q' || (n % 50) || ':' || n, 'h' || (n % 200), CASE WHEN n % 5 = 0 THEN 'release' ELSE 'take' END, 'q' || (n % 50), n,
          CASE WHEN n % 2 = 1 THEN 's' || (n % 200) END
        FROM generate_series(0, 99999) n`;
      // 50k posts across the boards, each pushed to one handle; two in three carry their receiving session (#1370).
      await sql`INSERT INTO posts (board, author, body, created_at) SELECT 'q' || (n % 50), 'x', 'x', n FROM generate_series(0, 49999) n`;
      await sql`INSERT INTO outbox (handle, post_id, reason, session_id)
        SELECT 'h' || (p.id % 200), p.id, 'subscription', CASE WHEN p.id % 3 <> 1 THEN 's' || (p.id % 200) END FROM posts p`;
      await sql`ANALYZE`;
      const s = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-boards-plan" });
      try {
        const q = pgOf(s.read);
        const plan = (await q`EXPLAIN ${laneRowsStatement(q, "q0", ["h1"])}` as Row[]).map(r => r["QUERY PLAN"] as string).join("\n");
        expect(plan).toMatch(/\bidx_claim_events_take\b(?!_)/);
        expect(plan).toContain("idx_claim_events_take_sid");
        expect(plan).not.toContain("idx_claim_events_key");
        // The session-keyed pushes (#1370) by idx_outbox_session (session_id, post_id), and no outbox read a scan.
        expect(plan).toContain("idx_outbox_session");
        expect(plan).not.toContain("Seq Scan on outbox");
        // And the statement answers on the seeded table: every lane, the poster left out.
        const lanes = await makePgBoards({ clock: () => CLOCK }).laneRows(s.read, "q0", ["h1"]);
        expect(lanes).toHaveLength(19);
        expect(lanes).not.toContain("h1");
      } finally {
        await s.close();
      }
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });
});
