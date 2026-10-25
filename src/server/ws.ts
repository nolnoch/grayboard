import { participant, type MessageRow, type Repo } from "./db.ts";
import { parseClientMessage, type ServerMessage, type HelloOk, type HelloRequest, type DelegateRequest, type SendOk, type ErrorCode } from "../shared/protocol.ts";
import {
  HUMAN_NAME, HUMAN_RESERVED, MAX_IDENTITY_LENGTH, formatDirectAddress, formatTeamAddress, isValidIdentityName, parseAddress, type Address,
} from "../shared/addressing.ts";
import { canSend, type HumanReach, type SendPrincipal } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { DEFAULT_HELLO_LIMIT, HelloLimiter, type HelloLimit } from "./hello_limit.ts";
import {
  acknowledge,
  age,
  endLane,
  laneStreamRef,
  checkBody,
  lastSeen,
  MAIN_LANE,
  pendingFor,
  refOf,
  sessionsSeen,
  setPlace,
  startSession,
  touchHandle,
  touchHandleIfExists,
  type CoreDb,
  type PendingRef,
  type UnboundPeer,
} from "../core/boards.ts";
import {
  MAX_CANDIDATES, UNBOUND_ERROR, UNBOUND_READS, closestNames, lastBoundBy, lastWasRelease, logBinding, mintSessionId, orderCandidates, continuityOf,
  sessionIdOf, unboundPeer, unknownNameError, type Candidate,
} from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool, claimsInstruction, isBoardTool } from "../core/tools.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
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
  // Heartbeat: pings sent without a pong since the last answer. A socket
  // past the miss limit is half-open and is closed.
  missedPings?: number;
  // The server's Slack bridge holding a user's human identity: the only
  // connection allowed the reserved name, and drained like a human's session.
  human?: true;
  // The client process's session ID (#182): derived from its session key, or
  // minted here for a client from before session IDs. Keys binding_events.
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
  send(data: string): void;
  close(): void;
};

type Ws = Conn;

export type WsOptions = {
  // How long a live connection has to answer a collision probe.
  probeMs?: number;
  humanReach?: HumanReach;
  // Whether the Slack bridge is up; a linked human is reachable only then.
  slackRunning?: () => boolean;
  // Heartbeat tuning (tests): the ping interval, and how many unanswered
  // pings close a half-open socket.
  pingIntervalMs?: number;
  pingMissLimit?: number;
  // Hellos per user: the burst, and the refill rate (#210).
  helloLimit?: HelloLimit;
};

// Per server instance.
type Hub = {
  // identity_full -> the one push owner (the delivery slot; rotation moves it)
  registry: Map<string, Ws>;
  // identity_full -> the connection that holds the name: registry's, or a
  // hold connection (push: false, hold: true), which is pinged and probed
  // but never pushed to and not online (#182 audit 2).
  holders: Map<string, Ws>;
  // identity_full -> the probe a hello is running against its holder
  probing: Map<string, Promise<boolean>>;
  // Tools-only connections (hello push: false, or demoted lanes): pinged,
  // never pushed to (until a demoted one is rotated into the registry).
  toolsOnly: Set<Ws>;
  // `${identity_full}\0${lane}` -> its push-capable connection: the owner of
  // that lane key (registry owner or a demoted lane). Tools-only connections
  // claim no lane key.
  laneHolders: Map<string, Ws>;
  // Unbound sessions' read-only connections: pinged, shown by peer_list.
  readOnly: Set<Ws>;
  repo: Repo;
  db: CoreDb;
  probeMs: number;
  humanReach: HumanReach;
  slackRunning: () => boolean;
  pingIntervalMs: number;
  pingMissLimit: number;
  helloLimiter: HelloLimiter;
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
const LANE_RE = /^[a-z0-9_-]{1,32}$/;

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
    registry: new Map(), holders: new Map(), probing: new Map(), toolsOnly: new Set(), laneHolders: new Map(), readOnly: new Set(), repo, db,
    probeMs: opts.probeMs ?? 2000, humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    pingIntervalMs: opts.pingIntervalMs ?? 30_000, pingMissLimit: opts.pingMissLimit ?? 3,
    // Logged and audited once per run of refusals, so a loop floods neither.
    helloLimiter: new HelloLimiter(opts.helloLimit ?? DEFAULT_HELLO_LIMIT, {
      start: (_id, email, ctx, retryAfterMs) => {
        console.error(`[grayboard] rate-limiting hellos from ${email}`);
        writeAudit(repo, "hello.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs });
      },
      end: (_id, email, refused) => {
        console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
        writeAudit(repo, "hello.rate_limit_ended", email, null, { refused });
      },
    }),
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
    // Its DM stream starts at the identity's read point (the MAX across its
    // lanes — any lane's ack counts), not the promoted lane's own stale
    // cursor: a demoted lane never received the pushes the owner already
    // handled, and a real client acks only what it received. Per-lane cursors
    // still matter for what was pushed but never acked: anything past the
    // read point is at-least-once, then everything pending on boards.
    const ref = laneStreamRef(full, promote.data.lane);
    const readPoint = repo.cursors.directFor(full);
    if (readPoint > 0) repo.cursors.advance(promote.data.identityId, "direct", ref, readPoint);
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
        ws.data.missedPings = 0;
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
      if (ws.data.readOnly && !(msg.type === "call" && UNBOUND_READS.has(msg.tool))) {
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
          case "delegate":
            handleDelegate(hub, ws, msg.req_id, msg);
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
      if (full) {
        const key = laneKeyOf(full, ws.data.lane);
        if (hub.laneHolders.get(key) === ws) {
          // Auto-drop: a lane's row goes with its connection (a dead lane
          // cannot ghost), its last state snapshotted onto the handle first
          // (endLane). Every server lane is kind "session" — bridge-sticky
          // rows are a local concept (the local sweep exempts them there).
          hub.laneHolders.delete(key);
          endLane(hub.db, full, ws.data.lane);
          writeAudit(hub.repo, "lane.dropped", null, ws.data.identityName, { lane: ws.data.lane, cause: "close" });
        }
        if (hub.registry.get(full) === ws) {
          hub.registry.delete(full);
          rotateOwner(full, ws.data.lane, "close");
        }
        if (hub.holders.get(full) === ws) hub.holders.delete(full);
        // Only a handle that still exists: a deleted identity's close must
        // not re-insert it into the roster (#73).
        touchHandleIfExists(hub.db, full);
      }
      if (ws.data.owner) release(hub, ws, "connection closed");
      ws.data.onPong = undefined;
    },
  };

  // Auth is checked at the upgrade only. When an admin revokes or disables a
  // user, close their connections (#70): reconnecting then fails auth. The
  // Slack bridge's humans have their own path (SlackBridge.userChanged).
  const conns = () => [...hub.holders.values(), ...hub.toolsOnly, ...hub.readOnly].filter((ws) => !ws.data.human);
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

  // Heartbeat: keeps idle connections open through proxies, and closes the
  // half-open ones (a machine asleep with a session open answers nothing).
  // The Slack bridge's humans are in-process and can't drop: exempt. A close
  // here runs the ordinary close path — rotation, lane cleanup — instead of
  // leaving a dead owner holding delivery.
  const startPing = () =>
    setInterval(() => {
      revalidate();
      hub.helloLimiter.sweep();
      for (const ws of [...hub.holders.values(), ...hub.toolsOnly, ...hub.readOnly]) {
        if (ws.data.human || ws.readyState !== 1 /* OPEN */) continue;
        send(ws, { type: "ping" });
        ws.data.missedPings = (ws.data.missedPings ?? 0) + 1;
        if (ws.data.missedPings >= hub.pingMissLimit) {
          // lost_ownership, not superseded: the client reconnects on it. A
          // paused session (a laptop asleep, a SIGSTOP) that answers nothing
          // looks half-open from here, but on wake it must re-attach — demote
          // under whoever took the slot — not exit for good.
          err(ws, undefined, "lost_ownership", "this session stopped answering pings; reconnecting re-attaches");
          ws.close();
        }
      }
    }, hub.pingIntervalMs);

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
  const { repo, db, registry, holders } = hub;
  const reqId = m.req_id;
  // First, before anything reads or writes the database. The Slack bridge's
  // in-process connections are the server's own.
  if (!ws.data.human) {
    const t = hub.helloLimiter.take(ws.data.authed.user_id, ws.data.authed.user_email, {
      session_id: m.session_key ? sessionIdOf(m.session_key) : null,
      ...(m.read_only ? { read_only: true } : { name: m.identity ?? null }),
      place: m.where ?? null,
    });
    if (!t.ok) {
      const secs = Math.ceil(t.retryAfterMs / 1000);
      send(ws, { type: "error", req_id: reqId, code: "rate_limited", message: `too many connections for this user; retry in ${secs}s`, retry_after_ms: t.retryAfterMs });
      ws.close();
      return;
    }
  }
  const push = m.push !== false;
  // Whether this connection holds its name: a push one, or a hold one, whose
  // harness can't show pushes (#182 audit 2). A tools-only one doesn't.
  const owns = push || m.hold === true;
  // Derived from the client's secret, so no connection can present another
  // session's ID (#182 audit 4). A client from before session IDs gets one
  // here, so its events have a key.
  const sessionId = m.session_key ? sessionIdOf(m.session_key) : mintSessionId();
  ws.data.sessionId = sessionId;
  ws.data.place = m.where ?? null;
  if (m.read_only) return helloReadOnly(hub, ws, reqId, sessionId, m.suggested);

  // An invalid name is logged cut to the longest valid length: it's the
  // client's text, and the event only has to show what was tried.
  const name = m.identity!.toLowerCase().slice(0, MAX_IDENTITY_LENGTH);
  const { authed } = ws.data;
  const full = `${authed.user_email}/${name}`;
  // Only the connection that would hold the name logs: a tools-only one runs
  // beside the session that owns it.
  const refuse = (code: ErrorCode, message: string, detail: string, extra: { known?: string[]; holder?: string } = {}) => {
    if (owns) logBinding(db, sessionId, full, "refused", detail);
    send(ws, { type: "error", req_id: reqId, code, message, ...extra });
    ws.close();
  };
  if (!isValidIdentityName(m.identity!.toLowerCase())) return refuse("bad_request", "invalid identity name", "invalid name");
  if ((name === HUMAN_NAME) !== (ws.data.human === true)) {
    const why = name === HUMAN_NAME ? HUMAN_RESERVED : "the Slack bridge holds only human identities";
    return refuse("bad_request", why, why);
  }
  // The lane this session joins (the fleet model, #114): BUS_LANE wins;
  // default "main". A second push session on the same lane is refused or
  // supersedes; on another lane it joins as a tool lane (demoted, below).
  let lane = MAIN_LANE;
  if (m.lane !== undefined) {
    lane = m.lane.toLowerCase();
    if (!LANE_RE.test(lane)) {
      refuse("bad_request", `invalid lane "${m.lane}": 1-32 chars, a-z 0-9 _ -`, "invalid lane");
      return;
    }
  }
  // An explicit join (BUS_IDENTITY) suppresses the worktree suffix: the
  // identity is literal, the worktree becomes the lane key (#114).
  const explicit = m.explicit === true;

  // A typo would otherwise create a fresh name, and the DMs queued for the
  // intended one would never arrive.
  if (m.create === false && !repo.identities.findByUserAndName(authed.user_id, name)) {
    const known = closestNames(name, repo.identities.listForUser(authed.user_id).map((i) => i.name).filter((n) => n !== HUMAN_NAME));
    const message = unknownNameError(name, known);
    refuse("identity_unknown", message, message, { known });
    return;
  }

  // One push session per lane key. If its holder still answers, refuse the
  // newcomer: taking over would let a stray second session silently steal
  // that lane's deliveries. A holder that doesn't answer is dead; replace it.
  // The registry owner on ANOTHER lane is probed too before demoting under
  // it: a live owner means a fleet (the newcomer demotes, below), while one
  // that doesn't answer is half-open (a laptop asleep with a session open) —
  // superseded, and the newcomer takes over, as a pre-fleet newcomer did.
  // Each await can change the holders (a close, another hello), so after
  // one, check again from the top; between the last check and the writes
  // below nothing awaits (#69).
  const key = laneKeyOf(full, lane);
  while (owns) {
    const inFlight = hub.probing.get(key);
    if (inFlight) {
      // Another hello is probing this lane's holder: whoever wins, it's settled after.
      await inFlight;
      if (ws.readyState !== 1 /* OPEN */) return;
      continue;
    }
    const holder = hub.laneHolders.get(key);
    if (holder && holder !== ws) {
      const probing = probe(holder, hub.probeMs).finally(() => {
        if (hub.probing.get(key) === probing) hub.probing.delete(key);
      });
      hub.probing.set(key, probing);
      if (await probing) {
        const who = describeHolder(holder);
        refuse("identity_in_use",
          `identity "${name}" is already in use by ${who} on lane "${lane}"; give this session a different BUS_IDENTITY or BUS_LANE.`, who, { holder: who });
        return;
      }
      if (ws.readyState !== 1 /* OPEN */) return;
      if (hub.laneHolders.get(key) === holder) {
        err(holder, undefined, "superseded", "a newer session connected with this identity and lane");
        if (holder.data.owner) release(hub, holder, `superseded by session ${sessionId}`);
        holder.close();
        // Its close handler may not have run yet; take its places now, so the
        // writes below don't race it.
        hub.toolsOnly.delete(holder);
        if (hub.registry.get(full) === holder) hub.registry.delete(full);
        if (hub.holders.get(full) === holder) hub.holders.delete(full);
        hub.laneHolders.delete(key);
      }
      continue;
    }
    const owner = registry.get(full);
    if (owner && owner !== ws && owner.data.lane !== lane) {
      const ownerKey = laneKeyOf(full, owner.data.lane);
      const inFlightOwner = hub.probing.get(ownerKey);
      if (inFlightOwner) {
        await inFlightOwner;
        if (ws.readyState !== 1 /* OPEN */) return;
        continue;
      }
      const probing = probe(owner, hub.probeMs).finally(() => {
        if (hub.probing.get(ownerKey) === probing) hub.probing.delete(ownerKey);
      });
      hub.probing.set(ownerKey, probing);
      const answers = await probing;
      if (ws.readyState !== 1 /* OPEN */) return;
      if (answers) break; // a live owner: demote below
      if (registry.get(full) === owner) {
        // lost_ownership: the owner was half-open (it didn't answer the
        // probe), not replaced by a live session on its lane — on wake it
        // reconnects and joins as a tool lane under the new owner. A real
        // newer session on the SAME lane closes with terminal `superseded`
        // (above).
        err(owner, undefined, "lost_ownership", "a newer session took over this identity's delivery; reconnecting re-attaches as a tool lane");
        owner.close();
        // The registry slot only: the owner's close handler still runs its
        // lane cleanup (a different lane key than ours, so no race below).
        registry.delete(full);
      }
      continue;
    }
    break;
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
    const held = [...holders.values()].find((c) => c !== ws && c.data.sessionId === sessionId && c.data.identityFull !== full);
    if (held && held.data.identityFull !== fromFull) {
      const was = held.data.identityName;
      refuse("identity_in_use", `this session holds "${was}" now; a hello for "${name}" that doesn't leave it is refused.`, `stale: the session holds "${was}"`);
      return;
    }
    if (fromFull !== null && fromFull !== full) {
      const h = holders.get(fromFull);
      if ((!h || h.data.sessionId === sessionId) && lastBoundBy(db, fromFull, sessionId)) from = fromFull;
      else notMoved = `claims not moved: this session doesn't hold "${m.from}"`;
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
          `no identity "${name}" for your account; your identities: ${mine.map((i) => `${authed.user_email}/${i.name}`).join(", ")}` +
          ` — create it first: grayboard identity create ${name}`);
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
  if (push && m.lane === undefined && owner && owner !== ws && owner.data.lane !== MAIN_LANE) {
    refuse("identity_in_use",
      `identity "${name}" is already in use by a live session. Give this session a different BUS_IDENTITY.`, "old client on a fleet");
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

  let moved: string[] | undefined;
  if (owns) {
    moved = [];
    holders.set(full, ws);
    if (push) {
      hub.laneHolders.set(key, ws);
      if (demoted) hub.toolsOnly.add(ws);
      else registry.set(full, ws);
    }
    // A reconnect, or a restart taking its name back, is the same session, so
    // its status stays, once the name's history shows it (#211). The session
    // ID comes from the client's secret, so a reconnect proves itself; a
    // restore names a public ID. A rebind is neither: it logs `moved`.
    // The lane row carries the per-lane state (cwd/place/status); the
    // handle's columns stay as the pre-lanes display fallback (#114).
    const continued = m.from !== undefined ? null
      : m.resume ? continuityOf(db, full, { reconnect: sessionId })
      : m.restored_from !== undefined ? continuityOf(db, full, { restartOf: m.restored_from })
      : null;
    startSession(db, full, null, lane, { push_capable: push, resume: continued?.verified === true || m.resume === true });
    setPlace(db, full, m.where ?? null, lane);
    // Only a push-mode owner advertises the capability (a hold, demoted or
    // tools-only connection can't receive a delegation, so it must not be
    // one), and its flag flip is audited (#184 review 4/6).
    if (push && !demoted) {
      setLauncher(db, full, m.launcher === true);
      writeAudit(repo, "handle.launcher_set", authed.user_email, full, { on: m.launcher === true });
    }
    ws.data.owner = true;
    if (from) {
      // The old connection, which the client closes next, holds nothing now.
      const prev = holders.get(from);
      if (prev) {
        holders.delete(from);
        if (registry.get(from) === prev) registry.delete(from);
        touchHandle(db, from);
      }
      moved = db.transaction(() => moveClaims(db, from, full))().map((c) => c.key);
      if (prev?.data.owner) release(hub, prev, `rebound to ${full}`);
      else if (!lastWasRelease(db, from)) logBinding(db, sessionId, from, "released", `rebound to ${full}`);
      logBinding(db, sessionId, full, "moved", from);
    } else {
      logBinding(db, sessionId, full, "bound", [continued?.detail ?? null, notMoved].filter((d) => d !== null).join("; ") || null);
    }
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
    attachment_limits: repo.attachmentLimits,
    ...(moved ? { moved } : {}),
    ...(notMoved ? { not_moved: notMoved } : {}),
    ...(lane !== MAIN_LANE ? { lane } : {}),
    ...(demoted ? { push_granted: false, owner_lane: owner!.data.lane } : {}),
  };
  // Bridge-down notices drain on agent-session hellos only: the bridge's own
  // human hello (HumanConn) would steal the notice into a handshake nobody
  // reads, leaving the owner uninformed.
  const bridgeNotice = ws.data.human ? undefined : owedBridgeNotice(repo, authed.user_email);
  const notices = [
    ...(created ? [`New identity "${full}" created for you by this session.`] : []),
    ...(demoted ? [`Push delivery for this identity is owned by lane "${owner!.data.lane}"; this session joined as a tool lane and takes over when that lane ends.`] : []),
    // Only a push owner that opted in pays for the launcher instruction; a
    // hold, demoted or tools-only connection can't receive a delegation.
    ...(m.launcher && push && !demoted ? launcherInstruction() : []),
    ...undeliveredInstruction(repo.messages.undeliveredFrom(full, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
    // Before the claims: drained once, so a cut must not take it.
    ...(bridgeNotice ? [bridgeNotice] : []),
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

  // This lane's direct messages since the identity's read point — the MAX
  // across its lanes (any lane's ack counts: a lane reading is the identity
  // reading). A fresh lane joins without replaying the identity's history
  // (including when only non-main lanes ever ran), and a promoted or
  // rejoined lane starts past what a sibling already handled. Per-lane
  // cursors still matter for pushed-but-unacked messages: anything past the
  // read point is at-least-once.
  const laneRef = laneStreamRef(full, lane);
  let since = repo.cursors.get(identity.id, "direct", laneRef);
  const readPoint = repo.cursors.directFor(full);
  if (readPoint > since) {
    repo.cursors.advance(identity.id, "direct", laneRef, readPoint);
    since = readPoint;
  }
  for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
    send(ws, { type: "push", message: showPending(message) });
  }
  // Boards drain for the owner only: one delivery owner, one ack writer.
  // A demoted lane catches up on boards when it is rotated in.
  if (!demoted) drainBoards(ws, db, true);
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
function unboundPeers(hub: Hub, ws: Ws): UnboundPeer[] {
  return [...hub.readOnly]
    .filter((c) => c.data.authed.user_id === ws.data.authed.user_id)
    .map((c) => unboundPeer(c.data.sessionId!, c.data.place ?? null, c.data.sessionId === ws.data.sessionId));
}

// A bare name means your own identity of that name, else the one identity
// anyone has with it (as @name does in a post). The pure core of resolvePeer,
// shared with delegate's `to` resolution (#184 review 7): both take bare and
// mixed-case names through the same path.
function resolvePeerInput(repo: Repo, email: string, userId: number, input: string): { address: Address } | { error: string; code: "not_found" | "bad_request" } {
  if (isValidIdentityName(input)) {
    const name = input.toLowerCase();
    if (repo.identities.findByUserAndName(userId, name)) {
      input = formatDirectAddress(email, name);
    } else if (name === HUMAN_NAME) {
      // Every linked user has one; listing them would only leak who linked.
      return { error: `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`, code: "not_found" };
    } else {
      const all = repo.identities.findAllByName(name);
      if (all.length !== 1) {
        const which = all.length ? `several identities are named "${name}": ${all.map(i => formatDirectAddress(i.email, i.name)).sort().join(", ")}` : `no identity is named "${name}"`;
        return { error: `${which}; peer_list shows exact handles`, code: "not_found" };
      }
      input = formatDirectAddress(all[0]!.email, name);
    }
  }
  try {
    return { address: parseAddress(input) };
  } catch (e) {
    return { error: String(e), code: "bad_request" };
  }
}

// Null once it has answered the request with why not.
function resolvePeer(repo: Repo, ws: Ws, reqId: string, input: string): Address | null {
  const { authed } = ws.data;
  const r = resolvePeerInput(repo, authed.user_email, authed.user_id, input);
  if ("error" in r) {
    err(ws, reqId, r.code, r.error);
    return null;
  }
  return r.address;
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
  extra: Record<string, unknown> & { note?: string } = {},
  // A caller that needs the reply shaped (delegate's result builder) applies
  // it here — the same object is sent and returned, so the two can't drift.
  shapeOk?: (ok: SendOk) => SendOk,
): { ok?: SendOk; refused?: string } {
  const { repo, db, registry } = hub;
  let ids: number[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
  } catch (e) {
    err(ws, reqId, "bad_request", (e as Error).message);
    return { refused: (e as Error).message };
  }

  const { authed } = ws.data;
  const parsedR = resolvePeerInput(repo, authed.user_email, authed.user_id, recipientStr);
  if ("error" in parsedR) {
    err(ws, reqId, parsedR.code, parsedR.error);
    return { refused: parsedR.error };
  }
  const parsed = parsedR.address;

  const principal: SendPrincipal = {
    user_id:       authed.user_id,
    user_email:    authed.user_email,
    identity_id:   ws.data.identityId,
    identity_name: ws.data.identityName,
    identity_full: ws.data.identityFull,
  };

  if (parsed.kind === "team") {
    const why = `${parsed.full} isn't a person; to reach a team, board_post to its board #${parsed.name}`;
    err(ws, reqId, "bad_request", why);
    return { refused: why };
  }

  const recipientUser = repo.users.findByEmail(parsed.email);
  if (!recipientUser) {
    const why = `user "${parsed.email}" not found`;
    err(ws, reqId, "not_found", why);
    return { refused: why };
  }
  const recipientIdentity = repo.identities.findByUserAndName(recipientUser.id, parsed.name);
  if (!recipientIdentity) {
    const why = `identity "${parsed.full}" not found; peer_list shows exact handles`;
    err(ws, reqId, "not_found", why);
    return { refused: why };
  }
  const decision = canSend(principal, { kind: "user", address: parsed.full }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) {
    err(ws, reqId, decision.code, decision.reason);
    return { refused: decision.reason };
  }

  if (parentId !== null && !participant(repo.messages.getById(parentId), ws.data.identityFull)) {
    const why = `parent_id ${parentId} is not a message you sent or received`;
    err(ws, reqId, "not_found", why);
    return { refused: why };
  }

  let msg: MessageRow;
  try {
    msg = repo.messages.insert(ws.data.identityFull, "user", parsed.full, body, parentId, pending, ids);
  } catch (e) {
    if (e instanceof CoreError) {
      err(ws, reqId, "bad_request", e.message);
      return { refused: e.message };
    }
    throw e;
  }
  for (const a of msg.attachments ?? []) {
    writeAudit(repo, "attachment.bound", authed.user_email, `attachment:${a.id}`, { identity: ws.data.identityFull, message_id: msg.id, recipient: parsed.full });
  }
  const p = { ...(pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) };

  const { note: extraNote, ...restExtra } = extra ?? {};
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
    ? fleetTruth(hub, repo, ws.data.identityFull, parsed.full, msg.id)
    : undefined;
  const fleet = truth && (truth.live_lanes > 1 || truth.read_lanes.length > 0)
    ? { live_lanes: truth.live_lanes, ...(truth.read_lanes.length ? { read_lanes: truth.read_lanes } : {}) }
    : undefined;
  const seen = lastSeen(db, parsed.full);
  const ok: SendOk = deliveredNow
    ? { type: "send_ok", req_id: reqId, message_id: msg.id, delivered_now: true, ...p, ...fleet, ...restExtra, ...(extraNote ? { note: extraNote } : {}) }
    : {
        type: "send_ok",
        req_id: reqId,
        message_id: msg.id,
        delivered_now: false,
        ...p,
        ...fleet,
        ...restExtra,
        ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
        undelivered_from_you: repo.messages.undeliveredFrom(ws.data.identityFull).find((u) => u.recipient === parsed.full)?.n ?? 1,
        note: [queuedNote(parsed.full, seen), extraNote].filter(Boolean).join(" "),
      };
  const shaped = shapeOk ? shapeOk(ok) : ok;
  send(ws, shaped);
  return { ok: shaped };
}

// A delegation request (#184): resolve the launcher (or fall back to the
// requester's human) in core, then deliver it as a pending DM through the
// ordinary send path. `to` resolves like dm_send's recipient (bare and
// mixed-case names included, #184 review 7); the human fallback checks real
// Slack reachability, not a last_seen row (review 10). Every outcome is
// audited: which launcher resolution picked and why, or the refusal (#184
// review 4). The reply is a DelegateOk — the send_ok fields plus `to` and,
// on the degrade path, human_fallback.
function handleDelegate(hub: Hub, ws: Ws, reqId: string, m: DelegateRequest): void {
  const { repo } = hub;
  const { authed } = ws.data;
  let to: string | undefined;
  if (m.to !== undefined) {
    const r = resolvePeerInput(repo, authed.user_email, authed.user_id, m.to);
    if ("error" in r) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: r.error, to: m.to });
      return err(ws, reqId, r.code, r.error);
    }
    to = r.address.full;
  }
  const online = (h: string) => hub.registry.get(h)?.data.ready === true;
  // The human fallback's reachability is the server's own knowledge: the
  // bridge is running and this user is linked. A last_seen row is not
  // reachability (#191: an unlinked or stopped bridge queues into the void).
  const humanReachable = () => hub.slackRunning() && !!repo.slack.linkFor(authed.user_id);
  let d;
  try {
    d = resolveDelegation(hub.db, ws.data.identityFull, { ...m, to }, online, humanReachable);
  } catch (e) {
    if (e instanceof CoreError) {
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: e.message, to: m.to });
      return err(ws, reqId, "bad_request", e.message);
    }
    throw e;
  }
  // The result is built by the same builder local uses (review 13): the
  // extra carries nothing delegation-specific, so the modes can't drift.
  const sent = handleSend(hub, ws, reqId, d.to, d.body, null, true, undefined, {}, (ok) => ({ ...ok, ...delegateOkFields(d, ok) }));
  if (sent.ok) {
    writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
      requester: ws.data.identityFull,
      via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
      message_id: sent.ok.message_id,
    });
  } else {
    // A refused send (canSend, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: sent.refused ?? "send refused", to: d.to });
  }
}

// Fleet delivery truth for send_ok: how many of the recipient identity's
// lanes are live, and which lanes are caught up to just before this message.
// "Just before" is the sender's previous message ADDRESSED TO the recipient
// (directional — NOT any message in the pair: the recipient's own reply sits
// above its receive cursor forever, so an either-direction compare hides
// read state after the first back-and-forth), and not messageId - 1: ids
// are global, and an unrelated pair may hold the id in between (N4). A fresh
// message can't have been read by anyone yet; "caught up before it" is the
// honest sender-side marker — empty when this is their first exchange.
function fleetTruth(hub: Hub, repo: Repo, senderFull: string, recipientFull: string, messageId: number): { live_lanes: number; read_lanes: string[] } {
  const live = fleetConns(hub, recipientFull).filter((ws) => ws.data.ready).length;
  const prev = repo.messages.previousBetween(senderFull, recipientFull, messageId);
  const read = prev > 0 ? repo.cursors.lanesRead(recipientFull, prev) : [];
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
      lane: ws.data.lane,
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
    // Only your own direct messages move your cursor — this lane's own
    // stream, so a lane's ack can't suppress a sibling's pending delivery.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== ws.data.identityFull) continue;
    repo.cursors.advance(ws.data.identityId, "direct", laneStreamRef(ws.data.identityFull, ws.data.lane), msgId);
  }
  send(ws, { type: "ack_ok", req_id: reqId });
}
