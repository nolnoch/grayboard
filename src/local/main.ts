#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getHistory,
  getMessage,
  getThread,
  insertMessage,
  setCursor,
  unreadFor,
} from "./db.ts";
import { listenForWakeup, poke } from "./wakeup.ts";

const rawIdentity = process.env.BUS_IDENTITY;
if (!rawIdentity) {
  throw new Error(
    "grayboard: BUS_IDENTITY env var is required (e.g. BUS_IDENTITY=fe)",
  );
}
const IDENTITY: string = rawIdentity;

const mcp = new Server(
  { name: "grayboard", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `You are identity "${IDENTITY}" on the grayboard bus, which coordinates between Claude instances.`,
      `Incoming peer messages arrive as <channel source="grayboard" message_id="..." from="..." [in_reply_to="..."]>body</channel>.`,
      `To send: call bus_send with recipient (peer identity) and body; add parent_id to thread.`,
      `To catch up without waiting for a push, call bus_history. For a full thread, call bus_thread.`,
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
    ].join(" "),
  },
);

// Tool discovery

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bus_send",
      description: `Send a message to another Claude instance over the grayboard bus. You are "${IDENTITY}". Delivered to the peer immediately if they're online, or queued until their next session.`,
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
        "List recent messages you are involved in (as sender or recipient), optionally filtered by peer. Returns chronological order.",
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
        "Return a root message and all its descendants (replies of replies), ordered by id.",
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
  ],
}));

// Tool dispatch

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "bus_send") {
    const { recipient, body, parent_id } = args as {
      recipient: string;
      body: string;
      parent_id?: number;
    };
    if (parent_id !== undefined && !getMessage(parent_id)) {
      return {
        content: [
          { type: "text", text: `error: parent_id ${parent_id} does not exist` },
        ],
        isError: true,
      };
    }
    const id = insertMessage(IDENTITY, recipient, body, parent_id ?? null);
    const delivered = await poke(recipient);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message_id: id,
            delivered_now: delivered,
            note: delivered
              ? "Recipient was online; pushed."
              : "Recipient offline; will be delivered on their next session.",
          }),
        },
      ],
    };
  }

  if (name === "bus_history") {
    const { peer, limit, before_id } = args as {
      peer?: string;
      limit?: number;
      before_id?: number;
    };
    const lim = Math.min(Math.max(limit ?? 20, 1), 200);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(getHistory(IDENTITY, peer, lim, before_id), null, 2),
        },
      ],
    };
  }

  if (name === "bus_thread") {
    const { root_id } = args as { root_id: number };
    return {
      content: [{ type: "text", text: JSON.stringify(getThread(root_id), null, 2) }],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

// Drain: emit any unread messages for this identity as channel notifications.
// Loop until empty so concurrent writes that race past a single query still
// get picked up. Re-entry is guarded; crashed drains re-deliver (at-least-once).
let draining = false;

async function drainToClaude(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const batch = unreadFor(IDENTITY);
      if (batch.length === 0) break;
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
    }
  } finally {
    draining = false;
  }
}

// Startup: connect MCP first so notifications are accepted, then bind the
// wakeup socket, then replay anything that arrived while we were offline.
await mcp.connect(new StdioServerTransport());

const cleanup = listenForWakeup(IDENTITY, () => {
  drainToClaude().catch((err) => {
    console.error("grayboard drain error:", err);
  });
});

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

drainToClaude().catch((err) => {
  console.error("grayboard initial drain error:", err);
});
