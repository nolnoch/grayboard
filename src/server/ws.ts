import type { MessageRow, Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk, type ErrorCode } from "../shared/protocol.ts";
import {
  HUMAN_NAME, HUMAN_RESERVED, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address,
} from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import {
  CoreError,
  acknowledge,
  age,
  endLane,
  laneStreamRef,
  lastSeen,
  MAIN_LANE,
  pendingFor,
  post,
  refOf,
  setPlace,
  startSession,
  touchHandle,
  touchHandleIfExists,
  type CoreDb,
  type PendingRef,
} from "../core/boards.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { onIdentityCreated } from "./teams.ts";
import {
  PROMISE_DAYS, STALE_UNDELIVERED_MS, dmBody, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showPending, unanswered, undeliveredInstruction,
} from "../shared/inbox.ts";

export type WsData = {
  authed: AuthedUser;
  identityId: number;
  identityName: string;
  identityFull: string;
  ready: boolean;
  // This connection's lane within the identity's fleet (default "main").
  lane: string;
  // A push-capable lane that isn't the owner (demoted): first in line for
  // rotation. Ownership itself is the hub's registry slot.
  pushWanted: boolean;
  joinedAt: number;
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
  // identity_full -> the one push owner (the delivery slot; rotation moves it)
  registry: Map<string, Ws>;
  // identity_full -> the probe a hello is running against its holder
  probing: Map<string, Promise<boolean>>;
  // Tools-only connections (hello push: false, or demoted lanes): pinged,
  // never pushed to (until a demoted one is rotated into the registry).
  toolsOnly: Set<Ws>;
  // `${identity_full}\0${lane}` -> its push-capable connection: the owner of
  // that lane key (registry owner or a demoted lane). Tools-only connections
  // claim no lane key.
  laneHolders: Map<string, Ws>;
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

const laneKeyOf = (full: string, lane: string): string => `${full}\u0000${lane}`;

// Every live connection of one identity (its fleet), owner and tools-only.
function fleetConns(hub: Hub, full: string): Ws[] {
  const out: Ws[] = [];
  const owner = hub.registry.get(full);
  if (owner) out.push(owner);
  for (const ws of hub.toolsOnly) if (ws.data.ready && ws.data.identityFull === full) out.push(ws);
  return out;
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
    registry: new Map(), probing: new Map(), toolsOnly: new Set(), laneHolders: new Map(), repo, db,
    probeMs: opts.probeMs ?? 2000, humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
  };
  // Announces claims that lapse on their boards.
  const expiry = claimExpiryTimer(db, (handles) => wake(hub, handles));

  // Rotation: hand the identity's push slot to its oldest live push-capable
  // lane. Synchronous — no await between the slot's delete and re-set, so
  // zero owners exists only inside this function.
  const rotateOwner = (full: string, fromLane: string, cause: "close" | "yield"): void => {
    let promote: Ws | undefined;
    for (const [key, ws] of hub.laneHolders) {
      if (!key.startsWith(`${full}\u0000`) || ws.readyState !== 1 /* OPEN */) continue;
      if (!promote || ws.data.joinedAt < promote.data.joinedAt) promote = ws;
    }
    if (!promote) return;
    hub.registry.set(full, promote);
    hub.toolsOnly.delete(promote);
    send(promote, { type: "fleet", event: "owner_rotated", lane: promote.data.lane });
    // Its own DM stream since its cursor (routing key is the identity; the
    // lane's cursor row is the stream), then everything pending on boards:
    // at-least-once, duplicates are the safe direction.
    const ref = laneStreamRef(full, promote.data.lane);
    const since = repo.cursors.get(promote.data.identityId, "direct", ref);
    for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
      send(promote, { type: "push", message: showPending(message) });
    }
    drainBoards(promote, db, true);
    writeAudit(repo, "lane.owner_rotated", null, promote.data.identityName, { from_lane: fromLane, to_lane: promote.data.lane, cause });
  };

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
        handleHello(hub, ws, msg.req_id, msg.identity, msg.push !== false, msg.where, msg.resume === true, msg.lane, msg.explicit === true).catch((e) => {
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
            handleSend(hub, ws, msg.req_id, msg.recipient, msg.body, msg.parent_id ?? null, msg.pending === true);
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
      if (full) {
        const key = laneKeyOf(full, ws.data.lane);
        if (hub.laneHolders.get(key) === ws) {
          // Auto-drop: a lane's row goes with its connection (a dead lane
          // cannot ghost). Sticky bridge lanes keep theirs (their handle is
          // the human's, and the local sweep exempts them there).
          hub.laneHolders.delete(key);
          endLane(hub.db, full, ws.data.lane);
          writeAudit(hub.repo, "lane.dropped", null, ws.data.identityName, { lane: ws.data.lane, cause: "close" });
        }
        if (hub.registry.get(full) === ws) {
          hub.registry.delete(full);
          rotateOwner(full, ws.data.lane, "close");
        }
        // Only a handle that still exists: a deleted identity's close must
        // not re-insert it into the roster (#73).
        touchHandleIfExists(hub.db, full);
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
    // Lane truth for the HTTP surface (`grayboard fleet`).
    fleetState: () => {
      const out: { identity_full: string; lane: string; live: boolean; push_owner: boolean }[] = [];
      for (const [key, ws] of hub.laneHolders) {
        const i = key.indexOf("\u0000");
        out.push({
          identity_full: key.slice(0, i),
          lane: key.slice(i + 1),
          live: ws.readyState === 1 /* OPEN */,
          push_owner: hub.registry.get(key.slice(0, i)) === ws,
        });
      }
      return out;
    },
    // The identity's owner (its user, via the CLI) disconnects one lane: all
    // its live connections close superseded-style; audit rides the caller.
    disconnectLane: (full: string, lane: string): boolean => {
      let closed = false;
      const note = `the identity's owner disconnected lane "${lane}"`;
      for (const ws of fleetConns(hub, full)) {
        if (ws.data.lane !== lane) continue;
        err(ws, undefined, "superseded", note);
        ws.close();
        closed = true;
      }
      return closed;
    },
    // Every live connection of an identity (identity delete, #73's fix shape).
    disconnectIdentity: (full: string): void => {
      for (const ws of fleetConns(hub, full)) {
        err(ws, undefined, "superseded", "this identity was deleted");
        ws.close();
      }
    },
  };
}

async function handleHello(
  hub: Hub, ws: Ws, reqId: string, identityInput: string, push: boolean, where?: string, resume = false, laneInput?: string, explicit = false,
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
  let lane = MAIN_LANE;
  if (laneInput !== undefined) {
    lane = laneInput.toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(lane)) {
      err(ws, reqId, "bad_request", `invalid lane "${laneInput}": 1-32 chars, a-z 0-9 _ -`);
      ws.close();
      return;
    }
  }

  const { authed } = ws.data;
  const full = `${authed.user_email}/${name}`;

  // One push session per lane key. If its holder still answers, refuse the
  // newcomer: taking over would let a stray second session silently steal
  // that lane's deliveries. A holder that doesn't answer is dead; replace it.
  // A live owner on ANOTHER lane means a fleet: the newcomer joins as a tool
  // lane instead (demotion, below) — the single-session refusal is gone for
  // same-user sessions on distinct lanes. Each await can change the holders
  // (a close, another hello), so after one, check again from the top; between
  // the last check and the writes below nothing awaits (#69).
  const key = laneKeyOf(full, lane);
  while (push) {
    const inFlight = hub.probing.get(key);
    if (inFlight) {
      // Another hello is probing this lane's holder: whoever wins, it's settled after.
      await inFlight;
      if (ws.readyState !== 1 /* OPEN */) return;
      continue;
    }
    const holder = hub.laneHolders.get(key);
    if (!holder || holder === ws) break;
    const probing = probe(holder, hub.probeMs).finally(() => {
      if (hub.probing.get(key) === probing) hub.probing.delete(key);
    });
    hub.probing.set(key, probing);
    if (await probing) {
      err(ws, reqId, "identity_in_use",
        `identity "${name}" is already in use by a live session on lane "${lane}". Give this session a different BUS_IDENTITY or BUS_LANE.`);
      ws.close();
      return;
    }
    if (ws.readyState !== 1 /* OPEN */) return;
    if (hub.laneHolders.get(key) === holder) {
      err(holder, undefined, "superseded", "a newer session connected with this identity and lane");
      holder.close();
      // Its close handler may not have run yet; take its places now, so the
      // writes below don't race it.
      hub.toolsOnly.delete(holder);
      if (hub.registry.get(full) === holder) hub.registry.delete(full);
      hub.laneHolders.delete(key);
    }
  }

  let identity = repo.identities.findByUserAndName(authed.user_id, name);
  const created = !identity;
  if (!identity) {
    // An explicit join (BUS_IDENTITY) attaches or refuses — never a lazy
    // fork: a typo'd name must not create a look-alike identity. A user with
    // no identities yet is bootstrapping (the adapter flow: pin, launch), so
    // the first identity still lazy-creates. Derived identities (pin or
    // directory default) keep the lazy create below, as they always have.
    if (explicit) {
      // The human identity (created by a Slack link) doesn't count: a linked
      // user's first AGENT identity is still a bootstrap, not a typo.
      const mine = repo.identities.listForUser(authed.user_id).filter((i) => i.name !== HUMAN_NAME);
      if (mine.length > 0) {
        err(ws, reqId, "not_found",
          `no identity "${name}" for your account; your identities: ${mine.map((i) => `${authed.user_email}/${i.name}`).join(", ")}`);
        ws.close();
        return;
      }
    }
    identity = repo.identities.create(authed.user_id, name);
    writeAudit(repo, "identity.created", authed.user_email, name, { lazy: true });
    onIdentityCreated(db, repo, authed.user_id, full);
  }

  // A push hello that found the identity's delivery already owned by a live
  // owner on another lane: join as a tools-only lane, first in line for
  // rotation when the owner ends (takeover is refused). A lane-less hello —
  // a client predating lanes — is refused instead: it would silently join
  // as tools-only, never receiving the pushes it asked for and ignoring the
  // field that says so. Lane-aware clients always send their lane, so only
  // old clients hit this; they see the refusal they have always seen.
  const owner = registry.get(full);
  if (push && laneInput === undefined && owner && owner !== ws && owner.data.lane !== MAIN_LANE) {
    err(ws, reqId, "identity_in_use",
      `identity "${name}" is already in use by a live session. Give this session a different BUS_IDENTITY.`);
    ws.close();
    return;
  }
  const demoted = push && !!owner && owner !== ws;

  ws.data.identityId   = identity.id;
  ws.data.identityName = name;
  ws.data.identityFull = full;
  ws.data.lane         = lane;
  ws.data.pushWanted   = push;
  ws.data.joinedAt     = Date.now();
  ws.data.ready        = true;

  if (push) {
    hub.laneHolders.set(key, ws);
    startSession(db, full, null, lane, { push_capable: true, resume });
    setPlace(db, full, where ?? null, lane);
    if (demoted) hub.toolsOnly.add(ws);
    else registry.set(full, ws);
    writeAudit(repo, "lane.joined", authed.user_email, name, { lane, push_granted: !demoted, created });
  } else {
    hub.toolsOnly.add(ws);
    touchHandle(db, full);
  }

  const teams = repo.teams.listForUser(authed.user_id).map(t => formatTeamAddress(t.name));

  const helloOk: HelloOk = {
    type: "hello_ok",
    req_id: reqId,
    identity_full: full,
    user_email: authed.user_email,
    teams,
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
    ...(lane !== MAIN_LANE ? { lane } : {}),
    ...(demoted ? { push_granted: false, owner_lane: owner!.data.lane } : {}),
  };
  const notices = [
    ...(created ? [`New identity "${full}" created for you by this session.`] : []),
    ...(demoted ? [`Push delivery for this identity is owned by lane "${owner!.data.lane}"; this session joined as a tool lane and takes over when that lane ends.`] : []),
    ...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(db, undefined, full), full),
  ];
  if (notices.length) helloOk.notices = notices;
  send(ws, helloOk);
  if (demoted) {
    // The owner learns its fleet grew; the demoted lane already knows from hello_ok.
    const ownerWs = registry.get(full);
    if (ownerWs?.data.ready) send(ownerWs, { type: "fleet", event: "lane_joined", lane });
  }
  if (!push) return;

  // This lane's direct messages since its own cursor (the cursor row is the
  // lane's stream; the messages themselves route by the identity). A fresh
  // non-main lane seeds from main's so joining doesn't replay the history.
  const laneRef = laneStreamRef(full, lane);
  let since = repo.cursors.get(identity.id, "direct", laneRef);
  if (lane !== MAIN_LANE && since === 0) {
    const mainSince = repo.cursors.get(identity.id, "direct", full);
    if (mainSince > 0) {
      repo.cursors.advance(identity.id, "direct", laneRef, mainSince);
      since = mainSince;
    }
  }
  for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
    send(ws, { type: "push", message: showPending(message) });
  }
  // Boards drain for the owner only: one delivery owner, one ack writer.
  // A demoted lane catches up on boards when it is rotated in.
  if (!demoted) drainBoards(ws, db, true);
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
): void {
  const { repo, db, registry } = hub;
  try {
    dmBody(body);
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

  const msg = repo.messages.insert(ws.data.identityFull, "user", parsed.full, body, parentId, pending);
  const p = pending ? { pending: true as const } : {};

  let deliveredNow = false;
  const recipientWs = registry.get(parsed.full);
  if (recipientWs?.data.ready) {
    send(recipientWs, { type: "push", message: showPending(msg) });
    deliveredNow = true;
  }

  // Fleet delivery truth: the recipient identity's live lanes and which
  // lanes have read this message (only when it has more than the default,
  // so single-session results stay unchanged).
  const truth = (parsed.full === ws.data.identityFull || fleetConns(hub, parsed.full).length > 1)
    ? fleetTruth(hub, repo, parsed.full, msg.id)
    : undefined;
  const fleet = truth && (truth.live_lanes > 1 || truth.read_lanes.length > 0)
    ? { live_lanes: truth.live_lanes, ...(truth.read_lanes.length ? { read_lanes: truth.read_lanes } : {}) }
    : undefined;

  if (deliveredNow) {
    send(ws, { type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: true, ...p, ...fleet });
    return;
  }
  const seen = lastSeen(db, parsed.full);
  send(ws, {
    type: "send_ok",
    req_id: reqId,
    message_id: msg.id,
    delivered_now: false,
    ...p,
    ...fleet,
    ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
    undelivered_from_you: repo.messages.undeliveredFrom(ws.data.identityFull).find((u) => u.recipient === parsed.full)?.n ?? 1,
    note: queuedNote(parsed.full, seen),
  });
}

// Fleet delivery truth for send_ok: how many of the recipient identity's
// lanes are live, and which lanes are caught up to just before this message
// (per-lane cursors: a lane's ack is its own reading; any lane's ack is the
// identity reading). A fresh message can't have been read by anyone yet;
// "caught up before it" is the honest sender-side marker.
function fleetTruth(hub: Hub, repo: Repo, recipientFull: string, messageId: number): { live_lanes: number; read_lanes: string[] } {
  const live = fleetConns(hub, recipientFull).filter((ws) => ws.data.ready).length;
  const read = repo.cursors.lanesRead(recipientFull, Math.max(1, messageId - 1));
  return { live_lanes: live, read_lanes: read };
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
      lane: ws.data.lane,
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

// Only a message's sender and recipient can see it, or thread from it. A
// message you're not in reads as missing, so its existence doesn't leak.
function participant(m: MessageRow | undefined, me: string): m is MessageRow {
  return !!m && m.recipient_type === "user" && (m.sender === me || m.recipient === me);
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
    // Only your own direct messages move your cursor — this lane's own
    // stream, so a lane's ack can't suppress a sibling's pending delivery.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== ws.data.identityFull) continue;
    repo.cursors.advance(ws.data.identityId, "direct", laneStreamRef(ws.data.identityFull, ws.data.lane), msgId);
  }
  send(ws, { type: "ack_ok", req_id: reqId });
}
