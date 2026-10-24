import { participant, type MessageRow, type Repo } from "./db.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address } from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { acknowledge, age, boardCatalog, canSeeBoard, checkBody, lastSeen, normalizeBoard, pendingFor, refOf, setPlace, snapshot, startSession, touchHandle, type CoreDb, type Pending, type PendingRef, type SnapshotOptions } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { attachmentIds, sweepBlobs } from "../core/attachments.ts";
import type { AttachmentInfo, AttachmentLimits } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { onIdentityCreated } from "./teams.ts";
import { PROMISE_DAYS, STALE_UNDELIVERED_MS, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showPending, unanswered, undeliveredInstruction, type InboxItem, type PromiseItem } from "../shared/inbox.ts";

export type ApplicationCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "internal"
  | "superseded"
  | "identity_in_use";

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationCode, message: string) {
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
export type IdentityOptions = {
  push?: boolean;
  where?: string;
  resume?: boolean;
  alive?: () => boolean;
};

// Only sessions registered by this application may execute operations.
export class ApplicationSession {
  readonly inflight = new Set<string>();
  active = true;
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
  probing: Map<string, Promise<boolean>>;
  sessions: Set<ApplicationSession>;
  probeMs: number;
  humanReach: HumanReach;
  slackRunning: () => boolean;
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

export function createApplication(repo: Repo, db: CoreDb, opts: ApplicationOptions = {}) {
  const hub: Hub = {
    repo,
    db,
    registry: new Map(),
    probing: new Map(),
    sessions: new Set(),
    probeMs: opts.probeMs ?? 2000,
    humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    boardChanged(board) {
      for (const observer of [...observers]) {
        if (observer.board === board && observerLive(observer)) notify(() => observer.hooks.changed());
      }
    },
  };
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
  function close(session: ApplicationSession) {
    session.active = false;
    hub.sessions.delete(session);
    for (const observer of [...observers]) if (observer.session === session) removeObserver(observer);
    if (hub.registry.get(session.identityFull) === session) {
      hub.registry.delete(session.identityFull);
      touchHandle(db, session.identityFull);
    }
  }
  function terminate(session: ApplicationSession, error: ApplicationError) {
    close(session);
    session.sink.closed(error);
  }
  function valid(session: ApplicationSession) {
    if (!session.active || !hub.sessions.has(session)) fail("unauthenticated", "session is closed");
    if (repo.users.findById(session.authed.user_id)?.disabled_at != null) {
      terminate(session, new ApplicationError("unauthenticated", "an admin signed this user out"));
      fail("unauthenticated", "an admin signed this user out");
    }
  }
  async function select(authed: AuthedUser, nameInput: string, sink: DeliverySink, options: IdentityOptions, human: boolean) {
    const name = nameInput.toLowerCase();
    if (!isValidIdentityName(name)) fail("bad_request", "invalid identity name");
    if ((name === HUMAN_NAME) !== human) fail("bad_request", name === HUMAN_NAME ? HUMAN_RESERVED : "the Slack bridge holds only human identities");
    const full = `${authed.user_email}/${name}`;
    const session = new ApplicationSession(authed, sink, human, options.push !== false);
    const epoch = revoked.get(authed.user_id);
    const alive = () => session.active && (options.alive?.() ?? true) && (human || revoked.get(authed.user_id) === epoch);
    // Every await can change the holder; nothing awaits between the final check and registration.
    while (session.push) {
      const inFlight = hub.probing.get(full);
      if (inFlight) {
        await inFlight;
        if (!alive()) fail("unauthenticated", "session is closed");
        continue;
      }
      const holder = hub.registry.get(full);
      if (!holder) break;
      const probing = holder.sink.probe(hub.probeMs).catch(() => false).finally(() => {
        if (hub.probing.get(full) === probing) hub.probing.delete(full);
      });
      hub.probing.set(full, probing);
      if (await probing) fail("identity_in_use", `identity "${name}" is already in use by a live session. Give this session a different BUS_IDENTITY.`);
      if (!alive()) fail("unauthenticated", "session is closed");
      if (hub.registry.get(full) === holder) terminate(holder, new ApplicationError("superseded", "a newer session connected with this identity"));
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
    if (session.push) {
      hub.registry.set(full, session);
      if (options.resume) {
        touchHandle(db, full);
      } else {
        startSession(db, full, null);
      }
      setPlace(db, full, options.where ?? null);
    } else {
      touchHandle(db, full);
    }
    const info: IdentityInfo = {
      identity_full: full,
      user_email: authed.user_email,
      teams: repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name)),
      human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
      attachment_limits: repo.attachmentLimits,
    };
    const notices = [...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), h => lastSeen(db, h)), ...claimsInstruction(listClaims(db, undefined, full), full)];
    if (notices.length) info.notices = notices;
    return { session, info };
  }
  const application = {
    selectIdentity: (authed: AuthedUser, name: string, sink: DeliverySink, options: IdentityOptions = {}) => select(authed, name, sink, options, false),
    // Trusted in-process bridge capability; never expose this through client arguments.
    attachHuman: (authed: AuthedUser, sink: DeliverySink) => select(authed, HUMAN_NAME, sink, {}, true),
    close,
    revalidateSession: valid,
    replay(session: ApplicationSession) {
      valid(session);
      if (!session.push || hub.registry.get(session.identityFull) !== session) return;
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
      valid(session);
      return boardCatalog(db, session.identityFull, after);
    },
    boardSnapshot(session: ApplicationSession, board: string, options: SnapshotOptions = {}) {
      valid(session);
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
      handleRetract(hub, session, id);
    },
    call(session: ApplicationSession, tool: string, args: Record<string, unknown>, publish?: (result: unknown) => void) {
      valid(session);
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
      for (const s of hub.sessions) s.sink.keepAlive?.();
    },
    stopExpiry() {
      expiry.stop();
      for (const observer of [...observers]) removeObserver(observer);
    },
  };
  return application;
}
export type Application = ReturnType<typeof createApplication>;

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
  for (const board of new Set(outcome.boards ?? [])) hub.boardChanged(board);
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
