// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CoreError, activeAnnouncements, age, endLane, humanHandles, isHuman, lastSeen, MAIN_LANE, markDelivered, pendingFor, rosterHandles, startSession, touchHandle, touchLane, laneStreamRef } from "../core/boards.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import {
  BOARD_INSTRUCTIONS,
  announcementsInstruction,
  claimsInstruction,
  boardNotification,
  humanInstruction,
  boardTools,
  callBoardTool,
  isBoardTool,
} from "../core/tools.ts";
import {
  ackMessage,
  claimDm,
  db,
  getCursor,
  getHistory,
  getMessage,
  getThread,
  hasDeliveredClaim,
  hasUndeliveredClaim,
  insertMessage,
  lanesReadPast,
  markClaimDelivered,
  nextClaimExpiry,
  previousBetween,
  pruneDmClaims,
  readPointFor,
  receivedUnacked,
  retractMessage,
  sentPending,
  setCursor,
  undeliveredClaimBelow,
  undeliveredFrom,
  type Message,
  unreadFor,
} from "./db.ts";
import { assertLaneFree, laneAlive, listenForWakeup, poke, pokeLanes } from "./wakeup.ts";
import { sessionIdentity, sessionLane } from "../shared/identity.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
import {
  DM_ACK_TOOL,
  DM_INBOX_INSTRUCTION,
  DM_INBOX_TOOL,
  DM_RETRACT_TOOL,
  PENDING_PARAM,
  PROMISE_DAYS,
  STALE_UNDELIVERED_MS,
  ackIds,
  ackResult,
  dmBody,
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

const IDENTITY: string = sessionIdentity();
// This session's lane within the identity's fleet: BUS_LANE, else the
// worktree's name when the identity was explicit, else the default. Several
// sessions of one identity run side by side, one per lane.
const LANE: string = sessionLane() ?? MAIN_LANE;
// This lane's DM-cursor stream: the identity's own row for the default lane
// (pre-lanes rows unchanged), `identity#<lane>` for the rest, so lanes never
// ack away each other's pending messages.
const READER: string = laneStreamRef(IDENTITY, LANE);
console.error(`[grayboard] local mode, identity "${IDENTITY}", lane "${LANE}"`);

// BUS_PUSH=off: tools only. For harnesses without Claude channels, where a
// separate adapter owns the wakeup socket and delivery. Draining here would
// consume messages into a void.
const PUSH = process.env.BUS_PUSH !== "off";
// BUS_HUMAN=1: a human holds this identity through a bridge (`grayboard bridge
// slack`). It grants nothing: the handle must already be the declared human
// (`grayboard human`), whose messages and posts reach agents marked
// human="true". Without it, the human's handle is refused, so an agent can't
// take it by name.
const HUMAN = process.env.BUS_HUMAN === "1";
if (HUMAN !== isHuman(db, IDENTITY)) {
  console.error(
    HUMAN
      ? `[grayboard] BUS_HUMAN=1, but "${IDENTITY}" isn't the declared human handle; declare it with: grayboard human ${IDENTITY}`
      : `[grayboard] "${IDENTITY}" is your user's handle; an agent session can't use it. Pick another BUS_IDENTITY.`,
  );
  process.exit(1);
}
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: tools only");
// Notifications such a session drops would still count as delivered, so it
// runs tools-only, as BUS_PUSH=off does, and what's pending waits (#71).
const DELIVER = PUSH && !CHANNELS_OFF;

const mcp = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      ...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []),
      `You are identity "${IDENTITY}"${LANE !== MAIN_LANE ? `, lane "${LANE}"` : ""} on the grayboard bus, which coordinates between agents.`,
      `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [parent_id="..."]>body</channel>; reply with dm_send(to=from, body, parent_id=message_id).`,
      DM_INBOX_INSTRUCTION,
      ...BOARD_INSTRUCTIONS,
      ...humanInstruction(humanHandles(db).filter((h) => h !== IDENTITY)),
      ...(HUMAN ? [] : announcementsInstruction(activeAnnouncements(db))),
      ...undeliveredInstruction(undeliveredFrom(IDENTITY, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
      // Last: the longest, and the one to lose if the client cuts the text.
      ...claimsInstruction(listClaims(db), IDENTITY),
    ].join(" "),
  },
);

// Tool discovery

const TOOLS = [
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox, dm_ack and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description: `dm_send(to, body, parent_id?, pending?): message one other agent by exact handle (peer_list). You are "${IDENTITY}". Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting.`,
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "The peer's exact handle, as peer_list shows it.",
        },
        body: {
          type: "string",
          description: "Message body. Plain text or markdown.",
        },
        parent_id: {
          type: "number",
          description:
            "Optional. message_id this is replying to; sets the thread parent.",
        },
        pending: PENDING_PARAM,
      },
      required: ["to", "body"],
    },
  },
  {
    name: "dm_history",
    description:
      "dm_history(peer?, limit?, before_id?): your recent direct messages, sent and received, oldest first; with peer, only those with that agent. Ones you sent have delivered: whether they've reached the recipient's session.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description:
            "Optional. Only return messages between you and this peer identity.",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default 20, max 200).",
        },
        before_id: {
          type: "number",
          description:
            "Return messages with id strictly less than this; use for pagination.",
        },
      },
    },
  },
  {
    name: "dm_thread",
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "dm_thread(thread): a whole direct-message thread you're in, from its first message through every reply, ordered by id.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "number",
          description: "Any message_id in the thread.",
        },
      },
      required: ["thread"],
    },
  },
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
  DM_RETRACT_TOOL,
...boardTools({ teams: false }),
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
const notices = (): string[] => {
  const out = channelsNoticePending ? [CHANNELS_OFF_NOTICE] : [];
  channelsNoticePending = false;
  const stale = staleNotice();
  return stale ? [...out, stale] : out;
};

// Announces claims that lapse on their boards. Every session runs one; the
// sweep's delete makes each lapse post once.
const expiry = claimExpiryTimer(db, (handles) => void wakeAll(handles));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  touchHandle(db, IDENTITY);
  const r = await call(name, args as Record<string, unknown>);
  expiry.arm();
  const extra = notices();
  return extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text", text }))] } : r;
});

async function call(name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const bad = checkArgs(TOOLS, name, args);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  try {
    return await dispatch(name, args);
  } catch (err) {
    if (err instanceof CoreError) {
      return { ...text(`error: ${err.message}`), isError: true };
    }
    throw err;
  }
}

// Only a message's sender and recipient can see it or thread from it.
const mine = (m: Message | undefined): m is Message => !!m && (m.sender === IDENTITY || m.recipient === IDENTITY);

async function dispatch(name: string, a: Record<string, unknown>) {
  if (name === "dm_send") {
    const { to: recipient, body, parent_id, pending } = a as {
      to: string;
      body: string;
      parent_id?: number;
      pending?: boolean;
    };
    dmBody(body);
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
    const id = insertMessage(IDENTITY, recipient, body, parent_id ?? null, pending === true);
    const p = pending ? { pending: true } : {};
    // Fleet delivery truth, like the server's send_ok: how many of the
    // recipient's lanes are live, and which had read past this point — the
    // sender's previous message ADDRESSED TO the recipient (directional: an
    // either-direction compare counts the recipient's own reply, which sits
    // above its receive cursor forever, hiding read state after the first
    // back-and-forth), not `id - 1`: ids are global, and an unrelated pair
    // may hold the id in between. Surfaced only when it says more than the
    // default, so single-session results stay unchanged.
    const { live, any: delivered } = await pokeLanes(recipient);
    const fleet: Record<string, unknown> = {};
    if (recipient === IDENTITY || live > 1) {
      const prev = previousBetween(IDENTITY, recipient, id);
      const read = prev > 0 ? lanesReadPast(recipient, prev) : [];
      if (live > 1) fleet.live_lanes = live;
      if (read.length > 0) fleet.read_lanes = read;
    }
    if (delivered) return text(JSON.stringify({ message_id: id, delivered_now: true, ...p, ...fleet, note: "Recipient was online; pushed." }));
    const seen = lastSeen(db, recipient);
    return text(JSON.stringify({
      message_id: id,
      delivered_now: false,
      ...p,
      ...fleet,
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
    const id = a.message_id as number;
    const m = getMessage(id);
    const refuse = (why: string) => ({ ...text(`error: ${why}`), isError: true });
    if (!m || m.sender !== IDENTITY) return refuse(retractRefusal.notYours(id));
    // A probe is a wakeup: a live recipient drains the message now. Reached
    // is any lane's cursor (a lane reading is the identity reading), held
    // back by undelivered claims (D1) — and a delivered claim counts even
    // when the winner's cursor is still held back.
    const reached = (mid: number, recipient: string) =>
      (readPointFor(recipient) >= mid || hasDeliveredClaim(mid)) && !hasUndeliveredClaim(mid);
    if (reached(m.id, m.recipient) || (await poke(m.recipient))) return refuse(retractRefusal.reached(id, m.recipient));
    if (!retractMessage(IDENTITY, m.id)) {
      return refuse(reached(m.id, m.recipient) ? retractRefusal.reached(id, m.recipient) : retractRefusal.replied(id));
    }
    return text("ok");
  }

  if (isBoardTool(name)) {
    // Only a human can start an announcement, which reaches the sessions live now.
    const ctx = name === "peer_list" || (name === "board_post" && HUMAN) ? { online: await liveHandles(), lane: LANE } : { lane: LANE };
    const { result, wake } = callBoardTool(db, IDENTITY, name, a, ctx);
    // The response must reach the caller before the wake fires. A woken
    // sibling can round-trip a reply faster than the poster's own follow-up
    // bookkeeping (the bridge relay registers its thread map only once this
    // response arrives), so waking inside the call turns that bookkeeping
    // into a race. The timer crosses into the next macrotask, after the
    // response write has gone out; the wake is at-least-once either way.
    setTimeout(() => { void wakeAll(wake).catch((e) => console.error("[grayboard] wake failed:", e)); }, 0);
    return text(result);
  }

  throw new Error(`unknown tool: ${name}`);
}

// Which handles have a live session, by probing each wakeup socket. A probe is
// also a wakeup, so each live peer runs a drain; that's harmless (idempotent).
async function liveHandles(): Promise<(h: string) => boolean> {
  const others = rosterHandles(db).filter((h) => h !== IDENTITY);
  const alive = await Promise.all(others.map((h) => poke(h)));
  const live = new Set(others.filter((_, i) => alive[i]));
  return (h) => live.has(h);
}

// Drain: emit unread direct messages and pending board items as channel
// notifications. Loop until empty so concurrent writes that race past a
// single query still get picked up. Re-entry is guarded; crashed drains
// re-deliver (at-least-once).
let draining = false;
// A drain requested while one runs: the running drain loops once more
// before it exits (round-7 N1). The retry timer bails on `draining` (it
// must not stack). A drain's tail — board notifications, slow stdout — can
// span a skipped claim's expiry; the expiry check after the tail sees the
// expired claim (the claimed row is the pending signal, round-8 N1) and
// arms an immediate retry, and a poke arriving during the tail rides the
// rerun to deliver at once.
let rerunDrain = false;
// Test seam (BUS_TEST_DRAIN_TAIL_MS): delays the tail between the last
// scan and the expiry check, widening the window the rerun flag exists for
// so a test can hit it deterministically. Zero in production.
const DRAIN_TAIL_TEST_MS = Math.max(Number(process.env.BUS_TEST_DRAIN_TAIL_MS ?? 0) || 0, 0);
// The first drain also brings deferred thread replies and digests: a new
// session is the natural time to see them.
let firstDrain = true;

// One armed TTL-retry drain: a drain that skips a live claim must not leave
// the takeover waiting for the next unrelated wake, which might be hours
// away — the claimer may be dead (round-6 item 2). Replaced, never stacked;
// unref'd so it can't hold the process open on its own.
let claimRetry: ReturnType<typeof setTimeout> | null = null;
function armClaimRetry(delayMs: number): void {
  if (claimRetry !== null) clearTimeout(claimRetry);
  claimRetry = setTimeout(() => {
    claimRetry = null;
    // .catch is load-bearing: an unhandled rejection here (e.g. SQLITE_BUSY
    // when another connection holds a write lock past busy_timeout) exits
    // the whole MCP server (round-7 N2); a failed retry just logs — the
    // claim stays armed in the table, the next wake takes it over.
    drainToClaude().catch((err) => {
      console.error("grayboard claim-retry drain error:", err);
    });
  }, Math.max(delayMs, 0));
  (claimRetry as { unref?: () => void }).unref?.();
}

// Claude Code drops notifications that arrive before it sends `initialized`,
// so the startup drain (and any early wakeup) waits for it.
let markInitialized!: () => void;
const initialized = new Promise<void>((r) => { markInitialized = r; });
mcp.oninitialized = () => markInitialized();

async function drainToClaude(): Promise<void> {
  await initialized;
  if (draining) {
    rerunDrain = true;
    return;
  }
  draining = true;
  try {
    do {
    rerunDrain = false;
    // Lazy sweep first (ruling 3): local sockets have no close event, so any
    // draining reader ends lanes whose session crashed — kind "session"
    // rows, past a grace window, whose lane socket no longer answers.
    await sweepStaleLanes();
    touchLane(db, IDENTITY, LANE);
    // A sibling lane may have handled messages this lane never saw: sync to
    // the identity's read point before draining (any lane's reading is the
    // identity reading), so this lane never replays what a sibling already
    // delivered. The read point is held back by undelivered claims (D1): a
    // message no agent received stays ahead of the cursor, visible to a
    // takeover, never synced past.
    const readPoint = readPointFor(IDENTITY);
    if (readPoint > getCursor(READER)) setCursor(READER, readPoint);
    while (true) {
      const batch = unreadFor(READER);
      // Deliver DMs first, then decide the board wake: a deferred item may
      // only ride along with a DM THIS lane claimed and delivered — a
      // sibling's claim is not this lane's wake (D2; deferred pushes and
      // digests never wake a session on their own).
      let deliveredDm = false;
      for (const msg of batch) {
        // Exactly one lane delivers each DM, ever: the claim is atomic, the
        // delivered marker is the truth. "delivered": an agent already got
        // it (a winner whose cursor is still held back) — catch the cursor
        // up, never re-notify. "skip": a live sibling claim — leave the
        // cursor alone; the read point holds until the sibling delivers or
        // the claim expires and any lane takes it over (at-least-once at the
        // claim level, exactly-once per attempt).
        const outcome = claimDm(msg.id, READER);
        if (outcome === "skip") continue;
        if (outcome === "claimed") {
          const meta: Record<string, string> = {
            message_id: String(msg.id),
            from: msg.sender,
            created_at: String(msg.created_at),
          };
          if (msg.parent_id !== null) meta.parent_id = String(msg.parent_id);
          if (isHuman(db, msg.sender)) meta.human = "true";
          await mcp.notification({
            method: "notifications/claude/channel",
            params: { content: msg.body, meta },
          });
          markClaimDelivered(msg.id);
          deliveredDm = true;
        }
        // The marker says an agent received it; the cursor may only move
        // when no earlier undelivered claim holds the read point back (D1).
        if (!undeliveredClaimBelow(IDENTITY, msg.id)) setCursor(READER, msg.id);
      }
      const boardItems = pendingFor(db, IDENTITY, { all: firstDrain || HUMAN || deliveredDm });
      firstDrain = false;
      if (batch.length === 0 && boardItems.length === 0) break;
      for (const item of boardItems) {
        const params = boardNotification(item);
        if (item.kind === "push" && isHuman(db, item.post.author)) params.meta.human = "true";
        await mcp.notification({
          method: "notifications/claude/channel",
          params,
        });
        markDelivered(db, IDENTITY, item);
      }
      // Every DM in the batch is claimed by a sibling (and nothing else to
      // do): nothing more for this lane — the siblings' deliveries move the
      // read point, and this lane's next drain syncs past them.
      if (!deliveredDm && boardItems.length === 0) break;
    }
    // A claim this drain skipped may belong to a claimer that died: nothing
    // else fires the takeover (the next DM or poke could be hours away), so
    // arm one retry for the claim's expiry moment — clamped to now by
    // armClaimRetry when the claim already expired, an immediate retry
    // (round-8 N1). Null means no undelivered claim exists at all, so
    // clearing an earlier arm is safe (round-6 item 2).
    if (DRAIN_TAIL_TEST_MS > 0) await Bun.sleep(DRAIN_TAIL_TEST_MS);
    const expiry = nextClaimExpiry(IDENTITY);
    if (expiry !== null) armClaimRetry(expiry - Date.now() + 50);
    else if (claimRetry !== null) {
      clearTimeout(claimRetry);
      claimRetry = null;
    }
    } while (rerunDrain);
  } finally {
    draining = false;
  }
}

// A crashed local session writes nothing (no close event), so its lane row
// lingers until any draining session sweeps it: kind "session", last_seen
// past the grace window (a live lane touches it on every drain), and a lane
// socket that no longer answers after the full retry window. Bridge lanes
// (kind "bridge") are sticky: exempt, the human's reachability rides on them.
const STALE_LANE_MS = 60_000;

async function sweepStaleLanes(): Promise<void> {
  // Delivery-marker claims outlive any concurrent scan by a day; then go.
  pruneDmClaims();
  const rows = db.prepare(`SELECT handle, lane, last_seen FROM lanes WHERE kind = 'session'`).all() as {
    handle: string; lane: string; last_seen: number;
  }[];
  const now = Date.now();
  for (const r of rows) {
    if (now - r.last_seen < STALE_LANE_MS) continue;
    if (r.handle === IDENTITY && r.lane === LANE) continue; // ours: alive by construction
    if (await laneAlive(r.handle, r.lane)) continue;
    endLane(db, r.handle, r.lane);
    console.error(`[grayboard] swept stale lane ${r.handle}#${r.lane}`);
  }
}

// Startup: refuse a duplicate lane before the MCP handshake so the client
// shows the server as failed. Then connect MCP so notifications are accepted,
// bind the lane's wakeup socket (bind-first), and replay what arrived while
// offline — this lane's own stream, seeded from the default lane's cursor so
// joining a fleet doesn't replay the identity's history.
if (DELIVER) await assertLaneFree(IDENTITY, LANE);
// A tools-only server runs beside the session that owns the identity; leave its status alone.
if (DELIVER) startSession(db, IDENTITY, process.cwd(), LANE, { kind: HUMAN ? "bridge" : "session", push_capable: true });
else touchHandle(db, IDENTITY);
// Seed this lane's cursor to the identity's read point (the MAX across its
// lanes, held back by undelivered claims — D1): a fresh or rejoining lane
// must not replay what a sibling already handled — including an identity
// that only ever ran on non-main lanes — and must not sync past a message
// still claimed and undelivered, which would strand it.
{
  const readPoint = readPointFor(IDENTITY);
  if (readPoint > 0) setCursor(READER, readPoint);
}
await mcp.connect(new StdioServerTransport());

let cleanup = () => {};
const shutdown = () => {
  // Clean exits drop their own lane now; a crash leaves it for the sweep.
  try {
    endLane(db, IDENTITY, LANE);
  } catch (err) {
    console.error("grayboard lane cleanup failed:", err);
  }
  cleanup();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Exit when the client goes away. Otherwise the wakeup listener keeps an
// orphan alive that holds the lane and blocks the next session on it.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

if (DELIVER) {
  cleanup = await listenForWakeup(IDENTITY, LANE, () => {
    // A wakeup may follow another session's claim_take.
    expiry.arm();
    drainToClaude().catch((err) => {
      console.error("grayboard drain error:", err);
    });
  });

  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}
