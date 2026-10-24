import { participant, type MessageRow, type Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk, type HelloRequest, type ErrorCode } from "../shared/protocol.ts";
import {
  HUMAN_NAME, HUMAN_RESERVED, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address,
} from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  acknowledge,
  age,
  checkBody,
  lastSeen,
  pendingFor,
  post,
  refOf,
  sessionsSeen,
  setPlace,
  startSession,
  touchHandle,
  type CoreDb,
  type PendingRef,
  type UnboundPeer,
} from "../core/boards.ts";
import {
  MAX_CANDIDATES, UNBOUND_ERROR, UNBOUND_TOOLS, closestNames, logBinding, mintSessionId, orderCandidates, unknownNameError, type Candidate,
} from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { attachmentIds, sweepBlobs } from "../core/attachments.ts";
import type { AttachmentInfo } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims, moveClaims } from "../core/claims.ts";
import { onIdentityCreated } from "./teams.ts";
import {
  PROMISE_DAYS, STALE_UNDELIVERED_MS, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showPending, unanswered, undeliveredInstruction,
} from "../shared/inbox.ts";

export type WsData = {
  authed: AuthedUser;
  identityId: number;
  identityName: string;
  identityFull: string;
  ready: boolean;
  // Board items sent and not yet acked on this connection. Cleared with the
  // connection, so a reconnect resends them (at-least-once, like DMs).
  inflight?: Set<string>;
  // Set while a collision probe is waiting for this connection's pong.
  onPong?: () => void;
  // The server's Slack bridge holding a user's human identity: the only
  // connection allowed the reserved name, and drained like a human's session.
  human?: true;
  // The client process's session ID (#182): its own, or minted here for a
  // client from before session IDs. Keys binding_events.
  sessionId?: string;
  // Where the client runs, from its hello.
  place?: string | null;
  // An unbound session's read-only connection: its handle is
  // <email>/~<session id>, which no hello can name, and it may only read.
  readOnly?: true;
  // This connection holds its name: its close logs the release.
  owner?: true;
};

// What the hub needs of a connection: a client's WebSocket, or an in-process
// one (the Slack bridge's humans, src/server/slack.ts).
export type Conn = {
  data: WsData;
  readonly readyState: number;
  send(data: string): unknown;
  close(): void;
};

type Ws = Conn;

export type WsOptions = {
  // How long a live connection has to answer a collision probe.
  probeMs?: number;
  humanReach?: HumanReach;
  // Whether the Slack bridge is up; a linked human is reachable only then.
  slackRunning?: () => boolean;
};

// Per server instance.
type Hub = {
  // identity_full -> open WebSocket
  registry: Map<string, Ws>;
  // identity_full -> the probe a hello is running against its holder
  probing: Map<string, Promise<boolean>>;
  // Tools-only connections (hello push: false): pinged, never pushed to.
  toolsOnly: Set<Ws>;
  // Unbound sessions' read-only connections: pinged, shown by peer_list.
  readOnly: Set<Ws>;
  repo: Repo;
  db: CoreDb;
  probeMs: number;
  humanReach: HumanReach;
  slackRunning: () => boolean;
};

function send(ws: Ws, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function err(ws: Ws, reqId: string | undefined, code: ErrorCode, message: string): void {
  send(ws, { type: "error", req_id: reqId, code, message });
}

function refKey(r: PendingRef): string {
  // Digests are keyed by board: until one is acked, newer posts don't send another.
  return r.kind === "push" ? `p:${r.post_id}` : `d:${r.board}`;
}

// Send this connection everything pending on boards that it hasn't been sent.
// all: also deferred pushes and digests (at hello; see pendingFor).
function drainBoards(ws: Ws, db: CoreDb, all = false): void {
  const inflight = (ws.data.inflight ??= new Set());
  for (const item of pendingFor(db, ws.data.identityFull, { all })) {
    const key = refKey(refOf(item));
    if (inflight.has(key)) continue;
    inflight.add(key);
    send(ws, { type: "board_push", item });
  }
}

// A human's session has no wakes to save: it gets deferred pushes and
// digests at once.
function wake(hub: Hub, handles: string[]): void {
  for (const h of handles) {
    const ws = hub.registry.get(h);
    if (ws?.data.ready) drainBoards(ws, hub.db, ws.data.human === true);
  }
}

// Does the connection answer a ping within ms? The plugin pongs every ping.
function probe(ws: Ws, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.data.onPong = undefined;
      resolve(false);
    }, ms);
    ws.data.onPong = () => {
      clearTimeout(timer);
      ws.data.onPong = undefined;
      resolve(true);
    };
    try {
      send(ws, { type: "ping" });
    } catch {
      clearTimeout(timer);
      ws.data.onPong = undefined;
      resolve(false);
    }
  });
}

export function createWsHandlers(repo: Repo, db: CoreDb, opts: WsOptions = {}) {
  const hub: Hub = {
    registry: new Map(), probing: new Map(), toolsOnly: new Set(), readOnly: new Set(), repo, db,
    probeMs: opts.probeMs ?? 2000, humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
  };
  // Announces claims that lapse on their boards.
  const expiry = claimExpiryTimer(db, (handles) => wake(hub, handles));

  const handlers = {
    open(_ws: Ws) {
      // wait for hello
    },

    message(ws: Ws, rawData: string | Buffer) {
      const raw = typeof rawData === "string" ? rawData : rawData.toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        err(ws, undefined, "bad_request", "invalid JSON");
        return;
      }

      let msg;
      try {
        msg = parseClientMessage(parsed);
      } catch (e) {
        // Echo the req_id when there is one, or the client's call waits forever (#40).
        const reqId = (parsed as { req_id?: unknown } | null)?.req_id;
        err(ws, typeof reqId === "string" ? reqId : undefined, "bad_request", String(e));
        return;
      }

      if (msg.type === "pong") {
        ws.data.onPong?.();
        return;
      }

      if (!ws.data.ready) {
        if (msg.type !== "hello") {
          err(ws, undefined, "bad_request", "send hello first");
          ws.close();
          return;
        }
        handleHello(hub, ws, msg).catch((e) => {
          console.error("[grayboard] hello failed:", e);
          err(ws, msg.req_id, "internal", "hello failed");
          ws.close();
        });
        return;
      }

      // Every handler below reads ws.data.identityFull as a name's: a
      // read-only connection has none, so it gets only the unbound reads.
      if (ws.data.readOnly && !(msg.type === "call" && UNBOUND_TOOLS.has(msg.tool))) {
        err(ws, msg.req_id, "unbound", UNBOUND_ERROR);
        return;
      }

      // The handlers are synchronous: a throw (a bug, or a row deleted under
      // the connection) answers the call instead of leaving it to time out.
      try {
        switch (msg.type) {
          case "hello":
            err(ws, msg.req_id, "bad_request", "already authenticated");
            break;
          case "send":
            handleSend(hub, ws, msg.req_id, msg.recipient, msg.body, msg.parent_id ?? null, msg.pending === true, msg.attachment_ids);
            break;
          case "history":
            handleHistory(ws, msg.req_id, msg.peer, msg.limit, msg.before_id, repo);
            break;
          case "thread":
            handleThread(ws, msg.req_id, msg.message_id, repo);
            break;
          case "ack":
            handleAck(ws, msg.req_id, msg.message_ids, repo);
            break;
          case "inbox":
            handleInbox(hub, ws, msg.req_id, msg.days);
            break;
          case "dm_ack": {
            const m = repo.messages.getById(msg.message_id);
            const me = ws.data.identityFull;
            if (!m || m.recipient_type !== "user" || !(m.recipient === me || (m.sender === me && m.pending))) {
              err(ws, msg.req_id, "not_found", `no message ${msg.message_id} to you or pending from you; dm_inbox lists them`);
              break;
            }
            repo.messages.ack(ws.data.identityFull, m.id);
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
          }
          case "dm_retract":
            handleRetract(hub, ws, msg.req_id, msg.message_id);
            break;
          case "call":
            handleCall(hub, ws, msg.req_id, msg.tool, msg.args);
            expiry.arm();
            break;
          case "board_ack":
            for (const r of msg.refs) {
              acknowledge(db, ws.data.identityFull, r);
              ws.data.inflight?.delete(refKey(r));
            }
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
        }
      } catch (e) {
        console.error(`[grayboard] ${msg.type} failed:`, e);
        err(ws, msg.req_id, "internal", `${msg.type} failed`);
      }
    },

    close(ws: Ws) {
      hub.toolsOnly.delete(ws);
      hub.readOnly.delete(ws);
      const full = ws.data.identityFull;
      if (full && hub.registry.get(full) === ws) {
        hub.registry.delete(full);
        touchHandle(hub.db, full);
      }
      if (ws.data.owner) release(hub, ws, "connection closed");
      ws.data.onPong = undefined;
    },
  };

  // Auth is checked at the upgrade only. When an admin revokes or disables a
  // user, close their connections (#70): reconnecting then fails auth. The
  // Slack bridge's humans have their own path (SlackBridge.userChanged).
  const conns = () => [...hub.registry.values(), ...hub.toolsOnly, ...hub.readOnly].filter((ws) => !ws.data.human);
  const disconnectUser = (userId: number) => {
    for (const ws of conns()) {
      if (ws.data.authed.user_id !== userId) continue;
      err(ws, undefined, "unauthenticated", "an admin signed this user out");
      ws.close();
    }
  };
  // Catches a user disabled while one of their hellos was in flight.
  const revalidate = () => {
    for (const id of new Set(conns().map((ws) => ws.data.authed.user_id))) {
      if (repo.users.findById(id)?.disabled_at != null) disconnectUser(id);
    }
  };

  // Heartbeat: keeps idle connections open through proxies.
  const startPing = () =>
    setInterval(() => {
      revalidate();
      for (const ws of [...hub.registry.values(), ...hub.toolsOnly, ...hub.readOnly]) {
        if (ws.readyState === 1 /* OPEN */) send(ws, { type: "ping" });
      }
    }, 30_000);

  return {
    handlers, startPing, revalidate, disconnectUser, stopExpiry: expiry.stop,
    wake: (handles: string[]) => wake(hub, handles),
  };
}

// A connection that held its name gives it up: logged once, by whichever of
// close, supersede or rebind comes first.
function release(hub: Hub, ws: Ws, why: string): void {
  ws.data.owner = undefined;
  logBinding(hub.db, ws.data.sessionId!, ws.data.identityFull, "released", why);
}

function describeHolder(ws: Ws): string {
  return `the live session ${ws.data.sessionId}${ws.data.place ? `, in ${ws.data.place}` : ""}`;
}

async function handleHello(hub: Hub, ws: Ws, m: HelloRequest): Promise<void> {
  const { repo, db, registry } = hub;
  const reqId = m.req_id;
  const push = m.push !== false;
  // A client from before session IDs gets one here, so its events have a key.
  const sessionId = m.session_id ?? mintSessionId();
  ws.data.sessionId = sessionId;
  ws.data.place = m.where ?? null;
  if (m.read_only) return helloReadOnly(hub, ws, reqId, sessionId, m.suggested);

  const name = m.identity!.toLowerCase();
  if (!isValidIdentityName(name)) {
    err(ws, reqId, "bad_request", "invalid identity name");
    ws.close();
    return;
  }
  if ((name === HUMAN_NAME) !== (ws.data.human === true)) {
    err(ws, reqId, "bad_request", name === HUMAN_NAME ? HUMAN_RESERVED : "the Slack bridge holds only human identities");
    ws.close();
    return;
  }

  const { authed } = ws.data;
  const full = `${authed.user_email}/${name}`;
  // Only the connection that would hold the name logs: a tools-only one runs
  // beside the session that owns it.
  const refuse = (code: ErrorCode, message: string, detail: string, extra: { known?: string[]; holder?: string } = {}) => {
    if (push) logBinding(db, sessionId, full, "refused", detail);
    send(ws, { type: "error", req_id: reqId, code, message, ...extra });
    ws.close();
  };

  // A typo would otherwise create a fresh name, and the DMs queued for the
  // intended one would never arrive.
  if (m.create === false && !repo.identities.findByUserAndName(authed.user_id, name)) {
    const known = closestNames(name, repo.identities.listForUser(authed.user_id).map((i) => i.name).filter((n) => n !== HUMAN_NAME));
    const message = unknownNameError(name, known);
    refuse("identity_unknown", message, message, { known });
    return;
  }

  // One live connection per identity. If the current holder still answers,
  // refuse the newcomer: taking over would let a stray second session (e.g.
  // a worktree that inherited .mcp.json) silently steal this identity's
  // deliveries. A holder that doesn't answer is dead; replace it. Each await
  // can change the registry (a close, another hello), so after one, check
  // again from the top; between the last check and registry.set below
  // nothing awaits (#69).
  while (push) {
    const inFlight = hub.probing.get(full);
    if (inFlight) {
      // Another hello is probing the holder: whoever wins, it's settled after.
      await inFlight;
      if (ws.readyState !== 1 /* OPEN */) return;
      continue;
    }
    const holder = registry.get(full);
    if (!holder || holder === ws) break;
    const probing = probe(holder, hub.probeMs).finally(() => {
      if (hub.probing.get(full) === probing) hub.probing.delete(full);
    });
    hub.probing.set(full, probing);
    if (await probing) {
      const who = describeHolder(holder);
      refuse("identity_in_use", `identity "${name}" is already in use by ${who}; bind another name.`, who, { holder: who });
      return;
    }
    if (ws.readyState !== 1 /* OPEN */) return;
    if (registry.get(full) === holder) {
      err(holder, undefined, "superseded", "a newer session connected with this identity");
      if (holder.data.owner) release(hub, holder, `superseded by session ${sessionId}`);
      holder.close();
      registry.delete(full);
    }
  }

  let identity = repo.identities.findByUserAndName(authed.user_id, name);
  if (!identity) {
    identity = repo.identities.create(authed.user_id, name);
    writeAudit(repo, "identity.created", authed.user_email, name, { lazy: true });
    onIdentityCreated(db, repo, authed.user_id, full);
  }

  let moved: string[] | undefined;
  if (push) {
    // The same session on another name is a rebind: its claims follow it, and
    // the old connection, which the client closes next, no longer holds that name.
    const previous = m.session_id === undefined ? undefined : [...registry.values()].find((c) =>
      c !== ws && c.data.sessionId === sessionId && c.data.authed.user_id === authed.user_id && c.data.identityFull !== full);
    registry.set(full, ws);
    // A reconnect, or a restart taking its name back, is the same session: its status stays.
    if (m.resume || m.restored_from) touchHandle(db, full);
    else startSession(db, full, null);
    setPlace(db, full, m.where ?? null);
    ws.data.owner = true;
    if (previous) {
      const from = previous.data.identityFull;
      moved = db.transaction(() => moveClaims(db, from, full))().map((c) => c.key);
      if (previous.data.owner) release(hub, previous, `rebound to ${full}`);
      logBinding(db, sessionId, full, "moved", from);
    } else logBinding(db, sessionId, full, "bound", m.resume ? "reconnect" : m.restored_from ? `restored: restart of session ${m.restored_from}` : null);
  } else {
    hub.toolsOnly.add(ws);
    touchHandle(db, full);
  }
  ws.data.identityId   = identity.id;
  ws.data.identityName = name;
  ws.data.identityFull = full;
  ws.data.ready        = true;

  const teams = repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name));

  const helloOk: HelloOk = {
    type: "hello_ok",
    req_id: reqId,
    identity_full: full,
    user_email: authed.user_email,
    teams,
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
    attachment_limits: repo.attachmentLimits,
    ...(moved ? { moved } : {}),
  };
  const notices = [
    ...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(db, undefined, full), full),
  ];
  if (notices.length) helloOk.notices = notices;
  send(ws, helloOk);
  if (!push) return;

  // Direct messages since the cursor (unacked ones are resent), then boards.
  const since = repo.cursors.get(identity.id, "direct", full);
  for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
    send(ws, { type: "push", message: showPending(message) });
  }
  drainBoards(ws, db, true);
}

// An unbound session's connection: reads only, as <email>/~<session id>.
// It writes no handles row (that would put it in dm_send's roster); the hub's
// readOnly set is its presence.
function helloReadOnly(hub: Hub, ws: Ws, reqId: string, sessionId: string, suggested?: string): void {
  const { repo, readOnly } = hub;
  const { authed } = ws.data;
  readOnly.add(ws);
  ws.data.readOnly     = true;
  ws.data.identityId   = 0;
  ws.data.identityName = `~${sessionId}`;
  ws.data.identityFull = `${authed.user_email}/~${sessionId}`;
  ws.data.ready        = true;
  send(ws, {
    type: "hello_ok",
    req_id: reqId,
    identity_full: ws.data.identityFull,
    user_email: authed.user_email,
    teams: repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name)),
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
    attachment_limits: repo.attachmentLimits,
    candidates: candidates(hub, authed, suggested),
  });
}

// The user's free names, for an unbound session to bind: `suggested` (the
// checkout's default) first, then the most pending work. Live names and the
// human are left out.
function candidates(hub: Hub, authed: AuthedUser, suggestedInput?: string): Candidate[] {
  const { repo, db, registry } = hub;
  const full = (n: string) => `${authed.user_email}/${n}`;
  const free = (n: string) => n !== HUMAN_NAME && !registry.has(full(n));
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
function unboundPeers(hub: Hub, ws: Ws): UnboundPeer[] {
  return [...hub.readOnly]
    .filter((c) => c.data.authed.user_id === ws.data.authed.user_id)
    .map((c) => ({
      session_id: c.data.sessionId!, unbound: true as const, online: true as const,
      ...(c.data.place ? { where: c.data.place } : {}),
      ...(c.data.sessionId === ws.data.sessionId ? { self: true as const } : {}),
    }));
}

// A bare name means your own identity of that name, else the one identity
// anyone has with it (as @name does in a post). Null once it has answered
// the request with why not.
function resolvePeer(repo: Repo, ws: Ws, reqId: string, input: string): Address | null {
  const { authed } = ws.data;
  if (isValidIdentityName(input)) {
    const name = input.toLowerCase();
    if (repo.identities.findByUserAndName(authed.user_id, name)) {
      input = formatDirectAddress(authed.user_email, name);
    } else if (name === HUMAN_NAME) {
      // Every linked user has one; listing them would only leak who linked.
      err(ws, reqId, "not_found", `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`);
      return null;
    } else {
      const all = repo.identities.findAllByName(name);
      if (all.length !== 1) {
        const which = all.length ? `several identities are named "${name}": ${all.map(i => formatDirectAddress(i.email, i.name)).sort().join(", ")}` : `no identity is named "${name}"`;
        err(ws, reqId, "not_found", `${which}; peer_list shows exact handles`);
        return null;
      }
      input = formatDirectAddress(all[0]!.email, name);
    }
  }
  try {
    return parseAddress(input);
  } catch (e) {
    err(ws, reqId, "bad_request", String(e));
    return null;
  }
}

function handleSend(
  hub: Hub,
  ws: Ws,
  reqId: string,
  recipientStr: string,
  body: string,
  parentId: number | null,
  pending: boolean,
  attachmentIdsRaw: unknown,
): void {
  const { repo, db, registry } = hub;
  let ids: number[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
  } catch (e) {
    return err(ws, reqId, "bad_request", (e as Error).message);
  }

  const { authed } = ws.data;
  const parsed = resolvePeer(repo, ws, reqId, recipientStr);
  if (!parsed) return;

  const principal: SendPrincipal = {
    user_id:       authed.user_id,
    user_email:    authed.user_email,
    identity_id:   ws.data.identityId,
    identity_name: ws.data.identityName,
    identity_full: ws.data.identityFull,
  };

  if (parsed.kind === "team") {
    err(ws, reqId, "bad_request", `${parsed.full} isn't a person; to reach a team, board_post to its board #${parsed.name}`);
    return;
  }

  const recipientUser = repo.users.findByEmail(parsed.email);
  if (!recipientUser) {
    err(ws, reqId, "not_found", `user "${parsed.email}" not found`);
    return;
  }
  const recipientIdentity = repo.identities.findByUserAndName(recipientUser.id, parsed.name);
  if (!recipientIdentity) {
    err(ws, reqId, "not_found", `identity "${parsed.full}" not found; peer_list shows exact handles`);
    return;
  }
  const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) {
    err(ws, reqId, decision.code, decision.reason);
    return;
  }

  if (parentId !== null && !participant(repo.messages.getById(parentId), ws.data.identityFull)) {
    err(ws, reqId, "not_found", `parent_id ${parentId} is not a message you sent or received`);
    return;
  }

  let msg: MessageRow;
  try {
    msg = repo.messages.insert(ws.data.identityFull, "user", parsed.full, body, parentId, pending, ids);
  } catch (e) {
    if (e instanceof CoreError) return err(ws, reqId, "bad_request", e.message);
    throw e;
  }
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, "attachment.bound", authed.user_email, `attachment:${a.id}`, { identity: ws.data.identityFull, message_id: msg.id, recipient: parsed.full });
  }
  const p = { ...(pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) };

  let deliveredNow = false;
  const recipientWs = registry.get(parsed.full);
  if (recipientWs?.data.ready) {
    send(recipientWs, { type: "push", message: showPending(msg) });
    deliveredNow = true;
  }

  if (deliveredNow) {
    send(ws, { type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: true, ...p });
    return;
  }
  const seen = lastSeen(db, parsed.full);
  send(ws, {
    type: "send_ok",
    req_id: reqId,
    message_id: msg.id,
    delivered_now: false,
    ...p,
    ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
    undelivered_from_you: repo.messages.undeliveredFrom(ws.data.identityFull).find((u) => u.recipient === parsed.full)?.n ?? 1,
    note: queuedNote(parsed.full, seen),
  });
}

// The cursor moves only when the recipient acks, so a live recipient may hold
// a pushed message past it: liveness counts as reached too.
function handleRetract(hub: Hub, ws: Ws, reqId: string, id: number): void {
  const { repo, registry } = hub;
  const m = repo.messages.getById(id);
  if (!m || m.recipient_type !== "user" || m.sender !== ws.data.identityFull) {
    return err(ws, reqId, "not_found", retractRefusal.notYours(id));
  }
  if (registry.get(m.recipient)?.data.ready || repo.cursors.directFor(m.recipient) >= m.id) {
    return err(ws, reqId, "bad_request", retractRefusal.reached(id, m.recipient));
  }
  if (!repo.messages.retract(ws.data.identityFull, id)) return err(ws, reqId, "bad_request", retractRefusal.replied(id));
  send(ws, { type: "ack_ok", req_id: reqId });
  void sweepBlobs(hub.db, repo.blobs);
}

function handleCall(hub: Hub, ws: Ws, reqId: string, tool: string, args: Record<string, unknown>): void {
  const { db } = hub;
  if (!isBoardTool(tool)) {
    err(ws, reqId, "bad_request", `unknown tool: ${tool}`);
    return;
  }
  let outcome;
  try {
    outcome = callBoardTool(db, ws.data.identityFull, tool, args, {
      online: (h) => hub.registry.get(h)?.data.ready === true,
      attachmentLimits: hub.repo.attachmentLimits,
      ...(tool === "peer_list" ? { unbound: unboundPeers(hub, ws) } : {}),
    });
  } catch (e) {
    if (e instanceof CoreError) return err(ws, reqId, "bad_request", e.message);
    console.error(`[grayboard] ${tool} failed:`, e);
    return err(ws, reqId, "internal", `${tool} failed`);
  }
  if (tool === "board_post") {
    const r = outcome.result as { post_id: number; board: string; attachments?: AttachmentInfo[] };
    for (const a of r.attachments ?? []) {
      writeAudit(hub.repo, "attachment.bound", ws.data.authed.user_email, `attachment:${a.id}`, { identity: ws.data.identityFull, post_id: r.post_id, board: r.board });
    }
  }
  send(ws, { type: "call_ok", req_id: reqId, result: outcome.result });
  wake(hub, outcome.wake);
}

function handleHistory(
  ws: Ws,
  reqId: string,
  peer: string | undefined,
  limit: number | undefined,
  beforeId: number | undefined,
  repo: Repo,
): void {
  let lim: number;
  try {
    lim = historyLimit(limit);
  } catch (e) {
    return err(ws, reqId, "bad_request", (e as Error).message);
  }
  let peerFull: string | undefined;
  if (peer) {
    const parsed = resolvePeer(repo, ws, reqId, peer);
    if (!parsed) return;
    peerFull = parsed.full;
  }
  const me = ws.data.identityFull;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const messages = repo.messages.history(me, peerFull, lim, beforeId).reverse().map((m) =>
    m.sender === me && m.recipient_type === "user" && m.recipient !== me ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
  );
  send(ws, { type: "history_ok", req_id: reqId, messages: messages.map(showPending) });
}

function handleInbox(hub: Hub, ws: Ws, reqId: string, days: number | undefined): void {
  const { repo, db } = hub;
  const me = ws.data.identityFull;
  let since: number;
  try {
    since = Date.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return err(ws, reqId, "bad_request", (e as Error).message);
  }
  const owed = unanswered(me, repo.messages.receivedUnacked(me, since), (id) => repo.messages.thread(id));
  const promises = promised(me, repo.messages.sentPending(me, Date.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
  const queued = repo.messages.undeliveredFrom(me).map((u) => {
    const seen = lastSeen(db, u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(Date.now() - seen)} ago` } : {}) };
  });
  send(ws, {
    type: "inbox_ok",
    req_id: reqId,
    unanswered: owed,
    ...(promises.length ? { promised: promises } : {}),
    ...(queued.length ? { undelivered_from_you: queued } : {}),
  });
}

function handleThread(ws: Ws, reqId: string, messageId: number, repo: Repo): void {
  const me = ws.data.identityFull;
  if (!participant(repo.messages.getById(messageId), me)) {
    err(ws, reqId, "not_found", `message ${messageId} not found`);
    return;
  }
  const messages = repo.messages.thread(messageId).filter((m) => participant(m, me));
  send(ws, { type: "thread_ok", req_id: reqId, messages: messages.map(showPending) });
}

function handleAck(ws: Ws, reqId: string, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move your cursor.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== ws.data.identityFull) continue;
    repo.cursors.advance(ws.data.identityId, "direct", ws.data.identityFull, msgId);
  }
  send(ws, { type: "ack_ok", req_id: reqId });
}
