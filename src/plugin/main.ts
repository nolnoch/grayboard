import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrayboardClient } from "./client.ts";
import type { Message, SendOk, HistoryOk, ThreadOk, CallOk } from "../shared/protocol.ts";
import { BOARD_INSTRUCTIONS, boardNotification, boardTools, isBoardTool } from "../core/tools.ts";
import pkg from "../../package.json" with { type: "json" };

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

const server = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `You are identity "${identity}" on the grayboard bus, which coordinates between agents.`,
      `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [in_reply_to="..."]>body</channel>.`,
      ...BOARD_INSTRUCTIONS,
      `Handles are user@org/name. In a post, @name means your own identity of that name if you have one, else the one person on the board with it; @user/name or @user@org/name is exact.`,
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
    ].join(" "),
  },
);

// ── WS client setup ───────────────────────────────────────────────────────────

const notify = (params: { content: string; meta: Record<string, string> }) =>
  server.notification({ method: "notifications/claude/channel", params });

const client = new GrayboardClient(
  serverUrl,
  creds.session_token,
  identity,
  (msg: Message) => {
    const meta: Record<string, string> = {
      message_id: String(msg.id),
      from:       msg.sender,
      created_at: String(msg.created_at),
    };
    if (msg.parent_id !== null) meta.in_reply_to = String(msg.parent_id);
    void notify({ content: msg.body, meta });
  },
  (item) => notify(boardNotification(item)),
);

client.connect();

// Wait for hello_ok before the MCP handshake, so a refused identity or an
// unreachable server shows as a failed server in the client. Keep this well
// under the client's own startup timeout (30s in Claude Code) so it's an
// error, not a timeout.
await Promise.race([
  client.ready(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no answer from grayboard server at ${serverUrl} within 10s`)), 10_000),
  ),
]).catch((e: Error) => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
});

// ── MCP tools ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bus_send",
      description:
        `Send a direct message to another agent. You are "${identity}". Delivered now if they're online, or queued until their next session. ` +
        `team:<name> posts to that team's board instead (same as board_post).`,
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string", description: "user@your-org.com/identity-name, or team:name" },
          body:      { type: "string", description: "Message body (plain text, max 64 KiB)" },
          parent_id: { type: "number", description: "Optional. message_id (or post_id, for team:) to reply to." },
        },
        required: ["recipient", "body"],
      },
    },
    {
      name: "bus_history",
      description: "List recent direct messages you are involved in, optionally filtered by peer.",
      inputSchema: {
        type: "object",
        properties: {
          peer:      { type: "string", description: "Optional. Only messages with this address." },
          limit:     { type: "number", description: "Max messages (default 20, max 200)." },
          before_id: { type: "number", description: "Return messages older than this id (pagination)." },
        },
      },
    },
    {
      name: "bus_thread",
      description: "Return a root direct message and all its replies, ordered by id.",
      inputSchema: {
        type: "object",
        properties: { root_id: { type: "number", description: "message_id of the root message." } },
        required: ["root_id"],
      },
    },
    ...boardTools({ teams: true }),
  ],
}));

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, unknown>;
  try {
    if (isBoardTool(name)) {
      return text((await client.request<CallOk>({ type: "call", tool: name, args: a })).result);
    }
    if (name === "bus_send") {
      const { type: _t, req_id: _r, ...rest } = await client.request<SendOk>({
        type: "send",
        recipient: a.recipient,
        body: a.body,
        ...(a.parent_id !== undefined ? { parent_id: a.parent_id } : {}),
      });
      return text(rest);
    }
    if (name === "bus_history") {
      const resp = await client.request<HistoryOk>({ type: "history", peer: a.peer, limit: a.limit, before_id: a.before_id });
      return text(resp.messages);
    }
    if (name === "bus_thread") {
      return text((await client.request<ThreadOk>({ type: "thread", root_id: a.root_id })).messages);
    }
    return { ...text(`error: unknown tool: ${name}`), isError: true };
  } catch (e) {
    // Server errors arrive as "code: message"; show them to the agent.
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
});

// ── start stdio transport ─────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());

const shutdown = () => { client.close(); process.exit(0); };
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
// Exit when the MCP client goes away, so an orphan can't keep holding the identity.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
