// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { activeAnnouncements, checkBody, age, humanHandles, isHuman, lastSeen, markDelivered, pendingFor, rosterHandles, startSession, touchHandle, type UnboundPeer } from "../core/boards.ts";
import { delegateNote, launcherInstruction, resolveDelegation, setLauncher } from "../core/delegation.ts";
import { UNBOUND_ERROR, UNBOUND_TOOLS, bindMissed, bindOk, bindTarget, boundInstructions, heldNote, lastWasRelease, launcherNote, mintSessionId, restoreNote, unboundInstruction, unboundPeer } from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { isQueueBoard } from "../core/boards.ts";
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
  receivedUnacked,
  retractMessage,
  sentPending,
  setCursor,
  undeliveredFrom,
  type Message,
  unreadFor,
  withUploads,
} from "./db.ts";
import { localDbPath } from "./open.ts";
import { listenForWakeup, poke } from "./wakeup.ts";
import { sockDir } from "../shared/sockdir.ts";
import { acquireName, candidateNames, endSession, liveSessions, registerSession, siblingGone, thisSession } from "./binding.ts";
import { dropUnboundRecord, freshRecord, sweepRecords, writeRecord } from "../shared/namerecord.ts";
import { launcherName } from "../shared/proc.ts";
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
  showPending,
  unanswered,
  undeliveredInstruction,
} from "../shared/inbox.ts";
import pkg from "../../package.json" with { type: "json" };

// This process, for run metadata and binding history (#182). Not an address.
const SESSION_ID = mintSessionId();
// Directories this session may attach files from and save them to.
const ROOTS = attachRoots();
// This bus's subdirectory of the default save directory.
const BUS_DIR = localBusDir(localDbPath());
const RETENTION_DAYS = retentionDays();
if (RETENTION_DAYS === null) {
  console.error(`[grayboard] BUS_RETENTION_DAYS must be a whole number of days, not "${process.env.BUS_RETENTION_DAYS}"`);
  process.exit(1);
}

// BUS_PUSH=off: tools only, for a harness that drops MCP notifications and
// has no adapter. Draining here would consume messages into a void.
const PUSH = process.env.BUS_PUSH !== "off";
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
// The name came back from the name record: the same harness session, so its
// peer status stays.
let restored = false;
// The name record (#182 decision 14), written by the session that owns
// delivery whenever its name changes. The Slack bridge's child keeps none:
// its name is fixed, and a restart that can't have it must fail loudly.
const RECORD_DIR = sockDir();
const RECORDS = PUSH && !HUMAN;
// A failed write costs only the restore after a restart; the bind itself stands.
const writeName = (name: string | null) => {
  if (!RECORDS) return;
  try {
    writeRecord(RECORD_DIR, { name, session_id: SESSION_ID, harness_pid: process.ppid, bus: localDbPath() });
  } catch (e) {
    console.error(`[grayboard] name record for harness pid ${process.ppid} not written:`, e);
  }
};
if (!PUSH) bound = SUGGESTED;
else {
  // The session that owns delivery owns the name: it writes the bindings row,
  // its presence while unbound, and acquires through it. Channels-off
  // sessions too: they own the session, they just don't listen.
  registerSession(db, thisSession(SESSION_ID));
  if (RECORDS) sweepRecords(RECORD_DIR);
  // A restart under the same harness takes back its predecessor's name, ahead
  // of BUS_IDENTITY: it's the same session, mid-task.
  const rec = RECORDS ? freshRecord(RECORD_DIR, process.ppid, localDbPath()) : null;
  if (rec?.name) {
    const n = normalizeIdentityName(rec.name);
    // The process it replaces may not have exited yet.
    if (n.ok) await siblingGone(db, n.name, process.ppid);
    const r = n.ok
      ? await acquireName(db, SESSION_ID, n.name, { create: false, previous: null, detail: `restored: restart of session ${rec.session_id}` })
      : { ok: false as const, error: n.error };
    if (r.ok) {
      bound = r.name;
      restored = true;
    } else unboundNotes.push(restoreNote(rec.name, r.error));
  } else if (EXPLICIT) {
    const r = await acquireName(db, SESSION_ID, SUGGESTED!, { create: true, previous: null, allowHuman: HUMAN });
    if (r.ok) bound = r.name;
    else if (HUMAN) {
      // A bridge has no agent to read a candidate list; refuse loudly.
      console.error(`[grayboard] ${r.error}`);
      endSession(db, SESSION_ID);
      process.exit(1);
    } else unboundNotes.push(heldNote(SUGGESTED!, r.holder ?? r.error));
  }
  if (!bound) {
    const launcher = launcherName(process.ppid);
    if (launcher) unboundNotes.push(launcherNote(launcher));
  }
  writeName(bound);
}
console.error(`[grayboard] local mode, session ${SESSION_ID}, ${bound ? `identity "${bound}"` : "unbound"}`);

// What a session bound to `name` is told (core's boundInstructions), with
// local mode's human and announcement sentences, and its claims last: the
// longest, and the one to lose if the client cuts the text.
function localBoundInstructions(name: string, general: boolean): string[] {
  return boundInstructions(
    name,
    general,
    () => [
      ...(LAUNCHER ? launcherInstruction() : []),
      ...humanInstruction(humanHandles(db).filter((h) => h !== name)),
      ...(HUMAN ? [] : announcementsInstruction(activeAnnouncements(db))),
    ],
    [
      ...undeliveredInstruction(undeliveredFrom(name, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      ...claimsInstruction(listClaims(db), name),
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
    // Unbound: one sentence and the candidates. The rest only matters once
    // a name receives anything, so bind's result carries it.
    instructions: [
      ...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []),
      ...(bound ? localBoundInstructions(bound, true) : [unboundInstruction(await candidateNames(db, SUGGESTED), unboundNotes)]),
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
mcp.setRequestHandler(CallToolRequestSchema, async (req, { signal, requestId }) => {
  const { name, arguments: args = {} } = req.params;
  const run = async () => {
    // An unbound session writes no handles row: it would join dm_send's roster.
    if (bound) touchHandle(db, bound);
    return call(name, args, signal);
  };
  const r: { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown } =
    await (name === "bind" ? gate.bind(run) : gate.call(run));
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
  if (!bound && !UNBOUND_TOOLS.has(name)) return { ...text(`error: ${UNBOUND_ERROR}`), isError: true };
  // Unbound reads go as this session's viewer handle: "~" handles are never
  // identities and own no subscriptions, so a read advances no cursor.
  const IDENTITY = bound ?? `~${SESSION_ID}`;
  // Only a message's sender and recipient can see it or thread from it.
  const mine = (m: Message | undefined): m is Message => !!m && (m.sender === IDENTITY || m.recipient === IDENTITY);

  if (name === "delegate") {
    // Resolve the launcher and build the payload (core), then deliver it as
    // this mode's DM, pending: the promise shows in dm_inbox until the
    // launcher reports the result in this thread (#184).
    const online = await liveHandles(IDENTITY);
    let d;
    try {
      d = resolveDelegation(db, IDENTITY, a, online);
    } catch (e) {
      if (e instanceof CoreError) return { ...text(`error: ${e.message}`), isError: true };
      throw e;
    }
    const { id } = await insertMessage(IDENTITY, d.to, d.body, null, true, []);
    const delivered = (await poke(d.to)) && !lastWasRelease(db, d.to);
    return text(JSON.stringify({
      message_id: id,
      delivered_now: delivered,
      to: d.to,
      ...(d.humanFallback ? { human_fallback: true as const } : {}),
      note: delegateNote(Date.now()),
    }));
  }

  if (name === "dm_send") {
    const { to: recipient, body, parent_id, pending } = a as {
      to: string;
      body: string;
      parent_id?: number;
      pending?: boolean;
    };
    checkBody(body);
    if (!rosterHandles(db).includes(recipient)) {
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
    const { id, attachments } = await withUploads(IDENTITY, files, (ids) => insertMessage(IDENTITY, recipient, body, parent_id ?? null, pending === true, ids));
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
      undelivered_from_you: undeliveredFrom(IDENTITY).find((u) => u.recipient === recipient)?.n ?? 1,
    }));
  }

  if (name === "dm_history") {
    return text(getHistory(IDENTITY, a.peer as string | undefined, historyLimit(a.limit), a.before_id as number | undefined).map(showPending));
  }

  if (name === "dm_thread") {
    if (!mine(getMessage(a.thread as number))) {
      return { ...text(`error: message ${a.thread} not found`), isError: true };
    }
    return text(getThread(a.thread as number).filter(mine).map(showPending));
  }

  if (name === "dm_inbox") {
    const since = Date.now() - inboxDays(a.days) * 86_400_000;
    const owed = unanswered(IDENTITY, receivedUnacked(IDENTITY, since), getThread);
    const promises = promised(IDENTITY, sentPending(IDENTITY, Date.now() - PROMISE_DAYS * 86_400_000), getThread);
    const queued = undeliveredFrom(IDENTITY).map((u) => {
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
      if (m && (m.recipient === IDENTITY || (m.sender === IDENTITY && m.pending))) { ackMessage(IDENTITY, id); acked.push(id); } else missing.push(id);
    }
    const r = ackResult(acked, missing);
    return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
  }

  if (name === "dm_retract") {
    const m = getMessage(a.message_id as number);
    const refuse = (why: string) => ({ ...text(`error: ${why}`), isError: true });
    if (!m || m.sender !== IDENTITY) return refuse(retractRefusal.notYours(a.message_id as number));
    // A probe is a wakeup: a live recipient drains the message now.
    if (getCursor(m.recipient) >= m.id || (await poke(m.recipient))) return refuse(retractRefusal.reached(m.id, m.recipient));
    if (!retractMessage(IDENTITY, m.id)) {
      return refuse(getCursor(m.recipient) >= m.id ? retractRefusal.reached(m.id, m.recipient) : retractRefusal.replied(m.id));
    }
    await sweepBlobs(db, blobs);
    return text("ok");
  }

  if (name === "attachment_get") {
    const id = checkAttachmentId(a.id);
    const target = await saveTarget(a.dir, ROOTS, BUS_DIR);
    const row = getAttachment(db, id);
    if (!row || !canReadAttachment(db, IDENTITY, row, (m) => mine(getMessage(m)))) {
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
      ...(name === "peer_list" || (name === "board_post" && (HUMAN || queuePost)) ? { online: await liveHandles(IDENTITY) } : {}),
      ...(name === "peer_list" ? { unbound: unboundPeers() } : {}),
      attachmentLimits: DEFAULT_ATTACHMENT_LIMITS,
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

// Which handles have a live session, by probing each wakeup socket. A probe is
// also a wakeup, so each live peer runs a drain; that's harmless (idempotent).
async function liveHandles(self: string): Promise<(h: string) => boolean> {
  const others = rosterHandles(db).filter((h) => h !== self);
  const alive = await Promise.all(others.map((h) => poke(h)));
  const live = new Set(others.filter((_, i) => alive[i]));
  return (h) => live.has(h);
}

// Live sessions with no name yet, for peer_list.
function unboundPeers(): UnboundPeer[] {
  return liveSessions(db)
    .filter((r) => r.name === null)
    .map((r) => unboundPeer(r.session_id, r.cwd ? describeLocation(r.cwd) : null, r.session_id === SESSION_ID));
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
  if (swapping) return Promise.resolve();
  inflight ??= drainLoop().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function drainLoop(): Promise<void> {
  await initialized;
  // Read once: a cursor written under one name must never get another's ids.
  const name = bound;
  if (!name) return;
  while (true) {
    const batch = unreadFor(name);
    // A human's session has no tokens to save; a DM is already waking the agent.
    const boardItems = pendingFor(db, name, { all: firstDrain || HUMAN || batch.length > 0 });
    firstDrain = false;
    if (batch.length === 0 && boardItems.length === 0) break;
    for (const msg of batch) {
      const params = dmNotification(msg);
      if (isHuman(db, msg.sender)) params.meta.human = "true";
      await mcp.notification({ method: "notifications/claude/channel", params });
      setCursor(name, msg.id);
    }
    for (const item of boardItems) {
      const params = boardNotification(item);
      if (item.kind === "push" && isHuman(db, item.post.author)) params.meta.human = "true";
      await mcp.notification({
        method: "notifications/claude/channel",
        params,
      });
      markDelivered(db, name, item);
    }
  }
}

const onWake = () => {
  // A wakeup may follow another session's claim_take.
  expiry.arm();
  drainToClaude().catch((err) => {
    console.error("grayboard drain error:", err);
  });
};
let stopListening = () => {};

// bind(name, create?): take a name, or move to another (#182). The new name
// is acquired first (its row, in one transaction, with this session's claims
// moved to it); only then does the old name's socket close. Drains stop for
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
      if (previous) touchHandle(db, previous);
      startSession(db, n.name, process.cwd());
      setLauncher(db, n.name, LAUNCHER);
    } catch (e) {
      const moved = r.moved.length ? `; claims moved: ${r.moved.map((c) => c.key).join(", ")}` : "";
      console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}" but its setup failed:`, e);
      throw new CoreError(`bound "${n.name}"${previous ? ` (was "${previous}")` : ""}${moved}, but setting it up failed: ${(e as Error).message}`);
    }
    console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}"${previous ? ` (was "${previous}")` : ""}`);
    const ok = bindOk(n.name, previous, r.moved.map((c) => c.key), (general) => localBoundInstructions(n.name, general));
    // A cancelled call's result is dropped (pi and opencode cancel on abort).
    if (signal.aborted) {
      missedBindNotice = bindMissed(n.name, "it was cancelled", ok.content[0]!.text);
      instructionsStale = true;
    }
    return ok;
  } finally {
    swapping = false;
    if (DELIVER && bound) onWake();
  }
}


// Startup: the name (if any) is already acquired. Connect MCP so
// notifications are accepted, listen on the name's wakeup socket, and replay
// what arrived while offline.
// A tools-only server runs beside the session that owns the identity, and a
// restored name is the same session restarted: leave their status alone.
if (bound && PUSH && !restored) startSession(db, bound, process.cwd());
else if (bound) touchHandle(db, bound);
if (bound) setLauncher(db, bound, LAUNCHER);
const transport = new StdioServerTransport();
await mcp.connect(transport);
late.watch(transport);
// Prunes the bus at most once a day across the sessions that share it.
startLocalRetention(db, blobs, RETENTION_DAYS);

const shutdown = () => {
  try {
    if (bound) touchHandle(db, bound);
  } catch {
    // The bus may already be closed at shutdown; exiting matters more.
  }
  // The socket goes first, while the row still holds the name, so nobody
  // takes the name with this socket still in place.
  stopListening();
  try {
    if (PUSH) endSession(db, SESSION_ID);
  } catch {
    // Same: shutdown must not throw.
  }
  if (RECORDS && !bound) dropUnboundRecord(RECORD_DIR, process.ppid, SESSION_ID);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Exit when the client goes away. Otherwise the wakeup listener keeps an
// orphan alive that holds the identity and blocks the next session.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

if (DELIVER && bound) {
  stopListening = listenForWakeup(bound, onWake);
  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}
