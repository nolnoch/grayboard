import type { HelloRequest } from "../shared/protocol.ts";
import { MAX_CANDIDATES, UNBOUND_ERROR, UNBOUND_READS, closestNames, lastBoundBy, lastWasRelease, logBinding, mintSessionId, orderCandidates, sessionIdOf, unboundPeer, unknownNameError, type Candidate } from "../core/bindings.ts";
import { participant, type MessageRow, type Repo } from "./db.ts";
import { HUMAN_NAME, HUMAN_RESERVED, MAX_IDENTITY_LENGTH, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address } from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { acknowledge, age, checkBody, lastSeen, pendingFor, refOf, sessionsSeen, setPlace, startSession, touchHandle, type CoreDb, type Pending, type PendingRef, type UnboundPeer } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { attachmentIds, sweepBlobs } from "../core/attachments.ts";
import type { AttachmentInfo, AttachmentLimits } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims, moveClaims } from "../core/claims.ts";
import { onIdentityCreated } from "./teams.ts";
import { PROMISE_DAYS, STALE_UNDELIVERED_MS, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showPending, unanswered, undeliveredInstruction, type InboxItem, type PromiseItem } from "../shared/inbox.ts";

export type ApplicationCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "internal"
  | "superseded"
  | "identity_in_use"
  | "identity_unknown"
  | "unbound";

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationCode, message: string, readonly extra: { known?: string[]; holder?: string } = {}) {
    super(message);
  }
}
export type DirectMessage = ReturnType<typeof showPending<MessageRow>>;
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
};
export type SendResult = {
  message_id: number;
  delivered_now: boolean;
  pending?: true;
  attachments?: AttachmentInfo[];
  recipient_last_seen?: string;
  undelivered_from_you?: number;
  note?: string;
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
};
export type IdentityOptions = Omit<HelloRequest, "type" | "req_id" | "identity"> & {
  alive?: () => boolean;
};

// Only sessions registered by this application may execute operations.
export class ApplicationSession {
  readonly inflight = new Set<string>();
  active = true;
  sessionId = "";
  place: string | null = null;
  readOnly = false;
  owner = false;
  identityId = 0;
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
  };
  const expiry = claimExpiryTimer(db, handles => wake(hub, handles));
  const revoked = new Map<number, number>();
  function release(session: ApplicationSession, why: string) {
    if (!session.owner) return;
    session.owner = false;
    logBinding(db, session.sessionId, session.identityFull, "released", why);
  }
  function close(session: ApplicationSession, why = "connection closed") {
    session.active = false;
    hub.sessions.delete(session);
    if (hub.registry.get(session.identityFull) === session) hub.registry.delete(session.identityFull);
    if (hub.holders.get(session.identityFull) === session) {
      hub.holders.delete(session.identityFull);
      touchHandle(db, session.identityFull);
    }
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
  async function select(authed: AuthedUser, nameInput: string | undefined, sink: DeliverySink, m: IdentityOptions, human: boolean) {
    const { holders, registry } = hub;
    const push = m.push !== false;
    const owns = push || m.hold === true;
    const sessionId = m.session_key ? sessionIdOf(m.session_key) : mintSessionId();
    const session = new ApplicationSession(authed, sink, human, push);
    session.sessionId = sessionId;
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
    if (m.create === false && !repo.identities.findByUserAndName(authed.user_id, name)) {
      const known = closestNames(name, repo.identities.listForUser(authed.user_id).map((i) => i.name).filter((n) => n !== HUMAN_NAME));
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
    let identity = repo.identities.findByUserAndName(authed.user_id, name);
    if (!identity) {
      identity = repo.identities.create(authed.user_id, name);
      writeAudit(repo, "identity.created", authed.user_email, name, { lazy: true });
      onIdentityCreated(db, repo, authed.user_id, full);
    }

    session.identityId = identity.id;
    session.identityName = name;
    session.identityFull = full;
    hub.sessions.add(session);
    let moved: string[] | undefined;
    if (owns) {
      moved = [];
      holders.set(full, session);
      if (push) registry.set(full, session);
      // A reconnect, or a restart taking its name back, is the same session: its status stays.
      if (m.resume || m.restored_from) touchHandle(db, full);
      else startSession(db, full, null);
      setPlace(db, full, m.where ?? null);
      session.owner = true;
      if (from) {
        // The old connection, which the client closes next, holds nothing now.
        const prev = holders.get(from);
        if (prev) {
          holders.delete(from);
          if (registry.get(from) === prev) registry.delete(from);
          touchHandle(db, from);
        }
        moved = db.transaction(() => moveClaims(db, from, full))().map((c) => c.key);
        if (prev?.owner) release(prev, `rebound to ${full}`);
        else if (!lastWasRelease(db, from)) logBinding(db, sessionId, from, "released", `rebound to ${full}`);
        logBinding(db, sessionId, full, "moved", from);
      } else {
        const how = m.resume ? "reconnect" : m.restored_from ? `restored: restart of session ${m.restored_from}` : null;
        logBinding(db, sessionId, full, "bound", [how, notMoved].filter((d) => d !== null).join("; ") || null);
      }
    } else {
      touchHandle(db, full);
    }

    const info: IdentityInfo = { ...infoFor(full), ...(moved ? { moved } : {}), ...(notMoved ? { not_moved: notMoved } : {}) };
    const notices = [...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), h => lastSeen(db, h)), ...claimsInstruction(listClaims(db, undefined, full), full)];
    // The bridge's human attachment must not consume the owner's notice.
    if (!human) {
      const bridgeNotice = owedBridgeNotice(repo, authed.user_email);
      if (bridgeNotice) notices.push(bridgeNotice);
    }
    if (notices.length) info.notices = notices;
    return { session, info };
  }
  const application = {
    selectIdentity: (authed: AuthedUser, name: string | undefined, sink: DeliverySink, options: IdentityOptions = {}) => select(authed, name, sink, options, false),
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman: (authed: AuthedUser, sink: DeliverySink) => select(authed, HUMAN_NAME, sink, {}, true),
    close,
    replay(session: ApplicationSession) {
      valid(session, true);
      if (session.readOnly || !session.push || hub.registry.get(session.identityFull) !== session) return;
      const since = repo.cursors.get(session.identityId, "direct", session.identityFull);
      for (const message of repo.messages.unreadSince([{ type: "direct", ref: session.identityFull, since }])) {
        session.sink.deliver({ kind: "direct", message: showPending(message) });
      }
      drainBoards(session, db, true);
    },
    send(
      session: ApplicationSession,
      recipient: string,
      body: string,
      options: { parent_id?: number; pending?: boolean; attachment_ids?: number[] } = {},
    ) {
      valid(session);
      return handleSend(hub, session, recipient, body, options.parent_id ?? null, options.pending === true, options.attachment_ids);
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
      handleRetract(hub, session, id);
    },
    call(session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      valid(session, UNBOUND_READS.has(tool));
      const result = handleCall(hub, session, tool, args, publish);
      expiry.arm();
      return result;
    },
    wake: (handles: string[]) => wake(hub, handles),
    disconnectUser(userId: number) {
      revoked.set(userId, (revoked.get(userId) ?? 0) + 1);
      for (const s of [...hub.sessions]) {
        if (!s.human && s.authed.user_id === userId) {
          terminate(s, new ApplicationError("unauthenticated", "an admin signed this user out"));
        }
      }
    },
    revalidate() {
      for (const s of [...hub.sessions]) {
        if (!s.human && repo.users.findById(s.authed.user_id)?.disabled_at != null) {
          application.disconnectUser(s.authed.user_id);
        }
      }
    },
    heartbeat() {
      application.revalidate();
      for (const s of hub.sessions) s.sink.keepAlive?.();
    },
    stopExpiry: expiry.stop,
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
  const names = repo.identities.listForUser(authed.user_id).map((i) => i.name).filter(free);
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
    if (repo.identities.findByUserAndName(authed.user_id, name)) {
      input = formatDirectAddress(authed.user_email, name);
    } else if (name === HUMAN_NAME) {
      // Every linked user has one; listing them would only leak who linked.
      fail("not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
    } else {
      const all = repo.identities.findAllByName(name);
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

function handleSend(
  hub: Hub,
  session: ApplicationSession,
  recipientStr: string,
  body: string,
  parentId: number | null,
  pending: boolean,
  attachmentIdsRaw: unknown,
): SendResult {
  const { repo, db, registry } = hub;
  let ids: number[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
  } catch (e) {
    return fail("bad_request", (e as Error).message);
  }

  const { authed } = session;
  const parsed = resolvePeer(repo, session, recipientStr);

  const principal: SendPrincipal = {
    user_id:       authed.user_id,
    user_email:    authed.user_email,
    identity_id:   session.identityId,
    identity_name: session.identityName,
    identity_full: session.identityFull,
  };

  if (parsed.kind === "team") {
    fail("bad_request", `${parsed.full} isn't a person; to reach a team, board_post to its board #${parsed.name}`);
  }

  const recipientUser = repo.users.findByEmail(parsed.email);
  if (!recipientUser) {
    fail("not_found", `user "${parsed.email}" not found`);
  }
  const recipientIdentity = repo.identities.findByUserAndName(recipientUser.id, parsed.name);
  if (!recipientIdentity) {
    fail("not_found", `identity "${parsed.full}" not found; peer_list shows exact handles`);
  }
  const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) {
    fail(decision.code, decision.reason);
  }

  if (parentId !== null && !participant(repo.messages.getById(parentId), session.identityFull)) {
    fail("not_found", `parent_id ${parentId} is not a message you sent or received`);
  }

  let msg: MessageRow;
  try {
    msg = repo.messages.insert(session.identityFull, "user", parsed.full, body, parentId, pending, ids);
  } catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    throw e;
  }
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, "attachment.bound", authed.user_email, `attachment:${a.id}`, { identity: session.identityFull, message_id: msg.id, recipient: parsed.full });
  }
  const p = { ...(pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) };

  let deliveredNow = false;
  const recipientSession = registry.get(parsed.full);
  if (recipientSession?.active) {
    recipientSession.sink.deliver({ kind: "direct", message: showPending(msg) });
    deliveredNow = true;
  }

  if (deliveredNow) {
    return { message_id: msg.id, delivered_now: true, ...p };
  }
  const seen = lastSeen(db, parsed.full);
  return {
    message_id: msg.id,
    delivered_now: false,
    ...p,
    ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
    undelivered_from_you: repo.messages.undeliveredFrom(session.identityFull).find((u) => u.recipient === parsed.full)?.n ?? 1,
    note: queuedNote(parsed.full, seen),
  };
}

// The cursor moves only when the recipient acks, so a live recipient may hold
// a pushed message past it: liveness counts as reached too.
function handleRetract(hub: Hub, session: ApplicationSession, id: number): void {
  const { repo, registry } = hub;
  const m = repo.messages.getById(id);
  if (!m || m.recipient_type !== "user" || m.sender !== session.identityFull) {
    return fail("not_found", retractRefusal.notYours(id));
  }
  if (registry.get(m.recipient)?.active || repo.cursors.directFor(m.recipient) >= m.id) {
    return fail("bad_request", retractRefusal.reached(id, m.recipient));
  }
  if (!repo.messages.retract(session.identityFull, id)) return fail("bad_request", retractRefusal.replied(id));

  void sweepBlobs(hub.db, repo.blobs);
}

function handleCall(hub: Hub, session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void): unknown {
  const { db } = hub;
  if (!isBoardTool(tool)) {
    fail("bad_request", `unknown tool: ${tool}`);
  }
  let outcome;
  try {
    outcome = callBoardTool(db, session.identityFull, tool, args, {
      online: (h) => hub.registry.get(h)?.active === true,
      attachmentLimits: hub.repo.attachmentLimits,
      ...(tool === "peer_list" ? { unbound: unboundPeers(hub, session) } : {}),
    });
  } catch (e) {
    if (e instanceof CoreError) return fail("bad_request", e.message);
    console.error(`[grayboard] ${tool} failed:`, e);
    return fail("internal", `${tool} failed`);
  }
  if (tool === "board_post") {
    const r = outcome.result as { post_id: number; board: string; attachments?: AttachmentInfo[] };
    for (const a of r.attachments ?? []) {
      writeAudit(hub.repo, "attachment.bound", session.authed.user_email, `attachment:${a.id}`, { identity: session.identityFull, post_id: r.post_id, board: r.board });
    }
  }
  // The transitional adapter publishes its answer before the resulting deliveries.
  publish?.(outcome.result);
  wake(hub, outcome.wake);
  return outcome.result;
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
  return messages.map(showPending);
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
  const owed = unanswered(me, repo.messages.receivedUnacked(me, since), (id) => repo.messages.thread(id));
  const promises = promised(me, repo.messages.sentPending(me, Date.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
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
  return messages.map(showPending);
}

function handleAck(session: ApplicationSession, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move your cursor.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== session.identityFull) continue;
    repo.cursors.advance(session.identityId, "direct", session.identityFull, msgId);
  }
}
