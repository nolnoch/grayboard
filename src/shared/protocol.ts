import type { AttachmentInfo } from "./attachments.ts";

export type Message = {
  id: number;
  sender: string;
  recipient_type: "user" | "team";
  recipient: string;
  body: string;
  parent_id: number | null;
  created_at: number;
  // Only when set: the sender marked it as owing a follow-up.
  pending?: true;
  // Only when it carries files.
  attachments?: AttachmentInfo[];
  // Only when set: "bounce", returned by a session that ended before reading it (#284 S12).
  kind?: "bounce";
};


// Add an alias to this session's holds (#284 PR 4 S1): a bare name in the
// caller's own person scope, or scope/name. One already held answers ok and
// only applies meta. create: false refuses a name that has never existed
// (identity_unknown); absent, it's created lazily. meta: the alias's labels
// (S12, core parseAliasMeta). restored_from: the public ID of the process
// this one restarted from, kept as audit only (S11: it proves nothing, so
// no status carries over). previous_key: the key of this process's own
// ended session, after a reconnect (PR 3 S4): a secret, so it
// proves descent where a public ID can't (#259), and the status carries over.
export type BindRequest = {
  type: "bind"; req_id: string; alias: string; create?: boolean; meta?: Record<string, unknown>; restored_from?: string; previous_key?: string;
};

// Hand work to a launcher session (#184): the server resolves the launcher
// (explicit `to`, or any live one; none live → the requester's human) and
// sends the payload pending. The reply is send_ok with `to` (and
// human_fallback on the degrade path) added.
export type DelegateRequest = { type: "delegate"; req_id: string; persona: string; task: string; context?: string; to?: string; resend?: boolean };

// The row an append write made (#254): a direct message or a board post.
export type WriteRef = { kind: "message" | "post"; id: number };
// On a result that repeats an earlier identical call's (#254): when that one
// landed and what it wrote. Nothing was written this time.
export type Replayed = { first_at: string; ref: WriteRef };
// A send's result without its frame: what the server stores to replay it.
export type SendResult  = {
  message_id: number; delivered_now: boolean;
  // Echoed when the request set it, so a client can tell this server recorded it.
  pending?: true;
  attachments?: AttachmentInfo[];
  // The address it went out as, when that isn't the session's primary (#284 S4).
  sent_as?: string;
  // When not delivered now: the recipient's last session, e.g. "14d ago", and
  // how many of your messages are queued for them, this one included.
  recipient_last_seen?: string; undelivered_from_you?: number; note?: string;
  replayed?: Replayed;
};
// A delegation's result: the ordinary fields plus which launcher took it
// (or the human fallback).
export type DelegateResult = SendResult & { to: string; human_fallback?: true };

// known: with identity_unknown, the user's names closest to the one asked for.
// holder: with alias_held, the session that holds the alias.
// retry_after_ms: on a rate_limited bind, the wait until one is accepted again.
export type ErrorMessage = { type: "error"; req_id?: string; code: ErrorCode; message: string; known?: string[]; holder?: string; retry_after_ms?: number };

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "bad_request" | "not_found"
  | "rate_limited" | "internal" | "superseded"
  // a hosted delivery lease holds as many receipts as it can (#204)
  | "receipt_capacity"
  // bind refused: another session holds the alias
  | "alias_held"
  // bind refused: create: false and the name has never existed
  | "identity_unknown"
  // a session key's ID is another principal's session or has ended (#284)
  | "id_collision"
  // the session has ended (#284 S4), or a send or mention named an ended ID
  | "id_ended"
  // a send or mention named an ID that receives nothing (a tools-only session)
  | "no_delivery"
  // a child session (a harness subagent, #523) called a tool that is its root's: bind, unbind, delivery,
  // or one that takes on or changes the root's read state (dm_inbox, dm_ack, board_subscribe;
  // childStateRefusal in src/core/bindings.ts); or a send or mention named a child's ID, which is
  // never an address (both modes)
  | "child_session"
  // Hosted MCP only (src/server/hosted.ts): a hosted
  // call that needs a bound name, and the hosted child-session registration refusals.
  | "unbound"
  | "upgrade_required"
  | "invalid_registration"
  | "root_is_child"
  | "child_bound"
  | "child_registered_elsewhere"
  | "has_children";

/** The protocol version a hello must carry; the refusal frame still reads it (#284 S15, #282). */
export const PROTO = 2;
/** What a hello without it is told: a 1.x client against a 2.x server. */
export const PROTO_REFUSAL = "this grayboard server is 2.x; update the CLI (`grayboard update`)";
// What a pre-removal `grayboard mcp --mode server` is told (#282). A 410 on the
// upgrade is invisible to every release (Bun's WebSocket exposes no status or
// body for a non-101), so the upgrade is accepted and the hello answered.
export const UPGRADE_REFUSAL = "this grayboard server no longer serves `grayboard mcp` over WebSocket; update the CLI (`grayboard update`) and use the hosted MCP entry";
/** A self-reported session fact (harness, model, effort) is stored as at most this many characters. */
export const SESSION_FACT_MAX = 64;
