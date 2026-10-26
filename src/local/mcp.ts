// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { IdCollision, activeAnnouncements, checkBody, age, ensureAlias, humanHandles, inheritStatus, isHuman, lastSeen, liveAddresses, markDelivered, pendingFor, rosterHandles, touchAlias, touchId, type UnboundPeer } from "../core/boards.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation } from "../core/delegation.ts";
import { writeCoreAudit } from "../core/audit.ts";
import { bindMissed, envSessionKey, bindOk, bindTarget, boundInstructions, heldNote, idAddress, lastWasRelease, launcherNote, leftNote, unboundInstruction, mintSessionKey, restoreNote, unboundPeer } from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { isQueueBoard } from "../core/boards.ts";
import { addressParts } from "../core/addresses.ts";
import { retentionDays, startLocalRetention } from "./retention.ts";
import { canReadAttachment, getAttachment, sweepBlobs } from "../core/attachments.ts";
import {
  announcementsInstruction,
  claimsInstruction,
  boardNotification,
  dmNotification,
  humanInstruction,
  callBoardTool,
  isBoardTool,
} from "../core/tools.ts";
import {
  ackMessage,
  blobs,
  db,
  getCursor,
  getHistory,
  getMessage,
  getThread,
  insertMessage,
  openEnded,
  receivedUnacked,
  retractMessage,
  retractedAt,
  sentPending,
  setCursor,
  undeliveredFrom,
  type Message,
  unreadFor,
  withUploads,
} from "./db.ts";
import { localDbPath } from "./open.ts";
import { deliverEnded, listenForWakeup, poke } from "./wakeup.ts";
import { sockDir } from "../shared/sockdir.ts";
import { NOTHING_ENDED, acquireName, attachSession, candidateNames, detachSession, endLocalSession, keyedHarness, liveSessions, registerSession, siblingGone, thisSession, type Ended } from "./binding.ts";
import { dropUnboundRecord, freshRecord, sweepRecords, writeRecord } from "../shared/namerecord.ts";
import { isAlive, launcherName } from "../shared/proc.ts";
import { LOCAL_TOOLS } from "./tools.ts";
import { describeLocation, isExplicitIdentity, sessionIdentity } from "../shared/identity.ts";
import { LateCancels } from "../shared/latecancel.ts";
import { testPause } from "../shared/testpause.ts";
import { BindGate } from "../shared/bindgate.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { DEFAULT_ATTACHMENT_LIMITS, attachRoots, checkAttachmentId, localBusDir, readAttachmentFiles, saveAttachment, saveTarget } from "../shared/attachments.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
import {
  PROMISE_DAYS,
  STALE_UNDELIVERED_MS,
  ackIds,
  ackResult,
  historyLimit,
  inboxDays,
  promised,
  queuedNote,
  retractRefusal,
  alreadyRetracted,
  showMessage,
  unanswered,
  undeliveredInstruction,
} from "../shared/inbox.ts";
import pkg from "../../package.json" with { type: "json" };

// BUS_PUSH=off: tools only, for a harness that drops MCP notifications and
// has no adapter. Draining here would consume messages into a void. It is
// still a session (#284 S7): its own ID, which its writes carry, but one that
// receives nothing.
const PUSH = process.env.BUS_PUSH !== "off";
// BUS_SESSION_KEY: an orchestrator minted this session's key, so it knows
// the ID before the process exists (#284 decision 2). The session is then an
// attachment to its harness: it outlives this process, and a restart under
// the same harness carries on as it (decision 3). Read once, here.
const KEY = (() => {
  try {
    return envSessionKey();
  } catch (e) {
    console.error(`[grayboard] ${(e as Error).message}`);
    process.exit(1);
  }
})();
const KEYED = KEY !== undefined;
if (!KEYED && process.env.BUS_HARNESS_PID !== undefined) {
  console.error("[grayboard] BUS_HARNESS_PID names a keyed session's harness; set BUS_SESSION_KEY with it");
  process.exit(1);
}
// A keyed session's harness, whose exit ends the session. A tools-only
// process's liveness is its own (registerSession below), so it has none.
const HARNESS = KEYED && PUSH ? keyedHarness() : null;
if (typeof HARNESS === "string") {
  console.error(`[grayboard] ${HARNESS}`);
  process.exit(1);
}
// This process's session ID (#284), derived from its key.
const SESSION_ID = idAddress(KEY ?? mintSessionKey());
// Directories this session may attach files from and save them to.
const ROOTS = attachRoots();
// This bus's subdirectory of the default save directory.
const BUS_DIR = localBusDir(localDbPath());
const RETENTION_DAYS = retentionDays();
if (RETENTION_DAYS === null) {
  console.error(`[grayboard] BUS_RETENTION_DAYS must be a whole number of days, not "${process.env.BUS_RETENTION_DAYS}"`);
  process.exit(1);
}

// BUS_HUMAN=1: a human holds this identity through a bridge (`grayboard bridge
// slack`). It grants nothing: the handle must already be the declared human
// (`grayboard human`), whose messages and posts reach agents marked
// human="true". Without it, the human's handle is refused, so an agent can't
// take it by name.
const HUMAN = process.env.BUS_HUMAN === "1";
// BUS_LAUNCHER=1: this session's harness can spawn subagents, so delegate
// requests may land here (#184). It grants nothing by itself: the session is
// telling peers what its harness can do, and it's the one that acts on a
// delegation request when one arrives by DM.
const LAUNCHER = process.env.BUS_LAUNCHER === "1";
// A launcher must be able to RECEIVE delegation requests: a tools-only
// session (BUS_PUSH=off) isn't one, whatever its env says — it doesn't hold
// the name, has no socket, and never touches the launcher flag (a sidecar
// must not overwrite the owner's opt-in).
const EFFECTIVE_LAUNCHER = LAUNCHER && PUSH;
// A session binds a name at start only when told which (#182): an explicit
// BUS_IDENTITY (not a harness re-delivering the repo's pin), or the bridge's
// child, whose BUS_IDENTITY is the human handle wherever it runs. Otherwise
// the resolved name is only the first suggestion, and the session starts
// unbound: binding delivers the name's queued DMs and hands it the name's
// claims, which should follow the agent knowing its task.
const EXPLICIT = HUMAN || isExplicitIdentity();
const resolved = (() => {
  try {
    return normalizeIdentityName(HUMAN && process.env.BUS_IDENTITY ? process.env.BUS_IDENTITY : sessionIdentity());
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
})();
// A tools-only process (a harness without an adapter) uses the resolved name
// as it always has, without acquiring it.
const NAMED = EXPLICIT || !PUSH;
if (!resolved.ok && NAMED) {
  console.error(`[grayboard] ${resolved.error}`);
  process.exit(1);
}
const SUGGESTED = resolved.ok ? resolved.name : null;
if (NAMED && HUMAN !== isHuman(db, SUGGESTED!)) {
  console.error(
    HUMAN
      ? `[grayboard] BUS_HUMAN=1, but "${SUGGESTED}" isn't the declared human handle; declare it with: grayboard human ${SUGGESTED}`
      : `[grayboard] "${SUGGESTED}" is your user's handle; an agent session can't use it. Pick another BUS_IDENTITY.`,
  );
  process.exit(1);
}
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: tools only");
// Notifications such a session drops would still count as delivered, so it
// runs tools-only, as BUS_PUSH=off does, and what's pending waits (#71).
const DELIVER = PUSH && !CHANNELS_OFF;

// The bus name this session holds, or null while unbound. bind() changes it,
// only between drains.
let bound: string | null = null;
// Why this session started unbound, for its instructions.
const unboundNotes: string[] = [];
// The name came back from the name record and the name's history shows the
// recorded session (#211): the same harness session, so its peer status stays.
let restored = false;
// The session a verified restore continues (#211): its status carries over.
let restoredFrom: string | null = null;
// The name record (#182 decision 14), written by the session that owns
// delivery whenever its name changes. The Slack bridge's child keeps none:
// its name is fixed, and a restart that can't have it must fail loudly. Nor
// does a keyed session: its restart re-attaches, name and all.
const RECORD_DIR = sockDir();
const RECORDS = PUSH && !HUMAN && !KEYED;
// A failed write costs only the restore after a restart; the bind itself stands.
const writeName = (name: string | null) => {
  if (!RECORDS) return;
  try {
    writeRecord(RECORD_DIR, { name, session_id: SESSION_ID, harness_pid: process.ppid, bus: localDbPath() });
  } catch (e) {
    console.error(`[grayboard] name record for harness pid ${process.ppid} not written:`, e);
  }
};
if (!PUSH) {
  bound = SUGGESTED;
  ensureAlias(db, bound!, bound!);
  // Its liveness is its own process, keyed or not: it ends on exit, and a
  // key shared with a live session collides rather than attaching.
  try {
    registerSession(db, thisSession(SESSION_ID), { writesAs: bound!, keyed: KEYED });
  } catch (e) {
    if (!(e instanceof IdCollision)) throw e;
    writeCoreAudit(db, "id.collision", e.id, e.id, { ended_at: e.endedAt, pid: process.pid, tools_only: true });
    console.error(`[grayboard] ${e.message}`);
    process.exit(1);
  }
} else {
  // The session that owns delivery owns the name: it writes the session's
  // rows, its presence while unbound, and acquires through them.
  // Channels-off sessions too: they own the session, they just don't listen.
  const self = thisSession(SESSION_ID, HARNESS);
  // A keyed session restarting under its live harness: the open above ended
  // it first if the harness had died, so attaching is refused then.
  let attached = false;
  try {
    registerSession(db, self, { launcher: EFFECTIVE_LAUNCHER });
    // The flag is the session's (ids.launcher), so it's audited once, here.
    writeCoreAudit(db, "handle.launcher_set", SESSION_ID, SESSION_ID, { on: EFFECTIVE_LAUNCHER });
  } catch (e) {
    if (!(e instanceof IdCollision)) throw e;
    if (KEYED && e.endedAt === null) {
      const r = await attachSession(db, self, HUMAN);
      if (!r.ok) {
        console.error(`[grayboard] ${r.error}`);
        process.exit(1);
      }
      attached = true;
      bound = r.held;
    } else {
      writeCoreAudit(db, "id.collision", e.id, e.id, { ended_at: e.endedAt, pid: process.pid });
      console.error(`[grayboard] ${e.message}`);
      process.exit(1);
    }
  }
  if (RECORDS) sweepRecords(RECORD_DIR);
  // A restart under the same harness takes back its predecessor's name, ahead
  // of BUS_IDENTITY: it's the same session, mid-task.
  const rec = RECORDS ? freshRecord(RECORD_DIR, process.ppid, localDbPath()) : null;
  if (rec?.name) {
    const n = normalizeIdentityName(rec.name);
    // The process it replaces may not have exited yet.
    if (n.ok) await siblingGone(db, n.name, process.ppid);
    const r = n.ok
      ? await acquireName(db, SESSION_ID, n.name, { create: false, previous: null, restartOf: rec.session_id })
      : { ok: false as const, error: n.error, ended: NOTHING_ENDED };
    await deliverEnded(db, r.ended);
    if (r.ok) {
      bound = r.name;
      restored = r.restored;
      if (restored) restoredFrom = rec.session_id;
    } else unboundNotes.push(restoreNote(rec.name, r.error));
  } else if (EXPLICIT && !attached) {
    const r = await acquireName(db, SESSION_ID, SUGGESTED!, { create: true, previous: null, allowHuman: HUMAN });
    await deliverEnded(db, r.ended);
    if (r.ok) bound = r.name;
    else if (HUMAN) {
      // A bridge has no agent to read a candidate list; refuse loudly.
      console.error(`[grayboard] ${r.error}`);
      await deliverEnded(db, endLocalSession(db, SESSION_ID));
      process.exit(1);
    } else unboundNotes.push(heldNote(SUGGESTED!, r.holder ?? r.error));
  }
  if (!bound && !KEYED) {
    const launcher = launcherName(process.ppid);
    if (launcher) unboundNotes.push(launcherNote(launcher));
  }
  writeName(bound);
}
console.error(`[grayboard] local mode, session ${SESSION_ID}, ${bound ? `identity "${bound}"` : "unbound"}`);

// The address set of a session whose primary is `primary` (#284 S5): its
// alias and its ID. A tools-only process writes as its owner's alias and
// receives nothing, so its ID isn't one of its addresses.
function addressesOf(primary: string): string[] {
  return PUSH ? [...new Set([primary, SESSION_ID])] : [primary];
}

// What a session acting as `name` is told (core's boundInstructions), with
// local mode's human and announcement sentences, and its claims last: the
// longest, and the one to lose if the client cuts the text. `lead` opens the
// variable part: an unbound session's line about binding a name.
function localBoundInstructions(name: string, general: boolean, lead: string[] = []): string[] {
  return boundInstructions(
    name,
    general,
    () => [
      ...(EFFECTIVE_LAUNCHER ? launcherInstruction() : []),
      ...humanInstruction(humanHandles(db).filter((h) => h !== name)),
      ...(HUMAN ? [] : announcementsInstruction(activeAnnouncements(db))),
    ],
    [
      ...lead,
      ...undeliveredInstruction(undeliveredFrom(addressesOf(name), Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      ...claimsInstruction(listClaims(db), addressesOf(name)),
    ],
  );
}

const mcp = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    // Unbound: the session acts as its ID, with a line on binding a name.
    instructions: [
      ...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []),
      ...(bound
        ? localBoundInstructions(bound, true)
        : localBoundInstructions(SESSION_ID, true, [unboundInstruction(SESSION_ID, await candidateNames(db, SUGGESTED), unboundNotes)])),
    ].join(" "),
  },
);

// Tool discovery


mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LOCAL_TOOLS }));

// Tool dispatch

const text = (value: unknown) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

async function wakeAll(handles: string[]): Promise<void> {
  await Promise.all(handles.map((h) => poke(h)));
}

const staleNotice = updateNotice();
// The channels warning also goes in the first tool result, in case the
// instructions went unread.
let channelsNoticePending = CHANNELS_OFF;
// A bind that completed after it was cancelled, for the next tool result; it
// carries the instructions too, as the bind's result would have, for adapters
// that keep them in the system prompt.
let missedBindNotice: string | null = null;
let instructionsStale = false;
// What a result the client dropped carried, for the next one.
const requeued: string[] = [];
const notices = (): string[] => {
  const out = requeued.splice(0);
  if (channelsNoticePending) out.push(CHANNELS_OFF_NOTICE);
  channelsNoticePending = false;
  if (missedBindNotice) out.push(missedBindNotice);
  missedBindNotice = null;
  const stale = staleNotice();
  return stale ? [...out, stale] : out;
};

// Announces claims that lapse on their boards. Every session runs one; the
// sweep's delete makes each lapse post once.
const expiry = claimExpiryTimer(db, (handles) => void wakeAll(handles));

const gate = new BindGate();
const late = new LateCancels();
// Set when shutdown starts: no call or drain starts after it, and shutdown
// waits (bounded) for those in flight before it ends the session, so nothing
// writes rows for an ended ID. `sessionEnded` guards a write that outlived the wait.
let shuttingDown = false;
let sessionEnded = false;
const calls = new Set<Promise<unknown>>();
mcp.setRequestHandler(CallToolRequestSchema, async (req, { signal, requestId }) => {
  const { name, arguments: args = {} } = req.params;
  if (shuttingDown) return { ...text("error: this session is ending"), isError: true };
  const run = async () => {
    if (bound) touchAlias(db, bound);
    touchId(db, SESSION_ID);
    return call(name, args, signal);
  };
  const pending = name === "bind" ? gate.bind(run) : gate.call(run);
  calls.add(pending);
  let r: { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
  try {
    r = await pending;
  } finally {
    calls.delete(pending);
  }
  expiry.arm();
  // A cancelled call's result is dropped: its notices wait for the next one.
  if (signal.aborted) return r;
  const extra = notices();
  let out = extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text", text }))] } : r;
  if (instructionsStale && !out.structuredContent && bound) {
    instructionsStale = false;
    out = { ...out, structuredContent: { name: bound, instructions: localBoundInstructions(bound, true) } };
  }
  late.answer(requestId, () => {
    if (name === "bind" && r.structuredContent) requeued.push(bindMissed((r.structuredContent as { name: string }).name, "it was cancelled", r.content[0]!.text));
    requeued.push(...extra);
    if (out.structuredContent) instructionsStale = true;
  });
  return out;
});

async function call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const bad = checkArgs(LOCAL_TOOLS, name, args);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  try {
    return await dispatch(name, args, signal);
  } catch (err) {
    if (err instanceof CoreError) {
      return { ...text(`error: ${err.message}`), isError: true };
    }
    throw err;
  }
}

async function dispatch(name: string, a: Record<string, unknown>, signal: AbortSignal) {
  if (name === "bind") return bind(a, signal);
  // With no name, the session acts as its ID (#284 S13).
  const IDENTITY = bound ?? SESSION_ID;
  // What this session reads mail, claims and uploads as; IDENTITY is the
  // primary it writes as.
  const ADDRS = addressesOf(IDENTITY);
  // Only a message's sender and recipient can see it or thread from it.
  const mine = (m: Message | undefined): m is Message => !!m && (ADDRS.includes(m.sender) || ADDRS.includes(m.recipient));

  if (name === "delegate") {
    // Resolve the launcher and build the payload (core), then deliver it as
    // this mode's DM, pending: the promise shows in dm_inbox until the
    // requester settles the thread (#184). Same result fields as dm_send, via
    // the shared builder, so the modes can't drift.
    const live = await liveHandles(ADDRS);
    // A launcher inside its bind swap still answers under its old name: filter
    // it like dm_send does (a released name's socket isn't the session).
    const online = (h: string) => live(h) && !lastWasRelease(db, h);
    let d;
    try {
      d = resolveDelegation(db, IDENTITY, a, online);
    } catch (e) {
      if (e instanceof CoreError) {
        writeCoreAudit(db, "delegation.refused", IDENTITY, null, { reason: e.message });
        return { ...text(`error: ${e.message}`), isError: true };
      }
      throw e;
    }
    // The window a re-pick races: the liveness snapshot above is taken once,
    // the delivery pokes again below. Tests force the overlap here (a socket
    // that dies between the two) — #246 review 12/16.
    testPause("delegate:after-resolve");
    checkBody(d.body);
    // The message id tracks the pick that owns the work: a re-pick replaces
    // both (review 16).
    let msgId = (await insertMessage(IDENTITY, SESSION_ID, d.to, d.body, null, true, [])).id;
    writeCoreAudit(db, "delegation.requested", IDENTITY, d.to, { via: d.humanFallback ? "human_fallback" : a.to !== undefined ? "explicit" : "auto", message_id: msgId });
    const deliver = async (to: string) => (await poke(to)) && !lastWasRelease(db, to);
    let delivered = await deliver(d.to);
    if (!delivered && !d.humanFallback) {
      // The pick may have landed in a bind swap: re-resolve once, excluding
      // the launcher that didn't take it. The first message is retracted
      // first — left queued, that name's next holder would drain it and
      // spawn the same work again (#246 review 16) — and the re-pick only
      // proceeds when the retraction wins; otherwise the request stays
      // queued for the first pick, which the catch below treats as fine.
      try {
        const d2 = resolveDelegation(db, IDENTITY, a, (h) => online(h) && h !== d!.to);
        if (d2.to !== d.to && !d2.humanFallback && retractMessage(IDENTITY, msgId)) {
          const id2 = (await insertMessage(IDENTITY, SESSION_ID, d2.to, d2.body, null, true, [])).id;
          writeCoreAudit(db, "delegation.requested", IDENTITY, d2.to, { via: "auto", message_id: id2, repicked_from: d.to });
          d = d2;
          msgId = id2;
          delivered = await deliver(d2.to);
        }
      } catch {
        // No second launcher: the request stays queued for the first pick's
        // name; its next holder drains it.
      }
    }
    const seen = lastSeen(db, d.to);
    const base = delivered
      ? { message_id: msgId, delivered_now: true, pending: true as const }
      : {
          message_id: msgId,
          delivered_now: false,
          pending: true as const,
          note: queuedNote(d.to, seen),
          ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
          undelivered_from_you: undeliveredFrom(ADDRS).find((u) => u.recipient === d!.to)?.n ?? 1,
        };
    return text(JSON.stringify(delegateOkFields(d, base)));
  }

  if (name === "dm_send") {
    const { to, body, parent_id, pending } = a as {
      to: string;
      body: string;
      parent_id?: number;
      pending?: boolean;
    };
    checkBody(body);
    // A session ID is checked where the message is written (insertMessage).
    const parsed = addressParts(to);
    const recipient = parsed?.kind === "id" ? parsed.address : to;
    if (parsed?.kind !== "id" && !rosterHandles(db).includes(recipient)) {
      return {
        ...text(`error: no agent "${recipient}" has ever connected; peer_list shows exact handles`),
        isError: true,
      };
    }
    if (parent_id !== undefined && !mine(getMessage(parent_id))) {
      return {
        ...text(`error: parent_id ${parent_id} is not a message you sent or received`),
        isError: true,
      };
    }
    const files = a.attachments === undefined ? [] : await readAttachmentFiles(a.attachments, ROOTS);
    const { id, attachments } = await withUploads(IDENTITY, files, (ids) => insertMessage(IDENTITY, SESSION_ID, recipient, body, parent_id ?? null, pending === true, ids));
    const p = { ...(pending ? { pending: true } : {}), ...(attachments.length ? { attachments } : {}) };
    // A socket that answers for a released name is a bind's swap window: the
    // DM stays queued for the name's next holder (#182 audit 29).
    const delivered = (await poke(recipient)) && !lastWasRelease(db, recipient);
    if (delivered) return text(JSON.stringify({ message_id: id, delivered_now: true, ...p, note: "Recipient was online; pushed." }));
    const seen = lastSeen(db, recipient);
    return text(JSON.stringify({
      message_id: id,
      delivered_now: false,
      ...p,
      note: queuedNote(recipient, seen),
      ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
      undelivered_from_you: undeliveredFrom(ADDRS).find((u) => u.recipient === recipient)?.n ?? 1,
    }));
  }

  if (name === "dm_history") {
    return text(getHistory(ADDRS, a.peer as string | undefined, historyLimit(a.limit), a.before_id as number | undefined).map(showMessage));
  }

  if (name === "dm_thread") {
    if (!mine(getMessage(a.thread as number))) {
      return { ...text(`error: message ${a.thread} not found`), isError: true };
    }
    return text(getThread(a.thread as number).filter(mine).map(showMessage));
  }

  if (name === "dm_inbox") {
    const since = Date.now() - inboxDays(a.days) * 86_400_000;
    const owed = unanswered(ADDRS, receivedUnacked(ADDRS, since), getThread);
    const promises = promised(ADDRS, sentPending(ADDRS, Date.now() - PROMISE_DAYS * 86_400_000), getThread);
    const queued = undeliveredFrom(ADDRS).map((u) => {
      const seen = lastSeen(db, u.recipient);
      return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(Date.now() - seen)} ago` } : {}) };
    });
    return text({
      unanswered: owed,
      ...(promises.length ? { promised: promises } : {}),
      ...(queued.length ? { undelivered_from_you: queued } : {}),
    });
  }

  if (name === "dm_ack") {
    const ids = ackIds(a.message_id);
    if (!ids) return { ...text("error: message_id must be a message_id or a list of them"), isError: true };
    const acked: number[] = [], missing: number[] = [];
    for (const id of ids) {
      const m = getMessage(id);
      // The ack is the reader's the inbox checks: the address it was sent to,
      // or for a promise, the address it was sent as.
      const reader = !m ? undefined : ADDRS.includes(m.recipient) ? m.recipient : ADDRS.includes(m.sender) && m.pending ? m.sender : undefined;
      if (reader) { ackMessage(reader, id); acked.push(id); } else missing.push(id);
    }
    const r = ackResult(acked, missing);
    return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
  }

  if (name === "dm_retract") {
    const m = getMessage(a.message_id as number);
    const refuse = (why: string) => ({ ...text(`error: ${why}`), isError: true });
    // A repeat whose first answer was lost (#254): it landed.
    const done = m ? undefined : retractedAt(ADDRS, a.message_id as number);
    if (done !== undefined) return text(`ok: ${alreadyRetracted(done)}`);
    if (!m || !ADDRS.includes(m.sender)) return refuse(retractRefusal.notYours(a.message_id as number));
    // A probe is a wakeup: a live recipient drains the message now.
    if (getCursor(m.recipient) >= m.id || (await poke(m.recipient))) return refuse(retractRefusal.reached(m.id, m.recipient));
    if (!retractMessage(m.sender, m.id)) {
      return refuse(getCursor(m.recipient) >= m.id ? retractRefusal.reached(m.id, m.recipient) : retractRefusal.replied(m.id));
    }
    await sweepBlobs(db, blobs);
    return text("ok");
  }

  if (name === "attachment_get") {
    const id = checkAttachmentId(a.id);
    const target = await saveTarget(a.dir, ROOTS, BUS_DIR);
    const row = getAttachment(db, id);
    if (!row || !canReadAttachment(db, IDENTITY, row, (m) => mine(getMessage(m)), ADDRS)) {
      return { ...text(`error: no attachment ${id} on a message or post you can read`), isError: true };
    }
    const path = await saveAttachment(row, await blobs.get(row.sha256), target);
    return text({ path, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256 });
  }

  if (isBoardTool(name)) {
    // Only a human can start an announcement, which reaches the sessions live
    // now. A queue board's rotation prefers live lanes, so it needs the probe
    // too; other posts don't pay for it.
    const queuePost = name === "board_post" && isQueueBoard(db, typeof a.board === "string" ? a.board : "");
    const ctx = {
      ...(name === "peer_list" || (name === "board_post" && (HUMAN || queuePost)) ? { online: await liveHandles(ADDRS) } : {}),
      ...(name === "peer_list" ? { unbound: await unboundPeers() } : {}),
      attachmentLimits: DEFAULT_ATTACHMENT_LIMITS,
      human: HUMAN,
      session: SESSION_ID,
      addresses: ADDRS,
    };
    const { attachments: paths, ...args } = a;
    const files = paths === undefined ? [] : await readAttachmentFiles(paths, ROOTS);
    // Bound in the post's transaction; a refused post releases the uploads.
    const { result, wake } = await withUploads(IDENTITY, files, (ids) =>
      db.transaction(() => callBoardTool(db, IDENTITY, name, ids.length ? { ...args, attachment_ids: ids } : args, ctx)).immediate(),
    );
    await wakeAll(wake);
    return text(result);
  }

  throw new Error(`unknown tool: ${name}`);
}

// Which addresses have a live session, by probing each wakeup socket. A probe
// is also a wakeup, so each live peer runs a drain; that's harmless (idempotent).
async function liveHandles(self: string[]): Promise<(h: string) => boolean> {
  const others = liveAddresses(db).filter((h) => !self.includes(h));
  const alive = await Promise.all(others.map((h) => poke(h)));
  const live = new Set(others.filter((_, i) => alive[i]));
  return (h) => live.has(h);
}

// Live sessions with no name yet, for peer_list, with the status each set as
// its ID, delivering what ending the dead ones it found produced.
async function unboundPeers(): Promise<UnboundPeer[]> {
  const { alive, ...ended } = liveSessions(db);
  await deliverEnded(db, ended);
  const unbound = alive.filter((r) => r.name === null);
  const statuses = new Map(
    (
      db
        .prepare(`SELECT id, status, status_at FROM ids WHERE status IS NOT NULL AND id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(unbound.map((r) => r.session_id))) as { id: string; status: string; status_at: number | null }[]
    ).map((r) => [r.id, r]),
  );
  const now = Date.now();
  return unbound.map((r) => {
    const s = statuses.get(r.session_id);
    return unboundPeer(r.session_id, r.cwd ? describeLocation(r.cwd) : null, r.session_id === SESSION_ID, s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
  });
}

// Drain: emit unread direct messages and pending board items as channel
// notifications. Loop until empty so concurrent writes that race past a
// single query still get picked up. Re-entry is guarded; crashed drains
// re-deliver (at-least-once).
let inflight: Promise<void> | null = null;
// Set while bind swaps names: no drain starts, so none mixes the two names.
let swapping = false;
// The first drain also brings deferred thread replies and digests: a new
// session is the natural time to see them.
let firstDrain = true;

// Claude Code drops notifications that arrive before it sends `initialized`,
// so the startup drain (and any early wakeup) waits for it.
let markInitialized!: () => void;
const initialized = new Promise<void>((r) => { markInitialized = r; });
mcp.oninitialized = () => markInitialized();

// A wakeup during a drain joins it: the loop re-queries until empty.
function drainToClaude(): Promise<void> {
  if (swapping || shuttingDown) return Promise.resolve();
  inflight ??= drainLoop().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Each of the session's addresses (#284 S5) is drained under its own cursor
// and outbox rows: mail to the ID and to the alias are separate streams.
async function drainLoop(): Promise<void> {
  await initialized;
  // Read once: a cursor written under one name must never get another's ids.
  const readers = bound ? addressesOf(bound) : [SESSION_ID];
  while (!shuttingDown) {
    const first = firstDrain;
    firstDrain = false;
    let any = false;
    for (const reader of readers) {
      const batch = unreadFor(reader);
      // A human's session has no tokens to save; a DM is already waking the agent.
      const boardItems = pendingFor(db, reader, { all: first || HUMAN || batch.length > 0 });
      if (batch.length === 0 && boardItems.length === 0) continue;
      any = true;
      for (const msg of batch) {
        if (shuttingDown) return;
        const params = dmNotification(msg);
        if (isHuman(db, msg.sender)) params.meta.human = "true";
        await mcp.notification({ method: "notifications/claude/channel", params });
        if (sessionEnded) return;
        setCursor(reader, msg.id);
      }
      for (const item of boardItems) {
        if (shuttingDown) return;
        const params = boardNotification(item);
        if (item.kind === "push" && isHuman(db, item.post.author)) params.meta.human = "true";
        await mcp.notification({
          method: "notifications/claude/channel",
          params,
        });
        if (sessionEnded) return;
        markDelivered(db, reader, item);
      }
    }
    if (!any) break;
  }
}

const onWake = () => {
  if (shuttingDown) return;
  // A wakeup may follow another session's claim_take.
  expiry.arm();
  drainToClaude().catch((err) => {
    console.error("grayboard drain error:", err);
  });
};
// The alias's wakeup socket, swapped by bind; the ID's is this process's
// from start to exit.
let stopListening = () => {};
let stopIdListening = () => {};

// bind(name, create?): take a name, or move to another (#182). The new name
// is acquired first (its row, in one transaction); only then does the old
// name's socket close. Claims stay with the name they were taken under. Drains stop for
// the swap, so a DM to the old name is either delivered under it before the
// swap or stays queued for its next holder; never consumed under the new one.
// It runs behind the gate, so no tool call overlaps it (#182 audit 11).
async function bind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  const n = bindTarget(a, bound, PUSH);
  if ("result" in n) return n.result;
  swapping = true;
  try {
    await inflight;
    const previous = bound;
    const r = await acquireName(db, SESSION_ID, n.name, { create: a.create === true, previous });
    await deliverEnded(db, r.ended);
    if (!r.ok) return fail(r.error);
    // The row holds the new name from here: so does this process, whatever
    // follows fails, or the finally's drain would read a name it no longer holds.
    bound = n.name;
    writeName(bound);
    firstDrain = true;
    testPause("bind:after-acquire");
    try {
      if (DELIVER) {
        stopListening();
        stopListening = () => {};
        stopListening = listenForWakeup(n.name, onWake);
      }
      if (previous) touchAlias(db, previous);
      touchAlias(db, n.name);
    } catch (e) {
      console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}" but its setup failed:`, e);
      throw new CoreError(`bound "${n.name}"${previous ? ` (was "${previous}")` : ""}, but setting it up failed: ${(e as Error).message}`);
    }
    console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}"${previous ? ` (was "${previous}")` : ""}`);
    // Claims stay with the name they were taken under (#284 S6): say which
    // ones this session no longer holds.
    const left = previous ? listClaims(db).filter((c) => c.holder === previous).map((c) => c.key) : [];
    const notes = previous ? leftNote(previous, left) : [];
    const ok = bindOk(n.name, previous, (general) => localBoundInstructions(n.name, general), notes, true);
    // A cancelled call's result is dropped (pi and opencode cancel on abort).
    if (signal.aborted) {
      missedBindNotice = bindMissed(n.name, "it was cancelled", ok.content[0]!.text);
      instructionsStale = true;
    }
    return ok;
  } finally {
    swapping = false;
    if (DELIVER) onWake();
  }
}


// Startup: the name (if any) is already acquired. Connect MCP so
// notifications are accepted, listen on the name's wakeup socket, and replay
// what arrived while offline.
// A restored name is the same harness session restarted: its status carries
// over to this session's ID.
if (restoredFrom) inheritStatus(db, SESSION_ID, restoredFrom);
if (bound) touchAlias(db, bound);
const transport = new StdioServerTransport();
await mcp.connect(transport);
late.watch(transport);
// Prunes the bus at most once a day across the sessions that share it.
startLocalRetention(db, blobs, RETENTION_DAYS);

// How long exit waits for in-flight calls and the drain, and then for the
// end's wakeups: they're conveniences (mail and posts are durable, and each
// recipient's next wake drains them), so a stuck socket mustn't hold the exit.
const SHUTDOWN_WAKE_MS = 2000;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (bound) touchAlias(db, bound);
  } catch (err) {
    // The bus may already be closed at shutdown; exiting matters more.
    console.error("grayboard shutdown: touching the alias failed:", err);
  }
  // The sockets go first, while the row still holds the name, so nobody
  // takes the name with this socket still in place.
  stopListening();
  stopIdListening();
  await Promise.race([Promise.allSettled([...calls, inflight]), Bun.sleep(SHUTDOWN_WAKE_MS)]);
  let ended: Ended = NOTHING_ENDED;
  try {
    // A keyed session outlives this process while its harness runs.
    if (HARNESS && isAlive(HARNESS.pid, HARNESS.proc_start)) detachSession(db, SESSION_ID);
    else ended = endLocalSession(db, SESSION_ID);
  } catch (err) {
    // Same: shutdown must not throw, but a session left unended is the
    // next opener's reap, so say why.
    console.error(`grayboard shutdown: ending ${SESSION_ID} failed:`, err);
  }
  sessionEnded = true;
  if (RECORDS && !bound) dropUnboundRecord(RECORD_DIR, process.ppid, SESSION_ID);
  await Promise.race([deliverEnded(db, ended).catch(() => {}), Bun.sleep(SHUTDOWN_WAKE_MS)]);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Exit when the client goes away. Otherwise the wakeup listener keeps an
// orphan alive that holds the identity and blocks the next session.
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
// What this process's open ended (db.ts): bounces and releases to wake. After
// the exit handlers, so a client gone during it still ends this session.
await deliverEnded(db, openEnded);

if (DELIVER) {
  stopIdListening = listenForWakeup(SESSION_ID, onWake);
  if (bound) stopListening = listenForWakeup(bound, onWake);
  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}
