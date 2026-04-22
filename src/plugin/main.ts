import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrayboardClient } from "./client.ts";
import type { Message, SendOk, HistoryOk, ThreadOk } from "../shared/protocol.ts";

// ── credentials ───────────────────────────────────────────────────────────────

type Credentials = { session_token: string; server: string; user_email: string };

function loadCredentials(): Credentials {
  // Env-var overrides for dev
  if (process.env.GRAYBOARD_TOKEN) {
    const server = process.env.GRAYBOARD_SERVER ?? "http://localhost:8080";
    return { session_token: process.env.GRAYBOARD_TOKEN, server, user_email: "dev" };
  }

  const credPath = process.env.GRAYBOARD_CREDENTIALS ?? join(homedir(), ".grayboard", "credentials");
  if (!existsSync(credPath)) {
    console.error(`[grayboard] credentials not found at ${credPath}. Run \`grayboard login\` first.`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(credPath, "utf8")) as Credentials;
  } catch {
    console.error(`[grayboard] failed to parse credentials at ${credPath}. Run \`grayboard login\` again.`);
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const identity = process.env.BUS_IDENTITY;
if (!identity) {
  console.error("[grayboard] BUS_IDENTITY env var is required");
  process.exit(1);
}

const creds = loadCredentials();
const serverUrl = process.env.GRAYBOARD_SERVER ?? creds.server;

const server = new McpServer({
  name: "grayboard",
  version: "0.1.0",
});

// ── channel notification helper ───────────────────────────────────────────────

function buildChannelTag(msg: Message): string {
  const attrs: Record<string, string | number> = {
    source:     "grayboard",
    message_id: msg.id,
    from:       msg.sender,
    created_at: msg.created_at,
  };
  if (msg.parent_id !== null) attrs.in_reply_to = msg.parent_id;
  if (msg.recipient_type === "team") {
    // extract team name from "team:name"
    attrs.team = msg.recipient.slice(5);
  }
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<channel ${attrStr}>${msg.body}</channel>`;
}

// ── WS client setup ───────────────────────────────────────────────────────────

const client = new GrayboardClient(
  serverUrl,
  creds.session_token,
  identity,
  (msg: Message) => {
    // Push received — notify Claude via channels protocol
    server.server.notification({
      method: "notifications/claude/channel",
      params: { content: buildChannelTag(msg) },
    });
  },
);

client.connect();

// Wait for hello_ok before registering tools (with 30s timeout)
const helloData = await Promise.race([
  client.ready(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout waiting for grayboard server")), 30_000),
  ),
]).catch((e: Error) => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
});

// ── MCP tools ─────────────────────────────────────────────────────────────────

server.tool(
  "bus_send",
  "Send a message to another identity or team on the grayboard bus",
  {
    recipient: z.string().describe("Recipient address: user@your-org.com/identity-name or team:name"),
    body:      z.string().describe("Message body (plain text, max 64 KiB)"),
    parent_id: z.number().int().optional().describe("Parent message ID to create a thread reply"),
  },
  async ({ recipient, body, parent_id }) => {
    const resp = await client.request<SendOk>({ type: "send", recipient, body, ...(parent_id ? { parent_id } : {}) });
    return {
      content: [{ type: "text", text: JSON.stringify({ message_id: resp.message_id, delivered_now: resp.delivered_now }) }],
    };
  },
);

server.tool(
  "bus_history",
  "Fetch recent message history from the grayboard bus",
  {
    peer:      z.string().optional().describe("Filter to conversation with this address"),
    limit:     z.number().int().min(1).max(200).optional().describe("Number of messages (default 20, max 200)"),
    before_id: z.number().int().optional().describe("Fetch messages before this ID (pagination)"),
  },
  async ({ peer, limit, before_id }) => {
    const resp = await client.request<HistoryOk>({ type: "history", peer, limit, before_id });
    return {
      content: [{ type: "text", text: JSON.stringify(resp.messages) }],
    };
  },
);

server.tool(
  "bus_thread",
  "Fetch a message thread (root message and all replies) from the grayboard bus",
  {
    root_id: z.number().int().describe("ID of the root message"),
  },
  async ({ root_id }) => {
    const resp = await client.request<ThreadOk>({ type: "thread", root_id });
    return {
      content: [{ type: "text", text: JSON.stringify(resp.messages) }],
    };
  },
);

// ── start stdio transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT",  () => { client.close(); process.exit(0); });
process.on("SIGTERM", () => { client.close(); process.exit(0); });
