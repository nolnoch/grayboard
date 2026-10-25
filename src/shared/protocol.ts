import type { Pending, PendingRef } from "../core/boards.ts";
import type { InboxItem, PromiseItem } from "./inbox.ts";
import type { AttachmentInfo, AttachmentLimits } from "./attachments.ts";
import { SESSION_ID, SESSION_KEY, type Candidate } from "../core/bindings.ts";

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
};

// Client -> Server
// push: false is a tools-only connection beside the session that owns the
// identity (a harness that can't show pushes): no pushes, not "online".
// where: the client's describeLocation (the server can't see its files).
// resume: a reconnect within one session, so its peer_status stays.
// session_key: the client process's secret (#182 audit 4); the server
// derives the session ID, the key of its binding_events, from it
// (sessionIdOf), so no connection can present another session's ID.
// hold: with push: false, the connection holds its name as push does (the
// probe, binding events, claim moves) but gets no pushes and isn't online:
// a session whose harness can't show pushes (Claude Code without channels).
// from: the name a rebind leaves; its claims move to the new name if this
// session holds it by the record. Sent on a bind's first hello only.
// restored_from: the session ID of the process this one restarted from,
// taking back its name (#182 decision 14): logged, and its status stays.
// create: false refuses a name that has never existed (identity_unknown);
// absent, the name is created lazily, as before #182.
// read_only: an unbound session's connection (no identity; push must be
// false): board_list, board_read, peer_list and claim_list only. suggested:
// the checkout's default name, listed first among hello_ok.candidates.
export type HelloRequest = {
  type: "hello"; req_id: string; identity?: string; push?: boolean; where?: string; resume?: boolean;
  session_key?: string; hold?: boolean; from?: string; create?: boolean; read_only?: boolean; suggested?: string; restored_from?: string;
  // This session's harness can spawn subagents, so delegate requests may land
  // here (#184). Recorded on the handle's row; peer_list shows it.
  launcher?: boolean;
};
// attachment_ids: the sender's uploads (POST /api/attachments) to carry.
export type SendRequest    = { type: "send";    req_id: string; recipient: string; body: string; parent_id?: number; pending?: boolean; attachment_ids?: number[] };
// Hand work to a launcher session (#184): the server resolves the launcher
// (explicit `to`, or any live one; none live → the requester's human) and
// sends the payload pending. The reply is send_ok with `to` (and
// human_fallback on the degrade path) added.
export type DelegateRequest = { type: "delegate"; req_id: string; persona: string; task: string; context?: string; to?: string };
export type HistoryRequest = { type: "history"; req_id: string; peer?: string; limit?: number; before_id?: number };
export type ThreadRequest  = { type: "thread";  req_id: string; message_id: number };
export type AckRequest     = { type: "ack";     req_id: string; message_ids: number[] };
export type PongMessage    = { type: "pong" };
export type InboxRequest   = { type: "inbox";   req_id: string; days?: number };
export type DmAckRequest   = { type: "dm_ack";  req_id: string; message_id: number };
export type DmRetractRequest = { type: "dm_retract"; req_id: string; message_id: number };
// Board and claim tools (src/core/tools.ts), run server-side as this identity.
export type CallRequest    = { type: "call";      req_id: string; tool: string; args: Record<string, unknown> };
export type BoardAckRequest = { type: "board_ack"; req_id: string; refs: PendingRef[] };

export type ClientMessage =
  | HelloRequest | DelegateRequest | SendRequest | HistoryRequest | ThreadRequest | AckRequest | PongMessage
  | CallRequest | BoardAckRequest | InboxRequest | DmAckRequest | DmRetractRequest;

// Server -> Client
export type HelloOk     = {
  type: "hello_ok"; req_id: string; identity_full: string; user_email: string; teams: string[];
  // Sentences for the session's MCP instructions: active claims, and direct
  // messages you sent that still haven't arrived a day later.
  notices?: string[];
  // Your user's human identity. Sent by servers that reserve its name for the
  // Slack bridge, so a message from that handle can only be your user's.
  // linked: whether anyone reads it (the user has linked Slack).
  human?: { handle: string; linked: boolean };
  // This server's attachment size caps, for the client's checks before upload.
  attachment_limits?: AttachmentLimits;
  // A read-only hello: the user's free names an unbound session can bind.
  candidates?: Candidate[];
  // A hello that holds its name: the claim keys that moved from the name the
  // session left ([] when none did). A server from before #182 never sends
  // it, which is how the client tells it can't move claims or refuse names.
  moved?: string[];
  // A rebind whose claims stayed behind: why.
  not_moved?: string;
};
export type SendOk      = {
  type: "send_ok"; req_id: string; message_id: number; delivered_now: boolean;
  // Echoed when the request set it, so a client can tell this server recorded it.
  pending?: true;
  attachments?: AttachmentInfo[];
  // When not delivered now: the recipient's last session, e.g. "14d ago", and
  // how many of your messages are queued for them, this one included.
  recipient_last_seen?: string; undelivered_from_you?: number; note?: string;
};
// Messages you sent carry delivered: whether they've reached the recipient's session.
export type HistoryOk   = { type: "history_ok"; req_id: string; messages: (Message & { delivered?: boolean })[] };
export type ThreadOk    = { type: "thread_ok";  req_id: string; messages: Message[] };
export type AckOk       = { type: "ack_ok";     req_id: string };
export type InboxOk     = {
  type: "inbox_ok"; req_id: string; unanswered: InboxItem[]; promised?: PromiseItem[];
  undelivered_from_you?: { to: string; n: number; oldest_id: number; last_seen?: string }[];
};
export type PushMessage = { type: "push"; message: Message };
export type PingMessage = { type: "ping" };
export type CallOk      = { type: "call_ok";    req_id: string; result: unknown };
export type BoardPush   = { type: "board_push"; item: Pending };
// known: with identity_unknown, the user's names closest to the one asked for.
// holder: with identity_in_use, the live session that holds the name.
export type ErrorMessage = { type: "error"; req_id?: string; code: ErrorCode; message: string; known?: string[]; holder?: string };

export type ServerMessage =
  | HelloOk | SendOk | HistoryOk | ThreadOk | AckOk | PushMessage | PingMessage | ErrorMessage
  | CallOk | BoardPush | InboxOk;

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "bad_request" | "not_found"
  | "rate_limited" | "internal" | "superseded"
  // hello refused: another live connection holds this identity
  | "identity_in_use"
  // hello refused: create: false and the name has never existed
  | "identity_unknown"
  // a read-only connection asked for something that needs a name
  | "unbound";

export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw !== "object" || raw === null) throw new Error("expected object");
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case "hello":
      assertStr(m, "req_id");
      if (m.read_only !== undefined && typeof m.read_only !== "boolean") throw new Error("read_only must be boolean");
      if (m.read_only === true) {
        if (m.identity !== undefined) throw new Error("a read_only hello has no identity");
        if (m.push !== false) throw new Error("a read_only hello needs push: false");
      } else assertStr(m, "identity");
      if (m.push !== undefined && typeof m.push !== "boolean") throw new Error("push must be boolean");
      if (m.create !== undefined && typeof m.create !== "boolean") throw new Error("create must be boolean");
      if (m.session_key !== undefined && (typeof m.session_key !== "string" || !SESSION_KEY.test(m.session_key)))
        throw new Error("session_key must be 64 lowercase hex characters");
      if (m.hold !== undefined && typeof m.hold !== "boolean") throw new Error("hold must be boolean");
      if (m.hold === true && (m.push !== false || m.read_only === true)) throw new Error("hold needs push: false and a name");
      if (m.from !== undefined && (typeof m.from !== "string" || m.read_only === true)) throw new Error("from must be a string, on a hello with a name");
      if (m.restored_from !== undefined && (typeof m.restored_from !== "string" || !SESSION_ID.test(m.restored_from)))
        throw new Error("restored_from must be 16 lowercase hex characters");
      if (m.suggested !== undefined && typeof m.suggested !== "string") throw new Error("suggested must be a string");
      if (m.resume !== undefined && typeof m.resume !== "boolean") throw new Error("resume must be boolean");
      if (m.where !== undefined && typeof m.where !== "string") throw new Error("where must be a string");
      if (m.launcher !== undefined && typeof m.launcher !== "boolean") throw new Error("launcher must be boolean");
      return m as unknown as HelloRequest;
    case "send":
      assertStr(m, "req_id"); assertStr(m, "recipient"); assertStr(m, "body");
      if (m.parent_id !== undefined && typeof m.parent_id !== "number")
        throw new Error("parent_id must be number");
      if (m.pending !== undefined && typeof m.pending !== "boolean") throw new Error("pending must be boolean");
      if (m.attachment_ids !== undefined && (!Array.isArray(m.attachment_ids) || !m.attachment_ids.every(x => typeof x === "number")))
        throw new Error("attachment_ids must be number[]");
      return m as unknown as SendRequest;
    case "history":
      assertStr(m, "req_id");
      if (m.peer !== undefined && typeof m.peer !== "string") throw new Error("peer must be string");
      if (m.limit !== undefined && typeof m.limit !== "number") throw new Error("limit must be number");
      if (m.before_id !== undefined && typeof m.before_id !== "number") throw new Error("before_id must be number");
      return m as unknown as HistoryRequest;
    case "thread":
      assertStr(m, "req_id");
      if (typeof m.message_id !== "number") throw new Error("message_id must be number");
      return m as unknown as ThreadRequest;
    case "ack":
      assertStr(m, "req_id");
      if (!Array.isArray(m.message_ids) || !m.message_ids.every(x => typeof x === "number"))
        throw new Error("message_ids must be number[]");
      return m as unknown as AckRequest;
    case "pong":
      return { type: "pong" };
    case "inbox":
      assertStr(m, "req_id");
      if (m.days !== undefined && typeof m.days !== "number") throw new Error("days must be number");
      return m as unknown as InboxRequest;
    case "dm_ack":
      assertStr(m, "req_id");
      if (typeof m.message_id !== "number") throw new Error("message_id must be number");
      return m as unknown as DmAckRequest;
    case "dm_retract":
      assertStr(m, "req_id");
      if (typeof m.message_id !== "number") throw new Error("message_id must be number");
      return m as unknown as DmRetractRequest;
    case "delegate":
      assertStr(m, "req_id"); assertStr(m, "persona"); assertStr(m, "task");
      if (m.context !== undefined && typeof m.context !== "string") throw new Error("context must be string");
      if (m.to !== undefined && typeof m.to !== "string") throw new Error("to must be string");
      // SAFETY: every field of DelegateRequest was validated just above; the
      // cast only re-labels the parsed object.
      return m as unknown as DelegateRequest;
    case "call":
      assertStr(m, "req_id"); assertStr(m, "tool");
      if (m.args !== undefined && (typeof m.args !== "object" || m.args === null || Array.isArray(m.args)))
        throw new Error("args must be an object");
      return { type: "call", req_id: m.req_id as string, tool: m.tool as string, args: (m.args ?? {}) as Record<string, unknown> };
    case "board_ack":
      assertStr(m, "req_id");
      if (!Array.isArray(m.refs) || !m.refs.every(isPendingRef)) throw new Error("refs must be PendingRef[]");
      return m as unknown as BoardAckRequest;
    default:
      throw new Error(`unknown message type: ${String(m.type)}`);
  }
}

function isPendingRef(r: unknown): r is PendingRef {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  if (x.kind === "push") return typeof x.post_id === "number";
  if (x.kind === "digest") return typeof x.board === "string" && typeof x.latest_id === "number";
  return false;
}

function assertStr(m: Record<string, unknown>, key: string) {
  if (typeof m[key] !== "string") throw new Error(`${key} must be string`);
}
