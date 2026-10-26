import { participant, type MessageRow, type Repo, type Sync } from "./db.ts";
import {
  parseClientMessage, type ServerMessage, type HelloOk, type HelloRequest, type BindRequest, type DelegateRequest, type DelegateResult, type SendRequest, type SendResult,
  type ErrorCode, type ErrorMessage, type WriteRef,
} from "../shared/protocol.ts";
import { HUMAN_NAME, HUMAN_RESERVED, formatTeamAddress } from "../shared/addressing.ts";
import { canSend, type HumanReach } from "./can_send.ts";
import { serverAuditSink, writeAudit } from "./audit.ts";
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
  inheritStatus,
  registerId,
  cleanPlace,
  setPlace,
  touchAlias,
  touchId,
  type CoreDb,
  type PendingRef,
  type UnboundPeer,
} from "../core/boards.ts";
import {
  aliasUser, aliasUses, closestNames, continuityOf, dropHold, holdAlias, holderOf, holdsOf, idAddress, idRow, idStatuses, logBinding, unboundPeer, unendedIds,
  unknownNameError, type AliasUse, type Continuity, type IdRow,
} from "../core/bindings.ts";
import { addressParts, aliasScope, type AliasScope, type ParsedAddress, type ScopeKind } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { assertDeliverableId, endSession, Undeliverable } from "../core/session_end.ts";
import { callBoardTool, claimsInstruction, isBoardTool, type BoardPostResult, type ToolContext } from "../core/tools.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
import { attachmentIds, dropUnsentUploads, sweepBlobs, uploadDigests } from "../core/attachments.ts";
import { dedupWrite, type DedupOutcome, type DedupTool, type Written } from "./write_dedup.ts";
import { testPause } from "../shared/testpause.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { onAliasCreated } from "./teams.ts";
import { mayActIn } from "./access.ts";
import {
  PROMISE_DAYS, STALE_UNDELIVERED_MS, alreadyRetracted, historyLimit, inboxDays, promised, queuedNote, retractRefusal, showMessage, unanswered, undeliveredInstruction,
} from "../shared/inbox.ts";

export type WsData = {
  authed: AuthedUser;
  ready: boolean;
  // The address the connection writes as (#284 S8): its alias when bound,
  // else its session ID; a tools-only connection's writes_as.
  primary: string;
  // Every address it reads as: {bound alias?, ID}; a tools-only
  // connection's [writes_as] (it receives nothing, so its ID isn't one).
  addresses: string[];
  // The alias the session holds (one per session until PR 4).
  bound?: string;
  // Board items sent and not yet acked on this connection. Cleared with the
  // connection, so a reconnect resends them (at-least-once, like DMs).
  inflight?: Set<string>;
  // Set while a collision probe is waiting for this connection's pong.
  onPong?: () => void;
  // The server's Slack bridge holding a user's human alias (S16): it has no
  // session ID, and is set only in-process, so no network hello reaches it.
  human?: true;
  // The session's ID (#284), derived from its hello's session key: keys its
  // ids row, its holds, its binding events and its writes' provenance.
  // Undefined for the Slack bridge's humans, whose writes carry no session.
  sessionId?: string;
  // Where the client runs, from its hello.
  place?: string | null;
  // The hello's push: false for a hold or tools-only connection, which is
  // never pushed to and not online.
  push?: boolean;
  // A tools-only connection (S7): writes as writes_as, binds nothing.
  toolsOnly?: true;
  // Its session ended by its `end` (S4): any later frame is refused.
  ended?: true;
  // Its hello is in flight: a second one is refused.
  helloing?: true;
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
  // The hub's clock: the rate limiters', the write-dedup window's
  // (src/server/write_dedup.ts) and the grace's. Tests move it instead of sleeping.
  now?: () => number;
};

/** How long a session outlives its connection's close (#284 S4): a resume within it re-attaches. */
export const GRACE_MS = 30_000;
/** How often the sweep ends sessions past their grace (S4). */
export const SWEEP_MS = 5_000;

// Per server instance.
type Hub = {
  // address -> the connection pushes go to: a push connection's ID and its
  // bound alias, a Slack bridge human's email/human.
  registry: Map<string, Ws>;
  // session ID -> its connection: every agent connection (push, hold and
  // tools-only), so probe, supersede and grace treat them alike.
  holders: Map<string, Ws>;
  // session ID -> the probe a hello is running against its connection
  probing: Map<string, Promise<boolean>>;
  // session ID -> when its grace ends: its connection closed, its holds stay (S4).
  grace: Map<string, number>;
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

function err(ws: Ws, reqId: string | undefined, code: ErrorCode, message: string, extra: Pick<ErrorMessage, "known" | "holder" | "retry_after_ms"> = {}): void {
  send(ws, { type: "error", req_id: reqId, code, message, ...extra });
}

// A refused call's code and message: an ID that can't receive names its own
// code (#284 S18); any other CoreError is a bad request.
function coreRefusal(e: CoreError): { code: ErrorCode; message: string } {
  return e instanceof Undeliverable ? { code: e.code, message: e.detail } : { code: "bad_request", message: e.message };
}

function refKey(r: PendingRef): string {
  // Digests are keyed by board: until one is acked, newer posts don't send another.
  return r.kind === "push" ? `p:${r.post_id}` : `d:${r.board}`;
}

// Send this connection everything pending on boards, for any of its
// addresses, that it hasn't been sent: a subscription taken as the ID while
// unbound and the alias's own both deliver. all: also deferred pushes and
// digests (at hello; see pendingFor).
function drainBoards(ws: Ws, db: CoreDb, all = false): void {
  const inflight = (ws.data.inflight ??= new Set());
  for (const address of ws.data.addresses) {
    for (const item of pendingFor(db, address, { all })) {
      const key = refKey(refOf(item));
      if (inflight.has(key)) continue;
      inflight.add(key);
      send(ws, { type: "board_push", item });
    }
  }
}

// Direct messages to any of `addresses` past each one's cursor (unacked ones
// are resent).
function drainDirect(hub: Hub, ws: Ws, addresses: string[]): void {
  const streams = addresses.map((a) => ({ type: "direct" as const, ref: a, since: hub.repo.cursors.get(a, "direct", a) }));
  for (const message of hub.repo.messages.unreadSince(streams)) {
    send(ws, { type: "push", message: showMessage(message) });
  }
}

// A human's session has no wakes to save: it gets deferred pushes and
// digests at once.
function wake(hub: Hub, handles: string[]): void {
  for (const ws of new Set(handles.map((h) => hub.registry.get(h)))) {
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

// helloLimit: hellos per user, the burst and the refill rate (#210). A bind
// spends from the same bucket (S2).
export function createWsHandlers(repo: Repo, db: CoreDb, opts: WsOptions & { helloLimit: RateLimit }) {
  const hub: Hub = {
    registry: new Map(), holders: new Map(), probing: new Map(), grace: new Map(), repo, db,
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
  // No connection outlives the server, but a session does, for its grace
  // (S4): every one a previous run left gets a grace from now, so a deploy
  // ends only the sessions that don't come back, through endSession.
  const startedAt = hub.now();
  for (const id of unendedIds(db)) hub.grace.set(id, startedAt + GRACE_MS);

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
        err(ws, typeof reqId === "string" ? reqId : undefined, "bad_request", (e as Error).message);
        return;
      }

      if (msg.type === "pong") {
        ws.data.onPong?.();
        return;
      }

      if (ws.data.ended) {
        err(ws, msg.req_id, "id_ended", `session ${ws.data.sessionId} has ended`);
        ws.close();
        return;
      }

      if (!ws.data.ready) {
        if (msg.type !== "hello") {
          err(ws, undefined, "bad_request", "send hello first");
          ws.close();
          return;
        }
        // A hello awaits a probe; a second one meanwhile would race it for the session.
        if (ws.data.helloing) {
          err(ws, msg.req_id, "bad_request", "a hello is already in flight on this connection");
          ws.close();
          return;
        }
        ws.data.helloing = true;
        (ws.data.human ? Promise.resolve(helloHuman(hub, ws, msg)) : handleHello(hub, ws, msg)).catch((e) => {
          console.error("[grayboard] hello failed:", e);
          err(ws, msg.req_id, "internal", "hello failed");
          ws.close();
        });
        return;
      }

      // A connection superseded, revoked or ended has left the hub; a frame
      // already in flight on it must not act for the session (its successor's).
      if (!ws.data.human && hub.holders.get(ws.data.sessionId!) !== ws) {
        err(ws, msg.req_id, "superseded", "this connection no longer holds its session");
        ws.close();
        return;
      }

      // The handlers are synchronous: a throw (a bug, or a row deleted under
      // the connection) answers the call instead of leaving it to time out.
      try {
        switch (msg.type) {
          case "hello":
            err(ws, msg.req_id, "bad_request", "already authenticated");
            break;
          case "bind":
            handleBind(hub, ws, msg);
            break;
          case "end":
            handleEnd(hub, ws, msg.req_id);
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
            // Acked as the address the row names (S8): receivedUnacked and
            // sentPending match a.reader = m.recipient, or m.sender.
            const m = repo.messages.getById(msg.message_id);
            const mine = ws.data.addresses;
            const reader = !m || m.recipient_type !== "user" ? null
              : mine.includes(m.recipient) ? m.recipient
              : m.pending && mine.includes(m.sender) ? m.sender
              : null;
            if (!m || reader === null) {
              err(ws, msg.req_id, "not_found", `no message ${msg.message_id} to you or pending from you; dm_inbox lists them`);
              break;
            }
            repo.messages.ack(reader, m.id);
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
            // A ref carries no handle: the item was sent for one of this
            // connection's addresses, and acknowledging is a no-op on one
            // with no such row, so each address acks it.
            for (const r of msg.refs) {
              for (const a of ws.data.addresses) acknowledge(db, a, r);
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
      ws.data.onPong = undefined;
      if (ws.data.human) {
        const addr = ws.data.primary;
        if (addr && hub.registry.get(addr) === ws) {
          hub.registry.delete(addr);
          logBinding(hub.db, HUMAN_NAME, addr, "released", "connection closed");
        }
        return;
      }
      const id = ws.data.sessionId;
      // A superseded connection was detached when it was; its close records nothing.
      if (!id || hub.holders.get(id) !== ws) return;
      detach(hub, ws);
      touchId(hub.db, id);
      if (ws.data.bound) touchAlias(hub.db, ws.data.bound);
      // Its holds stay: a 30 s blip must not lose the alias (S4).
      const until = hub.now() + GRACE_MS;
      hub.grace.set(id, until);
      writeAudit(hub.repo, "id.detached", ws.data.authed.user_email, id, { held: ws.data.bound ?? null, grace_until: until });
    },
  };

  // Auth is checked at the upgrade only. When an admin revokes or disables a
  // user, close their connections (#70): reconnecting then fails auth. Their
  // sessions end at once, live or in their grace, not through the grace (S4).
  // The Slack bridge's humans have their own path (SlackBridge.userChanged).
  const conns = () => [...hub.holders.values()];
  const disconnectUser = (userId: number) => {
    for (const ws of conns()) {
      if (ws.data.authed.user_id !== userId) continue;
      detach(hub, ws);
      err(ws, undefined, "unauthenticated", "an admin signed this user out");
      ws.close();
    }
    const email = repo.users.findById(userId)?.email;
    if (!email) return;
    endIds(hub, unendedIds(db, email), "revoked");
  };
  // Catches a user disabled while one of their hellos was in flight, and an
  // alias its session's principal may no longer act as (S9's backstop to
  // accessChanged).
  const revalidate = () => {
    for (const id of new Set(conns().map((ws) => ws.data.authed.user_id))) {
      if (repo.users.findById(id)?.disabled_at != null) disconnectUser(id);
    }
    recheckAliases(hub, null);
  };
  // What a principal may act in changed (S9): a team leave or removal now,
  // #270's grants later. Its sessions stop acting as aliases it lost now,
  // not when they next bind.
  const accessChanged = (principal: string) => recheckAliases(hub, principal);

  // Heartbeat: keeps idle connections open through proxies.
  const startPing = () =>
    setInterval(() => {
      revalidate();
      for (const ws of hub.holders.values()) {
        if (ws.readyState === 1 /* OPEN */) send(ws, { type: "ping" });
      }
    }, 30_000);

  return {
    handlers, startPing, revalidate, disconnectUser, accessChanged, stopExpiry: expiry.stop,
    sweepSessions: (now = hub.now()) => sweepSessions(hub, now),
    sweepHellos: () => hub.helloLimiter.sweep(),
    wake: (handles: string[]) => wake(hub, handles),
  };
}

// Ends every session past its grace (S4), on its own SWEEP_MS interval, so
// the end lands 30-35 s after the close. An ID with a live connection only
// leaves the grace: a stale close must not end a session that came back.
function sweepSessions(hub: Hub, now: number): void {
  const due: string[] = [];
  for (const [id, until] of hub.grace) {
    if (hub.holders.has(id)) hub.grace.delete(id);
    else if (until <= now) due.push(id);
  }
  endIds(hub, due, "grace");
}

// Ends sessions, each in its own transaction (bounces, claim releases, holds
// released), then wakes what that changed and sweeps the freed upload bytes.
// One end that throws is logged and audited id.end_failed and leaves the
// others ended; its ID goes (back) into the grace, so a sweep retries it
// rather than the sweep's interval dying with it.
function endIds(hub: Hub, ids: string[], why: string): void {
  if (!ids.length) return;
  const { repo, db } = hub;
  const woken = new Set<string>();
  for (const id of ids) {
    let ended;
    try {
      ended = repo.atomic(() => endSession(db, repo.mail, id, { why, now: hub.now(), audit: serverAuditSink(repo) }));
    } catch (e) {
      const retryAt = hub.now() + GRACE_MS;
      if (!hub.holders.has(id)) hub.grace.set(id, retryAt);
      console.error(`[grayboard] ending session ${id} (${why}) failed; retrying after ${new Date(retryAt).toISOString()}:`, e);
      writeAudit(repo, "id.end_failed", null, id, { why, error: String(e), retry_at: retryAt });
      continue;
    }
    hub.grace.delete(id);
    // An end that found the session already ended sends nothing again.
    if (!ended.ended) continue;
    for (const h of ended.wake) woken.add(h);
    // A bounce goes to a live sender now, as a send does; a drain would
    // resend that connection's unacked messages too.
    for (const b of repo.messages.bouncesFrom(id)) {
      const to = hub.registry.get(b.recipient);
      if (to?.data.ready) send(to, { type: "push", message: showMessage(b) });
    }
    if (ended.held.length) console.error(`[grayboard] session ${id} ended (${why}); released ${ended.held.join(", ")}`);
  }
  wake(hub, [...woken]);
  void sweepBlobs(db, repo.blobs);
}

// end (S4): an unkeyed session's clean exit ends it at once. The connection
// leaves the hub first, so its close records no grace.
function handleEnd(hub: Hub, ws: Ws, reqId: string): void {
  if (ws.data.human) return err(ws, reqId, "bad_request", "the Slack bridge's humans have no session to end");
  detach(hub, ws);
  ws.data.ended = true;
  endIds(hub, [ws.data.sessionId!], "exit");
  send(ws, { type: "end_ok", req_id: reqId });
}

// The connection leaves the hub's maps: superseded, or closed.
function detach(hub: Hub, ws: Ws): void {
  const id = ws.data.sessionId!;
  if (hub.holders.get(id) === ws) hub.holders.delete(id);
  for (const a of ws.data.addresses) if (hub.registry.get(a) === ws) hub.registry.delete(a);
}

// Re-checks the aliases that sessions act as (S9) against mayActIn, for one
// principal's sessions or (null) every session's, and revokes the ones it
// now refuses.
function recheckAliases(hub: Hub, principal: string | null): void {
  const revoked: (AliasUse & { reason: string })[] = [];
  for (const u of aliasUses(hub.db, principal)) {
    const p = hub.repo.principals.findByName(u.principal);
    const reason = p ? mayActIn(hub.repo, p, u) : `principal ${u.principal} no longer exists`;
    if (reason) revoked.push({ ...u, reason });
  }
  revokeAliases(hub, revoked);
}

// Takes aliases from sessions whose principals may no longer act in their
// scopes (S9). A holder keeps its ID: its hold is released, and a live one
// is told by an alias_lost frame and acts as its ID from here. A tools-only
// connection writes only as its writes_as, so it has nothing left to be:
// its session ends, and its reconnect's hello is refused.
function revokeAliases(hub: Hub, uses: (AliasUse & { reason: string })[]): void {
  if (!uses.length) return;
  const { repo, db, registry } = hub;
  const ended: string[] = [];
  for (const u of uses) {
    const { reason } = u;
    const ws = hub.holders.get(u.id);
    if (!u.held) {
      writeAudit(repo, "alias.revoked", u.principal, u.address, { session: u.id, writes_as: true, reason });
      if (ws) {
        detach(hub, ws);
        err(ws, undefined, "forbidden", `this connection wrote as "${u.address}", and ${reason}`);
        ws.close();
      }
      ended.push(u.id);
      continue;
    }
    repo.atomic(() => {
      dropHold(db, u.address, u.id);
      logBinding(db, u.id, u.address, "released", `access revoked: ${reason}`);
      writeAudit(repo, "alias.revoked", u.principal, u.address, { session: u.id, reason });
    });
    if (!ws || ws.data.bound !== u.address) continue;
    if (registry.get(u.address) === ws) registry.delete(u.address);
    ws.data.bound = undefined;
    ws.data.primary = u.id;
    ws.data.addresses = [u.id];
    send(ws, { type: "alias_lost", alias: u.address, reason });
  }
  endIds(hub, ended, "revoked");
}

const userPrincipal = (authed: AuthedUser): Principal => ({ kind: "user", name: authed.user_email });

function helloOkFields(hub: Hub, authed: AuthedUser): Pick<HelloOk, "user_email" | "teams" | "human" | "attachment_limits"> {
  const { repo } = hub;
  return {
    user_email: authed.user_email,
    teams: repo.teams.listForUser(authed.user_id).map((t) => formatTeamAddress(t.name)),
    human: { handle: `${authed.user_email}/${HUMAN_NAME}`, linked: hub.slackRunning() && !!repo.slack.linkFor(authed.user_id) },
    attachment_limits: repo.attachmentLimits,
  };
}

// The sentences a session's instructions carry for its addresses: active
// claims, and direct messages it sent that still haven't arrived a day later.
function noticesFor(hub: Hub, addresses: string[], first: string[] = []): string[] {
  return [
    ...first,
    ...undeliveredInstruction(hub.repo.messages.undeliveredFrom(addresses, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(hub.db, h)),
    // Last, as the plugin appends notices: the longest, so the one a cut takes.
    ...claimsInstruction(listClaims(hub.db), addresses),
  ];
}

// The hello is the session (#284 S1, S3): it registers the key's ID, or
// re-attaches a session in its grace, holds and all. Aliases come by bind.
async function handleHello(hub: Hub, ws: Ws, m: HelloRequest): Promise<void> {
  const { repo, db, registry, holders } = hub;
  const reqId = m.req_id;
  const { authed } = ws.data;
  const id = m.session_key ? idAddress(m.session_key) : null;
  // Client text: cleaned once, before any audit or log carries it.
  const where = cleanPlace(m.where ?? null);
  // First, before anything reads or writes the database.
  const t = hub.helloLimiter.take(authed.user_email, { session_id: id, place: where });
  if (!t.ok) {
    send(ws, { type: "error", req_id: reqId, code: "rate_limited", message: `too many connections for this user; retry in ${retrySecs(t.retryAfterMs)}s`, retry_after_ms: t.retryAfterMs });
    ws.close();
    return;
  }
  const refuse = (code: ErrorCode, message: string) => {
    send(ws, { type: "error", req_id: reqId, code, message });
    ws.close();
  };
  if (id === null) return refuse("bad_request", "a hello needs a session_key");
  const push = m.push !== false;
  const toolsOnly = !push && m.hold !== true;
  // A tools-only connection writes as an alias it may act in, but never holds it (S7).
  let writesAs: Exclude<Target, { error: string }> | undefined;
  if (toolsOnly) {
    const target = bindTarget(hub, authed, m.writes_as!);
    if ("error" in target) {
      if (target.address) logBinding(db, id, target.address, "refused", target.error);
      return refuse(target.code, target.error);
    }
    const other = aliasUser(db, target.address, authed.user_email);
    if (other) {
      const why = `"${target.address}" is in use by another user's session ${other}`;
      logBinding(db, id, target.address, "refused", why);
      return refuse("alias_held", `${why}; write as another name`);
    }
    writesAs = target;
  }
  const collide = (why: string) => {
    writeAudit(repo, "id.collision", authed.user_email, id, { why, place: where });
    refuse("id_collision", idCollisionText(id, why));
  };
  // Never probe or supersede another principal's connection: its row is
  // checked before anything touches the hub.
  const row = idRow(db, id);
  if (row && row.principal !== authed.user_email) return collide("is another principal's session");
  if (row?.ended_at != null) return collide(`ended at ${new Date(row.ended_at).toISOString()}`);
  // A re-attach is the session it registered as: a tools-only session
  // writes as the same alias, and a push or hold one writes as nobody else.
  // Checked before the probe, so a mismatched hello never supersedes.
  const sameShape = (r: IdRow) => r.writes_as === (writesAs?.address ?? null);
  const shapeWhy = (r: IdRow) => `registered writing as ${r.writes_as ? `"${r.writes_as}"` : "its own addresses"}, and this hello writes as ${writesAs ? `"${writesAs.address}"` : "its own"}`;
  if (row && !sameShape(row)) return collide(shapeWhy(row));

  // One live connection per session. A connection on this ID that still
  // answers is a second process on one key: refused. One that doesn't is
  // dead (a reconnect beat its close): superseded. Each await can change the
  // hub (a close, another hello), so after one, check again from the top;
  // between the last check and holders.set below nothing awaits (#69).
  for (;;) {
    const inFlight = hub.probing.get(id);
    if (inFlight) {
      // Another hello is probing the holder: whoever wins, it's settled after.
      await inFlight;
      if (ws.readyState !== 1 /* OPEN */) return;
      continue;
    }
    const holder = holders.get(id);
    if (!holder || holder === ws) break;
    const probing = probe(holder, hub.probeMs).finally(() => {
      if (hub.probing.get(id) === probing) hub.probing.delete(id);
    });
    hub.probing.set(id, probing);
    if (await probing) return collide("is live on another connection");
    if (ws.readyState !== 1 /* OPEN */) return;
    if (holders.get(id) === holder) {
      // Detached first, so its close finds another connection holding the
      // ID and records no grace (S3).
      detach(hub, holder);
      writeAudit(repo, "id.superseded", authed.user_email, id, { old_place: holder.data.place ?? null, place: where });
      err(holder, undefined, "superseded", "a newer connection took over this session");
      holder.close();
    }
  }
  // The row again: the session may have ended during an await.
  const now = idRow(db, id);
  if (now?.ended_at != null) return collide(`ended at ${new Date(now.ended_at).toISOString()}`);
  if (now && !sameShape(now)) return collide(shapeWhy(now));
  const launcher = push && m.launcher === true;
  if (!now) {
    repo.atomic(() => {
      if (writesAs) createLazily(hub, authed, writesAs, id);
      const reused = registerId(db, {
        id, principal: authed.user_email, place: where, launcher, keyed: m.keyed === true, ...(writesAs === undefined ? {} : { writesAs: writesAs.address }),
      });
      // A key whose ended session retention pruned (#284 S10): a new session on an old ID.
      if (reused) writeAudit(repo, "id.reused", authed.user_email, id, { ended_at: reused.ended_at, pruned_at: reused.pruned_at });
      writeAudit(repo, "id.registered", authed.user_email, id, {
        delivery: writesAs === undefined ? "push" : "none", ...(m.hold ? { hold: true } : {}), ...(writesAs === undefined ? {} : { writes_as: writesAs.address }), keyed: m.keyed === true, place: where,
      });
    });
  } else {
    setPlace(db, id, where);
    touchId(db, id);
    // Every push hello rewrites the flag; registerId wrote it for a new row.
    if (push) setLauncher(db, id, launcher);
    // Possession of the key is the proof; resume is detail only (S3).
    writeAudit(repo, "id.reattached", authed.user_email, id, { resume: m.resume === true, in_grace: hub.grace.has(id), place: where });
  }
  hub.grace.delete(id);
  // Audited, changed or not (#184 review 4/6): a hold or tools-only
  // connection can't receive a delegation, so it's never a launcher.
  if (push) writeAudit(repo, "handle.launcher_set", authed.user_email, id, { on: launcher });

  const bound = toolsOnly ? undefined : holdsOf(db, id)[0];
  ws.data.sessionId = id;
  ws.data.place = where;
  ws.data.push = push;
  ws.data.bound = bound;
  if (toolsOnly) ws.data.toolsOnly = true;
  ws.data.primary = writesAs?.address ?? bound ?? id;
  ws.data.addresses = writesAs !== undefined ? [writesAs.address] : bound ? [bound, id] : [id];
  holders.set(id, ws);
  if (push) for (const a of ws.data.addresses) registry.set(a, ws);
  if (bound) touchAlias(db, bound);
  ws.data.ready = true;

  const bridgeNotice = owedBridgeNotice(repo, authed.user_email);
  const notices = noticesFor(hub, ws.data.addresses, [
    ...(launcher ? launcherInstruction() : []),
    // Before the claims: drained once, so a cut must not take it.
    ...(bridgeNotice ? [bridgeNotice] : []),
  ]);
  send(ws, {
    type: "hello_ok", req_id: reqId, id, ...(bound ? { bound } : {}), ...helloOkFields(hub, authed),
    ...(notices.length ? { notices } : {}),
  });
  if (!push) return;
  // Mail and board items for every address, the alias's included: what
  // arrived during a grace is delivered on resume.
  drainDirect(hub, ws, ws.data.addresses);
  drainBoards(ws, db, true);
}

// The Slack bridge's in-process human (S16): no ID, no ids row, no grace.
// It holds email/human and logs bind events under the literal `human`.
function helloHuman(hub: Hub, ws: Ws, m: HelloRequest): void {
  const { repo, db, registry } = hub;
  const { authed } = ws.data;
  const addr = `${authed.user_email}/${HUMAN_NAME}`;
  if (!repo.aliases.find(addr)) {
    repo.aliases.create({ scope_kind: "person", scope_ref: authed.user_email, name: HUMAN_NAME }, authed.user_email);
    writeAudit(repo, "alias.created", authed.user_email, addr, { lazy: true, slack: true });
    onAliasCreated(db, repo, authed.user_id, addr);
  }
  // A bridge connection never pongs: a newer one for the user replaces it.
  const prev = registry.get(addr);
  registry.set(addr, ws);
  if (prev && prev !== ws) {
    err(prev, undefined, "superseded", "a newer Slack bridge connection took over this human");
    prev.close();
  }
  ws.data.primary = addr;
  ws.data.addresses = [addr];
  ws.data.ready = true;
  touchAlias(db, addr);
  logBinding(db, HUMAN_NAME, addr, "bound");
  send(ws, { type: "hello_ok", req_id: m.req_id, id: HUMAN_NAME, ...helloOkFields(hub, authed) });
  drainDirect(hub, ws, [addr]);
  drainBoards(ws, db, true);
}

// What a bind or a tools-only hello's writes_as names (#284 S9): a bare name
// in the caller's own person scope, or scope/name in a scope the caller may
// act in (mayActIn). Never `human`:
// canSend treats any */human as a human.
// A refusal carries the address when the input parsed as one, so the
// refusal is logged against it; an unparseable name has none.
type Target = { address: string; scope: AliasScope & { scope_ref: string } } | { code: ErrorCode; error: string; address?: string };

function bindTarget(hub: Hub, authed: AuthedUser, input: string): Target {
  const { repo } = hub;
  const p = addressParts(input);
  if (!p || p.kind === "id" || p.kind === "team") {
    return { code: "bad_request", error: `"${input}" isn't an alias: a name (a-z 0-9 _ -, 1-32 chars), or scope/name` };
  }
  const address = p.kind === "bare" ? `${authed.user_email}/${p.name}` : p.address;
  let scope: AliasScope;
  try {
    scope = aliasScope(address, (k) => {
      const kind = repo.principals.findByName(k)?.kind;
      return kind === "team" || kind === "service" ? kind : null;
    });
  } catch (e) {
    if (e instanceof CoreError) return { code: "not_found", error: e.message, address };
    throw e;
  }
  if (scope.name === HUMAN_NAME) return { code: "forbidden", error: HUMAN_RESERVED, address };
  const t = { ...scope, scope_ref: scope.scope_ref! };
  const no = mayActIn(repo, userPrincipal(authed), t);
  if (no) return { code: "forbidden", error: `you can't act as "${address}": ${no}; bind a name in your own scope, or in a team's you belong to`, address };
  return { address, scope: t };
}

// An alias a bind or a writes_as names is created on first use (S9), by
// the user who named it. Callers are inside a transaction.
function createLazily(hub: Hub, authed: AuthedUser, { address, scope }: Exclude<Target, { error: string }>, session: string): void {
  const { repo, db } = hub;
  if (repo.aliases.find(address)) return;
  repo.aliases.create(scope, authed.user_email);
  writeAudit(repo, "alias.created", authed.user_email, address, { lazy: true, session });
  onAliasCreated(db, repo, authed.user_id, address);
}

// Who holds an alias, for an alias_held refusal: its ID, where it runs, and
// for a session in its grace, when it disconnected and when it ends.
function describeHolder(hub: Hub, id: string): string {
  const place = idRow(hub.db, id)?.place;
  const until = hub.grace.get(id);
  const grace = until === undefined ? "" : `; disconnected at ${new Date(until - GRACE_MS).toISOString()}, ends by ${new Date(until).toISOString()}`;
  return `the session ${id}${place ? `, in ${place}` : ""}${grace}`;
}

// bind (#284 S2): take an alias for this session, or move to another. A
// bind while holding one is a rebind: the old hold is released, and claims
// stay with the alias they were taken under (S6).
function handleBind(hub: Hub, ws: Ws, m: BindRequest): void {
  const { repo, db, registry } = hub;
  const { authed } = ws.data;
  if (ws.data.human || ws.data.toolsOnly) {
    return err(ws, m.req_id, "bad_request", "a tools-only connection writes as its writes_as; it binds nothing");
  }
  const id = ws.data.sessionId!;
  // Lazy creation is here, not in the limited hello: an unlimited create loop
  // would mint aliases without bound.
  const t = hub.helloLimiter.take(authed.user_email, { session_id: id, bind: m.alias });
  if (!t.ok) {
    return send(ws, { type: "error", req_id: m.req_id, code: "rate_limited", message: `too many binds for this user; retry in ${retrySecs(t.retryAfterMs)}s`, retry_after_ms: t.retryAfterMs });
  }
  const target = bindTarget(hub, authed, m.alias);
  if ("error" in target) {
    if (target.address) logBinding(db, id, target.address, "refused", target.error);
    return err(ws, m.req_id, target.code, target.error);
  }
  const { address, scope } = target;
  const previous = ws.data.bound ?? null;
  if (address === previous) return send(ws, { type: "bind_ok", req_id: m.req_id, alias: address });
  const refuse = (code: ErrorCode, message: string, detail: string, extra: Pick<ErrorMessage, "known" | "holder" | "retry_after_ms"> = {}) => {
    logBinding(db, id, address, "refused", detail);
    err(ws, m.req_id, code, message, extra);
  };
  // A typo would otherwise create a fresh alias, and the DMs queued for the
  // intended one would never arrive.
  if (m.create === false && !repo.aliases.find(address)) {
    const known = closestNames(scope.name, repo.aliases.listForScope(scope.scope_kind, scope.scope_ref).map((a) => a.name).filter((n) => n !== HUMAN_NAME));
    const message = unknownNameError(scope.name, known);
    return refuse("identity_unknown", message, message, { known });
  }
  // Another session's hold is never taken over, live or in its grace.
  const holder = holderOf(db, address);
  if (holder !== null && holder !== id) {
    const who = describeHolder(hub, holder);
    // A holder in its grace frees the alias by the sweep after it ends,
    // unless it comes back: a restore retries then (S11).
    const until = hub.grace.get(holder);
    const wait = until === undefined ? {} : { retry_after_ms: Math.max(0, until - hub.now()) + SWEEP_MS };
    return refuse("alias_held", `"${address}" is held by ${who}; bind another name`, who, { holder: who, ...wait });
  }
  // Another user's tools-only session writing as it holds nothing, but the
  // alias is in use, so it's exclusive all the same (S8, decided).
  const writer = aliasUser(db, address, authed.user_email);
  if (writer !== null) {
    const why = `"${address}" is in use by another user's session ${writer}`;
    return refuse("alias_held", `${why}; bind another name`, why);
  }

  const restored = repo.atomic((): Continuity | undefined => {
    createLazily(hub, authed, target, id);
    const continued = continuity(hub, authed, id, address, m);
    if (previous) {
      dropHold(db, previous, id);
      logBinding(db, id, previous, "released", `rebound to ${address}`);
    }
    holdAlias(db, address, id);
    logBinding(db, id, address, previous ? "moved" : "bound", previous ?? continued?.detail ?? null);
    touchAlias(db, address);
    return continued;
  });

  if (previous && registry.get(previous) === ws) registry.delete(previous);
  if (ws.data.push) registry.set(address, ws);
  ws.data.bound = address;
  ws.data.primary = address;
  ws.data.addresses = [address, id];
  // Claims stay with the alias they were taken under (S6): say which.
  const left = previous ? listClaims(db).filter((c) => c.holder === previous).map((c) => c.key) : [];
  const notices = noticesFor(hub, ws.data.addresses);
  send(ws, {
    type: "bind_ok", req_id: m.req_id, alias: address,
    ...(restored ? { restored } : {}), ...(left.length ? { left } : {}), ...(notices.length ? { notices } : {}),
  });
  if (!ws.data.push) return;
  drainDirect(hub, ws, [address]);
  drainBoards(ws, db, true);
}

// A bind's claim to continue an earlier session on the alias (#211), checked
// against the alias's history in the bind's transaction. restored_from names
// a public ID, so it shows the history, not descent; previous_key is the
// ended session's secret, so it proves descent after a reconnect past the
// grace (S4). A verified one carries the status over.
function continuity(hub: Hub, authed: AuthedUser, id: string, address: string, m: BindRequest): Continuity | undefined {
  const { db } = hub;
  if (m.restored_from !== undefined) {
    // Another principal's session's status is never carried over.
    if (idRow(db, m.restored_from)?.principal !== authed.user_email) {
      return { verified: false, detail: `restore not verified: ${m.restored_from} isn't a session of yours` };
    }
    const c = continuityOf(db, address, { restartOf: m.restored_from });
    if (c.verified) inheritStatus(db, id, m.restored_from);
    return c;
  }
  if (m.previous_key === undefined) return undefined;
  const prev = idAddress(m.previous_key);
  const row = idRow(db, prev);
  if (!row || row.principal !== authed.user_email || row.ended_at === null) {
    return { verified: false, detail: `restore after end not verified: ${prev} isn't an ended session of yours` };
  }
  const c = continuityOf(db, address, { restartOf: prev });
  if (!c.verified) return c;
  inheritStatus(db, id, prev);
  return { verified: true, detail: `restored after end of session ${prev}` };
}

// The user's live sessions with no alias, for peer_list: never another
// user's (`where` describes their machine). A hold connection isn't listed:
// it receives nothing.
function unboundPeers(hub: Hub, ws: Ws): UnboundPeer[] {
  const mine = [...hub.holders.values()].filter((c) => c.data.authed.user_id === ws.data.authed.user_id && c.data.push && !c.data.bound);
  const statuses = idStatuses(hub.db, mine.map((c) => c.data.sessionId!));
  const now = Date.now();
  return mine.map((c) => {
    const s = statuses.get(c.data.sessionId!);
    return unboundPeer(c.data.sessionId!, c.data.place ?? null, c === ws, s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
  });
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
  const r = resolvePeerInput(repo, ws.data.primary, input);
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
    digests = uploadDigests(db, ids, ws.data.primary);
  } catch (e) {
    if (e instanceof CoreError) throw new SendRefused("bad_request", e.message);
    throw e;
  }

  const r = resolvePeerInput(repo, ws.data.primary, recipientStr);
  if ("error" in r) throw new SendRefused(r.code, r.error);
  const to = r.address;
  if (to.kind === "team") throw new SendRefused("bad_request", `${to.address} isn't a person; to reach a team, board_post to its board #${to.name}`);
  // An ID's deliverability is checked in the write's transaction (writeSend).
  if (to.kind === "alias" && !repo.aliases.find(to.address)) throw new SendRefused("not_found", `identity "${to.address}" not found; peer_list shows exact handles`);
  const decision = canSend(ws.data.primary, { kind: "user", address: to.address }, { db: repo, now: Date.now(), humanReach: hub.humanReach });
  if (!decision.allow) throw new SendRefused(decision.code, decision.reason);

  if (parentId !== null && !participant(repo.messages.getById(parentId), ws.data.addresses)) {
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
    msg = repo.messages.insert(ws.data.primary, "user", p.to, p.body, p.parentId, p.pending, p.ids, ws.data.sessionId ?? null);
  } catch (e) {
    if (e instanceof CoreError) {
      const r = coreRefusal(e);
      throw new SendRefused(r.code, r.message);
    }
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
        undelivered_from_you: repo.messages.undeliveredFrom(ws.data.addresses).find((u) => u.recipient === p.to)?.n ?? 1,
        note: queuedNote(p.to, seen),
      };
  return { payload, ref: { kind: "message", id: msg.id }, msg };
}

// After a fresh send's commit (never a replay's): its files' audit rows and
// the push to a live recipient.
function deliverSend(hub: Hub, ws: Ws, msg: MessageRow): void {
  for (const a of msg.attachments ?? []) {
    writeAudit(hub.repo, "attachment.bound", ws.data.authed.user_email, `attachment:${a.id}`, { identity: ws.data.primary, message_id: msg.id, recipient: msg.recipient });
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
  const { authed, primary: me } = ws.data;
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
    const r = resolvePeerInput(repo, ws.data.primary, m.to);
    if ("error" in r) {
      // An unresolvable `to` is a refusal, and it's audited as one (#184 review 4).
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.primary, { reason: r.error, to: m.to });
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
      const d = resolveDelegation(hub.db, ws.data.primary, { ...m, to }, online, humanReachable);
      picked = d.to;
      const w = writeSend(hub, ws, prepareSend(hub, ws, d.to, d.body, null, true, undefined));
      // The result is built by the same builder local uses (review 13): the
      // extra carries nothing delegation-specific, so the modes can't drift.
      const payload: DelegateResult = { ...w.payload, ...delegateOkFields(d, w.payload) };
      writeAudit(repo, "delegation.requested", authed.user_email, d.to, {
        requester: ws.data.primary,
        via: d.humanFallback ? "human_fallback" : m.to !== undefined ? "explicit" : "auto",
        message_id: w.msg.id,
      });
      return { payload, ref: w.ref, msg: w.msg };
    });
  } catch (e) {
    // Written after the rollback, so the refusal's row stays.
    if (e instanceof CoreError) {
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.primary, { reason: e.message, to: m.to });
      const r = coreRefusal(e);
      return err(ws, reqId, r.code, r.message);
    }
    // A refused send (canSend, a missing identity, a bad body) is a refusal,
    // not a request (#184 review 4).
    if (e instanceof SendRefused) {
      writeAudit(repo, "delegation.refused", authed.user_email, ws.data.primary, { reason: e.message, to: picked });
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
  const mine = ws.data.addresses;
  const m = repo.messages.getById(id);
  if (!m) {
    const done = repo.audit.last("message.retracted", `message:${id}`);
    const by = done?.detail ? (JSON.parse(done.detail) as { sender?: string }).sender : undefined;
    if (done && by !== undefined && mine.includes(by)) return send(ws, { type: "ack_ok", req_id: reqId, note: alreadyRetracted(done.at) });
  }
  // Retracted as the address that sent it (S8).
  if (!m || m.recipient_type !== "user" || !mine.includes(m.sender)) {
    return err(ws, reqId, "not_found", retractRefusal.notYours(id));
  }
  if (registry.get(m.recipient)?.data.ready || repo.cursors.directFor(m.recipient) >= m.id) {
    return err(ws, reqId, "bad_request", retractRefusal.reached(id, m.recipient));
  }
  const retracted = repo.atomic(() => {
    if (!repo.messages.retract(m.sender, id)) return false;
    writeAudit(repo, "message.retracted", ws.data.authed.user_email, `message:${id}`, { message_id: id, sender: m.sender, recipient: m.recipient });
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
    ...(ws.data.sessionId ? { session: ws.data.sessionId } : {}),
    addresses: ws.data.addresses,
    ...(tool === "peer_list" ? { unbound: unboundPeers(hub, ws) } : {}),
  };
  if (tool === "board_post") return handleBoardPost(hub, ws, reqId, args, ctx);
  let outcome;
  try {
    outcome = callBoardTool(db, ws.data.primary, tool, args, ctx);
  } catch (e) {
    if (e instanceof CoreError) {
      const r = coreRefusal(e);
      return err(ws, reqId, r.code, r.message);
    }
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
  const me = ws.data.primary;
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
    if (e instanceof CoreError) {
      const r = coreRefusal(e);
      return err(ws, reqId, r.code, r.message);
    }
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
  const mine = ws.data.addresses;
  const cursors = new Map<string, number>();
  const reached = (to: string) => {
    if (!cursors.has(to)) cursors.set(to, repo.cursors.directFor(to));
    return cursors.get(to)!;
  };
  // Newest `lim` before beforeId, shown oldest first as in local mode.
  const messages = repo.messages.history(mine, peerFull, lim, beforeId).reverse().map((m) =>
    mine.includes(m.sender) && m.recipient_type === "user" && !mine.includes(m.recipient) ? { ...m, delivered: reached(m.recipient) >= m.id } : m,
  );
  send(ws, { type: "history_ok", req_id: reqId, messages: messages.map(showMessage) });
}

function handleInbox(hub: Hub, ws: Ws, reqId: string, days: number | undefined): void {
  const { repo, db } = hub;
  const mine = ws.data.addresses;
  let since: number;
  try {
    since = Date.now() - inboxDays(days) * 86_400_000;
  } catch (e) {
    return err(ws, reqId, "bad_request", (e as Error).message);
  }
  const owed = unanswered(mine, repo.messages.receivedUnacked(mine, since), (id) => repo.messages.thread(id));
  const promises = promised(mine, repo.messages.sentPending(mine, Date.now() - PROMISE_DAYS * 86_400_000), (id) => repo.messages.thread(id));
  const queued = repo.messages.undeliveredFrom(mine).map((u) => {
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
  const mine = (m: MessageRow | undefined): m is MessageRow => participant(m, ws.data.addresses);
  if (!mine(repo.messages.getById(messageId))) {
    err(ws, reqId, "not_found", `message ${messageId} not found`);
    return;
  }
  const messages = repo.messages.thread(messageId).filter(mine);
  send(ws, { type: "thread_ok", req_id: reqId, messages: messages.map(showMessage) });
}

function handleAck(ws: Ws, reqId: string, messageIds: number[], repo: Repo): void {
  for (const msgId of messageIds) {
    const msg = repo.messages.getById(msgId);
    // Only your own direct messages move a cursor: their recipient address's (S8).
    if (!msg || msg.recipient_type !== "user" || !ws.data.addresses.includes(msg.recipient)) continue;
    repo.cursors.advance(msg.recipient, "direct", msg.recipient, msgId);
  }
  send(ws, { type: "ack_ok", req_id: reqId });
}
