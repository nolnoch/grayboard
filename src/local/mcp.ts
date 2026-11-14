// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { IdCollision, parseAliasMeta, type AliasMetaSet, activeAnnouncements, checkBody, age, ensureAlias, humanHandles, inheritStatus, isHuman, lastSeen, liveAddresses, markDelivered, pendingFor, pendingKey, refOf, rosterHandles, touchAlias, touchId, type UnboundPeer } from "../core/boards.ts";
import { boardNotification, dmNotification, type Pending } from "../shared/notifications.ts";
import { delegateOkFields, launcherInstruction, launchers, resolveDelegation } from "../core/delegation.ts";
import { writeCoreAudit } from "../core/audit.ts";
import { MAX_HOLDS, TOOLS_ONLY_BIND, actingAs, bindMissed, boardActor, childStateRefusal, holdsOf, logBinding, replyPeer, replyPeerError, replySender, runnerChildInstructions, unbindMissed, envSessionKey, bindOk, boundInstructions, heldNote, idAddress, lastWasRelease, launcherNote, notHolding, primaryOf, unbindOk, unboundInstruction, mintSessionKey, restoreNote, unboundPeer, unverifiedRestoreNote } from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { isQueueBoard } from "../core/boards.ts";
import { addressParts } from "../core/addresses.ts";
import { retentionDays, startLocalRetention } from "./retention.ts";
import { canReadAttachment, getAttachment, sweepBlobs } from "../core/attachments.ts";
import {
  announcementsInstruction,
  claimsInstruction,
  humanInstruction,
  callBoardTool,
  isBoardTool,
  DEFAULT_CHANNEL_SOURCE,
} from "../core/tools.ts";
import {
  ackMessage,
  blobs,
  db,
  deliveredTo,
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
  undeliveredFrom,
  type Message,
  unreadFor,
  withUploads,
} from "./db.ts";
import { localDbPath } from "./open.ts";
import { deliverEnded, listenForWakeup, poke } from "./wakeup.ts";
import { sockDir } from "../shared/sockdir.ts";
import { ChildSessions, acquireName, attachSession, candidateNames, childFallback, conversationSnapshot, detachSession, endLocalSession, keyedHarness, liveSessions, nothingEnded, registerChild, registerSession, releaseName, runnerRoot, runnerRootLive, setHeldMeta, SIBLING_WAIT_MS, siblingGone, thisSession, type Ended, type Leave, type SessionKind } from "./binding.ts";
import { GRAYBOARD_AGENT_META, validSourceId } from "../shared/session_meta.ts";
import { MISSING_TEXT, TOOL_USE_META, readCurrent, takeRecord, type MissingCause } from "../shared/claude_agents.ts";
import { listenIdentity, type IdentityRequest } from "../shared/claude_identity.ts";
import { z } from "zod";
import { hooksDisabledBy, recordHookInstalled } from "../shared/claude_settings.ts";
import { dropUnboundRecord, freshRecord, sweepRecords, writeRecord } from "../shared/namerecord.ts";
import { isAlive, launcherName, procStart } from "../shared/proc.ts";
import { LOCAL_TOOLS } from "./tools.ts";
import { describeLocation, isExplicitIdentity, sessionIdentity } from "../shared/identity.ts";
import { LateCancels } from "../shared/latecancel.ts";
import { testPause, testPauseAsync } from "../shared/testpause.ts";
import { BindGate } from "../shared/bindgate.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { DEFAULT_ATTACHMENT_LIMITS, attachRoots, checkAttachmentId, localBusDir, readAttachmentFiles, saveAttachment, saveTarget } from "../shared/attachments.ts";
import { channelsOff, channelsOffNotice, checkArgs, parentCommandLine, signedInLocalNotice, updateNotice } from "../shared/toolguard.ts";
import { busMode, loadCredentials } from "../cli/api.ts";
import { launch } from "./launch.ts";
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
  withNotices,
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
// This process's session key, BUS_SESSION_KEY or one minted here and kept:
// its child sessions' IDs derive from it (#523). Its session ID (#284). A
// runner child that becomes its own session (#523 step 5) mints both anew:
// its child ID stays a child's.
let SESSION_KEY = KEY ?? mintSessionKey();
let SESSION_ID = idAddress(SESSION_KEY);
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
// BUS_MODEL, BUS_EFFORT: what this session's harness runs on, shown on its
// peer_list rows (#284 S12). Self-reported, read once, ended with the session.
const MODEL = process.env.BUS_MODEL || undefined;
const EFFORT = process.env.BUS_EFFORT || undefined;
// BUS_HARNESS_SESSION: the harness's own id for the session this process
// serves (pi's getSessionId()), recorded as ids.harness_session.
// BUS_PARENT_SESSION: that id of the session whose subagent process this is
// (pi-subagents' detached runner, #523 step 5): while that session lives and
// its harness is among this process's ancestors, this process is its child.
// Harness-asserted, like a child's `_meta`: a child acts only under its
// root's addresses. The pi adapter sets both.
const harnessId = (key: string): string | undefined => {
  const v = process.env[key] || undefined;
  if (v !== undefined && !validSourceId(v)) {
    console.error(`[grayboard] ${key} must be 1 to 1024 characters with no control characters`);
    process.exit(1);
  }
  return v;
};
let HARNESS_SESSION = harnessId("BUS_HARNESS_SESSION") ?? (process.env.CLAUDECODE === "1" ? harnessId("CLAUDE_CODE_SESSION_ID") : undefined);
const PARENT_SESSION = harnessId("BUS_PARENT_SESSION");
// A runner child stands in for a session that would own its delivery, so
// it falls back to (or is promoted to) one.
if (PARENT_SESSION !== undefined && (!PUSH || HUMAN || KEYED)) {
  console.error("[grayboard] BUS_PARENT_SESSION makes this process a subagent of the session that recorded it, in place of a session that owns its delivery; it can't be combined with BUS_PUSH=off, BUS_HUMAN=1 or BUS_SESSION_KEY");
  process.exit(1);
}
// A launcher must be able to RECEIVE delegation requests: a tools-only
// session (BUS_PUSH=off) isn't one, whatever its env says — it doesn't hold
// the name, has no socket, and never touches the launcher flag (a sidecar
// must not overwrite the owner's opt-in). Nor is a runner (BUS_PARENT_SESSION),
// child or its own session: its BUS_LAUNCHER is its launching session's,
// inherited with its env, and pi-subagents doesn't load in a runner, so it
// can't spawn the subagent a request asks for.
const EFFECTIVE_LAUNCHER = LAUNCHER && PUSH && PARENT_SESSION === undefined;
// What this process registers its own root session as: at start, or when a
// runner child becomes its own session.
const ROOT_KIND: SessionKind = { launcher: EFFECTIVE_LAUNCHER, model: MODEL, effort: EFFORT, ...(HARNESS_SESSION ? { harnessSession: HARNESS_SESSION } : {}) };
// A session binds a name at start only when told which (#182): an explicit
// BUS_IDENTITY (not a harness re-delivering the repo's pin), or the bridge's
// child, whose BUS_IDENTITY is the human handle wherever it runs. Otherwise
// the resolved name is only the first suggestion, and the session starts
// unbound: binding delivers the name's queued DMs and hands it the name's
// claims, which should follow the agent knowing its task. A runner's
// BUS_IDENTITY is its launching session's, inherited with its env: only a
// suggestion, whether it is a child or its own session.
const EXPLICIT = HUMAN || (PARENT_SESSION === undefined && isExplicitIdentity());
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
// A Claude Code session that won't show channel messages drops pushes silently; say so and why.
const CHANNELS_OFF_REASON = PUSH ? channelsOff(process.env, parentCommandLine()) : null;
const CHANNELS_OFF = CHANNELS_OFF_REASON !== null;
const CHANNELS_OFF_NOTICE = CHANNELS_OFF_REASON === null ? null : channelsOffNotice(CHANNELS_OFF_REASON);
if (CHANNELS_OFF) console.error(`[grayboard] Claude Code channels are off (${CHANNELS_OFF_REASON}): tools only`);
// Notifications such a session drops would still count as delivered, so it
// runs tools-only, as BUS_PUSH=off does, and what's pending waits (#71).
const DELIVER = PUSH && !CHANNELS_OFF;
const ORDINARY = DELIVER && !HUMAN && !KEYED && PARENT_SESSION === undefined;
ROOT_KIND.localResume = ORDINARY;
const ADAPTER_OWNER = ORDINARY ? harnessId("BUS_ADAPTER_OWNER") : undefined;
let adapterEpoch = 0;
// Fence readiness as soon as selection arrives, before BindGate can drain
// outgoing work; adapterEpoch advances only after that selection completes.
let adapterSelectedEpoch = 0;
let adapterPaused = ADAPTER_OWNER !== undefined;

// The live root this process is a runner child of (#523 step 5), while it
// is one; null for a root. A runner child acts under its root's addresses,
// as the root's in-process children do, but from a process of its own: no
// wakeup listener, drain, name record or bindings row of its own (its row is
// a copy of its root's liveness, registerChild). A bind promotes it to its
// own session (bind); its root ending makes it one (rootGone).
let liveParent: string | null = null;
// Why a BUS_PARENT_SESSION process started as its own session: no live root,
// or its root refused it as a child.
let ownWhy: string | null = null;
if (PARENT_SESSION !== undefined) {
  const found = runnerRoot(db, PARENT_SESSION);
  if ("why" in found) ownWhy = found.why;
  else {
    const self = thisSession(SESSION_ID);
    testPause("runner:before-register");
    try {
      registerChild(db, found.root, SESSION_ID, HARNESS_SESSION ?? null, Date.now(), {
        harness: self.harness, cwd: self.cwd, harnessSession: HARNESS_SESSION, detail: { parent_session: PARENT_SESSION },
      });
      liveParent = found.root;
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      // Refused (its root ended since the lookup, or has its fill of
      // children): it runs as its own session, as with no live parent, rather
      // than lose grayboard for its whole life over a reason only stderr sees.
      ownWhy = e.message;
    }
  }
}
// Claude Code subagents (#551): Claude Code tells this server only a call's
// tool_use_id, and grayboard's PreToolUse hook records which agent made it.
// Read once at start: whether that hook is in user settings, and the harness
// the records are kept under (the pid bindings hold; its start time catches a
// recycled pid). Without the hook (settings from before it), calls act as the
// root, audited once and said in the instructions and whoami.
const UNDER_CLAUDE = process.env.CLAUDECODE === "1";
const CLAUDE_HARNESS = UNDER_CLAUDE && recordHookInstalled()
  ? { pid: HARNESS?.pid ?? process.ppid, start: HARNESS ? HARNESS.proc_start : procStart(process.ppid) ?? null }
  : null;
// CLAUDECODE is inherited by harnesses Claude launches; an adapter's own ID
// and owner must never wait for Claude hooks under that harness's PID.
const CLAUDE_CURRENT = CLAUDE_HARNESS !== null && ORDINARY && ADAPTER_OWNER === undefined && process.env.BUS_HARNESS_SESSION === undefined;
const ATTRIBUTION_OFF = UNDER_CLAUDE && CLAUDE_HARNESS === null;
const ATTRIBUTION_OFF_NOTE = "Claude Code subagent attribution is off: grayboard's hooks aren't in Claude Code's user settings, so subagents' calls act as this session. Run `grayboard update` (or `grayboard setup`) and restart Claude Code.";
let attributionOffAudited = false;
if (CLAUDE_CURRENT) {
  const current = readCurrent(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start);
  if (current) HARNESS_SESSION = current.session;
  ROOT_KIND.harnessSession = HARNESS_SESSION;
}

// The names this session holds, oldest first (#284 S1): the first is its
// primary, which it sends as. bind() and unbind() change it, only between
// drains. A tools-only process holds nothing and writes as WRITES_AS. A
// runner child holds nothing either.
let held: string[] = [];
const WRITES_AS = PUSH ? null : SUGGESTED;
// The session whose addresses this process acts under, and its holds: this
// one, or a runner child's root, whose holds are re-read on every call.
const rootId = (): string => liveParent ?? SESSION_ID;
const holds = (): string[] => (liveParent === null ? held : holdsOf(db, liveParent));
// The address this session writes as by default, and every address it reads
// mail, claims and uploads as (#284 S1): its holds and its ID. A tools-only
// process receives nothing, so its ID isn't one of its addresses.
const primary = (): string => WRITES_AS ?? primaryOf(holds(), rootId());
const addresses = (): string[] => (WRITES_AS ? [WRITES_AS] : [...holds(), rootId()]);
// The first successful write of a session acting as its ID says how to get a
// readable name, once per session (#470). A root's notice: never a child's (#523).
let bindHinted = false;
// A recipient as the server reads one (#272): a session ID, or a handle
// matched without regard to case. Handles are lowercase since #181; a
// database from before then may hold a mixed-case one, so the exact input
// is tried first.
function localRecipient(to: string): string {
  const parsed = addressParts(to);
  if (parsed?.kind === "id") return parsed.address;
  if (parsed?.kind !== "bare" || rosterHandles(db).includes(to)) return to;
  return parsed.address;
}

function bindHint(child: string | undefined): { bind_hint?: string } {
  if (child !== undefined || bindHinted || WRITES_AS || held.length) return {};
  bindHinted = true;
  return { bind_hint: `You act as ${primary()}; bind(name) gives peers a readable name.` };
}
// Notes on how this session started: why it has no name, or a name its
// restart couldn't take back. For its instructions.
const startNotes: string[] = [];
let claudeGuidancePending = false;
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

async function restoreNames(rec: { names: string[]; session_id: string }, sibling = false): Promise<void> {
  const missed = rec.names.slice(MAX_HOLDS).map(name => ({ name, why: `a session holds at most ${MAX_HOLDS} names` }));
  const deadline = Date.now() + SIBLING_WAIT_MS;
  for (const name of rec.names.slice(0, MAX_HOLDS)) {
    const n = normalizeIdentityName(name);
    if (sibling && n.ok) await siblingGone(db, n.name, process.ppid, Math.max(0, deadline - Date.now()));
    const r = n.ok
      ? await acquireName(db, SESSION_ID, n.name, { create: false, restartOf: rec.session_id })
      : { ok: false as const, error: n.error, ended: nothingEnded() };
    await deliverEnded(db, r.ended);
    if (!r.ok) { missed.push({ name, why: r.error }); continue; }
    held.push(r.name);
    if (r.restored && !restored) { restored = true; restoredFrom = rec.session_id; }
  }
  for (const m of missed) startNotes.push(restoreNote(m.name, m.why, held.length > 0));
  // Unverified: the name stays, the status doesn't; say so only when there was one to lose (#260).
  if (held.length && !restored && (db.prepare(`SELECT status FROM ids WHERE id = ?`).get(rec.session_id) as { status: string | null } | null)?.status) {
    startNotes.push(unverifiedRestoreNote(held));
  }
}
if (WRITES_AS) {
  ensureAlias(db, WRITES_AS, WRITES_AS);
  // Its liveness is its own process, keyed or not: it ends on exit, and a
  // key shared with a live session collides rather than attaching.
  try {
    registerSession(db, thisSession(SESSION_ID), { writesAs: WRITES_AS, keyed: KEYED, model: MODEL, effort: EFFORT, ...(HARNESS_SESSION ? { harnessSession: HARNESS_SESSION } : {}) });
  } catch (e) {
    if (!(e instanceof IdCollision)) throw e;
    writeCoreAudit(db, "id.collision", e.id, e.id, { why: e.why, delivery: "none", ended_at: e.endedAt, pid: process.pid });
    console.error(`[grayboard] ${e.message}`);
    process.exit(1);
  }
} else if (liveParent === null) {
  // The session that owns delivery owns the name: it writes the session's
  // rows, its presence while unbound, and acquires through them.
  // Channels-off sessions too: they own the session, they just don't listen.
  const self = thisSession(SESSION_ID, HARNESS);
  // A keyed session restarting under its live harness: the open above ended
  // it first if the harness had died, so attaching is refused then.
  let attached = false;
  try {
    registerSession(db, self, ROOT_KIND);
    // The flag is the session's (ids.launcher), so it's audited once, here.
    writeCoreAudit(db, "handle.launcher_set", SESSION_ID, SESSION_ID, { on: EFFECTIVE_LAUNCHER });
  } catch (e) {
    if (!(e instanceof IdCollision)) throw e;
    if (KEYED && e.endedAt === null) {
      const r = await attachSession(db, self, HUMAN, { model: MODEL ?? null, effort: EFFORT ?? null });
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
  if (ownWhy !== null) {
    // A runner with no live parent, or one that refused it as a child, runs
    // as its own session, logged once (hosted's rule for a subagent with no
    // parent session).
    console.error(`[grayboard] BUS_PARENT_SESSION ${PARENT_SESSION}: ${ownWhy}; this process runs as its own session`);
    writeCoreAudit(db, "id.child_fallback", SESSION_ID, SESSION_ID, { parent_session: PARENT_SESSION, why: ownWhy, pid: process.pid });
  }
  if (RECORDS) sweepRecords(RECORD_DIR);
  // Existence controls precedence: an empty selected snapshot is an explicit
  // unbind, never an invitation to take PID carry or configured identity.
  const snapshot = ORDINARY && HARNESS_SESSION ? conversationSnapshot(db, HARNESS_SESSION) : null;
  claudeGuidancePending = CLAUDE_CURRENT && snapshot !== null;
  const rec = snapshot ?? (RECORDS ? freshRecord(RECORD_DIR, process.ppid, localDbPath()) : null);
  if (snapshot !== null || rec?.names.length) {
    await restoreNames(rec!, snapshot === null);
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
// A machine signed in to a server (#491): a bare `grayboard mcp` entry is
// most likely a pre-plugin one that meant the server before #282, so its
// session is told, in every render, that the team isn't on this bus; an entry
// that passes `--mode local` chose it and is only audited.
const SIGNED_IN = busMode() === "server";
// Only the URL's origin is repeated (instructions, stderr, audit): a sign-in
// URL may carry credentials or a path the model has no use for.
const serverOrigin = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};
const SIGNED_IN_SERVER = SIGNED_IN ? serverOrigin(process.env.GRAYBOARD_SERVER) ?? serverOrigin(loadCredentials()?.server) : null;
const SIGNED_IN_NOTICE = SIGNED_IN && !launch.modePinned ? signedInLocalNotice(SIGNED_IN_SERVER) : null;
if (SIGNED_IN) writeCoreAudit(db, "id.signed_in_local", SESSION_ID, SESSION_ID, { server: SIGNED_IN_SERVER, mode_pinned: launch.modePinned });
if (SIGNED_IN_NOTICE) console.error(`[grayboard] this machine is signed in to ${SIGNED_IN_SERVER ?? "a grayboard server"}, but this entry runs the local bus. Run \`grayboard setup\` to use the server, \`grayboard setup --local\` if this machine should be local, or pass \`--mode local\` to keep this entry local on purpose.`);
console.error(`[grayboard] local mode, session ${SESSION_ID}, ${liveParent !== null ? `a subagent of ${liveParent} (BUS_PARENT_SESSION ${PARENT_SESSION})` : held.length ? `identity "${held.join('", "')}"` : WRITES_AS ? `writing as "${WRITES_AS}"` : "unbound"}`);

// What the session is told as it is now (core's boundInstructions): as its
// primary, with local mode's human and announcement sentences, and its claims
// last: the longest, and the one to lose if the client cuts the text. An
// unbound session's variable part opens with its line about binding a name;
// `notes` are why it started as it did.
function localInstructions(general: boolean, notes: string[] = []): string[] {
  const name = primary();
  const modeGeneral = () => [
    ...(EFFECTIVE_LAUNCHER ? launcherInstruction() : []),
    ...humanInstruction(humanHandles(db).filter((h) => h !== name)),
    ...(HUMAN ? [] : announcementsInstruction(activeAnnouncements(db))),
  ];
  const signedIn = general && SIGNED_IN_NOTICE ? [SIGNED_IN_NOTICE] : [];
  // A runner child is told what it is: a subagent writing as its root, pushed nothing.
  if (liveParent !== null) return [...signedIn, ...runnerChildInstructions(SESSION_ID, liveParent, name, modeGeneral())];
  const lead = !WRITES_AS && !held.length ? [unboundInstruction(SESSION_ID, unboundCandidates, notes)] : notes;
  // First in every general render (initialize, and bind and unbind's structured
  // instructions, which the adapters rebuild their prompt from); a result's
  // text, the non-general render, doesn't repeat it.
  return [...signedIn, ...boundInstructions(
    name,
    DEFAULT_CHANNEL_SOURCE,
    general,
    modeGeneral,
    [
      ...lead,
      ...undeliveredInstruction(undeliveredFrom(addresses(), Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      ...claimsInstruction(listClaims(db), addresses()),
    ],
    held.slice(1),
  )];
}
// The candidates an unbound session is offered: read at start, and again when
// an unbind leaves it holding nothing.
let unboundCandidates = !WRITES_AS && liveParent === null && !held.length ? await candidateNames(db, SUGGESTED) : [];

const mcp = new Server(
  { name: DEFAULT_CHANNEL_SOURCE, version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    // Unbound: the session acts as its ID, with a line on binding a name.
    instructions: [...(CHANNELS_OFF_NOTICE ? [CHANNELS_OFF_NOTICE] : []), ...(ATTRIBUTION_OFF ? [ATTRIBUTION_OFF_NOTE] : []), ...localInstructions(true, startNotes)].join(" "),
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
// A write the client cancelled whose result says it landed (#292): the agent
// never saw that, and might send it again.
const LANDING_WRITES = new Set(["dm_send", "board_post", "delegate"]);
const landed = (name: string, r: { isError?: boolean; content: { text: string }[] }): string | null =>
  !r.isError && LANDING_WRITES.has(name) ? `${name} completed after it was cancelled; it landed, so don't repeat it. ${r.content[0]?.text ?? ""}` : null;
const notices = (): string[] => {
  const out = requeued.splice(0);
  if (channelsNoticePending && CHANNELS_OFF_NOTICE) out.push(CHANNELS_OFF_NOTICE);
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
// A Claude Code call with no usable subagent record (#551 §3): refused and
// audited, never run as the root; the cause names a settings layer that turns
// hooks off when one does.
function recordMissing(tool: string, toolUseId: unknown, cause: MissingCause) {
  const layer = hooksDisabledBy(process.cwd());
  writeCoreAudit(db, "claude.agent_record_missing", SESSION_ID, null, { tool_use_id: String(toolUseId).slice(0, 128), tool, cause, ...(layer ? { layer } : {}) });
  const why = layer ? `${MISSING_TEXT[cause]}; ${layer}` : MISSING_TEXT[cause];
  return { ...text(`error: grayboard can't tell which Claude Code agent made this call (${why}), so it didn't run. Rerun \`grayboard setup\` and restart Claude Code.`), isError: true };
}
// The child sessions this process has seen within the idle window (#523),
// under its root: a runner child's subagents are its root's children, as
// hosted resolves a nested subagent to its root, so a child's root is always
// a root. Their IDs are minted over this process's key, which only it holds.
// A runner child's becoming its own session starts anew (becomeRoot).
let children = new ChildSessions(db, rootId(), SESSION_KEY);

let resumeBarrier: PromiseWithResolvers<void> | null = ADAPTER_OWNER ? Promise.withResolvers<void>() : null;
let claudePaused = false;
// Pinned Claude registers channels after tools/list, not at initialized.
// A ping acknowledged after its list response is the measured activation seam.
const claudeReady = CLAUDE_CURRENT && DELIVER ? Promise.withResolvers<boolean>() : null;
let claudeActivationStarted = false;
let claudeActivationError = "";
let claudePublication: string | null = null;
let connected = false;
let deliveryStarted = false;
const receipts = new Map<string, PromiseWithResolvers<boolean>>();
function pauseRoot(): void {
  adapterPaused = true;
  resumeBarrier ??= Promise.withResolvers<void>();
}
function resumeRoot(): void {
  adapterPaused = false;
  resumeBarrier?.resolve();
  resumeBarrier = null;
  if (connected && !shuttingDown && liveParent === null) { startDelivery(); onWake(); }
}

/** Runs behind BindGate; endSession is the only snapshot writer. */
async function rotateRoot(session: string): Promise<void> {
  if (shuttingDown || !ORDINARY || liveParent !== null) throw new Error("this process cannot associate an ordinary local conversation");
  if (session === HARNESS_SESSION) return;
  swapping = true;
  try {
    await inflight;
    const outgoing = { names: [...held], session_id: SESSION_ID };
    for (const alias of [...listeners.keys()]) stopListening(alias);
    stopIdListening();
    deliveryStarted = false;
    const ended = endLocalSession(db, SESSION_ID);
    SESSION_KEY = mintSessionKey();
    SESSION_ID = idAddress(SESSION_KEY);
    HARNESS_SESSION = session;
    held = [];
    restored = false;
    restoredFrom = null;
    startNotes.length = 0;
    bindHinted = false;
    missedBindNotice = null;
    requeued.length = 0;
    ROOT_KIND.harnessSession = session;
    registerSession(db, thisSession(SESSION_ID), ROOT_KIND);
    children = new ChildSessions(db, SESSION_ID, SESSION_KEY);
    await deliverEnded(db, ended);
    await restoreNames(conversationSnapshot(db, session) ?? outgoing);
    claudeGuidancePending = CLAUDE_CURRENT;
    if (restoredFrom) inheritStatus(db, SESSION_ID, restoredFrom);
    unboundCandidates = held.length ? [] : await candidateNames(db, SUGGESTED);
    writeNames();
    firstDrain = true;
    instructionsStale = true;
    writeCoreAudit(db, "id.conversation_selected", SESSION_ID, outgoing.session_id, { harness_session: session, owner: ADAPTER_OWNER ?? "claude-hook" });
  } finally { swapping = false; }
}

const OwnerSchema = z.object({ owner: z.string(), epoch: z.number().int().nonnegative(), _meta: z.record(z.string(), z.unknown()).optional() });
const SessionSchema = z.object({ method: z.literal("grayboard/session"), params: OwnerSchema.extend({ session: z.string().refine(validSourceId) }) });
const ReadySchema = z.object({ method: z.literal("grayboard/session/ready"), params: OwnerSchema });
const ReceiptSchema = z.object({ method: z.literal("grayboard/delivery"), params: z.object({ owner: z.string(), token: z.string(), accepted: z.boolean() }) });
function checkOwner(owner: string, meta?: Record<string, unknown>): void {
  if (!ORDINARY || !ADAPTER_OWNER || owner !== ADAPTER_OWNER || meta?.[GRAYBOARD_AGENT_META] !== undefined || meta?.[TOOL_USE_META] !== undefined) throw new Error("not this ordinary root's adapter owner");
}
mcp.setRequestHandler(SessionSchema, async ({ params }) => {
  checkOwner(params.owner, params._meta);
  if (params.epoch <= adapterSelectedEpoch) throw new Error("stale conversation epoch");
  adapterSelectedEpoch = params.epoch;
  pauseRoot();
  return gate.bind(async () => {
    if (params.epoch !== adapterSelectedEpoch) throw new Error("stale conversation epoch");
    await inflight;
    if (params.epoch !== adapterSelectedEpoch) throw new Error("stale conversation epoch");
    await rotateRoot(params.session);
    if (params.epoch !== adapterSelectedEpoch) throw new Error("stale conversation epoch");
    adapterEpoch = params.epoch;
    return { id: SESSION_ID, session: HARNESS_SESSION, epoch: adapterEpoch, instructions: localInstructions(true, startNotes) };
  });
});
mcp.setRequestHandler(ReadySchema, async ({ params }) => {
  checkOwner(params.owner, params._meta);
  if (params.epoch !== adapterSelectedEpoch || params.epoch !== adapterEpoch) throw new Error("stale conversation readiness");
  resumeRoot();
  return {};
});
mcp.setRequestHandler(ReceiptSchema, async ({ params }) => {
  checkOwner(params.owner);
  const receipt = receipts.get(params.token);
  if (!receipt) throw new Error("unknown delivery receipt");
  receipt.resolve(params.accepted);
  return {};
});

async function currentClaude(request?: IdentityRequest): Promise<{ instructions?: string[] }> {
  if (!CLAUDE_CURRENT) return {};
  if (request?.action === "pause") {
    claudePaused = true;
    pauseRoot();
    await gate.bind(async () => { await inflight; });
    return {};
  }
  let current = readCurrent(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start);
  if (!current) return {};
  if (request?.current && request.current.token !== current.token) throw new Error("stale Claude conversation record");
  const wasPaused = claudePaused;
  if (current.session !== HARNESS_SESSION) {
    pauseRoot();
    await gate.bind(async () => {
      const latest = readCurrent(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start);
      if (!latest || (request?.current && request.current.token !== latest.token)) throw new Error("stale Claude conversation record");
      await rotateRoot(latest.session);
      current = latest;
    });
  }
  const published = current.token !== claudePublication;
  claudePublication = current.token;
  if (published || claudePaused || adapterPaused) {
    claudePaused = false;
    resumeRoot();
  }
  return request && (published || wasPaused) ? { instructions: localInstructions(true, startNotes) } : {};
}

mcp.setRequestHandler(CallToolRequestSchema, async (req, { signal, requestId }) => {
  const { name, arguments: args = {} } = req.params;
  if (shuttingDown) return { ...text("error: this session is ending"), isError: true };
  if (CLAUDE_CURRENT && !claudePaused) await currentClaude();
  if (resumeBarrier) await resumeBarrier.promise;
  if (claudeReady && !await claudeReady.promise) return { ...text(`error: Claude channel activation failed; queued mail remains pending: ${claudeActivationError}`), isError: true };
  const callSession = SESSION_ID;
  const callEpoch = adapterEpoch;
  // A harness subagent's call (#523): harness-asserted, it makes the call the
  // subagent's child session, acting under this session's addresses. Claude
  // Code names the agent only through its hook's record (#551): a root marker
  // leaves the call the root's, and a missing record refuses it.
  const meta = req.params._meta;
  let agent: unknown = meta?.[GRAYBOARD_AGENT_META];
  if (agent === undefined && meta?.[TOOL_USE_META] !== undefined) {
    if (CLAUDE_HARNESS) {
      const taken = takeRecord(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start, meta[TOOL_USE_META]);
      if ("missing" in taken) return recordMissing(name, meta[TOOL_USE_META], taken.missing);
      if (taken.agent !== null) agent = taken.agent;
      if (taken.session !== undefined && taken.session !== HARNESS_SESSION) return recordMissing(name, meta[TOOL_USE_META], "bad_record");
    } else if (ATTRIBUTION_OFF && !attributionOffAudited) {
      attributionOffAudited = true;
      writeCoreAudit(db, "claude.attribution_off", SESSION_ID, null, { tool: name });
    }
  }
  const run = async () => {
    if (shuttingDown || callSession !== SESSION_ID || callEpoch !== adapterEpoch) return { ...text("error: conversation changed before this call ran"), isError: true };
    await testPauseAsync("local:tool:in-gate");
    // A runner child whose root isn't live (its parent harness exited while
    // this runner lives on) is its own session from here (#523 step 5).
    if (liveParent !== null && !runnerRootLive(db, SESSION_ID, liveParent)) await rootGone();
    for (const a of WRITES_AS ? [WRITES_AS] : held) touchAlias(db, a);
    touchId(db, SESSION_ID);
    // A runner child's own call is its child session's.
    if (agent === undefined) return call(name, args, signal, liveParent === null ? undefined : SESSION_ID);
    if (!validSourceId(agent)) return { ...text(`error: _meta["${GRAYBOARD_AGENT_META}"] must be a string of 1 to 1024 characters with no control characters`), isError: true };
    let child: string;
    try {
      child = children.resolve(agent);
    } catch (e) {
      if (e instanceof CoreError) return { ...text(`error: ${e.message}`), isError: true };
      throw e;
    }
    return call(name, args, signal, child);
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
  // Notices and fresh instructions are the root's: they never go to a child.
  const mine = agent === undefined && !(ORDINARY && (callSession !== SESSION_ID || callEpoch !== adapterEpoch));
  if (signal.aborted) {
    const l = mine ? landed(name, r) : null;
    if (l) requeued.push(l);
    return r;
  }
  if (!mine) return r;
  const extra = notices();
  let out = withNotices(r, extra);
  if (instructionsStale && !out.structuredContent) {
    instructionsStale = false;
    out = { ...out, structuredContent: { name: primary(), instructions: localInstructions(true) } };
  }
  late.answer(requestId, () => {
    if (name === "bind" && r.structuredContent) requeued.push(bindMissed((r.structuredContent as { name: string }).name, "it was cancelled", r.content[0]!.text));
    if (name === "unbind" && r.structuredContent) requeued.push(unbindMissed(String(args.name), "it was cancelled", r.content[0]!.text));
    const l = landed(name, r);
    if (l) requeued.push(l);
    requeued.push(...extra);
    if (out.structuredContent) instructionsStale = true;
  });
  return out;
});

// `child`: the child session making the call (#523), else the root itself.
async function call(name: string, args: Record<string, unknown>, signal: AbortSignal, child?: string): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const bad = checkArgs(LOCAL_TOOLS, name, args);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  try {
    return await dispatch(name, args, signal, child);
  } catch (err) {
    if (err instanceof CoreError) {
      return { ...text(`error: ${err.message}`), isError: true };
    }
    throw err;
  }
}

async function dispatch(name: string, a: Record<string, unknown>, signal: AbortSignal, child?: string) {
  // A child acts under its root's addresses; its names are the root's to
  // change, but for a runner child's bind, which promotes it (#523 step 5).
  if (child !== undefined && (name === "unbind" || (name === "bind" && child !== SESSION_ID))) {
    const whose = child === SESSION_ID ? "unbind is the root's; bind(name) makes this process its own session." : "bind and unbind are the root's. Call them from the root session.";
    return { ...text(`error: child_session: this session acts under its root ${rootId()}; ${whose}`), isError: true };
  }
  // Nor does it take on or change the root's read state (its inbox, its subscriptions).
  const refused = child === undefined ? null : childStateRefusal(name, child, primary());
  if (refused !== null) return { ...text(`error: child_session: ${refused}`), isError: true };
  if (name === "bind") return bind(a, signal);
  if (name === "unbind") return unbind(a, signal);
  // Local mode has one implicit scope: no principal (#284 S6).
  if (name === "whoami") return text({ id: child ?? SESSION_ID, primary: primary(), aliases: holds(), principal: null, ...(WRITES_AS ? { writes_as: WRITES_AS } : {}), ...(child !== undefined ? { root: rootId(), child: true } : {}), ...(ATTRIBUTION_OFF ? { note: ATTRIBUTION_OFF_NOTE } : {}) });
  // The session the write is from (sender_id, author_id): the child making
  // the call, which its writes also name as `via` (#523), else this one.
  const WRITER = child ?? SESSION_ID;
  const via = child ?? null;
  // A runner child's root is checked live at call start, but a call that
  // awaits (a liveness probe, an attachment read) can outlast it: its write
  // checks again in the write's own transaction (#557). The next call then
  // finds the root gone and runs as its own session.
  const rootLive = liveParent === null || child === undefined ? undefined : ((root: string, c: string) => () => {
    if (!runnerRootLive(db, c, root)) throw new CoreError(`child_session: this session's root ${root} ended during the call, so nothing was written; call again, as this process's own session`);
  })(liveParent, child);

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
    // Only the launchers (and an explicit `to`) are probed: a probe is a
    // wakeup, so probing the whole roster would wake every peer's drain (#253).
    const live = await liveHandles(ADDRS, [...launchers(db), ...(typeof a.to === "string" ? [localRecipient(a.to.trim())] : [])]);
    // A name just released (an unbind, or a 1.x rebind sharing the file) can
    // still answer on its socket: filter it like dm_send does (a released
    // name's socket isn't the session).
    const online = (h: string) => live(h) && !lastWasRelease(db, h);
    // The audit rows name the child that called, beside the routing `via` (#523).
    const byChild = child === undefined ? {} : { child };
    // `to` resolved as dm_send resolves a recipient, as the server does (#272).
    const args = typeof a.to === "string" ? { ...a, to: localRecipient(a.to.trim()) } : a;
    let d;
    try {
      d = resolveDelegation(db, IDENTITY, args, online, undefined, (h) => ADDRS.includes(h));
    } catch (e) {
      if (e instanceof CoreError) {
        writeCoreAudit(db, "delegation.refused", IDENTITY, null, { reason: e.message, ...byChild });
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
    let msgId = (await insertMessage(IDENTITY, WRITER, d.to, d.body, null, true, [], undefined, via, rootLive)).id;
    writeCoreAudit(db, "delegation.requested", IDENTITY, d.to, { via: d.humanFallback ? "human_fallback" : a.to !== undefined ? "explicit" : "auto", message_id: msgId, ...byChild });
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
        const d2 = resolveDelegation(db, IDENTITY, args, (h) => online(h) && h !== d!.to, undefined, (h) => ADDRS.includes(h));
        if (d2.to !== d.to && !d2.humanFallback && retractMessage(IDENTITY, msgId)) {
          const id2 = (await insertMessage(IDENTITY, WRITER, d2.to, d2.body, null, true, [], undefined, via, rootLive)).id;
          writeCoreAudit(db, "delegation.requested", IDENTITY, d2.to, { via: "auto", message_id: id2, repicked_from: d.to, ...byChild });
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
    const sender = a.as !== undefined ? actingAs(String(a.as), AS_ADDRS, null) : (mine(parent) ? replySender(parent, holds()) : null) ?? IDENTITY;
    checkBody(body);
    // A session ID is checked where the message is written (insertMessage).
    const recipient = localRecipient(to);
    if (addressParts(recipient)?.kind !== "id" && !rosterHandles(db).includes(recipient)) {
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
    const peer = parent ? replyPeer(parent, ADDRS) : null;
    if (parent && peer !== recipient) {
      return { ...text(`error: ${replyPeerError(parent.id, peer!)}`), isError: true };
    }
    const files = a.attachments === undefined ? [] : await readAttachmentFiles(a.attachments, ROOTS);
    const { id, attachments } = await withUploads(sender, files, (ids) => insertMessage(sender, WRITER, recipient, body, parent_id ?? null, pending === true, ids, { addresses: ADDRS, principal: null }, via, rootLive));
    // The result names the sender whenever it isn't the primary.
    const p = { ...(sender !== IDENTITY ? { sent_as: sender } : {}), ...(pending ? { pending: true } : {}), ...(attachments.length ? { attachments } : {}), ...bindHint(child) };
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
    if (m.delivered_at !== null || getCursor(m.recipient) >= m.id || (await poke(m.recipient))) return refuse(retractRefusal.reached(m.id, m.recipient));
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
    if (!row || !canReadAttachment(db, IDENTITY, row, (m) => mine(getMessage(m)), { addresses: ADDRS, principal: null })) {
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
      session: WRITER,
      ...(child !== undefined ? { via: child } : {}),
      addresses: ADDRS,
    };
    const actor = boardActor(db, name, a, { addresses: ADDRS, asAddresses: AS_ADDRS, ownScope: null });
    const { attachments: paths, as: _as, ...args } = a;
    const files = paths === undefined ? [] : await readAttachmentFiles(paths, ROOTS);
    // Bound in the post's transaction; a refused post releases the uploads.
    const { result, wake } = await withUploads(actor, files, (ids) => {
      testPause("board:before-txn");
      return db.transaction(() => {
        rootLive?.();
        return callBoardTool(db, actor, name, ids.length ? { ...args, attachment_ids: ids } : args, ctx);
      }).immediate();
    });
    await wakeAll(wake);
    // board_post and a taken claim are writes; a claim held by someone else is a refusal.
    const wrote = typeof result === "object" && result !== null && (name === "board_post" || (name === "claim_take" && "ok" in result && result.ok === true));
    return text(wrote ? { ...result, ...bindHint(child) } : result);
  }

  throw new Error(`unknown tool: ${name}`);
}

// Which addresses have a live session, by probing each wakeup socket. A probe
// is also a wakeup, so each live peer runs a drain; that's harmless (idempotent).
async function liveHandles(self: string[], among?: string[]): Promise<(h: string) => boolean> {
  const candidates = liveAddresses(db);
  const others = (among ? candidates.filter((h) => among.includes(h)) : candidates).filter((h) => !self.includes(h));
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
    return unboundPeer(r.session_id, r.cwd ? describeLocation(r.cwd) : null, r.session_id === rootId(), s ? { text: s.status, age: age(now - (s.status_at ?? now)) } : undefined);
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

// A wakeup during a drain joins it: the loop re-queries until empty. A
// runner child never drains: its root's mail is its root's.
function drainToClaude(): Promise<void> {
  if (swapping || shuttingDown || liveParent !== null || adapterPaused || claudePaused) return Promise.resolve();
  if (CLAUDE_CURRENT) {
    const current = readCurrent(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start);
    if (!current) return Promise.resolve();
    if (current.session !== HARNESS_SESSION) return currentClaude().then(() => drainToClaude());
  }
  inflight ??= drainLoop().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Each of the session's addresses (#284 S5) is drained under its own cursor
// and outbox rows: mail to the ID and to the alias are separate streams.
async function drainLoop(): Promise<void> {
  await initialized;
  if (claudeReady && !await claudeReady.promise) return;
  if (CLAUDE_CURRENT && claudeGuidancePending) {
    if (!await pushChannel({ content: `Current grayboard instructions supersede this conversation's earlier bus guidance. Current bus session: ${SESSION_ID}.\n${localInstructions(true, startNotes).join("\n")}`, meta: { kind: "guidance" } })) return;
    claudeGuidancePending = false;
  }
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
        if (!await pushChannel(params)) return;
        if (sessionEnded) return;
        deliveredTo(reader, msg.id);
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
      if (!await pushChannel(params)) return;
      if (sessionEnded) return;
      for (const reader of pendingTo) markDelivered(db, reader, item);
    }
    if (!any) break;
  }
}

async function pushChannel(params: { content: string; meta: Record<string, string> }): Promise<boolean> {
  if (adapterPaused || claudePaused || shuttingDown) return false;
  if (CLAUDE_CURRENT && readCurrent(sockDir(), CLAUDE_HARNESS.pid, CLAUDE_HARNESS.start)?.session !== HARNESS_SESSION) return false;
  if (!ADAPTER_OWNER) {
    await mcp.notification({ method: "notifications/claude/channel", params });
    return true;
  }
  const token = `${adapterEpoch}-${crypto.randomUUID()}`;
  const receipt = Promise.withResolvers<boolean>();
  receipts.set(token, receipt);
  const timeout = setTimeout(() => receipt.resolve(false), 8_000);
  try {
    await mcp.notification({ method: "notifications/claude/channel", params: { ...params, meta: { ...params.meta, grayboard_session: HARNESS_SESSION ?? "", grayboard_epoch: String(adapterEpoch), grayboard_delivery: token } } });
    return await receipt.promise;
  } finally { clearTimeout(timeout); receipts.delete(token); }
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
// before it drops (#284 S7); the ID's is this process's from start (or from a
// runner child's becoming its own session) to exit.
const listeners = new Map<string, () => void>();
let stopIdListening = () => {};

function listen(alias: string): void {
  if (DELIVER && !listeners.has(alias)) listeners.set(alias, listenForWakeup(alias, onWake));
}

function stopListening(alias: string): void {
  listeners.get(alias)?.();
  listeners.delete(alias);
}

// Delivery for the session this process owns: its ID's wakeup socket, its
// names' sockets, and a first drain. A runner child has none until it
// becomes its own session.
function startDelivery(): void {
  if (!DELIVER || deliveryStarted || !connected) return;
  deliveryStarted = true;
  stopIdListening = listenForWakeup(SESSION_ID, onWake);
  for (const h of held) listen(h);
  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}

// The root session a runner child becomes (#523 step 5): a new key and ID,
// since its child ID is never an address, registered unbound as ROOT_KIND.
function leaving(): { key: string; leave: Leave } {
  const key = mintSessionKey();
  const leave: Leave = {
    child: SESSION_ID, root: liveParent!, self: thisSession(idAddress(key)), kind: ROOT_KIND,
    detail: { parent_session: PARENT_SESSION, harness_session: HARNESS_SESSION ?? null },
  };
  return { key, leave };
}

// This process is that session from here (`how` says why, for the log) and
// owns its delivery, as a root that started on its own does.
function becomeRoot(key: string, how: string): void {
  const id = idAddress(key);
  console.error(`[grayboard] subagent session ${SESSION_ID} of ${liveParent} ${how}: this process is session ${id} from here`);
  SESSION_KEY = key;
  SESSION_ID = id;
  liveParent = null;
  children = new ChildSessions(db, SESSION_ID, SESSION_KEY);
  // The flag is the session's (ids.launcher), audited where it registers.
  writeCoreAudit(db, "handle.launcher_set", SESSION_ID, SESSION_ID, { on: EFFECTIVE_LAUNCHER });
  startDelivery();
}

// A runner child whose root isn't live (#523 step 5) runs as its own,
// unbound session from here: once, since it then has no root to check.
async function rootGone(): Promise<void> {
  const { key, leave } = leaving();
  const ended = childFallback(db, leave);
  becomeRoot(key, "lost its root, which isn't live");
  writeNames();
  instructionsStale = true;
  unboundCandidates = await candidateNames(db, SUGGESTED);
  await deliverEnded(db, ended);
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
  // The human's handle is a declaration, fixed for its bridge's session (#363), as the server's attachHuman session.
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
    // A runner child's bind promotes it to its own session in the
    // transaction that takes the name (#523 step 5).
    const promote = liveParent === null ? null : leaving();
    const r = await acquireName(db, promote?.leave.self.session_id ?? SESSION_ID, n.name, { create: a.create === true, meta, ...(promote ? { promote: promote.leave } : {}) });
    await deliverEnded(db, r.ended);
    if (!r.ok) return fail(r.error);
    if (promote) becomeRoot(promote.key, `bound "${n.name}", promoted`);
    // The row holds the new name from here: so does this process, whatever
    // follows fails.
    held.push(n.name);
    writeNames();
    firstDrain = true;
    testPause("bind:after-acquire");
    try {
      listen(n.name);
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
// A runner child starts its delivery when it becomes its own session
// (becomeRoot), which a call can do before startup's below: so whether
// startup starts it is read before the first call can arrive.
const rootAtStart = liveParent === null;
const transport = new StdioServerTransport();
let stopIdentity = () => {};
if (CLAUDE_CURRENT) {
  stopIdentity = await listenIdentity(sockDir(), CLAUDE_HARNESS.pid, currentClaude);
  await currentClaude();
}
const sendTransport = transport.send.bind(transport);
transport.send = async message => {
  // Keep the SDK's negotiation and capabilities; only initialize's guidance is live.
  if ("result" in message && "serverInfo" in message.result) message = { ...message, result: { ...message.result, instructions: [...(CHANNELS_OFF_NOTICE ? [CHANNELS_OFF_NOTICE] : []), ...(ATTRIBUTION_OFF ? [ATTRIBUTION_OFF_NOTE] : []), ...localInstructions(true, startNotes)].join(" ") } };
  await sendTransport(message);
  if (claudeReady && !claudeActivationStarted && "result" in message && "tools" in message.result) {
    claudeActivationStarted = true;
    void mcp.ping().then(() => {
      claudeReady.resolve(true);
      onWake();
    }, error => {
      claudeActivationError = (error as Error).message;
      console.error(`grayboard Claude channel activation failed; queued mail remains pending: ${claudeActivationError}`);
      claudeReady.resolve(false);
    });
  }
};
await mcp.connect(transport);
connected = true;
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
  stopIdentity();
  resumeBarrier?.resolve();
  for (const receipt of receipts.values()) receipt.resolve(false);
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
  let ended: Ended = nothingEnded();
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

if (rootAtStart) startDelivery();
