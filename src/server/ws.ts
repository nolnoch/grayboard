import { participant, type MessageRow, type Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk, type ErrorCode } from "../shared/protocol.ts";
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
  setPlace,
  startSession,
  touchHandle,
  type CoreDb,
  type PendingRef,
} from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { attachmentIds, sweepBlobs } from "../core/attachments.ts";
import type { AttachmentInfo } from "../shared/attachments.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
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

// The bridge-down notice is durable, not hub memory: a fatal stop writes a
// `bridge.stopped` audit row per linked user (src/server/slack.ts), and the
// drain writes `bridge.notified`. An unsuppressed death newer than the last
// delivery is still owed — across a restart too, which is why it lives in
// the audit log — and drains once, at the user's next agent-session hello.
// Reads and the write run synchronously, so two hellos of one user can't
// both deliver.
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
    registry: new Map(), probing: new Map(), toolsOnly: new Set(), repo, db,
    probeMs: opts.probeMs ?? 2000, humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
  };
  // Announces claims that lapse on their boards.
  const expiry = claimExpiryTimer(db, (handles) => wake(hub, handles));

  const handlers = {
    open(_ws: Ws) {
      // wait for hello
    },
    // The Slack bridge died fatally: hold the notice for the owner's next
    // hello (any of their identities), drained once per user per stop.
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
        handleHello(hub, ws, msg.req_id, msg.identity, msg.push !== false, msg.where, msg.resume === true).catch((e) => {
          console.error("[grayboard] hello failed:", e);
          err(ws, msg.req_id, "internal", "hello failed");
          ws.close();
        });
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
      const full = ws.data.identityFull;
      if (full && hub.registry.get(full) === ws) {
        hub.registry.delete(full);
        touchHandle(hub.db, full);
      }
      ws.data.onPong = undefined;
    },
  };

  // Auth is checked at the upgrade only. When an admin revokes or disables a
  // user, close their connections (#70): reconnecting then fails auth. The
  // Slack bridge's humans have their own path (SlackBridge.userChanged).
  const conns = () => [...hub.registry.values(), ...hub.toolsOnly].filter((ws) => !ws.data.human);
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
      for (const ws of [...hub.registry.values(), ...hub.toolsOnly]) {
        if (ws.readyState === 1 /* OPEN */) send(ws, { type: "ping" });
      }
    }, 30_000);

  return {
    handlers, startPing, revalidate, disconnectUser, stopExpiry: expiry.stop,
    wake: (handles: string[]) => wake(hub, handles),
  };
}

async function handleHello(
  hub: Hub, ws: Ws, reqId: string, identityInput: string, push: boolean, where?: string, resume = false,
): Promise<void> {
  const { repo, db, registry } = hub;
  const name = identityInput.toLowerCase();
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
      err(ws, reqId, "identity_in_use",
        `identity "${name}" is already in use by a live session. Give this session a different BUS_IDENTITY.`);
      ws.close();
      return;
    }
    if (ws.readyState !== 1 /* OPEN */) return;
    if (registry.get(full) === holder) {
      err(holder, undefined, "superseded", "a newer session connected with this identity");
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

  if (push) {
    registry.set(full, ws);
    if (resume) touchHandle(db, full);
    else startSession(db, full, null);
    setPlace(db, full, where ?? null);
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
  };
  const notices = [
    ...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(db, undefined, full), full),
  ];
  // Bridge-down notices drain on agent-session hellos only: the bridge's own
  // human hello (HumanConn) would steal the notice into a handshake nobody
  // reads, leaving the owner uninformed.
  if (!ws.data.human) {
    const bridgeNotice = owedBridgeNotice(repo, authed.user_email);
    if (bridgeNotice) notices.push(bridgeNotice);
  }
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
