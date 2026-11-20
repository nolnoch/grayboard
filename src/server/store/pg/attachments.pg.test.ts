// #807 P3 C10c: the attachments store's races on Postgres (c10-scope §2 Q1-Q3, docs/future/postgres-server.md D3),
// each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the
// race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose guard is
// gone fails on what it broke (two uploads past one quota, a sweep's failed transaction, a prune stuck behind a send),
// not on a timeout. Each names the mutation it must catch. On SQLite none of these interleave: the single writer runs
// each body whole. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { blockedOrSettled, committed, gate, outcome, pgPair, race, settle, type PgPair, type Settled } from "../../../../tests/support/pg_race.ts";
import { DEFAULT_ATTACHMENT_LIMITS, UNBOUND_TTL_MS } from "../../../shared/attachments.ts";
import type { NewUpload, Uploader } from "../attachments.ts";
import type { Tx } from "../tx_base.ts";
import { bindLocked, lockUnsent } from "./attachment_rows.ts";
import { insertAttachment, insertCatalogEntry, makePgAttachments } from "./attachments.ts";
import { int8 } from "./sql.ts";
import { pgOf } from "./tx.ts";

const T0 = 1_800_000_000_000;
const ME = "you@example.com";
const FE = `${ME}/fe`, BE = `${ME}/be`;
const SHA = (c: string) => c.repeat(64);
const att = makePgAttachments();
const mine: Uploader = { addresses: [FE, BE], principal: ME };

const upload = (u: Partial<NewUpload>): NewUpload => ({ sha256: SHA("a"), filename: "a.txt", type: "text/plain", size: 60, uploader: FE, now: T0, ...u });
const rows = async (p: PgPair) => (await p.db.sql`SELECT sha256, uploader, message_id FROM attachments ORDER BY id`)
  .map((r: Record<string, unknown>) => ({ sha256: r.sha256, uploader: r.uploader, message_id: r.message_id === null ? null : int8(r.message_id) }));
const blobs = async (p: PgPair) => (await p.db.sql`SELECT sha256 FROM attachment_blobs ORDER BY sha256`).map((r: Record<string, unknown>) => r.sha256);
async function stored(p: PgPair, sha256: string, createdAt: number): Promise<number> {
  await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${sha256}, 60, ${createdAt}) ON CONFLICT DO NOTHING`;
  const [r] = await p.db.sql`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
    VALUES (${sha256}, 'f.txt', 'text/plain', 60, ${FE}, ${ME}, ${createdAt}) RETURNING id`;
  return int8(r.id);
}

describePg("attachments store races (Postgres)", () => {
  // Mutation: insertUpload's quota lock removed (B's count misses A's uncommitted row: both stored, 120 bytes under a
  // 100-byte cap).
  test("Q1: two uploads by one principal that each fit and together don't: one stored, the other refused over quota", async () => {
    await using p = await pgPair();
    const quota = { principal: ME, unsent: 100, stored: 1_000_000 };
    const r = await race(p,
      tx => att.insertUpload(tx, upload({ quota })),
      tx => att.insertUpload(tx, upload({ sha256: SHA("b"), uploader: BE, quota })));
    expect(committed(r.a).row.sha256).toBe(SHA("a"));
    expect(outcome(r.b)).toBe("threw TooLargeError: your unsent uploads would exceed 100B; send or wait for them to expire");
    expect(await rows(p)).toEqual([{ sha256: SHA("a"), uploader: FE, message_id: null }]);
    expect(r.waited).toBe(true);
    expect(r.waitEvent).toBe("advisory");
  });

  // Two principals' uploads don't share the lock: neither waits (a lock keyed by anything coarser would).
  test("Q1b: two principals' uploads don't wait on each other's quota lock", async () => {
    await using p = await pgPair();
    const r = await race(p,
      tx => att.insertUpload(tx, upload({ quota: { principal: ME, unsent: 100, stored: 100 } })),
      tx => att.insertUpload(tx, upload({ sha256: SHA("b"), uploader: "them@example.com/sim", quota: { principal: "them@example.com", unsent: 100, stored: 100 } })));
    expect(committed(r.a).row.uploader).toBe(FE);
    expect((outcome(r.b) as { row: { uploader: string } }).row.uploader).toBe("them@example.com/sim");
    expect(r.waited).toBe(false);
  });

  // Q2, a sweep's catalog drop racing an upload of the same blob. Upload first: the drop waits on the entry the upload
  // locked, and its NOT EXISTS reads the snapshot from before the upload commits, so its delete goes ahead once the
  // upload commits and fails the foreign key (23503 attachments_sha256_fkey).
  // Mutation: the 23503 not caught in dropBlobEntry (the sweep's transaction fails); the savepoint dropped (the catch
  // answers 0 but the body's next statement fails 25P02).
  test("Q2a: a catalog drop racing an uncommitted upload of its blob answers 0, its body commits, and the entry survives", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${SHA("a")}, 60, 1), (${SHA("z")}, 60, 1)`;
    const sweep = async (tx: Tx) => [await att.dropBlobEntry(tx, SHA("a")), await att.dropBlobEntry(tx, SHA("z"))];
    const r = await race(p, tx => att.insertUpload(tx, upload({})), sweep);
    expect(committed(r.a).row.sha256).toBe(SHA("a"));
    expect(outcome(r.b)).toEqual([0, 1]);
    expect(await blobs(p)).toEqual([SHA("a")]);
    expect(await rows(p)).toEqual([{ sha256: SHA("a"), uploader: FE, message_id: null }]);
    expect(r.waited).toBe(true);
  });

  // Drop first: the upload's insert-if-absent waits on the drop's deleted entry, then inserts it afresh.
  // A plain catalog INSERT would pass here too (it waits the same way); the contract's shared-entry row (AC-2) catches
  // ON CONFLICT DO NOTHING removed.
  test("Q2b: an upload racing an uncommitted catalog drop of its blob waits, then re-inserts the entry", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${SHA("a")}, 60, 1)`;
    const r = await race(p, tx => att.dropBlobEntry(tx, SHA("a")), tx => att.insertUpload(tx, upload({ now: T0 })));
    expect(committed(r.a)).toBe(1);
    expect((outcome(r.b) as { row: { sha256: string } }).row.sha256).toBe(SHA("a"));
    const [entry] = await p.db.sql`SELECT created_at FROM attachment_blobs WHERE sha256 = ${SHA("a")}`;
    expect(int8(entry.created_at)).toBe(T0);
    expect(await rows(p)).toEqual([{ sha256: SHA("a"), uploader: FE, message_id: null }]);
    expect(r.waited).toBe(true);
  });

  // Q2d: the upload between its two inserts, on an existing entry (a known blob). The catalog insert locks the entry,
  // so a drop there waits, then fails the foreign key once the upload's row commits, and answers 0.
  // Mutation: the catalog insert as ON CONFLICT DO NOTHING (it locks nothing: the drop deletes the entry and commits
  // without waiting, and the upload's row insert fails 23503).
  test("Q2d: a catalog drop between an upload's catalog insert and its row's waits for the upload; the entry survives", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${SHA("a")}, 60, 1)`;
    const u = upload({});
    const held = gate(), release = gate();
    // insertUpload's two inserts, the race held between them.
    const a = settle(p.a.write(async tx => {
      await insertCatalogEntry(pgOf(tx), u);
      held.open();
      await release.wait;
      return insertAttachment(pgOf(tx), u);
    }));
    let waitEvent: string | null = null, b!: Promise<Settled<number>>;
    try {
      await Promise.race([held.wait, a]);
      let done = false;
      b = settle(p.b.write(tx => att.dropBlobEntry(tx, SHA("a")))).finally(() => { done = true; });
      waitEvent = await blockedOrSettled(p, () => done);
    } finally {
      release.open();
    }
    expect(committed(await a).sha256).toBe(SHA("a"));
    expect(outcome(await b)).toBe(0);
    expect(await blobs(p)).toEqual([SHA("a")]);
    expect(await rows(p)).toEqual([{ sha256: SHA("a"), uploader: FE, message_id: null }]);
    expect(waitEvent).not.toBeNull();
  });

  // dropBlobEntry answers 0 for its own constraint's 23503 only (#807 P3 C10c audit 5). Another table's foreign key on
  // the catalog (none exists in the schema; this test adds one) fails the drop, and so does a non-constraint error.
  // Mutation: the catch keyed on any 23503, or catching everything.
  test("Q2e: a catalog drop that fails on another constraint, or on a lock timeout, rejects; it doesn't answer 0", async () => {
    await using p = await pgPair();
    await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${SHA("a")}, 60, 1), (${SHA("b")}, 60, 1)`;
    await p.db.sql`CREATE TABLE blob_refs (sha256 text COLLATE "C" CONSTRAINT blob_refs_sha256_fkey REFERENCES attachment_blobs (sha256))`;
    await p.db.sql`INSERT INTO blob_refs VALUES (${SHA("a")})`;
    const other = await settle(p.a.write(tx => att.dropBlobEntry(tx, SHA("a"))));
    expect(other.ok ? other.value : (other.error as { errno?: string; constraint?: string })).toMatchObject({ errno: "23503", constraint: "blob_refs_sha256_fkey" });
    // The entry locked by another transaction until the drop has settled; the drop's 50 ms lock timeout (its deadline)
    // fails it 55P03, which propagates.
    const held = gate(), release = gate();
    const a = settle(p.a.write(async tx => {
      const n = (await pgOf(tx)`SELECT 1 FROM attachment_blobs WHERE sha256 = ${SHA("b")} FOR UPDATE`).length;
      held.open();
      await release.wait;
      return n;
    }));
    let timedOut: Settled<number>;
    try {
      await Promise.race([held.wait, a]);
      timedOut = await settle(p.b.write(async tx => { await pgOf(tx)`SET LOCAL lock_timeout = '50ms'`; return att.dropBlobEntry(tx, SHA("b")); }));
    } finally {
      release.open();
    }
    expect(committed(await a)).toBe(1);
    expect(timedOut.ok ? timedOut.value : (timedOut.error as { errno?: string }).errno).toBe("55P03");
    expect(await blobs(p)).toEqual([SHA("a"), SHA("b")]);
  });

  // A committed upload, held by a send binding it: the drop's NOT EXISTS sees the row and deletes nothing, without
  // waiting. Without it the delete's foreign-key check locks the referencing rows FOR KEY SHARE, which waits on the
  // send's FOR UPDATE, then fails 23503, which the catch answers as the same 0: only the wait shows it.
  // Mutation: dropBlobEntry's NOT EXISTS dropped (the drop waits on the send).
  test("Q2c: a catalog drop of a blob a committed upload names answers 0 without waiting on a send that holds the upload", async () => {
    await using p = await pgPair();
    const id = await stored(p, SHA("a"), T0);
    const r = await race(p, async tx => (await lockUnsent(pgOf(tx), [id], mine, DEFAULT_ATTACHMENT_LIMITS)).length, tx => att.dropBlobEntry(tx, SHA("a")));
    expect(committed(r.a)).toBe(1);
    expect(outcome(r.b)).toBe(0);
    expect(await blobs(p)).toEqual([SHA("a")]);
    expect(r.waited).toBe(false);
  });

  // Q3, an upload's prune racing a send that holds the expired upload's row to bind it (lockUnsent).
  // Mutation: pruneUnbound without SKIP LOCKED, or a plain DELETE (the prune waits on the send's row lock).
  test("Q3: an upload's prune skips the expired upload a send holds, never waiting on it, and prunes the rest", async () => {
    await using p = await pgPair();
    const cut = T0 - UNBOUND_TTL_MS;
    const held = await stored(p, SHA("h"), cut - 10);
    await stored(p, SHA("x"), cut - 10);
    const send = async (tx: Tx) => {
      const sql = pgOf(tx);
      const files = await lockUnsent(sql, [held], mine, DEFAULT_ATTACHMENT_LIMITS);
      const [m] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES (${FE}, 'user', 'b', 'm', 0) RETURNING id`;
      await bindLocked(sql, "message", int8(m.id), files, mine);
      return int8(m.id);
    };
    const r = await race(p, send, tx => att.insertUpload(tx, upload({ sha256: SHA("n") })));
    const msg = committed(r.a);
    expect((outcome(r.b) as { pruned: boolean }).pruned).toBe(true);
    expect(await rows(p)).toEqual([{ sha256: SHA("h"), uploader: FE, message_id: msg }, { sha256: SHA("n"), uploader: FE, message_id: null }]);
    expect(r.waited).toBe(false);
  });
});
