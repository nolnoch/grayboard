// Append-write dedup (#254). A write the server committed but whose answer
// never reached the agent gets called again by the model, which shares no
// request identifier with the first call in any harness; only the content
// matches. So the server fingerprints the call (the calling session, the
// sender, the tool and its arguments as the server resolved them) and answers
// a repeat inside the window with the first call's result, marked replayed,
// instead of writing twice. `resend: true` writes again on purpose.
//
// Every server transport runs its dm_send, board_post and delegate writes
// through dedupWrite. Receipts go through the Repo facade (src/server/db.ts),
// so this module never touches a database handle.
import { createHash } from "node:crypto";

import { writeAudit } from "./audit.ts";
import type { Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { canonicalJson, WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";
import type { Replayed, WriteRef } from "../shared/protocol.ts";

export type DedupTool = "dm_send" | "board_post" | "delegate";

// Hex sha256 of the call. `args` are the arguments after the server resolved
// them (a recipient's full handle, a normalized board, attachments by blob
// digest), so two spellings of one call collide; `resend` is never in them.
export function fingerprint(tool: DedupTool, session: string, sender: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ tool, session, sender, args })).digest("hex");
}

// One call to dedup. session: the calling session's ID (a hosted session's ID),
// so sibling subagents writing under one name don't collapse. sender: the
// address the written row records. actor: the user's email, for the audit
// rows. transport: which server path took the call, for those rows.
export type DedupCall = {
  tool: DedupTool;
  session: string;
  sender: string;
  actor: string;
  transport: "bridge" | "hosted";
  args: Record<string, unknown>;
  resend: boolean;
};

// What a write returns: its transport-neutral result (no frame: a replay is
// framed as the transport frames any result, with the current request's id)
// and the row it made. A write may return more for its caller (what to push
// after the commit); only payload and ref are stored.
export type Written<P extends object = object> = { payload: P; ref: WriteRef };

export type DedupOutcome<W extends Written> =
  | { fresh: W }
  | { replay: W["payload"] & { replayed: Replayed; note: string } };

// Runs `write` unless an identical call by this session landed within the
// window and its row still exists; then the stored result comes back marked
// replayed, nothing else is written but a request.replayed audit row, and the
// caller must push, wake and audit nothing; `onReplay` runs in the replay's
// transaction, for what the repeat brought that nothing will use (its fresh
// uploads). The receipt is claimed before the write by one statement (D3,
// #807 P2-2), so of two identical calls under READ COMMITTED (D3) one writes
// and the other replays; the claim, the write, the receipt and the audit row are
// one savepoint inside the caller's transaction, and a write that throws
// leaves no receipt. `now` is the hub's clock. `recheck` runs on a hit, in the same
// transaction, before anything is answered or audited: it throws the refusal a
// fresh call would get when authority over what the first call wrote has gone
// since, so no replay outlives a revocation (docs/vision.md principle 11, #806).
export function dedupWrite<W extends Written>(
  repo: Repo, parent: Tx, now: number, call: DedupCall, write: (tx: Tx) => W | Promise<W>, onReplay: (tx: Tx) => void = () => {},
  recheck: (stored: W["payload"], tx: Tx) => void = () => {},
): Promise<DedupOutcome<W>> {
  const fp = fingerprint(call.tool, call.session, call.sender, call.args);
  const since = now - WRITE_DEDUP_WINDOW_MS;
  // write, onReplay and recheck run in the savepoint, on its Tx: the parent's refuses statements while it's open.
  return parent.savepoint(async (tx): Promise<DedupOutcome<W>> => {
    const receipts = repo.writeReceipts;
    const key = { session: call.session, sender: call.sender, fp };
    // Bounds one session's rows by what it wrote in the window, so a receipt the claim meets is inside it.
    await receipts.pruneSession(tx, call.session, since);
    // A lost claim reads the receipt that beat it. A pass that neither claims nor answers saw another transaction
    // change that receipt in between (pruned it, replaced a stale one first, or committed one already outside the
    // window after this call's prune), which a single writer never allows; three passes bound it.
    for (let pass = 0; !call.resend; pass++) {
      if (pass === 3) throw new Error(`write receipt for ${call.tool} by ${call.sender} kept changing under this call; retry it`);
      if (await receipts.claim(tx, key, call.tool, now)) break;
      const hit = await receipts.find(tx, call.session, call.sender, fp, since);
      if (!hit) {
        // A receipt committed after the prune can already be outside the window (a long transaction, a skewed
        // clock): prune again so the next claim isn't refused by a receipt the lookup can't see.
        await receipts.pruneSession(tx, call.session, since);
        continue;
      }
      // A receipt whose row is gone (retracted, pruned) is a miss: this call takes it over, unless another call
      // replaced it first, and the audit says why this repeat wrote fresh (#306).
      if (!(await receipts.refExists(tx, hit.ref_kind, hit.ref_id))) {
        if (!(await receipts.reclaim(tx, key, hit, now))) continue;
        writeAudit(repo, tx, "request.receipt_stale", call.actor, call.sender, {
          tool: call.tool, fp, ref_kind: hit.ref_kind, ref_id: hit.ref_id, first_at: new Date(hit.at).toISOString(), session: call.session,
        });
        break;
      }
      const ref: WriteRef = { kind: hit.ref_kind, id: hit.ref_id };
      const first_at = new Date(hit.at).toISOString();
      const stored = JSON.parse(hit.result_json) as W["payload"];
      recheck(stored, tx);
      writeAudit(repo, tx, "request.replayed", call.actor, call.sender, {
        tool: call.tool, fp, ref_kind: ref.kind, ref_id: ref.id, first_at, transport: call.transport, session: call.session,
      });
      onReplay(tx);
      return { replay: { ...stored, replayed: { first_at, ref }, note: replayNote(call, stored, first_at, ref) } };
    }
    const w = await write(tx);
    await receipts.upsert(tx, {
      session: call.session, sender: call.sender, fp, tool: call.tool,
      ref_kind: w.ref.kind, ref_id: w.ref.id, result_json: JSON.stringify(w.payload), at: now,
    });
    // A deliberate repeat, told apart from a fresh first call.
    if (call.resend) {
      writeAudit(repo, tx, "request.resent", call.actor, call.sender, { tool: call.tool, fp, ref_kind: w.ref.kind, ref_id: w.ref.id, session: call.session });
    }
    return { fresh: w };
  });
}

// Names the target, so a model repeating itself in a loop has a reason to
// notice, and the way to send again on purpose.
function replayNote(call: DedupCall, stored: object, firstAt: string, ref: WriteRef): string {
  const what =
    call.tool === "dm_send" ? `already sent to ${String(call.args.to)} at ${firstAt} as message ${ref.id}; this repeat was not sent.`
    : call.tool === "board_post" ? `already posted to #${String(call.args.board)} at ${firstAt} as post ${ref.id}; this repeat was not posted.`
    : `already delegated to ${String((stored as { to?: unknown }).to)} at ${firstAt} as message ${ref.id}; this repeat was not sent.`;
  return `${what} To send it again on purpose, call with resend: true.`;
}
