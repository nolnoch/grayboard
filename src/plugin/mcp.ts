// Server-mode MCP server: a WSS client of the grayboard backend. `grayboard mcp`
// imports this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrayboardClient, HelloRefused } from "./client.ts";
import { ApiClient, ApiError, loadCredentials as savedCredentials, signInHint } from "../cli/api.ts";
import { isExplicitIdentity, sessionIdentity } from "../shared/identity.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import type { Message, SendOk, HistoryOk, ThreadOk, CallOk, InboxOk, HelloOk } from "../shared/protocol.ts";
import { DM_ACK_TOOL, DM_INBOX_INSTRUCTION, DM_INBOX_TOOL, DM_RETRACT_TOOL, PENDING_PARAM, ackIds, ackResult } from "../shared/inbox.ts";
import { checkBody } from "../core/boards.ts";
import { BIND_TOOL, UNBOUND_ERROR, UNBOUND_TOOLS, bindResult, mintSessionId, unboundInstruction } from "../core/bindings.ts";
import { testPause } from "../shared/testpause.ts";
import { BOARD_INSTRUCTIONS, boardNotification, boardTools, dmNotification, isBoardTool, ownHumanInstruction } from "../core/tools.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
import {
  ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL, attachRoots, checkAttachmentId, digestSha256, dispositionFilename, sha256Hex, readAttachmentFiles, saveAttachment, saveTarget, serverBusDir,
  type AttachmentLimits,
} from "../shared/attachments.ts";
import pkg from "../../package.json" with { type: "json" };

// Team boards are members-only on the server; this keeps their content from
// being relayed to non-members through DMs or open boards.
const TEAM_PRIVACY_INSTRUCTION =
  `Team boards are private to their members: don't repeat their content in DMs or posts that non-members can read unless your user asks you to.`;

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

const SESSION_ID = mintSessionId();
// A session binds a name at start only when told which (#182): an explicit
// BUS_IDENTITY, not a harness re-delivering the repo's pin. Otherwise the
// resolved name is only the first suggestion, and the session starts unbound.
const EXPLICIT = isExplicitIdentity();
const resolved = (() => {
  try {
    return normalizeIdentityName(sessionIdentity());
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
})();
// Directories this session may attach files from and save them to.
const ROOTS = attachRoots();
// BUS_PUSH=off: tools only, beside a harness plugin that owns delivery (opencode).
const PUSH = process.env.BUS_PUSH !== "off";
// A tools-only process uses the resolved name as it always has; the session
// that owns delivery runs beside it (until #182's name record).
if (!resolved.ok && (EXPLICIT || !PUSH)) {
  console.error(`[grayboard] ${resolved.error}`);
  process.exit(1);
}
const SUGGESTED = resolved.ok ? resolved.name : null;
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: tools only");
// Notifications such a session drops would still count as delivered, so it
// runs tools-only, as BUS_PUSH=off does, and what's pending waits (#71).
// Unlike local mode, such a session doesn't hold its name: a push: false
// connection is never the name's holder on the server.
const DELIVER = PUSH && !CHANNELS_OFF;
const creds = loadCredentials();
const serverUrl = process.env.GRAYBOARD_SERVER ?? creds.server;

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

// Read on each connect: after `grayboard login`, the next reconnect uses the new token.
const envToken = !!process.env.GRAYBOARD_TOKEN;
const currentToken = () => process.env.GRAYBOARD_TOKEN ?? savedCredentials()?.session_token ?? creds.session_token;

// The bus name this session holds, or null while unbound. bind() changes it.
let bound: string | null = null;
// The connection: bound's, or while unbound the read-only one (opened for
// the candidates at start, and again by the first read after a lost name).
let client: GrayboardClient | null = null;
// Set when the server refuses a read-only hello (it predates #182).
let readsUnavailable: string | null = null;
// Why this session lost its name, for the next tool result.
let lostNotice: string | null = null;

// A connection for `identity` (null: read-only). Its pushes go to the agent
// only while it's live; a client that's been replaced or refused is dead and
// hands nothing on, so its unacked messages stay queued for the name.
function connect(identity: string | null, opts: { push: boolean; create?: boolean }): GrayboardClient {
  const c: GrayboardClient = new GrayboardClient(
    serverUrl,
    currentToken,
    identity,
    async (msg: Message) => {
      const params = dmNotification(msg);
      if (await fromOwnHuman(c, msg.sender)) params.meta.human = "true";
      return notify(params);
    },
    async (item) => {
      const params = boardNotification(item);
      if (item.kind === "push" && await fromOwnHuman(c, item.post.author)) params.meta.human = "true";
      return notify(params);
    },
    opts.push,
    (running) => signInHint(serverUrl, envToken) + (running && !envToken ? "; this session reconnects by itself after that" : ""),
    { sessionId: SESSION_ID, create: opts.create, suggested: SUGGESTED, onDead: (reason) => lost(c, reason) },
  );
  c.connect();
  return c;
}

// A live client stopped for good: superseded, or refused on a reconnect. The
// session doesn't exit; it goes unbound and says why in the next tool result.
function lost(c: GrayboardClient, reason: string): void {
  if (c !== client) return;
  client = null;
  if (bound === null) return;
  lostNotice = `This session lost its bus name "${bound}" (${reason}) and is unbound now: bind(name) to take a name again.`;
  bound = null;
}

// Only a server that reserves the name sends hello_ok.human, so only there is
// that handle provably your user (an older server would let an agent take it).
const fromOwnHuman = async (c: GrayboardClient, handle: string): Promise<boolean> => handle === (await c.ready()).human?.handle;

// Keep this well under the client's own startup timeout (30s in Claude Code),
// so a stuck server is an error, not a timeout.
const helloWithin = (c: GrayboardClient): Promise<HelloOk> => Promise.race([
  c.ready(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no answer from grayboard server at ${serverUrl} within 10s`)), 10_000),
  ),
]);

const OLD_SERVER = "this grayboard server predates unbound sessions, so reads are unavailable until you bind a name; the server needs updating";

// Set when an explicit name was already held at start.
let heldAtStart: { name: string; holder: string } | undefined;
const fatal = (e: Error): never => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
};

// Wait for hello_ok before the MCP handshake, so a refused identity or an
// unreachable server shows as a failed server in the client, and so the
// instructions can carry its notices or candidates.
let hello: HelloOk | null = null;
if (!PUSH || EXPLICIT) {
  const c = connect(SUGGESTED!, { push: DELIVER, create: true });
  try {
    hello = await helloWithin(c);
    client = c;
    bound = SUGGESTED;
  } catch (e) {
    c.close();
    // A held explicit name starts the session unbound, naming the holder:
    // exiting would show the agent nothing it can act on.
    if (!(PUSH && e instanceof HelloRefused && e.code === "identity_in_use")) fatal(e as Error);
    heldAtStart = { name: SUGGESTED!, holder: (e as HelloRefused).holder ?? (e as Error).message };
  }
}
if (!bound) {
  const c = connect(null, { push: false });
  try {
    hello = await helloWithin(c);
    client = c;
  } catch (e) {
    c.close();
    if (!(e instanceof HelloRefused && e.code === "bad_request")) fatal(e as Error);
    readsUnavailable = OLD_SERVER;
  }
}
console.error(`[grayboard] server mode (${serverUrl}), session ${SESSION_ID}, ${bound ? `identity "${bound}"` : "unbound"}`);

// What a session bound to `name` is told: at start, or in bind's result.
// `general` is everything not about the name; a rebind already has it.
function boundInstructions(name: string, h: HelloOk, general: boolean): string[] {
  return [
    `You are identity "${name}" on the grayboard bus, which coordinates between agents.`,
    ...(general
      ? [
          `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [parent_id="..."]>body</channel>; reply with dm_send(to=from, body, parent_id=message_id).`,
          DM_INBOX_INSTRUCTION,
          ...BOARD_INSTRUCTIONS,
          ...(h.teams.length > 0 ? [TEAM_PRIVACY_INSTRUCTION] : []),
          ...(h.human?.linked ? ownHumanInstruction(h.human.handle) : []),
          `Handles are user@org/name; dm_send also takes a bare name, resolved the same way as @name. In a post, @name means your own identity of that name if you have one, else the one person on the board with it; @user/name or @user@org/name is exact.`,
          `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
        ]
      : []),
    // Last: variable length, so a client cut loses these, not fixed text.
    ...(h.notices ?? []),
  ];
}

// Built after hello_ok; notify waits for `initialized`, which needs it.
// Unbound: one sentence and the candidates. The rest only matters once a
// name receives anything, so bind's result carries it.
const server = new Server(
  { name: "grayboard", version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      ...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []),
      ...(bound && hello
        ? boundInstructions(bound, hello, true)
        : [unboundInstruction(hello?.candidates ?? [], heldAtStart), ...(readsUnavailable ? [`(${readsUnavailable}.)`] : [])]),
    ].join(" "),
  },
);

server.oninitialized = markInitialized;

// ── MCP tools ─────────────────────────────────────────────────────────────────

const TOOLS = [
  BIND_TOOL,
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox, dm_ack and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description:
      `dm_send(to, body, parent_id?, pending?, attachments?): message one other agent by handle (peer_list): user@org/name, or a bare name for your own identity of that name (else the one identity anyone has with it). Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting. To reach a team, board_post to its board.`,
    inputSchema: {
      type: "object",
      properties: {
        to:        { type: "string", description: "The peer's exact handle, user@your-org.com/name, as peer_list shows it." },
        body:      { type: "string", description: "Message body (plain text, max 64 KiB)" },
        parent_id: { type: "number", description: "Optional. message_id to reply to." },
        pending:   PENDING_PARAM,
        attachments: ATTACHMENTS_PARAM,
      },
      required: ["to", "body"],
    },
  },
  {
    name: "dm_history",
    description: "dm_history(peer?, limit?, before_id?): your recent direct messages, sent and received, oldest first; with peer, only those with that agent. Ones you sent have delivered: whether they've reached the recipient's session.",
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
    _meta: { "anthropic/alwaysLoad": true },
    description: "dm_thread(thread): a whole direct-message thread you're in, from its first message through every reply, ordered by id.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "number", description: "Any message_id in the thread." } },
      required: ["thread"],
    },
  },
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
  DM_RETRACT_TOOL,
  ATTACHMENT_GET_TOOL,
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
  if (lostNotice) out.push(lostNotice);
  lostNotice = null;
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
  if (name === "bind") return bind(a);
  if (!bound && !UNBOUND_TOOLS.has(name)) return { ...text(`error: ${UNBOUND_ERROR}`), isError: true };
  try {
    const client = await connection();
    const me = bound;
    if (isBoardTool(name)) {
      const { attachments: paths, ...args } = a;
      if (paths !== undefined && name === "board_post") checkBody(args.body);
      const { result } = await withUploads(client, me, paths, (ids) =>
        client.request<CallOk>({ type: "call", tool: name, args: ids.length ? { ...args, attachment_ids: ids } : args }),
      );
      return text(result);
    }
    if (name === "dm_send") {
      if (a.attachments !== undefined) checkBody(a.body);
      const { type: _t, req_id: _r, ...rest } = await withUploads(client, me, a.attachments, (ids) =>
        client.request<SendOk>({
          type: "send",
          recipient: a.to,
          body: a.body,
          ...(a.parent_id !== undefined ? { parent_id: a.parent_id } : {}),
          ...(a.pending === true ? { pending: true } : {}),
          ...(ids.length ? { attachment_ids: ids } : {}),
        }),
      );
      // A server from before pending ignores the field, which would lose the promise silently.
      if (a.pending === true && !rest.pending) {
        rest.note = `${rest.note ? `${rest.note} ` : ""}Sent, but this server doesn't record pending, so dm_inbox won't list the promise; the server needs updating.`;
      }
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
      // One frame per id, so the server needs no new protocol.
      const ids = ackIds(a.message_id);
      if (!ids) return { ...text("error: message_id must be a message_id or a list of them"), isError: true };
      const acked: number[] = [], missing: number[] = [];
      for (const id of ids) {
        try { await client.request({ type: "dm_ack", message_id: id }); acked.push(id); } catch (e) {
          if (!(e as Error).message.startsWith("not_found:")) throw e;
          missing.push(id);
        }
      }
      const r = ackResult(acked, missing);
      return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
    }
    if (name === "dm_retract") {
      await client.request({ type: "dm_retract", message_id: a.message_id });
      return text("ok");
    }
    if (name === "dm_thread") {
      return text((await client.request<ThreadOk>({ type: "thread", message_id: a.thread })).messages);
    }
    if (name === "attachment_get") {
      const id = checkAttachmentId(a.id);
      const limits = attachmentLimits(client);
      const target = await saveTarget(a.dir, ROOTS, serverBusDir(serverUrl));
      const { res, data } = await api().download(`/api/attachments/${id}?identity=${encodeURIComponent(me!)}`, limits.file);
      // Checked before anything is saved: the bytes must be the ones the server stored.
      const sha256 = sha256Hex(data);
      const want = digestSha256(res.headers.get("repr-digest"));
      if (!want) throw new Error(`attachment ${id}: the server sent no digest; it needs updating`);
      if (want !== sha256) throw new Error(`attachment ${id}: the bytes received don't match the server's sha256`);
      const info = {
        id,
        filename: dispositionFilename(res.headers.get("content-disposition")) ?? "file",
        type: res.headers.get("content-type") ?? "application/octet-stream",
        size: data.length,
        sha256,
      };
      const path = await saveAttachment(info, data, target);
      return text({ path, filename: info.filename, type: info.type, size: info.size, sha256 });
    }
    return { ...text(`error: unknown tool: ${name}`), isError: true };
  } catch (e) {
    if (e instanceof SendLanded) return text({ sent: true, attachment_ids: e.attachments, note: e.message });
    // The HTTP API (attachments) refused the token, as a WS hello would have.
    if (e instanceof ApiError && e.status === 401) return { ...text(`error: ${signInHint(serverUrl, envToken)}`), isError: true };
    // Server errors arrive as "code: message"; show them to the agent.
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
}

// The server's HTTP API as this session's user, with the current token.
const api = () => new ApiClient(serverUrl, currentToken());

// The live connection's attachment limits, which every hello_ok (a reconnect's
// too) carries. A server from before attachments sends none.
function attachmentLimits(client: GrayboardClient): AttachmentLimits {
  const limits = client.assertConnected().attachment_limits;
  if (!limits) throw new Error("this server doesn't take attachments; it needs updating");
  return limits;
}

// Reads and checks the files an agent named (all before any is sent), uploads
// each as identity `me` (null: unbound, so there's nothing to upload as), and runs `send` with their ids; the server checks
// them again and binds them to that dm_send or board_post. Uploads go only
// over a live connection, and if any upload or the send fails, the ones made
// are released, so a refused send doesn't hold the user's unsent quota.
async function withUploads<T>(client: GrayboardClient, me: string | null, paths: unknown, send: (ids: number[]) => Promise<T>): Promise<T> {
  if (paths === undefined) return send([]);
  if (me === null) throw new Error(UNBOUND_ERROR);
  const files = await readAttachmentFiles(paths, ROOTS, { limits: attachmentLimits(client) });
  client.assertConnected();
  const ids: number[] = [];
  let sent = false;
  try {
    for (const f of files) {
      const q = `identity=${encodeURIComponent(me)}&filename=${encodeURIComponent(f.filename)}`;
      ids.push(((await api().upload(`/api/attachments?${q}`, f.data)) as { id: number }).id);
    }
    sent = true;
    return await send(ids);
  } catch (e) {
    const landed = await releaseUploads(me, ids);
    // A send binds all its files in one transaction or none: if every one is
    // bound, the send landed and only its answer was lost.
    if (sent && ids.length && landed === ids.length) throw new SendLanded(ids, e as Error);
    throw e;
  }
}

// Releases uploads a failed send left unbound. Returns how many the server
// says are no longer unsent: bound after all (the answer was lost, not the send).
async function releaseUploads(me: string, ids: number[]): Promise<number> {
  let bound = 0;
  for (const id of ids) {
    try {
      await api().del(`/api/attachments/${id}?identity=${encodeURIComponent(me)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        bound++;
        continue;
      }
      console.error(`[grayboard] couldn't release upload ${id} (it expires in an hour): ${(e as Error).message}`);
    }
  }
  return bound;
}

// A send whose answer was lost, though the server bound its attachments.
class SendLanded extends Error {
  constructor(readonly attachments: number[], cause: Error) {
    super(`sent, but the server's answer was lost (${cause.message}); its attachments (${attachments.join(", ")}) are bound to it. Don't send it again; dm_history or board_read shows it.`);
  }
}

// The connection a tool call goes over: the bound one, or while unbound the
// read-only one, opened again if a lost name closed it.
async function connection(): Promise<GrayboardClient> {
  if (client) return client;
  if (readsUnavailable) throw new Error(readsUnavailable);
  const c = connect(null, { push: false });
  client = c;
  try {
    await helloWithin(c);
    return c;
  } catch (e) {
    if (client === c) client = null;
    c.close();
    if (e instanceof HelloRefused && e.code === "bad_request") readsUnavailable = OLD_SERVER;
    throw new Error(readsUnavailable ?? (e as Error).message);
  }
}

// bind(name, create?): take a name, or move to another (#182). A fresh
// connection says hello for the new name; only once the server accepts it
// (moving this session's claims) is the old connection marked dead and
// closed, so it can't reconnect and re-register the old name. A DM pushed to
// the old connection after that is never acked: it stays queued for the old
// name's next holder, never consumed under the new one.
let binding = false;
async function bind(a: Record<string, unknown>) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  if (!PUSH) return fail("this grayboard process is tools-only (BUS_PUSH=off); its name comes from the session that owns delivery");
  const n = normalizeIdentityName(String(a.name));
  if (!n.ok) return fail(n.error);
  if (n.name === bound) return text(`already bound to "${n.name}"`);
  if (binding) return fail("another bind is in progress");
  binding = true;
  try {
    const previous = bound;
    const next = connect(n.name, { push: DELIVER, create: a.create === true });
    let h: HelloOk;
    try {
      h = await helloWithin(next);
    } catch (e) {
      next.close();
      return fail((e as Error).message);
    }
    testPause("bind:after-acquire");
    const old = client;
    client = next;
    bound = n.name;
    lostNotice = null;
    old?.close();
    console.error(`[grayboard] session ${SESSION_ID} bound "${n.name}"${previous ? ` (was "${previous}")` : ""}`);
    return text(bindResult(n.name, previous, h.moved ?? [], boundInstructions(n.name, h, previous === null)));
  } finally {
    binding = false;
  }
}

// ── start stdio transport ─────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());

const shutdown = () => { client?.close(); process.exit(0); };
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
// Exit when the MCP client goes away, so an orphan can't keep holding the identity.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
