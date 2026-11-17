// The server's session and operation core (#402): hosted MCP
// (src/server/mcp.ts, src/server/hosted.ts) and the Slack bridge's in-process
// human call it. The session model is #284's: a session has an ID, aliases
// come by bind and go by unbind, and a session holds several. The WSS
// transport and its hello are gone (#282): a hosted session's lifetime is the
// hosted store's lease, not a connection's grace.
import type { BindRequest, DelegateRequest, DelegateResult, ErrorCode, Replayed, SendResult as WireSendResult, WriteRef } from "../shared/protocol.ts";
import { DEFAULT_HOSTED_CAPS } from "./config.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, DEFAULT_HOSTED_SUBSCRIBER_LIMIT, RateLimiter, retrySecs, type RateLimit, type Take } from "./rate_limit.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause, testPauseAsync } from "../shared/testpause.ts";
import { ALIAS_SCOPE_CAP, aliasCapRefusal } from "./alias_cap.ts";
import { DELEGATE_LIMIT, DELEGATE_OPEN_CAP, addressUser, crossUserRefusal, delegateOkFields, delegateThrottled, neverConnected, resolveDelegation, type DelegateReach } from "../core/delegation.ts";
import {
  MAX_CANDIDATES, MAX_HOLDS, actingAs, aliasHeldText, aliasUser, aliasUses, boardActor, childStateRefusal, closestNames, dropHold, holdAlias, holderOf, holdsOf, idRow,
  idStatuses, logBinding, orderCandidates, primaryOf, replyPeer, replyPeerError, replySender, replySenderError, tooManyHolds, unboundPeer, unendedIds, unknownNameError,
  type AliasUse, type Candidate,
} from "../core/bindings.ts";
import { participant, queuedTx, type MessageRow, type Repo, type Sync } from "./db.ts";
import { afterCommitOf, isTx, type Read, type Tx } from "./store/tx.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatTeamAddress } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { authorize, recordDecision, type Actor, type AuthzRequest, type Decision, type HumanReach } from "./policy.ts";
import { serverAuditSink, writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  acknowledge, age, boardCatalog, snapshot, canSeeBoard, checkBody, checkPostAccess, lastSeen, parseAliasMeta, pendingFor, pendingKey, refOf,
  setAliasMeta, setPlace, touchAlias, touchId, registerId, setIdFacts, cleanFact, idCollisionText, normalizeBoard, getBoard,
  type AliasMetaSet, type Board, type CoreDb, type Viewer, type PendingRef, type ReadResult, type SnapshotOptions, type UnboundPeer,
} from "../core/boards.ts";
import { addressParts, aliasScope, type AliasScope, type ParsedAddress } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { countRefusal } from "./metrics.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { assertDeliverableId, coreRefusalCode, endSession, Undeliverable } from "../core/session_end.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type ToolContext, type BoardPostResult } from "../core/tools.ts";
import { attachmentIds, dropUnsentUploads, uploadDigests, sweepBlobs, type Uploader } from "../core/attachments.ts";
import type { AttachmentLimits } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { detached } from "./request_context.ts";
import { onAliasCreated } from "./teams.ts";
import { principalCanSee } from "./access.ts";
import { PROMISE_DAYS, STALE_UNDELIVERED_MS, alreadyRetracted, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showMessage, unanswered, undeliveredInstruction, type InboxItem, type PromiseItem } from "../shared/inbox.ts";
import type { Pending } from "../shared/notifications.ts";

// Every code an operation refuses with is a wire code (src/shared/protocol.ts).
export type ApplicationCode = ErrorCode;

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationCode, message: string, readonly extra: { known?: string[]; holder?: string; retry_after_ms?: number } = {}) {
    super(message);
  }
}
// other_user, ungranted, delegated: the writer marks every read and the pull carry (writerMarks; security audit F-10, F-03; #256).
export type DirectMessage = ReturnType<typeof showMessage<MessageRow>> & { other_user?: true; ungranted?: true; delegated?: true };
export type HistoryMessage = DirectMessage & { delivered?: boolean };
export type DeliveryEvent =
  | { kind: "direct"; message: DirectMessage }
  | { kind: "board"; item: Pending };
export type DeliverySink = {
  deliver(event: DeliveryEvent): void;
  closed(error: ApplicationError): void;
};
// A hosted session's facts, for its MCP instructions (src/server/mcp.ts).
export type SessionFacts = {
  user_email: string;
  teams: string[];
  human: { handle: string; linked: boolean };
  attachment_limits: AttachmentLimits;
};
export type IdentityInfo = SessionFacts & {
  candidates?: Candidate[];
  identity_full: string;
};
export type SendResult = WireSendResult;
export type InboxResult = {
  unanswered: InboxItem[];
  promised?: PromiseItem[];
  undelivered_from_you?: { to: string; n: number; oldest_id: number; last_seen?: string }[];
};
export type ApplicationOptions = {
  humanReach?: HumanReach;
  slackRunning?: () => boolean;
  helloLimit?: RateLimit;
  hostedRequestLimit?: RateLimit;
  // Delivery upkeep (role=subscriber) has a bucket of its own (#845).
  hostedSubscriberLimit?: RateLimit;
  // delegate's limits (#252): per user, and the open requests one launcher may hold.
  delegateLimit?: RateLimit;
  delegateOpenCap?: number;
  // Names per scope (#347, alias_cap.ts).
  aliasScopeCap?: number;
  // Board observers server-wide: hosted resource watches are observers, so it is their global cap (#805).
  observerCap?: number;
  // The hub's clock: the rate limiters' and the write-dedup window's
  // (src/server/write_dedup.ts). Tests move it instead of sleeping.
  now?: () => number;
};
// What a session's user facts are: the bridge's human attach answers them.
export type HelloResult = { id: string } & SessionFacts;
export type BindResult = { alias: string; held: string[]; notices?: string[] };
export type UnbindResult = { alias: string; released: boolean; held: string[]; left?: string[] };

/**
 * The reads a hosted session with no name may make (master's read-only
 * model, kept for hosted MCP). It doesn't act as its ID: the hosted session
 * ID is routing, not a capability (#229).
 */
export const UNBOUND_READS = new Set(["board_list", "board_read", "peer_list", "claim_list"]);
const UNBOUND_ERROR = "no bus name yet. Call bind(name) to resume a name (see the candidates in your instructions, or peer_list), or bind(name, create: true) for a new one.";

// Only sessions registered by this application may execute operations.
export class ApplicationSession {
  // Board items sent and not yet acked, each with the addresses it was
  // pending for: one push per item across the set, and an unbind drops the
  // released address, so the item reaches that alias's next binding.
  readonly inflight = new Map<string, Set<string>>();
  // Set while a replay's direct-message drain is in flight (drainDirect): live DMs held for it, the ids its drains
  // sent, how many are running, and the chain that runs them one at a time.
  draining: { held: MessageRow[]; sent: Set<number>; runs: number; chain: Promise<void> } | null = null;
  active = true;
  // The session's ID (#284): keys its ids row, its holds, its binding
  // events and its writes' dedup. Empty for the Slack bridge's humans.
  sessionId = "";
  place: string | null = null;
  // A hosted session with no name: it reads and nothing else.
  readOnly = false;
  // Whether peer_list shows it among the user's unbound sessions; an idle
  // legacy GET receives nothing, so it isn't (#431).
  listed = true;
  // The ID its writes carry as provenance; unset for a writer with no
  // session (the bridge's humans, a hosted request with no context).
  writerId?: string;
  // A hosted child's own ID (#523): it acts under its root's addresses, and
  // its writes store this as `via` so readers see which subagent wrote them.
  // The root's read state isn't its: its board_read peeks, and dm_inbox and
  // dm_ack are refused (childInbox).
  via?: string;
  transport: "bridge" | "hosted" = "bridge";
  // The address the session writes as by default (#284 S1, S8): its oldest
  // hold, else its ID; a tools-only session's writes_as.
  primary = "";
  // Every address it reads as: its holds, oldest first, then its ID (a
  // hosted child's: its root's ID, never its own); a tools-only session's
  // [writes_as]. Primary first.
  addresses: string[] = [];
  // The aliases the session holds, oldest first (PR 4 S1); set by setHolds.
  holds: string[] = [];
  // A tools-only session (S7): writes as writes_as, binds nothing.
  toolsOnly = false;
  // Why it closed, when the server closed it: what a later call is told.
  closedBy?: ApplicationError;
  // Set by a caller that runs the call inside an outer transaction (hosted's
  // `run`, #452): a refusal's audit row is handed to it, to be written after
  // the transaction unwinds, because writing it inside would roll it back with
  // the refused call. Unset, the row is written at once.
  // A row takes the `Tx` of the body that writes it (#807 P1c-15b-2).
  afterRollback?: (write: RefusalRow) => void;
  constructor(
    readonly authed: AuthedUser,
    readonly sink: DeliverySink,
    readonly human: boolean,
    readonly push: boolean,
  ) {}
  // The primary, under master's names (hosted MCP, resources, delivery).
  get identityFull(): string { return this.primary; }
  get identityName(): string {
    const slash = this.primary.lastIndexOf("/");
    return slash < 0 ? this.primary : this.primary.slice(slash + 1);
  }
}

function fail(code: ApplicationCode, message: string, extra: ApplicationError["extra"] = {}): never {
  throw new ApplicationError(code, message, extra);
}

// A child (#523) neither takes on nor changes its root's read state: dm_inbox,
// dm_ack and board_subscribe are the root's (childStateRefusal names them).
function childState(session: ApplicationSession, tool: string): void {
  const refused = session.via === undefined ? null : childStateRefusal(tool, session.via, session.primary);
  if (refused !== null) fail("child_session", refused);
}

// A refused call's code and message: an ID that can't receive names its own
// code (#284 S18); any other CoreError is a bad request.
function coreRefusal(e: CoreError): ApplicationError {
  return new ApplicationError(coreRefusalCode(e), e instanceof Undeliverable ? e.detail : e.message);
}

export type BoardObserver = {
  changed(): void | Promise<void>;
  closed?(): void | Promise<void>;
};
function notify(callback?: () => void | Promise<void>) {
  try { void Promise.resolve(callback?.()).catch(() => {}); } catch {}
}

type Hub = {
  repo: Repo;
  // address -> the session pushes go to: a push session's ID and its bound
  // aliases, a Slack bridge human's email/human, a hosted lease's name.
  registry: Map<string, ApplicationSession>;
  sessions: Set<ApplicationSession>;
  humanReach: HumanReach;
  slackRunning: () => boolean;
  helloLimiter: RateLimiter;
  // delegate's per-user bucket and the launcher cap (#252). A streak's
  // rows go to delegateRows while a delegate call runs, to be written where
  // its outcome keeps them, on that call's `Tx`; otherwise (a sweep, outside any body) posted.
  delegateLimit: RateLimit;
  delegateLimiter: RateLimiter;
  delegateRows: RefusalRow[] | undefined;
  delegateOpenCap: number;
  aliasScopeCap: number;
  now: () => number;
  // `on`: when its effect runs (`onCommit(handle)`: after that handle's commit, or now for `repo.read`).
  boardChanged: (on: Commit, board: string) => void;
};

// Schedules an effect after the commit of the transaction a handle names, or now for a `Read` (#807 P1c-15a).
type Commit = (effect: () => void | Promise<void>) => void;
const onCommit = (h: Read): Commit => (effect) => afterCommitOf(h, effect);

// A push its reader can no longer see, acknowledged as pendingFor finds it, on `h`: inside a body (a delivery
// receipt's `pending`) on its `Tx`; outside one (a drain, a lease's pull) posted through the write queue (#807 D4).
const lostAck = (hub: Hub, h: Read) => (handle: string, ref: PendingRef) => {
  const write = (tx: Tx) => acknowledge(hub.repo.coreOn(tx), handle, ref);
  if (isTx(h)) write(h); else hub.repo.post(write, undefined, "lost-visibility push ack");
};

// Send this session everything pending on boards, for any of its addresses,
// that it hasn't been sent: a subscription taken as the ID while unbound and
// the alias's own both deliver. all: also deferred pushes and digests (at
// hello; see pendingFor).
function drainBoards(session: ApplicationSession, hub: Hub, all = false): void {
  for (const address of session.addresses) {
    for (const item of pendingFor(hub.repo.coreOn(hub.repo.read), address, { all, ack: lostAck(hub, hub.repo.read) })) {
      const key = pendingKey(refOf(item));
      const sent = session.inflight.get(key);
      if (sent) {
        sent.add(address);
        continue;
      }
      session.inflight.set(key, new Set([address]));
      try { session.sink.deliver({ kind: "board", item }); }
      catch (error) { session.inflight.delete(key); throw error; }
    }
  }
}

// A direct message to a live session, as it commits. While a drain of the session's unread is in flight it waits
// for that drain, so the session never gets a newer message before an older one the drain is still reading.
function deliverDirect(session: ApplicationSession, message: MessageRow): void {
  if (!session.active) return;
  if (session.draining) session.draining.held.push(message);
  else session.sink.deliver({ kind: "direct", message: showMessage(message) });
}

// Direct messages to any of `addresses` past each one's cursor (unacked ones
// are resent). Its reads await (#807 P3 A6a), so another body can commit a
// message meanwhile: from the call on, live ones wait in `session.draining`.
// Drains run one at a time; the last to finish delivers what waited, in id
// order, less what a drain already sent. A message committed after a drain's
// read has a larger id than any it read, so order holds.
async function drainDirect(hub: Hub, session: ApplicationSession, addresses: string[]): Promise<void> {
  const d = (session.draining ??= { held: [], sent: new Set(), runs: 0, chain: Promise.resolve() });
  d.runs++;
  const run = d.chain.then(async () => {
    const streams = await Promise.all(addresses.map(async (a) => ({ type: "direct" as const, ref: a, since: await hub.repo.cursors.get(hub.repo.read, a, "direct", a) })));
    const unread = hub.repo.messages.unreadSince(hub.repo.read, streams);
    await testPauseAsync("server:drain:after-read");
    for (const message of unread) {
      if (!session.active) return;
      d.sent.add(message.id);
      session.sink.deliver({ kind: "direct", message: showMessage(message) });
    }
  });
  d.chain = run.catch(() => {});
  try {
    await run;
  } finally {
    if (--d.runs === 0) {
      session.draining = null;
      // Each on its own, as drainBoards delivers: one that throws leaves the rest delivered (it stays unacked).
      for (const m of d.held.sort((a, b) => a.id - b.id)) {
        if (d.sent.has(m.id)) continue;
        try { deliverDirect(session, m); }
        catch (error) { console.error("held direct delivery failed", error); }
      }
    }
  }
}

// A human's session has no wakes to save: it gets deferred pushes and
// digests at once.
function wake(hub: Hub, on: Commit, handles: string[]): void {
  on(() => {
    for (const session of new Set(handles.map((h) => hub.registry.get(h)))) {
      if (session?.active) drainBoards(session, hub, session.human);
    }
  });
}

// The session's holds changed (#284 PR 4 S1, S8): its primary and address
// set follow, and a push session's registry entries with them. An alias it
// no longer holds leaves the registry and its in-flight board items, so they
// are pushed to whoever binds it next.
function setHolds(hub: Hub, session: ApplicationSession, holds: string[]): void {
  const id = session.sessionId;
  for (const a of session.holds) {
    if (holds.includes(a)) continue;
    if (hub.registry.get(a) === session) hub.registry.delete(a);
    for (const [key, sent] of session.inflight) {
      sent.delete(a);
      if (!sent.size) session.inflight.delete(key);
    }
  }
  session.holds = holds;
  session.primary = primaryOf(holds, id);
  session.addresses = [...holds, id];
  if (session.push) for (const a of session.addresses) hub.registry.set(a, session);
}

// What `as` may name (#284 S3): any of the session's addresses; the Slack
// bridge's human acts only as its handle.
const asAddresses = (s: ApplicationSession): string[] => (s.human ? [s.primary] : s.addresses);

const userPrincipal = (authed: AuthedUser): Principal => ({ kind: "user", name: authed.user_email });
// Whose unsent uploads this session may send: its addresses' (#284 S5),
// made by its user (#367).
const uploaderOf = (s: ApplicationSession): Uploader => ({ addresses: s.addresses, principal: s.authed.user_email });

// The audit log keeps an undelivered bridge death owed across restarts.
// Selection reads and records delivery synchronously, so only one agent gets it.
function owedBridgeNotice(repo: Repo, tx: Tx, email: string): string | undefined {
  const target = `${email}/${HUMAN_NAME}`;
  const stop = repo.audit.last(tx, "bridge.stopped", target);
  if (!stop) return undefined;
  let detail: { reason?: string; at?: string; suppressed?: boolean };
  try {
    detail = stop.detail ? (JSON.parse(stop.detail) as typeof detail) : {};
  } catch {
    return undefined;
  }
  if (detail.suppressed || !detail.at || !detail.reason) return undefined;
  const notified = repo.audit.last(tx, "bridge.notified", target);
  if (notified && notified.at >= stop.at) return undefined;
  writeAudit(repo, tx, "bridge.notified", null, target, { at: new Date().toISOString(), stopped_at: detail.at });
  return `your Slack bridge stopped at ${detail.at} (${detail.reason}); linked humans are offline until it reconnects or the server restarts`;
}

function helloOkFields(hub: Hub, authed: AuthedUser): SessionFacts {
  const { repo } = hub;
  return {
    user_email: authed.user_email,
    teams: repo.teams.listForUser(authed.user_id).map((t) => formatTeamAddress(t.name)),
    // Read committed: the link isn't written by any body this runs in.
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(repo.read, authed.user_id) },
    attachment_limits: repo.attachmentLimits,
  };
}

// The sentences a session's instructions carry for its addresses: active
// claims, and direct messages it sent that still haven't arrived a day later.
function noticesFor(hub: Hub, r: Read, addresses: string[], first: string[] = []): string[] {
  return [
    ...first,
    ...undeliveredInstruction(hub.repo.messages.undeliveredFrom(r, addresses, hub.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(hub.repo.coreOn(r), h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(hub.repo.coreOn(r)), addresses),
  ];
}

// What a bind or a tools-only declaration's writes_as names (#284 S9): a bare name
// in the caller's own person scope, or scope/name in a scope the caller may
// act in (policy.ts, alias.bind). Never `human`: msg.send treats any */human as a human.
// A refusal carries the address when the input parsed as one, so the
// refusal is logged against it; an unparseable name has none.
// A policy refusal carries its request and decision (`authz`), for the
// caller that owns the act to record (policy.ts recordDecision).
type Target =
  | { address: string; scope: AliasScope & { scope_ref: string } }
  | { code: ErrorCode; error: string; address?: string; authz?: { req: AuthzRequest; d: Decision } };

function bindTarget(hub: Hub, authed: AuthedUser, input: string): Target {
  const { repo } = hub;
  const p = addressParts(input);
  if (!p || p.kind === "id" || p.kind === "team") {
    return { code: "bad_request", error: `"${input}" isn't an alias: a name (a-z 0-9 _ -, 1-32 chars), or scope/name` };
  }
  const address = p.kind === "bare" ? `${authed.user_email}/${p.name}` : p.address;
  let scope: AliasScope;
  try {
    scope = aliasScope(address, (k) => {
      const kind = repo.principals.findByName(k)?.kind;
      return kind === "team" || kind === "service" ? kind : null;
    });
  } catch (e) {
    // The reserved name refuses alike in a team that exists and one that doesn't (#1020).
    if (e instanceof CoreError && p.name === HUMAN_NAME) return { code: "forbidden", error: HUMAN_RESERVED, address };
    if (e instanceof CoreError) return { code: "not_found", error: e.message, address };
    throw e;
  }
  const t = { ...scope, scope_ref: scope.scope_ref! };
  const req: AuthzRequest = { verb: "alias.bind", principal: userPrincipal(authed), scope: t, name: scope.name };
  const d = authorize(repo, {}, req);
  if (!d.allow && d.rule === "alias.human_reserved") return { code: "forbidden", error: HUMAN_RESERVED, address, authz: { req, d } };
  // A team reads as missing to a non-member (#1020): the refusal aliasScope gives a scope nobody owns.
  if (!d.allow && d.rule === "scope.team_member") return { code: "not_found", error: `"${address}": no team or service is named "${t.scope_ref}"`, address, authz: { req, d } };
  if (!d.allow) return { code: "forbidden", error: `you can't act as "${address}": ${d.reason}; bind a name in your own scope, or in a team's you belong to`, address, authz: { req, d } };
  return { address, scope: t };
}

// An alias a bind or a writes_as names is created on first use (S9), by
// the user who named it. Callers are inside a transaction, whose Tx is `tx`.
async function createLazily(hub: Hub, tx: Tx, authed: AuthedUser, { address, scope }: Exclude<Target, { error: string }>, session: string): Promise<void> {
  const { repo } = hub;
  if (repo.aliases.find(tx, address)) return;
  await repo.aliases.create(tx, scope, authed.user_email);
  writeAudit(repo, tx, "alias.created", authed.user_email, address, { lazy: true, session });
  onAliasCreated(repo, tx, authed.user_id, address);
}

// Who holds an alias, for an alias_held refusal: its ID and where it runs.
// `place` describes the holder's machine, so only its own principal sees it
// (#349): a team alias's asker can be another member. `r`: the bind's body.
function describeHolder(hub: Hub, r: Read, id: string, asker: string): string {
  const row = idRow(hub.repo.coreOn(r), id);
  const place = row?.principal === asker ? row.place : null;
  // A hosted root has no connection to disconnect: it is last seen when its client last called (#402).
  const hosted = hub.repo.hosted.get(r, id);
  if (hosted) return `the hosted session ${id}${place ? `, in ${place}` : ""}, last seen ${Math.floor((hub.now() - hosted.last_seen_at) / 1000)}s ago`;
  return `the session ${id}${place ? `, in ${place}` : ""}`;
}

// A refusal's row, written by the session's `afterRollback` when the call runs inside a transaction the refusal's
// throw rolls back (#452, #467), or now on `tx`, the body the call runs in.
export type RefusalRow = (tx: Tx) => void;
function rowAfterRollback(session: ApplicationSession, tx: Tx, write: RefusalRow) {
  if (session.afterRollback) session.afterRollback(write); else write(tx);
}

// Who asked, for a decision row (policy.ts): the session's user, the address
// the act was for, and its ID; a Slack bridge human connection has none.
function sessionActor(session: ApplicationSession, address?: string): Actor {
  return { user: session.authed.user_email, address, session: session.sessionId || undefined };
}

export function createApplication(repo: Repo, opts: ApplicationOptions = {}) {
  const now = opts.now ?? Date.now;
  // A bind spends the hello bucket inside its caller's transaction (hosted's `owning`, #467): while it does, this
  // holds the bind's `Tx` and the session's `afterRollback`; a streak's audit row is written on that `Tx`, where a
  // commit keeps it, and handed to `afterRollback` as well, to be written again if the transaction rolls back. A
  // refused take always rolls it back. Outside a bind (a sweep, outside any body) the row is posted.
  let streakAt: { tx: Tx; afterRollback?: (write: RefusalRow) => void } | undefined;
  const streakRow = (write: RefusalRow) => {
    if (!streakAt) { repo.post(write, undefined, "bind rate-limit row"); return; }
    write(streakAt.tx); streakAt.afterRollback?.(write);
  };
  const delegateRow = (write: RefusalRow) => { if (hub.delegateRows) hub.delegateRows.push(write); else repo.post(write, undefined, "delegation throttle row"); };
  const hub: Hub = {
    repo,
    registry: new Map(),
    sessions: new Set(),
    humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    now,
    // Logged and audited once per run of refusals, so a loop floods neither.
    // Keyed by email, which is unique per user. A bind spends from the same
    // bucket (S2).
    helloLimiter: new RateLimiter(opts.helloLimit ?? DEFAULT_HELLO_LIMIT, {
      start: (email, ctx, retryAfterMs) => {
        console.error(`[grayboard] rate-limiting hellos from ${email}`);
        streakRow(w => writeAudit(repo, w, "bind.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs }));
      },
      end: (email, refused) => {
        console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
        streakRow(w => writeAudit(repo, w, "bind.rate_limit_ended", email, null, { refused }));
      },
    }, opts.now),
    delegateLimit: opts.delegateLimit ?? DELEGATE_LIMIT,
    // Keyed by user email, so a user's sessions, aliases and children share
    // one bucket and a fresh session can't reset it; capped like the
    // hosted-request limiter's keys would be by users.
    delegateLimiter: new RateLimiter(opts.delegateLimit ?? DELEGATE_LIMIT, {
      start: (email, ctx, retryAfterMs) => delegateRow(w => writeAudit(repo, w, "delegation.throttled", email, email, { ...ctx, retry_after_ms: retryAfterMs })),
      end: (email, refused) => delegateRow(w => writeAudit(repo, w, "delegation.throttle_ended", null, email, { refused })),
    }, opts.now, 10_000),
    delegateRows: undefined,
    delegateOpenCap: opts.delegateOpenCap ?? DELEGATE_OPEN_CAP,
    aliasScopeCap: opts.aliasScopeCap ?? ALIAS_SCOPE_CAP,
    boardChanged(on, board) {
      on(() => {
        // A copy: observerLive removes a dead observer from the set mid-walk.
        for (const observer of [...observersByBoard.get(board) ?? []]) {
          if (observerLive(observer)) notify(() => observer.hooks.changed());
        }
      });
    },
  };
  // One per-user bucket per role: tool calls (native) and delivery upkeep (subscriber), so one user's
  // delivery fan-out can't throttle that user's tool calls (#845). Each keeps its own refusal streak.
  const hostedLimiter = (bucket: "native" | "subscriber", limit: RateLimit) => new RateLimiter(limit, {
    start: (email, _ctx, retryAfterMs) => {
      console.error(`[grayboard] rate-limiting hosted ${bucket} requests from ${email}`);
      writeAudit(repo, repo.read, "hosted.rate_limited", email, null, { bucket, retry_after_ms: retryAfterMs });
    },
    end: (email, refused) => {
      console.error(`[grayboard] hosted ${bucket} requests from ${email} no longer rate-limited; ${refused} refused`);
      writeAudit(repo, repo.read, "hosted.rate_limit_ended", email, null, { bucket, refused });
    },
  }, opts.now);
  const hostedRequestLimiter = hostedLimiter("native", opts.hostedRequestLimit ?? DEFAULT_HOSTED_REQUEST_LIMIT);
  const hostedSubscriberLimiter = hostedLimiter("subscriber", opts.hostedSubscriberLimit ?? DEFAULT_HOSTED_SUBSCRIBER_LIMIT);
  type Observer = { session: ApplicationSession; board: string; hooks: BoardObserver };
  // Every observer, and the same ones indexed by board and by session, so a post's fan-out walks only its board's
  // observers and a close only its session's (#831, vision P13): neither grows with the server-wide watch cap.
  const observers = new Set<Observer>();
  const observersByBoard = new Map<string, Set<Observer>>();
  const observersBySession = new Map<ApplicationSession, Set<Observer>>();
  function index<K>(map: Map<K, Set<Observer>>, key: K, observer: Observer, add: boolean) {
    let set = map.get(key);
    if (add) { if (!set) map.set(key, set = new Set()); set.add(observer); return; }
    if (set?.delete(observer) && set.size === 0) map.delete(key);
  }
  function addObserver(observer: Observer) {
    observers.add(observer);
    index(observersByBoard, observer.board, observer, true);
    index(observersBySession, observer.session, observer, true);
  }
  function removeObserver(observer: Observer) {
    if (!observers.delete(observer)) return;
    index(observersByBoard, observer.board, observer, false);
    index(observersBySession, observer.session, observer, false);
    notify(observer.hooks.closed);
  }
  function observerLive(observer: Observer): boolean {
    if (!observers.has(observer)) return false;
    try {
      valid(observer.session);
      if (observer.session.addresses.some((a) => canSeeBoard(repo.coreOn(repo.read), a, observer.board))) return true;
    } catch {}
    removeObserver(observer);
    return false;
  }
  function boardsChanged(on: Commit, boards: string[]) {
    for (const board of new Set(boards)) hub.boardChanged(on, board);
  }
  // Core's claim expiry calls back after its sweep's write has committed, outside any body: its effects run now.
  const expiryCommit = onCommit(repo.read);
  // Announces claims that lapse on their boards.
  // Armed from requests, it fires for every holder: detached, so its rows
  // don't carry the arming request's address (security audit F-19).
  // The sweep writes on its queued body's connection; `arm` runs after commits and outside bodies, on the pool.
  const expiryTimer = claimExpiryTimer(repo.coreOn(repo.read), handles => wake(hub, expiryCommit, handles), boards => boardsChanged(expiryCommit, boards), queuedTx(repo));
  const expiry = { arm: () => detached(() => expiryTimer.arm()), stop: () => expiryTimer.stop() };
  // The session leaves the hub's registry: superseded, revoked or closed.
  function detach(session: ApplicationSession): void {
    for (const a of session.addresses) if (hub.registry.get(a) === session) hub.registry.delete(a);
  }
  // `h`: the body the close runs in (bind's and unbind's `finally`), whose `Tx` takes its rows; else the rows are posted.
  function close(session: ApplicationSession, h: Read = repo.read) {
    const write = (row: (tx: Tx) => void, what: string) => { if (isTx(h)) row(h); else repo.post(row, undefined, what); };
    if (!session.active) return;
    session.active = false;
    hub.sessions.delete(session);
    for (const observer of [...observersBySession.get(session) ?? []]) removeObserver(observer);
    if (session.human) {
      const addr = session.primary;
      if (addr && hub.registry.get(addr) === session) {
        hub.registry.delete(addr);
        write(tx => logBinding(repo.coreOn(tx), HUMAN_NAME, addr, "released", "connection closed"), "human release row");
      }
      return;
    }
    // alias_holds is the hosted hold set's only truth (#451): a close is a rebuild
    // (reconcile) or a shutdown, never a release, so it leaves the holds alone.
    const id = session.sessionId;
    detach(session);
    // Close runs from sync finally blocks and commit callbacks: the touch is written on `h` or posted, not awaited (#807 P1b-4b).
    const writer = session.writerId;
    if (writer) write(tx => touchId(repo.coreOn(tx), writer), "last-seen touch");
  }
  // The server closes the session: it leaves the hub, and its transport is
  // told why and closes. `h`: the body it runs in, whose `Tx` takes close's rows (#807 P3 A3).
  function terminate(session: ApplicationSession, error: ApplicationError, h: Read = repo.read) {
    detach(session);
    session.closedBy = error;
    close(session, h);
    session.sink.closed(error);
  }
  // `h`: the handle the caller holds; inside a body its `Tx`, so a disabled user's terminate writes its rows there.
  function valid(session: ApplicationSession, allowUnbound = false, h: Read = repo.read) {
    if (!session.active || !hub.sessions.has(session)) {
      // A superseded bridge connection is told so, a revoked tools-only
      // one why it may not write as its alias (S9); any other closed session
      // is closed (#402).
      const why = session.closedBy;
      if (why?.code === "superseded") fail("superseded", "this connection no longer holds its session");
      if (why?.code === "forbidden") throw why;
      fail("unauthenticated", "session is closed");
    }
    if (repo.users.isDisabled(session.authed.user_id)) {
      terminate(session, new ApplicationError("unauthenticated", "an admin signed this user out"), h);
      fail("unauthenticated", "an admin signed this user out");
    }
    if (session.readOnly && !allowUnbound) fail("unbound", UNBOUND_ERROR);
  }
  function admitHosted(authed: AuthedUser, sessionId: string | null, role: "native" | "subscriber") {
    const t = (role === "subscriber" ? hostedSubscriberLimiter : hostedRequestLimiter).take(authed.user_email, { session_id: sessionId, read_only: true, place: null });
    if (!t.ok) fail("rate_limited", `too many connections for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
  }

  // Ends sessions in one write, each end its own savepoint inside it (bounces, claim releases, holds released; #807
  // P1b-4b), then wakes what that changed and sweeps the freed upload bytes. One end that throws rolls back alone, is
  // logged and audited id.end_failed, and leaves the others ended. Only a revoked alias's end is retried while
  // the server runs (revalidate re-checks it); a startup leftover's is
  // retried at the next start, and its holds stay until then (#475 item 2).
  // Settles once the ends are written. A failure of the whole write rejects it: its only caller is startup, whose
  // `ready` then rejects and the server exits, as the idle-queue post this replaced threw out of startup (#807 P3 A1).
  function endIds(ids: string[], why: string): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return repo.write(tx => endIdsIn(tx, ids, why), ends => afterEnds(ends.woken, ends.bounced)).then(() => {});
  }
  type Ends = { woken: Set<string>; bounced: { id: string; at: number }[] };
  // endIds's body, inside a write body: `tx` is that body's. Each end's savepoint runs on its own Tx.
  async function endIdsIn(tx: Tx, ids: string[], why: string): Promise<Ends> {
    const woken = new Set<string>(), bounced: { id: string; at: number }[] = [];
    for (const id of ids) {
      let ended;
      const at = now();
      try {
        ended = await tx.savepoint(sp => endSession(repo.coreOn(sp), repo.mailOn(sp), id, { why, now: at, audit: serverAuditSink(repo, sp) }));
      } catch (e) {
        console.error(`[grayboard] ending session ${id} (${why}) failed:`, e);
        writeAudit(repo, tx, "id.end_failed", null, id, { why, error: String(e) });
        continue;
      }
      // An end that found the session already ended sends nothing again.
      if (!ended.ended) continue;
      for (const h of ended.wake) woken.add(h);
      bounced.push({ id, at });
      if (ended.held.length) console.error(`[grayboard] session ${id} ended (${why}); released ${ended.held.join(", ")}`);
    }
    return { woken, bounced };
  }
  // What follows ends, after their commit: a bounce goes to a live sender now, as a send does (a drain would
  // resend that session's unacked messages too), the woken handles drain, and the freed upload bytes go.
  function afterEnds(woken: Set<string>, ends: { id: string; at: number }[]): void {
    for (const { id, at } of ends) for (const b of repo.messages.bouncesFrom(repo.read, id, at)) {
      const to = hub.registry.get(b.recipient);
      if (to) deliverDirect(to, b);
    }
    wake(hub, onCommit(repo.read), [...woken]);
    void sweepBlobs(repo.coreOn(repo.read), repo.blobs, queuedTx(repo));
  }
  // The hosted store ends a released child's ID in the release's transaction (#475 item 1); this runs its
  // after-commit half for every hosted commit, whichever path released it.
  const unsubscribeEnds = repo.hosted.subscribe(() => {
    const ended = repo.hosted.takeEnded();
    if (ended.length) afterEnds(new Set(ended.flatMap((e) => e.wake)), ended);
  });
  // The WSS transport is gone (#282): no connection can come back for a
  // session a previous run left unended, because only a hello re-attached one.
  // End each at start, as the grace sweep would have: holds and claims
  // released, mail bounced. A hosted ID is the hosted store's to end.
  // The startup leftovers' ends (#807 P3 A1): the server's `ready` waits for them.
  const ready = endIds(unendedIds(repo.coreOn(repo.read)).filter((id) => !repo.hosted.owned(repo.read, id)), "wss_removed");
  // Re-checks the aliases that sessions act as (S9) against policy.ts (scope.act), for
  // one principal's sessions or (null) every session's, and revokes the ones
  // it now refuses. by: the user whose act changed the access (an admin's
  // team removal, the principal's own leave), or null for the server's own
  // sweep; the revocations' audit actor.
  // One write (#807 P1b-4b): the uses are read, and revoked, in its transaction; live holders follow after the commit.
  // `h`: a caller's body `Tx` takes it in (a team leave or removal); outside any body it's its own write, and a held queue
  // makes it wait behind the holder.
  // Its promise settles once the revocations are written: in the caller's body (which awaits it: its savepoints are
  // awaited), or, outside one, committed through the queue; a failure there is logged, not rejected.
  function recheckAliases(principal: string | null, by: string | null, h: Read = repo.read): Promise<void> {
    const body = (tx: Tx) => {
      const revoked: (AliasUse & { reason: string })[] = [];
      for (const u of aliasUses(repo.coreOn(tx), principal)) {
        const p = repo.principals.findByName(u.principal);
        const d = p ? authorize(repo, {}, { verb: "scope.act", principal: p, scope: u }) : undefined;
        const reason = !p ? `principal ${u.principal} no longer exists` : d && !d.allow ? d.reason : null;
        if (reason) revoked.push({ ...u, reason });
      }
      return revokeAliases(tx, revoked, by);
    };
    const committed = ({ resync, ends }: Awaited<ReturnType<typeof revokeAliases>>) => {
      // #475 7c: a live holder (the Slack bridge's, an application session) stops acting as it now: its
      // address set and registry entries follow the database, as a bind or unbind's do.
      for (const id of resync) for (const s of hub.sessions) if (!s.human && s.sessionId === id) setHolds(hub, s, holdsOf(repo.coreOn(repo.read), id));
      afterEnds(ends.woken, ends.bounced);
    };
    if (isTx(h)) return body(h).then(value => { h.afterCommit(() => committed(value)); });
    return repo.write(body, committed).then(() => {}, error => console.error("[grayboard] alias recheck failed:", error));
  }
  // Takes aliases from sessions whose principals may no longer act in their
  // scopes (S9). A holder keeps its ID and its other holds: only the revoked
  // hold is released. A tools-only session writes only as its writes_as, so
  // it has nothing left to be: its ownership ends. A hosted root's hold is
  // released in the database (#408) and its generation bumped (#451): the live
  // holder is rebuilt and its lease closed. HTTP has no frame to tell it, so the
  // loss is kept (#453): the root's next native whoami or tool result takes it
  // once, and its Controller's whoami reports it until the next delivery_open.
  // Inside recheckAliases's write body; returns what its commit hands on: the non-hosted holders to resync, the ends.
  // Each use is its own savepoint: one that throws rolls back alone, is logged and audited alias.revoke_failed, and
  // leaves the others revoked, so one bad row doesn't stop every revocation the server's sweep makes.
  async function revokeAliases(tx: Tx, uses: (AliasUse & { reason: string })[], by: string | null): Promise<{ resync: string[]; ends: Ends }> {
    const ended: string[] = [], resync: string[] = [];
    if (!uses.length) return { resync, ends: { woken: new Set(), bounced: [] } };
    for (const u of uses) {
      try { await revokeUse(tx, u, by, ended, resync); }
      catch (e) {
        console.error(`[grayboard] revoking ${u.address} from session ${u.id} failed:`, e);
        writeAudit(repo, tx, "alias.revoke_failed", by, u.address, { session: u.id, principal: u.principal, error: String(e) });
      }
    }
    return { resync, ends: await endIdsIn(tx, ended, "revoked") };
  }
  // Its writes go in a savepoint, on the savepoint's Tx.
  async function revokeUse(tx: Tx, u: AliasUse & { reason: string }, by: string | null, ended: string[], resync: string[]): Promise<void> {
    const { reason } = u;
    const hosted = repo.hosted.owned(tx, u.id);
    if (!u.held) {
      // A hosted tools-only root ends its ownership, not an ID (hosted IDs are the store's).
      await tx.savepoint(sp => {
        writeAudit(repo, sp, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, writes_as: true, reason });
        if (hosted) repo.hosted.end(sp, u.id, "revoked", now());
      });
      if (!hosted) ended.push(u.id);
      return;
    }
    // A hosted root's change goes through the hosted store's writes, whose commit tells the hosted
    // service and delivery to close the lease now, not at its next renewal.
    await tx.savepoint(sp => {
      const primary = hosted && holdsOf(repo.coreOn(sp), u.id)[0] === u.address;
      dropHold(repo.coreOn(sp), u.address, u.id);
      logBinding(repo.coreOn(sp), u.id, u.address, "released", `access revoked: ${reason}`);
      writeAudit(repo, sp, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, reason });
      if (hosted) {
        const row = repo.hosted.get(sp, u.id);
        if (row) {
          // Its last hold gone, the root is unbound but owning: no lease, so the sweep doesn't expire it.
          repo.hosted.update(sp, { ...row, bind_gen: row.bind_gen + 1, lease_deadline: holdsOf(repo.coreOn(sp), u.id).length ? row.lease_deadline : null });
          if (row.lease_deadline !== null) writeAudit(repo, sp, "hosted.lease_closed", null, u.id, { reason: "revoked", ownership: row.ownership_id });
          repo.hosted.lose(sp, u.id, { alias: u.address, reason, primary }, now());
        }
      }
    });
    if (!hosted) resync.push(u.id);
  }

  // The Slack bridge's in-process human (S16): no ID and no ids row.
  // It holds email/human and logs bind events under the literal `human`.
  // Its alias, audit and binding row commit in one transaction through the write queue (#807 D4); the registry
  // changes after the commit, so a rolled-back attach leaves an earlier connection in place. `current` runs inside
  // that transaction: the bridge's checks went stale while the write waited (an unlink or stop queued ahead of it).
  async function attachHuman(authed: AuthedUser, sink: DeliverySink, current?: (tx: Tx) => string | null): Promise<{ session: ApplicationSession; ok: HelloResult }> {
    const addr = `${authed.user_email}/${HUMAN_NAME}`;
    return repo.write(async tx => {
      if (repo.users.findById(authed.user_id)?.disabled_at != null) fail("unauthenticated", "session is closed");
      const stale = current?.(tx);
      if (stale) fail("unauthenticated", stale);
      if (!repo.aliases.find(tx, addr)) {
        await repo.aliases.create(tx, { scope_kind: "person", scope_ref: authed.user_email, name: HUMAN_NAME }, authed.user_email);
        writeAudit(repo, tx, "alias.created", authed.user_email, addr, { lazy: true, slack: true });
        onAliasCreated(repo, tx, authed.user_id, addr);
      }
      touchAlias(repo.coreOn(tx), addr);
      logBinding(repo.coreOn(tx), HUMAN_NAME, addr, "bound");
    }, () => {
      const session = new ApplicationSession(authed, sink, true, true);
      session.primary = addr;
      session.addresses = [addr];
      // A bridge connection never pongs: a newer one for the user replaces it.
      const prev = hub.registry.get(addr);
      if (prev && prev !== session) terminate(prev, new ApplicationError("superseded", "a newer Slack bridge connection took over this human"));
      hub.sessions.add(session);
      hub.registry.set(addr, session);
      return { session, ok: { id: HUMAN_NAME, ...helloOkFields(hub, authed) } };
    });
  }

  // bind (#284 S2, PR 4 S1): add an alias to this session's holds. One it
  // already holds answers ok and applies only `meta`; the others stay held,
  // and the primary changes only when the session held nothing.
  // A refusal's binding row goes to the session's `afterRollback` when it has one: a hosted bind runs inside a
  // transaction the refusal's throw rolls back, and the row is written after it.
  // `tx`: the body the bind runs in; its alias reads and lazy create run on it.
  async function bindNow(tx: Tx, session: ApplicationSession, m: Omit<BindRequest, "type" | "req_id">): Promise<BindResult> {
    valid(session, true, tx);
    const { authed } = session;
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it binds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it binds nothing");
    const id = session.sessionId;
    // Lazy creation is here, after the bind limit: an unlimited create loop
    // would mint aliases without bound. Taken before the held check, so a
    // re-bind loop spends it too.
    streakAt = { tx, afterRollback: session.afterRollback };
    let t: Take;
    try { t = hub.helloLimiter.take(authed.user_email, { session_id: id, bind: m.alias }); } finally { streakAt = undefined; }
    if (!t.ok) fail("rate_limited", `too many binds for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
    const target = bindTarget(hub, authed, m.alias);
    if ("error" in target) {
      if (target.address) { const a = target.address; rowAfterRollback(session, tx, w => logBinding(repo.coreOn(w), id, a, "refused", target.error)); }
      if (target.authz) { const { req, d } = target.authz; rowAfterRollback(session, tx, w => recordDecision(repo, w, sessionActor(session, target.address), req, d)); }
      return fail(target.code, target.error);
    }
    const { address, scope } = target;
    const refuse = (code: ErrorCode, message: string, detail: string, extra: ApplicationError["extra"] = {}): never => {
      rowAfterRollback(session, tx, w => logBinding(repo.coreOn(w), id, address, "refused", detail));
      return fail(code, message, extra);
    };
    let meta: AliasMetaSet | undefined;
    try {
      meta = m.meta === undefined ? undefined : parseAliasMeta(m.meta);
    } catch (e) {
      if (e instanceof CoreError) return refuse("bad_request", e.message, e.message);
      throw e;
    }
    const audit = serverAuditSink(repo, tx);
    if (session.holds.includes(address)) {
      // No binding event, and bound_at stays: the session already holds it.
      if (meta) setAliasMeta(repo.coreOn(tx), address, meta, id, audit, authed.user_email);
      return { alias: address, held: [...session.holds] };
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return refuse("bad_request", why, why);
    }
    // A typo would otherwise create a fresh alias, and the DMs queued for the
    // intended one would never arrive.
    if (m.create === false && !repo.aliases.find(tx, address)) {
      const known = closestNames(scope.name, repo.aliases.listForScope(tx, scope.scope_kind, scope.scope_ref).map((a) => a.name).filter((n) => n !== HUMAN_NAME));
      const message = unknownNameError(scope.name, known);
      return refuse("identity_unknown", message, message, { known });
    }
    // Another session's hold is never taken over. The hosted service clears a stale
    // hosted holder first (#402): one idle past the hosted window ended and freed the
    // alias; a live one refuses the bind.
    const holder = holderOf(repo.coreOn(tx), address);
    if (holder !== null && holder !== id) {
      const who = describeHolder(hub, tx, holder, authed.user_email);
      return refuse("alias_held", aliasHeldText(address, who, "bind another name"), who, { holder: who });
    }
    // Another user's tools-only session writing as it holds nothing, but the
    // alias is in use, so it's exclusive all the same (S8, decided).
    const writer = aliasUser(repo.coreOn(tx), address, authed.user_email);
    if (writer !== null) {
      const why = `another user's session ${writer}`;
      return refuse("alias_held", aliasHeldText(address, why, "bind another name"), why);
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return refuse("bad_request", why, why);
    }
    // A new name past its scope's cap (#347); checked here, not in the
    // transaction below, so the refused binding event stays.
    const capped = repo.aliases.find(tx, address) ? null : aliasCapRefusal(repo, tx, target.scope, hub.aliasScopeCap);
    if (capped) return refuse("bad_request", capped, capped);

    // No savepoint (#807 P3 A1): a throw here fails the bind, and every caller's transaction rolls back with it.
    await createLazily(hub, tx, authed, target, id);
    holdAlias(repo.coreOn(tx), address, id, now());
    logBinding(repo.coreOn(tx), id, address, "bound", null);
    if (meta) setAliasMeta(repo.coreOn(tx), address, meta, id, audit, authed.user_email);
    touchAlias(repo.coreOn(tx), address);

    setHolds(hub, session, holdsOf(repo.coreOn(tx), id));
    // The first bind of a user's session after the bridge died carries the death notice, once.
    const owed = owedBridgeNotice(repo, tx, authed.user_email);
    const notices = noticesFor(hub, tx, session.addresses, owed ? [owed] : []);
    return { alias: address, held: [...session.holds], ...(notices.length ? { notices } : {}) };
  }

  // unbind (#284 PR 4 S2): release one hold. Its mail queues and its claims
  // stay with the alias, for its next holder; a board item in flight for it
  // leaves this session (setHolds), so that holder is pushed it. An alias
  // the session doesn't hold answers ok with released: false.
  // `tx`: the body the unbind runs in.
  function unbind(tx: Tx, session: ApplicationSession, alias: string): UnbindResult {
    valid(session, true, tx);
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it unbinds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it unbinds nothing");
    const id = session.sessionId;
    const p = addressParts(alias);
    if (!p || p.kind === "id" || p.kind === "team") fail("bad_request", `"${alias}" isn't an alias: a name, or scope/name`);
    const address = p.kind === "bare" ? `${session.authed.user_email}/${p.name}` : p.address;
    if (!session.holds.includes(address)) return { alias: address, released: false, held: [...session.holds] };
    const core = repo.coreOn(tx);
    // No savepoint (#807 P3 A1): a throw fails the unbind, and its caller's transaction rolls back with it.
    dropHold(core, address, id);
    logBinding(core, id, address, "released", "unbind");
    touchAlias(core, address);
    setHolds(hub, session, session.holds.filter((a) => a !== address));
    const left = listClaims(core).filter((c) => c.holder === address).map((c) => c.key);
    return { alias: address, released: true, held: [...session.holds], ...(left.length ? { left } : {}) };
  }

  const application = {
    ready,
    repo,
    admitHosted,
    // `suggested`: the name the session's checkout suggested (#443), offered first while free.
    hostedCandidates(r: Read, authed: AuthedUser, suggested: string | null) { return candidates(hub, r, authed, suggested); },
    // The aliases a hosted root holds, oldest first: alias_holds is their only truth (#451).
    hostedHolds(r: Read, id: string): string[] { return holdsOf(repo.coreOn(r), id); },
    // `writesAs`: a tools-only root's alias; it holds nothing and binds nothing.
    // Otherwise the session holds `holds`, reads as them and its
    // ID, and writes as the oldest; none held reads and nothing else (readOnly). `row`: the hosted root's
    // place and suggested name (#443), null with no row. `root`: set for a child session (#523),
    // which acts under its root's addresses, never its own ID (not an address), and whose writes
    // carry its ID as `via`.
    // `r`: the body the session is built in, or the pool outside one (the candidates read on it).
    hostedSession(r: Read, authed: AuthedUser, id: string, holds: string[], writesAs: string | null, row: { place: string | null; suggested: string | null } | null, sink: DeliverySink, push = false, root: string | null = null) {
      const session = new ApplicationSession(authed, sink, false, push);
      session.transport = "hosted";
      session.sessionId = id;
      session.place = row?.place ?? null;
      session.readOnly = holds.length === 0 && writesAs === null;
      session.toolsOnly = writesAs !== null;
      if (writesAs !== null) {
        session.primary = writesAs;
        session.addresses = [writesAs];
      } else {
        session.holds = holds;
        session.primary = primaryOf(holds, root ?? id);
        session.addresses = [...holds, root ?? id];
      }
      // A child is one whether or not its root holds a name yet: its text and refusals are a child's.
      const own = idRow(repo.coreOn(r), id)?.principal === authed.user_email;
      if (!session.readOnly && own) session.writerId = id;
      if (root !== null && own) session.via = id;
      // Computed before the session is registered: a throw here leaves no holder or route behind (#385 item 9).
      const info: IdentityInfo = {
        identity_full: session.primary,
        ...helloOkFields(hub, authed),
        ...(session.readOnly && session.via === undefined ? { candidates: candidates(hub, r, authed, row?.suggested ?? null) } : {}),
      };
      hub.sessions.add(session);
      if (push && holds.length) for (const a of session.addresses) hub.registry.set(a, session);
      return { session, info };
    },
    // The root a hosted child acts under (#523), recorded on the child's ids row, where it outlives the
    // child's source row (deleted at the child's end) so a send or mention to the child's ID keeps
    // being refused child_session; null when the ID starts as a root, which makes it an address again.
    hostedRoot(tx: Tx, id: string, root: string | null) { repo.hosted.setRoot(tx, id, root); },
    // `harness` comes from the principal's source mapping (#414): peer_list shows it and match:{harness} filters on it.
    // `collided`: where a caller inside a transaction that the refusal rolls back takes the audit row
    // (`hostedCollided`, written after the rollback); without it the row is written here.
    hostedRegister(tx: Tx, authed: AuthedUser, id: string, harness: string, writesAs: string | null = null, collided?: (why: string) => void, facts?: { model?: string; effort?: string }) {
      const prior = idRow(repo.coreOn(tx), id);
      if (prior && prior.principal !== authed.user_email) {
        const why = "is another principal's session";
        if (collided) collided(why); else writeAudit(repo, tx, "id.collision", authed.user_email, id, { why });
        fail("id_collision", idCollisionText(id, why));
      }
      // A tools-only root's writes_as is registered here (A4): aliasUser, aliasUses and
      // undeliverableId read ids.writes_as, so a send to its ID is pointed at the alias.
      if (!prior) {
        // No savepoint (#807 P3 A1), here or at a reopen: a throw fails the registration, and its caller's
        // transaction (or rowFor's savepoint) rolls back with it.
        const model = cleanFact(facts?.model), effort = cleanFact(facts?.effort);
        registerId(repo.coreOn(tx), { id, principal: authed.user_email, harness, launcher: false, ...(writesAs === null ? {} : { writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        writeAudit(repo, tx, "id.registered", authed.user_email, id, { harness, ...(writesAs === null ? {} : { writes_as: writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      }
      else {
        // An ID whose row ended (a released child, or a row a restart ended) is live again (#475 item 7a): revocation
        // (aliasUses), identity deletion (aliasUser) and retention only see unended rows, so a holder must have one.
        if (prior.ended_at !== null) {
          const endedAt = prior.ended_at;
          repo.hosted.reopenId(tx, id);
          writeAudit(repo, tx, "id.reopened", authed.user_email, id, { ended_at: endedAt, harness });
        }
        touchId(repo.coreOn(tx), id);
        // A new ownership of the same ID reports its own model and effort: what the last one reported is stale.
        const changed = setIdFacts(repo.coreOn(tx), id, { model: facts?.model ?? null, effort: facts?.effort ?? null });
        if (changed) writeAudit(repo, tx, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "ownership" });
        // An ownership's end clears the row's writes_as (the store's end), so a new ownership of the same ID restates it.
        if (writesAs !== null) repo.hosted.restateWritesAs(tx, id, writesAs);
      }
    },
    // A root's request declared a launcher (#473, #520): the flag is the ownership's (`ids.launcher`; its end clears
    // it), turned on by whichever of its requests declares first and audited as a local session's is, once.
    // `detail`: which ownership and client turned it on, now that a later request can (#520).
    hostedDeclareLauncher(tx: Tx, authed: AuthedUser, id: string, detail: { ownership: number; client_id: string }) {
      if (repo.hosted.declareLauncher(tx, id)) writeAudit(repo, tx, "handle.launcher_set", authed.user_email, id, { on: true, ...detail });
    },
    // The latest model and effort a hosted session's request reports (#364): written, and audited with the
    // before and after, only when one changed. Absent fields keep the stored value; an empty one clears it (#558).
    hostedFacts(tx: Tx, authed: AuthedUser, id: string, facts: { model?: string; effort?: string }) {
      const changed = setIdFacts(repo.coreOn(tx), id, facts);
      if (changed) writeAudit(repo, tx, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "request" });
    },
    // A tools-only declaration's alias, resolved and checked: a name the
    // principal may act in, never one another user's session uses (S7, S8); it may share the
    // alias with a holder. create: the first request makes the alias lazily.
    // `refused`: as `collided` above, for the refused binding row (`hostedRefused`).
    // `later`: where a policy refusal's decision row goes, for the same reason (hosted's `later`).
    // `tx`: the body the request's row is written in.
    async hostedWritesAs(tx: Tx, authed: AuthedUser, id: string, raw: string, create = false, refused?: (address: string, detail: string) => void, later?: (write: RefusalRow) => void): Promise<string> {
      const note = (address: string, detail: string) => { if (refused) refused(address, detail); else logBinding(repo.coreOn(tx), id, address, "refused", detail); };
      const target = bindTarget(hub, authed, raw);
      if ("error" in target) {
        if (target.address) note(target.address, target.error);
        if (target.authz) {
          const { req, d } = target.authz;
          const row: RefusalRow = w => recordDecision(repo, w, { user: authed.user_email, address: target.address, session: id }, req, d);
          if (later) later(row); else row(tx);
        }
        return fail(target.code, target.error);
      }
      const other = aliasUser(repo.coreOn(tx), target.address, authed.user_email);
      if (other) {
        const why = `another user's session ${other}`;
        note(target.address, why);
        return fail("alias_held", aliasHeldText(target.address, why, "write as another name"));
      }
      if (create) {
        const capped = repo.aliases.find(tx, target.address) ? null : aliasCapRefusal(repo, tx, target.scope, hub.aliasScopeCap);
        if (capped) {
          note(target.address, capped);
          return fail("bad_request", capped);
        }
        await createLazily(hub, tx, authed, target, id);
      }
      return target.address;
    },
    // The address a bind of `alias` would take, or undefined when bind will refuse it
    // (bindNow says why): the hosted service clears a stale contender for it first.
    bindAddress(authed: AuthedUser, alias: string): string | undefined {
      const target = bindTarget(hub, authed, alias);
      return "error" in target ? undefined : target.address;
    },
    aliasHolderId(r: Read, address: string): string | null { return holderOf(repo.coreOn(r), address); },
    // Every session's holds, oldest first, for the hosted sweep and reconcile.
    holdsByOwner(): Map<string, string[]> {
      const byOwner = new Map<string, string[]>();
      for (const r of repo.hosted.holds(repo.read)) {
        const list = byOwner.get(r.id);
        if (list) list.push(r.address); else byOwner.set(r.id, [r.address]);
      }
      return byOwner;
    },
    // Whether the session's ownership declared a launcher (#473, #520): what its instruction text follows, since the
    // stored flag, not the current request's `_meta`, decides whether it receives delegation requests.
    hostedLauncher(id: string): boolean { return repo.hosted.launcher(repo.read, id); },
    hostedPlace(tx: Tx, id: string, place: string | null) { setPlace(repo.coreOn(tx), id, place); },
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman,
    bindNow,
    hostedRefused(tx: Tx, id: string, address: string, detail: string) { logBinding(repo.coreOn(tx), id, address, "refused", detail); },
    hostedCollided(h: Read, authed: AuthedUser, id: string, why: string) { writeAudit(repo, h, "id.collision", authed.user_email, id, { why }); },
    unbind,
    close,
    revalidateSession: valid,
    // Everything owed to a push session, after its hello's answer: direct
    // messages and board items for `addresses` (every address by default; a
    // bind's alias after its answer).
    async replay(session: ApplicationSession, addresses?: string[]) {
      valid(session, true);
      if (session.readOnly || !session.push) return;
      // Called after the hello's or bind's commit, outside any body, so the drain runs now; awaited, so the replay
      // answers once it's delivered (#807 P3 A6a). A failure is logged, as a commit effect's is.
      try {
        await drainDirect(hub, session, addresses ?? session.addresses);
        // Closed while the drain awaited (an unlink, a revoke): nothing more is owed.
        if (!session.active) return;
        valid(session, true);
        drainBoards(session, hub, true);
      } catch (error) { console.error("postcommit effect failed", error); }
    },
    async send(
      tx: Tx,
      session: ApplicationSession,
      recipient: string,
      body: string,
      options: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean; as?: string } = {},
    ) {
      valid(session, false, tx);
      return handleSend(hub, tx, session, recipient, body, options.parent_id ?? null, options.pending === true, options.attachment_ids, options.resend === true, options.as);
    },
    async delegate(tx: Tx, session: ApplicationSession, request: Omit<DelegateRequest, "type" | "req_id">) {
      valid(session, false, tx);
      return handleDelegate(hub, tx, session, request);
    },
    async history(r: Read, session: ApplicationSession, options: { peer?: string; limit?: number; before_id?: number } = {}) {
      valid(session, false, r);
      return handleHistory(hub, r, session, options.peer, options.limit, options.before_id);
    },
    async thread(r: Read, session: ApplicationSession, id: number) {
      valid(session, false, r);
      return handleThread(r, session, id, repo);
    },
    async inbox(r: Read, session: ApplicationSession, days?: number) {
      valid(session, false, r);
      childState(session, "dm_inbox");
      return handleInbox(hub, r, session, days);
    },
    // Reads retain durable cursors; pendingFor still cleans inaccessible outbox rows.
    async pending(r: Read, session: ApplicationSession, limit = 100): Promise<DeliveryEvent[]> {
      valid(session, false, r);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("bad_request", "invalid pending limit");
      const streams = await Promise.all(session.addresses.map(async (a) => ({ type: "direct" as const, ref: a, since: await repo.cursors.get(r, a, "direct", a) })));
      const messages = repo.messages.unreadSince(r, streams).slice(0, limit);
      const seen = new Set<string>();
      const all: Pending[] = [];
      for (const a of session.addresses) {
        for (const item of pendingFor(repo.coreOn(r), a, { all: true, ack: lostAck(hub, r) })) {
          const key = pendingKey(refOf(item));
          if (!seen.has(key)) { seen.add(key); all.push(item); }
        }
      }
      const boards = all.slice(0, limit - messages.length);
      // A digest's latest post never wakes, so it carries other_user only.
      const marks = writerMarks(repo, r, session, messages.map(m => m.id), boards.map(i => (i.kind === "push" ? i.post : i.latest).id));
      return [
        ...messages.map((m): DeliveryEvent => ({ kind: "direct", message: { ...showMessage(m), ...marks.message(m.id) } })),
        ...boards.map((item): DeliveryEvent => ({ kind: "board", item: item.kind === "push"
          ? { ...item, post: { ...item.post, ...marks.post(item.post.id) } }
          : { ...item, latest: { ...item.latest, ...marks.post(item.latest.id, false) } } })),
      ];
    },
    async boardCatalog(r: Read, session: ApplicationSession, after?: string) {
      valid(session, true, r);
      return boardCatalog(repo.coreOn(r), session.readOnly ? seer(repo, session) : session.primary, after);
    },
    async boardSnapshot(r: Read, session: ApplicationSession, board: string, options: SnapshotOptions = {}) {
      valid(session, true, r);
      // A resource read is a read like board_read, and carries its marks (#825).
      const snap = snapshot(repo.coreOn(r), reader(r, session, board), board, options);
      const marks = writerMarks(repo, r, session, [], snap.posts.map((p) => p.id));
      return { ...snap, posts: snap.posts.map((p) => ({ ...p, ...marks.post(p.id) })) };
    },
    // O(1), for the metrics scrape (#805).
    get observerCount() { return observers.size; },
    // Keys in the observer indexes: a board or session with no observers left has none (#831).
    get observerIndexKeys() { return { boards: observersByBoard.size, sessions: observersBySession.size }; },
    observeBoard(session: ApplicationSession, boardInput: string, hooks: BoardObserver): () => void {
      valid(session);
      const board = normalizeBoard(boardInput);
      // Snapshot performs the same concealed access check as content reads.
      snapshot(repo.coreOn(repo.read), reader(repo.read, session, board), board, { limit: 1 });
      if (observers.size >= (opts.observerCap ?? DEFAULT_HOSTED_CAPS.watches.global)) { countRefusal("board_observer"); fail("bad_request", "board observer capacity reached"); }
      const observer = { session, board, hooks };
      addObserver(observer);
      return () => removeObserver(observer);
    },
    canReceiveBoard(r: Read, session: ApplicationSession, board: string) {
      valid(session, false, r);
      const core = repo.coreOn(r);
      return session.addresses.some((a) => canSeeBoard(core, a, board));
    },
    // handed: false is a give-up (Slack refused the message): the cursor
    // moves so it isn't retried, but nothing reached the harness to stamp.
    async receiptDirect(tx: Tx, session: ApplicationSession, ids: number[], opts: { handed: boolean } = { handed: true }) {
      valid(session, false, tx);
      await handleAck(tx, session, ids, repo, opts.handed ? now() : null);
    },
    // A ref carries no handle: the item was sent for one of this session's
    // addresses, and acknowledging is a no-op on one with no such row, so
    // each address acks it.
    receiptBoards(tx: Tx, session: ApplicationSession, refs: PendingRef[]) {
      valid(session, false, tx);
      for (const r of refs) {
        for (const a of session.addresses) acknowledge(repo.coreOn(tx), a, r);
        tx.afterCommit(() => { session.inflight.delete(pendingKey(r)); });
      }
    },
    // Acked as the address the row names (S8): receivedUnacked and
    // sentPending match a.reader = m.recipient, or m.sender.
    async acknowledgeDm(tx: Tx, session: ApplicationSession, id: number) {
      valid(session, false, tx);
      childState(session, "dm_ack");
      const m = repo.messages.getById(tx, id), mine = session.addresses;
      const reader = !m || m.recipient_type !== "user" ? null
        : mine.includes(m.recipient) ? m.recipient
        : m.pending && mine.includes(m.sender) ? m.sender
        : null;
      if (!m || reader === null) fail("not_found", `no message ${id} to you or pending from you; dm_inbox lists them`);
      repo.messages.ack(tx, reader, m.id);
    },
    async retract(tx: Tx, session: ApplicationSession, id: number) {
      valid(session, false, tx);
      return await handleRetract(hub, tx, session, id);
    },
    async call(tx: Tx, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      valid(session, UNBOUND_READS.has(tool), tx);
      // Armed on a refusal too: a call can commit work (an expiring claim) before it throws (#385 item 15f).
      try { return await handleCall(hub, tx, session, tool, args, publish); }
      finally { tx.afterCommit(() => expiry.arm()); }
    },
    // Trusted committed domain operations, not client-supplied invalidations; called after their commit, so effects run now.
    boardsChanged: (boards: string[]) => boardsChanged(onCommit(repo.read), boards),
    wake(handles: string[]) {
      expiry.arm();
      wake(hub, onCommit(repo.read), handles);
    },
    // An admin revoked or disabled a user: every session of theirs closes.
    // The hosted store ends them (disabled users) on its sweep.
    disconnectUser(userId: number) {
      for (const s of [...hub.sessions]) {
        if (!s.human && s.authed.user_id === userId) terminate(s, new ApplicationError("unauthenticated", "an admin signed this user out"));
      }
    },
    // What a principal may act in changed (S9): a team leave or removal now,
    // #270's grants later. Its sessions stop acting as aliases it lost now,
    // not when they next bind.
    // On a body's `Tx` the caller awaits it.
    accessChanged(h: Read, principal: string, by: string): Promise<void> { return recheckAliases(principal, by, h); },
    // Catches a user disabled with no server route to say so (a database
    // reset, an operator edit), and an alias its session's principal may no
    // longer act as (S9's backstop to accessChanged).
    // Its promise settles once the alias recheck is written (a failure there is logged, not rejected).
    revalidate(): Promise<void> {
      for (const observer of [...observers]) observerLive(observer);
      const users = new Set<number>();
      for (const s of hub.sessions) {
        if (!s.human && repo.users.findById(s.authed.user_id)?.disabled_at != null) users.add(s.authed.user_id);
      }
      for (const id of users) application.disconnectUser(id);
      return recheckAliases(null, null);
    },
    sweepHellos: () => { hub.helloLimiter.sweep(); hostedRequestLimiter.sweep(); hostedSubscriberLimiter.sweep(); hub.delegateLimiter.sweep(); },
    /** How many users have a bind or hosted-request bucket, for tests. */
    limiterSizes: () => ({ bind: hub.helloLimiter.size, hosted: hostedRequestLimiter.size, subscriber: hostedSubscriberLimiter.size, delegate: hub.delegateLimiter.size }),
    stopExpiry() {
      expiry.stop();
      unsubscribeEnds();
      for (const observer of [...observers]) removeObserver(observer);
    },
  };
  // Who a board read is judged for: the first of the session's addresses that can see it (S14).
  function reader(r: Read, session: ApplicationSession, board: string): Viewer {
    if (session.readOnly) return seer(repo, session);
    try {
      return boardActor(repo.coreOn(r), "board_read", { board }, { addresses: session.addresses, asAddresses: asAddresses(session), ownScope: session.authed.user_email });
    } catch (e) {
      if (e instanceof CoreError) throw coreRefusal(e);
      throw e;
    }
  }
  return application;
}
export type Application = ReturnType<typeof createApplication>;

// A hosted session with no name doesn't act as its ID (routing, not a
// capability, #229), and acts as no address: its side-effect-free reads
// (catalog, snapshot, board_list, board_read, and the board visibility in
// claim_list and peer_list) are judged by
// its user's principal directly, never as an address in the user's scope
// (`human` there is the bridge's reserved identity), #410.
function seer(repo: Repo, session: ApplicationSession): (board: Board) => boolean {
  const p = { kind: "user" as const, name: session.authed.user_email };
  return (board) => principalCanSee(repo, p, board);
}

// Where a name was last used: its session's cwd, else its place.
function whereSeen(seen: { cwd: string | null; place: string | null } | undefined): string | null {
  return !seen ? null : seen.cwd ? describeLocation(seen.cwd) : seen.place;
}

// A hosted unbound session's candidates: the user's own names nobody holds.
function candidates(hub: Hub, r: Read, authed: AuthedUser, suggestedInput: string | null): Candidate[] {
  const { repo } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const free = (n: string) => n !== HUMAN_NAME && holderOf(repo.coreOn(r), full(n)) === null;
  const names = repo.aliases.listForScope(r, "person", authed.user_email).map((i) => i.name).filter(free);
  const queued = repo.messages.queuedTo(r, names.map(full));
  const seen = repo.aliases.seen(r, names.map(full));
  const claims = new Map<string, number>();
  for (const c of listClaims(repo.coreOn(r))) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
  const suggested = suggestedInput !== null && free(suggestedInput) ? suggestedInput : null;
  return orderCandidates(
    names.map((n) => ({
      name: n, queued: queued.get(full(n)) ?? 0, claims: claims.get(full(n)) ?? 0,
      last_seen: seen.get(full(n))?.last_seen ?? 0, where: whereSeen(seen.get(full(n))),
    })),
    suggested,
  ).slice(0, MAX_CANDIDATES);
}

// The user's unbound hosted roots, for peer_list: never another user's
// (`where` describes their machine). Read from the durable store (#475), so a
// root with no request in flight is listed too. A root that holds an alias, a
// tools-only root (it writes as its writes_as) and a child (it acts as its
// root) aren't listed; nor is a root whose only live connections are idle
// legacy GETs, which receive nothing (#431). A hosted session with no name is
// listed as master listed it (#402). One row per session ID.
function unboundPeers(hub: Hub, r: Read, session: ApplicationSession): UnboundPeer[] {
  const user = session.authed.user_id;
  // Per live session ID: whether any of its connections is listed (#489: a call adds its own beside others).
  const live = new Map<string, boolean>();
  for (const c of hub.sessions) {
    if (c.transport !== "hosted" || c.authed.user_id !== user) continue;
    live.set(c.sessionId, (live.get(c.sessionId) ?? false) || c.listed);
  }
  const roots = hub.repo.hosted.roots(r, user).filter((row) =>
    row.writes_as === null && live.get(row.session_id) !== false && holdsOf(hub.repo.coreOn(r), row.session_id).length === 0);
  const statuses = idStatuses(hub.repo.coreOn(r), roots.map((r) => r.session_id));
  const now = hub.now();
  return roots.map((r) => {
    const s = statuses.get(r.session_id);
    return unboundPeer(r.session_id, r.place, r.session_id === session.sessionId, s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
  });
}

// A bare name means the one of that name in the acting address's own scope,
// and only that (as @name does in a post): another user's or team's alias is
// named in full, so a bare name never wakes someone else's agent by accident
// (security audit F-08; vision principle 9). The refusal names the full
// handles that do exist and the sender may see: a team's only to its members
// (alias.see, #348), so with none visible it reads as a name nobody has. Shared with delegate's `to` resolution (#184 review
// 7): both take bare and mixed-case names through the same path.
type Peer = Exclude<ParsedAddress, { kind: "bare" }>;
// `viewer` (the session's ID, else `from`) is whose sight the not-found
// suggestions follow (#348), as peer_list's: the session's user, not the
// address it acts as.
function resolvePeer(repo: Repo, r: Read, from: string, input: string, viewer: string = from): Peer {
  const p = addressParts(input);
  if (!p) fail("bad_request", `invalid address "${input}": expected "id:…", "scope/name" or "team:name"`);
  if (p.kind !== "bare") return p;
  const scope = ownScope(repo.resolver, from);
  const own = scope ? addressParts(`${scope}/${p.name}`) : null;
  if (own?.kind === "alias" && repo.aliases.find(r, own.address)) return own;
  if (p.name === HUMAN_NAME) {
    // A bare "human" is always your own (addressing.ts HUMAN_NAME), never the
    // one alias anyone has with the name: another user's is reached by its
    // full handle, as peer_list shows it.
    fail("not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
  }
  const vp = repo.resolver.principalOf(viewer);
  const all = repo.aliases.findAllByName(r, p.name)
    .filter((a) => vp !== null && authorize(repo, {}, { verb: "alias.see", principal: vp, scope: { scope_kind: a.scope_kind, scope_ref: a.scope_ref } }).allow)
    .map((i) => i.address).sort();
  const which = all.length ? `"${p.name}" isn't in your scope; name it in full: ${all.join(", ")}` : `no identity is named "${p.name}"`;
  return fail("not_found", `${which}; peer_list shows exact handles`);
}

// Whether `address` is a team's alias that `viewer` (a session ID, else the acting address) may not see exists: to
// anyone outside the team its names read as missing (alias.see, #348), for mail too (#1014). Only a team's: a
// service's agents take mail from anyone in the org (vision.md principle 9).
function teamAliasHidden(repo: Repo, r: Read, viewer: string, address: string): boolean {
  const a = repo.aliases.find(r, address);
  if (a?.scope_kind !== "team" || a.scope_ref === null) return false;
  const vp = repo.resolver.principalOf(viewer);
  return vp === null || !authorize(repo, {}, { verb: "alias.see", principal: vp, scope: { scope_kind: "team", scope_ref: a.scope_ref } }).allow;
}

// A send checked and resolved, ready to write: `from` the address it goes
// out as, `to` the recipient's full handle, `digests` its files' blob
// digests in call order.
type PreparedSend = { from: string; to: string; body: string; parentId: number | null; pending: boolean; ids: number[]; digests: string[] };

// The address a send goes out as: `as` when given (#284 S3), else for a
// reply the held alias its parent reached or was sent as (S4), else the
// primary.
function sendAs(hub: Hub, r: Read, session: ApplicationSession, as: string | undefined, parentId: number | null): string {
  if (as !== undefined) {
    try {
      return actingAs(as, asAddresses(session), session.authed.user_email);
    } catch (e) {
      if (e instanceof CoreError) fail("bad_request", e.message);
      throw e;
    }
  }
  const parent = parentId === null ? undefined : hub.repo.messages.getById(r, parentId);
  return (parent && participant(parent, session.addresses) ? replySender(parent, session.holds) : null) ?? session.primary;
}

// Checks a send and resolves its recipient, writing nothing; throws
// ApplicationError. Its uploads may be any of the session's addresses' (S5).
// `r`: the send's body. A policy refusal's row, when no `afterRollback` takes it, runs on that body (its audit
// write is still ambient until the audit slice).
function prepareSend(
  hub: Hub, r: Tx, session: ApplicationSession, from: string, recipientStr: string, body: string, parentId: number | null, pending: boolean, attachmentIdsRaw: unknown,
): PreparedSend {
  const { repo } = hub;
  let ids: number[];
  let digests: string[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
    digests = uploadDigests(repo.coreOn(r), ids, uploaderOf(session));
  } catch (e) {
    if (e instanceof CoreError) fail("bad_request", e.message);
    throw e;
  }

  const to = resolvePeer(repo, r, from, recipientStr, session.sessionId || from);
  if (to.kind === "team") fail("bad_request", `${to.address} isn't a person; to reach a team, board_post to its board #${to.name}`);
  // An ID's deliverability is checked in the write's transaction (writeSend).
  // A team's alias the sender may not see reads as one nobody has (#1014), unless this replies in a thread with it:
  // a handle that wrote to you is one you may answer.
  const replyingTo = (address: string) => {
    if (parentId === null) return false;
    const parent = repo.messages.getById(r, parentId);
    return participant(parent, session.addresses) && replyPeer(parent, session.addresses) === address;
  };
  if (to.kind === "alias" && (!repo.aliases.find(r, to.address) || (teamAliasHidden(repo, r, session.sessionId || from, to.address) && !replyingTo(to.address)))) {
    fail("not_found", `identity "${to.address}" not found; peer_list shows exact handles`);
  }
  const req: AuthzRequest = { verb: "msg.send", from, to: to.address };
  const decision = authorize(repo, { humanReach: hub.humanReach }, req);
  if (!decision.allow) {
    rowAfterRollback(session, r, w => recordDecision(repo, w, sessionActor(session, from), req, decision));
    fail(decision.code, decision.reason);
  }

  if (parentId !== null) {
    const parent = repo.messages.getById(r, parentId);
    if (!participant(parent, session.addresses)) fail("not_found", `parent_id ${parentId} is not a message you sent or received`);
    const peer = replyPeer(parent, session.addresses);
    if (to.address !== peer) fail("bad_request", replyPeerError(parentId, peer));
    const asError = replySenderError(parent, peer, from);
    if (asError !== null) fail("bad_request", asError);
  }
  return { from, to: to.address, body, parentId, pending, ids, digests };
}

// Writes the message and builds its result. Runs inside the caller's
// transaction; whether the recipient is live is read here, with nothing
// awaited before deliverSend pushes, so the result says what happens.
function writeSend(hub: Hub, tx: Tx, session: ApplicationSession, p: PreparedSend): Written<SendResult> & { msg: MessageRow } {
  const { repo, registry } = hub;
  let msg: MessageRow;
  try {
    if (addressParts(p.to)?.kind === "id") assertDeliverableId(repo.coreOn(tx), p.to);
    msg = repo.messages.insert(tx, p.from, "user", p.to, p.body, p.parentId, p.pending, { ids: p.ids, uploader: uploaderOf(session) }, session.writerId ?? null, session.via ?? null, session.authed.user_email);
  } catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    throw e;
  }
  const f = {
    ...(p.pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}),
    // Named whenever it isn't the primary (S4).
    ...(p.from !== session.primary ? { sent_as: p.from } : {}),
  };
  const seen = lastSeen(repo.coreOn(tx), p.to);
  const live = registry.get(p.to);
  const payload: SendResult = live?.active
    ? { message_id: msg.id, delivered_now: true, ...f, ...unwoken(repo, tx, session, live, p.to) }
    : {
        message_id: msg.id,
        delivered_now: false,
        ...f,
        ...(seen ? { recipient_last_seen: `${age(hub.now() - seen)} ago` } : {}),
        undelivered_from_you: repo.messages.undeliveredFrom(tx, session.addresses).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
        ...unwoken(repo, tx, session, live, p.to),
      };
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, tx, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: msg.sender, message_id: msg.id, recipient: msg.recipient });
  }
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// Security audit F-03 (#806): `wakes: false` and why, when the recipient is
// known to be another user whom no grant lets this sender wake, so the sender
// doesn't wait on an agent that won't act. Known: the user of the session
// holding the address now, else a person alias's user; a team or service
// alias or an ID with no live holder says nothing, as does a human (a person
// reads it; msg.send already decided reach). Each pull decides again
// (pending()), so this reflects the grant at send time, not a promise.
function unwoken(repo: Repo, r: Read, session: ApplicationSession, live: ApplicationSession | undefined, to: string): { wakes?: false; wake_note?: string } {
  if (live?.human || to.endsWith(`/${HUMAN_NAME}`)) return {};
  const toUser = live?.authed.user_email ?? (() => { const a = repo.aliases.find(r, to); return a?.scope_kind === "person" ? a.scope_ref : undefined; })();
  if (toUser === undefined) return {};
  const decision = authorize(repo, {}, { verb: "msg.wake", from_user: session.authed.user_email, to_user: toUser });
  if (decision.allow) return {};
  // Named only when the address already names them (a person alias): a team
  // alias's or an ID's holder is a handle, not a user (security audit F-12).
  const whose = to.startsWith(`${toUser}/`) ? `${toUser}'s agent` : "its holder (another user's agent)";
  return { wakes: false, wake_note: `Delivered as mail: ${whose} won't act on it until its user does (no shared collaborative team; \`grayboard team policy\`).` };
}

// Only after the outermost commit, never on a replay.
function deliverSend(hub: Hub, msg: MessageRow): void {
  const recipient = hub.registry.get(msg.recipient);
  if (recipient) deliverDirect(recipient, msg);
}

// An append write, deduplicated (#254): an identical call by this session
// as the same `sender` within the window answers with the first one's
// result. The Slack bridge's humans are exempt: a person typing a line twice
// sent it twice. `uploads`: the call's attachment ids, any of the session's
// addresses' (S5); a replay releases them (the retry uploaded its files
// afresh, and nothing will bind them), audited like any release.
// write and recheck run in a savepoint, on its Tx (the caller's refuses statements while it's open).
async function writeOnce<W extends Written>(
  hub: Hub, tx: Tx, session: ApplicationSession, tool: DedupTool, sender: string, args: Record<string, unknown>, resend: boolean, uploads: number[], write: (sp: Tx) => Sync<W>,
  recheck?: (stored: W["payload"], sp: Tx) => void,
): Promise<DedupOutcome<W>> {
  const { repo } = hub;
  if (session.human) return { fresh: await tx.savepoint(write) };
  const { authed } = session;
  const out = await dedupWrite(repo, tx, hub.now(), {
    tool, session: session.sessionId, sender, actor: authed.user_email, transport: session.transport, args, resend,
  }, write, sp => {
    for (const row of dropUnsentUploads(hub.repo.coreOn(sp), uploads, uploaderOf(session))) {
      writeAudit(repo, sp, "attachment.released", authed.user_email, `attachment:${row.id}`, {
        identity: row.uploader, filename: row.filename, size: row.size, sha256: row.sha256, reason: "replayed",
      });
    }
  }, recheck);
  if ("replay" in out && uploads.length > 0) tx.afterCommit(async () => { await sweepBlobs(repo.coreOn(repo.read), repo.blobs, queuedTx(repo)); });
  return out;
}

async function handleSend(
  hub: Hub, tx: Tx, session: ApplicationSession, recipient: string, body: string, parentId: number | null, pending: boolean, ids: unknown, resend: boolean, as: string | undefined,
): Promise<SendResult> {
  const p = prepareSend(hub, tx, session, sendAs(hub, tx, session, as, parentId), recipient, body, parentId, pending, ids);
  // Keyed by what the server resolved, so two spellings of one call collide.
  const args = { to: p.to, body: p.body, parent_id: p.parentId, pending: p.pending, attachments: p.digests };
  const out = await writeOnce(hub, tx, session, "dm_send", p.from, args, resend, p.ids, sp => writeSend(hub, sp, session, p));
  if ("replay" in out) return out.replay;
  tx.afterCommit(() => {
    // Committed, not yet answered: a lost answer's window (tests force it here).
    testPause("write:after-commit");
    deliverSend(hub, out.fresh.msg);
  });
  return out.fresh.payload;
}

// A delegation request (#184): resolve the launcher (or fall back to the
// requester's human) in core, then deliver it as a pending DM through the
// ordinary send path. Every outcome is audited: which launcher resolution
// picked and why, or the refusal (#184 review 4). Deduplicated as a
// delegate (#254): the fingerprint is the request as given, taken before
// resolution picks a launcher.
async function handleDelegate(hub: Hub, tx: Tx, session: ApplicationSession, m: Omit<DelegateRequest, "type" | "req_id">): Promise<DelegateResult> {
  const { repo } = hub;
  const { authed } = session;
  // The audit rows name the child that called, beside the routing `via` (#523).
  const byChild = session.via === undefined ? {} : { child: session.via };
  const refused = (detail: Record<string, unknown>) => rowAfterRollback(session, tx, w => writeAudit(repo, w, "delegation.refused", authed.user_email, session.primary, { ...detail, ...byChild }));
  let to: string | undefined;
  if (m.to !== undefined) {
    try {
      to = resolvePeer(repo, tx, session.primary, m.to, session.sessionId || session.primary).address;
    } catch (e) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      if (e instanceof ApplicationError) refused({ reason: e.message, to: m.to });
      throw e;
    }
  }
  const online = (h: string) => hub.registry.get(h)?.active === true;
  // The human fallback's reachability is the server's own knowledge: the
  // bridge is running and this user is linked (#191).
  // On `h`: the dedup savepoint's Tx where the call runs inside it (the caller's refuses statements while it's open).
  const humanReachable = (h: Tx) => () => hub.slackRunning() && !!repo.slack.linkFor(h, authed.user_id);
  const args = { to: to ?? null, persona: m.persona, task: m.task, context: m.context ?? null };
  // Where a refused send was headed, for its audit row.
  let picked: string | undefined;
  let out: DedupOutcome<Written<DelegateResult> & { msg: MessageRow }>;
  // A launcher's open requests: the same window dm_inbox lists by default (#252).
  const since = hub.now() - inboxDays(undefined) * 86_400_000;
  const open = (h: Tx) => (to: string) => repo.messages.openDelegations(h, to, since);
  // The limiter's streak rows and the policy denies' decision rows from this
  // call: written inside the dedup transaction they'd roll back with it, so
  // they're written after it. A refusal's decision rows go to the session's
  // afterRollback, which every queued caller sets (hosted run, Slack inWrite).
  const rows: RefusalRow[] = [];
  hub.delegateRows = rows;
  // Whether this user may name `to`'s launcher (#256): its own user's, or
  // another's under a shared 'delegating' team (policy.ts delegate.to). The
  // target's user is the session behind the address now, so a team alias
  // that changed hands is judged by its holder at this call. A deny is a
  // decision row (written after the rollback, above). An address no session
  // stands behind (`undefined`: unknown, or an alias its last binder released
  // while still live) reads as own on a fresh call, whose routing checks then
  // refuse it by name; a replay's recheck refuses it, since the stored
  // request's grant can't be judged against a holder that isn't there
  // (security audit of #878).
  const reach = (h: Tx) => (to: string, recheck = false): DelegateReach => {
    // A team's alias this session may not see reads as one nobody has (#1014), before any grant is judged. A replay
    // named it while it could: it says why it can't be replayed, not that the name never connected.
    if (teamAliasHidden(repo, h, session.sessionId || session.primary, to)) {
      return { refused: recheck ? `"${to}" is a team's alias this session may no longer see, so the first delegation can't be replayed` : neverConnected(to) };
    }
    // On a replay, a person's human is that person's, though no session holds it (the Slack bridge's connection has
    // none), so a human-fallback delegation is rechecked rather than refused as unheld (#1030). A fresh call naming a
    // human keeps reading as own, and routing refuses it as no launcher.
    const t = recheck ? addressParts(to) : null;
    const owner = t?.kind === "alias" && t.name === HUMAN_NAME && t.scopeKind === "person" ? t.scope : addressUser(repo.coreOn(h), to);
    if (owner === undefined && recheck) return { refused: `no session holds "${to}" now, so the first delegation's grant can't be rechecked; call again to delegate afresh (#256)` };
    if (owner === undefined || owner === authed.user_email) return { ok: "own" };
    if (owner === null) return { refused: crossUserRefusal(to) };
    const req: AuthzRequest = { verb: "delegate.to", from_user: authed.user_email, to_user: owner };
    const decision = authorize(repo, {}, req);
    if (decision.allow) return { ok: "granted" };
    rowAfterRollback(session, h, w => recordDecision(repo, w, sessionActor(session, session.primary), req, decision, { launcher: to }));
    return { refused: crossUserRefusal(to) };
  };
  try {
    out = await writeOnce(hub, tx, session, "delegate", session.primary, args, m.resend === true, [], sp => {
      // Checked and spent in here, so a dedup replay is neither charged nor
      // refused; resend writes again, so it's charged (#252).
      // The user's bucket, not the address's (#252): the row names the session that tripped it.
      const t = hub.delegateLimiter.check(authed.user_email, { requester: session.primary, session_id: session.sessionId, ...byChild });
      if (!t.ok) fail("rate_limited", delegateThrottled(hub.delegateLimit, t.retryAfterMs, "your user"), { retry_after_ms: t.retryAfterMs });
      const d = resolveDelegation(repo.coreOn(sp), session.primary, authed.user_email, { ...m, to }, online, humanReachable(sp), (h) => session.addresses.includes(h), open(sp), hub.delegateOpenCap, reach(sp));
      picked = d.to;
      const w = writeSend(hub, sp, session, prepareSend(hub, sp, session, session.primary, d.to, d.body, null, true, undefined));
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, sp, "delegation.requested", authed.user_email, d.to, {
        requester: session.primary,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
        ...byChild,
      });
      hub.delegateLimiter.spend(authed.user_email);
      return { payload, ref: w.ref, msg: w.msg };
    }, (stored, sp) => {
      // A replay names the launcher the first call picked: the checks a
      // fresh call makes of a named target that are authority, not routing,
      // run again on it, so a replay never outlives a revocation (#393 1,
      // docs/vision.md principle 11). Online state, the open cap and the
      // limiter are routing and stay the first call's.
      picked = stored.to;
      // An auto-pick repeat never named this target: say the first
      // delegation went, and how to delegate afresh (a fresh pick).
      const hint = m.to === undefined ? ` This repeat was not sent: your first call auto-picked "${stored.to}"; to delegate again with a fresh pick, call with resend: true.` : "";
      // The grant is authority: one revoked (the team's policy, membership, or
      // the alias's holder) since the first call refuses the replay (#256).
      const r = reach(sp)(stored.to, true);
      if ("refused" in r) throw new CoreError(r.refused + hint);
      const req: AuthzRequest = { verb: "msg.send", from: session.primary, to: stored.to };
      const decision = authorize(repo, { humanReach: hub.humanReach }, req);
      if (!decision.allow) {
        rowAfterRollback(session, sp, w => recordDecision(repo, w, sessionActor(session, session.primary), req, decision));
        fail(decision.code, decision.reason + hint);
      }
    });
  } catch (e) {
    hub.delegateRows = undefined;
    for (const row of rows) rowAfterRollback(session, tx, row);
    // Written after the rollback (hosted defers it past its outer transaction), so the refusal's row stays.
    if (e instanceof CoreError) {
      refused({ reason: e.message, to: m.to ?? picked });
      throw coreRefusal(e);
    }
    // A throttled call is audited once per streak (delegation.throttled), not per call.
    if (e instanceof ApplicationError && e.code === "rate_limited") throw e;
    // A refused send (policy.ts msg.send, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    if (e instanceof ApplicationError) refused({ reason: e.message, to: picked });
    throw e;
  }
  hub.delegateRows = undefined;
  // Committed with the write: kept, and written again should hosted's outer transaction roll back.
  for (const row of rows) { row(tx); session.afterRollback?.(row); }
  if ("replay" in out) return out.replay;
  tx.afterCommit(() => {
    testPause("write:after-commit");
    deliverSend(hub, out.fresh.msg);
  });
  return out.fresh.payload;
}

// The cursor moves only when the recipient acks, so a live recipient may hold
// a pushed message past it: liveness counts as reached too. A repeat of a
// retract that landed (its answer lost, #254) is answered from its audit row.
async function handleRetract(hub: Hub, tx: Tx, session: ApplicationSession, id: number): Promise<{ note?: string }> {
  const { repo, registry } = hub;
  const mine = session.addresses;
  const m = repo.messages.getById(tx, id);
  if (!m) {
    const done = repo.audit.last(tx, "message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by !== undefined && mine.includes(by)) return { note: alreadyRetracted(done.at) };
  }
  // Retracted as the address that sent it (S8).
  if (!m || m.recipient_type !== "user" || !mine.includes(m.sender)) return fail("not_found", retractRefusal.notYours(id));
  if (m.delivered_at !== null || registry.get(m.recipient)?.active || (await repo.cursors.directFor(tx, m.recipient)) >= m.id) return fail("bad_request", retractRefusal.reached(id, m.recipient));
  if (!repo.messages.retract(tx, m.sender, id, { actor: session.authed.user_email, session: session.sessionId })) return fail("bad_request", retractRefusal.replied(id));
  tx.afterCommit(async () => { await sweepBlobs(repo.coreOn(repo.read), repo.blobs, queuedTx(repo)); });
  return {};
}

function handleCall(hub: Hub, tx: Tx, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): unknown {
  const { repo } = hub;
  if (!isBoardTool(tool)) fail("bad_request", `unknown tool: ${tool}`);
  childState(session, tool);
  const ctx: ToolContext = {
    online: h => hub.registry.get(h)?.active === true,
    files: { limits: hub.repo.attachmentLimits, principal: uploaderOf(session).principal },
    human: session.human,
    ...(session.writerId ? { session: session.writerId } : {}),
    ...(session.via ? { via: session.via } : {}),
    user: session.authed.user_email,
    addresses: session.addresses,
    ...(session.readOnly ? { reader: seer(hub.repo, session) } : {}),
    ...(tool === "peer_list" ? { unbound: unboundPeers(hub, tx, session) } : {}),
  };
  // `as`, else the first address that can see the board (#284 S3, S14).
  let actor: string;
  try {
    actor = boardActor(repo.coreOn(tx), tool, args, { addresses: session.addresses, asAddresses: asAddresses(session), ownScope: session.authed.user_email });
  } catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    throw e;
  }
  const { as: _as, ...rest } = args;
  if (tool === "board_post") return handleBoardPost(hub, tx, session, actor, rest, ctx, publish);
  let outcome;
  try { outcome = callBoardTool(repo.coreOn(tx), actor, tool, rest, ctx); }
  catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    console.error(`[grayboard] ${tool} failed:`, e);
    return fail("internal", `${tool} failed`);
  }
  // board_read's posts carry the writer marks every read path does (#825).
  if (tool === "board_read") {
    const r = outcome.result as ReadResult;
    const marks = writerMarks(hub.repo, tx, session, [], r.posts.map((p) => p.id));
    outcome = { ...outcome, result: { ...r, posts: r.posts.map((p) => ({ ...p, ...marks.post(p.id) })) } };
  }
  // A hosted session with no name answers peer_list as its ID, but is nobody (#402).
  if (session.readOnly && tool === "peer_list" && outcome.result && typeof outcome.result === "object") delete (outcome.result as { you?: string }).you;
  for (const board of new Set(outcome.boards ?? [])) hub.boardChanged(onCommit(tx), board);
  // The transitional adapter publishes its answer before the resulting deliveries.
  if (publish) tx.afterCommit(() => publish(outcome.result));
  wake(hub, onCommit(tx), outcome.wake);
  return outcome.result;
}

// board_post, deduplicated (#254): a repeat replays the first post's result,
// and a queue board gets no second work item.
async function handleBoardPost(hub: Hub, tx: Tx, session: ApplicationSession, me: string, args: Record<string, unknown>, ctx: ToolContext, publish?: (result: unknown) => void): Promise<unknown> {
  const { repo } = hub;
  const { resend, ...postArgs } = args;
  let out: DedupOutcome<Written<BoardPostResult> & { wake: string[] }>;
  try {
    if (resend !== undefined && typeof resend !== "boolean") throw new CoreError("resend must be boolean");
    if (typeof postArgs.board !== "string") throw new CoreError("board must be a string");
    // Checked before it's fingerprinted: a non-string body is a bad request, not a canonicalJson failure.
    if (typeof postArgs.body !== "string") throw new CoreError("body must be a string");
    const ids = attachmentIds(postArgs.attachment_ids);
    // The same reading core's optNum gives it, so the access check and the write agree on whether this is a reply.
    const parentId = postArgs.parent_id ?? null;
    if (parentId !== null && typeof parentId !== "number") throw new CoreError("parent_id must be a number");
    // Before the write is deduplicated: access is re-checked on a repeat, so a caller who has lost the board is refused, not replayed (#296).
    checkPostAccess(repo.coreOn(tx), me, postArgs.board, parentId);
    const fp = { board: normalizeBoard(postArgs.board), body: postArgs.body, parent_id: parentId, attachments: uploadDigests(repo.coreOn(tx), ids, uploaderOf(session)) };
    out = await writeOnce(hub, tx, session, "board_post", me, fp, resend === true, ids, sp => {
      const o = callBoardTool(repo.coreOn(sp), me, "board_post", postArgs, ctx);
      const r = o.result as BoardPostResult;
      for (const a of r.attachments ?? []) writeAudit(repo, sp, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: me, post_id: r.post_id, board: r.board });
      return { payload: r, ref: { kind: "post", id: r.post_id } satisfies WriteRef, wake: o.wake };
    });
  } catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    if (e instanceof ApplicationError) throw e;
    console.error("[grayboard] board_post failed:", e);
    return fail("internal", "board_post failed");
  }
  if ("replay" in out) {
    if (publish) tx.afterCommit(() => publish(out.replay));
    return out.replay;
  }
  const r = out.fresh.payload;
  tx.afterCommit(() => testPause("write:after-commit"));
  hub.boardChanged(onCommit(tx), r.board);
  if (publish) tx.afterCommit(() => publish(r));
  wake(hub, onCommit(tx), out.fresh.wake);
  return r;
}

// Security audit F-10, F-03, #825: what another signed-in user wrote is
// marked other_user, by the user recorded at write time, never the address's
// spelling (a team alias or an ID names no user); the user isn't shown. One no
// msg.wake grant covers is also marked ungranted: in a lease's pull it doesn't
// wake (the host shows it without starting a turn), and on every read it's
// data the instructions say not to act on without the user's approval
// (vision.md principle 10). Every path marks the same way: the pull and the
// pull-free reads (dm_inbox, dm_thread, dm_history, board_read, a board resource), so /clear or
// a poll session loses no mark. Decided per call, so a revoked grant governs
// the next one (principle 11); one decision per writer per call. Rows from
// before the column carry no writer and no mark. Another user's message the
// server wrote through `delegate` (its delegation.requested row) is also
// marked delegated while a delegate.to grant covers its writer and this
// session's user (#256): the mark a launcher acts on, which a plain dm_send
// carrying a delegation header can't earn.
type WriterMark = { other_user?: true; ungranted?: true; delegated?: true };
function writerMarks(repo: Repo, r: Read, session: ApplicationSession, messageIds: number[], postIds: number[]) {
  const writers = repo.messages.writerUsers(r, messageIds, postIds);
  const me = session.authed.user_email;
  const decided = new Map<string, boolean>();
  const may = (verb: "msg.wake" | "delegate.to", user: string) => {
    const key = `${verb} ${user}`;
    if (!decided.has(key)) decided.set(key, authorize(repo, {}, { verb, from_user: user, to_user: me }).allow);
    return decided.get(key)!;
  };
  const foreign = messageIds.filter((id) => { const u = writers.messages.get(id); return u !== undefined && u !== me; });
  const delegations = foreign.length ? repo.messages.delegationIds(r, foreign) : new Set<number>();
  const mark = (user: string | undefined, judged: boolean): WriterMark =>
    user === undefined || user === me ? {} : { other_user: true, ...(judged && !may("msg.wake", user) ? { ungranted: true as const } : {}) };
  return {
    message: (id: number): WriterMark => {
      const m = mark(writers.messages.get(id), true);
      return m.other_user && delegations.has(id) && may("delegate.to", writers.messages.get(id)!) ? { ...m, delegated: true } : m;
    },
    post: (id: number, judged = true): WriterMark => mark(writers.posts.get(id), judged),
  };
}

async function handleHistory(hub: Hub, r: Read, session: ApplicationSession, peer: string | undefined, limit: number | undefined, beforeId: number | undefined): Promise<HistoryMessage[]> {
  const { repo } = hub;
  let lim: number;
  try {
    lim = historyLimit(limit);
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const peerFull = peer ? resolvePeer(repo, r, session.primary, peer, session.sessionId || session.primary).address : undefined;
  const mine = session.addresses;
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const rows = repo.messages.history(r, mine, peerFull, lim, beforeId).reverse();
  const sent = (m: MessageRow) => mine.includes(m.sender) && m.recipient_type === "user" && !mine.includes(m.recipient);
  // The cursor of each recipient a sent, unstamped message needs, read once before the rows are shaped (#807 P3 A6a).
  const unstamped = [...new Set(rows.filter((m) => sent(m) && m.delivered_at === null).map((m) => m.recipient))];
  const cursors = new Map(await Promise.all(unstamped.map(async (to) => [to, await repo.cursors.directFor(r, to)] as const)));
  const messages = rows.map((m) =>
    sent(m) ? { ...m, delivered: m.delivered_at !== null || cursors.get(m.recipient)! >= m.id } : m,
  );
  const marks = writerMarks(repo, r, session, messages.map((m) => m.id), []);
  return messages.map((m) => ({ ...showMessage(m), ...marks.message(m.id) }));
}

function handleInbox(hub: Hub, r: Read, session: ApplicationSession, days: number | undefined): InboxResult {
  const { repo } = hub;
  const mine = session.addresses;
  let since: number;
  try {
    since = hub.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const owed = unanswered(mine, repo.messages.receivedUnacked(r, mine, since), (id) => repo.messages.thread(r, id), session.primary);
  const promises = promised(mine, repo.messages.sentPending(r, mine, hub.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(r, id));
  const queued = repo.messages.undeliveredFrom(r, mine).map((u) => {
    const seen = lastSeen(repo.coreOn(r), u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(hub.now() - seen)} ago` } : {}) };
  });
  const marks = writerMarks(repo, r, session, owed.map((m) => m.id), []);
  return {
    unanswered: owed.map((m) => ({ ...m, ...marks.message(m.id) })),
    ...(promises.length ? { promised: promises } : {}),
    ...(queued.length ? { undelivered_from_you: queued } : {}),
  };
}

function handleThread(r: Read, session: ApplicationSession, messageId: number, repo: Repo): DirectMessage[] {
  const mine = (m: MessageRow | undefined): m is MessageRow => participant(m, session.addresses);
  if (!mine(repo.messages.getById(r, messageId))) fail("not_found", `message ${messageId} not found`);
  const rows = repo.messages.thread(r, messageId).filter(mine);
  const marks = writerMarks(repo, r, session, rows.map((m) => m.id), []);
  return rows.map((m) => ({ ...showMessage(m), ...marks.message(m.id) }));
}

// A receipt: the harness was handed these ids. Each stamps its delivery time
// once (unless `at` is null: given up, not handed) and moves its recipient
// address's cursor; only your own direct messages count (S8).
async function handleAck(tx: Tx, session: ApplicationSession, messageIds: number[], repo: Repo, at: number | null): Promise<void> {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(tx, msgId);
    if (!msg || msg.recipient_type !== "user" || !session.addresses.includes(msg.recipient)) continue;
    if (at !== null) repo.messages.markDelivered(tx, msgId, at);
    await repo.cursors.advance(tx, msg.recipient, "direct", msg.recipient, msgId);
  }
}
