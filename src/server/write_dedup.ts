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
import type { Repo, Sync } from "./db.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";
import type { Replayed, WriteRef } from "../shared/protocol.ts";

export type DedupTool = "dm_send" | "board_post" | "delegate";

// Sorted keys, no whitespace, strings encoded as JSON (UTF-8), no Unicode
// normalization. A key whose value is undefined is left out, as
// JSON.stringify does; any other value JSON can't carry is refused, so two
// different calls can never encode alike.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: ${v} isn't JSON`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof v} isn't JSON`);
}

// Hex sha256 of the call. `args` are the arguments after the server resolved
// them (a recipient's full handle, a normalized board, attachments by blob
// digest), so two spellings of one call collide; `resend` is never in them.
export function fingerprint(tool: DedupTool, session: string, sender: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ tool, session, sender, args })).digest("hex");
}

// One call to dedup. session: the calling session's ID (on WSS, ws.data.sessionId),
// so sibling subagents writing under one name don't collapse. sender: the
// address the written row records. actor: the user's email, for the audit
// rows. transport: which server path took the call, for those rows.
export type DedupCall = {
  tool: DedupTool;
  session: string;
  sender: string;
  actor: string;
  transport: "wss" | "hosted";
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
// uploads). The lookup, the write, the
// receipt and the audit row are one IMMEDIATE transaction (a savepoint inside
// an open one): two calls can't interleave, and a write that throws leaves no
// receipt. `now` is the hub's clock.
export function dedupWrite<W extends Written>(
  repo: Repo, now: number, call: DedupCall, write: () => Sync<W>, onReplay: () => void = () => {},
): DedupOutcome<W> {
  const fp = fingerprint(call.tool, call.session, call.sender, call.args);
  const since = now - WRITE_DEDUP_WINDOW_MS;
  return repo.atomic((): DedupOutcome<W> => {
    const receipts = repo.writeReceipts;
    // Bounds one session's rows by what it wrote in the window.
    receipts.pruneSession(call.session, since);
    if (!call.resend) {
      const hit = receipts.find(call.session, call.sender, fp, since);
      // A receipt whose row is gone (retracted, pruned) is a miss: the upsert below replaces it.
      if (hit && receipts.refExists(hit.ref_kind, hit.ref_id)) {
        const ref: WriteRef = { kind: hit.ref_kind, id: hit.ref_id };
        const first_at = new Date(hit.at).toISOString();
        const stored = JSON.parse(hit.result_json) as W["payload"];
        writeAudit(repo, "request.replayed", call.actor, call.sender, {
          tool: call.tool, fp, ref_kind: ref.kind, ref_id: ref.id, first_at, transport: call.transport, session: call.session,
        });
        onReplay();
        return { replay: { ...stored, replayed: { first_at, ref }, note: replayNote(call, stored, first_at, ref) } };
      }
    }
    const w = write() as W;
    receipts.upsert({
      session: call.session, sender: call.sender, fp, tool: call.tool,
      ref_kind: w.ref.kind, ref_id: w.ref.id, result_json: JSON.stringify(w.payload), at: now,
    });
    // A deliberate repeat, told apart from a fresh first call.
    if (call.resend) {
      writeAudit(repo, "request.resent", call.actor, call.sender, { tool: call.tool, fp, ref_kind: w.ref.kind, ref_id: w.ref.id, session: call.session });
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
