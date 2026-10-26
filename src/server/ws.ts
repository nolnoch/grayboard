import { participant, type MessageRow, type Repo, type Sync } from "./db.ts";
import {
  parseClientMessage, type ServerMessage, type HelloOk, type HelloRequest, type DelegateRequest, type DelegateResult, type SendRequest, type SendResult, type ErrorCode,
  type WriteRef,
} from "../shared/protocol.ts";
import {
  HUMAN_NAME, HUMAN_RESERVED, MAX_IDENTITY_LENGTH, formatDirectAddress, formatTeamAddress, isValidIdentityName,
} from "../shared/addressing.ts";
import { canSend, type HumanReach } from "./can_send.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import { RateLimiter, retrySecs, type RateLimit } from "./rate_limit.ts";
import {
  acknowledge,
  age,
  checkBody,
  lastSeen,
  normalizeBoard,
  pendingFor,
  refOf,
  idCollisionText,
  idPrincipal,
  inheritStatus,
  registerId,
  sessionsSeen,
  setPlace,
  touchAlias,
  touchId,
  type CoreDb,
  type PendingRef,
  type UnboundPeer,
} from "../core/boards.ts";
import {
  MAX_CANDIDATES, UNBOUND_ERROR, UNBOUND_READS, clearHolds, closestNames, dropHold, holdAlias, idAddress, lastBoundBy, lastWasRelease, logBinding, mintSessionKey,
  orderCandidates, continuityOf, unboundPeer, unknownNameError, type Candidate,
} from "../core/bindings.ts";
import { addressParts, type ParsedAddress } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope } from "../core/resolver.ts";
import { assertDeliverableId } from "../core/session_end.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type BoardPostResult, type ToolContext } from "../core/tools.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
import { attachmentIds, dropUnsentUploads, sweepBlobs, uploadDigests } from "../core/attachments.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause } from "../shared/testpause.ts";
import { claimExpiryTimer, listClaims, moveClaims } from "../core/claims.ts";
import { onAliasCreated } from "./teams.ts";
import {
  PROMISE_DAYS, STALE_UNDELIVERED_MS, alreadyRetracted, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showMessage, unanswered, undeliveredInstruction,
} from "../shared/inbox.ts";

export type WsData = {
  authed: AuthedUser;
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
  // The client process's session ID (#182, #284): derived from its session
  // key, or minted here for a client from before session IDs and for the
  // Slack bridge's humans. Keys binding_events, and the ids and alias_holds
  // rows of a session that holds its name (never a human's).
  sessionId?: string;
  // Where the client runs, from its hello.
  place?: string | null;
  // An unbound session's read-only connection: its handle is
  // <email>/~<session id>, which no hello can name, and it may only read.
  readOnly?: true;
  // This connection holds its name: its close logs the release.
  owner?: true;
  // The session ID this connection's writes carry (#284): set once its ids
  // row exists. A tools-only connection and the Slack bridge's humans have
  // none, so their messages and posts carry no session.
  writerId?: string;
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
  // The hub's clock: the rate limiters' and the write-dedup window's
  // (src/server/write_dedup.ts). Tests move it instead of sleeping.
  now?: () => number;
};

// Per server instance.
type Hub = {
  // identity_full -> the connection pushes go to (hello push: true)
  registry: Map<string, Ws>;
  // identity_full -> the connection that holds the name: registry's, or a
  // hold connection (push: false, hold: true), which is pinged and probed
  // but never pushed to and not online (#182 audit 2).
  holders: Map<string, Ws>;
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
  helloLimiter: RateLimiter;
  now: () => number;
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

// helloLimit: hellos per user, the burst and the refill rate (#210).
export function createWsHandlers(repo: Repo, db: CoreDb, opts: WsOptions & { helloLimit: RateLimit }) {
  const hub: Hub = {
    registry: new Map(), holders: new Map(), probing: new Map(), toolsOnly: new Set(), readOnly: new Set(), repo, db,
    probeMs: opts.probeMs ?? 2000, humanReach: opts.humanReach ?? "team",
    slackRunning: opts.slackRunning ?? (() => false),
    now: opts.now ?? Date.now,
    // Logged and audited once per run of refusals, so a loop floods neither.
    // Keyed by email, which is unique per user.
    helloLimiter: new RateLimiter(opts.helloLimit, {
      start: (email, ctx, retryAfterMs) => {
        console.error(`[grayboard] rate-limiting hellos from ${email}`);
        writeAudit(repo, "hello.rate_limited", email, null, { ...ctx, retry_after_ms: retryAfterMs });
      },
      end: (email, refused) => {
        console.error(`[grayboard] hellos from ${email} no longer rate-limited; ${refused} refused`);
        writeAudit(repo, "hello.rate_limit_ended", email, null, { refused });
      },
    }, opts.now),
  };
  // Announces claims that lapse on their boards.
  const expiry = claimExpiryTimer(db, (handles) => wake(hub, handles));
  // No connection outlives the server, so no hold a previous run left is live.
  clearHolds(db);

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
            handleSend(hub, ws, msg);
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
      if (full && hub.registry.get(full) === ws) hub.registry.delete(full);
      if (full && hub.holders.get(full) === ws) {
        hub.holders.delete(full);
        if (!ws.data.human) dropHold(hub.db, full, ws.data.sessionId!);
        touchAlias(hub.db, full);
      }
      if (ws.data.writerId) touchId(hub.db, ws.data.writerId);
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

  // Heartbeat: keeps idle connections open through proxies.
  const startPing = () =>
    setInterval(() => {
      revalidate();
      for (const ws of [...hub.holders.values(), ...hub.toolsOnly, ...hub.readOnly]) {
        if (ws.readyState === 1 /* OPEN */) send(ws, { type: "ping" });
      }
    }, 30_000);

  return {
    handlers, startPing, revalidate, disconnectUser, stopExpiry: expiry.stop,
    sweepHellos: () => hub.helloLimiter.sweep(),
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
  const { repo, db, registry, holders } = hub;
  const reqId = m.req_id;
  // First, before anything reads or writes the database. The Slack bridge's
  // in-process connections are the server's own.
  if (!ws.data.human) {
    const t = hub.helloLimiter.take(ws.data.authed.user_email, {
      session_id: m.session_key ? idAddress(m.session_key) : null,
      ...(m.read_only ? { read_only: true } : { name: m.identity ?? null }),
      place: m.where ?? null,
    });
    if (!t.ok) {
      send(ws, { type: "error", req_id: reqId, code: "rate_limited", message: `too many connections for this user; retry in ${retrySecs(t.retryAfterMs)}s`, retry_after_ms: t.retryAfterMs });
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
  const sessionId = idAddress(m.session_key ?? mintSessionKey());
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

  // A typo would otherwise create a fresh name, and the DMs queued for the
  // intended one would never arrive.
  if (m.create === false && !repo.aliases.find(full)) {
    const known = closestNames(name, repo.aliases.listForScope("person", authed.user_email).map((i) => i.name).filter((n) => n !== HUMAN_NAME));
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
  while (owns) {
    const inFlight = hub.probing.get(full);
    if (inFlight) {
      // Another hello is probing the holder: whoever wins, it's settled after.
      await inFlight;
      if (ws.readyState !== 1 /* OPEN */) return;
      continue;
    }
    const holder = holders.get(full);
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
    if (holders.get(full) === holder) {
      err(holder, undefined, "superseded", "a newer session connected with this identity");
      if (holder.data.owner) release(hub, holder, `superseded by session ${sessionId}`);
      holder.close();
      holders.delete(full);
      if (registry.get(full) === holder) registry.delete(full);
    }
  }

  // A session's ID is one principal's (#284): a key whose ID is another
  // user's session is refused, never attached to that session's row. From
  // here to registry.set nothing awaits, so the row read here stands.
  const prior = owns && !ws.data.human ? idPrincipal(db, sessionId) : undefined;
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

  if (!repo.aliases.find(full)) {
    repo.aliases.create({ scope_kind: "person", scope_ref: authed.user_email, name }, authed.user_email);
    writeAudit(repo, "alias.created", authed.user_email, full, { lazy: true, ...(ws.data.human ? {} : { session: sessionId }) });
    onAliasCreated(db, repo, authed.user_id, full);
  }

  let moved: string[] | undefined;
  if (owns) {
    moved = [];
    holders.set(full, ws);
    if (push) registry.set(full, ws);
    // The session's rows (#284): its ids row, written by its first owner
    // hello and updated by the rest (a reconnect, a rebind), and its hold.
    // The Slack bridge's humans have no ID.
    if (!ws.data.human) {
      if (prior === undefined) registerId(db, { id: sessionId, principal: authed.user_email, place: m.where ?? null, launcher: push && m.launcher === true, keyed: m.session_key !== undefined });
      else {
        setPlace(db, sessionId, m.where ?? null);
        touchId(db, sessionId);
      }
      holdAlias(db, full, sessionId);
      ws.data.writerId = sessionId;
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
    if (continued?.verified && m.restored_from !== undefined && !ws.data.human) inheritStatus(db, sessionId, m.restored_from);
    touchAlias(db, full);
    // Only a push-mode owner advertises the capability (a hold or tools-only
    // connection can't receive a delegation, so it must not be one). Every
    // owner hello rewrites the flag and audits it, changed or not (#184 review 4/6).
    if (push) {
      // registerId wrote the flag for a new row; a later hello rewrites it.
      if (!ws.data.human && prior !== undefined) setLauncher(db, sessionId, m.launcher === true);
      writeAudit(repo, "handle.launcher_set", authed.user_email, full, { on: m.launcher === true, ...(ws.data.human ? {} : { session: sessionId }) });
    }
    ws.data.owner = true;
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
      if (prev?.data.owner) release(hub, prev, `rebound to ${full}`);
      else if (!lastWasRelease(db, from)) logBinding(db, sessionId, from, "released", `rebound to ${full}`);
      logBinding(db, sessionId, full, "moved", from);
    } else {
      logBinding(db, sessionId, full, "bound", [continued?.detail ?? null, notMoved].filter((d) => d !== null).join("; ") || null);
    }
  } else {
    hub.toolsOnly.add(ws);
    touchAlias(db, full);
  }
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
    ...(m.session_key ? { write_dedup: true } : {}),
    ...(moved ? { moved } : {}),
    ...(notMoved ? { not_moved: notMoved } : {}),
  };
  // Bridge-down notices drain on agent-session hellos only: the bridge's own
  // human hello (HumanConn) would steal the notice into a handshake nobody
  // reads, leaving the owner uninformed.
  const bridgeNotice = ws.data.human ? undefined : owedBridgeNotice(repo, authed.user_email);
  const notices = [
    ...(m.launcher && push && owns ? launcherInstruction() : []),
    ...undeliveredInstruction(repo.messages.undeliveredFrom([full], Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
    // Before the claims: drained once, so a cut must not take it.
    ...(bridgeNotice ? [bridgeNotice] : []),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(db, undefined, full), [full]),
  ];
  if (notices.length) helloOk.notices = notices;
  send(ws, helloOk);
  if (!push) return;

  // Direct messages since the cursor (unacked ones are resent), then boards.
  const since = repo.cursors.get(full, "direct", full);
  for (const message of repo.messages.unreadSince([{ type: "direct", ref: full, since }])) {
    send(ws, { type: "push", message: showMessage(message) });
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
  const names = repo.aliases.listForScope("person", authed.user_email).map((i) => i.name).filter(free);
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

// A bare name means the one of that name in the acting address's own scope,
// else the one alias anyone has with it (as @name does in a post). The pure
// core of resolvePeer, shared with delegate's `to` resolution (#184 review
// 7): both take bare and mixed-case names through the same path.
type Peer = Exclude<ParsedAddress, { kind: "bare" }>;
function resolvePeerInput(repo: Repo, from: string, input: string): { address: Peer } | { error: string; code: "not_found" | "bad_request" } {
  const p = addressParts(input);
  if (!p) return { error: `invalid address "${input}": expected "id:…", "scope/name" or "team:name"`, code: "bad_request" };
  if (p.kind !== "bare") return { address: p };
  const scope = ownScope(repo.resolver, from);
  const own = scope ? addressParts(`${scope}/${p.name}`) : null;
  if (own?.kind === "alias" && repo.aliases.find(own.address)) return { address: own };
  if (p.name === HUMAN_NAME) {
    // Every linked user has one; listing them would only leak who linked.
    return { error: `your user hasn't linked Slack, so there's no "${HUMAN_NAME}" to message; they can run grayboard slack link`, code: "not_found" };
  }
  const all = repo.aliases.findAllByName(p.name);
  const only = all.length === 1 ? addressParts(all[0]!.address) : null;
  if (only && only.kind !== "bare") return { address: only };
  const which = all.length ? `several identities are named "${p.name}": ${all.map(i => i.address).sort().join(", ")}` : `no identity is named "${p.name}"`;
  return { error: `${which}; peer_list shows exact handles`, code: "not_found" };
}

// Null once it has answered the request with why not.
function resolvePeer(repo: Repo, ws: Ws, reqId: string, input: string): Peer | null {
  const r = resolvePeerInput(repo, ws.data.identityFull, input);
  if ("error" in r) {
    err(ws, reqId, r.code, r.error);
    return null;
  }
  return r.address;
}

// A send the server refuses: answered as an error frame with this code.
class SendRefused extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

// A send checked and resolved, ready to write: `to` is the recipient's full
// handle, `digests` its files' blob digests in call order.
type PreparedSend = { to: string; body: string; parentId: number | null; pending: boolean; ids: number[]; digests: string[] };

// Checks a send and resolves its recipient, writing nothing; throws SendRefused.
function prepareSend(
  hub: Hub, ws: Ws, recipientStr: string, body: string, parentId: number | null, pending: boolean, attachmentIdsRaw: unknown,
): PreparedSend {
  const { repo, db } = hub;
  let ids: number[];
  let digests: string[];
  try {
    checkBody(body);
    ids = attachmentIds(attachmentIdsRaw);
    digests = uploadDigests(db, ids, ws.data.identityFull);
  } catch (e) {
    if (e instanceof CoreError) throw new SendRefused("bad_request", e.message);
    throw e;
  }

  const r = resolvePeerInput(repo, ws.data.identityFull, recipientStr);
  if ("error" in r) throw new SendRefused(r.code, r.error);
  const to = r.address;
  if (to.kind === "team") throw new SendRefused("bad_request", `${to.address} isn't a person; to reach a team, board_post to its board #${to.name}`);
  // An ID's deliverability is checked in the write's transaction (writeSend).
  if (to.kind === "alias" && !repo.aliases.find(to.address)) throw new SendRefused("not_found", `identity "${to.address}" not found; peer_list shows exact handles`);
  const decision = canSend(ws.data.identityFull, { kind: "user", address: to.address }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) throw new SendRefused(decision.code, decision.reason);

  if (parentId !== null && !participant(repo.messages.getById(parentId), ws.data.identityFull)) {
    throw new SendRefused("not_found", `parent_id ${parentId} is not a message you sent or received`);
  }
  return { to: to.address, body, parentId, pending, ids, digests };
}

// Writes the message and builds its result. Runs inside the caller's
// transaction; whether the recipient is live is read here, with nothing
// awaited before deliverSend pushes, so the result says what happens.
function writeSend(hub: Hub, ws: Ws, p: PreparedSend): Written<SendResult> & { msg: MessageRow } {
  const { repo, db, registry } = hub;
  let msg: MessageRow;
  try {
    if (addressParts(p.to)?.kind === "id") assertDeliverableId(db, p.to);
    msg = repo.messages.insert(ws.data.identityFull, "user", p.to, p.body, p.parentId, p.pending, p.ids, ws.data.writerId ?? null);
  } catch (e) {
    if (e instanceof CoreError) throw new SendRefused("bad_request", e.message);
    throw e;
  }
  const f = { ...(p.pending ? { pending: true as const } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) };
  const seen = lastSeen(db, p.to);
  const payload: SendResult = registry.get(p.to)?.data.ready
    ? { message_id: msg.id, delivered_now: true, ...f }
    : {
        message_id: msg.id,
        delivered_now: false,
        ...f,
        ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
        undelivered_from_you: repo.messages.undeliveredFrom([ws.data.identityFull]).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
      };
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// After a fresh send's commit (never a replay's): its files' audit rows and
// the push to a live recipient.
function deliverSend(hub: Hub, ws: Ws, msg: MessageRow): void {
  for (const a of msg.attachments ?? []) {
    writeAudit(hub.repo, "attachment.bound", ws.data.authed.user_email, `attachment:${a.id}`, { identity: ws.data.identityFull, message_id: msg.id, recipient: msg.recipient });
  }
  const recipientWs = hub.registry.get(msg.recipient);
  if (recipientWs?.data.ready) send(recipientWs, { type: "push", message: showMessage(msg) });
}

// An append write, deduplicated (#254): an identical call by this session
// within the window answers with the first one's result. The Slack bridge's
// humans are exempt: a person typing a line twice sent it twice. `uploads`:
// the call's attachment ids; a replay releases them (the retry uploaded its
// files afresh, and nothing will bind them), audited like any release.
function writeOnce<W extends Written>(
  hub: Hub, ws: Ws, tool: DedupTool, args: Record<string, unknown>, resend: boolean, uploads: number[], write: () => Sync<W>,
): DedupOutcome<W> {
  const { repo } = hub;
  if (ws.data.human) return { fresh: repo.atomic(write) };
  const { authed, identityFull: me } = ws.data;
  const out = dedupWrite(repo, hub.now(), {
    tool, session: ws.data.sessionId!, sender: me, actor: authed.user_email, transport: "wss", args, resend,
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

function handleSend(hub: Hub, ws: Ws, m: SendRequest): void {
  let out: DedupOutcome<Written<SendResult> & { msg: MessageRow }>;
  try {
    const p = prepareSend(hub, ws, m.recipient, m.body, m.parent_id ?? null, m.pending === true, m.attachment_ids);
    // Keyed by what the server resolved, so two spellings of one call collide.
    const args = { to: p.to, body: p.body, parent_id: p.parentId, pending: p.pending, attachments: p.digests };
    out = writeOnce(hub, ws, "dm_send", args, m.resend === true, p.ids, () => writeSend(hub, ws, p));
  } catch (e) {
    if (e instanceof SendRefused) return err(ws, m.req_id, e.code, e.message);
    throw e;
  }
  if ("replay" in out) return send(ws, { type: "send_ok", req_id: m.req_id, ...out.replay });
  // Committed, not yet answered: a lost answer's window (tests force it here).
  testPause("write:after-commit");
  deliverSend(hub, ws, out.fresh.msg);
  send(ws, { type: "send_ok", req_id: m.req_id, ...out.fresh.payload });
}

// A delegation request (#184): resolve the launcher (or fall back to the
// requester's human) in core, then deliver it as a pending DM through the
// ordinary send path. `to` resolves like dm_send's recipient (bare and
// mixed-case names included, #184 review 7); the human fallback checks real
// Slack reachability, not a last_seen row (review 10). Every outcome is
// audited: which launcher resolution picked and why, or the refusal (#184
// review 4). The reply is a DelegateOk — the send_ok fields plus `to` and,
// on the degrade path, human_fallback. Deduplicated as a delegate (#254):
// the fingerprint is the request as given, taken before resolution picks a
// launcher, and the resolution, the send and its audit row run inside the
// dedup'd write, so a replay resolves nothing. The inner send isn't
// deduplicated itself: it would collide a later plain dm_send of the same body.
function handleDelegate(hub: Hub, ws: Ws, reqId: string, m: DelegateRequest): void {
  const { repo } = hub;
  const { authed } = ws.data;
  let to: string | undefined;
  if (m.to !== undefined) {
    const r = resolvePeerInput(repo, ws.data.identityFull, m.to);
    if ("error" in r) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: r.error, to: m.to });
      return err(ws, reqId, r.code, r.error);
    }
    to = r.address.address;
  }
  const online = (h: string) => hub.registry.get(h)?.data.ready === true;
  // The human fallback's reachability is the server's own knowledge: the
  // bridge is running and this user is linked. A last_seen row is not
  // reachability (#191: an unlinked or stopped bridge queues into the void).
  const humanReachable = () => hub.slackRunning() && !!repo.slack.linkFor(authed.user_id);
  const args = { to: to ?? null, persona: m.persona, task: m.task, context: m.context ?? null };
  // Where a refused send was headed, for its audit row.
  let picked: string | undefined;
  let out: DedupOutcome<Written<DelegateResult> & { msg: MessageRow }>;
  try {
    out = writeOnce(hub, ws, "delegate", args, m.resend === true, [], () => {
      const d = resolveDelegation(hub.db, ws.data.identityFull, { ...m, to }, online, humanReachable);
      picked = d.to;
      const w = writeSend(hub, ws, prepareSend(hub, ws, d.to, d.body, null, true, undefined));
      // The result is built by the same builder local uses (review 13): the
      // extra carries nothing delegation-specific, so the modes can't drift.
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
        requester: ws.data.identityFull,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
      });
      return { payload, ref: w.ref, msg: w.msg };
    });
  } catch (e) {
    // Written after the rollback, so the refusal's row stays.
    if (e instanceof CoreError) {
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: e.message, to: m.to });
      return err(ws, reqId, "bad_request", e.message);
    }
    // A refused send (canSend, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    if (e instanceof SendRefused) {
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.identityFull, { reason: e.message, to: picked });
      return err(ws, reqId, e.code, e.message);
    }
    throw e;
  }
  if ("replay" in out) return send(ws, { type: "send_ok", req_id: reqId, ...out.replay });
  testPause("write:after-commit");
  deliverSend(hub, ws, out.fresh.msg);
  send(ws, { type: "send_ok", req_id: reqId, ...out.fresh.payload });
}

// The cursor moves only when the recipient acks, so a live recipient may hold
// a pushed message past it: liveness counts as reached too. A repeat of a
// retract that landed (its answer lost, #254) is answered from its audit row.
function handleRetract(hub: Hub, ws: Ws, reqId: string, id: number): void {
  const { repo, registry } = hub;
  const me = ws.data.identityFull;
  const m = repo.messages.getById(id);
  if (!m) {
    const done = repo.audit.last("message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by === me) return send(ws, { type: "ack_ok", req_id: reqId, note: alreadyRetracted(done.at) });
  }
  if (!m || m.recipient_type !== "user" || m.sender !== me) {
    return err(ws, reqId, "not_found", retractRefusal.notYours(id));
  }
  if (registry.get(m.recipient)?.data.ready || repo.cursors.directFor(m.recipient) >= m.id) {
    return err(ws, reqId, "bad_request", retractRefusal.reached(id, m.recipient));
  }
  const retracted = repo.atomic(() => {
    if (!repo.messages.retract(me, id)) return false;
    writeAudit(repo, "message.retracted", ws.data.authed.user_email, `message:${id}`, { message_id: id, sender: me, recipient: m.recipient });
    return true;
  });
  if (!retracted) return err(ws, reqId, "bad_request", retractRefusal.replied(id));
  send(ws, { type: "ack_ok", req_id: reqId });
  void sweepBlobs(hub.db, repo.blobs);
}

function handleCall(hub: Hub, ws: Ws, reqId: string, tool: string, args: Record<string, unknown>): void {
  const { db } = hub;
  if (!isBoardTool(tool)) {
    err(ws, reqId, "bad_request", `unknown tool: ${tool}`);
    return;
  }
  const ctx: ToolContext = {
    online: (h: string) => hub.registry.get(h)?.data.ready === true,
    attachmentLimits: hub.repo.attachmentLimits,
    human: ws.data.human,
    ...(ws.data.writerId ? { session: ws.data.writerId } : {}),
    ...(tool === "peer_list" ? { unbound: unboundPeers(hub, ws) } : {}),
  };
  if (tool === "board_post") return handleBoardPost(hub, ws, reqId, args, ctx);
  let outcome;
  try {
    outcome = callBoardTool(db, ws.data.identityFull, tool, args, ctx);
  } catch (e) {
    if (e instanceof CoreError) return err(ws, reqId, "bad_request", e.message);
    console.error(`[grayboard] ${tool} failed:`, e);
    return err(ws, reqId, "internal", `${tool} failed`);
  }
  send(ws, { type: "call_ok", req_id: reqId, result: outcome.result });
  wake(hub, outcome.wake);
}

// board_post, deduplicated (#254): a repeat replays the first post's result,
// and a queue board gets no second work item.
function handleBoardPost(hub: Hub, ws: Ws, reqId: string, args: Record<string, unknown>, ctx: ToolContext): void {
  const { db, repo } = hub;
  const me = ws.data.identityFull;
  const { resend, ...postArgs } = args;
  let out: DedupOutcome<Written<BoardPostResult> & { wake: string[] }>;
  try {
    if (resend !== undefined && typeof resend !== "boolean") throw new CoreError("resend must be boolean");
    if (typeof postArgs.board !== "string") throw new CoreError("board must be a string");
    // Checked before it's fingerprinted: a non-string body is a bad request, not a canonicalJson failure.
    if (typeof postArgs.body !== "string") throw new CoreError("body must be a string");
    const ids = attachmentIds(postArgs.attachment_ids);
    const fp = {
      board: normalizeBoard(postArgs.board),
      body: postArgs.body,
      parent_id: postArgs.parent_id ?? null,
      attachments: uploadDigests(db, ids, me),
    };
    out = writeOnce(hub, ws, "board_post", fp, resend === true, ids, () => {
      const o = callBoardTool(db, me, "board_post", postArgs, ctx);
      const r = o.result as BoardPostResult;
      return { payload: r, ref: { kind: "post", id: r.post_id } satisfies WriteRef, wake: o.wake };
    });
  } catch (e) {
    if (e instanceof CoreError) return err(ws, reqId, "bad_request", e.message);
    console.error("[grayboard] board_post failed:", e);
    return err(ws, reqId, "internal", "board_post failed");
  }
  if ("replay" in out) return send(ws, { type: "call_ok", req_id: reqId, result: out.replay });
  testPause("write:after-commit");
  const r = out.fresh.payload;
  for (const a of r.attachments ?? []) {
    writeAudit(repo, "attachment.bound", ws.data.authed.user_email, `attachment:${a.id}`, { identity: me, post_id: r.post_id, board: r.board });
  }
  send(ws, { type: "call_ok", req_id: reqId, result: r });
  wake(hub, out.fresh.wake);
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
    peerFull = parsed.address;
  }
  const me = ws.data.identityFull;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const messages = repo.messages.history([me], peerFull, lim, beforeId).reverse().map((m) =>
    m.sender === me && m.recipient_type === "user" && m.recipient !== me ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
  );
  send(ws, { type: "history_ok", req_id: reqId, messages: messages.map(showMessage) });
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
  const owed = unanswered([me], repo.messages.receivedUnacked([me], since), (id) => repo.messages.thread(id));
  const promises = promised([me], repo.messages.sentPending([me], Date.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
  const queued = repo.messages.undeliveredFrom([me]).map((u) => {
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
  send(ws, { type: "thread_ok", req_id: reqId, messages: messages.map(showMessage) });
}

function handleAck(ws: Ws, reqId: string, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move your cursor.
    if (!msg || msg.recipient_type !== "user" || msg.recipient !== ws.data.identityFull) continue;
    repo.cursors.advance(ws.data.identityFull, "direct", ws.data.identityFull, msgId);
  }
  send(ws, { type: "ack_ok", req_id: reqId });
}
