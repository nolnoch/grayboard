// The server's transport-neutral session and operation core (#402): WSS
// (src/server/ws.ts) and hosted MCP (src/server/mcp.ts, src/server/hosted.ts)
// both call it. The session model is #284's: the hello is the session (its
// ID, from the client's key), aliases come by bind and go by unbind, a
// session holds several, and a closed connection's session outlives it for a
// grace before it ends (PR 3, PR 4).
import type { HelloOk, HelloRequest, BindRequest, DelegateRequest, DelegateResult, ErrorCode, Replayed, SendResult as WireSendResult, WriteRef } from "../shared/protocol.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, RateLimiter, retrySecs, type RateLimit } from "./rate_limit.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause } from "../shared/testpause.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
import {
  MAX_CANDIDATES, MAX_HOLDS, actingAs, aliasHeldText, aliasUser, aliasUses, boardActor, closestNames, continuityOf, dropHold, holdAlias, holderOf, holdsOf, idAddress, idRow,
  idStatuses, logBinding, mintSessionKey, orderCandidates, primaryOf, replySender, tooManyHolds, unboundPeer, unendedIds, unknownNameError,
  type AliasUse, type Candidate, type Continuity, type IdRow,
} from "../core/bindings.ts";
import { participant, type MessageRow, type Repo, type Sync } from "./db.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatTeamAddress } from "../shared/addressing.ts";
import { describeLocation } from "../shared/identity.ts";
import { canSend, type HumanReach } from "./can_send.ts";
import { serverAuditSink, writeAudit } from "./audit.ts";
import { authLost, type AuthedUser, type AuthLost } from "./auth.ts";
import {
  ALIAS_SESSION_SQL, acknowledge, age, boardCatalog, snapshot, canSeeBoard, checkBody, checkPostAccess, cleanPlace, lastSeen, parseAliasMeta, pendingFor, pendingKey, refOf,
  setAliasMeta, setPlace, touchAlias, touchId, registerId, idCollisionText, inheritStatus, normalizeBoard, getBoard,
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
  probe(ms: number): Promise<boolean>;
  keepAlive?(): void;
  closed(error: ApplicationError): void;
  // The server released an alias the session held (#284 S9): WSS sends an
  // alias_lost frame. A sink without it learns from its next call.
  aliasLost?(alias: string, reason: string): void;
};
// A hosted session's facts, for its MCP instructions (src/server/mcp.ts).
export type IdentityInfo = {
  candidates?: Candidate[];
  identity_full: string;
  user_email: string;
  teams: string[];
  notices?: string[];
  human: { handle: string; linked: boolean };
  attachment_limits: AttachmentLimits;
};
export type SendResult = WireSendResult;
export type InboxResult = {
  unanswered: InboxItem[];
  promised?: PromiseItem[];
  undelivered_from_you?: { to: string; n: number; oldest_id: number; last_seen?: string }[];
};
export type ApplicationOptions = {
  probeMs?: number;
  humanReach?: HumanReach;
  slackRunning?: () => boolean;
  helloLimit?: RateLimit;
  hostedRequestLimit?: RateLimit;
  // The hub's clock: the rate limiters', the write-dedup window's
  // (src/server/write_dedup.ts) and the grace's. Tests move it instead of sleeping.
  now?: () => number;
};
export type HelloOptions = Omit<HelloRequest, "type" | "req_id" | "proto"> & {
  // Whether the transport is still open; checked after each await.
  alive?: () => boolean;
};
export type HelloResult = Omit<HelloOk, "type" | "req_id">;
export type BindResult = { alias: string; held: string[]; notices?: string[]; restored?: Continuity };
export type UnbindResult = { alias: string; released: boolean; held: string[]; left?: string[] };

/** How long a session outlives its connection's close (#284 S4): a resume within it re-attaches. */
export const GRACE_MS = 30_000;
/** How often the sweep ends sessions past their grace (S4). */
export const SWEEP_MS = 5_000;

/**
 * The reads a hosted session with no name may make (master's read-only
 * model, kept for hosted MCP). Unlike a WSS session (S13), it doesn't act
 * as its ID: the hosted session ID is routing, not a capability (#229).
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
  // The ID its writes carry as provenance; unset for a writer with no
  // session (the bridge's humans, a hosted request with no context).
  writerId?: string;
  transport: "wss" | "hosted" = "wss";
  // The address the session writes as by default (#284 S1, S8): its oldest
  // hold, else its ID; a tools-only session's writes_as.
  primary = "";
  // Every address it reads as: its holds, oldest first, then its ID; a
  // tools-only session's [writes_as]. Primary first.
  addresses: string[] = [];
  // The aliases the session holds, oldest first (PR 4 S1); set by setHolds.
  holds: string[] = [];
  // A tools-only session (S7): writes as writes_as, binds nothing.
  toolsOnly = false;
  // Ended by its `end` (S4): any later call is refused.
  ended = false;
  // Why it closed, when the server closed it: what a later call is told.
  closedBy?: ApplicationError;
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
  // session ID -> its WSS connection's session: every agent connection
  // (push, hold and tools-only), so probe, supersede and grace treat them alike.
  holders: Map<string, ApplicationSession>;
  // session ID -> the hosted session holding its name (hosted.ts reconcile).
  hostedHolders: Map<string, ApplicationSession>;
  // session ID -> the probe a hello is running against its connection
  probing: Map<string, Promise<boolean>>;
  // session ID -> when its grace ends: its connection closed, its holds stay (S4).
  grace: Map<string, number>;
  sessions: Set<ApplicationSession>;
  probeMs: number;
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

function helloOkFields(hub: Hub, authed: AuthedUser): Pick<HelloOk, "user_email" | "teams" | "attachment_limits"> & { human: { handle: string; linked: boolean } } {
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

// The token session an ID last said hello under, so a logout finds its IDs
// in their grace too (#351).
function setTokenSession(db: CoreDb, id: string, tokenSession: number): void {
  db.prepare(`UPDATE ids SET token_session = ? WHERE id = ?`).run(tokenSession, id);
}

function idsOfToken(db: CoreDb, tokenSession: number): string[] {
  return (db.prepare(`SELECT id FROM ids WHERE ended_at IS NULL AND viewer = 0 AND token_session = ?`).all(tokenSession) as { id: string }[]).map((r) => r.id);
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

// What a bind or a tools-only hello's writes_as names (#284 S9): a bare name
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

// Who holds an alias, for an alias_held refusal: its ID, where it runs, and
// for a session in its grace, when it disconnected and when it ends.
function describeHolder(hub: Hub, id: string): string {
  const place = idRow(hub.db, id)?.place;
  const until = hub.grace.get(id);
  const grace = until === undefined ? "" : `; disconnected at ${new Date(until - GRACE_MS).toISOString()}, ends by ${new Date(until).toISOString()}`;
  // A hosted root has no connection to disconnect: it is last seen when its client last called (#402).
  const hosted = hub.repo.hosted.get(id);
  if (hosted) return `the hosted session ${id}${place ? `, in ${place}` : ""}, last seen ${Math.floor((hub.now() - hosted.last_seen_at) / 1000)}s ago`;
  return `the session ${id}${place ? `, in ${place}` : ""}${grace}`;
}

// A bind's claim to continue an earlier session on the alias (#211), checked
// against the alias's history in the bind's transaction. restored_from names
// a public ID, which any client of the principal can present, so it proves
// nothing (PR 4 S11, #259): kept as audit, carrying no status. previous_key
// is the ended session's secret, so it proves descent after a reconnect
// past the grace (PR 3 S4); a verified one carries the status over.
function continuity(hub: Hub, authed: AuthedUser, id: string, address: string, m: Omit<BindRequest, "type" | "req_id">): Continuity | undefined {
  const { db } = hub;
  if (m.restored_from !== undefined) return { verified: false, detail: `restore claimed from ${m.restored_from}, not verified` };
  if (m.previous_key === undefined) return undefined;
  const prev = idAddress(m.previous_key);
  const row = idRow(db, prev);
  if (!row || row.principal !== authed.user_email || row.ended_at === null) {
    return { verified: false, detail: `restore after end not verified: ${prev} isn't an ended session of yours` };
  }
  const c = continuityOf(db, address, prev);
  if (!c.verified) return c;
  inheritStatus(db, id, prev);
  return { verified: true, detail: `restored after end of session ${prev}` };
}

export function createApplication(repo: Repo, db: CoreDb, opts: ApplicationOptions = {}) {
  const now = opts.now ?? Date.now;
  const hub: Hub = {
    repo,
    db,
    registry: new Map(),
    holders: new Map(),
    hostedHolders: new Map(),
    probing: new Map(),
    grace: new Map(),
    sessions: new Set(),
    probeMs: opts.probeMs ?? 2000,
    humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    now,
    // Logged and audited once per run of refusals, so a loop floods neither.
    // Keyed by email, which is unique per user. A bind spends from the same
    // bucket (S2).
    helloLimiter: new RateLimiter(opts.helloLimit ?? DEFAULT_HELLO_LIMIT, {
      start: (email, ctx, retryAfterMs) => {
        console.error(`[grayboard] rate-limiting hellos from ${email}`);
        writeAudit(repo, "hello.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs });
      },
      end: (email, refused) => {
        console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
        writeAudit(repo, "hello.rate_limit_ended", email, null, { refused });
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
  // No connection outlives the server, but a session does, for its grace
  // (S4): every one a previous run left gets a grace from now, so a deploy
  // ends only the sessions that don't come back, through endSession. A
  // hosted ID is outside the WSS lifecycle: its hosted store ends it.
  const startedAt = now();
  for (const id of unendedIds(db)) if (!repo.hosted.owned(id)) hub.grace.set(id, startedAt + GRACE_MS);

  // The session leaves the hub's maps: superseded, ended, revoked or closed.
  function detach(session: ApplicationSession): void {
    const id = session.sessionId;
    if (id && hub.holders.get(id) === session) hub.holders.delete(id);
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
    const id = session.sessionId;
    if (session.transport === "hosted") {
      for (const a of session.addresses) if (hub.registry.get(a) === session) hub.registry.delete(a);
      // alias_holds is the hosted hold set's only truth (#451): a close is a rebuild
      // (reconcile) or a shutdown, never a release, so it leaves the holds alone.
      if (hub.hostedHolders.get(id) === session) hub.hostedHolders.delete(id);
      if (session.writerId) touchId(db, session.writerId);
      return;
    }
    // A superseded, ended or revoked connection was detached when it was;
    // its close records nothing.
    if (!id || hub.holders.get(id) !== session) return;
    detach(session);
    touchId(db, id);
    for (const a of session.holds) touchAlias(db, a);
    // Its holds stay: a 30 s blip must not lose the aliases (S4).
    const until = now() + GRACE_MS;
    hub.grace.set(id, until);
    writeAudit(repo, "id.detached", session.authed.user_email, id, { held: session.holds, grace_until: until });
  }
  // The server closes the session: it leaves the hub without a grace, its
  // transport is told why and closes.
  function terminate(session: ApplicationSession, error: ApplicationError) {
    detach(session);
    session.closedBy = error;
    close(session);
    session.sink.closed(error);
  }
  function valid(session: ApplicationSession, allowUnbound = false) {
    if (session.ended) fail("id_ended", `session ${session.sessionId} has ended`);
    if (!session.active || !hub.sessions.has(session)) {
      // A superseded connection is told so (#284 S3), a revoked tools-only
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
  // and leaves the others ended; its ID goes (back) into the grace, so a
  // sweep retries it rather than the sweep's interval dying with it.
  function endIds(ids: string[], why: string): void {
    if (!ids.length) return;
    const woken = new Set<string>();
    for (const id of ids) {
      let ended;
      try {
        ended = repo.atomic(() => endSession(db, repo.mail, id, { why, now: now(), audit: serverAuditSink(repo) }));
      } catch (e) {
        const retryAt = now() + GRACE_MS;
        if (!hub.holders.has(id)) hub.grace.set(id, retryAt);
        console.error(`[grayboard] ending session ${id} (${why}) failed; retrying after ${new Date(retryAt).toISOString()}:`, e);
        writeAudit(repo, "id.end_failed", null, id, { why, error: String(e), retry_at: retryAt });
        continue;
      }
      hub.grace.delete(id);
      // An end that found the session already ended sends nothing again.
      if (!ended.ended) continue;
      for (const h of ended.wake) woken.add(h);
      // A bounce goes to a live sender now, as a send does; a drain would
      // resend that session's unacked messages too.
      for (const b of repo.messages.bouncesFrom(id)) {
        const to = hub.registry.get(b.recipient);
        if (to?.active) to.sink.deliver({ kind: "direct", message: showMessage(b) });
      }
      if (ended.held.length) console.error(`[grayboard] session ${id} ended (${why}); released ${ended.held.join(", ")}`);
    }
    wake(hub, [...woken]);
    void sweepBlobs(db, repo.blobs);
  }
  // Ends every session past its grace (S4), on its own SWEEP_MS interval, so
  // the end lands 30-35 s after the close. An ID with a live connection only
  // leaves the grace: a stale close must not end a session that came back.
  function sweepSessions(at = now()): void {
    const due: string[] = [];
    for (const [id, until] of hub.grace) {
      if (hub.holders.has(id)) hub.grace.delete(id);
      else if (until <= at) due.push(id);
    }
    endIds(due, "grace");
  }
  // Auth is checked at the upgrade and again at each hello, so a connection
  // outlives its credential unless it is closed when the credential goes
  // (#70, #351). closeConns closes the WSS sessions `match` selects:
  // detached first (their close then records no grace), told why, audited,
  // closed. It returns their IDs. The Slack bridge's humans and hosted
  // sessions never appear here: hub.holders has none of them.
  function closeConns(match: (s: ApplicationSession) => boolean, message: string, why: string): string[] {
    const closed: string[] = [];
    for (const s of [...hub.holders.values()]) {
      if (!match(s)) continue;
      const id = s.sessionId;
      writeAudit(repo, "auth.connection_closed", s.authed.user_email, id, { token_session: s.authed.session_id, why });
      terminate(s, new ApplicationError("unauthenticated", message));
      closed.push(id);
    }
    return closed;
  }
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
  // hold is released, and a live one is told (alias_lost) and sends as its
  // primary from here. A tools-only session writes only as its writes_as,
  // so it has nothing left to be: its session ends, and its reconnect's
  // hello is refused. A hosted root's hold is released in the database (#408)
  // and its generation bumped (#451): the live holder is rebuilt and its lease
  // closed, and the next request or whoami tells the session what it lost.
  function revokeAliases(uses: (AliasUse & { reason: string })[], by: string | null): void {
    if (!uses.length) return;
    const ended: string[] = [];
    for (const u of uses) {
      const { reason } = u;
      const s = hub.holders.get(u.id);
      const hosted = repo.hosted.owned(u.id);
      if (!u.held) {
        writeAudit(repo, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, writes_as: true, reason });
        if (s) terminate(s, new ApplicationError("forbidden", `this connection wrote as "${u.address}", and ${reason}`));
        // A hosted tools-only root ends its ownership, not an ID (hosted IDs are the store's).
        if (hosted) repo.hosted.atomic(() => repo.hosted.end(u.id, "revoked", now()));
        else ended.push(u.id);
        continue;
      }
      // A hosted root's change goes through the hosted store's transaction, whose commit tells the hosted
      // service and delivery to close the lease now, not at its next renewal.
      const revoke = () => {
        dropHold(db, u.address, u.id);
        logBinding(db, u.id, u.address, "released", `access revoked: ${reason}`);
        writeAudit(repo, "alias.revoked", by, u.address, { session: u.id, principal: u.principal, reason });
        if (hosted) {
          const row = repo.hosted.get(u.id);
          if (row) {
            // Its last hold gone, the root is unbound but owning: no lease, so the sweep doesn't expire it.
            repo.hosted.update({ ...row, bind_gen: row.bind_gen + 1, lease_deadline: holdsOf(db, u.id).length ? row.lease_deadline : null });
            if (row.lease_deadline !== null) writeAudit(repo, "hosted.lease_closed", null, u.id, { reason: "revoked", ownership: row.ownership_id });
          }
        }
      };
      if (hosted) repo.hosted.atomic(revoke); else repo.atomic(revoke);
      if (!s || !s.holds.includes(u.address)) continue;
      setHolds(hub, s, s.holds.filter((a) => a !== u.address));
      s.sink.aliasLost?.(u.address, reason);
    }
    endIds(ended, "revoked");
  }

  // The hello is the session (#284 S1, S3): it registers the key's ID, or
  // re-attaches a session in its grace, holds and all. Aliases come by bind.
  async function hello(authed: AuthedUser, sink: DeliverySink, m: HelloOptions): Promise<{ session: ApplicationSession; ok: HelloResult }> {
    const { holders } = hub;
    const id = m.session_key ? idAddress(m.session_key) : null;
    // Client text: cleaned once, before any audit or log carries it.
    const where = cleanPlace(m.where ?? null);
    // First, before anything reads or writes the database.
    const t = hub.helloLimiter.take(authed.user_email, { session_id: id, place: where });
    if (!t.ok) fail("rate_limited", `too many connections for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
    const alive = () => m.alive?.() ?? true;
    const closed = () => fail("unauthenticated", "session is closed");
    // Auth is checked at the upgrade, so a token revoked since (logout, an
    // out-of-band reset) or a user disabled since is refused here (#351).
    const refuseAuth = (why: AuthLost): never => {
      writeAudit(repo, "auth.hello_refused", authed.user_email, id, { token_session: authed.session_id, why, place: where });
      return fail("unauthenticated", why === "token_revoked" ? "this sign-in was signed out" : "this user is disabled");
    };
    const lost = authLost(authed, repo);
    if (lost) return refuseAuth(lost);
    if (id === null) return fail("bad_request", "a hello needs a session_key");
    const push = m.push !== false;
    const toolsOnly = !push && m.hold !== true;
    // A tools-only connection writes as an alias it may act in, but never holds it (S7).
    let writesAs: Exclude<Target, { error: string }> | undefined;
    if (toolsOnly) {
      const target = bindTarget(hub, authed, m.writes_as ?? "");
      if ("error" in target) {
        if (target.address) logBinding(db, id, target.address, "refused", target.error);
        return fail(target.code, target.error);
      }
      const other = aliasUser(db, target.address, authed.user_email);
      if (other) {
        const why = `another user's session ${other}`;
        logBinding(db, id, target.address, "refused", why);
        return fail("alias_held", aliasHeldText(target.address, why, "write as another name"));
      }
      writesAs = target;
    }
    const collide = (why: string): never => {
      writeAudit(repo, "id.collision", authed.user_email, id, { why, place: where });
      return fail("id_collision", idCollisionText(id, why));
    };
    // Never probe or supersede another principal's connection: its row is
    // checked before anything touches the hub.
    const row = idRow(db, id);
    if (row && row.principal !== authed.user_email) return collide("is another principal's session");
    if (row?.ended_at != null) return collide(`ended at ${new Date(row.ended_at).toISOString()}`);
    // A hosted ID is the hosted store's, never a WSS session's.
    if (repo.hosted.owned(id)) return collide("is a hosted session's");
    // A re-attach is the session it registered as: a tools-only session
    // writes as the same alias, and a push or hold one writes as nobody else.
    // Checked before the probe, so a mismatched hello never supersedes.
    const sameShape = (r: IdRow) => r.writes_as === (writesAs?.address ?? null);
    const shapeWhy = (r: IdRow) => `registered writing as ${r.writes_as ? `"${r.writes_as}"` : "its own addresses"}, and this hello writes as ${writesAs ? `"${writesAs.address}"` : "its own"}`;
    if (row && !sameShape(row)) return collide(shapeWhy(row));

    // One live connection per session. A connection on this ID that still
    // answers is a second process on one key: refused. One that doesn't is
    // dead (a reconnect beat its close): superseded. Each await can change the
    // hub (a close, another hello), so after one, check again from the top;
    // between the last check and holders.set below nothing awaits (#69).
    for (;;) {
      const inFlight = hub.probing.get(id);
      if (inFlight) {
        // Another hello is probing the holder: whoever wins, it's settled after.
        await inFlight;
        if (!alive()) return closed();
        // A revoked token must not register an ID after any wait (#351).
        const lostWait = authLost(authed, repo);
        if (lostWait) return refuseAuth(lostWait);
        continue;
      }
      const holder = holders.get(id);
      if (!holder) break;
      const probing = holder.sink.probe(hub.probeMs).catch(() => false).finally(() => {
        if (hub.probing.get(id) === probing) hub.probing.delete(id);
      });
      hub.probing.set(id, probing);
      if (await probing) return collide("is live on another connection");
      if (!alive()) return closed();
      // Before the holder is superseded: a revoked token must not take it over (#351).
      const lostProbe = authLost(authed, repo);
      if (lostProbe) return refuseAuth(lostProbe);
      if (holders.get(id) === holder) {
        // Detached first, so its close finds another connection holding the
        // ID and records no grace (S3).
        writeAudit(repo, "id.superseded", authed.user_email, id, { old_place: holder.place ?? null, place: where });
        terminate(holder, new ApplicationError("superseded", "a newer connection took over this session"));
      }
    }
    // The row again: the session may have ended during an await.
    const current = idRow(db, id);
    if (current?.ended_at != null) return collide(`ended at ${new Date(current.ended_at).toISOString()}`);
    if (current && !sameShape(current)) return collide(shapeWhy(current));
    const launcher = push && m.launcher === true;
    if (!current) {
      repo.atomic(() => {
        if (writesAs) createLazily(hub, authed, writesAs, id);
        const reused = registerId(db, {
          id, principal: authed.user_email, place: where, launcher, keyed: m.keyed === true, ...(writesAs === undefined ? {} : { writesAs: writesAs.address }),
          harness: m.harness, model: m.model, effort: m.effort,
        });
        // A key whose ended session retention pruned (#284 S10): a new session on an old ID.
        if (reused) writeAudit(repo, "id.reused", authed.user_email, id, { ended_at: reused.ended_at, pruned_at: reused.pruned_at });
        writeAudit(repo, "id.registered", authed.user_email, id, {
          delivery: writesAs === undefined ? "push" : "none", ...(m.hold ? { hold: true } : {}), ...(writesAs === undefined ? {} : { writes_as: writesAs.address }), keyed: m.keyed === true, place: where,
        });
      });
    } else {
      setPlace(db, id, where);
      touchId(db, id);
      // Every push hello rewrites the flag; registerId wrote it for a new row.
      if (push) setLauncher(db, id, launcher);
      // Possession of the key is the proof; resume is detail only (S3).
      writeAudit(repo, "id.reattached", authed.user_email, id, { resume: m.resume === true, in_grace: hub.grace.has(id), place: where });
    }
    setTokenSession(db, id, authed.session_id);
    hub.grace.delete(id);
    // Audited, changed or not (#184 review 4/6): a hold or tools-only
    // connection can't receive a delegation, so it's never a launcher.
    if (push) writeAudit(repo, "handle.launcher_set", authed.user_email, id, { on: launcher });

    const session = new ApplicationSession(authed, sink, false, push);
    session.sessionId = id;
    session.writerId = id;
    session.place = where;
    session.transport = "wss";
    hub.sessions.add(session);
    holders.set(id, session);
    if (writesAs) {
      session.toolsOnly = true;
      session.primary = writesAs.address;
      session.addresses = [writesAs.address];
    } else {
      // A re-attach restores every hold, in bound order (S8).
      setHolds(hub, session, holdsOf(db, id));
    }
    const bound = session.holds;
    for (const a of bound) touchAlias(db, a);

    // Drained by a session that shows its notices (push or hold), never a
    // tools-only one's (#402): its notices may go nowhere.
    const bridgeNotice = toolsOnly ? undefined : owedBridgeNotice(repo, authed.user_email);
    const notices = noticesFor(hub, session.addresses, [
      ...(launcher ? launcherInstruction() : []),
      // Before the claims: drained once, so a cut must not take it.
      ...(bridgeNotice ? [bridgeNotice] : []),
    ]);
    return {
      session,
      ok: { id, ...(bound.length ? { bound: [...bound] } : {}), ...helloOkFields(hub, authed), ...(notices.length ? { notices } : {}) },
    };
  }

  // The Slack bridge's in-process human (S16): no ID, no ids row, no grace.
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
  // A WSS holder of the alias, or a hosted one, answers a probe before the bind decides
  // (#402); bindNow is the rest, synchronous, which a hosted bind needs inside its
  // transaction (hosted.ts clears a stale hosted contender itself first, so any hosted
  // holder bindNow sees is live).
  async function bind(session: ApplicationSession, m: Omit<BindRequest, "type" | "req_id">): Promise<BindResult> {
    valid(session, true);
    const target = bindTarget(hub, session.authed, m.alias);
    const holder = "error" in target ? null : holderOf(db, target.address);
    const hosted = holder === null ? undefined : hub.hostedHolders.get(holder);
    if (hosted && hosted.sessionId !== session.sessionId) {
      const responding = await hosted.sink.probe(hub.probeMs).catch(() => false);
      valid(session, true);
      if (!responding && hub.hostedHolders.get(hosted.sessionId) === hosted) close(hosted);
    }
    return bindNow(session, m);
  }
  // `refused`: where a refusal's binding row goes when the caller's transaction will roll it back with the throw
  // (a hosted bind runs inside one); it writes the row after the rollback.
  function bindNow(session: ApplicationSession, m: Omit<BindRequest, "type" | "req_id">, refused?: (address: string, detail: string) => void): BindResult {
    valid(session, true);
    const { authed } = session;
    if (session.human) fail("bad_request", `the Slack bridge's connection is its user's "${HUMAN_NAME}"; it binds nothing`);
    if (session.toolsOnly) fail("bad_request", "a tools-only connection writes as its writes_as; it binds nothing");
    const id = session.sessionId;
    // Lazy creation is here, not in the limited hello: an unlimited create loop
    // would mint aliases without bound. Taken before the held check, so a
    // re-bind loop spends it too.
    const t = hub.helloLimiter.take(authed.user_email, { session_id: id, bind: m.alias });
    if (!t.ok) fail("rate_limited", `too many binds for this user; retry in ${retrySecs(t.retryAfterMs)}s`, { retry_after_ms: t.retryAfterMs });
    const target = bindTarget(hub, authed, m.alias);
    if ("error" in target) {
      if (target.address) (refused ?? ((a, d) => logBinding(db, id, a, "refused", d)))(target.address, target.error);
      return fail(target.code, target.error);
    }
    const { address, scope } = target;
    const refuse = (code: ErrorCode, message: string, detail: string, extra: ApplicationError["extra"] = {}): never => {
      (refused ?? ((a, d) => logBinding(db, id, a, "refused", d)))(address, detail);
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
    // Another session's hold is never taken over, live or in its grace. A hosted
    // holder was probed by bind (#402), or cleared by the hosted service: one idle
    // past the hosted window ended and freed the alias; a live one refuses the bind.
    const holder = holderOf(db, address);
    if (holder !== null && holder !== id) {
      const who = describeHolder(hub, holder);
      // A holder in its grace frees the alias by the sweep after it ends,
      // unless it comes back: a restore retries then (S11).
      const until = hub.grace.get(holder);
      const wait = until === undefined ? {} : { retry_after_ms: Math.max(0, until - now()) + SWEEP_MS };
      return refuse("alias_held", aliasHeldText(address, who, "bind another name"), who, { holder: who, ...wait });
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

    const restored = repo.atomic(() => {
      createLazily(hub, authed, target, id);
      const c = continuity(hub, authed, id, address, m);
      holdAlias(db, address, id, now());
      logBinding(db, id, address, "bound", c?.detail ?? null);
      if (meta) setAliasMeta(db, address, meta, id, audit);
      touchAlias(db, address);
      return c;
    });

    setHolds(hub, session, holdsOf(db, id));
    const notices = noticesFor(hub, session.addresses);
    return { alias: address, held: [...session.holds], ...(notices.length ? { notices } : {}), ...(restored ? { restored } : {}) };
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

  // end (S4): an unkeyed session's clean exit ends it at once. The session
  // leaves the hub first, so its close records no grace.
  function end(session: ApplicationSession): void {
    valid(session);
    if (session.human) fail("bad_request", "the Slack bridge's humans have no session to end");
    if (session.transport === "hosted") fail("bad_request", "a hosted session ends through session_end");
    detach(session);
    session.ended = true;
    endIds([session.sessionId], "exit");
  }

  const application = {
    repo,
    // The live session holding `full`, WSS or hosted: the hub's view, which
    // a transaction changes only after it commits (the hosted store's
    // reconcile), as master's holder map did.
    hostedHolder(full: string): ApplicationSession | undefined {
      for (const s of [...hub.hostedHolders.values(), ...hub.holders.values()]) if (s.active && s.holds.includes(full)) return s;
      return undefined;
    },
    admitHosted,
    hostedCandidates(authed: AuthedUser) { return candidates(hub, authed); },
    // The aliases a hosted root holds, oldest first: alias_holds is their only truth (#451).
    hostedHolds(id: string): string[] { return holdsOf(db, id); },
    // `writesAs`: a tools-only root's alias; it holds nothing and binds nothing, as a WSS
    // tools-only connection. Otherwise the session holds `holds`, reads as them and its
    // ID, and writes as the oldest; none held reads and nothing else (readOnly).
    hostedSession(authed: AuthedUser, id: string, holds: string[], writesAs: string | null, place: string | null, sink: DeliverySink, hold = false, push = false) {
      const session = new ApplicationSession(authed, sink, false, push);
      session.transport = "hosted";
      session.sessionId = id;
      session.place = place;
      session.readOnly = holds.length === 0 && writesAs === null;
      session.toolsOnly = writesAs !== null;
      if (writesAs !== null) {
        session.primary = writesAs;
        session.addresses = [writesAs];
      } else {
        session.holds = holds;
        session.primary = primaryOf(holds, id);
        session.addresses = [...holds, id];
      }
      if (!session.readOnly && idRow(db, id)?.principal === authed.user_email) session.writerId = id;
      hub.sessions.add(session);
      if (hold && holds.length) hub.hostedHolders.set(id, session);
      if (push && holds.length) for (const a of session.addresses) hub.registry.set(a, session);
      const info: IdentityInfo = {
        identity_full: session.primary,
        ...helloOkFields(hub, authed),
        ...(session.readOnly ? { candidates: candidates(hub, authed) } : {}),
      };
      return { session, info };
    },
    // `harness` comes from the principal's source mapping (#414): peer_list shows it and match:{harness} filters on it.
    hostedRegister(authed: AuthedUser, id: string, harness: string, writesAs: string | null = null) {
      const prior = idRow(db, id);
      if (prior && prior.principal !== authed.user_email) fail("id_collision", idCollisionText(id, "is another principal's session"));
      // A tools-only root is registered as WSS's is (A4): aliasUser, aliasUses and
      // undeliverableId read ids.writes_as, so a send to its ID is pointed at the alias.
      if (!prior) registerId(db, { id, principal: authed.user_email, harness, launcher: false, ...(writesAs === null ? {} : { writesAs }) });
      else {
        touchId(db, id);
        // An ownership's end clears the row's writes_as (the store's end), so a new ownership of the same ID restates it.
        if (writesAs !== null) db.prepare(`UPDATE ids SET writes_as = ? WHERE id = ? AND writes_as IS NULL`).run(writesAs, id);
      }
    },
    // A tools-only declaration's alias, resolved and checked the way a WSS hello's writes_as
    // is: a name the principal may act in, never one another user's session uses (S7, S8);
    // it shares the alias with a holder, as WSS. create: the first request makes the alias
    // lazily, as hello does.
    hostedWritesAs(authed: AuthedUser, id: string, raw: string, create = false): string {
      const target = bindTarget(hub, authed, raw);
      if ("error" in target) return fail(target.code, target.error);
      const other = aliasUser(db, target.address, authed.user_email);
      if (other) return fail("alias_held", aliasHeldText(target.address, `another user's session ${other}`, "write as another name"));
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
    hostedPlace(id: string, place: string | null) { setPlace(db, id, place); },
    hello,
    // Hello then bind, as a WSS client does: a test convenience composing the
    // real operations. name undefined: an unbound session, acting as its ID.
    async selectIdentity(
      authed: AuthedUser, name: string | undefined, sink: DeliverySink,
      options: HelloOptions & { create?: boolean } = {},
    ) {
      const { create, ...m } = options;
      // A push: false connection without hold is tools-only (S7): it writes
      // as the name, and binds nothing.
      const toolsOnly = m.push === false && m.hold !== true && name !== undefined;
      const { session, ok } = await hello(authed, sink, { ...m, ...(toolsOnly ? { writes_as: name } : {}), session_key: m.session_key ?? mintSessionKey() });
      if (name !== undefined && !toolsOnly) {
        try { await bind(session, { alias: name, ...(create === undefined ? {} : { create }) }); }
        catch (e) {
          // A session this call minted ends with its refusal; one on the
          // caller's key closes, into its grace.
          if (session.active && !session.ended) {
            if (m.session_key === undefined) end(session);
            close(session);
          }
          throw e;
        }
      }
      const info: IdentityInfo = { identity_full: session.primary, ...helloOkFields(hub, authed), ...(ok.notices ? { notices: ok.notices } : {}) };
      return { session, info, ok };
    },
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman,
    bind,
    bindNow,
    hostedRefused(id: string, address: string, detail: string) { logBinding(db, id, address, "refused", detail); },
    unbind,
    end,
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
    receiptDirect(session: ApplicationSession, ids: number[]) {
      valid(session);
      handleAck(session, ids, repo);
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
      const result = handleCall(hub, session, tool, args, publish);
      afterCommit(db, () => expiry.arm());
      return result;
    },
    // Trusted committed domain operations, not client-supplied invalidations.
    boardsChanged,
    wake(handles: string[]) {
      afterCommit(db, () => expiry.arm());
      wake(hub, handles);
    },
    // An admin revoked or disabled a user: every session of theirs closes,
    // and their WSS sessions end at once, live or in their grace, not
    // through the grace (S4). Hosted sessions close; the hosted store ends
    // them (disabled users) on its sweep.
    disconnectUser(userId: number) {
      closeConns((s) => s.authed.user_id === userId, "an admin signed this user out", "user_signed_out");
      for (const s of [...hub.sessions]) {
        if (!s.human && s.authed.user_id === userId) terminate(s, new ApplicationError("unauthenticated", "an admin signed this user out"));
      }
      const email = repo.users.findById(userId)?.email;
      if (!email) return;
      endIds(unendedIds(db, email).filter((id) => !repo.hosted.owned(id)), "revoked");
    },
    // One token was revoked (logout, #351): its connections close and its
    // sessions end, live or in their grace; the user's other tokens keep theirs.
    disconnectSession(tokenSession: number, why: string) {
      const closed = closeConns((s) => s.authed.session_id === tokenSession, "this sign-in was signed out", why);
      endIds([...new Set([...closed, ...idsOfToken(db, tokenSession)])], "signed_out");
    },
    // What a principal may act in changed (S9): a team leave or removal now,
    // #270's grants later. Its sessions stop acting as aliases it lost now,
    // not when they next bind.
    accessChanged(principal: string, by: string) { recheckAliases(principal, by); },
    // Catches a token revoked or user disabled with no server route to say so
    // (a database reset, an operator edit), and an alias its session's
    // principal may no longer act as (S9's backstop to accessChanged).
    revalidate() {
      for (const observer of [...observers]) observerLive(observer);
      const tokens = new Map<number, AuthedUser>();
      for (const s of hub.holders.values()) tokens.set(s.authed.session_id, s.authed);
      const users = new Set<number>();
      for (const [sid, authed] of tokens) {
        const lost = authLost(authed, repo);
        if (lost === "token_revoked") application.disconnectSession(sid, "token_revoked");
        else if (lost === "user_disabled") users.add(authed.user_id);
      }
      for (const s of hub.sessions) {
        if (!s.human && repo.users.findById(s.authed.user_id)?.disabled_at != null) users.add(s.authed.user_id);
      }
      for (const id of users) application.disconnectUser(id);
      recheckAliases(null, null);
    },
    sweepSessions,
    heartbeat() {
      application.revalidate();
      hub.helloLimiter.sweep();
      for (const s of hub.sessions) s.sink.keepAlive?.();
    },
    sweepHellos: () => { hub.helloLimiter.sweep(); hostedRequestLimiter.sweep(); },
    stopExpiry() {
      expiry.stop();
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
function candidates(hub: Hub, authed: AuthedUser, suggestedInput?: string): Candidate[] {
  const { repo, db } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const free = (n: string) => n !== HUMAN_NAME && holderOf(db, full(n)) === null;
  const names = repo.aliases.listForScope("person", authed.user_email).map((i) => i.name).filter(free);
  const queued = repo.messages.queuedTo(names.map(full));
  const seen = sessionsSeen(db, names.map(full));
  const claims = new Map<string, number>();
  for (const c of listClaims(db)) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
  const s = suggestedInput?.toLowerCase();
  const suggested = s !== undefined && free(s) ? s : null;
  return orderCandidates(
    names.map((n) => ({
      name: n, queued: queued.get(full(n)) ?? 0, claims: claims.get(full(n)) ?? 0,
      last_seen: seen.get(full(n))?.last_seen ?? 0, where: seen.get(full(n))?.where ?? null,
    })),
    suggested,
  ).slice(0, MAX_CANDIDATES);
}

// The user's live sessions with no alias, for peer_list: never another
// user's (`where` describes their machine). A hold or tools-only connection
// isn't listed: it receives nothing. A hosted session with no name is
// listed as master listed it (#402).
function unboundPeers(hub: Hub, session: ApplicationSession): UnboundPeer[] {
  const mine = [
    ...[...hub.holders.values()].filter((c) => c.push && c.holds.length === 0),
    ...[...hub.sessions].filter((c) => c.transport === "hosted" && c.readOnly),
  ].filter((c) => c.authed.user_id === session.authed.user_id);
  const statuses = idStatuses(hub.db, mine.map((c) => c.sessionId));
  const now = hub.now();
  return mine.map((c) => {
    const s = statuses.get(c.sessionId);
    return unboundPeer(c.sessionId, c.place ?? null, c === session || c.sessionId === session.sessionId, s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
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

  if (parentId !== null && !participant(repo.messages.getById(parentId), session.addresses)) {
    fail("not_found", `parent_id ${parentId} is not a message you sent or received`);
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
    msg = repo.messages.insert(p.from, "user", p.to, p.body, p.parentId, p.pending, p.ids, session.writerId ?? null, uploaderOf(session));
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
  let to: string | undefined;
  if (m.to !== undefined) {
    try {
      to = resolvePeer(repo, session.primary, m.to).address;
    } catch (e) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      if (e instanceof ApplicationError) writeAudit(repo, "delegation.refused", authed.user_email, session.primary, { reason: e.message, to: m.to });
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
      const d = resolveDelegation(db, session.primary, { ...m, to }, online, humanReachable);
      picked = d.to;
      const w = writeSend(hub, session, prepareSend(hub, session, session.primary, d.to, d.body, null, true, undefined));
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
        requester: session.primary,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
      });
      return { payload, ref: w.ref, msg: w.msg };
    });
  } catch (e) {
    // Written after the rollback, so the refusal's row stays.
    if (e instanceof CoreError) {
      writeAudit(repo, "delegation.refused", authed.user_email, session.primary, { reason: e.message, to: m.to });
      throw coreRefusal(e);
    }
    // A refused send (canSend, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    if (e instanceof ApplicationError) writeAudit(repo, "delegation.refused", authed.user_email, session.primary, { reason: e.message, to: picked });
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
  if (registry.get(m.recipient)?.active || repo.cursors.directFor(m.recipient) >= m.id) return fail("bad_request", retractRefusal.reached(id, m.recipient));
  const retracted = repo.atomic(() => {
    if (!repo.messages.retract(m.sender, id)) return false;
    writeAudit(repo, "message.retracted", session.authed.user_email, `message:${id}`, { message_id: id, sender: m.sender, recipient: m.recipient });
    return true;
  });
  if (!retracted) return fail("bad_request", retractRefusal.replied(id));
  afterCommit(hub.db, async () => { await sweepBlobs(hub.db, repo.blobs); });
  return {};
}

function handleCall(hub: Hub, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): unknown {
  const { db } = hub;
  if (!isBoardTool(tool)) fail("bad_request", `unknown tool: ${tool}`);
  const ctx: ToolContext = {
    online: h => hub.registry.get(h)?.active === true,
    files: { limits: hub.repo.attachmentLimits, principal: uploaderOf(session).principal },
    human: session.human,
    ...(session.writerId ? { session: session.writerId } : {}),
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
    mine.includes(m.sender) && m.recipient_type === "user" && !mine.includes(m.recipient) ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
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

function handleAck(session: ApplicationSession, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move a cursor: their recipient address's (S8).
    if (!msg || msg.recipient_type !== "user" || !session.addresses.includes(msg.recipient)) continue;
    repo.cursors.advance(msg.recipient, "direct", msg.recipient, msgId);
  }
}
