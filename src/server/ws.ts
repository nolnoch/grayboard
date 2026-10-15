import type { ServerWebSocket } from "bun";
import type { Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk, type ErrorCode } from "../shared/protocol.ts";
import { formatTeamAddress, isValidIdentityName, parseAddress } from "../shared/addressing.ts";
import { canSend, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  CoreError,
  acknowledge,
  age,
  lastSeen,
  pendingFor,
  post,
  refOf,
  startSession,
  touchHandle,
  type CoreDb,
  type PendingRef,
} from "../core/boards.ts";
import { callBoardTool, isBoardTool } from "../core/tools.ts";
import { claimExpiryTimer } from "../core/claims.ts";
import { onIdentityCreated } from "./teams.ts";
import { inboxDays, unanswered } from "../shared/inbox.ts";

const MAX_BODY_BYTES = 64 * 1024;

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
};

type Ws = ServerWebSocket<WsData>;

export type WsOptions = {
  // How long a live connection has to answer a collision probe.
  probeMs?: number;
};

// Per server instance.
type Hub = {
  // identity_full -> open WebSocket
  registry: Map<string, Ws>;
  // identity_full values with a hello currently probing the existing holder
  probing: Set<string>;
  repo: Repo;
  db: CoreDb;
  probeMs: number;
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
function drainBoards(ws: Ws, db: CoreDb): void {
  const inflight = (ws.data.inflight ??= new Set());
  for (const item of pendingFor(db, ws.data.identityFull)) {
    const key = refKey(refOf(item));
    if (inflight.has(key)) continue;
    inflight.add(key);
    send(ws, { type: "board_push", item });
  }
}

function wake(hub: Hub, handles: string[]): void {
  for (const h of handles) {
    const ws = hub.registry.get(h);
    if (ws?.data.ready) drainBoards(ws, hub.db);
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
  const hub: Hub = { registry: new Map(), probing: new Set(), repo, db, probeMs: opts.probeMs ?? 2000 };
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
        err(ws, undefined, "bad_request", String(e));
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
        handleHello(hub, ws, msg.req_id, msg.identity).catch((e) => {
          console.error("[grayboard] hello failed:", e);
          err(ws, msg.req_id, "internal", "hello failed");
          ws.close();
        });
        return;
      }

      switch (msg.type) {
        case "hello":
          err(ws, msg.req_id, "bad_request", "already authenticated");
          break;
        case "send":
          handleSend(hub, ws, msg.req_id, msg.recipient, msg.body, msg.parent_id ?? null);
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
          if (!m || m.recipient_type !== "user" || m.recipient !== ws.data.identityFull) {
            err(ws, msg.req_id, "not_found", `no message ${msg.message_id} to you; dm_inbox lists them`);
            break;
          }
          repo.messages.ack(ws.data.identityFull, m.id);
          send(ws, { type: "ack_ok", req_id: msg.req_id });
          break;
        }
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
    },

    close(ws: Ws) {
      const full = ws.data.identityFull;
      if (full && hub.registry.get(full) === ws) {
        hub.registry.delete(full);
        touchHandle(hub.db, full);
      }
      ws.data.onPong = undefined;
    },
  };

  // Heartbeat: keeps idle connections open through proxies.
  const startPing = () =>
    setInterval(() => {
      for (const ws of hub.registry.values()) {
        if (ws.readyState === 1 /* OPEN */) send(ws, { type: "ping" });
      }
    }, 30_000);

  return { handlers, startPing, stopExpiry: expiry.stop };
}

async function handleHello(hub: Hub, ws: Ws, reqId: string, identityInput: string): Promise<void> {
  const { repo, db, registry } = hub;
  const name = identityInput.toLowerCase();
  if (!isValidIdentityName(name)) {
    err(ws, reqId, "bad_request", "invalid identity name");
    ws.close();
    return;
  }

  const { authed } = ws.data;
  const full = `${authed.user_email}/${name}`;

  // One live connection per identity. If the current holder still answers,
  // refuse the newcomer: taking over would let a stray second session (e.g.
  // a worktree that inherited .mcp.json) silently steal this identity's
  // deliveries. A holder that doesn't answer is dead; replace it.
  const existing = registry.get(full);
  if (existing && existing !== ws) {
    const refuse = () => {
      err(ws, reqId, "identity_in_use",
        `identity "${name}" is already in use by a live session. Give this session a different BUS_IDENTITY.`);
      ws.close();
    };
    if (hub.probing.has(full)) return refuse();
    hub.probing.add(full);
    let alive: boolean;
    try {
      alive = await probe(existing, hub.probeMs);
    } finally {
      hub.probing.delete(full);
    }
    if (alive) return refuse();
    if (ws.readyState !== 1 /* OPEN */) return;
    if (registry.get(full) === existing) {
      err(existing, undefined, "superseded", "a newer session connected with this identity");
      existing.close();
      registry.delete(full);
    }
  }

  let identity = repo.identities.findByUserAndName(authed.user_id, name);
  if (!identity) {
    identity = repo.identities.create(authed.user_id, name);
    writeAudit(repo, "identity.created", authed.user_email, name, { lazy: true });
    onIdentityCreated(db, repo, authed.user_id, full);
  }

  registry.set(full, ws);
  startSession(db, full, null);
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
  };
  send(ws, helloOk);

  // Direct messages since the cursor (unacked ones are resent), then boards.
  const since = repo.cursors.get(identity.id, "direct", full);
  for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
    send(ws, { type: "push", message });
  }
  drainBoards(ws, db);
}

function handleSend(
  hub: Hub,
  ws: Ws,
  reqId: string,
  recipientStr: string,
  body: string,
  parentId: number | null,
): void {
  const { repo, db, registry } = hub;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    err(ws, reqId, "bad_request", "body exceeds 64 KiB limit");
    return;
  }

  let parsed;
  try {
    parsed = parseAddress(recipientStr);
  } catch (e) {
    err(ws, reqId, "bad_request", String(e));
    return;
  }

  const { authed } = ws.data;
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
  const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now() });
  if (!decision.allow) {
    err(ws, reqId, decision.code, decision.reason);
    return;
  }

  const msg = repo.messages.insert(ws.data.identityFull, "user", parsed.full, body, parentId);

  let deliveredNow = false;
  const recipientWs = registry.get(parsed.full);
  if (recipientWs?.data.ready) {
    send(recipientWs, { type: "push", message: msg });
    deliveredNow = true;
  }

  if (deliveredNow) {
    send(ws, { type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: true });
    return;
  }
  const seen = lastSeen(db, parsed.full);
  send(ws, {
    type: "send_ok",
    req_id: reqId,
    message_id: msg.id,
    delivered_now: false,
    ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
    undelivered_from_you: repo.messages.undeliveredFrom(ws.data.identityFull).find((u) => u.recipient === parsed.full)?.n ?? 1,
  });
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
    });
  } catch (e) {
    if (e instanceof CoreError) return err(ws, reqId, "bad_request", e.message);
    console.error(`[grayboard] ${tool} failed:`, e);
    return err(ws, reqId, "internal", `${tool} failed`);
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
  try {
    if (peer) parseAddress(peer); // validate
  } catch (e) {
    err(ws, reqId, "bad_request", String(e));
    return;
  }
  const me = ws.data.identityFull;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  const messages = repo.messages.history(me, peer, limit, beforeId).map((m) =>
    m.sender === me && m.recipient_type === "user" && m.recipient !== me ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
  );
  send(ws, { type: "history_ok", req_id: reqId, messages });
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
  const queued = repo.messages.undeliveredFrom(me).map((u) => {
    const seen = lastSeen(db, u.recipient);
    return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(Date.now() - seen)} ago` } : {}) };
  });
  send(ws, { type: "inbox_ok", req_id: reqId, unanswered: owed, ...(queued.length ? { undelivered_from_you: queued } : {}) });
}

function handleThread(ws: Ws, reqId: string, messageId: number, repo: Repo): void {
  const messages = repo.messages.thread(messageId);
  if (messages.length === 0) {
    err(ws, reqId, "not_found", `message ${messageId} not found`);
    return;
  }
  send(ws, { type: "thread_ok", req_id: reqId, messages });
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
