import type { ServerWebSocket } from "bun";
import type { Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk } from "../shared/protocol.ts";
import { formatTeamAddress, isValidIdentityName } from "../shared/addressing.ts";
import { canSend, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { parseAddress } from "../shared/addressing.ts";

const MAX_BODY_BYTES = 64 * 1024;

export type WsData = {
  authed: AuthedUser;
  identityId: number;
  identityName: string;
  identityFull: string;
  ready: boolean;
};

// identity_id -> open WebSocket
const registry = new Map<number, ServerWebSocket<WsData>>();

export function getRegistry(): Map<number, ServerWebSocket<WsData>> {
  return registry;
}

function send(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function err(ws: ServerWebSocket<WsData>, reqId: string | undefined, code: ServerMessage & { type: "error" } extends { code: infer C } ? C : never, message: string): void {
  ws.send(JSON.stringify({ type: "error", req_id: reqId, code, message }));
}

export function createWsHandlers(repo: Repo) {
  return {
    open(_ws: ServerWebSocket<WsData>) {
      // wait for hello
    },

    message(ws: ServerWebSocket<WsData>, rawData: string | Buffer) {
      const raw = typeof rawData === "string" ? rawData : rawData.toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "bad_request", message: "invalid JSON" }));
        return;
      }

      let msg;
      try {
        msg = parseClientMessage(parsed);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", code: "bad_request", message: String(e) }));
        return;
      }

      if (msg.type === "pong") return;

      if (!ws.data.ready) {
        if (msg.type !== "hello") {
          ws.send(JSON.stringify({ type: "error", code: "bad_request", message: "send hello first" }));
          ws.close();
          return;
        }
        handleHello(ws, msg.req_id, msg.identity, repo);
        return;
      }

      switch (msg.type) {
        case "hello":
          ws.send(JSON.stringify({ type: "error", req_id: msg.req_id, code: "bad_request", message: "already authenticated" }));
          break;
        case "send":
          handleSend(ws, msg.req_id, msg.recipient, msg.body, msg.parent_id ?? null, repo);
          break;
        case "history":
          handleHistory(ws, msg.req_id, msg.peer, msg.limit, msg.before_id, repo);
          break;
        case "thread":
          handleThread(ws, msg.req_id, msg.root_id, repo);
          break;
        case "ack":
          handleAck(ws, msg.req_id, msg.message_ids, repo);
          break;
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const id = ws.data.identityId;
      if (id !== undefined && registry.get(id) === ws) {
        registry.delete(id);
      }
    },
  };
}

function handleHello(
  ws: ServerWebSocket<WsData>,
  reqId: string,
  identityInput: string,
  repo: Repo,
): void {
  const name = identityInput.toLowerCase();
  if (!isValidIdentityName(name)) {
    ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "bad_request", message: "invalid identity name" }));
    ws.close();
    return;
  }

  const { authed } = ws.data;

  let identity = repo.identities.findByUserAndName(authed.user_id, name);
  if (!identity) {
    identity = repo.identities.create(authed.user_id, name);
    writeAudit(repo, "identity.created", authed.user_email, name, { lazy: true });
  }

  // Supersede any existing connection for this identity
  const existing = registry.get(identity.id);
  if (existing && existing !== ws) {
    existing.send(JSON.stringify({ type: "error", code: "superseded", message: "a newer session connected with this identity" }));
    existing.close();
    registry.delete(identity.id);
  }

  registry.set(identity.id, ws);
  ws.data.identityId   = identity.id;
  ws.data.identityName = name;
  ws.data.identityFull = `${authed.user_email}/${name}`;
  ws.data.ready        = true;

  const teams = repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name));

  // Initialize missing team cursors (new member — no history replay)
  for (const teamRef of teams) {
    repo.cursors.initTeamCursorToCurrentMax(identity.id, teamRef);
  }

  const helloOk: HelloOk = {
    type: "hello_ok",
    req_id: reqId,
    identity_full: ws.data.identityFull,
    user_email: authed.user_email,
    teams,
  };
  ws.send(JSON.stringify(helloOk));

  drainForIdentity(ws, identity.id, ws.data.identityFull, teams, repo);
}

function drainForIdentity(
  ws: ServerWebSocket<WsData>,
  identityId: number,
  identityFull: string,
  teams: string[],
  repo: Repo,
): void {
  const streams: { type: "direct" | "team"; ref: string; since: number }[] = [
    { type: "direct", ref: identityFull, since: repo.cursors.get(identityId, "direct", identityFull) },
    ...teams.map(ref => ({ type: "team" as const, ref, since: repo.cursors.get(identityId, "team", ref) })),
  ];

  const messages = repo.messages.unreadSince(streams);
  for (const msg of messages) {
    ws.send(JSON.stringify({ type: "push", message: msg }));
  }
}

function handleSend(
  ws: ServerWebSocket<WsData>,
  reqId: string,
  recipientStr: string,
  body: string,
  parentId: number | null,
  repo: Repo,
): void {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "bad_request", message: "body exceeds 64 KiB limit" }));
    return;
  }

  let parsed;
  try {
    parsed = parseAddress(recipientStr);
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "bad_request", message: String(e) }));
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
    const team = repo.teams.findByName(parsed.name);
    if (!team) {
      ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "not_found", message: `team "${parsed.name}" not found` }));
      return;
    }
    const decision = canSend(principal, { kind: "team", team_id: team.id, name: team.name }, { db: repo, now: Date.now() });
    if (!decision.allow) {
      ws.send(JSON.stringify({ type: "error", req_id: reqId, code: decision.code, message: decision.reason }));
      return;
    }

    const msg = repo.messages.insert(ws.data.identityFull, "team", parsed.full, body, parentId);
    const delivered = fanOutToTeam(team.id, msg, repo);
    ws.send(JSON.stringify({ type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: delivered > 0 }));
  } else {
    // Direct
    const recipientUser = repo.users.findByEmail(parsed.email);
    if (!recipientUser) {
      ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "not_found", message: `user "${parsed.email}" not found` }));
      return;
    }
    const recipientIdentity = repo.identities.findByUserAndName(recipientUser.id, parsed.name);
    if (!recipientIdentity) {
      ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "not_found", message: `identity "${parsed.full}" not found` }));
      return;
    }
    const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now() });
    if (!decision.allow) {
      ws.send(JSON.stringify({ type: "error", req_id: reqId, code: decision.code, message: decision.reason }));
      return;
    }

    const msg = repo.messages.insert(ws.data.identityFull, "user", parsed.full, body, parentId);

    let deliveredNow = false;
    const recipientWs = registry.get(recipientIdentity.id);
    if (recipientWs) {
      recipientWs.send(JSON.stringify({ type: "push", message: msg }));
      deliveredNow = true;
    }

    ws.send(JSON.stringify({ type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: deliveredNow }));
  }
}

function fanOutToTeam(teamId: number, msg: import("../shared/protocol.ts").Message | import("./db.ts").MessageRow, repo: Repo): number {
  const memberUserIds = repo.teams.listMemberUserIds(teamId);
  let delivered = 0;
  for (const userId of memberUserIds) {
    const identities = repo.identities.listForUser(userId);
    for (const identity of identities) {
      const recipientWs = registry.get(identity.id);
      if (recipientWs) {
        recipientWs.send(JSON.stringify({ type: "push", message: msg }));
        delivered++;
      }
    }
  }
  return delivered;
}

function handleHistory(
  ws: ServerWebSocket<WsData>,
  reqId: string,
  peer: string | undefined,
  limit: number | undefined,
  beforeId: number | undefined,
  repo: Repo,
): void {
  try {
    if (peer) parseAddress(peer); // validate
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "bad_request", message: String(e) }));
    return;
  }
  const messages = repo.messages.history(ws.data.identityFull, peer, limit, beforeId);
  ws.send(JSON.stringify({ type: "history_ok", req_id: reqId, messages }));
}

function handleThread(
  ws: ServerWebSocket<WsData>,
  reqId: string,
  rootId: number,
  repo: Repo,
): void {
  const messages = repo.messages.thread(rootId);
  if (messages.length === 0) {
    ws.send(JSON.stringify({ type: "error", req_id: reqId, code: "not_found", message: `message ${rootId} not found` }));
    return;
  }
  ws.send(JSON.stringify({ type: "thread_ok", req_id: reqId, messages }));
}

function handleAck(
  ws: ServerWebSocket<WsData>,
  reqId: string,
  messageIds: number[],
  repo: Repo,
): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    if (!msg) continue;
    const identityId = ws.data.identityId;
    if (msg.recipient_type === "user") {
      repo.cursors.advance(identityId, "direct", ws.data.identityFull, msgId);
    } else {
      repo.cursors.advance(identityId, "team", msg.recipient, msgId);
    }
  }
  ws.send(JSON.stringify({ type: "ack_ok", req_id: reqId }));
}

export function startPingInterval(): void {
  setInterval(() => {
    for (const ws of registry.values()) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }
  }, 30_000);
}
