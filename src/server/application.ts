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
import { DELEGATE_LIMIT, DELEGATE_OPEN_CAP, crossUserRefusal, delegateOkFields, delegateThrottled, neverConnected, resolveDelegationWith, type DelegateReach } from "../core/delegation.ts";
import {
  MAX_CANDIDATES, MAX_HOLDS, actingAs, aliasHeldText, boardActor, childStateRefusal, closestNames,
  orderCandidates, primaryOf, replyPeer, replyPeerError, replySender, replySenderError, tooManyHolds, unboundPeer, unknownNameError,
  type AliasUse, type Candidate,
} from "../core/bindings.ts";
import { participant, type MessageRow, type Repo } from "./db.ts";
import { sweepStoredBlobs } from "./attachments.ts";
import { afterCommitOf, isTx, type Read, type Tx } from "./store/tx.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatTeamAddress } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { authorize, recordDecision, type Actor, type AuthzRequest, type Decision, type HumanReach } from "./policy.ts";
import { serverAuditSink, writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  age, snapshot, canSeeBoard, checkBody, checkPostAccess, parseAliasMeta, pendingKey, refOf,
  cleanFact, idCollisionText, normalizeBoard, getBoard,
  type AliasMetaSet, type Board, type CoreDb, type Viewer, type PendingRef, type ReadResult, type SnapshotOptions, type UnboundPeer,
} from "../core/boards.ts";
import { addressParts, aliasScope, type AliasScope, type ParsedAddress } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { countRefusal } from "./metrics.ts";
import type { Principal } from "../core/resolver.ts";
import { coreRefusalCode, Undeliverable } from "../core/session_end.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type ToolContext, type BoardPostResult } from "../core/tools.ts";
import { attachmentIds, type Uploader } from "../core/attachments.ts";
import type { AttachmentLimits } from "../shared/attachments.ts";
import { expiryTimer } from "../core/claims.ts";
import { detached } from "./request_context.ts";
import { onAliasCreated } from "./teams.ts";
import { boardAccess, ownScopeOn, principalCanSee, type BoardAccess } from "./access.ts";
import { boardCatalog, boardSnapshot, pendingOf } from "./board_reads.ts";
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
// What application.hostedBuildFacts reads for application.hostedBuild (#807 P3 A7g): whether the session's ID is its
// user's, the hello's reads, and the candidates a read-only session shows.
export type BuildFacts = { own: boolean; hello: HelloFacts; candidates?: Candidate[] };
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
  // Set while a board drain runs (drainBoards, #807 P3 B5a1): a wake meanwhile asks for one more run (`all` when any
  // asks for it), and a receipt committed meanwhile names what the running drain read before it and mustn't resend.
  boardDrain: { rerun: boolean; all: boolean; acked: Set<string>; done: Promise<void> } | null = null;
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
  // Board visibility on a caller's handle (#807 P3 B5a1).
  access: BoardAccess;
  slackRunning: () => boolean;
  helloLimiter: RateLimiter;
  // delegate's per-user bucket and the launcher cap (#252). A streak's
  // rows go to delegateRows while a delegate call runs, to be written where
  // its outcome keeps them, on that call's `Tx`; otherwise (a sweep, outside any body) posted.
  delegateLimit: RateLimit;
  delegateLimiter: RateLimiter;
  delegateRows: SyncRow[] | undefined;
  delegateOpenCap: number;
  aliasScopeCap: number;
  now: () => number;
  // `on`: when its effect runs (`onCommit(handle)`: after that handle's commit, or now for `repo.read`).
  boardChanged: (on: Commit, board: string) => void;
};

// Schedules an effect after the commit of the transaction a handle names, or now for a `Read` (#807 P1c-15a).
type Commit = (effect: () => void | Promise<void>) => void;
const onCommit = (h: Read): Commit => (effect) => afterCommitOf(h, effect);

// A push its reader can no longer see, acknowledged as pendingOf finds it, on `h`: inside a body (a delivery
// receipt's `pending`) on its `Tx`, awaited; outside one (a drain, a lease's pull) queued on the write queue and not
// awaited (#807 D4; never `repo.post`, which refuses an async body, B5a1 H2).
const lostAck = (hub: Hub, h: Read, handle: string) => async (ref: PendingRef): Promise<void> => {
  if (isTx(h)) return hub.repo.boards.acknowledge(h, handle, ref);
  void hub.repo.write((tx: Tx) => hub.repo.boards.acknowledge(tx, handle, ref)).catch((error) => console.error("lost-visibility push ack failed", error));
};

// A pending item's identity down to the post a digest names: a receipt for it means the drain that read it must not
// send it again; a newer digest of the same board is another item.
const ackKey = (r: PendingRef) => (r.kind === "push" ? `p:${r.post_id}` : `d:${r.board}:${r.latest_id}`);

// Send this session everything pending on boards, for any of its addresses,
// that it hasn't been sent: a subscription taken as the ID while unbound and
// the alias's own both deliver. all: also deferred pushes and digests (at
// hello; see pendingFor).
//
// Its reads await (#807 P3 B5a1, H1), so other bodies commit meanwhile. One drain runs per session: a call while one
// runs asks it for another run and waits for that run, so a later drain never delivers before an earlier one. A
// receipt that commits during a drain names an item that drain may have read before it: the drain skips it.
function drainBoards(session: ApplicationSession, hub: Hub, all = false): Promise<void> {
  const running = session.boardDrain;
  if (running) {
    running.rerun = true;
    running.all ||= all;
    return running.done;
  }
  const d: NonNullable<ApplicationSession["boardDrain"]> = { rerun: true, all, acked: new Set(), done: Promise.resolve() };
  session.boardDrain = d;
  // A run that fails doesn't end the drain: a rerun asked for meanwhile still runs, and the callers waiting see the
  // last run's failure, if that one failed too.
  d.done = (async () => {
    let failure: { error: unknown } | undefined;
    try {
      while (d.rerun && session.active) {
        const runAll = d.all;
        d.rerun = false;
        d.all = false;
        try { await drainBoardsOnce(session, hub, runAll, d.acked); failure = undefined; }
        catch (error) {
          failure = { error };
          // An `all` run that failed is owed again if another run follows.
          d.all ||= runAll;
        }
      }
    } finally { session.boardDrain = null; }
    if (failure) throw failure.error;
  })();
  return d.done;
}

async function drainBoardsOnce(session: ApplicationSession, hub: Hub, all: boolean, acked: Set<string>): Promise<void> {
  for (const address of [...session.addresses]) {
    const items = await pendingOf(hub.repo, hub.access, hub.repo.read, address, all, lostAck(hub, hub.repo.read, address));
    // Closed while the read awaited: nothing more to send. Unbound from this address: the holds change dropped its
    // in-flight items.
    if (!session.active) return;
    if (!session.addresses.includes(address)) continue;
    for (const item of items) {
      const ref = refOf(item);
      if (acked.has(ackKey(ref))) continue;
      const key = pendingKey(ref);
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
    const unread = await hub.repo.messages.unreadSince(hub.repo.read, streams);
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
      if (session?.active) void drainBoards(session, hub, session.human).catch((error) => console.error("postcommit effect failed", error));
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
// Selection reads and records delivery in one bind body, which holds the write queue across its awaits (#807 D4),
// so only one agent gets it.
async function owedBridgeNotice(repo: Repo, tx: Tx, email: string): Promise<string | undefined> {
  const target = `${email}/${HUMAN_NAME}`;
  const stop = await repo.audit.last(tx, "bridge.stopped", target);
  if (!stop) return undefined;
  let detail: { reason?: string; at?: string; suppressed?: boolean };
  try {
    detail = stop.detail ? (JSON.parse(stop.detail) as typeof detail) : {};
  } catch {
    return undefined;
  }
  if (detail.suppressed || !detail.at || !detail.reason) return undefined;
  const notified = await repo.audit.last(tx, "bridge.notified", target);
  if (notified && notified.at >= stop.at) return undefined;
  writeAudit(repo, tx, "bridge.notified", null, target, { at: new Date().toISOString(), stopped_at: detail.at });
  return `your Slack bridge stopped at ${detail.at} (${detail.reason}); linked humans are offline until it reconnects or the server restarts`;
}

// What a hello's fields read, split from building them (#807 P3 A7g): a caller reads these in its body, on its `Tx`
// (#807 P3 A7e2: a holder's `repo.read` is refused), and builds the fields synchronously where it registers the session.
export type HelloFacts = { teams: string[]; linked: boolean };
async function helloFacts(hub: Hub, authed: AuthedUser, r: Read): Promise<HelloFacts> {
  const { repo } = hub;
  const teams = (await repo.teams.listForUser(r, authed.user_id)).map((t) => formatTeamAddress(t.name));
  return { teams, linked: !!(await repo.slack.linkFor(r, authed.user_id)) };
}
// Reads nothing: whether the bridge runs is in memory, read when the fields are built.
function helloFields(hub: Hub, authed: AuthedUser, f: HelloFacts): SessionFacts {
  return {
    user_email: authed.user_email,
    teams: f.teams,
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && f.linked },
    attachment_limits: hub.repo.attachmentLimits,
  };
}

// The sentences a session's instructions carry for its addresses: active
// claims, and direct messages it sent that still haven't arrived a day later.
async function noticesFor(hub: Hub, r: Read, addresses: string[], first: string[] = []): Promise<string[]> {
  const undelivered = await hub.repo.messages.undeliveredFrom(r, addresses, hub.now() - STALE_UNDELIVERED_MS);
  // Read before the synchronous helper (#807 P3 B1a), which asks per stale recipient.
  const seen = await hub.repo.bindings.lastSeen(r, undelivered.map((u) => u.recipient));
  const claims = await hub.repo.claims.list(r);
  return [
    ...first,
    ...undeliveredInstruction(undelivered, (h) => seen.get(h) ?? null),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(claims, addresses),
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

// `r`: the caller's handle (a body's `Tx`); the scope's principal and the decision read on it.
async function bindTarget(hub: Hub, r: Read, authed: AuthedUser, input: string): Promise<Target> {
  const { repo } = hub;
  const p = addressParts(input);
  if (!p || p.kind === "id" || p.kind === "team") {
    return { code: "bad_request", error: `"${input}" isn't an alias: a name (a-z 0-9 _ -, 1-32 chars), or scope/name` };
  }
  const address = p.kind === "bare" ? `${authed.user_email}/${p.name}` : p.address;
  // aliasScope asks for a principal scope's kind only, and only for this address's scope: read it first.
  const owner = p.kind === "alias" && p.scopeKind === "principal" ? (await repo.principals.findByName(r, p.scope))?.kind : undefined;
  let scope: AliasScope;
  try {
    scope = aliasScope(address, () => (owner === "team" || owner === "service" ? owner : null));
  } catch (e) {
    // The reserved name refuses alike in a team that exists and one that doesn't (#1020).
    if (e instanceof CoreError && p.name === HUMAN_NAME) return { code: "forbidden", error: HUMAN_RESERVED, address };
    if (e instanceof CoreError) return { code: "not_found", error: e.message, address };
    throw e;
  }
  const t = { ...scope, scope_ref: scope.scope_ref! };
  const req: AuthzRequest = { verb: "alias.bind", principal: userPrincipal(authed), scope: t, name: scope.name };
  const d = await authorize(repo, r, {}, req);
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
  if ((await repo.aliases.find(tx, address))) return;
  await repo.aliases.create(tx, scope, authed.user_email);
  writeAudit(repo, tx, "alias.created", authed.user_email, address, { lazy: true, session });
  await onAliasCreated(repo, tx, authed.user_id, address);
}

// Who holds an alias, for an alias_held refusal: its ID and where it runs.
// `place` describes the holder's machine, so only its own principal sees it
// (#349): a team alias's asker can be another member. `r`: the bind's body.
async function describeHolder(hub: Hub, r: Read, id: string, asker: string): Promise<string> {
  const row = await hub.repo.bindings.idRow(r, id);
  const place = row?.principal === asker ? row.place : null;
  // A hosted root has no connection to disconnect: it is last seen when its client last called (#402).
  const hosted = await hub.repo.hosted.get(r, id);
  if (hosted) return `the hosted session ${id}${place ? `, in ${place}` : ""}, last seen ${Math.floor((hub.now() - hosted.last_seen_at) / 1000)}s ago`;
  return `the session ${id}${place ? `, in ${place}` : ""}`;
}

// A refusal's row, written by the session's `afterRollback` when the call runs inside a transaction the refusal's
// throw rolls back (#452, #467), or now on `tx`, the body the call runs in. Every flusher runs it through an awaited
// `tx.savepoint`, so a binding row may be async (#807 P3 B1c).
export type RefusalRow = (tx: Tx) => void | Promise<void>;
// A row written where nothing awaits it (an audit or decision row, a streak or throttle row, one core's synchronous
// `reach` emits): synchronous by convention, so none floats a promise (#807 P3 B1c, R10). The type doesn't refuse an
// async function (TypeScript accepts one where `void` is returned): every producer must call only synchronous writers.
export type SyncRow = (tx: Tx) => void;
function rowAfterRollback(session: ApplicationSession, tx: Tx, write: SyncRow) {
  if (session.afterRollback) session.afterRollback(write); else write(tx);
}
// An async row (a binding row): written now is awaited.
async function asyncRowAfterRollback(session: ApplicationSession, tx: Tx, write: RefusalRow): Promise<void> {
  if (session.afterRollback) session.afterRollback(write); else await write(tx);
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
  const streakRow = (write: SyncRow) => {
    if (!streakAt) { repo.post(write, undefined, "bind rate-limit row"); return; }
    write(streakAt.tx); streakAt.afterRollback?.(write);
  };
  const delegateRow = (write: SyncRow) => { if (hub.delegateRows) hub.delegateRows.push(write); else repo.post(write, undefined, "delegation throttle row"); };
  const hub: Hub = {
    repo,
    registry: new Map(),
    sessions: new Set(),
    humanReach: opts.humanReach ?? "team",
    access: boardAccess(repo, opts.humanReach ?? "team"),
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
      on(async () => {
        // A copy: liveObservers removes a dead observer from the set mid-walk.
        const live = await liveObservers(board, [...observersByBoard.get(board) ?? []]);
        // Still observing after the await: a close meanwhile isn't notified.
        for (const observer of live) if (observers.has(observer)) notify(() => observer.hooks.changed());
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
  // Of one board's observers, those still live: the session valid and one of its addresses (as they stood before the
  // read) able to see the board, read once for them all (#807 P3 B5a1, H3). The rest are removed; a failed read
  // removes them all, as a refused check would.
  async function liveObservers(board: string, list: Observer[]): Promise<Observer[]> {
    const checked = list.flatMap((o) => {
      if (!observers.has(o)) return [];
      try { validNow(o.session); return [{ o, addresses: [...o.session.addresses] }]; }
      catch { removeObserver(o); return []; }
    });
    if (!checked.length) return [];
    let seeing = new Set<string>();
    try {
      const b = await repo.boards.get(repo.read, board);
      if (b) seeing = await hub.access.canSeeMany(repo.read, [...new Set(checked.flatMap((c) => c.addresses))], b);
    } catch (error) { console.error("[grayboard] observer check failed:", error); }
    const live: Observer[] = [];
    for (const { o, addresses } of checked) {
      if (addresses.some((a) => seeing.has(a))) live.push(o);
      else removeObserver(o);
    }
    return live;
  }
  function boardsChanged(on: Commit, boards: string[]) {
    for (const board of new Set(boards)) hub.boardChanged(on, board);
  }
  // Core's claim expiry calls back after its sweep's write has committed, outside any body: its effects run now.
  const expiryCommit = onCommit(repo.read);
  // Announces claims that lapse on their boards.
  // Armed from requests, it fires for every holder: detached, so its rows
  // don't carry the arming request's address (security audit F-19).
  // The sweep is a queued write that reads the clock inside it; `arm` runs after commits and outside bodies, and reads
  // on the pool (#807 P3 B2).
  const claimTimer = expiryTimer({
    next: () => repo.claims.nextExpiry(repo.read),
    sweep: () => repo.write(tx => repo.claims.sweep(tx, Date.now())),
  }, handles => wake(hub, expiryCommit, handles), boards => boardsChanged(expiryCommit, boards));
  const expiry = { arm: () => detached(() => claimTimer.arm()), stop: () => claimTimer.stop() };
  // The session leaves the hub's registry: superseded, revoked or closed.
  function detach(session: ApplicationSession): void {
    for (const a of session.addresses) if (hub.registry.get(a) === session) hub.registry.delete(a);
  }
  // `h`: the body the close runs in (bind's and unbind's `finally`), whose `Tx` takes its rows at its commit (they roll
  // back with it, as they did written inline); else each is its own queued write. Close stays synchronous, and its
  // callers include the write queue's holder (a reconcile apply, a commit callback), where an async post throws, so
  // the outside-a-body write is a `repo.write` not awaited, its failure logged (#807 P3 B1c).
  function close(session: ApplicationSession, h: Read = repo.read) {
    const write = (row: (tx: Tx) => Promise<void>, what: string) => {
      if (isTx(h)) h.beforeCommit({}, row);
      else void repo.write(row).catch(e => console.error(`[grayboard] ${what} failed:`, e));
    };
    if (!session.active) return;
    session.active = false;
    hub.sessions.delete(session);
    for (const observer of [...observersBySession.get(session) ?? []]) removeObserver(observer);
    if (session.human) {
      const addr = session.primary;
      if (addr && hub.registry.get(addr) === session) {
        hub.registry.delete(addr);
        write(tx => repo.bindings.log(tx, HUMAN_NAME, addr, "released", "connection closed"), "human release row");
      }
      return;
    }
    // alias_holds is the hosted hold set's only truth (#451): a close is a rebuild
    // (reconcile) or a shutdown, never a release, so it leaves the holds alone.
    const id = session.sessionId;
    detach(session);
    // Close runs from sync finally blocks and commit callbacks: the touch is written at `h`'s commit or queued, not
    // awaited (#807 P1b-4b, P3 B1c).
    const writer = session.writerId;
    if (writer) write(tx => repo.bindings.touchId(tx, writer), "last-seen touch");
  }
  // The server closes the session: it leaves the hub, and its transport is
  // told why and closes. `h`: the body it runs in, whose `Tx` takes close's rows (#807 P3 A3).
  function terminate(session: ApplicationSession, error: ApplicationError, h: Read = repo.read) {
    detach(session);
    session.closedBy = error;
    close(session, h);
    session.sink.closed(error);
  }
  // The session open and current; a closed one is refused with why.
  function stillOpen(session: ApplicationSession) {
    if (!session.active || !hub.sessions.has(session)) {
      // A superseded bridge connection is told so, a revoked tools-only
      // one why it may not write as its alias (S9); any other closed session
      // is closed (#402).
      const why = session.closedBy;
      if (why?.code === "superseded") fail("superseded", "this connection no longer holds its session");
      if (why?.code === "forbidden") throw why;
      fail("unauthenticated", "session is closed");
    }
  }
  // `valid`'s checks that read nothing (#807 P3 A7u1), for a sync caller downstream of a token check that refused a
  // disabled user with no await since, or of one that rechecks (the board observers' `changed` hook).
  function validNow(session: ApplicationSession, allowUnbound = false) {
    stillOpen(session);
    if (session.readOnly && !allowUnbound) fail("unbound", UNBOUND_ERROR);
  }
  // `h`: the handle the caller holds; inside a body its `Tx`, so a disabled user's terminate writes its rows there.
  // The user read awaits (#807 P3 A7u1, A7u2): a close, detach or terminate that lands meanwhile changes the session
  // outside the write queue, so it's checked again after, and the caller goes on with no await between.
  async function valid(session: ApplicationSession, allowUnbound = false, h: Read = repo.read): Promise<void> {
    stillOpen(session);
    const disabled = await repo.users.isDisabled(h, session.authed.user_id);
    await testPauseAsync("valid:user:read");
    stillOpen(session);
    if (disabled) {
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
  // `ids` reads the IDs to end on the write's Tx (#807 P3 A7h1: the hosted filter's reads await); none ends nothing.
  function endIds(ids: (tx: Tx) => Promise<string[]>, why: string): Promise<void> {
    return repo.write(async tx => {
      const list = await ids(tx);
      return list.length ? endIdsIn(tx, list, why) : null;
    }, ends => { if (ends) afterEnds(ends.woken, ends.bounces); }).then(() => {});
  }
  type Ends = { woken: Set<string>; bounces: MessageRow[] };
  // endIds's body, inside a write body: `tx` is that body's. Each end's savepoint runs on its own Tx.
  async function endIdsIn(tx: Tx, ids: string[], why: string): Promise<Ends> {
    const woken = new Set<string>(), bounces: MessageRow[] = [];
    for (const id of ids) {
      let ended;
      const at = now();
      try {
        // The end's bounces are read in its savepoint, so they're pushed at the commit (#807 P3 A7i), before any
        // newer message to their senders can commit; a failed read rolls back this end alone.
        ended = await tx.savepoint(async sp => {
          const end = await repo.sessionEnd.end(sp, id, { why, now: at, audit: serverAuditSink(repo, sp) });
          return { ...end, bounces: end.ended ? await repo.messages.bouncesFrom(sp, id, at) : [] };
        });
      } catch (e) {
        console.error(`[grayboard] ending session ${id} (${why}) failed:`, e);
        writeAudit(repo, tx, "id.end_failed", null, id, { why, error: String(e) });
        continue;
      }
      // An end that found the session already ended sends nothing again.
      if (!ended.ended) continue;
      for (const h of ended.wake) woken.add(h);
      bounces.push(...ended.bounces);
      if (ended.held.length) console.error(`[grayboard] session ${id} ended (${why}); released ${ended.held.join(", ")}`);
    }
    return { woken, bounces };
  }
  // What follows ends, after their commit: a bounce goes to a live sender now, as a send does (a drain would
  // resend that session's unacked messages too), the woken handles drain, and the freed upload bytes go. The
  // bounces were read in the ends' transaction (#807 P3 A7i), so they're pushed at the commit, synchronously, before
  // a newer message to their senders can be.
  function afterEnds(woken: Set<string>, bounces: MessageRow[]): void {
    for (const b of bounces) {
      const to = hub.registry.get(b.recipient);
      if (to) deliverDirect(to, b);
    }
    wake(hub, onCommit(repo.read), [...woken]);
    void sweepStoredBlobs(repo);
  }
  // The hosted store ends a released child's ID in the release's transaction (#475 item 1); this runs its
  // after-commit half for every hosted commit, whichever path released it.
  const unsubscribeEnds = repo.hosted.subscribe(() => {
    const ended = repo.hosted.takeEnded();
    if (ended.length) afterEnds(new Set(ended.flatMap((e) => e.wake)), ended.flatMap((e) => e.bounces));
  });
  // The WSS transport is gone (#282): no connection can come back for a
  // session a previous run left unended, because only a hello re-attached one.
  // End each at start, as the grace sweep would have: holds and claims
  // released, mail bounced. A hosted ID is the hosted store's to end.
  // The startup leftovers' ends (#807 P3 A1): the server's `ready` waits for them.
  // The write is enqueued at construction, ahead of every startup write but the dev-session revocation, and reads the leftovers on its own Tx
  // (#807 P3 B1b): a start with none commits an empty transaction.
  const ready = endIds(async (tx) => {
    const ids: string[] = [];
    for (const id of await repo.bindings.unendedIds(tx)) if (!(await repo.hosted.owned(tx, id))) ids.push(id);
    return ids;
  }, "wss_removed");
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
    const body = async (tx: Tx) => {
      const revoked: (AliasUse & { reason: string })[] = [];
      // One decision per (principal, scope): the sweep holds the write queue while it reads.
      const reasons = new Map<string, string | null>();
      for (const u of await repo.bindings.aliasUses(tx, principal)) {
        const key = JSON.stringify([u.principal, u.scope_kind, u.scope_ref]);
        let reason = reasons.get(key);
        if (reason === undefined) {
          const p = await repo.principals.findByName(tx, u.principal);
          const d = p ? await authorize(repo, tx, {}, { verb: "scope.act", principal: p, scope: u }) : undefined;
          reason = !p ? `principal ${u.principal} no longer exists` : d && !d.allow ? d.reason : null;
          reasons.set(key, reason);
        }
        if (reason) revoked.push({ ...u, reason });
      }
      const out = await revokeAliases(tx, revoked, by);
      // The resynced holders' holds as the transaction commits (#807 P3 B1b): a beforeCommit read sees what a
      // caller's body writes after this returns, as the after-commit read it replaces did.
      const holds = new Map<string, string[]>();
      if (out.resync.length) tx.beforeCommit({}, async root => {
        for (const [id, held] of await repo.bindings.holdsOfMany(root, out.resync)) holds.set(id, held);
      });
      return { ...out, holds };
    };
    const committed = ({ resync, ends, holds }: Awaited<ReturnType<typeof body>>) => {
      // #475 7c: a live holder (the Slack bridge's, an application session) stops acting as it now: its
      // address set and registry entries follow the database, as a bind or unbind's do.
      for (const id of resync) for (const s of hub.sessions) if (!s.human && s.sessionId === id) setHolds(hub, s, holds.get(id) ?? []);
      afterEnds(ends.woken, ends.bounces);
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
    if (!uses.length) return { resync, ends: { woken: new Set(), bounces: [] } };
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
    const hosted = await repo.hosted.owned(tx, u.id);
    if (!u.held) {
      // A hosted tools-only root ends its ownership, not an ID (hosted IDs are the store's).
      await tx.savepoint(async sp => {
        writeAudit(repo, sp, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, writes_as: true, reason });
        if (hosted) await repo.hosted.end(sp, u.id, "revoked", now());
      });
      if (!hosted) ended.push(u.id);
      return;
    }
    // A hosted root's change goes through the hosted store's writes, whose commit tells the hosted
    // service and delivery to close the lease now, not at its next renewal.
    await tx.savepoint(async sp => {
      const primary = hosted && (await repo.bindings.holdsOf(sp, u.id))[0] === u.address;
      await repo.bindings.release(sp, u.address, u.id);
      await repo.bindings.log(sp, u.id, u.address, "released", `access revoked: ${reason}`);
      writeAudit(repo, sp, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, reason });
      if (hosted) {
        const row = await repo.hosted.get(sp, u.id);
        if (row) {
          // Its last hold gone, the root is unbound but owning: no lease, so the sweep doesn't expire it.
          await repo.hosted.update(sp, { ...row, bind_gen: row.bind_gen + 1, lease_deadline: (await repo.bindings.holdsOf(sp, u.id)).length ? row.lease_deadline : null });
          if (row.lease_deadline !== null) writeAudit(repo, sp, "hosted.lease_closed", null, u.id, { reason: "revoked", ownership: row.ownership_id });
          await repo.hosted.lose(sp, u.id, { alias: u.address, reason, primary }, now());
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
  async function attachHuman(authed: AuthedUser, sink: DeliverySink, current?: (tx: Tx) => string | null | Promise<string | null>): Promise<{ session: ApplicationSession; ok: HelloResult }> {
    const addr = `${authed.user_email}/${HUMAN_NAME}`;
    return repo.write(async tx => {
      if ((await repo.users.findById(tx, authed.user_id))?.disabled_at != null) fail("unauthenticated", "session is closed");
      const stale = await current?.(tx);
      if (stale) fail("unauthenticated", stale);
      if (!(await repo.aliases.find(tx, addr))) {
        await repo.aliases.create(tx, { scope_kind: "person", scope_ref: authed.user_email, name: HUMAN_NAME }, authed.user_email);
        writeAudit(repo, tx, "alias.created", authed.user_email, addr, { lazy: true, slack: true });
        await onAliasCreated(repo, tx, authed.user_id, addr);
      }
      // Read in the body, on its Tx, for the hello the committed callback builds (#807 P3 A7g).
      const hello = await helloFacts(hub, authed, tx);
      // Again after the awaits (#807 P3 A7f3 audit): a stop outside the write queue lands meanwhile; the throw rolls the create back.
      // The rows before the last check (#807 P3 B1c, R3): nothing awaits after it; its throw rolls them back.
      await repo.bindings.touchAlias(tx, addr);
      await repo.bindings.log(tx, HUMAN_NAME, addr, "bound");
      const late = await current?.(tx);
      if (late) fail("unauthenticated", late);
      return hello;
    }, hello => {
      const session = new ApplicationSession(authed, sink, true, true);
      session.primary = addr;
      session.addresses = [addr];
      // A bridge connection never pongs: a newer one for the user replaces it.
      const prev = hub.registry.get(addr);
      if (prev && prev !== session) terminate(prev, new ApplicationError("superseded", "a newer Slack bridge connection took over this human"));
      hub.sessions.add(session);
      hub.registry.set(addr, session);
      return { session, ok: { id: HUMAN_NAME, ...helloFields(hub, authed, hello) } };
    });
  }

  // bind (#284 S2, PR 4 S1): add an alias to this session's holds. One it
  // already holds answers ok and applies only `meta`; the others stay held,
  // and the primary changes only when the session held nothing.
  // A refusal's binding row goes to the session's `afterRollback` when it has one: a hosted bind runs inside a
  // transaction the refusal's throw rolls back, and the row is written after it.
  // `tx`: the body the bind runs in; its alias reads and lazy create run on it.
  async function bindNow(tx: Tx, session: ApplicationSession, m: Omit<BindRequest, "type" | "req_id">): Promise<BindResult> {
    await valid(session, true, tx);
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
    const target = await bindTarget(hub, tx, authed, m.alias);
    await testPauseAsync("bind:target:decided");
    if ("error" in target) {
      if (target.address) { const a = target.address; await asyncRowAfterRollback(session, tx, w => repo.bindings.log(w, id, a, "refused", target.error)); }
      if (target.authz) { const { req, d } = target.authz; rowAfterRollback(session, tx, w => recordDecision(repo, w, sessionActor(session, target.address), req, d)); }
      return fail(target.code, target.error);
    }
    // The session may have been terminated (a disable's revalidate) while the decision awaited (#807 P3 A7f2, H-B); a
    // refused target's rows are written first, as every deny's is.
    await valid(session, true, tx);
    const { address, scope } = target;
    const refuse = async (code: ErrorCode, message: string, detail: string, extra: ApplicationError["extra"] = {}): Promise<never> => {
      await asyncRowAfterRollback(session, tx, w => repo.bindings.log(w, id, address, "refused", detail));
      return fail(code, message, extra);
    };
    let meta: AliasMetaSet | undefined;
    try {
      meta = m.meta === undefined ? undefined : parseAliasMeta(m.meta);
    } catch (e) {
      if (e instanceof CoreError) return await refuse("bad_request", e.message, e.message);
      throw e;
    }
    const audit = serverAuditSink(repo, tx);
    if (session.holds.includes(address)) {
      // No binding event, and bound_at stays: the session already holds it.
      if (meta) await repo.bindings.setMeta(tx, address, meta, id, audit, authed.user_email);
      return { alias: address, held: [...session.holds] };
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return await refuse("bad_request", why, why);
    }
    // A typo would otherwise create a fresh alias, and the DMs queued for the
    // intended one would never arrive.
    if (m.create === false && !(await repo.aliases.find(tx, address))) {
      const known = closestNames(scope.name, (await repo.aliases.listForScope(tx, scope.scope_kind, scope.scope_ref)).map((a) => a.name).filter((n) => n !== HUMAN_NAME));
      const message = unknownNameError(scope.name, known);
      return await refuse("identity_unknown", message, message, { known });
    }
    // Another session's hold is never taken over. The hosted service clears a stale
    // hosted holder first (#402): one idle past the hosted window ended and freed the
    // alias; a live one refuses the bind.
    const holder = await repo.bindings.holderOf(tx, address);
    if (holder !== null && holder !== id) {
      const who = await describeHolder(hub, tx, holder, authed.user_email);
      return await refuse("alias_held", aliasHeldText(address, who, "bind another name"), who, { holder: who });
    }
    // Another user's tools-only session writing as it holds nothing, but the
    // alias is in use, so it's exclusive all the same (S8, decided).
    const writer = await repo.bindings.userOf(tx, address, authed.user_email);
    if (writer !== null) {
      const why = `another user's session ${writer}`;
      return await refuse("alias_held", aliasHeldText(address, why, "bind another name"), why);
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return await refuse("bad_request", why, why);
    }
    // A new name past its scope's cap (#347); checked here, not in the
    // transaction below, so the refused binding event stays.
    const capped = (await repo.aliases.find(tx, address)) ? null : await aliasCapRefusal(repo, tx, target.scope, hub.aliasScopeCap);
    if (capped) return await refuse("bad_request", capped, capped);

    // No savepoint (#807 P3 A1): a throw here fails the bind, and every caller's transaction rolls back with it.
    await createLazily(hub, tx, authed, target, id);
    await testPauseAsync("bind:alias:created");
    // Again after the create's await: no hold for a session terminated meanwhile.
    await valid(session, true, tx);
    // The take is the authority (D3): the checks above fix the refusal order; one that lost since (on Postgres a
    // concurrent bind) refuses here, naming whoever has it now.
    if (!(await repo.bindings.take(tx, address, id, authed.user_email, now()))) {
      const now_ = await repo.bindings.holderOf(tx, address);
      // On Postgres an unbind or end may commit between the take and these reads, leaving neither: "another session".
      const user = now_ === null ? await repo.bindings.userOf(tx, address, authed.user_email) : null;
      const who = now_ !== null ? await describeHolder(hub, tx, now_, authed.user_email) : user !== null ? `another user's session ${user}` : "another session";
      return await refuse("alias_held", aliasHeldText(address, who, "bind another name"), who, now_ !== null ? { holder: who } : {});
    }
    await repo.bindings.log(tx, id, address, "bound", null);
    if (meta) await repo.bindings.setMeta(tx, address, meta, id, audit, authed.user_email);
    await repo.bindings.touchAlias(tx, address);
    const held = await repo.bindings.holdsOf(tx, id);
    // After the last write's await (R1; the notices below only read): a session closed meanwhile isn't registered
    // again; the throw rolls the bind back.
    stillOpen(session);
    setHolds(hub, session, held);
    // The first bind of a user's session after the bridge died carries the death notice, once.
    const owed = await owedBridgeNotice(repo, tx, authed.user_email);
    const notices = await noticesFor(hub, tx, session.addresses, owed ? [owed] : []);
    return { alias: address, held: [...session.holds], ...(notices.length ? { notices } : {}) };
  }

  // unbind (#284 PR 4 S2): release one hold. Its mail queues and its claims
  // stay with the alias, for its next holder; a board item in flight for it
  // leaves this session (setHolds), so that holder is pushed it. An alias
  // the session doesn't hold answers ok with released: false.
  // `tx`: the body the unbind runs in.
  async function unbind(tx: Tx, session: ApplicationSession, alias: string): Promise<UnbindResult> {
    await valid(session, true, tx);
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it unbinds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it unbinds nothing");
    const id = session.sessionId;
    const p = addressParts(alias);
    if (!p || p.kind === "id" || p.kind === "team") fail("bad_request", `"${alias}" isn't an alias: a name, or scope/name`);
    const address = p.kind === "bare" ? `${session.authed.user_email}/${p.name}` : p.address;
    if (!session.holds.includes(address)) return { alias: address, released: false, held: [...session.holds] };
    // No savepoint (#807 P3 A1): a throw fails the unbind, and its caller's transaction rolls back with it.
    await repo.bindings.release(tx, address, id);
    await repo.bindings.log(tx, id, address, "released", "unbind");
    await repo.bindings.touchAlias(tx, address);
    const left = (await repo.claims.list(tx)).filter((c) => c.holder === address).map((c) => c.key);
    // After the last await (R2), as bind's.
    stillOpen(session);
    setHolds(hub, session, session.holds.filter((a) => a !== address));
    return { alias: address, released: true, held: [...session.holds], ...(left.length ? { left } : {}) };
  }

  const application = {
    ready,
    repo,
    admitHosted,
    // `suggested`: the name the session's checkout suggested (#443), offered first while free.
    hostedCandidates(r: Read, authed: AuthedUser, suggested: string | null): Promise<Candidate[]> { return candidates(hub, r, authed, suggested); },
    // The aliases a hosted root holds, oldest first: alias_holds is their only truth (#451).
    hostedHolds(r: Read, id: string): Promise<string[]> { return repo.bindings.holdsOf(r, id); },
    // `writesAs`: a tools-only root's alias; it holds nothing and binds nothing.
    // Otherwise the session holds `holds`, reads as them and its
    // ID, and writes as the oldest; none held reads and nothing else (readOnly). `row`: the hosted root's
    // place and suggested name (#443), null with no row. `root`: set for a child session (#523),
    // which acts under its root's addresses, never its own ID (not an address), and whose writes
    // carry its ID as `via`.
    // A hosted session is read, then built (#807 P3 A7g): `hostedBuildFacts` reads on `r` (the body's Tx inside one, else the
    // pool), and `hostedBuild` builds and registers synchronously from what it read, reading nothing, so a holder's
    // facts can be read on the committing Tx before COMMIT and its build run in the after-commit notice. `shape` is the
    // build's: the facts carry candidates only for the read-only session that shows them.
    async hostedBuildFacts(r: Read, authed: AuthedUser, id: string, shape: { holds: string[]; writesAs: string | null; suggested: string | null; root: string | null }): Promise<BuildFacts> {
      const own = (await repo.bindings.idRow(r, id))?.principal === authed.user_email;
      const hello = await helloFacts(hub, authed, r);
      const readOnly = shape.holds.length === 0 && shape.writesAs === null;
      return { own, hello, ...(readOnly && !(shape.root !== null && own) ? { candidates: await candidates(hub, r, authed, shape.suggested) } : {}) };
    },
    hostedBuild(authed: AuthedUser, id: string, holds: string[], writesAs: string | null, row: { place: string | null; suggested: string | null } | null, sink: DeliverySink, facts: BuildFacts, push = false, root: string | null = null) {
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
      if (!session.readOnly && facts.own) session.writerId = id;
      if (root !== null && facts.own) session.via = id;
      const shows = session.readOnly && session.via === undefined;
      // Before the session is registered: a throw leaves no holder or route behind (#385 item 9).
      if (shows && !facts.candidates) throw new Error("hosted session facts were read for another shape: no candidates");
      const info: IdentityInfo = {
        identity_full: session.primary,
        ...helloFields(hub, authed, facts.hello),
        ...(shows ? { candidates: facts.candidates } : {}),
      };
      hub.sessions.add(session);
      if (push && holds.length) for (const a of session.addresses) hub.registry.set(a, session);
      return { session, info };
    },
    // Both, on `r`: a build that may await between its reads and its registration.
    async hostedSession(r: Read, authed: AuthedUser, id: string, holds: string[], writesAs: string | null, row: { place: string | null; suggested: string | null } | null, sink: DeliverySink, push = false, root: string | null = null) {
      const facts = await application.hostedBuildFacts(r, authed, id, { holds, writesAs, suggested: row?.suggested ?? null, root });
      return application.hostedBuild(authed, id, holds, writesAs, row, sink, facts, push, root);
    },
    // The root a hosted child acts under (#523), recorded on the child's ids row, where it outlives the
    // child's source row (deleted at the child's end) so a send or mention to the child's ID keeps
    // being refused child_session; null when the ID starts as a root, which makes it an address again.
    async hostedRoot(tx: Tx, id: string, root: string | null) { await repo.hosted.setRoot(tx, id, root); },
    // `harness` comes from the principal's source mapping (#414): peer_list shows it and match:{harness} filters on it.
    // `collided`: where a caller inside a transaction that the refusal rolls back takes the audit row
    // (`hostedCollided`, written after the rollback); without it the row is written here.
    async hostedRegister(tx: Tx, authed: AuthedUser, id: string, harness: string, writesAs: string | null = null, collided?: (why: string) => void, facts?: { model?: string; effort?: string }) {
      const prior = await repo.bindings.idRow(tx, id);
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
        await repo.bindings.registerId(tx, { id, principal: authed.user_email, harness, launcher: false, ...(writesAs === null ? {} : { writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        writeAudit(repo, tx, "id.registered", authed.user_email, id, { harness, ...(writesAs === null ? {} : { writes_as: writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      }
      else {
        // An ID whose row ended (a released child, or a row a restart ended) is live again (#475 item 7a): revocation
        // (aliasUses), identity deletion (aliasUser) and retention only see unended rows, so a holder must have one.
        if (prior.ended_at !== null) {
          const endedAt = prior.ended_at;
          await repo.hosted.reopenId(tx, id);
          writeAudit(repo, tx, "id.reopened", authed.user_email, id, { ended_at: endedAt, harness });
        }
        await repo.bindings.touchId(tx, id);
        // A new ownership of the same ID reports its own model and effort: what the last one reported is stale.
        const changed = await repo.bindings.setIdFacts(tx, id, { model: facts?.model ?? null, effort: facts?.effort ?? null });
        if (changed) writeAudit(repo, tx, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "ownership" });
        // An ownership's end clears the row's writes_as (the store's end), so a new ownership of the same ID restates it.
        if (writesAs !== null) await repo.hosted.restateWritesAs(tx, id, writesAs);
      }
    },
    // A root's request declared a launcher (#473, #520): the flag is the ownership's (`ids.launcher`; its end clears
    // it), turned on by whichever of its requests declares first and audited as a local session's is, once.
    // `detail`: which ownership and client turned it on, now that a later request can (#520).
    async hostedDeclareLauncher(tx: Tx, authed: AuthedUser, id: string, detail: { ownership: number; client_id: string }) {
      if (await repo.hosted.declareLauncher(tx, id)) writeAudit(repo, tx, "handle.launcher_set", authed.user_email, id, { on: true, ...detail });
    },
    // The latest model and effort a hosted session's request reports (#364): written, and audited with the
    // before and after, only when one changed. Absent fields keep the stored value; an empty one clears it (#558).
    async hostedFacts(tx: Tx, authed: AuthedUser, id: string, facts: { model?: string; effort?: string }) {
      const changed = await repo.bindings.setIdFacts(tx, id, facts);
      if (changed) writeAudit(repo, tx, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "request" });
    },
    // A tools-only declaration's alias, resolved and checked: a name the
    // principal may act in, never one another user's session uses (S7, S8); it may share the
    // alias with a holder. create: the first request makes the alias lazily.
    // `refused`: as `collided` above, for the refused binding row (`hostedRefused`).
    // `later`: where a policy refusal's decision row goes, for the same reason (hosted's `later`).
    // `tx`: the body the request's row is written in.
    async hostedWritesAs(tx: Tx, authed: AuthedUser, id: string, raw: string, create = false, refused?: (address: string, detail: string) => void, later?: (write: RefusalRow) => void): Promise<string> {
      const note = async (address: string, detail: string) => { if (refused) refused(address, detail); else await repo.bindings.log(tx, id, address, "refused", detail); };
      const target = await bindTarget(hub, tx, authed, raw);
      if ("error" in target) {
        if (target.address) await note(target.address, target.error);
        if (target.authz) {
          const { req, d } = target.authz;
          const row: SyncRow = w => recordDecision(repo, w, { user: authed.user_email, address: target.address, session: id }, req, d);
          if (later) later(row); else row(tx);
        }
        return fail(target.code, target.error);
      }
      const other = await repo.bindings.userOf(tx, target.address, authed.user_email);
      if (other) {
        const why = `another user's session ${other}`;
        await note(target.address, why);
        return fail("alias_held", aliasHeldText(target.address, why, "write as another name"));
      }
      if (create) {
        const capped = (await repo.aliases.find(tx, target.address)) ? null : await aliasCapRefusal(repo, tx, target.scope, hub.aliasScopeCap);
        if (capped) {
          await note(target.address, capped);
          return fail("bad_request", capped);
        }
        await createLazily(hub, tx, authed, target, id);
      }
      return target.address;
    },
    // The address a bind of `alias` would take, or undefined when bind will refuse it
    // (bindNow says why): the hosted service clears a stale contender for it first.
    async bindAddress(r: Read, authed: AuthedUser, alias: string): Promise<string | undefined> {
      const target = await bindTarget(hub, r, authed, alias);
      return "error" in target ? undefined : target.address;
    },
    aliasHolderId(r: Read, address: string): Promise<string | null> { return repo.bindings.holderOf(r, address); },
    // Every session's holds, oldest first, for the hosted sweep and reconcile, on `h` (the full reconcile's body Tx).
    async holdsByOwner(h: Read): Promise<Map<string, string[]>> {
      const byOwner = new Map<string, string[]>();
      for (const r of await repo.hosted.holds(h)) {
        const list = byOwner.get(r.id);
        if (list) list.push(r.address); else byOwner.set(r.id, [r.address]);
      }
      return byOwner;
    },
    // Whether the session's ownership declared a launcher (#473, #520): what its instruction text follows, since the
    // stored flag, not the current request's `_meta`, decides whether it receives delegation requests.
    hostedLauncher(id: string): Promise<boolean> { return repo.hosted.launcher(repo.read, id); },
    hostedPlace(tx: Tx, id: string, place: string | null): Promise<void> { return repo.bindings.setPlace(tx, id, place); },
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman,
    bindNow,
    hostedRefused(tx: Tx, id: string, address: string, detail: string): Promise<void> { return repo.bindings.log(tx, id, address, "refused", detail); },
    hostedCollided(h: Read, authed: AuthedUser, id: string, why: string) { writeAudit(repo, h, "id.collision", authed.user_email, id, { why }); },
    unbind,
    close,
    revalidateSession: valid,
    revalidateNow: validNow,
    // Everything owed to a push session, after its hello's answer: direct
    // messages and board items for `addresses` (every address by default; a
    // bind's alias after its answer).
    async replay(session: ApplicationSession, addresses?: string[]) {
      await valid(session, true);
      if (session.readOnly || !session.push) return;
      // Called after the hello's or bind's commit, outside any body, so the drain runs now; awaited, so the replay
      // answers once it's delivered (#807 P3 A6a). A failure is logged, as a commit effect's is.
      try {
        await drainDirect(hub, session, addresses ?? session.addresses);
        // Closed while the drain awaited (an unlink, a revoke): nothing more is owed.
        if (!session.active) return;
        await valid(session, true);
        await drainBoards(session, hub, true);
      } catch (error) { console.error("postcommit effect failed", error); }
    },
    async send(
      tx: Tx,
      session: ApplicationSession,
      recipient: string,
      body: string,
      options: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean; as?: string } = {},
    ) {
      await valid(session, false, tx);
      return handleSend(hub, tx, session, recipient, body, options.parent_id ?? null, options.pending === true, options.attachment_ids, options.resend === true, options.as);
    },
    async delegate(tx: Tx, session: ApplicationSession, request: Omit<DelegateRequest, "type" | "req_id">) {
      await valid(session, false, tx);
      return handleDelegate(hub, tx, session, request);
    },
    async history(r: Read, session: ApplicationSession, options: { peer?: string; limit?: number; before_id?: number } = {}) {
      await valid(session, false, r);
      return handleHistory(hub, r, session, options.peer, options.limit, options.before_id);
    },
    async thread(r: Read, session: ApplicationSession, id: number) {
      await valid(session, false, r);
      return handleThread(r, session, id, repo);
    },
    async inbox(r: Read, session: ApplicationSession, days?: number) {
      await valid(session, false, r);
      childState(session, "dm_inbox");
      return handleInbox(hub, r, session, days);
    },
    // Reads retain durable cursors; pendingOf still cleans inaccessible outbox rows.
    async pending(r: Read, session: ApplicationSession, limit = 100): Promise<DeliveryEvent[]> {
      await valid(session, false, r);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("bad_request", "invalid pending limit");
      const streams = await Promise.all(session.addresses.map(async (a) => ({ type: "direct" as const, ref: a, since: await repo.cursors.get(r, a, "direct", a) })));
      const messages = (await repo.messages.unreadSince(r, streams)).slice(0, limit);
      const seen = new Set<string>();
      const all: Pending[] = [];
      for (const a of session.addresses) {
        for (const item of await pendingOf(repo, hub.access, r, a, true, lostAck(hub, r, a))) {
          const key = pendingKey(refOf(item));
          if (!seen.has(key)) { seen.add(key); all.push(item); }
        }
      }
      const boards = all.slice(0, limit - messages.length);
      // A digest's latest post never wakes, so it carries other_user only.
      const marks = await writerMarks(repo, r, session, messages.map(m => m.id), boards.map(i => (i.kind === "push" ? i.post : i.latest).id));
      return [
        ...messages.map((m): DeliveryEvent => ({ kind: "direct", message: { ...showMessage(m), ...marks.message(m.id) } })),
        ...boards.map((item): DeliveryEvent => ({ kind: "board", item: item.kind === "push"
          ? { ...item, post: { ...item.post, ...marks.post(item.post.id) } }
          : { ...item, latest: { ...item.latest, ...marks.post(item.latest.id, false) } } })),
      ];
    },
    async boardCatalog(r: Read, session: ApplicationSession, after?: string) {
      await valid(session, true, r);
      return boardCatalog(repo, hub.access, r, session.readOnly ? userOf(session) : session.primary, after);
    },
    async boardSnapshot(r: Read, session: ApplicationSession, board: string, options: SnapshotOptions = {}) {
      await valid(session, true, r);
      // A resource read is a read like board_read, and carries its marks (#825).
      const snap = await boardSnapshot(repo, hub.access, r, session.readOnly ? userOf(session) : session.addresses, board, options);
      const marks = await writerMarks(repo, r, session, [], snap.posts.map((p) => p.id));
      return { ...snap, posts: snap.posts.map((p) => ({ ...p, ...marks.post(p.id) })) };
    },
    // O(1), for the metrics scrape (#805).
    get observerCount() { return observers.size; },
    // Keys in the observer indexes: a board or session with no observers left has none (#831).
    get observerIndexKeys() { return { boards: observersByBoard.size, sessions: observersBySession.size }; },
    observeBoard(session: ApplicationSession, boardInput: string, hooks: BoardObserver): () => void {
      validNow(session);
      const board = normalizeBoard(boardInput);
      // Snapshot performs the same concealed access check as content reads.
      snapshot(repo.coreOn(repo.read), reader(repo.read, session, board), board, { limit: 1 });
      if (observers.size >= (opts.observerCap ?? DEFAULT_HOSTED_CAPS.watches.global)) { countRefusal("board_observer"); fail("bad_request", "board observer capacity reached"); }
      const observer = { session, board, hooks };
      addObserver(observer);
      return () => removeObserver(observer);
    },
    canReceiveBoard(r: Read, session: ApplicationSession, board: string) {
      validNow(session);
      const core = repo.coreOn(r);
      return session.addresses.some((a) => canSeeBoard(core, a, board));
    },
    // handed: false is a give-up (Slack refused the message): the cursor
    // moves so it isn't retried, but nothing reached the harness to stamp.
    async receiptDirect(tx: Tx, session: ApplicationSession, ids: number[], opts: { handed: boolean } = { handed: true }) {
      await valid(session, false, tx);
      await handleAck(tx, session, ids, repo, opts.handed ? now() : null);
    },
    // A ref carries no handle: the item was sent for one of this session's
    // addresses, and acknowledging is a no-op on one with no such row, so
    // each address acks it.
    async receiptBoards(tx: Tx, session: ApplicationSession, refs: PendingRef[]) {
      await valid(session, false, tx);
      for (const r of refs) {
        for (const a of session.addresses) await repo.boards.acknowledge(tx, a, r);
        tx.afterCommit(() => {
          session.inflight.delete(pendingKey(r));
          session.boardDrain?.acked.add(ackKey(r));
        });
      }
    },
    // Acked as the address the row names (S8): receivedUnacked and
    // sentPending match a.reader = m.recipient, or m.sender.
    async acknowledgeDm(tx: Tx, session: ApplicationSession, id: number) {
      await valid(session, false, tx);
      childState(session, "dm_ack");
      const m = await repo.messages.getById(tx, id), mine = session.addresses;
      const reader = !m || m.recipient_type !== "user" ? null
        : mine.includes(m.recipient) ? m.recipient
        : m.pending && mine.includes(m.sender) ? m.sender
        : null;
      if (!m || reader === null) fail("not_found", `no message ${id} to you or pending from you; dm_inbox lists them`);
      await repo.messages.ack(tx, reader, m.id);
    },
    async retract(tx: Tx, session: ApplicationSession, id: number) {
      await valid(session, false, tx);
      return await handleRetract(hub, tx, session, id);
    },
    async call(tx: Tx, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      await valid(session, UNBOUND_READS.has(tool), tx);
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
    // Its promise settles once the alias recheck is written (a failure there, or a user's read, is logged, not
    // rejected). The users reads await, on the auth cache (#807 P3 A7u2): disconnectUser walks the sessions as they
    // stand after them; one user's failed read skips that user only, and the next tick retries it.
    async revalidate(): Promise<void> {
      await Promise.all([...observersByBoard].map(([board, set]) => liveObservers(board, [...set])));
      const ids = [...new Set([...hub.sessions].filter(s => !s.human).map(s => s.authed.user_id))];
      const disabled = await Promise.all(ids.map(id => repo.users.isDisabled(repo.read, id).catch(error => {
        console.error("[grayboard] revalidate: user read failed:", error);
        return false;
      })));
      for (const [i, id] of ids.entries()) if (disabled[i]) application.disconnectUser(id);
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
  const p = userOf(session);
  return (board) => principalCanSee(repo, p, board);
}
const userOf = (session: ApplicationSession): Principal => ({ kind: "user", name: session.authed.user_email });

// Where a name was last used: its session's cwd, else its place.
function whereSeen(seen: { cwd: string | null; place: string | null } | undefined): string | null {
  return !seen ? null : seen.cwd ? describeLocation(seen.cwd) : seen.place;
}

// A hosted unbound session's candidates: the user's own names nobody holds. `r`: the caller's body Tx inside one,
// else the pool, where a commit may land between the awaited reads: candidates are hints, so they needn't be one
// instant, and the synchronous reads all follow the last await.
async function candidates(hub: Hub, r: Read, authed: AuthedUser, suggestedInput: string | null): Promise<Candidate[]> {
  const { repo } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const all = (await repo.aliases.listForScope(r, "person", authed.user_email)).map((i) => i.name);
  const seen = await repo.aliases.seen(r, all.map(full));
  const held = await repo.bindings.holdersOf(r, [...all, ...(suggestedInput !== null ? [suggestedInput] : [])].map(full));
  const free = (n: string) => n !== HUMAN_NAME && !held.has(full(n));
  const names = all.filter(free);
  const queued = await repo.messages.queuedTo(r, names.map(full));
  const claims = new Map<string, number>();
  for (const c of await repo.claims.list(r)) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
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
async function unboundPeers(hub: Hub, r: Read, session: ApplicationSession): Promise<UnboundPeer[]> {
  const user = session.authed.user_id;
  // Every await comes before the in-memory connection list is read (#807 P3 A7h1): the roots, then their holds and
  // statuses (B1a; statuses for every root, a superset of those listed).
  const own = await hub.repo.hosted.roots(r, user);
  const ownIds = own.map((row) => row.session_id);
  const holds = await hub.repo.bindings.holdsOfMany(r, ownIds);
  const statuses = await hub.repo.bindings.idStatuses(r, ownIds);
  // Per live session ID: whether any of its connections is listed (#489: a call adds its own beside others).
  const live = new Map<string, boolean>();
  for (const c of hub.sessions) {
    if (c.transport !== "hosted" || c.authed.user_id !== user) continue;
    live.set(c.sessionId, (live.get(c.sessionId) ?? false) || c.listed);
  }
  const roots = own.filter((row) =>
    row.writes_as === null && live.get(row.session_id) !== false && holds.get(row.session_id)!.length === 0);
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
async function resolvePeer(repo: Repo, r: Read, from: string, input: string, viewer: string = from): Promise<Peer> {
  const p = addressParts(input);
  if (!p) fail("bad_request", `invalid address "${input}": expected "id:…", "scope/name" or "team:name"`);
  if (p.kind !== "bare") return p;
  const scope = await ownScopeOn(repo, r, from);
  const own = scope ? addressParts(`${scope}/${p.name}`) : null;
  if (own?.kind === "alias" && (await repo.aliases.find(r, own.address))) return own;
  if (p.name === HUMAN_NAME) {
    // A bare "human" is always your own (addressing.ts HUMAN_NAME), never the
    // one alias anyone has with the name: another user's is reached by its
    // full handle, as peer_list shows it.
    fail("not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
  }
  const vp = await repo.principals.of(r, viewer);
  // One decision per scope.
  const sees = new Map<string, boolean>();
  const all: string[] = [];
  for (const a of (await repo.aliases.findAllByName(r, p.name))) {
    if (vp === null) break;
    const key = JSON.stringify([a.scope_kind, a.scope_ref]);
    let ok = sees.get(key);
    if (ok === undefined) sees.set(key, ok = (await authorize(repo, r, {}, { verb: "alias.see", principal: vp, scope: { scope_kind: a.scope_kind, scope_ref: a.scope_ref } })).allow);
    if (ok) all.push(a.address);
  }
  all.sort();
  const which = all.length ? `"${p.name}" isn't in your scope; name it in full: ${all.join(", ")}` : `no identity is named "${p.name}"`;
  return fail("not_found", `${which}; peer_list shows exact handles`);
}

// Whether `address` is a team's alias that `viewer` (a session ID, else the acting address) may not see exists: to
// anyone outside the team its names read as missing (alias.see, #348), for mail too (#1014). Only a team's: a
// service's agents take mail from anyone in the org (vision.md principle 9).
async function teamAliasHidden(repo: Repo, r: Read, viewer: string, address: string): Promise<boolean> {
  const a = await repo.aliases.find(r, address);
  if (a?.scope_kind !== "team" || a.scope_ref === null) return false;
  const vp = await repo.principals.of(r, viewer);
  return vp === null || !(await authorize(repo, r, {}, { verb: "alias.see", principal: vp, scope: { scope_kind: "team", scope_ref: a.scope_ref } })).allow;
}

// A send checked and resolved, ready to write: `from` the address it goes
// out as, `to` the recipient's full handle, `digests` its files' blob
// digests in call order.
type PreparedSend = { from: string; to: string; body: string; parentId: number | null; pending: boolean; ids: number[]; digests: string[] };

// The address a send goes out as: `as` when given (#284 S3), else for a
// reply the held alias its parent reached or was sent as (S4), else the
// primary.
async function sendAs(hub: Hub, r: Read, session: ApplicationSession, as: string | undefined, parentId: number | null): Promise<string> {
  if (as !== undefined) {
    try {
      return actingAs(as, asAddresses(session), session.authed.user_email);
    } catch (e) {
      if (e instanceof CoreError) fail("bad_request", e.message);
      throw e;
    }
  }
  const parent = parentId === null ? undefined : await hub.repo.messages.getById(r, parentId);
  return (parent && participant(parent, session.addresses) ? replySender(parent, session.holds) : null) ?? session.primary;
}

// Checks a send and resolves its recipient, writing nothing; throws
// ApplicationError. Its uploads may be any of the session's addresses' (S5).
// `r`: the send's body. A policy refusal's row, when no `afterRollback` takes it, runs on that body (its audit
// write is still ambient until the audit slice).
async function prepareSend(
  hub: Hub, r: Tx, session: ApplicationSession, from: string, recipientStr: string, body: string, parentId: number | null, pending: boolean, attachmentIdsRaw: unknown,
): Promise<PreparedSend> {
  const { repo } = hub;
  let ids: number[];
  let digests: string[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
    digests = await repo.attachments.unsentDigests(r, ids, uploaderOf(session));
  } catch (e) {
    if (e instanceof CoreError) fail("bad_request", e.message);
    throw e;
  }

  const to = await resolvePeer(repo, r, from, recipientStr, session.sessionId || from);
  if (to.kind === "team") fail("bad_request", `${to.address} isn't a person; to reach a team, board_post to its board #${to.name}`);
  // An ID's deliverability is checked in the write's transaction (writeSend).
  // A team's alias the sender may not see reads as one nobody has (#1014), unless this replies in a thread with it:
  // a handle that wrote to you is one you may answer.
  // A named function, not an arrow: its stack frame names it (tests/integration/alias_visibility.test.ts finds it so).
  async function replyingTo(address: string) {
    if (parentId === null) return false;
    const parent = await repo.messages.getById(r, parentId);
    return participant(parent, session.addresses) && replyPeer(parent, session.addresses) === address;
  }
  if (to.kind === "alias" && (!(await repo.aliases.find(r, to.address)) || ((await teamAliasHidden(repo, r, session.sessionId || from, to.address)) && !(await replyingTo(to.address))))) {
    fail("not_found", `identity "${to.address}" not found; peer_list shows exact handles`);
  }
  const req: AuthzRequest = { verb: "msg.send", from, to: to.address };
  const decision = await authorize(repo, r, { humanReach: hub.humanReach }, req);
  if (!decision.allow) {
    rowAfterRollback(session, r, w => recordDecision(repo, w, sessionActor(session, from), req, decision));
    fail(decision.code, decision.reason);
  }

  if (parentId !== null) {
    const parent = await repo.messages.getById(r, parentId);
    if (!participant(parent, session.addresses)) fail("not_found", `parent_id ${parentId} is not a message you sent or received`);
    const peer = replyPeer(parent, session.addresses);
    if (to.address !== peer) fail("bad_request", replyPeerError(parentId, peer));
    const asError = replySenderError(parent, peer, from);
    if (asError !== null) fail("bad_request", asError);
  }
  return { from, to: to.address, body, parentId, pending, ids, digests };
}

// Writes the message and builds its result. Runs inside the caller's
// transaction; whether the recipient is live is read here, inside the
// queued body. Binds change the registry only in queued bodies or afterCommit (D4), but a session's close
// (a request's end, the bridge's detach, a revalidate's terminate) changes it at once, outside the queue: so the
// recipient is read again after the wake decision's await, and the result says what deliverSend would do then.
async function writeSend(hub: Hub, tx: Tx, session: ApplicationSession, p: PreparedSend): Promise<Written<SendResult> & { msg: MessageRow }> {
  const { repo, registry } = hub;
  let msg: MessageRow;
  try {
    if (addressParts(p.to)?.kind === "id") {
      const why = await repo.sessionEnd.refusal(tx, p.to);
      if (why) throw why;
    }
    msg = await repo.messages.insert(tx, p.from, "user", p.to, p.body, p.parentId, p.pending, { ids: p.ids, uploader: uploaderOf(session) }, session.writerId ?? null, session.via ?? null, session.authed.user_email);
  } catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    throw e;
  }
  const f = {
    ...(p.pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}),
    // Named whenever it isn't the primary (S4).
    ...(p.from !== session.primary ? { sent_as: p.from } : {}),
  };
  const seen = (await repo.bindings.lastSeen(tx, [p.to])).get(p.to) ?? null;
  const decided = await unwoken(repo, tx, session, registry.get(p.to), p.to);
  await testPauseAsync("send:wake:decided");
  // Read after the await (#807 P3 A7f2, H-A): a wake note about a holder that closed meanwhile is dropped.
  const live = registry.get(p.to);
  // Snapshot with `live`: wakeUser may await an alias read (#807 P3 A7f3), and the payload must describe one instant.
  const liveActive = live?.active;
  const wake = (await wakeUser(repo, tx, live, p.to)) === decided.user ? decided.fields : {};
  const payload: SendResult = liveActive
    ? { message_id: msg.id, delivered_now: true, ...f, ...wake }
    : {
        message_id: msg.id,
        delivered_now: false,
        ...f,
        ...(seen ? { recipient_last_seen: `${age(hub.now() - seen)} ago` } : {}),
        undelivered_from_you: (await repo.messages.undeliveredFrom(tx, session.addresses)).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
        ...wake,
      };
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, tx, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: msg.sender, message_id: msg.id, recipient: msg.recipient });
  }
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// The user a wake is judged against: `live`'s, else a person alias's; undefined says nothing.
async function wakeUser(repo: Repo, r: Read, live: ApplicationSession | undefined, to: string): Promise<string | undefined> {
  if (live?.human || to.endsWith(`/${HUMAN_NAME}`)) return undefined;
  if (live) return live.authed.user_email;
  const a = await repo.aliases.find(r, to);
  return a?.scope_kind === "person" ? a.scope_ref ?? undefined : undefined;
}

// `user`: whom the decision was about, so the caller can drop it when the holder changed during the await.
// Security audit F-03 (#806): `wakes: false` and why, when the recipient is
// known to be another user whom no grant lets this sender wake, so the sender
// doesn't wait on an agent that won't act. Known: the user of the session
// holding the address now, else a person alias's user; a team or service
// alias or an ID with no live holder says nothing, as does a human (a person
// reads it; msg.send already decided reach). Each pull decides again
// (pending()), so this reflects the grant at send time, not a promise.
async function unwoken(repo: Repo, r: Read, session: ApplicationSession, live: ApplicationSession | undefined, to: string): Promise<{ user: string | undefined; fields: { wakes?: false; wake_note?: string } }> {
  const toUser = await wakeUser(repo, r, live, to);
  if (toUser === undefined) return { user: undefined, fields: {} };
  const decision = await authorize(repo, r, {}, { verb: "msg.wake", from_user: session.authed.user_email, to_user: toUser });
  if (decision.allow) return { user: toUser, fields: {} };
  // Named only when the address already names them (a person alias): a team
  // alias's or an ID's holder is a handle, not a user (security audit F-12).
  const whose = to.startsWith(`${toUser}/`) ? `${toUser}'s agent` : "its holder (another user's agent)";
  return { user: toUser, fields: { wakes: false, wake_note: `Delivered as mail: ${whose} won't act on it until its user does (no shared collaborative team; \`grayboard team policy\`).` } };
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
  hub: Hub, tx: Tx, session: ApplicationSession, tool: DedupTool, sender: string, args: Record<string, unknown>, resend: boolean, uploads: number[], write: (sp: Tx) => W | Promise<W>,
  recheck?: (stored: W["payload"], sp: Tx) => void | Promise<void>,
): Promise<DedupOutcome<W>> {
  const { repo } = hub;
  if (session.human) return { fresh: await tx.savepoint(write) };
  const { authed } = session;
  const out = await dedupWrite(repo, tx, hub.now(), {
    tool, session: session.sessionId, sender, actor: authed.user_email, transport: session.transport, args, resend,
  }, write, async sp => {
    for (const row of await repo.attachments.dropUnsent(sp, uploads, uploaderOf(session))) {
      writeAudit(repo, sp, "attachment.released", authed.user_email, `attachment:${row.id}`, {
        identity: row.uploader, filename: row.filename, size: row.size, sha256: row.sha256, reason: "replayed",
      });
    }
  }, recheck);
  if ("replay" in out && uploads.length > 0) tx.afterCommit(async () => { await sweepStoredBlobs(repo); });
  return out;
}

async function handleSend(
  hub: Hub, tx: Tx, session: ApplicationSession, recipient: string, body: string, parentId: number | null, pending: boolean, ids: unknown, resend: boolean, as: string | undefined,
): Promise<SendResult> {
  const p = await prepareSend(hub, tx, session, await sendAs(hub, tx, session, as, parentId), recipient, body, parentId, pending, ids);
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
      to = (await resolvePeer(repo, tx, session.primary, m.to, session.sessionId || session.primary)).address;
    } catch (e) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      if (e instanceof ApplicationError) refused({ reason: e.message, to: m.to });
      throw e;
    }
  }
  const online = (h: string) => hub.registry.get(h)?.active === true;
  // The human fallback's reachability is the server's own knowledge: the
  // bridge is running and this user is linked (#191).
  // The link is read on `h` before core's synchronous decision runs (#807 P3 A7i): `h` is the dedup
  // savepoint's Tx where the call runs inside it (the caller's refuses statements while it's open). Whether the bridge
  // runs is in memory, read when core asks.
  const humanReachable = async (h: Tx) => { const linked = !!(await repo.slack.linkFor(h, authed.user_id)); return () => hub.slackRunning() && linked; };
  const args = { to: to ?? null, persona: m.persona, task: m.task, context: m.context ?? null };
  // Where a refused send was headed, for its audit row.
  let picked: string | undefined;
  let out: DedupOutcome<Written<DelegateResult> & { msg: MessageRow }>;
  // A launcher's open requests: the same window dm_inbox lists by default (#252).
  const since = hub.now() - inboxDays(undefined) * 86_400_000;
  // The limiter's streak rows and the policy denies' decision rows from this
  // call: written inside the dedup transaction they'd roll back with it, so
  // they're written after it. A refusal's decision rows go to the session's
  // afterRollback, which every queued caller sets (hosted run, Slack inWrite).
  const rows: SyncRow[] = [];
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
  // Decided before core asks (#807 P3 A7f2): core's decision is synchronous and calls `reach` only for the
  // explicit `to`, which is resolved before it runs. The deny row is returned, not written, so it's emitted only when
  // core asks (after its own field checks), as before.
  type Reach = { result: DelegateReach; row?: SyncRow };
  const reachDecision = async (h: Tx, to: string, recheck = false): Promise<Reach> => {
    // A team's alias this session may not see reads as one nobody has (#1014), before any grant is judged. A replay
    // named it while it could: it says why it can't be replayed, not that the name never connected.
    if (await teamAliasHidden(repo, h, session.sessionId || session.primary, to)) {
      return { result: { refused: recheck ? `"${to}" is a team's alias this session may no longer see, so the first delegation can't be replayed` : neverConnected(to) } };
    }
    // On a replay, a person's human is that person's, though no session holds it (the Slack bridge's connection has
    // none), so a human-fallback delegation is rechecked rather than refused as unheld (#1030). A fresh call naming a
    // human keeps reading as own, and routing refuses it as no launcher.
    const t = recheck ? addressParts(to) : null;
    const owner = t?.kind === "alias" && t.name === HUMAN_NAME && t.scopeKind === "person" ? t.scope : await repo.delegation.addressUser(h, to);
    if (owner === undefined && recheck) return { result: { refused: `no session holds "${to}" now, so the first delegation's grant can't be rechecked; call again to delegate afresh (#256)` } };
    if (owner === undefined || owner === authed.user_email) return { result: { ok: "own" } };
    if (owner === null) return { result: { refused: crossUserRefusal(to) } };
    const req: AuthzRequest = { verb: "delegate.to", from_user: authed.user_email, to_user: owner };
    const decision = await authorize(repo, h, {}, req);
    if (decision.allow) return { result: { ok: "granted" } };
    return { result: { refused: crossUserRefusal(to) }, row: w => recordDecision(repo, w, sessionActor(session, session.primary), req, decision, { launcher: to }) };
  };
  const emit = (h: Tx, r: Reach): DelegateReach => {
    if (r.row) rowAfterRollback(session, h, r.row);
    return r.result;
  };
  try {
    out = await writeOnce(hub, tx, session, "delegate", session.primary, args, m.resend === true, [], async sp => {
      // Checked and spent in here, so a dedup replay is neither charged nor
      // refused; resend writes again, so it's charged (#252).
      // The user's bucket, not the address's (#252): the row names the session that tripped it.
      const t = hub.delegateLimiter.check(authed.user_email, { requester: session.primary, session_id: session.sessionId, ...byChild });
      if (!t.ok) fail("rate_limited", delegateThrottled(hub.delegateLimit, t.retryAfterMs, "your user"), { retry_after_ms: t.retryAfterMs });
      const pre = to === undefined ? undefined : await reachDecision(sp, to);
      const reach = (t: string): DelegateReach => {
        if (pre === undefined || t !== to) throw new Error(`delegate: reach for an address not decided first ("${t}")`);
        return emit(sp, pre);
      };
      // What core's synchronous decision asks of the store, read first on the savepoint (#807 P3 B4b): the named
      // target's facts, or every launcher's user and open count.
      const facts = await repo.delegation.facts(sp, { to, since });
      const d = resolveDelegationWith(facts, session.primary, authed.user_email, { ...m, to }, online, await humanReachable(sp), (h) => session.addresses.includes(h), facts.open, hub.delegateOpenCap, reach);
      picked = d.to;
      const w = await writeSend(hub, sp, session, await prepareSend(hub, sp, session, session.primary, d.to, d.body, null, true, undefined));
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, sp, "delegation.requested", authed.user_email, d.to, {
        requester: session.primary,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
        ...byChild,
      });
      hub.delegateLimiter.spend(authed.user_email);
      return { payload, ref: w.ref, msg: w.msg };
    }, async (stored, sp) => {
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
      const r = emit(sp, await reachDecision(sp, stored.to, true));
      if ("refused" in r) throw new CoreError(r.refused + hint);
      const req: AuthzRequest = { verb: "msg.send", from: session.primary, to: stored.to };
      const decision = await authorize(repo, sp, { humanReach: hub.humanReach }, req);
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
  const m = await repo.messages.getById(tx, id);
  if (!m) {
    const done = await repo.audit.last(tx, "message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by !== undefined && mine.includes(by)) return { note: alreadyRetracted(done.at) };
  }
  // Retracted as the address that sent it (S8).
  if (!m || m.recipient_type !== "user" || !mine.includes(m.sender)) return fail("not_found", retractRefusal.notYours(id));
  if (m.delivered_at !== null || registry.get(m.recipient)?.active || (await repo.cursors.directFor(tx, m.recipient)) >= m.id) return fail("bad_request", retractRefusal.reached(id, m.recipient));
  if (!(await repo.messages.retract(tx, m.sender, id, { actor: session.authed.user_email, session: session.sessionId }))) return fail("bad_request", retractRefusal.replied(id));
  tx.afterCommit(async () => { await sweepStoredBlobs(repo); });
  return {};
}

async function handleCall(hub: Hub, tx: Tx, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): Promise<unknown> {
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
    ...(tool === "peer_list" ? { unbound: await unboundPeers(hub, tx, session) } : {}),
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
    const marks = await writerMarks(hub.repo, tx, session, [], r.posts.map((p) => p.id));
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
    const fp = { board: normalizeBoard(postArgs.board), body: postArgs.body, parent_id: parentId, attachments: await repo.attachments.unsentDigests(tx, ids, uploaderOf(session)) };
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
// Decided up front (#807 P3 A7f2), one await per (verb, writer): msg.wake for every foreign writer, delegate.to for
// the writers of delegation requests; the marks are then read synchronously.
async function writerMarks(repo: Repo, r: Read, session: ApplicationSession, messageIds: number[], postIds: number[]) {
  const writers = await repo.messages.writerUsers(r, messageIds, postIds);
  const me = session.authed.user_email;
  const decided = new Map<string, boolean>();
  const settle = async (verb: "msg.wake" | "delegate.to", user: string) => {
    const key = `${verb} ${user}`;
    if (!decided.has(key)) decided.set(key, (await authorize(repo, r, {}, { verb, from_user: user, to_user: me })).allow);
  };
  const may = (verb: "msg.wake" | "delegate.to", user: string) => decided.get(`${verb} ${user}`)!;
  const foreign = messageIds.filter((id) => { const u = writers.messages.get(id); return u !== undefined && u !== me; });
  const delegations = foreign.length ? await repo.messages.delegationIds(r, foreign) : new Set<number>();
  for (const u of new Set([...writers.messages.values(), ...writers.posts.values()])) if (u !== undefined && u !== me) await settle("msg.wake", u);
  for (const id of delegations) await settle("delegate.to", writers.messages.get(id)!);
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
  const peerFull = peer ? (await resolvePeer(repo, r, session.primary, peer, session.sessionId || session.primary)).address : undefined;
  const mine = session.addresses;
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const rows = (await repo.messages.history(r, mine, peerFull, lim, beforeId)).reverse();
  const sent = (m: MessageRow) => mine.includes(m.sender) && m.recipient_type === "user" && !mine.includes(m.recipient);
  // The cursor of each recipient a sent, unstamped message needs, read once before the rows are shaped (#807 P3 A6a).
  const unstamped = [...new Set(rows.filter((m) => sent(m) && m.delivered_at === null).map((m) => m.recipient))];
  const cursors = new Map(await Promise.all(unstamped.map(async (to) => [to, await repo.cursors.directFor(r, to)] as const)));
  const messages = rows.map((m) =>
    sent(m) ? { ...m, delivered: m.delivered_at !== null || cursors.get(m.recipient)! >= m.id } : m,
  );
  const marks = await writerMarks(repo, r, session, messages.map((m) => m.id), []);
  return messages.map((m) => ({ ...showMessage(m), ...marks.message(m.id) }));
}

async function handleInbox(hub: Hub, r: Read, session: ApplicationSession, days: number | undefined): Promise<InboxResult> {
  const { repo } = hub;
  const mine = session.addresses;
  let since: number;
  try {
    since = hub.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const received = await repo.messages.receivedUnacked(r, mine, since);
  const owed = unanswered(mine, received, await threadsOf(repo, r, received), session.primary);
  const sentPending = await repo.messages.sentPending(r, mine, hub.now() - PROMISE_DAYS * 86_400_000);
  const promises = promised(mine, sentPending, await threadsOf(repo, r, sentPending));
  const undelivered = await repo.messages.undeliveredFrom(r, mine);
  const lastSeenAt = await repo.bindings.lastSeen(r, undelivered.map((u) => u.recipient));
  const queued = undelivered.map((u) => {
    const seen = lastSeenAt.get(u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(hub.now() - seen)} ago` } : {}) };
  });
  const marks = await writerMarks(repo, r, session, owed.map((m) => m.id), []);
  return {
    unanswered: owed.map((m) => ({ ...m, ...marks.message(m.id) })),
    ...(promises.length ? { promised: promises } : {}),
    ...(queued.length ? { undelivered_from_you: queued } : {}),
  };
}

// The threads of `rows`, read before the shared inbox helpers ask for them synchronously (#807 P3 A7i): one read per
// thread, as their own memo makes, since a thread's members share the rows read for the first of them.
async function threadsOf(repo: Repo, r: Read, rows: MessageRow[]): Promise<(id: number) => MessageRow[]> {
  const byId = new Map<number, MessageRow[]>();
  for (const m of rows) {
    if (byId.has(m.id)) continue;
    const t = await repo.messages.thread(r, m.id);
    for (const x of t) byId.set(x.id, t);
  }
  return (id) => {
    const t = byId.get(id);
    if (t === undefined) throw new Error(`threadsOf: message ${id}'s thread was not read first`);
    return t;
  };
}

async function handleThread(r: Read, session: ApplicationSession, messageId: number, repo: Repo): Promise<DirectMessage[]> {
  const mine = (m: MessageRow | undefined): m is MessageRow => participant(m, session.addresses);
  if (!mine(await repo.messages.getById(r, messageId))) fail("not_found", `message ${messageId} not found`);
  const rows = (await repo.messages.thread(r, messageId)).filter(mine);
  const marks = await writerMarks(repo, r, session, rows.map((m) => m.id), []);
  return rows.map((m) => ({ ...showMessage(m), ...marks.message(m.id) }));
}

// A receipt: the harness was handed these ids. Each stamps its delivery time
// once (unless `at` is null: given up, not handed) and moves its recipient
// address's cursor; only your own direct messages count (S8).
async function handleAck(tx: Tx, session: ApplicationSession, messageIds: number[], repo: Repo, at: number | null): Promise<void> {
  for (const msgId of messageIds) {
    const msg = await repo.messages.getById(tx, msgId);
    if (!msg || msg.recipient_type !== "user" || !session.addresses.includes(msg.recipient)) continue;
    if (at !== null) await repo.messages.markDelivered(tx, msgId, at);
    await repo.cursors.advance(tx, msg.recipient, "direct", msg.recipient, msgId);
  }
}
