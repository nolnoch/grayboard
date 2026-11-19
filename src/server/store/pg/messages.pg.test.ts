// #807 P3 C5b: the messages store's races on Postgres (c5-scope §5.2 T-C5-7…12, docs/future/postgres-server.md D3),
// each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the
// race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose lock is
// gone fails on what it broke (a raw 23503, a retracted message that was read, an orphan ack, a leftover message row),
// not on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { CoreError } from "../../../core/errors.ts";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import { MissingParent } from "../errors.ts";
import { MESSAGE_LIMITS } from "../messages.contract.ts";
import type { Tx } from "../tx_base.ts";
import { makePgMessages } from "./messages.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf } from "./tx.ts";

const T0 = 1_800_000_000_000;
const A = "a@example.com/fe", B = "b@example.com/be";
const by = { actor: "a@example.com", session: null };
let now = T0;
const ms = makePgMessages({ clock: () => now, attachmentLimits: MESSAGE_LIMITS });

async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

const messageRows = async (p: PgPair) => (await p.db.sql`SELECT id, parent_id, body FROM messages ORDER BY id`)
  .map((r: Record<string, unknown>) => ({ id: int8(r.id), parent_id: int8OrNull(r.parent_id), body: r.body }));
const ackRows = async (p: PgPair) => (await p.db.sql`SELECT reader, message_id FROM dm_acks ORDER BY reader`)
  .map((r: Record<string, unknown>) => ({ reader: r.reader, message_id: int8(r.message_id) }));
// A's message to B, the race's parent or retract target.
const root = (p: PgPair) => p.a.write(tx => ms.insert(tx, A, "user", B, "root", null));
const reply = (parentId: number, body = "reply") => (tx: Tx) => ms.insert(tx, B, "user", A, body, parentId);
const retract = (id: number) => (tx: Tx) => ms.retract(tx, A, id, by);

describePg("messages store races (Postgres)", () => {
  // Mutation: retract's FOR UPDATE dropped (its reply check misses the uncommitted reply; its DELETE then fails 23503).
  test("T-C5-7: a reply, then a retract of its parent: the retract answers replied", async () => {
    now = T0;
    await using p = await pgPair();
    const m = await root(p);
    const r = await race(p, reply(m.id), retract(m.id));
    const rep = committed(r.a);
    expect(outcome(r.b)).toBe("replied");
    expect(await messageRows(p)).toEqual([{ id: m.id, parent_id: null, body: "root" }, { id: rep.id, parent_id: m.id, body: "reply" }]);
    expect(r.waited).toBe(true);
  });

  // Mutations: the parent's FOR KEY SHARE dropped (the insert fails 23503, which aborts B's body: the caught form's
  // commit fails TxAborted); with it, the 23503 classifier too (the uncaught form rejects with the raw error).
  test("T-C5-8: a retract, then a reply to the retracted message: the reply refuses as a missing parent, even caught", async () => {
    now = T0;
    {
      await using p = await pgPair();
      const m = await root(p);
      const r = await race(p, retract(m.id), reply(m.id));
      expect(committed(r.a)).toBe("retracted");
      expect(r.b.ok ? "committed" : r.b.error).toBeInstanceOf(MissingParent);
      expect(await messageRows(p)).toEqual([]);
      expect(r.waited).toBe(true);
    }
    {
      await using p = await pgPair();
      const m = await root(p);
      // The caller catches the refusal and goes on to commit, as writeSend's savepoint-free paths may.
      const r = await race(p, retract(m.id), async tx => {
        const e = await caught(() => reply(m.id)(tx));
        const after = await ms.insert(tx, B, "user", A, "after", null);
        return { e, after: after.id };
      });
      const b = outcome(r.b) as { e: unknown; after: number };
      expect(b.e).toBeInstanceOf(MissingParent);
      expect((b.e as Error).message).toBe(`parent_id ${m.id} is not a message you sent or received`);
      expect(await messageRows(p)).toEqual([{ id: b.after, parent_id: null, body: "after" }]);
      expect(r.waited).toBe(true);
    }
  });

  // Mutation: delivered_at read before the lock (B reads it unset while A's stamp is uncommitted, and retracts a
  // delivered message).
  test("T-C5-9: a delivery stamp, then a retract: the retract answers read and the message stays", async () => {
    now = T0;
    await using p = await pgPair();
    const m = await root(p);
    const r = await race(p, tx => ms.markDelivered(tx, m.id, T0 + 5), retract(m.id));
    committed(r.a);
    expect(outcome(r.b)).toBe("read");
    expect((await ms.getById(p.a.read, m.id))?.delivered_at).toBe(T0 + 5);
    expect(r.waited).toBe(true);
  });

  // Mutation: ack as a plain INSERT … SELECT (no FOR KEY SHARE): ack first, the retract's ack delete misses the
  // uncommitted ack; retract first, the ack's read still sees the message. Either order leaves an orphan dm_acks row.
  test("T-C5-10: an ack racing a retract leaves no orphan ack, in either order", async () => {
    now = T0;
    {
      await using p = await pgPair();
      const m = await root(p);
      const r = await race(p, tx => ms.ack(tx, B, m.id), retract(m.id));
      committed(r.a);
      expect(outcome(r.b)).toBe("retracted");
      expect(await ackRows(p)).toEqual([]);
      expect(await messageRows(p)).toEqual([]);
      expect(r.waited).toBe(true);
    }
    {
      await using p = await pgPair();
      const m = await root(p);
      const r = await race(p, retract(m.id), tx => ms.ack(tx, B, m.id));
      expect(committed(r.a)).toBe("retracted");
      expect(outcome(r.b)).toBeUndefined();
      expect(await ackRows(p)).toEqual([]);
      expect(r.waited).toBe(true);
    }
  });

  // Mutation: retract's cursor read moved into its locked statement (that statement's snapshot predates A's cursor
  // write, and the lock wait re-checks only the message row, so B retracts a message its recipient has read).
  test("T-C5-10b: an ack and a cursor move past the message, then a retract: the retract answers read and the message stays", async () => {
    now = T0;
    await using p = await pgPair();
    const m = await root(p);
    // The ack's FOR KEY SHARE makes the retract wait; the cursor write commits with it.
    const r = await race(p, async tx => {
      await ms.ack(tx, B, m.id);
      await pgOf(tx)`INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (${B}, 'direct', ${B}, ${m.id})`;
    }, retract(m.id));
    committed(r.a);
    expect(outcome(r.b)).toBe("read");
    expect(await messageRows(p)).toEqual([{ id: m.id, parent_id: null, body: "root" }]);
    expect(await ackRows(p)).toEqual([{ reader: B, message_id: m.id }]);
    expect(r.waited).toBe(true);
  });

  // Mutations: the message inserted before the uploads are checked (the loser's message row stays when its caller
  // commits); the uploads' FOR UPDATE dropped (the loser's check passes on the unbound row, and its insert lands).
  test("T-C5-11: two sends binding one upload: one binds, the other refuses before it writes, even when its caller commits", async () => {
    now = T0;
    await using p = await pgPair();
    await p.db.sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES ('sha-1', 10, 0)`;
    const [{ id }] = await p.db.sql`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
      VALUES ('sha-1', 'f.txt', 'text/plain', 10, ${A}, 'a@example.com', 0) RETURNING id`;
    const f = int8(id);
    const files = { ids: [f], uploader: { addresses: [A], principal: "a@example.com" } };
    const send = (body: string) => (tx: Tx) => ms.insert(tx, A, "user", B, body, null, false, files);
    const r = await race(p, send("first"), async tx => {
      const e = await caught(() => send("second")(tx));
      const after = await ms.insert(tx, A, "user", B, "after", null);
      return { e, after: after.id };
    });
    const first = committed(r.a);
    expect(first.attachments?.map(a => a.id)).toEqual([f]);
    const b = outcome(r.b) as { e: unknown; after: number };
    expect(b.e).toBeInstanceOf(CoreError);
    expect((b.e as Error).message).toBe(`attachment ${f} isn't an unsent upload of yours`);
    expect((await messageRows(p)).map((m: { body: unknown }) => m.body)).toEqual(["first", "after"]);
    expect((await p.db.sql`SELECT message_id FROM attachments`).map((x: { message_id: unknown }) => int8(x.message_id))).toEqual([first.id]);
    expect(r.waited).toBe(true);
  });

  // Mutation: prune's lock-first dropped (its parent-null UPDATE misses the uncommitted reply; its DELETE then waits on
  // the reply's key-share lock and fails 23503).
  test("T-C5-12: a reply to an old message, then a prune: the prune succeeds and the reply stays, as a root", async () => {
    now = T0;
    await using p = await pgPair();
    const old = await root(p);
    now = T0 + 100;
    const r = await race(p, reply(old.id, "young reply"), tx => ms.prune(tx, T0 + 50));
    const rep = committed(r.a);
    expect(outcome(r.b)).toBeUndefined();
    expect(await messageRows(p)).toEqual([{ id: rep.id, parent_id: null, body: "young reply" }]);
    expect(r.waited).toBe(true);
  });
});
