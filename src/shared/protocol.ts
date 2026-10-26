import type { Pending, PendingRef } from "../core/boards.ts";
import type { InboxItem, PromiseItem } from "./inbox.ts";
import type { AttachmentInfo, AttachmentLimits } from "./attachments.ts";
import { SESSION_KEY, asSessionId } from "../core/bindings.ts";
import { SESSION_ID } from "../core/session_id.ts";

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

// Client -> Server
// The hello is the session (#284 S1): its ID is derived from session_key
// (idAddress), the client process's secret, so no connection can present
// another session's ID. A key with no ids row registers the session; one
// whose session is in its grace re-attaches it, holds and all (S3).
// proto: 2; a 1.x client's hello is refused with an update hint (S15).
// keyed: the key came from BUS_SESSION_KEY (an orchestrator minted it); such
// a session never mints a replacement after its end (#284 decision 2).
// push: false is a connection that receives nothing: with hold, a session
// whose harness can't show pushes (Claude Code without channels), which
// binds and holds an alias as push does; without, a tools-only connection
// beside the session that owns delivery, writing as writes_as (S7).
// where: the client's describeLocation (the server can't see its files).
// resume: a reconnect within one session; audit detail only, as possession
// of the key is the proof.
// The Slack bridge's in-process humans send no key: ws.data.human is set
// only in-process, and no network hello can reach that path (S16).
export type HelloRequest = {
  type: "hello"; req_id: string; proto: 2; session_key?: string; keyed?: boolean;
  push?: boolean; hold?: boolean; where?: string; resume?: boolean; writes_as?: string;
  // This session's harness can spawn subagents, so delegate requests may land
  // here (#184). Recorded on the session's ids row; peer_list shows it.
  launcher?: boolean;
};
// Take an alias for this session, or move to another (S2): a bare name in
// the caller's own person scope, or scope/name. create: false refuses a name
// that has never existed (identity_unknown); absent, it's created lazily.
// restored_from: the public ID of the process this one restarted from (#211:
// its status stays when the alias's history shows it). previous_key: the key
// of this process's own ended session, after a reconnect past the grace (S4):
// a secret, so it proves descent where a public ID can't (#259).
export type BindRequest = { type: "bind"; req_id: string; alias: string; create?: boolean; restored_from?: string; previous_key?: string };
// A clean exit of an unkeyed session (S4): it ends at once.
export type EndRequest = { type: "end"; req_id: string };
// attachment_ids: the sender's uploads (POST /api/attachments) to carry.
// resend: true sends again though an identical send landed within the dedup
// window (#254, src/server/write_dedup.ts); otherwise that one's result replays.
export type SendRequest    = { type: "send";    req_id: string; recipient: string; body: string; parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean };
// Hand work to a launcher session (#184): the server resolves the launcher
// (explicit `to`, or any live one; none live → the requester's human) and
// sends the payload pending. The reply is send_ok with `to` (and
// human_fallback on the degrade path) added.
export type DelegateRequest = { type: "delegate"; req_id: string; persona: string; task: string; context?: string; to?: string; resend?: boolean };
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
  | HelloRequest | BindRequest | EndRequest | DelegateRequest | SendRequest | HistoryRequest | ThreadRequest | AckRequest | PongMessage
  | CallRequest | BoardAckRequest | InboxRequest | DmAckRequest | DmRetractRequest;

// Server -> Client
export type HelloOk     = {
  type: "hello_ok"; req_id: string;
  // This session's ID, its address while it holds no alias.
  id: string;
  // The alias a re-attached session already holds: the client then binds
  // nothing at start, so a restart doesn't rebind away from it (S1).
  bound?: string;
  user_email: string; teams: string[];
  // Sentences for the session's MCP instructions: active claims, and direct
  // messages you sent that still haven't arrived a day later.
  notices?: string[];
  // Your user's human identity. Sent by servers that reserve its name for the
  // Slack bridge, so a message from that handle can only be your user's.
  // linked: whether anyone reads it (the user has linked Slack).
  human?: { handle: string; linked: boolean };
  // This server's attachment size caps, for the client's checks before upload.
  attachment_limits: AttachmentLimits;
};
// alias: the full address bound. restored: a restore's or a reconnect-after-
// end's continuity, checked against the alias's history. left: the claims
// that stay with the alias this session left (#284 S6). notices: as
// hello_ok's, for the alias now held.
export type BindOk      = {
  type: "bind_ok"; req_id: string; alias: string; restored?: { verified: boolean; detail: string };
  left?: string[]; notices?: string[];
};
export type EndOk       = { type: "end_ok"; req_id: string };
// The server released an alias this session held (#284 S9: its user left the
// alias's team). The session keeps its ID and acts as it from here.
export type AliasLost   = { type: "alias_lost"; alias: string; reason: string };
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
  // When not delivered now: the recipient's last session, e.g. "14d ago", and
  // how many of your messages are queued for them, this one included.
  recipient_last_seen?: string; undelivered_from_you?: number; note?: string;
  replayed?: Replayed;
};
export type SendOk      = { type: "send_ok"; req_id: string } & SendResult;
// A delegation's result: the ordinary fields plus which launcher took it
// (or the human fallback).
export type DelegateResult = SendResult & { to: string; human_fallback?: true };
export type DelegateOk  = SendOk & DelegateResult;
// Messages you sent carry delivered: whether they've reached the recipient's session.
export type HistoryOk   = { type: "history_ok"; req_id: string; messages: (Message & { delivered?: boolean })[] };
export type ThreadOk    = { type: "thread_ok";  req_id: string; messages: Message[] };
// note: a repeat answered from state, e.g. a dm_retract of a message already retracted (#254).
export type AckOk       = { type: "ack_ok";     req_id: string; note?: string };
export type InboxOk     = {
  type: "inbox_ok"; req_id: string; unanswered: InboxItem[]; promised?: PromiseItem[];
  undelivered_from_you?: { to: string; n: number; oldest_id: number; last_seen?: string }[];
};
export type PushMessage = { type: "push"; message: Message };
export type PingMessage = { type: "ping" };
export type CallOk      = { type: "call_ok";    req_id: string; result: unknown };
export type BoardPush   = { type: "board_push"; item: Pending };
// known: with identity_unknown, the user's names closest to the one asked for.
// holder: with alias_held, the session that holds the alias.
// retry_after_ms: on a rate_limited hello, the wait until one is accepted
// again; on alias_held, the wait until the holder's grace ends and the sweep
// after it runs (absent for a live holder).
export type ErrorMessage = { type: "error"; req_id?: string; code: ErrorCode; message: string; known?: string[]; holder?: string; retry_after_ms?: number };

export type ServerMessage =
  | HelloOk | BindOk | EndOk | AliasLost | SendOk | DelegateOk | HistoryOk | ThreadOk | AckOk | PushMessage | PingMessage | ErrorMessage
  | CallOk | BoardPush | InboxOk;

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "bad_request" | "not_found"
  | "rate_limited" | "internal" | "superseded"
  // bind refused: another session holds the alias
  | "alias_held"
  // bind refused: create: false and the name has never existed
  | "identity_unknown"
  // hello refused: the session key's ID is another principal's session, has
  // ended, or is live on another connection (#284)
  | "id_collision"
  // the session has ended (#284 S4), or a send or mention named an ended ID
  | "id_ended"
  // a send or mention named an ID that receives nothing (a tools-only session)
  | "no_delivery";

/** The protocol version a hello must carry (#284 S15). */
export const PROTO = 2;
/** What a hello without it is told: a 1.x client against a 2.x server. */
export const PROTO_REFUSAL = "this grayboard server is 2.x; update the CLI (`grayboard update`)";

export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw !== "object" || raw === null) throw new Error("expected object");
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case "hello":
      assertStr(m, "req_id");
      if (m.proto !== PROTO) throw new Error(PROTO_REFUSAL);
      if (m.session_key !== undefined && (typeof m.session_key !== "string" || !SESSION_KEY.test(m.session_key)))
        throw new Error("session_key must be 64 lowercase hex characters");
      for (const k of ["keyed", "push", "hold", "resume", "launcher"]) {
        if (m[k] !== undefined && typeof m[k] !== "boolean") throw new Error(`${k} must be boolean`);
      }
      if (m.hold === true && m.push !== false) throw new Error("hold needs push: false");
      if (m.where !== undefined && typeof m.where !== "string") throw new Error("where must be a string");
      // A tools-only connection names what it writes as; nothing else may.
      if (m.push === false && m.hold !== true) assertStr(m, "writes_as");
      else if (m.writes_as !== undefined) throw new Error("writes_as is a tools-only connection's (push: false, no hold)");
      return m as unknown as HelloRequest;
    case "bind":
      assertStr(m, "req_id"); assertStr(m, "alias");
      if (m.create !== undefined && typeof m.create !== "boolean") throw new Error("create must be boolean");
      // A 1.x client records its session ID as 16 hex characters: the same
      // 64 bits, re-encoded here so its restore still matches the history.
      if (typeof m.restored_from === "string") m.restored_from = asSessionId(m.restored_from);
      if (m.restored_from !== undefined && (typeof m.restored_from !== "string" || !SESSION_ID.test(m.restored_from)))
        throw new Error("restored_from must be a session ID (id: and 13 characters, or a 1.x client's 16 hex)");
      if (m.previous_key !== undefined && (typeof m.previous_key !== "string" || !SESSION_KEY.test(m.previous_key)))
        throw new Error("previous_key must be 64 lowercase hex characters");
      if (m.previous_key !== undefined && m.restored_from !== undefined) throw new Error("a bind names restored_from or previous_key, not both");
      return m as unknown as BindRequest;
    case "end":
      assertStr(m, "req_id");
      return m as unknown as EndRequest;
    case "send":
      assertStr(m, "req_id"); assertStr(m, "recipient"); assertStr(m, "body");
      if (m.parent_id !== undefined && typeof m.parent_id !== "number")
        throw new Error("parent_id must be number");
      if (m.pending !== undefined && typeof m.pending !== "boolean") throw new Error("pending must be boolean");
      if (m.attachment_ids !== undefined && (!Array.isArray(m.attachment_ids) || !m.attachment_ids.every(x => typeof x === "number")))
        throw new Error("attachment_ids must be number[]");
      if (m.resend !== undefined && typeof m.resend !== "boolean") throw new Error("resend must be boolean");
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
      if (m.resend !== undefined && typeof m.resend !== "boolean") throw new Error("resend must be boolean");
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
