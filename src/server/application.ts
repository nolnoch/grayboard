// The server's session and operation core (#402): hosted MCP
// (src/server/mcp.ts, src/server/hosted.ts) and the Slack bridge's in-process
// human call it. The session model is #284's: a session has an ID, aliases
// come by bind and go by unbind, and a session holds several. The WSS
// transport and its hello are gone (#282): a hosted session's lifetime is the
// hosted store's lease, not a connection's grace.
import type { BindRequest, DelegateRequest, DelegateResult, ErrorCode, Replayed, SendResult as WireSendResult, WriteRef } from "../shared/protocol.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, RateLimiter, retrySecs, type RateLimit, type Take } from "./rate_limit.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause } from "../shared/testpause.ts";
import { delegateOkFields, resolveDelegation } from "../core/delegation.ts";
import {
  MAX_CANDIDATES, MAX_HOLDS, actingAs, aliasHeldText, aliasUser, aliasUses, boardActor, childStateRefusal, closestNames, dropHold, holdAlias, holderOf, holdsOf, idRow,
  idStatuses, logBinding, orderCandidates, primaryOf, replyPeer, replyPeerError, replySender, tooManyHolds, unboundPeer, unendedIds, unknownNameError,
  type AliasUse, type Candidate,
} from "../core/bindings.ts";
import { participant, type MessageRow, type Repo, type Sync } from "./db.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatTeamAddress } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { canSend, type HumanReach } from "./can_send.ts";
import { serverAuditSink, writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  ALIAS_SESSION_SQL, acknowledge, age, boardCatalog, snapshot, canSeeBoard, checkBody, checkPostAccess, lastSeen, parseAliasMeta, pendingFor, pendingKey, refOf,
  setAliasMeta, setPlace, touchAlias, touchId, registerId, setIdFacts, cleanFact, idCollisionText, normalizeBoard, getBoard,
  type AliasMetaSet, type Board, type CoreDb, type Viewer, type PendingRef, type SnapshotOptions, type UnboundPeer,
} from "../core/boards.ts";
import { addressParts, aliasScope, type AliasScope, type ParsedAddress } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { assertDeliverableId, endSession, Undeliverable } from "../core/session_end.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type ToolContext, type BoardPostResult } from "../core/tools.ts";
import { attachmentIds, dropUnsentUploads, uploadDigests, sweepBlobs, type Uploader } from "../core/attachments.ts";
import type { AttachmentLimits } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { onAliasCreated } from "./teams.ts";
import { mayActIn, principalCanSee } from "./access.ts";
import { PROMISE_DAYS, STALE_UNDELIVERED_MS, alreadyRetracted, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showMessage, unanswered, undeliveredInstruction, type InboxItem, type PromiseItem } from "../shared/inbox.ts";
import { afterCommit } from "../core/sqlite.ts";
import type { Pending } from "../shared/notifications.ts";

// Every code an operation refuses with is a wire code (src/shared/protocol.ts).
export type ApplicationCode = ErrorCode;

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationCode, message: string, readonly extra: { known?: string[]; holder?: string; retry_after_ms?: number } = {}) {
    super(message);
  }
}
export type DirectMessage = ReturnType<typeof showMessage<MessageRow>>;
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
  afterRollback?: (write: () => void) => void;
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
  return e instanceof Undeliverable ? new ApplicationError(e.code, e.detail) : new ApplicationError("bad_request", e.message);
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
  db: CoreDb;
  // address -> the session pushes go to: a push session's ID and its bound
  // aliases, a Slack bridge human's email/human, a hosted lease's name.
  registry: Map<string, ApplicationSession>;
  sessions: Set<ApplicationSession>;
  humanReach: HumanReach;
  slackRunning: () => boolean;
  helloLimiter: RateLimiter;
  now: () => number;
  boardChanged: (board: string) => void;
};

// Send this session everything pending on boards, for any of its addresses,
// that it hasn't been sent: a subscription taken as the ID while unbound and
// the alias's own both deliver. all: also deferred pushes and digests (at
// hello; see pendingFor).
function drainBoards(session: ApplicationSession, db: CoreDb, all = false): void {
  for (const address of session.addresses) {
    for (const item of pendingFor(db, address, { all })) {
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

// Direct messages to any of `addresses` past each one's cursor (unacked ones
// are resent).
function drainDirect(hub: Hub, session: ApplicationSession, addresses: string[]): void {
  const streams = addresses.map((a) => ({ type: "direct" as const, ref: a, since: hub.repo.cursors.get(a, "direct", a) }));
  for (const message of hub.repo.messages.unreadSince(streams)) {
    session.sink.deliver({ kind: "direct", message: showMessage(message) });
  }
}

// A human's session has no wakes to save: it gets deferred pushes and
// digests at once.
function wake(hub: Hub, handles: string[]): void {
  afterCommit(hub.db, () => {
    for (const session of new Set(handles.map((h) => hub.registry.get(h)))) {
      if (session?.active) drainBoards(session, hub.db, session.human);
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
function owedBridgeNotice(repo: Repo, email: string): string | undefined {
  const target = `${email}/${HUMAN_NAME}`;
  const stop = repo.audit.last("bridge.stopped", target);
  if (!stop) return undefined;
  let detail: { reason?: string; at?: string; suppressed?: boolean };
  try {
    detail = stop.detail ? (JSON.parse(stop.detail) as typeof detail) : {};
  } catch {
    return undefined;
  }
  if (detail.suppressed || !detail.at || !detail.reason) return undefined;
  const notified = repo.audit.last("bridge.notified", target);
  if (notified && notified.at >= stop.at) return undefined;
  writeAudit(repo, "bridge.notified", null, target, { at: new Date().toISOString(), stopped_at: detail.at });
  return `your Slack bridge stopped at ${detail.at} (${detail.reason}); linked humans are offline until it reconnects or the server restarts`;
}

function helloOkFields(hub: Hub, authed: AuthedUser): SessionFacts {
  const { repo } = hub;
  return {
    user_email: authed.user_email,
    teams: repo.teams.listForUser(authed.user_id).map((t) => formatTeamAddress(t.name)),
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
    attachment_limits: repo.attachmentLimits,
  };
}

// The sentences a session's instructions carry for its addresses: active
// claims, and direct messages it sent that still haven't arrived a day later.
function noticesFor(hub: Hub, addresses: string[], first: string[] = []): string[] {
  return [
    ...first,
    ...undeliveredInstruction(hub.repo.messages.undeliveredFrom(addresses, hub.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(hub.db, h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(hub.db), addresses),
  ];
}

// When each alias was last used and where, for hosted candidates.
function sessionsSeen(db: CoreDb, handles: string[]): Map<string, { last_seen: number; where: string | null }> {
  const rows = db
    .prepare(
      `SELECT a.address, a.last_seen, i.cwd, i.place FROM aliases a LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL}
        WHERE a.address IN (SELECT value FROM json_each(?)) AND a.last_seen IS NOT NULL`,
    )
    .all(JSON.stringify(handles)) as { address: string; last_seen: number; cwd: string | null; place: string | null }[];
  return new Map(rows.map((r) => [r.address, { last_seen: r.last_seen, where: r.cwd ? describeLocation(r.cwd) : r.place }]));
}

// What a bind or a tools-only declaration's writes_as names (#284 S9): a bare name
// in the caller's own person scope, or scope/name in a scope the caller may
// act in (mayActIn). Never `human`: canSend treats any */human as a human.
// A refusal carries the address when the input parsed as one, so the
// refusal is logged against it; an unparseable name has none.
type Target = { address: string; scope: AliasScope & { scope_ref: string } } | { code: ErrorCode; error: string; address?: string };

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
    if (e instanceof CoreError) return { code: "not_found", error: e.message, address };
    throw e;
  }
  if (scope.name === HUMAN_NAME) return { code: "forbidden", error: HUMAN_RESERVED, address };
  const t = { ...scope, scope_ref: scope.scope_ref! };
  const no = mayActIn(repo, userPrincipal(authed), t);
  if (no) return { code: "forbidden", error: `you can't act as "${address}": ${no}; bind a name in your own scope, or in a team's you belong to`, address };
  return { address, scope: t };
}

// An alias a bind or a writes_as names is created on first use (S9), by
// the user who named it. Callers are inside a transaction.
function createLazily(hub: Hub, authed: AuthedUser, { address, scope }: Exclude<Target, { error: string }>, session: string): void {
  const { repo, db } = hub;
  if (repo.aliases.find(address)) return;
  repo.aliases.create(scope, authed.user_email);
  writeAudit(repo, "alias.created", authed.user_email, address, { lazy: true, session });
  onAliasCreated(db, repo, authed.user_id, address);
}

// Who holds an alias, for an alias_held refusal: its ID and where it runs.
// `place` describes the holder's machine, so only its own principal sees it
// (#349): a team alias's asker can be another member.
function describeHolder(hub: Hub, id: string, asker: string): string {
  const row = idRow(hub.db, id);
  const place = row?.principal === asker ? row.place : null;
  // A hosted root has no connection to disconnect: it is last seen when its client last called (#402).
  const hosted = hub.repo.hosted.get(id);
  if (hosted) return `the hosted session ${id}${place ? `, in ${place}` : ""}, last seen ${Math.floor((hub.now() - hosted.last_seen_at) / 1000)}s ago`;
  return `the session ${id}${place ? `, in ${place}` : ""}`;
}

// A refusal's row, written now, or by the session's `afterRollback` when the call runs inside a transaction
// the refusal's throw rolls back (#452, #467).
function rowAfterRollback(session: ApplicationSession, write: () => void) {
  if (session.afterRollback) session.afterRollback(write); else write();
}

export function createApplication(repo: Repo, db: CoreDb, opts: ApplicationOptions = {}) {
  const now = opts.now ?? Date.now;
  // A bind spends the hello bucket inside its caller's transaction (hosted's `owning`, #467): while it does, this
  // is the session's `afterRollback`, and a streak's audit row, written there where a commit keeps it, is handed
  // to it as well, to be written again if the transaction rolls back. A refused take always rolls it back.
  let streakAfterRollback: ((write: () => void) => void) | undefined;
  const streakRow = (write: () => void) => { write(); streakAfterRollback?.(write); };
  const hub: Hub = {
    repo,
    db,
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
        streakRow(() => writeAudit(repo, "hello.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs }));
      },
      end: (email, refused) => {
        console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
        streakRow(() => writeAudit(repo, "hello.rate_limit_ended", email, null, { refused }));
      },
    }, opts.now),
    boardChanged(board) {
      afterCommit(db, () => {
        for (const observer of [...observers]) {
          if (observer.board === board && observerLive(observer)) notify(() => observer.hooks.changed());
        }
      });
    },
  };
  const hostedRequestLimiter = new RateLimiter(opts.hostedRequestLimit ?? DEFAULT_HOSTED_REQUEST_LIMIT, {
    start: (email, _ctx, retryAfterMs) => {
      console.error(`[grayboard] rate-limiting hosted requests from ${email}`);
      writeAudit(repo, "hosted.rate_limited", email, null, { retry_after_ms: retryAfterMs });
    },
    end: (email, refused) => {
      console.error(`[grayboard] hosted requests from ${email} no longer rate-limited; ${refused} refused`);
      writeAudit(repo, "hosted.rate_limit_ended", email, null, { refused });
    },
  }, opts.now);
  type Observer = { session: ApplicationSession; board: string; hooks: BoardObserver };
  const observers = new Set<Observer>();
  function removeObserver(observer: Observer) {
    if (observers.delete(observer)) notify(observer.hooks.closed);
  }
  function observerLive(observer: Observer): boolean {
    if (!observers.has(observer)) return false;
    try {
      valid(observer.session);
      if (observer.session.addresses.some((a) => canSeeBoard(db, a, observer.board))) return true;
    } catch {}
    removeObserver(observer);
    return false;
  }
  function boardsChanged(boards: string[]) {
    for (const board of new Set(boards)) hub.boardChanged(board);
  }
  // Announces claims that lapse on their boards.
  const expiry = claimExpiryTimer(db, handles => wake(hub, handles), boardsChanged);
  // The session leaves the hub's registry: superseded, revoked or closed.
  function detach(session: ApplicationSession): void {
    for (const a of session.addresses) if (hub.registry.get(a) === session) hub.registry.delete(a);
  }
  function close(session: ApplicationSession, _why = "connection closed") {
    if (!session.active) return;
    session.active = false;
    hub.sessions.delete(session);
    for (const observer of [...observers]) if (observer.session === session) removeObserver(observer);
    if (session.human) {
      const addr = session.primary;
      if (addr && hub.registry.get(addr) === session) {
        hub.registry.delete(addr);
        logBinding(db, HUMAN_NAME, addr, "released", "connection closed");
      }
      return;
    }
    // alias_holds is the hosted hold set's only truth (#451): a close is a rebuild
    // (reconcile) or a shutdown, never a release, so it leaves the holds alone.
    const id = session.sessionId;
    detach(session);
    if (session.writerId) touchId(db, session.writerId);
  }
  // The server closes the session: it leaves the hub, and its transport is
  // told why and closes.
  function terminate(session: ApplicationSession, error: ApplicationError) {
    detach(session);
    session.closedBy = error;
    close(session);
    session.sink.closed(error);
  }
  function valid(session: ApplicationSession, allowUnbound = false) {
    if (!session.active || !hub.sessions.has(session)) {
      // A superseded bridge connection is told so, a revoked tools-only
      // one why it may not write as its alias (S9); any other closed session
      // is closed (#402).
      const why = session.closedBy;
      if (why?.code === "superseded") fail("superseded", "this connection no longer holds its session");
      if (why?.code === "forbidden") throw why;
      fail("unauthenticated", "session is closed");
    }
    if (repo.users.findById(session.authed.user_id)?.disabled_at != null) {
      terminate(session, new ApplicationError("unauthenticated", "an admin signed this user out"));
      fail("unauthenticated", "an admin signed this user out");
    }
    if (session.readOnly && !allowUnbound) fail("unbound", UNBOUND_ERROR);
  }
  function admitHosted(authed: AuthedUser, sessionId: string | null) {
    const t = hostedRequestLimiter.take(authed.user_email, { session_id: sessionId, read_only: true, place: null });
    if (!t.ok) fail("rate_limited", `too many connections for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
  }

  // Ends sessions, each in its own transaction (bounces, claim releases,
  // holds released), then wakes what that changed and sweeps the freed
  // upload bytes. One end that throws is logged and audited id.end_failed
  // and leaves the others ended; the next revalidate (a revoked alias) or
  // start (a leftover) retries it.
  function endIds(ids: string[], why: string): void {
    if (!ids.length) return;
    const woken = new Set<string>(), bounced: { id: string; at: number }[] = [];
    for (const id of ids) {
      let ended;
      const at = now();
      try {
        ended = repo.atomic(() => endSession(db, repo.mail, id, { why, now: at, audit: serverAuditSink(repo) }));
      } catch (e) {
        console.error(`[grayboard] ending session ${id} (${why}) failed:`, e);
        writeAudit(repo, "id.end_failed", null, id, { why, error: String(e) });
        continue;
      }
      // An end that found the session already ended sends nothing again.
      if (!ended.ended) continue;
      for (const h of ended.wake) woken.add(h);
      bounced.push({ id, at });
      if (ended.held.length) console.error(`[grayboard] session ${id} ended (${why}); released ${ended.held.join(", ")}`);
    }
    afterEnds(woken, bounced);
  }
  // What follows ends, after their commit: a bounce goes to a live sender now, as a send does (a drain would
  // resend that session's unacked messages too), the woken handles drain, and the freed upload bytes go.
  function afterEnds(woken: Set<string>, ends: { id: string; at: number }[]): void {
    for (const { id, at } of ends) for (const b of repo.messages.bouncesFrom(id, at)) {
      const to = hub.registry.get(b.recipient);
      if (to?.active) to.sink.deliver({ kind: "direct", message: showMessage(b) });
    }
    wake(hub, [...woken]);
    void sweepBlobs(db, repo.blobs);
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
  endIds(unendedIds(db).filter((id) => !repo.hosted.owned(id)), "wss_removed");
  // Re-checks the aliases that sessions act as (S9) against mayActIn, for
  // one principal's sessions or (null) every session's, and revokes the ones
  // it now refuses. by: the user whose act changed the access (an admin's
  // team removal, the principal's own leave), or null for the server's own
  // sweep; the revocations' audit actor.
  function recheckAliases(principal: string | null, by: string | null): void {
    const revoked: (AliasUse & { reason: string })[] = [];
    for (const u of aliasUses(db, principal)) {
      const p = repo.principals.findByName(u.principal);
      const reason = p ? mayActIn(repo, p, u) : `principal ${u.principal} no longer exists`;
      if (reason) revoked.push({ ...u, reason });
    }
    revokeAliases(revoked, by);
  }
  // Takes aliases from sessions whose principals may no longer act in their
  // scopes (S9). A holder keeps its ID and its other holds: only the revoked
  // hold is released. A tools-only session writes only as its writes_as, so
  // it has nothing left to be: its ownership ends. A hosted root's hold is
  // released in the database (#408) and its generation bumped (#451): the live
  // holder is rebuilt and its lease closed. HTTP has no frame to tell it, so the
  // loss is kept (#453): the root's next native whoami or tool result takes it
  // once, and its Controller's whoami reports it until the next delivery_open.
  function revokeAliases(uses: (AliasUse & { reason: string })[], by: string | null): void {
    if (!uses.length) return;
    const ended: string[] = [];
    for (const u of uses) {
      const { reason } = u;
      const hosted = repo.hosted.owned(u.id);
      if (!u.held) {
        writeAudit(repo, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, writes_as: true, reason });
        // A hosted tools-only root ends its ownership, not an ID (hosted IDs are the store's).
        if (hosted) repo.hosted.atomic(() => repo.hosted.end(u.id, "revoked", now()));
        else ended.push(u.id);
        continue;
      }
      // A hosted root's change goes through the hosted store's transaction, whose commit tells the hosted
      // service and delivery to close the lease now, not at its next renewal.
      const revoke = () => {
        const primary = hosted && holdsOf(db, u.id)[0] === u.address;
        dropHold(db, u.address, u.id);
        logBinding(db, u.id, u.address, "released", `access revoked: ${reason}`);
        writeAudit(repo, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, reason });
        if (hosted) {
          const row = repo.hosted.get(u.id);
          if (row) {
            // Its last hold gone, the root is unbound but owning: no lease, so the sweep doesn't expire it.
            repo.hosted.update({ ...row, bind_gen: row.bind_gen + 1, lease_deadline: holdsOf(db, u.id).length ? row.lease_deadline : null });
            if (row.lease_deadline !== null) writeAudit(repo, "hosted.lease_closed", null, u.id, { reason: "revoked", ownership: row.ownership_id });
            repo.hosted.lose(u.id, { alias: u.address, reason, primary }, now());
          }
        }
      };
      if (hosted) repo.hosted.atomic(revoke); else repo.atomic(revoke);
    }
    endIds(ended, "revoked");
  }

  // The Slack bridge's in-process human (S16): no ID and no ids row.
  // It holds email/human and logs bind events under the literal `human`.
  async function attachHuman(authed: AuthedUser, sink: DeliverySink): Promise<{ session: ApplicationSession; ok: HelloResult }> {
    const addr = `${authed.user_email}/${HUMAN_NAME}`;
    if (repo.users.findById(authed.user_id)?.disabled_at != null) fail("unauthenticated", "session is closed");
    if (!repo.aliases.find(addr)) {
      repo.aliases.create({ scope_kind: "person", scope_ref: authed.user_email, name: HUMAN_NAME }, authed.user_email);
      writeAudit(repo, "alias.created", authed.user_email, addr, { lazy: true, slack: true });
      onAliasCreated(db, repo, authed.user_id, addr);
    }
    const session = new ApplicationSession(authed, sink, true, true);
    session.primary = addr;
    session.addresses = [addr];
    // A bridge connection never pongs: a newer one for the user replaces it.
    const prev = hub.registry.get(addr);
    if (prev && prev !== session) terminate(prev, new ApplicationError("superseded", "a newer Slack bridge connection took over this human"));
    hub.sessions.add(session);
    hub.registry.set(addr, session);
    touchAlias(db, addr);
    logBinding(db, HUMAN_NAME, addr, "bound");
    return { session, ok: { id: HUMAN_NAME, ...helloOkFields(hub, authed) } };
  }

  // bind (#284 S2, PR 4 S1): add an alias to this session's holds. One it
  // already holds answers ok and applies only `meta`; the others stay held,
  // and the primary changes only when the session held nothing.
  // A refusal's binding row goes to the session's `afterRollback` when it has one: a hosted bind runs inside a
  // transaction the refusal's throw rolls back, and the row is written after it.
  function bindNow(session: ApplicationSession, m: Omit<BindRequest, "type" | "req_id">): BindResult {
    valid(session, true);
    const { authed } = session;
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it binds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it binds nothing");
    const id = session.sessionId;
    // Lazy creation is here, after the bind limit: an unlimited create loop
    // would mint aliases without bound. Taken before the held check, so a
    // re-bind loop spends it too.
    streakAfterRollback = session.afterRollback;
    let t: Take;
    try { t = hub.helloLimiter.take(authed.user_email, { session_id: id, bind: m.alias }); } finally { streakAfterRollback = undefined; }
    if (!t.ok) fail("rate_limited", `too many binds for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
    const target = bindTarget(hub, authed, m.alias);
    if ("error" in target) {
      if (target.address) { const a = target.address; rowAfterRollback(session, () => logBinding(db, id, a, "refused", target.error)); }
      return fail(target.code, target.error);
    }
    const { address, scope } = target;
    const refuse = (code: ErrorCode, message: string, detail: string, extra: ApplicationError["extra"] = {}): never => {
      rowAfterRollback(session, () => logBinding(db, id, address, "refused", detail));
      return fail(code, message, extra);
    };
    let meta: AliasMetaSet | undefined;
    try {
      meta = m.meta === undefined ? undefined : parseAliasMeta(m.meta);
    } catch (e) {
      if (e instanceof CoreError) return refuse("bad_request", e.message, e.message);
      throw e;
    }
    const audit = serverAuditSink(repo);
    if (session.holds.includes(address)) {
      // No binding event, and bound_at stays: the session already holds it.
      if (meta) repo.atomic(() => setAliasMeta(db, address, meta, id, audit));
      return { alias: address, held: [...session.holds] };
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return refuse("bad_request", why, why);
    }
    // A typo would otherwise create a fresh alias, and the DMs queued for the
    // intended one would never arrive.
    if (m.create === false && !repo.aliases.find(address)) {
      const known = closestNames(scope.name, repo.aliases.listForScope(scope.scope_kind, scope.scope_ref).map((a) => a.name).filter((n) => n !== HUMAN_NAME));
      const message = unknownNameError(scope.name, known);
      return refuse("identity_unknown", message, message, { known });
    }
    // Another session's hold is never taken over. The hosted service clears a stale
    // hosted holder first (#402): one idle past the hosted window ended and freed the
    // alias; a live one refuses the bind.
    const holder = holderOf(db, address);
    if (holder !== null && holder !== id) {
      const who = describeHolder(hub, holder, authed.user_email);
      return refuse("alias_held", aliasHeldText(address, who, "bind another name"), who, { holder: who });
    }
    // Another user's tools-only session writing as it holds nothing, but the
    // alias is in use, so it's exclusive all the same (S8, decided).
    const writer = aliasUser(db, address, authed.user_email);
    if (writer !== null) {
      const why = `another user's session ${writer}`;
      return refuse("alias_held", aliasHeldText(address, why, "bind another name"), why);
    }
    if (session.holds.length >= MAX_HOLDS) {
      const why = tooManyHolds(session.holds);
      return refuse("bad_request", why, why);
    }

    repo.atomic(() => {
      createLazily(hub, authed, target, id);
      holdAlias(db, address, id, now());
      logBinding(db, id, address, "bound", null);
      if (meta) setAliasMeta(db, address, meta, id, audit);
      touchAlias(db, address);
    });

    setHolds(hub, session, holdsOf(db, id));
    // The first bind of a user's session after the bridge died carries the death notice, once.
    const owed = owedBridgeNotice(repo, authed.user_email);
    const notices = noticesFor(hub, session.addresses, owed ? [owed] : []);
    return { alias: address, held: [...session.holds], ...(notices.length ? { notices } : {}) };
  }

  // unbind (#284 PR 4 S2): release one hold. Its mail queues and its claims
  // stay with the alias, for its next holder; a board item in flight for it
  // leaves this session (setHolds), so that holder is pushed it. An alias
  // the session doesn't hold answers ok with released: false.
  function unbind(session: ApplicationSession, alias: string): UnbindResult {
    valid(session, true);
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it unbinds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it unbinds nothing");
    const id = session.sessionId;
    const p = addressParts(alias);
    if (!p || p.kind === "id" || p.kind === "team") fail("bad_request", `"${alias}" isn't an alias: a name, or scope/name`);
    const address = p.kind === "bare" ? `${session.authed.user_email}/${p.name}` : p.address;
    if (!session.holds.includes(address)) return { alias: address, released: false, held: [...session.holds] };
    repo.atomic(() => {
      dropHold(db, address, id);
      logBinding(db, id, address, "released", "unbind");
      touchAlias(db, address);
    });
    setHolds(hub, session, session.holds.filter((a) => a !== address));
    const left = listClaims(db).filter((c) => c.holder === address).map((c) => c.key);
    return { alias: address, released: true, held: [...session.holds], ...(left.length ? { left } : {}) };
  }

  const application = {
    repo,
    admitHosted,
    // `suggested`: the name the session's checkout suggested (#443), offered first while free.
    hostedCandidates(authed: AuthedUser, suggested: string | null) { return candidates(hub, authed, suggested); },
    // The aliases a hosted root holds, oldest first: alias_holds is their only truth (#451).
    hostedHolds(id: string): string[] { return holdsOf(db, id); },
    // `writesAs`: a tools-only root's alias; it holds nothing and binds nothing.
    // Otherwise the session holds `holds`, reads as them and its
    // ID, and writes as the oldest; none held reads and nothing else (readOnly). `row`: the hosted root's
    // place and suggested name (#443), null with no row. `root`: set for a child session (#523),
    // which acts under its root's addresses, never its own ID (not an address), and whose writes
    // carry its ID as `via`.
    hostedSession(authed: AuthedUser, id: string, holds: string[], writesAs: string | null, row: { place: string | null; suggested: string | null } | null, sink: DeliverySink, push = false, root: string | null = null) {
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
      const own = idRow(db, id)?.principal === authed.user_email;
      if (!session.readOnly && own) session.writerId = id;
      if (root !== null && own) session.via = id;
      // Computed before the session is registered: a throw here leaves no holder or route behind (#385 item 9).
      const info: IdentityInfo = {
        identity_full: session.primary,
        ...helloOkFields(hub, authed),
        ...(session.readOnly && session.via === undefined ? { candidates: candidates(hub, authed, row?.suggested ?? null) } : {}),
      };
      hub.sessions.add(session);
      if (push && holds.length) for (const a of session.addresses) hub.registry.set(a, session);
      return { session, info };
    },
    // The root a hosted child acts under (#523), recorded on the child's ids row, where it outlives the
    // child's source row (deleted at the child's end) so a send or mention to the child's ID keeps
    // being refused child_session; null when the ID starts as a root, which makes it an address again.
    hostedRoot(id: string, root: string | null) {
      db.prepare(`UPDATE ids SET root_id = ? WHERE id = ? AND root_id IS NOT ?`).run(root, id, root);
    },
    // `harness` comes from the principal's source mapping (#414): peer_list shows it and match:{harness} filters on it.
    // `collided`: where a caller inside a transaction that the refusal rolls back takes the audit row
    // (`hostedCollided`, written after the rollback); without it the row is written here.
    hostedRegister(authed: AuthedUser, id: string, harness: string, writesAs: string | null = null, collided?: (why: string) => void, facts?: { model?: string; effort?: string }) {
      const prior = idRow(db, id);
      if (prior && prior.principal !== authed.user_email) {
        const why = "is another principal's session";
        if (collided) collided(why); else writeAudit(repo, "id.collision", authed.user_email, id, { why });
        fail("id_collision", idCollisionText(id, why));
      }
      // A tools-only root's writes_as is registered here (A4): aliasUser, aliasUses and
      // undeliverableId read ids.writes_as, so a send to its ID is pointed at the alias.
      if (!prior) {
        repo.atomic(() => {
          const model = cleanFact(facts?.model), effort = cleanFact(facts?.effort);
          registerId(db, { id, principal: authed.user_email, harness, launcher: false, ...(writesAs === null ? {} : { writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
          writeAudit(repo, "id.registered", authed.user_email, id, { harness, ...(writesAs === null ? {} : { writes_as: writesAs }), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        });
      }
      else {
        // An ID whose row ended (a released child, or a row a restart ended) is live again (#475 item 7a): revocation
        // (aliasUses), identity deletion (aliasUser) and retention only see unended rows, so a holder must have one.
        if (prior.ended_at !== null) {
          const endedAt = prior.ended_at;
          repo.atomic(() => {
            db.prepare(`UPDATE ids SET ended_at = NULL, held_aliases_json = NULL WHERE id = ?`).run(id);
            writeAudit(repo, "id.reopened", authed.user_email, id, { ended_at: endedAt, harness });
          });
        }
        touchId(db, id);
        // A new ownership of the same ID reports its own model and effort: what the last one reported is stale.
        const changed = setIdFacts(db, id, { model: facts?.model ?? null, effort: facts?.effort ?? null });
        if (changed) writeAudit(repo, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "ownership" });
        // An ownership's end clears the row's writes_as (the store's end), so a new ownership of the same ID restates it.
        if (writesAs !== null) db.prepare(`UPDATE ids SET writes_as = ? WHERE id = ? AND writes_as IS NULL`).run(writesAs, id);
      }
    },
    // A root's request declared a launcher (#473, #520): the flag is the ownership's (`ids.launcher`; its end clears
    // it), turned on by whichever of its requests declares first and audited as a local session's is, once.
    // `detail`: which ownership and client turned it on, now that a later request can (#520).
    hostedDeclareLauncher(authed: AuthedUser, id: string, detail: { ownership: number; client_id: string }) {
      if (db.prepare(`UPDATE ids SET launcher = 1 WHERE id = ? AND launcher IS NOT 1`).run(id).changes) writeAudit(repo, "handle.launcher_set", authed.user_email, id, { on: true, ...detail });
    },
    // The latest model and effort a hosted session's request reports (#364): written, and audited with the
    // before and after, only when one changed. Absent fields keep the stored value; an empty one clears it (#558).
    hostedFacts(authed: AuthedUser, id: string, facts: { model?: string; effort?: string }) {
      const changed = setIdFacts(db, id, facts);
      if (changed) writeAudit(repo, "id.facts_changed", authed.user_email, id, { before: changed.before, after: changed.after, why: "request" });
    },
    // A tools-only declaration's alias, resolved and checked: a name the
    // principal may act in, never one another user's session uses (S7, S8); it may share the
    // alias with a holder. create: the first request makes the alias lazily.
    // `refused`: as `collided` above, for the refused binding row (`hostedRefused`).
    hostedWritesAs(authed: AuthedUser, id: string, raw: string, create = false, refused?: (address: string, detail: string) => void): string {
      const note = (address: string, detail: string) => { if (refused) refused(address, detail); else logBinding(db, id, address, "refused", detail); };
      const target = bindTarget(hub, authed, raw);
      if ("error" in target) {
        if (target.address) note(target.address, target.error);
        return fail(target.code, target.error);
      }
      const other = aliasUser(db, target.address, authed.user_email);
      if (other) {
        const why = `another user's session ${other}`;
        note(target.address, why);
        return fail("alias_held", aliasHeldText(target.address, why, "write as another name"));
      }
      if (create) createLazily(hub, authed, target, id);
      return target.address;
    },
    // The address a bind of `alias` would take, or undefined when bind will refuse it
    // (bindNow says why): the hosted service clears a stale contender for it first.
    bindAddress(authed: AuthedUser, alias: string): string | undefined {
      const target = bindTarget(hub, authed, alias);
      return "error" in target ? undefined : target.address;
    },
    aliasHolderId(address: string): string | null { return holderOf(db, address); },
    // Every session's holds, oldest first, for the hosted sweep and reconcile.
    holdsByOwner(): Map<string, string[]> {
      const byOwner = new Map<string, string[]>();
      for (const r of db.prepare(`SELECT id, address FROM alias_holds ORDER BY bound_at, address`).all() as { id: string; address: string }[]) {
        const list = byOwner.get(r.id);
        if (list) list.push(r.address); else byOwner.set(r.id, [r.address]);
      }
      return byOwner;
    },
    // Whether the session's ownership declared a launcher (#473, #520): what its instruction text follows, since the
    // stored flag, not the current request's `_meta`, decides whether it receives delegation requests.
    hostedLauncher(id: string): boolean { return (db.prepare(`SELECT launcher FROM ids WHERE id = ?`).get(id) as { launcher: number | null } | null)?.launcher === 1; },
    hostedPlace(id: string, place: string | null) { setPlace(db, id, place); },
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman,
    bindNow,
    hostedRefused(id: string, address: string, detail: string) { logBinding(db, id, address, "refused", detail); },
    hostedCollided(authed: AuthedUser, id: string, why: string) { writeAudit(repo, "id.collision", authed.user_email, id, { why }); },
    unbind,
    close,
    revalidateSession: valid,
    // Everything owed to a push session, after its hello's answer: direct
    // messages and board items for `addresses` (every address by default; a
    // bind's alias after its answer).
    replay(session: ApplicationSession, addresses?: string[]) {
      valid(session, true);
      if (session.readOnly || !session.push) return;
      afterCommit(db, () => {
        valid(session, true);
        drainDirect(hub, session, addresses ?? session.addresses);
        drainBoards(session, db, true);
      });
    },
    send(
      session: ApplicationSession,
      recipient: string,
      body: string,
      options: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean; as?: string } = {},
    ) {
      valid(session);
      return handleSend(hub, session, recipient, body, options.parent_id ?? null, options.pending === true, options.attachment_ids, options.resend === true, options.as);
    },
    delegate(session: ApplicationSession, request: Omit<DelegateRequest, "type" | "req_id">) {
      valid(session);
      return handleDelegate(hub, session, request);
    },
    history(session: ApplicationSession, options: { peer?: string; limit?: number; before_id?: number } = {}) {
      valid(session);
      return handleHistory(hub, session, options.peer, options.limit, options.before_id);
    },
    thread(session: ApplicationSession, id: number) {
      valid(session);
      return handleThread(session, id, repo);
    },
    inbox(session: ApplicationSession, days?: number) {
      valid(session);
      childState(session, "dm_inbox");
      return handleInbox(hub, session, days);
    },
    // Reads retain durable cursors; pendingFor still cleans inaccessible outbox rows.
    pending(session: ApplicationSession, limit = 100): DeliveryEvent[] {
      valid(session);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("bad_request", "invalid pending limit");
      const streams = session.addresses.map((a) => ({ type: "direct" as const, ref: a, since: repo.cursors.get(a, "direct", a) }));
      const direct: DeliveryEvent[] = repo.messages.unreadSince(streams)
        .slice(0, limit).map(message => ({ kind: "direct", message: showMessage(message) }));
      const seen = new Set<string>();
      const boards: Pending[] = [];
      for (const a of session.addresses) {
        for (const item of pendingFor(db, a, { all: true })) {
          const key = pendingKey(refOf(item));
          if (!seen.has(key)) { seen.add(key); boards.push(item); }
        }
      }
      return [...direct, ...boards.slice(0, limit - direct.length).map(item => ({ kind: "board" as const, item }))];
    },
    boardCatalog(session: ApplicationSession, after?: string) {
      valid(session, true);
      return boardCatalog(db, session.readOnly ? seer(repo, session) : session.primary, after);
    },
    boardSnapshot(session: ApplicationSession, board: string, options: SnapshotOptions = {}) {
      valid(session, true);
      return snapshot(db, reader(session, board), board, options);
    },
    observeBoard(session: ApplicationSession, boardInput: string, hooks: BoardObserver): () => void {
      valid(session);
      const board = normalizeBoard(boardInput);
      // Snapshot performs the same concealed access check as content reads.
      snapshot(db, reader(session, board), board, { limit: 1 });
      if (observers.size >= 1024) fail("bad_request", "board observer capacity reached");
      const observer = { session, board, hooks };
      observers.add(observer);
      return () => removeObserver(observer);
    },
    canReceiveBoard(session: ApplicationSession, board: string) {
      valid(session);
      return session.addresses.some((a) => canSeeBoard(db, a, board));
    },
    // handed: false is a give-up (Slack refused the message): the cursor
    // moves so it isn't retried, but nothing reached the harness to stamp.
    receiptDirect(session: ApplicationSession, ids: number[], opts: { handed: boolean } = { handed: true }) {
      valid(session);
      handleAck(session, ids, repo, opts.handed ? now() : null);
    },
    // A ref carries no handle: the item was sent for one of this session's
    // addresses, and acknowledging is a no-op on one with no such row, so
    // each address acks it.
    receiptBoards(session: ApplicationSession, refs: PendingRef[]) {
      valid(session);
      for (const r of refs) {
        for (const a of session.addresses) acknowledge(db, a, r);
        afterCommit(db, () => { session.inflight.delete(pendingKey(r)); });
      }
    },
    // Acked as the address the row names (S8): receivedUnacked and
    // sentPending match a.reader = m.recipient, or m.sender.
    acknowledgeDm(session: ApplicationSession, id: number) {
      valid(session);
      childState(session, "dm_ack");
      const m = repo.messages.getById(id), mine = session.addresses;
      const reader = !m || m.recipient_type !== "user" ? null
        : mine.includes(m.recipient) ? m.recipient
        : m.pending && mine.includes(m.sender) ? m.sender
        : null;
      if (!m || reader === null) fail("not_found", `no message ${id} to you or pending from you; dm_inbox lists them`);
      repo.messages.ack(reader, m.id);
    },
    retract(session: ApplicationSession, id: number) {
      valid(session);
      return handleRetract(hub, session, id);
    },
    call(session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      valid(session, UNBOUND_READS.has(tool));
      // Armed on a refusal too: a call can commit work (an expiring claim) before it throws (#385 item 15f).
      try { return handleCall(hub, session, tool, args, publish); }
      finally { afterCommit(db, () => expiry.arm()); }
    },
    // Trusted committed domain operations, not client-supplied invalidations.
    boardsChanged,
    wake(handles: string[]) {
      afterCommit(db, () => expiry.arm());
      wake(hub, handles);
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
    accessChanged(principal: string, by: string) { recheckAliases(principal, by); },
    // Catches a user disabled with no server route to say so (a database
    // reset, an operator edit), and an alias its session's principal may no
    // longer act as (S9's backstop to accessChanged).
    revalidate() {
      for (const observer of [...observers]) observerLive(observer);
      const users = new Set<number>();
      for (const s of hub.sessions) {
        if (!s.human && repo.users.findById(s.authed.user_id)?.disabled_at != null) users.add(s.authed.user_id);
      }
      for (const id of users) application.disconnectUser(id);
      recheckAliases(null, null);
    },
    sweepHellos: () => { hub.helloLimiter.sweep(); hostedRequestLimiter.sweep(); },
    /** How many users have a bind or hosted-request bucket, for tests. */
    limiterSizes: () => ({ bind: hub.helloLimiter.size, hosted: hostedRequestLimiter.size }),
    stopExpiry() {
      expiry.stop();
      unsubscribeEnds();
      for (const observer of [...observers]) removeObserver(observer);
    },
  };
  // Who a board read is judged for: the first of the session's addresses that can see it (S14).
  function reader(session: ApplicationSession, board: string): Viewer {
    if (session.readOnly) return seer(repo, session);
    try {
      return boardActor(db, "board_read", { board }, { addresses: session.addresses, asAddresses: asAddresses(session), ownScope: session.authed.user_email });
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

// A hosted unbound session's candidates: the user's own names nobody holds.
function candidates(hub: Hub, authed: AuthedUser, suggestedInput: string | null): Candidate[] {
  const { repo, db } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const free = (n: string) => n !== HUMAN_NAME && holderOf(db, full(n)) === null;
  const names = repo.aliases.listForScope("person", authed.user_email).map((i) => i.name).filter(free);
  const queued = repo.messages.queuedTo(names.map(full));
  const seen = sessionsSeen(db, names.map(full));
  const claims = new Map<string, number>();
  for (const c of listClaims(db)) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
  const suggested = suggestedInput !== null && free(suggestedInput) ? suggestedInput : null;
  return orderCandidates(
    names.map((n) => ({
      name: n, queued: queued.get(full(n)) ?? 0, claims: claims.get(full(n)) ?? 0,
      last_seen: seen.get(full(n))?.last_seen ?? 0, where: seen.get(full(n))?.where ?? null,
    })),
    suggested,
  ).slice(0, MAX_CANDIDATES);
}

// The user's live sessions with no alias, for peer_list: never another
// user's (`where` describes their machine). A hold, a tools-only connection or
// an idle legacy GET isn't listed: it receives nothing. A hosted session with no name is
// listed as master listed it (#402). One row per session ID: a hosted call adds
// its own connection beside any other of the same ID that is live (#489).
function unboundPeers(hub: Hub, session: ApplicationSession): UnboundPeer[] {
  const mine = new Map<string, ApplicationSession>();
  for (const c of hub.sessions) {
    if (c.transport !== "hosted" || !c.readOnly || !c.listed || c.authed.user_id !== session.authed.user_id) continue;
    if (!mine.has(c.sessionId)) mine.set(c.sessionId, c);
  }
  const statuses = idStatuses(hub.db, [...mine.keys()]);
  const now = hub.now();
  return [...mine.values()].map((c) => {
    const s = statuses.get(c.sessionId);
    return unboundPeer(c.sessionId, c.place ?? null, c.sessionId === session.sessionId, s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
  });
}

// A bare name means the one of that name in the acting address's own scope,
// else the one alias anyone has with it (as @name does in a post). Shared
// with delegate's `to` resolution (#184 review 7): both take bare and
// mixed-case names through the same path.
type Peer = Exclude<ParsedAddress, { kind: "bare" }>;
function resolvePeer(repo: Repo, from: string, input: string): Peer {
  const p = addressParts(input);
  if (!p) fail("bad_request", `invalid address "${input}": expected "id:…", "scope/name" or "team:name"`);
  if (p.kind !== "bare") return p;
  const scope = ownScope(repo.resolver, from);
  const own = scope ? addressParts(`${scope}/${p.name}`) : null;
  if (own?.kind === "alias" && repo.aliases.find(own.address)) return own;
  if (p.name === HUMAN_NAME) {
    // A bare "human" is always your own (addressing.ts HUMAN_NAME), never the
    // one alias anyone has with the name: another user's is reached by its
    // full handle, as peer_list shows it.
    fail("not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
  }
  const all = repo.aliases.findAllByName(p.name);
  const only = all.length === 1 ? addressParts(all[0]!.address) : null;
  if (only && only.kind !== "bare") return only;
  const which = all.length ? `several identities are named "${p.name}": ${all.map(i => i.address).sort().join(", ")}` : `no identity is named "${p.name}"`;
  return fail("not_found", `${which}; peer_list shows exact handles`);
}

// A send checked and resolved, ready to write: `from` the address it goes
// out as, `to` the recipient's full handle, `digests` its files' blob
// digests in call order.
type PreparedSend = { from: string; to: string; body: string; parentId: number | null; pending: boolean; ids: number[]; digests: string[] };

// The address a send goes out as: `as` when given (#284 S3), else for a
// reply the held alias its parent reached or was sent as (S4), else the
// primary.
function sendAs(hub: Hub, session: ApplicationSession, as: string | undefined, parentId: number | null): string {
  if (as !== undefined) {
    try {
      return actingAs(as, asAddresses(session), session.authed.user_email);
    } catch (e) {
      if (e instanceof CoreError) fail("bad_request", e.message);
      throw e;
    }
  }
  const parent = parentId === null ? undefined : hub.repo.messages.getById(parentId);
  return (parent && participant(parent, session.addresses) ? replySender(parent, session.holds) : null) ?? session.primary;
}

// Checks a send and resolves its recipient, writing nothing; throws
// ApplicationError. Its uploads may be any of the session's addresses' (S5).
function prepareSend(
  hub: Hub, session: ApplicationSession, from: string, recipientStr: string, body: string, parentId: number | null, pending: boolean, attachmentIdsRaw: unknown,
): PreparedSend {
  const { repo, db } = hub;
  let ids: number[];
  let digests: string[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
    digests = uploadDigests(db, ids, uploaderOf(session));
  } catch (e) {
    if (e instanceof CoreError) fail("bad_request", e.message);
    throw e;
  }

  const to = resolvePeer(repo, from, recipientStr);
  if (to.kind === "team") fail("bad_request", `${to.address} isn't a person; to reach a team, board_post to its board #${to.name}`);
  // An ID's deliverability is checked in the write's transaction (writeSend).
  if (to.kind === "alias" && !repo.aliases.find(to.address)) fail("not_found", `identity "${to.address}" not found; peer_list shows exact handles`);
  const decision = canSend(from, { kind: "user", address: to.address }, { db: repo, now: hub.now(), humanReach: hub.humanReach });
  if (!decision.allow) fail(decision.code, decision.reason);

  if (parentId !== null) {
    const parent = repo.messages.getById(parentId);
    if (!participant(parent, session.addresses)) fail("not_found", `parent_id ${parentId} is not a message you sent or received`);
    const peer = replyPeer(parent, session.addresses);
    if (to.address !== peer) fail("bad_request", replyPeerError(parentId, peer));
  }
  return { from, to: to.address, body, parentId, pending, ids, digests };
}

// Writes the message and builds its result. Runs inside the caller's
// transaction; whether the recipient is live is read here, with nothing
// awaited before deliverSend pushes, so the result says what happens.
function writeSend(hub: Hub, session: ApplicationSession, p: PreparedSend): Written<SendResult> & { msg: MessageRow } {
  const { repo, db, registry } = hub;
  let msg: MessageRow;
  try {
    if (addressParts(p.to)?.kind === "id") assertDeliverableId(db, p.to);
    msg = repo.messages.insert(p.from, "user", p.to, p.body, p.parentId, p.pending, { ids: p.ids, uploader: uploaderOf(session) }, session.writerId ?? null, session.via ?? null);
  } catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    throw e;
  }
  const f = {
    ...(p.pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}),
    // Named whenever it isn't the primary (S4).
    ...(p.from !== session.primary ? { sent_as: p.from } : {}),
  };
  const seen = lastSeen(db, p.to);
  const payload: SendResult = registry.get(p.to)?.active
    ? { message_id: msg.id, delivered_now: true, ...f }
    : {
        message_id: msg.id,
        delivered_now: false,
        ...f,
        ...(seen ? { recipient_last_seen: `${age(hub.now() - seen)} ago` } : {}),
        undelivered_from_you: repo.messages.undeliveredFrom(session.addresses).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
      };
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: msg.sender, message_id: msg.id, recipient: msg.recipient });
  }
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// Only after the outermost commit, never on a replay.
function deliverSend(hub: Hub, msg: MessageRow): void {
  const recipient = hub.registry.get(msg.recipient);
  if (recipient?.active) recipient.sink.deliver({ kind: "direct", message: showMessage(msg) });
}

// An append write, deduplicated (#254): an identical call by this session
// as the same `sender` within the window answers with the first one's
// result. The Slack bridge's humans are exempt: a person typing a line twice
// sent it twice. `uploads`: the call's attachment ids, any of the session's
// addresses' (S5); a replay releases them (the retry uploaded its files
// afresh, and nothing will bind them), audited like any release.
function writeOnce<W extends Written>(
  hub: Hub, session: ApplicationSession, tool: DedupTool, sender: string, args: Record<string, unknown>, resend: boolean, uploads: number[], write: () => Sync<W>,
): DedupOutcome<W> {
  const { repo } = hub;
  if (session.human) return { fresh: repo.atomic(write) };
  const { authed } = session;
  const out = dedupWrite(repo, hub.now(), {
    tool, session: session.sessionId, sender, actor: authed.user_email, transport: session.transport, args, resend,
  }, write, () => {
    for (const row of dropUnsentUploads(hub.db, uploads, uploaderOf(session))) {
      writeAudit(repo, "attachment.released", authed.user_email, `attachment:${row.id}`, {
        identity: row.uploader, filename: row.filename, size: row.size, sha256: row.sha256, reason: "replayed",
      });
    }
  });
  if ("replay" in out && uploads.length > 0) afterCommit(hub.db, async () => { await sweepBlobs(hub.db, repo.blobs); });
  return out;
}

function handleSend(
  hub: Hub, session: ApplicationSession, recipient: string, body: string, parentId: number | null, pending: boolean, ids: unknown, resend: boolean, as: string | undefined,
): SendResult {
  const p = prepareSend(hub, session, sendAs(hub, session, as, parentId), recipient, body, parentId, pending, ids);
  // Keyed by what the server resolved, so two spellings of one call collide.
  const args = { to: p.to, body: p.body, parent_id: p.parentId, pending: p.pending, attachments: p.digests };
  const out = writeOnce(hub, session, "dm_send", p.from, args, resend, p.ids, () => writeSend(hub, session, p));
  if ("replay" in out) return out.replay;
  afterCommit(hub.db, () => {
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
function handleDelegate(hub: Hub, session: ApplicationSession, m: Omit<DelegateRequest, "type" | "req_id">): DelegateResult {
  const { repo, db } = hub;
  const { authed } = session;
  // The audit rows name the child that called, beside the routing `via` (#523).
  const byChild = session.via === undefined ? {} : { child: session.via };
  const refused = (detail: Record<string, unknown>) => rowAfterRollback(session, () => writeAudit(repo, "delegation.refused", authed.user_email, session.primary, { ...detail, ...byChild }));
  let to: string | undefined;
  if (m.to !== undefined) {
    try {
      to = resolvePeer(repo, session.primary, m.to).address;
    } catch (e) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      if (e instanceof ApplicationError) refused({ reason: e.message, to: m.to });
      throw e;
    }
  }
  const online = (h: string) => hub.registry.get(h)?.active === true;
  // The human fallback's reachability is the server's own knowledge: the
  // bridge is running and this user is linked (#191).
  const humanReachable = () => hub.slackRunning() && !!repo.slack.linkFor(authed.user_id);
  const args = { to: to ?? null, persona: m.persona, task: m.task, context: m.context ?? null };
  // Where a refused send was headed, for its audit row.
  let picked: string | undefined;
  let out: DedupOutcome<Written<DelegateResult> & { msg: MessageRow }>;
  try {
    out = writeOnce(hub, session, "delegate", session.primary, args, m.resend === true, [], () => {
      const d = resolveDelegation(db, session.primary, { ...m, to }, online, humanReachable, (h) => session.addresses.includes(h));
      picked = d.to;
      const w = writeSend(hub, session, prepareSend(hub, session, session.primary, d.to, d.body, null, true, undefined));
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
        requester: session.primary,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
        ...byChild,
      });
      return { payload, ref: w.ref, msg: w.msg };
    });
  } catch (e) {
    // Written after the rollback (hosted defers it past its outer transaction), so the refusal's row stays.
    if (e instanceof CoreError) {
      refused({ reason: e.message, to: m.to });
      throw coreRefusal(e);
    }
    // A refused send (canSend, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    if (e instanceof ApplicationError) refused({ reason: e.message, to: picked });
    throw e;
  }
  if ("replay" in out) return out.replay;
  afterCommit(db, () => {
    testPause("write:after-commit");
    deliverSend(hub, out.fresh.msg);
  });
  return out.fresh.payload;
}

// The cursor moves only when the recipient acks, so a live recipient may hold
// a pushed message past it: liveness counts as reached too. A repeat of a
// retract that landed (its answer lost, #254) is answered from its audit row.
function handleRetract(hub: Hub, session: ApplicationSession, id: number): { note?: string } {
  const { repo, registry } = hub;
  const mine = session.addresses;
  const m = repo.messages.getById(id);
  if (!m) {
    const done = repo.audit.last("message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by !== undefined && mine.includes(by)) return { note: alreadyRetracted(done.at) };
  }
  // Retracted as the address that sent it (S8).
  if (!m || m.recipient_type !== "user" || !mine.includes(m.sender)) return fail("not_found", retractRefusal.notYours(id));
  if (m.delivered_at !== null || registry.get(m.recipient)?.active || repo.cursors.directFor(m.recipient) >= m.id) return fail("bad_request", retractRefusal.reached(id, m.recipient));
  if (!repo.messages.retract(m.sender, id, { actor: session.authed.user_email, session: session.sessionId })) return fail("bad_request", retractRefusal.replied(id));
  afterCommit(hub.db, async () => { await sweepBlobs(hub.db, repo.blobs); });
  return {};
}

function handleCall(hub: Hub, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): unknown {
  const { db } = hub;
  if (!isBoardTool(tool)) fail("bad_request", `unknown tool: ${tool}`);
  childState(session, tool);
  const ctx: ToolContext = {
    online: h => hub.registry.get(h)?.active === true,
    files: { limits: hub.repo.attachmentLimits, principal: uploaderOf(session).principal },
    human: session.human,
    ...(session.writerId ? { session: session.writerId } : {}),
    ...(session.via ? { via: session.via } : {}),
    addresses: session.addresses,
    ...(session.readOnly ? { reader: seer(hub.repo, session) } : {}),
    ...(tool === "peer_list" ? { unbound: unboundPeers(hub, session) } : {}),
  };
  // `as`, else the first address that can see the board (#284 S3, S14).
  let actor: string;
  try {
    actor = boardActor(db, tool, args, { addresses: session.addresses, asAddresses: asAddresses(session), ownScope: session.authed.user_email });
  } catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    throw e;
  }
  const { as: _as, ...rest } = args;
  if (tool === "board_post") return handleBoardPost(hub, session, actor, rest, ctx, publish);
  let outcome;
  try { outcome = callBoardTool(db, actor, tool, rest, ctx); }
  catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    console.error(`[grayboard] ${tool} failed:`, e);
    return fail("internal", `${tool} failed`);
  }
  // A hosted session with no name answers peer_list as its ID, but is nobody (#402).
  if (session.readOnly && tool === "peer_list" && outcome.result && typeof outcome.result === "object") delete (outcome.result as { you?: string }).you;
  for (const board of new Set(outcome.boards ?? [])) hub.boardChanged(board);
  // The transitional adapter publishes its answer before the resulting deliveries.
  if (publish) afterCommit(db, () => publish(outcome.result));
  wake(hub, outcome.wake);
  return outcome.result;
}

// board_post, deduplicated (#254): a repeat replays the first post's result,
// and a queue board gets no second work item.
function handleBoardPost(hub: Hub, session: ApplicationSession, me: string, args: Record<string, unknown>, ctx: ToolContext, publish?: (result: unknown) => void): unknown {
  const { db, repo } = hub;
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
    checkPostAccess(db, me, postArgs.board, parentId);
    const fp = { board: normalizeBoard(postArgs.board), body: postArgs.body, parent_id: parentId, attachments: uploadDigests(db, ids, uploaderOf(session)) };
    out = writeOnce(hub, session, "board_post", me, fp, resend === true, ids, () => {
      const o = callBoardTool(db, me, "board_post", postArgs, ctx);
      const r = o.result as BoardPostResult;
      for (const a of r.attachments ?? []) writeAudit(repo, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: me, post_id: r.post_id, board: r.board });
      return { payload: r, ref: { kind: "post", id: r.post_id } satisfies WriteRef, wake: o.wake };
    });
  } catch (e) {
    if (e instanceof CoreError) throw coreRefusal(e);
    if (e instanceof ApplicationError) throw e;
    console.error("[grayboard] board_post failed:", e);
    return fail("internal", "board_post failed");
  }
  if ("replay" in out) {
    if (publish) afterCommit(db, () => publish(out.replay));
    return out.replay;
  }
  const r = out.fresh.payload;
  afterCommit(db, () => testPause("write:after-commit"));
  hub.boardChanged(r.board);
  if (publish) afterCommit(db, () => publish(r));
  wake(hub, out.fresh.wake);
  return r;
}

function handleHistory(hub: Hub, session: ApplicationSession, peer: string | undefined, limit: number | undefined, beforeId: number | undefined): HistoryMessage[] {
  const { repo } = hub;
  let lim: number;
  try {
    lim = historyLimit(limit);
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const peerFull = peer ? resolvePeer(repo, session.primary, peer).address : undefined;
  const mine = session.addresses;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const messages = repo.messages.history(mine, peerFull, lim, beforeId).reverse().map((m) =>
    mine.includes(m.sender) && m.recipient_type === "user" && !mine.includes(m.recipient) ? { ...m, delivered: m.delivered_at !== null || reached(m.recipient) >= m.id } : m,
  );
  return messages.map(showMessage);
}

function handleInbox(hub: Hub, session: ApplicationSession, days: number | undefined): InboxResult {
  const { repo, db } = hub;
  const mine = session.addresses;
  let since: number;
  try {
    since = hub.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const owed = unanswered(mine, repo.messages.receivedUnacked(mine, since), (id) => repo.messages.thread(id), session.primary);
  const promises = promised(mine, repo.messages.sentPending(mine, hub.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
  const queued = repo.messages.undeliveredFrom(mine).map((u) => {
    const seen = lastSeen(db, u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(hub.now() - seen)} ago` } : {}) };
  });
  return {
    unanswered: owed,
    ...(promises.length ? { promised: promises } : {}),
    ...(queued.length ? { undelivered_from_you: queued } : {}),
  };
}

function handleThread(session: ApplicationSession, messageId: number, repo: Repo): DirectMessage[] {
  const mine = (m: MessageRow | undefined): m is MessageRow => participant(m, session.addresses);
  if (!mine(repo.messages.getById(messageId))) fail("not_found", `message ${messageId} not found`);
  return repo.messages.thread(messageId).filter(mine).map(showMessage);
}

// A receipt: the harness was handed these ids. Each stamps its delivery time
// once (unless `at` is null: given up, not handed) and moves its recipient
// address's cursor; only your own direct messages count (S8).
function handleAck(session: ApplicationSession, messageIds: number[], repo: Repo, at: number | null): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    if (!msg || msg.recipient_type !== "user" || !session.addresses.includes(msg.recipient)) continue;
    if (at !== null) repo.messages.markDelivered(msgId, at);
    repo.cursors.advance(msg.recipient, "direct", msg.recipient, msgId);
  }
}
