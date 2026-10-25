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
import type { AckOk, Message, SendOk, DelegateOk, HistoryOk, ThreadOk, CallOk, InboxOk, HelloOk } from "../shared/protocol.ts";
import { WRITE_DEDUP_WINDOW_TEXT } from "../shared/dedup.ts";
import { ackIds, ackResult } from "../shared/inbox.ts";
import { checkBody } from "../core/boards.ts";
import {
  UNBOUND_ERROR, UNBOUND_TOOLS, bindMissed, bindOk, bindTarget, boundInstructions, heldNote, idAddress, launcherNote, oldServerBindNote, restoreNote, sessionKeyFromEnv, unboundInstruction,
} from "../core/bindings.ts";
import { dropUnboundRecord, freshRecord, sweepRecords, writeRecord } from "../shared/namerecord.ts";
import { launcherName } from "../shared/proc.ts";
import { SERVER_TOOLS } from "./tools.ts";
import { sockDir } from "../shared/sockdir.ts";
import { LateCancels } from "../shared/latecancel.ts";
import { testPause } from "../shared/testpause.ts";
import { BindGate } from "../shared/bindgate.ts";
import { boardNotification, dmNotification, isBoardTool, ownHumanInstruction } from "../core/tools.ts";
import { CHANNELS_OFF_NOTICE, channelsOff, checkArgs, parentCommandLine, updateNotice } from "../shared/toolguard.ts";
import {
  attachRoots, checkAttachmentId, digestSha256, dispositionFilename, readAttachmentFiles, saveAttachment, saveTarget, serverBusDir,
  type AttachmentLimits,
} from "../shared/attachments.ts";
import { sha256Hex } from "../shared/hash.ts";
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

// The secret the server derives this session's ID from (#182 audit 4):
// BUS_SESSION_KEY when an orchestrator minted it, so it knows the ID first (#284).
const SESSION_KEY = (() => {
  try {
    return sessionKeyFromEnv();
  } catch (e) {
    console.error(`[grayboard] ${(e as Error).message}`);
    process.exit(1);
  }
})();
const SESSION_ID = idAddress(SESSION_KEY);
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
// BUS_PUSH=off: tools only, for a harness without an adapter.
const PUSH = process.env.BUS_PUSH !== "off";
// A tools-only process (a harness without an adapter) uses the resolved name
// as it always has, without acquiring it.
if (!resolved.ok && (EXPLICIT || !PUSH)) {
  console.error(`[grayboard] ${resolved.error}`);
  process.exit(1);
}
const SUGGESTED = resolved.ok ? resolved.name : null;
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: tools only");
// Notifications such a session drops would still count as delivered, so it
// gets no pushes, as BUS_PUSH=off does, and what's pending waits (#71). It
// still holds its name, as in local mode (decision 9): its connections say
// hold (#182 audit 2).
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
// A bind whose result never reached the agent (it timed out, or was
// cancelled) but that completed, for the next tool result.
let missedBindNotice: string | null = null;
// The name changed without a bind result saying so (a missed bind, a lost
// name): the next tool result carries the instructions for the name now, as
// a bind result does, for adapters that keep them in the system prompt.
let instructionsStale = false;
// The hello_ok of the bound connection, for its instructions.
let boundHello: HelloOk | null = null;

// A connection for `identity` (null: read-only). Its pushes go to the agent
// only while it's live; a client that's been replaced or refused is dead and
// hands nothing on, so its unacked messages stay queued for the name.
function connect(identity: string | null, opts: { push: boolean; create?: boolean; restoredFrom?: string; from?: string }): GrayboardClient {
  const c: GrayboardClient = new GrayboardClient(
    serverUrl,
    currentToken,
    identity,
    SESSION_KEY,
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
    {
      hold: identity !== null && CHANNELS_OFF, from: opts.from, create: opts.create, suggested: SUGGESTED,
      restoredFrom: opts.restoredFrom, onDead: (reason) => lost(c, reason), launcher: process.env.BUS_LAUNCHER === "1",
    },
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
  console.error(`[grayboard] session ${SESSION_ID} lost "${bound}": ${reason}`);
  lostNotice = `This session lost its bus name "${bound}" (${reason}) and is unbound now: bind(name) to take a name again.`;
  bound = null;
  instructionsStale = true;
  writeName(null);
}

// Only a server that reserves the name sends hello_ok.human, so only there is
// that handle provably your user (an older server would let an agent take it).
const fromOwnHuman = async (c: GrayboardClient, handle: string): Promise<boolean> => handle === (await c.ready()).human?.handle;

// No hello_ok in time: the connection may still get one.
class HelloTimeout extends Error {}

// Keep this well under the client's own startup timeout (30s in Claude Code),
// so a stuck server is an error, not a timeout. BUS_TEST_HELLO_MS shortens it
// for tests.
const HELLO_MS = Number(process.env.BUS_TEST_HELLO_MS) || 10_000;
// While the server rate-limits the hello, wait longer, still under that 30s
// (#210). BUS_TEST_HELLO_LIMITED_MS shortens it for tests.
const HELLO_LIMITED_MS = Number(process.env.BUS_TEST_HELLO_LIMITED_MS) || 25_000;
// Startup is one window, whatever it takes: a restore's retries, then an
// unbound hello, all count against the same absolute deadline.
const STARTUP_LIMITED_BY = Date.now() + HELLO_LIMITED_MS;
// Wait for hello_ok: HELLO_MS, or while the server rate-limits this client,
// until `limitedBy` (an absolute time). Neither passes `limitedBy`.
const helloWithin = (c: GrayboardClient, limitedBy: number): Promise<HelloOk> => {
  let timer: Timer | undefined;
  const start = Date.now();
  const deadline = new Promise<never>((_, reject) => {
    const check = () => {
      const limited = c.rateLimited();
      const left = limitedBy - Date.now();
      // Waited out only when the next try fits the window.
      if (limited && left > 0 && limited.retryAt <= limitedBy) return void (timer = setTimeout(check, Math.min(1000, left)));
      reject(new HelloTimeout(limited
        ? `the grayboard server at ${serverUrl} is rate-limiting ${limited.what} (${limited.message}); gave up after ${Math.round((Date.now() - start) / 1000)}s`
        : `no answer from grayboard server at ${serverUrl} within ${Math.round((Date.now() - start) / 1000)}s`));
    };
    timer = setTimeout(check, Math.max(0, Math.min(HELLO_MS, limitedBy - start)));
  });
  return Promise.race([c.ready(), deadline]).finally(() => clearTimeout(timer));
};

const OLD_SERVER = "this grayboard server predates unbound sessions, so reads are unavailable until you bind a name; the server needs updating";
// A bad_request on a read-only hello is taken for an old server; its message
// is logged, so another cause shows.
function readOnlyRefused(e: HelloRefused): void {
  console.error(`[grayboard] the server refused a read-only hello (${e.message}); taking it for a server from before unbound sessions`);
  readsUnavailable = OLD_SERVER;
}

// Why this session started unbound, for its instructions.
const unboundNotes: string[] = [];
const fatal = (e: Error): never => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
};

// The name record (#182 decision 14), written by the session that owns
// delivery whenever its name changes, so a restart under the same harness
// takes the name back.
const RECORD_DIR = sockDir();
// A failed write costs only the restore after a restart; the bind itself stands.
function writeName(name: string | null): void {
  if (!PUSH) return;
  try {
    writeRecord(RECORD_DIR, { name, session_id: SESSION_ID, harness_pid: process.ppid, bus: serverUrl });
  } catch (e) {
    console.error(`[grayboard] name record for harness pid ${process.ppid} not written:`, e);
  }
}

// A bound connection for `name`, or why the server refused it. A restore
// retries while the name is in use: the process it replaces may still hold
// it for a moment.
async function helloAs(name: string, opts: { create: boolean; restoredFrom?: string }): Promise<{ c: GrayboardClient; hello: HelloOk } | { refused: HelloRefused }> {
  const deadline = Date.now() + 6000;
  for (;;) {
    const c = connect(name, { push: DELIVER, ...opts });
    try {
      return { c, hello: await helloWithin(c, STARTUP_LIMITED_BY) };
    } catch (e) {
      c.close();
      if (!(e instanceof HelloRefused)) throw e;
      if (!(opts.restoredFrom && e.code === "identity_in_use" && Date.now() < deadline)) return { refused: e };
      await Bun.sleep(500);
    }
  }
}

// Wait for hello_ok before the MCP handshake, so a refused identity or an
// unreachable server shows as a failed server in the client, and so the
// instructions can carry its notices or candidates.
let hello: HelloOk | null = null;
if (PUSH) sweepRecords(RECORD_DIR);
const rec = PUSH ? freshRecord(RECORD_DIR, process.ppid, serverUrl) : null;
// A restart under the same harness takes back its predecessor's name, ahead
// of BUS_IDENTITY: it's the same session, mid-task.
const want = rec?.name ? normalizeIdentityName(rec.name) : null;
if (want && !want.ok) unboundNotes.push(restoreNote(rec!.name!, want.error));
const startName = want?.ok ? want.name : !PUSH || EXPLICIT ? SUGGESTED : null;
if (startName) {
  const r = await helloAs(startName, want?.ok ? { create: false, restoredFrom: rec!.session_id } : { create: true }).catch(fatal);
  if ("hello" in r) {
    hello = r.hello;
    boundHello = r.hello;
    client = r.c;
    bound = startName;
  } else if (want?.ok) unboundNotes.push(restoreNote(startName, r.refused.message));
  // A held explicit name starts the session unbound, naming the holder:
  // exiting would show the agent nothing it can act on.
  else if (PUSH && r.refused.code === "identity_in_use") unboundNotes.push(heldNote(startName, r.refused.holder ?? r.refused.message));
  else fatal(r.refused);
}
if (!bound) {
  const launcher = PUSH ? launcherName(process.ppid) : null;
  if (launcher) unboundNotes.push(launcherNote(launcher));
  const c = connect(null, { push: false });
  try {
    hello = await helloWithin(c, STARTUP_LIMITED_BY);
    client = c;
  } catch (e) {
    c.close();
    if (!(e instanceof HelloRefused && e.code === "bad_request")) fatal(e as Error);
    readOnlyRefused(e as HelloRefused);
  }
}
writeName(bound);
console.error(`[grayboard] server mode (${serverUrl}), session ${SESSION_ID}, ${bound ? `identity "${bound}"` : "unbound"}`);

// What a session bound to `name` is told (core's boundInstructions), with
// server mode's team, human and handle sentences, and the server's notices.
function serverBoundInstructions(name: string, h: HelloOk, general: boolean): string[] {
  return boundInstructions(
    name,
    general,
    () => [
      ...(h.teams.length > 0 ? [TEAM_PRIVACY_INSTRUCTION] : []),
      ...(h.human?.linked ? ownHumanInstruction(h.human.handle) : []),
      `Handles are user@org/name; dm_send also takes a bare name, resolved the same way as @name. In a post, @name means your own identity of that name if you have one, else the one person on the board with it; @user/name or @user@org/name is exact.`,
    ],
    h.notices ?? [],
  );
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
        ? serverBoundInstructions(bound, hello, true)
        : [unboundInstruction(hello?.candidates ?? [], unboundNotes), ...(readsUnavailable ? [`(${readsUnavailable}.)`] : [])]),
    ].join(" "),
  },
);

server.oninitialized = markInitialized;

// ── MCP tools ─────────────────────────────────────────────────────────────────


server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SERVER_TOOLS }));

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const staleNotice = updateNotice();
// The channels warning also goes in the first tool result, in case the
// instructions went unread.
let channelsNoticePending = CHANNELS_OFF;
// What a result the client dropped carried, for the next one.
const requeued: string[] = [];
const notices = (): string[] => {
  const out = requeued.splice(0);
  if (channelsNoticePending) out.push(CHANNELS_OFF_NOTICE);
  channelsNoticePending = false;
  if (lostNotice) out.push(lostNotice);
  lostNotice = null;
  if (missedBindNotice) out.push(missedBindNotice);
  missedBindNotice = null;
  const stale = staleNotice();
  return stale ? [...out, stale] : out;
};

const gate = new BindGate();
const late = new LateCancels();
server.setRequestHandler(CallToolRequestSchema, async (req, { signal, requestId }) => {
  const { name, arguments: args = {} } = req.params;
  const run = () => call(name, args as Record<string, unknown>, signal);
  const r: { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: unknown } =
    await (name === "bind" ? gate.bind(run) : gate.call(run));
  // A cancelled call's result is dropped: its notices wait for the next one.
  if (signal.aborted) return r;
  const extra = notices();
  let out = extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text" as const, text }))] } : r;
  if (instructionsStale && !out.structuredContent) {
    instructionsStale = false;
    out = { ...out, structuredContent: { name: bound, instructions: currentInstructions() } };
  }
  late.answer(requestId, () => {
    if (name === "bind" && r.structuredContent) requeued.push(bindMissed((r.structuredContent as { name: string }).name, "it was cancelled", r.content[0]!.text));
    requeued.push(...extra);
    if (out.structuredContent) instructionsStale = true;
  });
  return out;
});

// The full instructions for the name this session holds now.
const currentInstructions = (): string[] =>
  bound && boundHello ? serverBoundInstructions(bound, boundHello, true) : [unboundInstruction([], [])];

async function call(name: string, a: Record<string, unknown>, signal: AbortSignal) {
  const bad = checkArgs(SERVER_TOOLS, name, a);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  if (name === "bind") return bind(a, signal);
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
          ...(a.resend === true ? { resend: true } : {}),
        }),
      );
      // A server from before pending ignores the field, which would lose the promise silently.
      if (a.pending === true && !rest.pending) {
        rest.note = `${rest.note ? `${rest.note} ` : ""}Sent, but this server doesn't record pending, so dm_inbox won't list the promise; the server needs updating.`;
      }
      return text(rest);
    }
    if (name === "delegate") {
      // The server resolves the launcher (or falls back to your human) and
      // sends the payload pending; the reply carries `to` and, on the degrade
      // path, human_fallback (#184).
      const { type: _frame, req_id: _req, ...rest } = await client.request<DelegateOk>({
        type: "delegate",
        persona: a.persona,
        task: a.task,
        ...(a.context !== undefined ? { context: a.context } : {}),
        ...(a.to !== undefined ? { to: a.to } : {}),
        ...(a.resend === true ? { resend: true } : {}),
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
      const r = await client.request<AckOk>({ type: "dm_retract", message_id: a.message_id });
      return text(r.note ? `ok: ${r.note}` : "ok");
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
    if (APPEND_WRITES.has(name) && isLostAnswer(e as Error)) {
      return { ...text(`error: ${lostAnswer((e as Error).message, client?.dedupsWrites === true, a.resend === true)}`), isError: true };
    }
    // The HTTP API (attachments) refused the token, as a WS hello would have.
    if (e instanceof ApiError && e.status === 401) return { ...text(`error: ${signInHint(serverUrl, envToken)}`), isError: true };
    // Server errors arrive as "code: message"; show them to the agent.
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
}

// The writes the server deduplicates (#254, src/server/write_dedup.ts).
const APPEND_WRITES = new Set(["dm_send", "board_post", "delegate"]);
// A disconnect around the call, or no answer in time: not a refusal (an
// `error` frame rejects as "code: message"), so the write may have landed.
const isLostAnswer = (e: Error) => /was lost|no answer from the grayboard server/.test(e.message);
// One answer for every append write. The retry is safe only when the server
// deduplicates (its hello_ok said so) and the call didn't force a resend.
const lostAnswer = (why: string, dedup: boolean, resend: boolean) =>
  `the server's answer was lost (${why}); the write may have landed. ` +
  (!dedup
    ? "This server doesn't deduplicate writes, so calling again may send twice: check dm_history, board_read or dm_inbox's promised list first."
    : resend
      ? `It was a resend, so calling again with resend sends again; calling again without resend within ${WRITE_DEDUP_WINDOW_TEXT} returns its result instead.`
      : `Calling again with the same arguments within ${WRITE_DEDUP_WINDOW_TEXT} is safe: the server returns the first result instead of sending twice.`);

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
    super(`sent, but the server's answer was lost (${cause.message}); its attachments (${attachments.join(", ")}) are bound to it. It landed, so there's nothing to send again; dm_history or board_read shows it.`);
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
    await helloWithin(c, Date.now() + HELLO_LIMITED_MS);
    return c;
  } catch (e) {
    if (client === c) client = null;
    c.close();
    if (e instanceof HelloRefused && e.code === "bad_request") readOnlyRefused(e);
    throw new Error(readsUnavailable ?? (e as Error).message);
  }
}

// bind(name, create?): take a name, or move to another (#182). A fresh
// connection says hello for the new name, naming the one it leaves; only once
// the server accepts it (moving this session's claims) is the old connection
// marked dead and closed, so it can't reconnect and re-register the old name.
// A DM pushed to the old connection after that is never acked: it stays
// queued for the old name's next holder, never consumed under the new one.
// It runs behind the gate, so no tool call overlaps it. The server commits on
// its hello_ok, so one that arrives after the result timed out still
// completes the bind (#182 audit 5), and the gate holds other calls until it
// does or LATE_MS passes.
const LATE_MS = 30_000;
async function bind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  const n = bindTarget(a, bound, PUSH);
  if ("result" in n) return n.result;
  const previous = bound;
  const next = connect(n.name, { push: DELIVER, create: a.create === true, ...(previous ? { from: previous } : {}) });
  let h: HelloOk;
  try {
    h = await helloWithin(next, Date.now() + HELLO_LIMITED_MS);
  } catch (e) {
    if (!(e instanceof HelloTimeout)) {
      next.close();
      return fail((e as Error).message);
    }
    const late = Promise.race([next.ready(), Bun.sleep(LATE_MS).then(() => Promise.reject(e))]);
    gate.holdUntil(late.then((h) => switchTo(next, n.name, previous, h, "its result timed out"), () => next.close()));
    return fail(`${e.message}; the bind may still complete, and if it does, a later tool result says so`);
  }
  // A cancelled call's result is dropped (pi and opencode cancel on abort).
  return switchTo(next, n.name, previous, h, signal.aborted ? "it was cancelled" : null);
}

// The server accepted `next` for `name`: it's this session's connection now.
// `missed`: why the agent never saw the bind's result.
function switchTo(next: GrayboardClient, name: string, previous: string | null, h: HelloOk, missed: string | null) {
  testPause("bind:after-acquire");
  const old = client;
  client = next;
  bound = name;
  boundHello = h;
  writeName(bound);
  lostNotice = null;
  old?.close();
  console.error(`[grayboard] session ${SESSION_ID} bound "${name}"${previous ? ` (was "${previous}")` : ""}${missed ? ` after ${missed}` : ""}`);
  const notes = h.moved === undefined ? [oldServerBindNote(previous)] : h.not_moved ? [`${h.not_moved[0]!.toUpperCase()}${h.not_moved.slice(1)}.`] : [];
  if (h.moved === undefined) console.error(`[grayboard] the server predates name binding: "${name}" was bound without its checks`);
  const r = bindOk(name, previous, h.moved ?? [], (general) => serverBoundInstructions(name, h, general), notes);
  if (missed) {
    missedBindNotice = bindMissed(name, missed, r.content[0]!.text);
    instructionsStale = true;
  }
  return r;
}

// ── start stdio transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
late.watch(transport);

const shutdown = () => {
  client?.close();
  if (PUSH && !bound) dropUnboundRecord(RECORD_DIR, process.ppid, SESSION_ID);
  process.exit(0);
};
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
// Exit when the MCP client goes away, so an orphan can't keep holding the identity.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
