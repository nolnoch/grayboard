// #807 P3 C67b: write dedup's races on Postgres (c6c7-scope §5.2 T-C6-3…5, docs/future/postgres-server.md D3 write
// dedup), each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts,
// and the test waits until B is blocked on a lock or done. They run the real dedupWrite over a minimal repo (it reaches
// only writeReceipts, and writeAudit only now and audit.write on a Tx), writing its message through makePgMessages. The
// end state is asserted before `waited`, so a race whose form is gone fails on what it broke (two messages for one
// call, a failed write holding the key to its caller's commit), not on a timeout. Without GRAYBOARD_TEST_PG_URL they
// skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { BLOCK_WAIT_MS, blockedOrSettled, committed, gate, outcome, pgPair, race, settle, type PgPair, type Settled } from "../../../../tests/support/pg_race.ts";
import { until } from "../../../../tests/support/until.ts";
import type { Repo } from "../../db.ts";
import { dedupWrite, fingerprint, type DedupCall, type DedupOutcome, type Written } from "../../write_dedup.ts";
import { MESSAGE_LIMITS } from "../messages.contract.ts";
import type { Tx } from "../tx_base.ts";
import type { WriteReceiptsStore } from "../write_receipts.ts";
import { makePgAudit } from "./audit.ts";
import { makePgMessages } from "./messages.ts";
import { int8 } from "./sql.ts";
import { makePgWriteReceipts } from "./write_receipts.ts";

const T0 = 1_800_000_000_000;
const A = "a@example.com/fe", B = "b@example.com/be";
const call: DedupCall = { tool: "dm_send", session: "sess-1", sender: A, actor: "a@example.com", transport: "hosted", args: { to: B, body: "hi" }, resend: false };
const FP = fingerprint(call.tool, call.session, call.sender, call.args);
const ms = makePgMessages({ clock: () => T0, attachmentLimits: MESSAGE_LIMITS });
const receipts = makePgWriteReceipts();

// What dedupWrite and writeAudit reach of a Repo; a post would mean an audit row off the body's Tx.
const repoOf = (writeReceipts: WriteReceiptsStore = receipts) => ({
  writeReceipts, audit: makePgAudit(), now: () => T0,
  post: () => { throw new Error("writeAudit posted: the row left the body's transaction"); },
}) as unknown as Repo;

type Sent = Written<{ message_id: number }>;
const send = async (tx: Tx): Promise<Sent> => {
  const m = await ms.insert(tx, A, "user", B, "hi", null);
  return { payload: { message_id: m.id }, ref: { kind: "message", id: m.id } };
};
const dedup = (repo: Repo, write: (tx: Tx) => Promise<Sent> = send) => (tx: Tx): Promise<DedupOutcome<Sent>> => dedupWrite(repo, tx, T0, call, write);

const messageIds = async (p: PgPair) => (await p.db.sql`SELECT id FROM messages ORDER BY id`).map((r: { id: unknown }) => int8(r.id));
const receiptRefs = async (p: PgPair) => (await p.db.sql`SELECT ref_kind, ref_id, result_json FROM write_receipts ORDER BY fp`)
  .map((r: Record<string, unknown>) => ({ ref_kind: r.ref_kind, ref_id: int8(r.ref_id), result_json: r.result_json }));
const actions = async (p: PgPair) => (await p.db.sql`SELECT action FROM access_log ORDER BY id`).map((r: { action: string }) => r.action);
// A fresh outcome's message id, or a replay's.
const sent = (o: unknown) => {
  const d = o as DedupOutcome<Sent>;
  return "fresh" in d ? { fresh: d.fresh.payload.message_id } : { replay: d.replay.message_id, ref: d.replay.replayed.ref };
};

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03, not on Bun's 5 s timeout.
setDefaultTimeout(30_000);

describePg("write dedup races (Postgres)", () => {
  // Mutation: the claim gone (find, then write and upsert): B's find misses A's uncommitted receipt, and both write.
  test("T-C6-3: two identical calls: one writes, the other waits on its receipt and replays it", async () => {
    await using p = await pgPair();
    const r = await race(p, dedup(repoOf()), dedup(repoOf()));
    const a = sent(committed(r.a));
    const id = a.fresh!;
    expect(sent(outcome(r.b))).toEqual({ replay: id, ref: { kind: "message", id } });
    expect(await messageIds(p)).toEqual([id]);
    expect(await receiptRefs(p)).toEqual([{ ref_kind: "message", ref_id: id, result_json: JSON.stringify({ message_id: id }) }]);
    expect(await actions(p)).toEqual(["request.replayed"]);
    expect(r.waitEvent).toBe("transactionid");
  });

  // Mutation: dedupWrite's savepoint removed (A's claim stays in its open transaction after the write throws: B waits
  // for A's outer commit instead of settling while A is still open).
  test("T-C6-4: a write that throws frees its claim at the savepoint's rollback: the identical call writes while the first's caller is still open", async () => {
    await using p = await pgPair();
    const inWrite = gate(), fail = gate(), held = gate(), release = gate();
    // A's write waits inside the claim's savepoint, then throws; A's caller catches it and holds its transaction open.
    const a = settle(p.a.write(async tx => {
      const failed = await settle(dedup(repoOf(), async () => { inWrite.open(); await fail.wait; throw new Error("write failed"); })(tx));
      held.open();
      await release.wait;
      return outcome(failed);
    }));
    let bDone = false, waitedOnClaim: string | null = null, settledWhileHeld = false;
    let b: Promise<Settled<DedupOutcome<Sent>>> | undefined;
    try {
      await Promise.race([inWrite.wait, a]);
      b = settle(p.b.write(dedup(repoOf()))).finally(() => { bDone = true; });
      // B's claim waits on A's uncommitted placeholder.
      waitedOnClaim = await blockedOrSettled(p, () => bDone, "B blocked on A's claim");
      fail.open();
      await Promise.race([held.wait, a]);
      // A's caller is still open: B settles now, or (its claim held to A's commit) not before the release.
      settledWhileHeld = (await settle(until(() => bDone, BLOCK_WAIT_MS, "B settled while A's caller held"))).ok;
    } finally {
      fail.open();
      release.open();
    }
    expect(outcome(await a)).toBe("threw Error: write failed");
    const bOut = sent(outcome(await b!));
    expect(settledWhileHeld).toBe(true);
    expect(await messageIds(p)).toEqual([bOut.fresh!]);
    expect(await receiptRefs(p)).toEqual([{ ref_kind: "message", ref_id: bOut.fresh!, result_json: JSON.stringify({ message_id: bOut.fresh }) }]);
    expect(waitedOnClaim).toBe("transactionid");
  });

  // Mutation: reclaim without its ref_id condition (B's reclaim, re-checked on A's committed receipt, still matches:
  // both write).
  test("T-C6-5: two repeats of a call whose message is gone: one reclaims and writes fresh, the other replays it", async () => {
    await using p = await pgPair();
    // The receipt names a message that no longer exists (retracted).
    const gone = await p.a.write(async tx => (await send(tx)).ref.id);
    await p.db.sql`DELETE FROM messages WHERE id = ${gone}`;
    await p.a.write(tx => receipts.upsert(tx, { session: call.session, sender: A, fp: FP, tool: call.tool, ref_kind: "message", ref_id: gone, result_json: JSON.stringify({ message_id: gone }), at: T0 - 1 }));
    // B finds the stale receipt and stops before reclaiming it; A, which finds it too, reclaims, writes and holds; then
    // B reclaims, on A's uncommitted row.
    const atReclaim = gate(), goB = gate(), held = gate(), release = gate();
    const slowReclaim: WriteReceiptsStore = { ...receipts, reclaim: async (...args) => { atReclaim.open(); await goB.wait; return receipts.reclaim(...args); } };
    let bDone = false, waitEvent: string | null = null;
    const b = settle(p.b.write(dedup(repoOf(slowReclaim)))).finally(() => { bDone = true; });
    let a: Promise<Settled<DedupOutcome<Sent>>> | undefined;
    try {
      await Promise.race([atReclaim.wait, b]);
      a = settle(p.a.write(async tx => { const v = await dedup(repoOf())(tx); held.open(); await release.wait; return v; }));
      await Promise.race([held.wait, a]);
      goB.open();
      waitEvent = await blockedOrSettled(p, () => bDone, "B blocked on A's reclaimed receipt");
    } finally {
      goB.open();
      release.open();
    }
    const id = sent(committed(await a!)).fresh!;
    expect(id).not.toBe(gone);
    expect(sent(outcome(await b))).toEqual({ replay: id, ref: { kind: "message", id } });
    expect(await messageIds(p)).toEqual([id]);
    expect(await actions(p)).toEqual(["request.receipt_stale", "request.replayed"]);
    expect(waitEvent).toBe("transactionid");
  });
});
