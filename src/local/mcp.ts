// Local-mode MCP server: SQLite + Unix-socket wakeup. `grayboard mcp` imports
// this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CoreError, markDelivered, pendingFor, rosterHandles, touchHandle } from "../core/boards.ts";
import {
  BOARD_INSTRUCTIONS,
  boardNotification,
  boardTools,
  callBoardTool,
  isBoardTool,
} from "../core/tools.ts";
import {
  db,
  getHistory,
  getMessage,
  getThread,
  insertMessage,
  setCursor,
  unreadFor,
} from "./db.ts";
import { assertIdentityFree, listenForWakeup, poke } from "./wakeup.ts";
import { sessionIdentity } from "../shared/identity.ts";
import pkg from "../../package.json" with { type: "json" };

const IDENTITY: string = sessionIdentity();
console.error(`[grayboard] local mode, identity "${IDENTITY}"`);

// BUS_PUSH=off: tools only. For harnesses without Claude channels, where a
// separate adapter owns the wakeup socket and delivery. Draining here would
// consume messages into a void.
const PUSH = process.env.BUS_PUSH !== "off";

const mcp = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `You are identity "${IDENTITY}" on the grayboard bus, which coordinates between agents.`,
      `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [in_reply_to="..."]>body</channel>.`,
      ...BOARD_INSTRUCTIONS,
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
    ].join(" "),
  },
);

// Tool discovery

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bus_send",
      description: `Send a direct message to another agent over the grayboard bus. You are "${IDENTITY}". Delivered to the peer immediately if they're online, or queued until their next session.`,
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: 'Peer identity to send to, e.g. "be", "fe", "sim".',
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
        required: ["recipient", "body"],
      },
    },
    {
      name: "bus_history",
      description:
        "List recent direct messages you are involved in (as sender or recipient), optionally filtered by peer. Returns chronological order.",
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
      name: "bus_thread",
      description:
        "Return a root direct message and all its descendants (replies of replies), ordered by id.",
      inputSchema: {
        type: "object",
        properties: {
          root_id: {
            type: "number",
            description: "message_id of the root message to expand.",
          },
        },
        required: ["root_id"],
      },
    },
    ...boardTools({ teams: false }),
  ],
}));

// Tool dispatch

const text = (value: unknown) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

async function wakeAll(handles: string[]): Promise<void> {
  await Promise.all(handles.map((h) => poke(h)));
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  touchHandle(db, IDENTITY);
  try {
    return await dispatch(name, args as Record<string, any>);
  } catch (err) {
    if (err instanceof CoreError) {
      return { ...text(`error: ${err.message}`), isError: true };
    }
    throw err;
  }
});

async function dispatch(name: string, a: Record<string, any>) {
  if (name === "bus_send") {
    const { recipient, body, parent_id } = a as {
      recipient: string;
      body: string;
      parent_id?: number;
    };
    if (parent_id !== undefined && !getMessage(parent_id)) {
      return {
        ...text(`error: parent_id ${parent_id} does not exist`),
        isError: true,
      };
    }
    const id = insertMessage(IDENTITY, recipient, body, parent_id ?? null);
    const delivered = await poke(recipient);
    return text(
      JSON.stringify({
        message_id: id,
        delivered_now: delivered,
        note: delivered
          ? "Recipient was online; pushed."
          : "Recipient offline; will be delivered on their next session.",
      }),
    );
  }

  if (name === "bus_history") {
    const lim = Math.min(Math.max(a.limit ?? 20, 1), 200);
    return text(getHistory(IDENTITY, a.peer, lim, a.before_id));
  }

  if (name === "bus_thread") {
    return text(getThread(a.root_id));
  }

  if (isBoardTool(name)) {
    const ctx = name === "who" ? { online: await liveHandles() } : {};
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

async function drainToClaude(): Promise<void> {
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
        if (msg.parent_id !== null) meta.in_reply_to = String(msg.parent_id);
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
touchHandle(db, IDENTITY);
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
    drainToClaude().catch((err) => {
      console.error("grayboard drain error:", err);
    });
  });

  drainToClaude().catch((err) => {
    console.error("grayboard initial drain error:", err);
  });
}
