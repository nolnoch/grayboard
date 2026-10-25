import type { HelloRequest, DelegateRequest, Replayed } from "../shared/protocol.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, RateLimiter, type RateLimit } from "./rate_limit.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause } from "../shared/testpause.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
import { MAX_CANDIDATES, UNBOUND_ERROR, UNBOUND_READS, closestNames, lastBoundBy, lastWasRelease, logBinding, clearHolds, dropHold, holdAlias, idAddress, mintSessionKey, orderCandidates, continuityOf, unboundPeer, unknownNameError, type Candidate } from "../core/bindings.ts";
import { participant, type MessageRow, type Repo, type Sync } from "./db.ts";
import { HUMAN_NAME, HUMAN_RESERVED, MAX_IDENTITY_LENGTH, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address } from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { acknowledge, age, boardCatalog, snapshot, canSeeBoard, checkBody, lastSeen, pendingFor, refOf, sessionsSeen, setPlace, touchAlias, touchId, registerId, idPrincipal, idCollisionText, inheritStatus, normalizeBoard, type CoreDb, type Pending, type PendingRef, type SnapshotOptions, type UnboundPeer } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type ToolContext, type BoardPostResult } from "../core/tools.ts";
import { attachmentIds, dropUnsentUploads, uploadDigests, sweepBlobs } from "../core/attachments.ts";
import type { AttachmentInfo, AttachmentLimits } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims, moveClaims } from "../core/claims.ts";
import { onAliasCreated } from "./teams.ts";
import { PROMISE_DAYS, STALE_UNDELIVERED_MS, alreadyRetracted, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showMessage, unanswered, undeliveredInstruction, type InboxItem, type PromiseItem } from "../shared/inbox.ts";

export type ApplicationCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "internal"
  | "superseded"
  | "identity_in_use"
  | "identity_unknown"
  | "unbound"
  | "rate_limited"
  | "id_collision"

  | "child_session"
  | "invalid_registration"
  | "root_is_child"
  | "child_bound"
  | "child_registered_elsewhere"
  | "has_children";

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
};
export type IdentityInfo = {
  candidates?: Candidate[];
  moved?: string[];
  not_moved?: string;
  identity_full: string;
  user_email: string;
  teams: string[];
  notices?: string[];
  human: { handle: string; linked: boolean };
  attachment_limits: AttachmentLimits;
  write_dedup?: true;
};
export type SendResult = {
  message_id: number;
  delivered_now: boolean;
  pending?: true;
  attachments?: AttachmentInfo[];
  recipient_last_seen?: string;
  undelivered_from_you?: number;
  note?: string;
  replayed?: Replayed;
};
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
  now?: () => number;
};
export type IdentityOptions = Omit<HelloRequest, "type" | "req_id" | "identity"> & {
  alive?: () => boolean;
  transport?: "wss" | "hosted";
};

// Only sessions registered by this application may execute operations.
export class ApplicationSession {
  readonly inflight = new Set<string>();
  active = true;
  sessionId = "";
  place: string | null = null;
  readOnly = false;
  owner = false;
  writerId?: string;
  transport: "wss" | "hosted" = "wss";
  identityName = "";
  identityFull = "";
  constructor(
    readonly authed: AuthedUser,
    readonly sink: DeliverySink,
    readonly human: boolean,
    readonly push: boolean,
  ) {}
}

function fail(code: ApplicationCode, message: string): never {
  throw new ApplicationError(code, message);
}

function refKey(r: PendingRef): string {
  return r.kind === "push" ? `p:${r.post_id}` : `d:${r.board}`;
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
  registry: Map<string, ApplicationSession>;
  holders: Map<string, ApplicationSession>;
  probing: Map<string, Promise<boolean>>;
  sessions: Set<ApplicationSession>;
  probeMs: number;
  humanReach: HumanReach;
  slackRunning: () => boolean;
  now: () => number;
  boardChanged: (board: string) => void;
};
function drainBoards(session: ApplicationSession, db: CoreDb, all = false): void {
  for (const item of pendingFor(db, session.identityFull, { all })) {
    const key = refKey(refOf(item));
    if (session.inflight.has(key)) continue;
    session.inflight.add(key);
    session.sink.deliver({ kind: "board", item });
  }
}
function wake(hub: Hub, handles: string[]): void {
  for (const h of handles) {
    const session = hub.registry.get(h);
    if (session?.active) drainBoards(session, hub.db, session.human);
  }
}

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

export function createApplication(repo: Repo, db: CoreDb, opts: ApplicationOptions = {}) {
  const hub: Hub = {
    repo,
    db,
    registry: new Map(),
    holders: new Map(),
    probing: new Map(),
    sessions: new Set(),
    probeMs: opts.probeMs ?? 2000,
    humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    now: opts.now ?? Date.now,
    boardChanged(board) {
      for (const observer of [...observers]) {
        if (observer.board === board && observerLive(observer)) notify(() => observer.hooks.changed());
      }
    },
  };
  const helloLimiter = new RateLimiter(opts.helloLimit ?? DEFAULT_HELLO_LIMIT, {
    start: (email, ctx, retryAfterMs) => {
      console.error(`[grayboard] rate-limiting hellos from ${email}`);
      writeAudit(repo, "hello.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs });
    },
    end: (email, refused) => {
      console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
      writeAudit(repo, "hello.rate_limit_ended", email, null, { refused });
    },
  }, opts.now);
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
  clearHolds(db);
  type Observer = { session: ApplicationSession; board: string; hooks: BoardObserver };
  const observers = new Set<Observer>();
  function removeObserver(observer: Observer) {
    if (observers.delete(observer)) notify(observer.hooks.closed);
  }
  function observerLive(observer: Observer): boolean {
    if (!observers.has(observer)) return false;
    try {
      valid(observer.session);
      if (canSeeBoard(db, observer.session.identityFull, observer.board)) return true;
    } catch {}
    removeObserver(observer);
    return false;
  }
  function boardsChanged(boards: string[]) {
    for (const board of new Set(boards)) hub.boardChanged(board);
  }
  const expiry = claimExpiryTimer(db, handles => wake(hub, handles), boardsChanged);
  const revoked = new Map<number, number>();
  function release(session: ApplicationSession, why: string) {
    if (!session.owner) return;
    session.owner = false;
    logBinding(db, session.sessionId, session.identityFull, "released", why);
  }
  function close(session: ApplicationSession, why = "connection closed") {
    session.active = false;
    hub.sessions.delete(session);
    for (const observer of [...observers]) if (observer.session === session) removeObserver(observer);
    if (hub.registry.get(session.identityFull) === session) hub.registry.delete(session.identityFull);
    if (hub.holders.get(session.identityFull) === session) {
      hub.holders.delete(session.identityFull);
      if (!session.human) dropHold(db, session.identityFull, session.sessionId);
      touchAlias(db, session.identityFull);
    }
    if (session.writerId) touchId(db, session.writerId);
    release(session, why);
  }
  function terminate(session: ApplicationSession, error: ApplicationError, why = error.message) {
    close(session, why);
    session.sink.closed(error);
  }
  function valid(session: ApplicationSession, allowUnbound = false) {
    if (!session.active || !hub.sessions.has(session)) fail("unauthenticated", "session is closed");
    if (repo.users.findById(session.authed.user_id)?.disabled_at != null) {
      terminate(session, new ApplicationError("unauthenticated", "an admin signed this user out"));
      fail("unauthenticated", "an admin signed this user out");
    }
    if (session.readOnly && !allowUnbound) fail("unbound", UNBOUND_ERROR);
  }
  function admit(authed: AuthedUser, nameInput: string | undefined, m: IdentityOptions) {
    const limiter = m.transport === "hosted" ? hostedRequestLimiter : helloLimiter;
    const t = limiter.take(authed.user_email, {
      session_id: m.session_key ? idAddress(m.session_key) : null,
      ...(m.read_only ? { read_only: true } : { name: nameInput ?? null }),
      place: m.where ?? null,
    });
    if (!t.ok) {
      const secs = Math.ceil(t.retryAfterMs / 1000);
      throw new ApplicationError("rate_limited", `too many connections for this user; retry in ${secs}s`, { retry_after_ms: t.retryAfterMs });
    }
  }
  async function select(authed: AuthedUser, nameInput: string | undefined, sink: DeliverySink, m: IdentityOptions, human: boolean, admitted = false) {
    const { holders, registry } = hub;
    // Before database work; trusted bridge attachments are the server's own.
    if (!human && !admitted) admit(authed, nameInput, m);
    const push = m.push !== false;
    const owns = push || m.hold === true;
    const sessionId = idAddress(m.session_key ?? mintSessionKey());
    const session = new ApplicationSession(authed, sink, human, push);
    session.sessionId = sessionId;
    session.transport = m.transport ?? "wss";
    session.place = m.where ?? null;
    const epoch = revoked.get(authed.user_id);
    const alive = () => session.active && (m.alive?.() ?? true) && (human || revoked.get(authed.user_id) === epoch);
    if (!alive() || repo.users.findById(authed.user_id)?.disabled_at != null) fail("unauthenticated", "session is closed");
    const infoFor = (full: string): IdentityInfo => ({
      identity_full: full,
      user_email: authed.user_email,
      teams: repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name)),
      human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
      attachment_limits: repo.attachmentLimits,
    });
    if (m.read_only) {
      session.readOnly = true;
      session.identityName = `~${sessionId}`;
      session.identityFull = `${authed.user_email}/~${sessionId}`;
      hub.sessions.add(session);
      return { session, info: { ...infoFor(session.identityFull), candidates: candidates(hub, authed, m.suggested) } };
    }
    // An invalid name is logged cut to the longest valid length: it's the
    // client's text, and the event only has to show what was tried.
    const name = (nameInput ?? "").toLowerCase().slice(0, MAX_IDENTITY_LENGTH);
    const full = `${authed.user_email}/${name}`;
    // Only the connection that would hold the name logs: a tools-only one runs
    // beside the session that owns it.
    const refuse = (code: ApplicationCode, message: string, detail: string, extra: { known?: string[]; holder?: string } = {}): never => {
      if (owns) logBinding(db, sessionId, full, "refused", detail);
      throw new ApplicationError(code, message, extra);
    };
    if (!isValidIdentityName((nameInput ?? "").toLowerCase())) return refuse("bad_request", "invalid identity name", "invalid name");
    if ((name === HUMAN_NAME) !== (human)) {
      const why = name === HUMAN_NAME ? HUMAN_RESERVED : "the Slack bridge holds only human identities";
      return refuse("bad_request", why, why);
    }

    // A typo would otherwise create a fresh name, and the DMs queued for the
    // intended one would never arrive.
    if (m.create === false && !repo.aliases.find(authed.user_email, name)) {
      const known = closestNames(name, repo.aliases.listFor(authed.user_email).map((i) => i.name).filter((n) => n !== HUMAN_NAME));
      const message = unknownNameError(name, known);
      return refuse("identity_unknown", message, message, { known });
    }

    // One live connection per identity. If the current holder still answers,
    // refuse the newcomer: taking over would let a stray second session (e.g.
    // a worktree that inherited .mcp.json) silently steal this identity's
    // deliveries. A holder that doesn't answer is dead; replace it. Each await
    // can change the registry (a close, another hello), so after one, check
    // again from the top; between the last check and registry.set below
    // nothing awaits (#69).
    while (owns) {
      const inFlight = hub.probing.get(full);
      if (inFlight) {
        // Another hello is probing the holder: whoever wins, it's settled after.
        await inFlight;
        if (!alive()) fail("unauthenticated", "session is closed");
        continue;
      }
      const holder = holders.get(full);
      if (!holder || holder === session) break;
      const probing = holder.sink.probe(hub.probeMs).catch(() => false).finally(() => {
        if (hub.probing.get(full) === probing) hub.probing.delete(full);
      });
      hub.probing.set(full, probing);
      const responding = await probing;
      if (!alive()) fail("unauthenticated", "session is closed");
      if (responding) {
        const who = describeHolder(holder);
        return refuse("identity_in_use", `identity "${name}" is already in use by ${who}; bind another name.`, who, { holder: who });
      }
      if (holders.get(full) === holder) {
        terminate(holder, new ApplicationError("superseded", "a newer session connected with this identity"), `superseded by session ${sessionId}`);
      }
    }

    // A session's ID is one principal's (#284): a key whose ID is another
    // user's session is refused, never attached to that session's row. From
    // here to registry.set nothing awaits, so the row read here stands.
    const prior = owns && !human ? idPrincipal(db, sessionId) : undefined;
    if (prior !== undefined && prior !== authed.user_email) {
      writeAudit(repo, "id.collision", authed.user_email, sessionId, { name: full });
      return refuse("id_collision", idCollisionText(sessionId, "is another principal's session"), "id_collision");
    }

    // A rebind names the name it leaves (#182 audit 3). Its claims move only
    // if this session holds that name by the record and no other connection
    // holds it live; that holds whether or not the old connection is open. A
    // session holding another name live must name it: a late reconnect of a
    // name it has left is refused, never taken for a rebind.
    let from: string | null = null;
    let notMoved: string | null = null;
    if (owns) {
      const fromFull = m.from === undefined ? null : `${authed.user_email}/${m.from.toLowerCase()}`;
      const held = [...holders.values()].find((c) => c !== session && c.sessionId === sessionId && c.identityFull !== full);
      if (held && held.identityFull !== fromFull) {
        const was = held.identityName;
        return refuse("identity_in_use", `this session holds "${was}" now; a hello for "${name}" that doesn't leave it is refused.`, `stale: the session holds "${was}"`);
      }
      if (fromFull !== null && fromFull !== full) {
        const h = holders.get(fromFull);
        if ((!h || h.sessionId === sessionId) && lastBoundBy(db, fromFull, sessionId)) from = fromFull;
        else notMoved = `claims not moved: this session doesn't hold "${m.from}"`;
      }
    }

    if (!alive() || repo.users.findById(authed.user_id)?.disabled_at != null) fail("unauthenticated", "an admin signed this user out");
    if (!repo.aliases.find(authed.user_email, name)) {
      repo.aliases.create(authed.user_email, name);
      writeAudit(repo, "alias.created", authed.user_email, full, { lazy: true, ...(session.human ? {} : { session: sessionId }) });
      onAliasCreated(db, repo, authed.user_id, full);
    }

    hub.sessions.add(session);
    let moved: string[] | undefined;
    if (owns) {
      moved = [];
      holders.set(full, session);
      if (push) registry.set(full, session);
      // The session's rows (#284): its ids row, written by its first owner
      // hello and updated by the rest (a reconnect, a rebind), and its hold.
      // The Slack bridge's humans have no ID.
      if (!session.human) {
        if (prior === undefined) registerId(db, { id: sessionId, principal: authed.user_email, place: m.where ?? null, launcher: push && m.launcher === true, keyed: m.session_key !== undefined });
        else {
          setPlace(db, sessionId, m.where ?? null);
          touchId(db, sessionId);
        }
        holdAlias(db, full, sessionId);
        session.writerId = sessionId;
      }
      // A reconnect, or a restart taking its name back, is the same session, so
      // its status stays, once the name's history shows it (#211). The session
      // ID comes from the client's secret, so a reconnect proves itself; a
      // restore names a public ID. A rebind is neither: it logs `moved`.
      const continued = m.from !== undefined ? null
        : m.resume ? continuityOf(db, full, { reconnect: sessionId })
        : m.restored_from !== undefined ? continuityOf(db, full, { restartOf: m.restored_from })
        : null;
      // A verified restore is the same harness session: its status carries over.
      if (continued?.verified && m.restored_from !== undefined && !session.human) inheritStatus(db, sessionId, m.restored_from);
      touchAlias(db, full);
      // Only a push-mode owner advertises the capability (a hold or tools-only
      // connection can't receive a delegation, so it must not be one). Every
      // owner hello rewrites the flag and audits it, changed or not (#184 review 4/6).
      if (push) {
        // registerId wrote the flag for a new row; a later hello rewrites it.
        if (!session.human && prior !== undefined) setLauncher(db, sessionId, m.launcher === true);
        writeAudit(repo, "handle.launcher_set", authed.user_email, full, { on: m.launcher === true, ...(session.human ? {} : { session: sessionId }) });
      }
      session.owner = true;
      if (from) {
        // The old connection, which the client closes next, holds nothing now.
        const prev = holders.get(from);
        if (prev) {
          holders.delete(from);
          if (registry.get(from) === prev) registry.delete(from);
          dropHold(db, from, sessionId);
          touchAlias(db, from);
        }
        moved = db.transaction(() => moveClaims(db, from, full))().map((c) => c.key);
        if (prev?.owner) release(prev, `rebound to ${full}`);
        else if (!lastWasRelease(db, from)) logBinding(db, sessionId, from, "released", `rebound to ${full}`);
        logBinding(db, sessionId, full, "moved", from);
      } else {
        logBinding(db, sessionId, full, "bound", [continued?.detail ?? null, notMoved].filter((d) => d !== null).join("; ") || null);
      }
    } else {

      touchAlias(db, full);
    }
    session.identityName = name;
    session.identityFull = full;

    const info: IdentityInfo = { ...infoFor(full), ...(m.session_key ? { write_dedup: true as const } : {}), ...(moved ? { moved } : {}), ...(notMoved ? { not_moved: notMoved } : {}) };
    // Tools-only requests and the bridge's human attachment cannot consume the owner's notice.
    const bridgeNotice = owns && !human ? owedBridgeNotice(repo, authed.user_email) : undefined;
    const notices = [
      ...(m.launcher && push && owns ? launcherInstruction() : []),
      ...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), h => lastSeen(db, h)),
      ...(bridgeNotice ? [bridgeNotice] : []),
      // Last: claims are the longest notice, so a client cut must lose them first.
      ...claimsInstruction(listClaims(db, undefined, full), [full]),
    ];
    if (notices.length) info.notices = notices;
    return { session, info };
  }
  const application = {
    // Single-use server capability for admission before a transport's identity preflight.
    admitIdentity(authed: AuthedUser, name: string, options: IdentityOptions = {}) {
      const m = { ...options };
      admit(authed, name, m);
      let used = false;
      return (sink: DeliverySink) => {
        if (used) throw new ApplicationError("internal", "identity admission already consumed");
        used = true;
        return select(authed, name, sink, m, false, true);
      };
    },
    repo,
    hostedHolder(full: string) { return hub.holders.get(full); },
    hostedCandidates(authed: AuthedUser) { return candidates(hub, authed); },
    hostedSession(authed: AuthedUser, id: string, name: string | null, place: string | null, sink: DeliverySink, hold = false, push = false) {
      const session = new ApplicationSession(authed, sink, false, push);
      session.sessionId = id;
      session.place = place;
      session.readOnly = name === null;
      session.identityName = name ?? `~${id}`;
      session.identityFull = `${authed.user_email}/${session.identityName}`;
      session.identityId = name ? repo.identities.findByUserAndName(authed.user_id, name)?.id ?? 0 : 0;
      hub.sessions.add(session);
      if (hold && name) hub.holders.set(session.identityFull, session);
      if (push && name) hub.registry.set(session.identityFull, session);
      const info: IdentityInfo = {
        identity_full: session.identityFull, user_email: authed.user_email,
        teams: repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name)),
        human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
        attachment_limits: repo.attachmentLimits,
        ...(name === null ? { candidates: candidates(hub, authed) } : {}),
      };
      return { session, info };
    },
    hostedBind(authed: AuthedUser, id: string, name: string, previous: string | null, place: string | null, create: boolean) {
      const full = `${authed.user_email}/${name}`;
      let identity = repo.identities.findByUserAndName(authed.user_id, name);
      if (!identity && !create) {
        const known = closestNames(name, repo.identities.listForUser(authed.user_id).map(i => i.name).filter(n => n !== HUMAN_NAME));
        const message = unknownNameError(name, known);
        logBinding(db, id, full, "refused", message);
        throw new ApplicationError("identity_unknown", message, { known });
      }
      if (!identity) {
        identity = repo.identities.create(authed.user_id, name);
        writeAudit(repo, "identity.created", authed.user_email, name);
        onIdentityCreated(db, repo, authed.user_id, full);
      }
      let moved: string[] = [];
      let notMoved: string | undefined;
      if (previous) {
        const from = `${authed.user_email}/${previous}`;
        if (lastBoundBy(db, from, id)) moved = moveClaims(db, from, full).map(c => c.key);
        else notMoved = `claims not moved: this session doesn't hold "${previous}"`;
        logBinding(db, id, from, "released", `rebound to ${full}`);
        logBinding(db, id, full, "moved", [from, notMoved].filter(Boolean).join("; "));
      } else logBinding(db, id, full, "bound");
      if (previous === null) startSession(db, full, null);
      else {
        touchHandle(db, full);
        db.prepare("UPDATE handles SET (status, status_at, queue_off) = (SELECT status, status_at, queue_off FROM handles WHERE name = ?) WHERE name = ?")
          .run(`${authed.user_email}/${previous}`, full);
      }
      setPlace(db, full, place);
      return { moved, notMoved };
    },
    hostedRefused(id: string, full: string, detail: string) { logBinding(db, id, full, "refused", detail); },
    selectIdentity: (authed: AuthedUser, name: string | undefined, sink: DeliverySink, options: IdentityOptions = {}) => select(authed, name, sink, options, false),
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman: (authed: AuthedUser, sink: DeliverySink) => select(authed, HUMAN_NAME, sink, {}, true),
    close,
    revalidateSession: valid,
    replay(session: ApplicationSession) {
      valid(session, true);
      if (session.readOnly || !session.push || hub.registry.get(session.identityFull) !== session) return;
      const since = repo.cursors.get(session.identityFull, "direct", session.identityFull);
      for (const message of repo.messages.unreadSince([{ type: "direct", ref: session.identityFull, since }])) {
        session.sink.deliver({ kind: "direct", message: showMessage(message) });
      }
      drainBoards(session, db, true);
    },
    send(
      session: ApplicationSession,
      recipient: string,
      body: string,
      options: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean } = {},
    ) {
      valid(session);
      return handleSend(hub, session, recipient, body, options.parent_id ?? null, options.pending === true, options.attachment_ids, options.resend === true);
    },
    delegate(session: ApplicationSession, request: Omit<DelegateRequest, "type" | "req_id">) {
      valid(session);
      return handleDelegate(hub, session, request);
    },
    history(session: ApplicationSession, options: { peer?: string; limit?: number; before_id?: number } = {}) {
      valid(session);
      return handleHistory(session, options.peer, options.limit, options.before_id, repo);
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
      const since = repo.cursors.get(session.identityId, "direct", session.identityFull);
      const direct: DeliveryEvent[] = repo.messages.unreadSince([{ type: "direct", ref: session.identityFull, since }])
        .slice(0, limit).map(message => ({ kind: "direct", message: showPending(message) }));
      const boards = pendingFor(db, session.identityFull, { all: true });
      return [...direct, ...boards.slice(0, limit - direct.length).map(item => ({ kind: "board" as const, item }))];
    },
    boardCatalog(session: ApplicationSession, after?: string) {
      valid(session, true);
      return boardCatalog(db, session.identityFull, after);
    },
    boardSnapshot(session: ApplicationSession, board: string, options: SnapshotOptions = {}) {
      valid(session, true);
      return snapshot(db, session.identityFull, board, options);
    },
    observeBoard(session: ApplicationSession, boardInput: string, hooks: BoardObserver): () => void {
      valid(session);
      const board = normalizeBoard(boardInput);
      // Snapshot performs the same concealed access check as content reads.
      snapshot(db, session.identityFull, board, { limit: 1 });
      if (observers.size >= 1024) fail("bad_request", "board observer capacity reached");
      const observer = { session, board, hooks };
      observers.add(observer);
      return () => removeObserver(observer);
    },
    canReceiveBoard(session: ApplicationSession, board: string) {
      valid(session);
      return canSeeBoard(db, session.identityFull, board);
    },
    receiptDirect(session: ApplicationSession, ids: number[]) {
      valid(session);
      handleAck(session, ids, repo);
    },
    receiptBoards(session: ApplicationSession, refs: PendingRef[]) {
      valid(session);
      for (const r of refs) {
        acknowledge(db, session.identityFull, r);
        session.inflight.delete(refKey(r));
      }
    },
    acknowledgeDm(session: ApplicationSession, id: number) {
      valid(session);
      const m = repo.messages.getById(id), me = session.identityFull;
      if (!m || m.recipient_type !== "user" || !(m.recipient === me || (m.sender === me && m.pending))) fail("not_found", `no message ${id} to you or pending from you; dm_inbox lists them`);
      repo.messages.ack(me, m.id);
    },
    retract(session: ApplicationSession, id: number) {
      valid(session);
      return handleRetract(hub, session, id);
    },
    call(session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      valid(session, UNBOUND_READS.has(tool));
      const result = handleCall(hub, session, tool, args, publish);
      expiry.arm();
      return result;
    },
    // Trusted committed domain operations, not client-supplied invalidations.
    boardsChanged,
    wake(handles: string[]) {
      expiry.arm();
      wake(hub, handles);
    },
    disconnectUser(userId: number) {
      revoked.set(userId, (revoked.get(userId) ?? 0) + 1);
      for (const s of [...hub.sessions]) {
        if (!s.human && s.authed.user_id === userId) {
          terminate(s, new ApplicationError("unauthenticated", "an admin signed this user out"));
        }
      }
    },
    revalidate() {
      for (const observer of [...observers]) observerLive(observer);
      for (const s of [...hub.sessions]) {
        if (!s.human && repo.users.findById(s.authed.user_id)?.disabled_at != null) {
          application.disconnectUser(s.authed.user_id);
        }
      }
    },
    heartbeat() {
      application.revalidate();
      helloLimiter.sweep();
      for (const s of hub.sessions) s.sink.keepAlive?.();
    },
    sweepHellos: () => { helloLimiter.sweep(); hostedRequestLimiter.sweep(); },
    stopExpiry() {
      expiry.stop();
      for (const observer of [...observers]) removeObserver(observer);
    },
  };
  return application;
}
export type Application = ReturnType<typeof createApplication>;

function describeHolder(session: ApplicationSession): string {
  return `the live session ${session.sessionId}${session.place ? `, in ${session.place}` : ""}`;
}

function candidates(hub: Hub, authed: AuthedUser, suggestedInput?: string): Candidate[] {
  const { repo, db, holders } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const free = (n: string) => n !== HUMAN_NAME && !holders.has(full(n));
  const names = repo.aliases.listFor(authed.user_email).map((i) => i.name).filter(free);
  const queued = repo.messages.queuedTo(names.map(full));
  const seen = sessionsSeen(db, names.map(full));
  const claims = new Map<string, number>();
  for (const c of listClaims(db)) claims.set(c.holder, (claims.get(c.holder) ?? 0) + 1);
  const s = suggestedInput?.toLowerCase();
  const suggested = s !== undefined && isValidIdentityName(s) && free(s) ? s : null;
  return orderCandidates(
    names.map((n) => ({
      name: n, queued: queued.get(full(n)) ?? 0, claims: claims.get(full(n)) ?? 0,
      last_seen: seen.get(full(n))?.last_seen ?? 0, where: seen.get(full(n))?.where ?? null,
    })),
    suggested,
  ).slice(0, MAX_CANDIDATES);
}

// The user's live unbound sessions, for peer_list: never another user's.
function unboundPeers(hub: Hub, session: ApplicationSession): UnboundPeer[] {
  return [...hub.sessions].filter(c => c.readOnly)
    .filter((c) => c.authed.user_id === session.authed.user_id)
    .map((c) => unboundPeer(c.sessionId!, c.place ?? null, c.sessionId === session.sessionId));
}

function resolvePeer(repo: Repo, session: ApplicationSession, input: string): Address {
  const { authed } = session;
  if (isValidIdentityName(input)) {
    const name = input.toLowerCase();
    if (repo.aliases.find(authed.user_email, name)) {
      input = formatDirectAddress(authed.user_email, name);
    } else if (name === HUMAN_NAME) {
      // Every linked user has one; listing them would only leak who linked.
      fail("not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
    } else {
      const all = repo.aliases.findAllByName(name);
      if (all.length !== 1) {
        const which = all.length ? `several identities are named "${name}": ${all.map(i => formatDirectAddress(i.email, i.name)).sort().join(", ")}` : `no identity is named "${name}"`;
        fail("not_found", `${which}; peer_list shows exact handles`);
      }
      input = formatDirectAddress(all[0]!.email, name);
    }
  }
  try {
    return parseAddress(input);
  } catch (e) {
    fail("bad_request", String(e));
  }
}

type PreparedSend = { to: string; body: string; parentId: number | null; pending: boolean; ids: number[]; digests: string[] };

// Checks a send and resolves its recipient, writing nothing; throws ApplicationError.
function prepareSend(
  hub: Hub, session: ApplicationSession, recipientStr: string, body: string, parentId: number | null, pending: boolean, attachmentIdsRaw: unknown,
): PreparedSend {
  const { repo, db } = hub;
  const { authed } = session;
  let ids: number[];
  let digests: string[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
    digests = uploadDigests(db, ids, session.identityFull);
  } catch (e) {
    if (e instanceof CoreError) throw new ApplicationError("bad_request", e.message);
    throw e;
  }

  const parsed = resolvePeer(repo, session, recipientStr);

  const principal: SendPrincipal = {
    user_id:       authed.user_id,
    user_email:    authed.user_email,
    identity_name: session.identityName,
    identity_full: session.identityFull,
  };

  if (parsed.kind === "team") throw new ApplicationError("bad_request", `${parsed.full} isn't a person; to reach a team, board_post to its board #${parsed.name}`);

  const recipientUser = repo.users.findByEmail(parsed.email);
  if (!recipientUser) throw new ApplicationError("not_found", `user "${parsed.email}" not found`);
  if (!repo.aliases.find(recipientUser.email, parsed.name)) throw new ApplicationError("not_found", `identity "${parsed.full}" not found; peer_list shows exact handles`);
  const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) throw new ApplicationError(decision.code, decision.reason);

  if (parentId !== null && !participant(repo.messages.getById(parentId), session.identityFull)) {
    throw new ApplicationError("not_found", `parent_id ${parentId} is not a message you sent or received`);
  }
  return { to: parsed.full, body, parentId, pending, ids, digests };
}

// Writes the message and builds its result. Runs inside the caller's
// transaction; whether the recipient is live is read here, with nothing
// awaited before deliverSend pushes, so the result says what happens.
function writeSend(hub: Hub, session: ApplicationSession, p: PreparedSend): Written<SendResult> & { msg: MessageRow } {
  const { repo, db, registry } = hub;
  let msg: MessageRow;
  try {
    msg = repo.messages.insert(session.identityFull, "user", p.to, p.body, p.parentId, p.pending, p.ids, session.writerId ?? null);
  } catch (e) {
    if (e instanceof CoreError) throw new ApplicationError("bad_request", e.message);
    throw e;
  }
  const f = { ...(p.pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) };
  const seen = lastSeen(db, p.to);
  const payload: SendResult = registry.get(p.to)?.active
    ? { message_id: msg.id, delivered_now: true, ...f }
    : {
        message_id: msg.id,
        delivered_now: false,
        ...f,
        ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
        undelivered_from_you: repo.messages.undeliveredFrom(session.identityFull).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
      };
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// After a fresh send's commit (never a replay's): its files' audit rows and
// the push to a live recipient.
function deliverSend(hub: Hub, session: ApplicationSession, msg: MessageRow): void {
  for (const a of msg.attachments ?? []) {
    writeAudit(hub.repo, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: session.identityFull, message_id: msg.id, recipient: msg.recipient });
  }
  const recipientWs = hub.registry.get(msg.recipient);
  if (recipientWs?.active) recipientWs.sink.deliver({ kind: "direct", message: showMessage(msg) });
}

// An append write, deduplicated (#254): an identical call by this session
// within the window answers with the first one's result. The Slack bridge's
// humans are exempt: a person typing a line twice sent it twice. `uploads`:
// the call's attachment ids; a replay releases them (the retry uploaded its
// files afresh, and nothing will bind them), audited like any release.
function writeOnce<W extends Written>(
  hub: Hub, session: ApplicationSession, tool: DedupTool, args: Record<string, unknown>, resend: boolean, uploads: number[], write: () => Sync<W>,
): DedupOutcome<W> {
  const { repo } = hub;
  if (session.human) return { fresh: repo.atomic(write) };
  const { authed, identityFull: me } = session;
  const out = dedupWrite(repo, hub.now(), {
    tool, session: session.sessionId!, sender: me, actor: authed.user_email, transport: session.transport, args, resend,
  }, write, () => {
    for (const row of dropUnsentUploads(hub.db, uploads, me)) {
      writeAudit(repo, "attachment.released", authed.user_email, `attachment:${row.id}`, {
        identity: me, filename: row.filename, size: row.size, sha256: row.sha256, reason: "replayed",
      });
    }
  });
  if ("replay" in out && uploads.length > 0) void sweepBlobs(hub.db, repo.blobs);
  return out;
}

function handleSend(hub: Hub, session: ApplicationSession, recipient: string, body: string, parentId: number | null, pending: boolean, ids: unknown, resend: boolean): SendResult {
  const p = prepareSend(hub, session, recipient, body, parentId, pending, ids);
  const args = { to: p.to, body: p.body, parent_id: p.parentId, pending: p.pending, attachments: p.digests };
  const out = writeOnce(hub, session, "dm_send", args, resend, p.ids, () => writeSend(hub, session, p));
  if ("replay" in out) return out.replay;
  testPause("write:after-commit");
  deliverSend(hub, session, out.fresh.msg);
  return out.fresh.payload;
}

function handleDelegate(hub: Hub, session: ApplicationSession, m: Omit<DelegateRequest, "type" | "req_id">) {
  const { repo, db } = hub;
  const { authed } = session;
  let resolvedTo = m.to;
  try {
    const to = m.to === undefined ? undefined : resolvePeer(repo, session, m.to).full;
    const args = { to: to ?? null, persona: m.persona, task: m.task, context: m.context ?? null };
    const out = writeOnce(hub, session, "delegate", args, m.resend === true, [], () => {
      const d = resolveDelegation(db, session.identityFull, { ...m, to },
        h => hub.registry.get(h)?.active === true,
        () => hub.slackRunning() && !!repo.slack.linkFor(authed.user_id));
      resolvedTo = d.to;
      const w = writeSend(hub, session, prepareSend(hub, session, d.to, d.body, null, true, undefined));
      const payload = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
        requester: session.identityFull,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
      });
      return { payload, ref: w.ref, msg: w.msg };
    });
    if ("replay" in out) return out.replay;
    testPause("write:after-commit");
    deliverSend(hub, session, out.fresh.msg);
    return out.fresh.payload;
  } catch (e) {
    if (e instanceof CoreError || e instanceof ApplicationError) {
      writeAudit(repo, "delegation.refused", authed.user_email, session.identityFull, { reason: e.message, to: resolvedTo });
      if (e instanceof CoreError) fail("bad_request", e.message);
    }
    throw e;
  }
}

function handleRetract(hub: Hub, session: ApplicationSession, id: number): { note?: string } {
  const { repo, registry } = hub;
  const me = session.identityFull;
  const m = repo.messages.getById(id);
  if (!m) {
    const done = repo.audit.last("message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by === me) return { note: alreadyRetracted(done.at) };
  }
  if (!m || m.recipient_type !== "user" || m.sender !== me) return fail("not_found", retractRefusal.notYours(id));
  if (registry.get(m.recipient)?.active || repo.cursors.directFor(m.recipient) >= m.id) return fail("bad_request", retractRefusal.reached(id, m.recipient));
  const retracted = repo.atomic(() => {
    if (!repo.messages.retract(me, id)) return false;
    writeAudit(repo, "message.retracted", session.authed.user_email, `message:${id}`, { message_id: id, sender: me, recipient: m.recipient });
    return true;
  });
  if (!retracted) return fail("bad_request", retractRefusal.replied(id));
  void sweepBlobs(hub.db, repo.blobs);
  return {};
}

function handleCall(hub: Hub, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): unknown {
  const { db } = hub;
  if (!isBoardTool(tool)) fail("bad_request", `unknown tool: ${tool}`);
  const ctx: ToolContext = {
    online: h => hub.registry.get(h)?.active === true,
    attachmentLimits: hub.repo.attachmentLimits,
    human: session.human,
    ...(session.writerId ? { session: session.writerId } : {}),
    ...(tool === "peer_list" ? { unbound: unboundPeers(hub, session) } : {}),
  };
  if (tool === "board_post") return handleBoardPost(hub, session, args, ctx, publish);
  let outcome;
  try { outcome = callBoardTool(db, session.identityFull, tool, args, ctx); }
  catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    console.error(`[grayboard] ${tool} failed:`, e);
    return fail("internal", `${tool} failed`);
  }
  for (const board of new Set(outcome.boards ?? [])) hub.boardChanged(board);
  publish?.(outcome.result);
  wake(hub, outcome.wake);
  return outcome.result;
}

function handleBoardPost(hub: Hub, session: ApplicationSession, args: Record<string, unknown>, ctx: ToolContext, publish?: (result: unknown) => void): unknown {
  const { db, repo } = hub;
  const me = session.identityFull;
  const { resend, ...postArgs } = args;
  let out: DedupOutcome<Written<BoardPostResult> & { wake: string[] }>;
  try {
    if (resend !== undefined && typeof resend !== "boolean") throw new CoreError("resend must be boolean");
    if (typeof postArgs.board !== "string") throw new CoreError("board must be a string");
    if (typeof postArgs.body !== "string") throw new CoreError("body must be a string");
    const ids = attachmentIds(postArgs.attachment_ids);
    const fp = { board: normalizeBoard(postArgs.board), body: postArgs.body, parent_id: postArgs.parent_id ?? null, attachments: uploadDigests(db, ids, me) };
    out = writeOnce(hub, session, "board_post", fp, resend === true, ids, () => {
      const o = callBoardTool(db, me, "board_post", postArgs, ctx);
      const r = o.result as BoardPostResult;
      return { payload: r, ref: { kind: "post", id: r.post_id }, wake: o.wake };
    });
  } catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    console.error("[grayboard] board_post failed:", e);
    return fail("internal", "board_post failed");
  }
  if ("replay" in out) { publish?.(out.replay); return out.replay; }
  testPause("write:after-commit");
  const r = out.fresh.payload;
  for (const a of r.attachments ?? []) writeAudit(repo, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: me, post_id: r.post_id, board: r.board });
  publish?.(r);
  wake(hub, out.fresh.wake);
  return r;
}

function handleHistory(
  session: ApplicationSession,
  peer: string | undefined,
  limit: number | undefined,
  beforeId: number | undefined,
  repo: Repo,
): HistoryMessage[] {
  let lim: number;
  try {
    lim = historyLimit(limit);
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  let peerFull: string | undefined;
  if (peer) {
    const parsed = resolvePeer(repo, session, peer);
    peerFull = parsed.full;
  }
  const me = session.identityFull;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const messages = repo.messages.history(me, peerFull, lim, beforeId).reverse().map((m) =>
    m.sender === me && m.recipient_type === "user" && m.recipient !== me ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
  );
  return messages.map(showMessage);
}

function handleInbox(hub: Hub, session: ApplicationSession, days: number | undefined): InboxResult {
  const { repo, db } = hub;
  const me = session.identityFull;
  let since: number;
  try {
    since = Date.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }
  const owed = unanswered([me], repo.messages.receivedUnacked(me, since), (id) => repo.messages.thread(id));
  const promises = promised([me], repo.messages.sentPending(me, Date.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
  const queued = repo.messages.undeliveredFrom(me).map((u) => {
    const seen = lastSeen(db, u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(Date.now() - seen)} ago` } : {}) };
  });
  return {
    unanswered: owed,
    ...(promises.length ? { promised: promises } : {}),
    ...(queued.length ? { undelivered_from_you: queued } : {}),
  };
}

function handleThread(session: ApplicationSession, messageId: number, repo: Repo): DirectMessage[] {
  const me = session.identityFull;
  if (!participant(repo.messages.getById(messageId), me)) {
    fail("not_found", `message ${messageId} not found`);
  }
  const messages = repo.messages.thread(messageId).filter((m) => participant(m, me));
  return messages.map(showMessage);
}

function handleAck(session: ApplicationSession, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move your cursor.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== session.identityFull) continue;
    repo.cursors.advance(session.identityFull, "direct", session.identityFull, msgId);
  }
}
