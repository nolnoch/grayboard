// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CoreError, activeAnnouncements, checkBody, age, humanHandles, isHuman, lastSeen, markDelivered, pendingFor, rosterHandles, startSession, touchHandle } from "../core/boards.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import { attachmentData, canReadAttachment, getAttachment, storeAttachment } from "../core/attachments.ts";
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
} from "./db.ts";
import { localDbPath } from "./open.ts";
import { assertIdentityFree, listenForWakeup, poke } from "./wakeup.ts";
import { sessionIdentity } from "../shared/identity.ts";
import { ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL, attachRoots, formatAttachmentsMeta, localBusDir, readAttachmentFiles, saveAttachment } from "../shared/attachments.ts";
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
console.error(`[grayboard] local mode, identity "${IDENTITY}"`);
// Directories this session may attach files from and save them to.
const ROOTS = attachRoots();
// This bus's subdirectory of the default save directory.
const BUS_DIR = localBusDir(localDbPath());

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
      `You are identity "${IDENTITY}" on the grayboard bus, which coordinates between agents.`,
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
    description: `dm_send(to, body, parent_id?, pending?, attachments?): message one other agent by exact handle (peer_list). You are "${IDENTITY}". Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting.`,
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
        attachments: ATTACHMENTS_PARAM,
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
  ATTACHMENT_GET_TOOL,
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
  const r = await call(name, args as Record<string, any>);
  expiry.arm();
  const extra = notices();
  return extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text", text }))] } : r;
});

async function call(name: string, args: Record<string, any>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
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

async function dispatch(name: string, a: Record<string, any>) {
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
    const { id, attachments } = insertMessage(IDENTITY, recipient, body, parent_id ?? null, pending === true, files);
    const p = { ...(pending ? { pending: true } : {}), ...(attachments.length ? { attachments } : {}) };
    const delivered = await poke(recipient);
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
    return text(getHistory(IDENTITY, a.peer, historyLimit(a.limit), a.before_id).map(showPending));
  }

  if (name === "dm_thread") {
    if (!mine(getMessage(a.thread))) {
      return { ...text(`error: message ${a.thread} not found`), isError: true };
    }
    return text(getThread(a.thread).filter(mine).map(showPending));
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
    const m = getMessage(a.message_id);
    const refuse = (why: string) => ({ ...text(`error: ${why}`), isError: true });
    if (!m || m.sender !== IDENTITY) return refuse(retractRefusal.notYours(a.message_id));
    // A probe is a wakeup: a live recipient drains the message now.
    if (getCursor(m.recipient) >= m.id || (await poke(m.recipient))) return refuse(retractRefusal.reached(m.id, m.recipient));
    if (!retractMessage(IDENTITY, m.id)) {
      return refuse(getCursor(m.recipient) >= m.id ? retractRefusal.reached(m.id, m.recipient) : retractRefusal.replied(m.id));
    }
    return text("ok");
  }

  if (name === "attachment_get") {
    const row = getAttachment(db, a.id);
    if (!row || !canReadAttachment(db, IDENTITY, row, (id) => mine(getMessage(id)))) {
      return { ...text(`error: no attachment ${a.id} on a message or post you can read`), isError: true };
    }
    const path = await saveAttachment(row, attachmentData(db, row.sha256), a.dir, ROOTS, BUS_DIR);
    return text({ path, filename: row.filename, type: row.type, size: row.size });
  }

  if (isBoardTool(name)) {
    // Only a human can start an announcement, which reaches the sessions live now.
    const ctx = name === "peer_list" || (name === "board_post" && HUMAN) ? { online: await liveHandles() } : {};
    const { attachments: paths, ...args } = a;
    const files = paths === undefined ? [] : await readAttachmentFiles(paths, ROOTS);
    // Stored and bound in the post's transaction: a refused post leaves no upload.
    const { result, wake } = db.transaction(() =>
      callBoardTool(db, IDENTITY, name, files.length ? { ...args, attachment_ids: files.map((f) => storeAttachment(db, IDENTITY, f).id) } : args, ctx),
    ).immediate();
    await wakeAll(wake);
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
// The first drain also brings deferred thread replies and digests: a new
// session is the natural time to see them.
let firstDrain = true;

// Claude Code drops notifications that arrive before it sends `initialized`,
// so the startup drain (and any early wakeup) waits for it.
let markInitialized!: () => void;
const initialized = new Promise<void>((r) => { markInitialized = r; });
mcp.oninitialized = () => markInitialized();

async function drainToClaude(): Promise<void> {
  await initialized;
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const batch = unreadFor(IDENTITY);
      // A human's session has no tokens to save; a DM is already waking the agent.
      const boardItems = pendingFor(db, IDENTITY, { all: firstDrain || HUMAN || batch.length > 0 });
      firstDrain = false;
      if (batch.length === 0 && boardItems.length === 0) break;
      for (const msg of batch) {
        const meta: Record<string, string> = {
          message_id: String(msg.id),
          from: msg.sender,
          created_at: String(msg.created_at),
        };
        if (msg.parent_id !== null) meta.parent_id = String(msg.parent_id);
        if (msg.attachments) meta.attachments = formatAttachmentsMeta(msg.attachments);
        if (isHuman(db, msg.sender)) meta.human = "true";
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: msg.body, meta },
        });
        setCursor(IDENTITY, msg.id);
      }
      for (const item of boardItems) {
        const params = boardNotification(item);
        if (item.kind === "push" && isHuman(db, item.post.author)) params.meta.human = "true";
        await mcp.notification({
          method: "notifications/claude/channel",
          params,
        });
        markDelivered(db, IDENTITY, item);
      }
    }
  } finally {
    draining = false;
  }
}

// Startup: refuse a duplicate identity before the MCP handshake so the client
// shows the server as failed. Then connect MCP so notifications are accepted,
// bind the wakeup socket (rechecking), and replay what arrived while offline.
if (DELIVER) await assertIdentityFree(IDENTITY);
// A tools-only server runs beside the session that owns the identity; leave its status alone.
if (DELIVER) startSession(db, IDENTITY, process.cwd());
else touchHandle(db, IDENTITY);
await mcp.connect(new StdioServerTransport());

let cleanup = () => {};
const shutdown = () => {
  try {
    touchHandle(db, IDENTITY);
  } catch {}
  cleanup();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Exit when the client goes away. Otherwise the wakeup listener keeps an
// orphan alive that holds the identity and blocks the next session.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

if (DELIVER) {
  cleanup = await listenForWakeup(IDENTITY, () => {
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
