// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CoreError, age, lastSeen, markDelivered, pendingFor, rosterHandles, startSession, touchHandle } from "../core/boards.ts";
import { claimExpiryTimer, listClaims } from "../core/claims.ts";
import {
  BOARD_INSTRUCTIONS,
  claimsInstruction,
  boardNotification,
  boardTools,
  callBoardTool,
  isBoardTool,
} from "../core/tools.ts";
import {
  ackMessage,
  db,
  getHistory,
  getMessage,
  getThread,
  insertMessage,
  receivedUnacked,
  setCursor,
  undeliveredFrom,
  type Message,
  unreadFor,
} from "./db.ts";
import { assertIdentityFree, listenForWakeup, poke } from "./wakeup.ts";
import { sessionIdentity } from "../shared/identity.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
import {
  DM_ACK_TOOL,
  DM_INBOX_INSTRUCTION,
  DM_INBOX_TOOL,
  STALE_UNDELIVERED_MS,
  inboxDays,
  unanswered,
  undeliveredInstruction,
} from "../shared/inbox.ts";
import pkg from "../../package.json" with { type: "json" };

const IDENTITY: string = sessionIdentity();
console.error(`[grayboard] local mode, identity "${IDENTITY}"`);

// BUS_PUSH=off: tools only. For harnesses without Claude channels, where a
// separate adapter owns the wakeup socket and delivery. Draining here would
// consume messages into a void.
const PUSH = process.env.BUS_PUSH !== "off";
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: pushes are off");

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
      ...claimsInstruction(listClaims(db)),
      ...undeliveredInstruction(undeliveredFrom(IDENTITY, Date.now() - STALE_UNDELIVERED_MS), (h) => lastSeen(db, h)),
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
    ].join(" "),
  },
);

// Tool discovery

const TOOLS = [
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description: `dm_send(to, body, parent_id?): message one other agent by exact handle (peer_list). You are "${IDENTITY}". Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting.`,
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
    const { to: recipient, body, parent_id } = a as {
      to: string;
      body: string;
      parent_id?: number;
    };
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
    const id = insertMessage(IDENTITY, recipient, body, parent_id ?? null);
    const delivered = await poke(recipient);
    if (delivered) return text(JSON.stringify({ message_id: id, delivered_now: true, note: "Recipient was online; pushed." }));
    const seen = lastSeen(db, recipient);
    return text(JSON.stringify({
      message_id: id,
      delivered_now: false,
      note: "Recipient offline; will be delivered on their next session.",
      ...(seen ? { recipient_last_seen: `${age(Date.now() - seen)} ago` } : {}),
      undelivered_from_you: undeliveredFrom(IDENTITY).find((u) => u.recipient === recipient)?.n ?? 1,
    }));
  }

  if (name === "dm_history") {
    const lim = Math.min(Math.max(a.limit ?? 20, 1), 200);
    return text(getHistory(IDENTITY, a.peer, lim, a.before_id));
  }

  if (name === "dm_thread") {
    if (!mine(getMessage(a.thread))) {
      return { ...text(`error: message ${a.thread} not found`), isError: true };
    }
    return text(getThread(a.thread).filter(mine));
  }

  if (name === "dm_inbox") {
    const since = Date.now() - inboxDays(a.days) * 86_400_000;
    const owed = unanswered(IDENTITY, receivedUnacked(IDENTITY, since), getThread);
    const queued = undeliveredFrom(IDENTITY).map((u) => {
      const seen = lastSeen(db, u.recipient);
      return { to: u.recipient, n: u.n, oldest_id: u.oldest_id, ...(seen ? { last_seen: `${age(Date.now() - seen)} ago` } : {}) };
    });
    return text({ unanswered: owed, ...(queued.length ? { undelivered_from_you: queued } : {}) });
  }

  if (name === "dm_ack") {
    const m = typeof a.id === "number" ? getMessage(a.id) : undefined;
    if (!m || m.recipient !== IDENTITY) {
      return { ...text(`error: no message ${a.id} to you; dm_inbox lists them`), isError: true };
    }
    ackMessage(IDENTITY, m.id);
    return text("ok");
  }

  if (isBoardTool(name)) {
    const ctx = name === "peer_list" ? { online: await liveHandles() } : {};
    const { result, wake } = callBoardTool(db, IDENTITY, name, a, ctx);
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
      const boardItems = pendingFor(db, IDENTITY);
      if (batch.length === 0 && boardItems.length === 0) break;
      for (const msg of batch) {
        const meta: Record<string, string> = {
          message_id: String(msg.id),
          from: msg.sender,
          created_at: String(msg.created_at),
        };
        if (msg.parent_id !== null) meta.parent_id = String(msg.parent_id);
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: msg.body, meta },
        });
        setCursor(IDENTITY, msg.id);
      }
      for (const item of boardItems) {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: boardNotification(item),
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
if (PUSH) await assertIdentityFree(IDENTITY);
// A tools-only server runs beside the session that owns the identity; leave its status alone.
if (PUSH) startSession(db, IDENTITY, process.cwd());
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

if (PUSH) {
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
