// Server-mode MCP server: a WSS client of the grayboard backend. `grayboard mcp`
// imports this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrayboardClient } from "./client.ts";
import { sessionIdentity } from "../shared/identity.ts";
import type { Message, SendOk, HistoryOk, ThreadOk, CallOk, InboxOk, HelloOk } from "../shared/protocol.ts";
import { DM_ACK_TOOL, DM_INBOX_INSTRUCTION, DM_INBOX_TOOL } from "../shared/inbox.ts";
import { BOARD_INSTRUCTIONS, boardNotification, boardTools, isBoardTool } from "../core/tools.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
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
  const raw = readFileSync(credPath, "utf8");
  if (!raw.trim()) {
    console.error("[grayboard] signed out. Run `grayboard login`, or `grayboard setup --local` to use local mode.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as Credentials;
  } catch {
    console.error(`[grayboard] failed to parse credentials at ${credPath}. Run \`grayboard login\` again.`);
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const identity = sessionIdentity();
// BUS_PUSH=off: tools only, beside a harness plugin that owns delivery (opencode).
const PUSH = process.env.BUS_PUSH !== "off";
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: pushes are off");
const creds = loadCredentials();
const serverUrl = process.env.GRAYBOARD_SERVER ?? creds.server;
console.error(`[grayboard] server mode (${serverUrl}), identity "${identity}"`);

// ── WS client setup ───────────────────────────────────────────────────────────

// The server sends what's queued right after hello_ok, before Claude Code has
// finished the MCP handshake, and Claude Code drops notifications that arrive
// before it sends `initialized`. Hold pushes until then; they're acked only
// once sent.
let markInitialized!: () => void;
const initialized = new Promise<void>((r) => { markInitialized = r; });
const notify = async (params: { content: string; meta: Record<string, string> }): Promise<void> => {
  await initialized;
  await server.notification({ method: "notifications/claude/channel", params });
};

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
    if (msg.parent_id !== null) meta.parent_id = String(msg.parent_id);
    return notify({ content: msg.body, meta });
  },
  (item) => notify(boardNotification(item)),
  PUSH,
);

client.connect();

// Wait for hello_ok before the MCP handshake, so a refused identity or an
// unreachable server shows as a failed server in the client, and so the
// instructions can carry its notices. Keep this well under the client's own
// startup timeout (30s in Claude Code) so it's an error, not a timeout.
const hello: HelloOk = await Promise.race([
  client.ready(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no answer from grayboard server at ${serverUrl} within 10s`)), 10_000),
  ),
]).catch((e: Error) => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
});

// Built after hello_ok; notify waits for `initialized`, which needs it.
const server = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      ...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []),
      `You are identity "${identity}" on the grayboard bus, which coordinates between agents.`,
      `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [parent_id="..."]>body</channel>; reply with dm_send(to=from, body, parent_id=message_id).`,
      DM_INBOX_INSTRUCTION,
      ...BOARD_INSTRUCTIONS,
      ...(hello.notices ?? []),
      `Handles are user@org/name. In a post, @name means your own identity of that name if you have one, else the one person on the board with it; @user/name or @user@org/name is exact.`,
      `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
    ].join(" "),
  },
);

server.oninitialized = markInitialized;

// ── MCP tools ─────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description:
      `dm_send(to, body, parent_id?): message one other agent by exact handle (peer_list). You are "${identity}". Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting. To reach a team, board_post to its board.`,
    inputSchema: {
      type: "object",
      properties: {
        to:        { type: "string", description: "The peer's exact handle, user@your-org.com/name, as peer_list shows it." },
        body:      { type: "string", description: "Message body (plain text, max 64 KiB)" },
        parent_id: { type: "number", description: "Optional. message_id to reply to." },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "dm_history",
    description: "dm_history(peer?, limit?, before_id?): your recent direct messages, sent and received; with peer, only those with that agent. Ones you sent have delivered: whether they've reached the recipient's session.",
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
    name: "dm_thread",
    description: "dm_thread(thread): a whole direct-message thread you're in, from its first message through every reply, ordered by id.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "number", description: "Any message_id in the thread." } },
      required: ["thread"],
    },
  },
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
...boardTools({ teams: true }),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const r = await call(name, args as Record<string, unknown>);
  const extra = notices();
  return extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text" as const, text }))] } : r;
});

async function call(name: string, a: Record<string, unknown>) {
  const bad = checkArgs(TOOLS, name, a);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  try {
    if (isBoardTool(name)) {
      return text((await client.request<CallOk>({ type: "call", tool: name, args: a })).result);
    }
    if (name === "dm_send") {
      const { type: _t, req_id: _r, ...rest } = await client.request<SendOk>({
        type: "send",
        recipient: a.to,
        body: a.body,
        ...(a.parent_id !== undefined ? { parent_id: a.parent_id } : {}),
      });
      return text(rest);
    }
    if (name === "dm_history") {
      const resp = await client.request<HistoryOk>({ type: "history", peer: a.peer, limit: a.limit, before_id: a.before_id });
      return text(resp.messages);
    }
    if (name === "dm_inbox") {
      const { type: _t, req_id: _r, ...rest } = await client.request<InboxOk>({ type: "inbox", days: a.days });
      return text(rest);
    }
    if (name === "dm_ack") {
      await client.request({ type: "dm_ack", message_id: a.id });
      return text("ok");
    }
    if (name === "dm_thread") {
      return text((await client.request<ThreadOk>({ type: "thread", message_id: a.thread })).messages);
    }
    return { ...text(`error: unknown tool: ${name}`), isError: true };
  } catch (e) {
    // Server errors arrive as "code: message"; show them to the agent.
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
}

// ── start stdio transport ─────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());

const shutdown = () => { client.close(); process.exit(0); };
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
// Exit when the MCP client goes away, so an orphan can't keep holding the identity.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
