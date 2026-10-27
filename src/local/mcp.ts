// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { IdCollision, parseAliasMeta, type AliasMetaSet, activeAnnouncements, checkBody, age, ensureAlias, humanHandles, inheritStatus, isHuman, lastSeen, liveAddresses, markDelivered, pendingFor, pendingKey, refOf, rosterHandles, touchAlias, touchId, type Pending, type UnboundPeer } from "../core/boards.ts";
import { delegateOkFields, launcherInstruction, resolveDelegation } from "../core/delegation.ts";
import { writeCoreAudit } from "../core/audit.ts";
import { MAX_HOLDS, TOOLS_ONLY_BIND, actingAs, bindMissed, boardActor, logBinding, replySender, unbindMissed, envSessionKey, bindOk, boundInstructions, heldNote, idAddress, lastWasRelease, launcherNote, notHolding, primaryOf, unbindOk, unboundInstruction, mintSessionKey, restoreNote, unboundPeer } from "../core/bindings.ts";
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
import { NOTHING_ENDED, acquireName, attachSession, candidateNames, detachSession, endLocalSession, keyedHarness, liveSessions, registerSession, releaseName, setHeldMeta, SIBLING_WAIT_MS, siblingGone, thisSession, type Ended } from "./binding.ts";
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
// BUS_MODEL, BUS_EFFORT: what this session's harness runs on, shown on its
// peer_list rows (#284 S12). Self-reported, read once, ended with the session.
const MODEL = process.env.BUS_MODEL || undefined;
const EFFORT = process.env.BUS_EFFORT || undefined;
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

// The names this session holds, oldest first (#284 S1): the first is its
// primary, which it sends as. bind() and unbind() change it, only between
// drains. A tools-only process holds nothing and writes as WRITES_AS.
let held: string[] = [];
const WRITES_AS = PUSH ? null : SUGGESTED;
// The address this session writes as by default, and every address it reads
// mail, claims and uploads as (#284 S1): its holds and its ID. A tools-only
// process receives nothing, so its ID isn't one of its addresses.
const primary = (): string => WRITES_AS ?? primaryOf(held, SESSION_ID);
const addresses = (): string[] => (WRITES_AS ? [WRITES_AS] : [...held, SESSION_ID]);
// Notes on how this session started: why it has no name, or a name its
// restart couldn't take back. For its instructions.
const startNotes: string[] = [];
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
const writeNames = () => {
  if (!RECORDS) return;
  try {
    writeRecord(RECORD_DIR, { names: held, session_id: SESSION_ID, harness_pid: process.ppid, bus: localDbPath() });
  } catch (e) {
    console.error(`[grayboard] name record for harness pid ${process.ppid} not written:`, e);
  }
};
if (WRITES_AS) {
  ensureAlias(db, WRITES_AS, WRITES_AS);
  // Its liveness is its own process, keyed or not: it ends on exit, and a
  // key shared with a live session collides rather than attaching.
  try {
    registerSession(db, thisSession(SESSION_ID), { writesAs: WRITES_AS, keyed: KEYED, model: MODEL, effort: EFFORT });
  } catch (e) {
    if (!(e instanceof IdCollision)) throw e;
    writeCoreAudit(db, "id.collision", e.id, e.id, { why: e.why, delivery: "none", ended_at: e.endedAt, pid: process.pid });
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
    registerSession(db, self, { launcher: EFFECTIVE_LAUNCHER, model: MODEL, effort: EFFORT });
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
      held = r.held;
    } else {
      writeCoreAudit(db, "id.collision", e.id, e.id, { why: e.why, ended_at: e.endedAt, pid: process.pid });
      console.error(`[grayboard] ${e.message}`);
      process.exit(1);
    }
  }
  if (RECORDS) sweepRecords(RECORD_DIR);
  // A restart under the same harness takes back its predecessor's names, in
  // their order, ahead of BUS_IDENTITY: it's the same session, mid-task
  // (#284 S10). Each is judged on its own; the first taken is the primary.
  const rec = RECORDS ? freshRecord(RECORD_DIR, process.ppid, localDbPath()) : null;
  if (rec?.names.length) {
    // A record is this machine's file, not proof: past MAX_HOLDS its names
    // are reported, not tried.
    const missed = rec.names.slice(MAX_HOLDS).map((name) => ({ name, why: `a session holds at most ${MAX_HOLDS} names` }));
    // The process it replaces may not have exited yet: one wait for all of
    // its names, not one per name.
    const deadline = Date.now() + SIBLING_WAIT_MS;
    for (const name of rec.names.slice(0, MAX_HOLDS)) {
      const n = normalizeIdentityName(name);
      if (n.ok) await siblingGone(db, n.name, process.ppid, Math.max(0, deadline - Date.now()));
      const r = n.ok
        ? await acquireName(db, SESSION_ID, n.name, { create: false, restartOf: rec.session_id })
        : { ok: false as const, error: n.error, ended: NOTHING_ENDED };
      await deliverEnded(db, r.ended);
      if (!r.ok) {
        missed.push({ name, why: r.error });
        continue;
      }
      held.push(r.name);
      // The status carries over once, from the first name that verifies.
      if (r.restored && !restored) {
        restored = true;
        restoredFrom = rec.session_id;
      }
    }
    for (const m of missed) startNotes.push(restoreNote(m.name, m.why, held.length > 0));
  } else if (EXPLICIT && !attached) {
    const r = await acquireName(db, SESSION_ID, SUGGESTED!, { create: true, allowHuman: HUMAN });
    await deliverEnded(db, r.ended);
    if (r.ok) held.push(r.name);
    else if (HUMAN) {
      // A bridge has no agent to read a candidate list; refuse loudly.
      console.error(`[grayboard] ${r.error}`);
      await deliverEnded(db, endLocalSession(db, SESSION_ID));
      process.exit(1);
    } else startNotes.push(heldNote(SUGGESTED!, r.holder ?? r.error));
  }
  if (!held.length && !KEYED) {
    const launcher = launcherName(process.ppid);
    if (launcher) startNotes.push(launcherNote(launcher));
  }
  writeNames();
}
console.error(`[grayboard] local mode, session ${SESSION_ID}, ${held.length ? `identity "${held.join('", "')}"` : WRITES_AS ? `writing as "${WRITES_AS}"` : "unbound"}`);

// What the session is told as it is now (core's boundInstructions): as its
// primary, with local mode's human and announcement sentences, and its claims
// last: the longest, and the one to lose if the client cuts the text. An
// unbound session's variable part opens with its line about binding a name;
// `notes` are why it started as it did.
function localInstructions(general: boolean, notes: string[] = []): string[] {
  const name = primary();
  const lead = !WRITES_AS && !held.length ? [unboundInstruction(SESSION_ID, unboundCandidates, notes)] : notes;
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
      ...undeliveredInstruction(undeliveredFrom(addresses(), Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      ...claimsInstruction(listClaims(db), addresses()),
    ],
    held.slice(1),
  );
}
// The candidates an unbound session is offered: read at start, and again when
// an unbind leaves it holding nothing.
let unboundCandidates = !WRITES_AS && !held.length ? await candidateNames(db, SUGGESTED) : [];

const mcp = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    // Unbound: the session acts as its ID, with a line on binding a name.
    instructions: [...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []), ...localInstructions(true, startNotes)].join(" "),
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
    for (const a of WRITES_AS ? [WRITES_AS] : held) touchAlias(db, a);
    touchId(db, SESSION_ID);
    return call(name, args, signal);
  };
  // bind and unbind change the address set: no call overlaps either.
  const pending = name === "bind" || name === "unbind" ? gate.bind(run) : gate.call(run);
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
  if (instructionsStale && !out.structuredContent) {
    instructionsStale = false;
    out = { ...out, structuredContent: { name: primary(), instructions: localInstructions(true) } };
  }
  late.answer(requestId, () => {
    if (name === "bind" && r.structuredContent) requeued.push(bindMissed((r.structuredContent as { name: string }).name, "it was cancelled", r.content[0]!.text));
    if (name === "unbind" && r.structuredContent) requeued.push(unbindMissed(String(args.name), "it was cancelled", r.content[0]!.text));
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
  if (name === "unbind") return unbind(a, signal);
  // Local mode has one implicit scope: no principal (#284 S6).
  if (name === "whoami") return text({ id: SESSION_ID, primary: primary(), aliases: held, principal: null, ...(WRITES_AS ? { writes_as: WRITES_AS } : {}) });
  // With no name, the session acts as its ID (#284 S13).
  const IDENTITY = primary();
  // What this session reads mail, claims and uploads as; IDENTITY is the
  // primary it writes as.
  const ADDRS = addresses();
  // What `as` may name (#284 S3): the human's session acts only as its handle.
  const AS_ADDRS = HUMAN ? [IDENTITY] : ADDRS;
  // Only a message's sender and recipient can see it or thread from it.
  const mine = (m: Message | undefined): m is Message => !!m && (ADDRS.includes(m.sender) || ADDRS.includes(m.recipient));

  if (name === "delegate") {
    // Resolve the launcher and build the payload (core), then deliver it as
    // this mode's DM, pending: the promise shows in dm_inbox until the
    // requester settles the thread (#184). Same result fields as dm_send, via
    // the shared builder, so the modes can't drift.
    const live = await liveHandles(ADDRS);
    // A name just released (an unbind, or a 1.x rebind sharing the file) can
    // still answer on its socket: filter it like dm_send does (a released
    // name's socket isn't the session).
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
    const parent = parent_id === undefined ? undefined : getMessage(parent_id);
    // `as` wins; a reply defaults to the held alias its parent reached or was
    // sent as (#284 S4); else the primary.
    const sender = a.as !== undefined ? actingAs(String(a.as), AS_ADDRS, null) : (mine(parent) ? replySender(parent, held) : null) ?? IDENTITY;
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
    if (parent_id !== undefined && !mine(parent)) {
      return {
        ...text(`error: parent_id ${parent_id} is not a message you sent or received`),
        isError: true,
      };
    }
    const files = a.attachments === undefined ? [] : await readAttachmentFiles(a.attachments, ROOTS);
    const { id, attachments } = await withUploads(sender, files, (ids) => insertMessage(sender, SESSION_ID, recipient, body, parent_id ?? null, pending === true, ids, ADDRS));
    // The result names the sender whenever it isn't the primary.
    const p = { ...(sender !== IDENTITY ? { sent_as: sender } : {}), ...(pending ? { pending: true } : {}), ...(attachments.length ? { attachments } : {}) };
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
    const owed = unanswered(ADDRS, receivedUnacked(ADDRS, since), getThread, IDENTITY);
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
      files: { limits: DEFAULT_ATTACHMENT_LIMITS, principal: null },
      human: HUMAN,
      session: SESSION_ID,
      addresses: ADDRS,
    };
    const actor = boardActor(db, name, a, { addresses: ADDRS, asAddresses: AS_ADDRS, ownScope: null });
    const { attachments: paths, as: _as, ...args } = a;
    const files = paths === undefined ? [] : await readAttachmentFiles(paths, ROOTS);
    // Bound in the post's transaction; a refused post releases the uploads.
    const { result, wake } = await withUploads(actor, files, (ids) =>
      db.transaction(() => callBoardTool(db, actor, name, ids.length ? { ...args, attachment_ids: ids } : args, ctx)).immediate(),
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
  const readers = addresses();
  while (!shuttingDown) {
    const first = firstDrain;
    firstDrain = false;
    let any = false;
    for (const reader of readers) {
      const batch = unreadFor(reader);
      if (batch.length > 0) any = true;
      for (const msg of batch) {
        if (shuttingDown) return;
        const params = dmNotification(msg, primary());
        if (isHuman(db, msg.sender)) params.meta.human = "true";
        await mcp.notification({ method: "notifications/claude/channel", params });
        if (sessionEnded) return;
        setCursor(reader, msg.id);
      }
    }
    // A post pending for several addresses (an ID and an alias subscription)
    // is pushed once and marked delivered for each (#361), as the server's
    // drain and board_ack do. A human's session has no tokens to save; a DM
    // is already waking the agent.
    const boardItems = new Map<string, { item: Pending; readers: string[] }>();
    for (const reader of readers) {
      for (const item of pendingFor(db, reader, { all: first || HUMAN || any })) {
        const key = pendingKey(refOf(item));
        const seen = boardItems.get(key);
        if (seen) seen.readers.push(reader);
        else boardItems.set(key, { item, readers: [reader] });
      }
    }
    if (boardItems.size > 0) any = true;
    for (const { item, readers: pendingTo } of boardItems.values()) {
      if (shuttingDown) return;
      const params = boardNotification(item);
      if (item.kind === "push" && isHuman(db, item.post.author)) params.meta.human = "true";
      await mcp.notification({
        method: "notifications/claude/channel",
        params,
      });
      if (sessionEnded) return;
      for (const reader of pendingTo) markDelivered(db, reader, item);
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
// Each held alias's wakeup socket, opened once its hold commits and closed
// before it drops (#284 S7); the ID's is this process's from start to exit.
const listeners = new Map<string, () => void>();
let stopIdListening = () => {};

function listen(alias: string): void {
  if (DELIVER && !listeners.has(alias)) listeners.set(alias, listenForWakeup(alias, onWake));
}

function stopListening(alias: string): void {
  listeners.get(alias)?.();
  listeners.delete(alias);
}

// The name a bind or unbind names: bare, in local mode's one scope.
function bareName(raw: string, verb: "bind" | "unbind"): { ok: true; name: string } | { ok: false; error: string } {
  // A server alias's scope ("eng/x", "you@example.com/x") means nothing here.
  if (raw.includes("/")) return { ok: false, error: `local mode has one scope; ${verb} a bare name, not "${raw}"` };
  return normalizeIdentityName(raw);
}

// bind(name, create?, meta?): take another name (#182, #284 S1). It never
// drops a hold: the new one is acquired (its row, in one transaction), then
// its socket opens. Drains stop for it, so the first drain under the new name
// starts from its own cursor. It runs behind the gate, so no tool call
// overlaps it (#182 audit 11). A name already held only takes its labels.
async function bind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  if (!PUSH) return fail(TOOLS_ONLY_BIND);
  // The human's handle is a declaration, fixed for its bridge's session (#363), as the server's HumanConn.
  if (HUMAN) return fail(`this is the human's session ("${primary()}", BUS_HUMAN=1); it binds nothing`);
  const n = bareName(String(a.name), "bind");
  if (!n.ok) return fail(n.error);
  let meta: AliasMetaSet | undefined;
  try {
    meta = a.meta === undefined ? undefined : parseAliasMeta(a.meta);
  } catch (e) {
    // Audited like the server's refusal of the same bind.
    if (e instanceof CoreError) logBinding(db, SESSION_ID, n.name, "refused", e.message);
    throw e;
  }
  if (held.includes(n.name)) {
    if (meta && !setHeldMeta(db, SESSION_ID, n.name, meta)) throw new Error(`grayboard: session ${SESSION_ID} lost its hold on "${n.name}"`);
    return text(`already bound to "${n.name}"`);
  }
  swapping = true;
  try {
    await inflight;
    const r = await acquireName(db, SESSION_ID, n.name, { create: a.create === true, meta });
    await deliverEnded(db, r.ended);
    if (!r.ok) return fail(r.error);
    // The row holds the new name from here: so does this process, whatever
    // follows fails.
    held.push(n.name);
    writeNames();
    firstDrain = true;
    testPause("bind:after-acquire");
    try {
      listen(n.name);
      touchAlias(db, n.name);
    } catch (e) {
      console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}" but its setup failed:`, e);
      throw new CoreError(`bound "${n.name}", but setting it up failed: ${(e as Error).message}`);
    }
    console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}"; holds "${held.join('", "')}"`);
    const ok = bindOk(n.name, held, (general) => localInstructions(general));
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

// unbind(name): release one hold (#284 S2), in shutdown's order: drains stop
// and the one in flight finishes, the name's socket closes while the row
// still holds it (nobody can take the name with this socket answering), then
// one transaction drops the hold. Its mail and claims stay with the name.
async function unbind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  if (!PUSH) return fail(TOOLS_ONLY_BIND);
  if (HUMAN) return fail(`this is the human's session ("${primary()}", BUS_HUMAN=1); it unbinds nothing`);
  const n = bareName(String(a.name), "unbind");
  if (!n.ok) return fail(n.error);
  if (!held.includes(n.name)) return text(notHolding(n.name));
  swapping = true;
  try {
    await inflight;
    const before = primary();
    stopListening(n.name);
    testPause("unbind:before-txn");
    let released: boolean;
    try {
      released = releaseName(db, SESSION_ID, n.name);
    } catch (e) {
      // The row still holds the name: answer on its socket again, or a
      // retried unbind or bind finds it held and nothing re-listens.
      listen(n.name);
      throw e;
    }
    held = held.filter((h) => h !== n.name);
    writeNames();
    if (!released) return text(notHolding(n.name));
    console.error(`[grayboard] session ${SESSION_ID} released "${n.name}"; ${held.length ? `holds "${held.join('", "')}"` : "unbound"}`);
    if (!held.length) unboundCandidates = await candidateNames(db, SUGGESTED);
    const left = listClaims(db).filter((c) => c.holder === n.name).map((c) => c.key);
    const ok = unbindOk(n.name, before, primary(), left, (general) => localInstructions(general));
    if (signal.aborted) {
      missedBindNotice = unbindMissed(n.name, "it was cancelled", ok.content[0]!.text);
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
for (const h of held) touchAlias(db, h);
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
    for (const h of held) touchAlias(db, h);
  } catch (err) {
    // The bus may already be closed at shutdown; exiting matters more.
    console.error("grayboard shutdown: touching the aliases failed:", err);
  }
  // The sockets go first, while the rows still hold the names, so nobody
  // takes a name with its socket still in place.
  for (const h of [...listeners.keys()]) stopListening(h);
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
  if (RECORDS && !held.length) dropUnboundRecord(RECORD_DIR, process.ppid, SESSION_ID);
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
  for (const h of held) listen(h);
  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}
