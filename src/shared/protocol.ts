import type { AttachmentInfo } from "./attachments.ts";

// Add an alias to this session's holds (#284 PR 4 S1): a bare name in the
// caller's own person scope, or scope/name. One already held answers ok and
// only applies meta. create: false refuses a name that has never existed
// (identity_unknown); absent, it's created lazily. meta: the alias's labels
// (S12, core parseAliasMeta).
export type BindRequest = {
  type: "bind"; req_id: string; alias: string; create?: boolean; meta?: Record<string, unknown>;
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
  | "invalid_registration"
  | "root_is_child"
  | "child_bound"
  | "child_registered_elsewhere"
  | "has_children";

// What `grayboard mcp --mode server` is told: the CLI refuses it itself (#282).
export const UPGRADE_REFUSAL = "this grayboard server no longer serves `grayboard mcp` over WebSocket; update the CLI (`grayboard update`) and use the hosted MCP entry";
/** A self-reported session fact (harness, model, effort) is stored as at most this many characters. */
export const SESSION_FACT_MAX = 64;
