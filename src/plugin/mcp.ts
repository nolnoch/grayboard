// Server-mode MCP server: a WSS client of the grayboard backend. `grayboard mcp`
// imports this; it starts on import.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrayboardClient, ServerRefused, retryWait } from "./client.ts";
import { ApiClient, ApiError, loadCredentials as savedCredentials, signInHint } from "../cli/api.ts";
import { isExplicitIdentity, sessionIdentity } from "../shared/identity.ts";
import type { AckOk, Message, SendOk, DelegateOk, HistoryOk, ThreadOk, CallOk, InboxOk, HelloOk, BindOk, BindRequest, UnbindOk } from "../shared/protocol.ts";
import { canonicalJson, WRITE_DEDUP_WINDOW_MS, WRITE_DEDUP_WINDOW_TEXT } from "../shared/dedup.ts";
import { ackIds, ackResult } from "../shared/inbox.ts";
import { checkBody } from "../core/boards.ts";
import { normalizeAliasName } from "../core/addresses.ts";
import {
  TOOLS_ONLY_BIND, bindMissed, bindOk, boundInstructions, envSessionKey, heldNote, idAddress, launcherNote, mintSessionKey, notHolding, restoreNote, unbindMissed,
  unbindOk, unboundInstruction,
} from "../core/bindings.ts";
import { dropUnboundRecord, freshRecord, sweepRecords, writeRecord } from "../shared/namerecord.ts";
import { commandName, launcherName } from "../shared/proc.ts";
import { SERVER_TOOLS } from "./tools.ts";
import { sockDir } from "../shared/sockdir.ts";
import { LateCancels } from "../shared/latecancel.ts";
import { testPause } from "../shared/testpause.ts";
import { BindGate } from "../shared/bindgate.ts";
import { boardNotification, DEFAULT_CHANNEL_SOURCE, dmNotification, isBoardTool, ownHumanInstruction } from "../core/tools.ts";
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

const fatal = (e: Error): never => {
  console.error(`[grayboard] ${e.message}`);
  process.exit(1);
};
// BUS_SESSION_KEY: an orchestrator minted this session's key, so it knows
// the ID before the process exists (#284 S10). The server's grace, not the
// harness, then decides when the session ends: a restart within it carries on
// as the same session. Read once, here.
const KEY = (() => {
  try {
    return envSessionKey();
  } catch (e) {
    return fatal(e as Error);
  }
})();
const KEYED = KEY !== undefined;
// A session binds a name at start only when told which (#182): an explicit
// BUS_IDENTITY, not a harness re-delivering the repo's pin. Otherwise the
// resolved name is only the first suggestion, and the session starts unbound.
// It may carry a scope (eng/build); the server judges it at bind.
const EXPLICIT = isExplicitIdentity();
const resolved = (() => {
  try {
    return normalizeAliasName(sessionIdentity());
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
})();
// Directories this session may attach files from and save them to.
const ROOTS = attachRoots();
// BUS_PUSH=off: tools only, for a harness without an adapter. It writes as
// the resolved name of the session that owns delivery (#284 S7).
const PUSH = process.env.BUS_PUSH !== "off";
if (!resolved.ok && (EXPLICIT || !PUSH)) fatal(new Error(resolved.error));
const SUGGESTED = resolved.ok ? resolved.name : null;
// What a tools-only process writes as; it holds nothing.
const WRITES_AS = PUSH ? null : SUGGESTED!;
// Claude Code started without a channels flag drops pushes silently; say so.
const CHANNELS_OFF = PUSH && channelsOff(process.env, parentCommandLine());
if (CHANNELS_OFF) console.error("[grayboard] this Claude Code session has no channels flag: tools only");
// Notifications such a session drops would still count as delivered, so it
// gets no pushes, as BUS_PUSH=off does, and what's pending waits (#71). It
// still holds its name, as in local mode (decision 9): its hello says hold
// (#182 audit 2).
const DELIVER = PUSH && !CHANNELS_OFF;
// Name records (#211) are for a session that ends with its process: a keyed
// one comes back by its key, as locally.
const RECORDS = PUSH && !KEYED;
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

// The aliases this session holds (full addresses), oldest first (#284 S1):
// it sends as the first, its primary, and as its ID while it holds none.
// The server's hello_ok, bind_ok, unbind_ok and alias_lost keep it in step.
let held: string[] = [];
// A tools-only process's name is bare until the server qualifies it, as a
// bind does: your own scope.
const primary = (): string => (WRITES_AS ? (WRITES_AS.includes("/") ? WRITES_AS : `${hello.user_email}/${WRITES_AS}`) : held[0] ?? client.id);
// The latest hello_ok: a reconnect's replaces it.
let hello!: HelloOk;
// The notices for the set held: the latest bind_ok's, or at start the hello_ok's.
let boundNotices: string[] = [];
// What happened to this session's name without a bind result saying so (a
// lost name, a restore's end, a new ID), for the next tool result.
let nameNotice: string | null = null;
// A bind whose result never reached the agent (it was cancelled) but that
// completed, for the next tool result.
let missedBindNotice: string | null = null;
// The name changed without a bind result saying so (a missed bind, a lost
// name, a new ID): the next tool result carries the instructions for the
// name now, as a bind result does, for adapters that keep them in the system prompt.
let instructionsStale = false;
// Tool calls wait out a bind, the agent's or one this process makes itself.
const gate = new BindGate();
// Set once startup has bound what it binds; a hello_ok before then is startup's.
let started = false;

// The harness this process runs under, for its hello.
const harness = commandName(process.ppid);
// One connection for the session's life (#284 S11): it holds the session's
// ID, and binding an alias changes what it acts as, not the connection.
const client: GrayboardClient = new GrayboardClient(
  serverUrl,
  currentToken,
  KEY ?? mintSessionKey(),
  async (msg: Message) => {
    const params = dmNotification(msg, primary());
    if (fromOwnHuman(msg.sender)) params.meta.human = "true";
    return notify(params);
  },
  async (item) => {
    const params = boardNotification(item);
    if (item.kind === "push" && fromOwnHuman(item.post.author)) params.meta.human = "true";
    return notify(params);
  },
  (running) => signInHint(serverUrl, envToken) + (running && !envToken ? "; this session reconnects by itself after that" : ""),
  {
    push: DELIVER,
    hold: CHANNELS_OFF,
    ...(PUSH ? {} : { writesAs: SUGGESTED! }),
    keyed: KEYED,
    launcher: process.env.BUS_LAUNCHER === "1",
    // What the session runs on, self-reported (#284 S12).
    facts: {
      ...(harness ? { harness } : {}),
      ...(process.env.BUS_MODEL ? { model: process.env.BUS_MODEL } : {}),
      ...(process.env.BUS_EFFORT ? { effort: process.env.BUS_EFFORT } : {}),
    },
    onReady: (h, rekeyedFrom) => {
      hello = h;
      if (started) reattached(h, rekeyedFrom);
    },
    // Its user left the alias's team: the session keeps its other holds.
    onAliasLost: (m) => {
      if (!held.includes(m.alias)) return;
      const before = primary();
      held = held.filter((h) => h !== m.alias);
      if (!held.length) boundNotices = [];
      writeNames();
      nameNotice = `This session lost its bus name "${short(m.alias)}": ${m.reason}. ` + (held.length
        ? before === primary() ? `It still sends as "${short(primary())}".` : `It sends as "${short(primary())}" now.`
        : `It acts as its ID (${client.id}) now: bind(name) to take another.`);
      instructionsStale = true;
      console.error(`[grayboard] session ${client.id} lost "${m.alias}": ${m.reason}`);
    },
    // Taken over by another process with this key, or a keyed session that
    // ended during an outage: nothing here can carry on as it.
    onDead: (reason) => fatal(new Error(`session ${client.id} stopped: ${reason}`)),
  },
);
client.connect();

// The server reserves the human's name, so only that handle is provably your user.
const fromOwnHuman = (handle: string): boolean => handle === hello.human?.handle;

// An address as the agent sees it: your own aliases without your user's scope.
const short = (address: string): string => {
  const own = `${hello.user_email}/`;
  return address.startsWith(own) ? address.slice(own.length) : address;
};

// A server refusal's own words, without the "code: " a request's carries.
const reason = (e: Error): string => (e instanceof ServerRefused && e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message);

// Keep this well under the client's own startup timeout (30s in Claude Code),
// so a stuck server is an error, not a timeout. BUS_TEST_HELLO_MS shortens it
// for tests.
const HELLO_MS = Number(process.env.BUS_TEST_HELLO_MS) || 10_000;
// While the server rate-limits the hello, wait longer, still under that 30s
// (#210). BUS_TEST_HELLO_LIMITED_MS shortens it for tests.
const HELLO_LIMITED_MS = Number(process.env.BUS_TEST_HELLO_LIMITED_MS) || 25_000;
// Startup is one window, whatever it takes: the hello and a restore's
// retries count against the same absolute deadline.
const STARTUP_LIMITED_BY = Date.now() + HELLO_LIMITED_MS;
// Wait for hello_ok: HELLO_MS, or while the server rate-limits this client,
// until `limitedBy` (an absolute time).
const helloWithin = (c: GrayboardClient, limitedBy: number): Promise<HelloOk> => {
  let timer: Timer | undefined;
  const start = Date.now();
  const deadline = new Promise<never>((_, reject) => {
    const check = () => {
      const limited = c.rateLimited();
      const left = limitedBy - Date.now();
      // Waited out only when the next try fits the window.
      if (limited && left > 0 && limited.retryAt <= limitedBy) return void (timer = setTimeout(check, Math.min(1000, left)));
      reject(new Error(limited
        ? `the grayboard server at ${serverUrl} is rate-limiting ${limited.what} (${limited.message}); gave up after ${Math.round((Date.now() - start) / 1000)}s`
        : `no answer from grayboard server at ${serverUrl} within ${Math.round((Date.now() - start) / 1000)}s`));
    };
    timer = setTimeout(check, Math.max(0, Math.min(HELLO_MS, limitedBy - start)));
  });
  return Promise.race([c.ready(), deadline]).finally(() => clearTimeout(timer));
};

// The name record (#182 decision 14), written by the session that owns
// delivery whenever its holds change, so a restart under the same harness
// takes them back (#284 S10).
const RECORD_DIR = sockDir();
// A failed write costs only the restore after a restart; the binds stand.
function writeNames(): void {
  if (!RECORDS) return;
  try {
    writeRecord(RECORD_DIR, { names: held, session_id: client.id, harness_pid: process.ppid, bus: serverUrl });
  } catch (e) {
    console.error(`[grayboard] name record for harness pid ${process.ppid} not written:`, e);
  }
}

// A bind at start, waiting out the server's rate limit within startup's window.
async function startupBind(alias: string, extra: Omit<BindRequest, "type" | "req_id" | "alias">): Promise<BindOk> {
  for (;;) {
    try {
      return await client.request<BindOk>({ type: "bind", alias, ...extra });
    } catch (e) {
      if (!(e instanceof ServerRefused && e.code === "rate_limited")) throw e;
      const wait = retryWait(e.retryAfterMs, 1000);
      if (Date.now() + wait > STARTUP_LIMITED_BY) throw e;
      await Bun.sleep(wait);
    }
  }
}

// What restores' bind_oks say about their continuity (#284 PR 4 S11): a
// restored_from proves nothing, so the session before's status stays behind.
// One sentence for every unverified restore, which all name the same session.
function restoredNote(oks: BindOk[]): string[] {
  const unverified = oks.filter((ok) => ok.restored && !ok.restored.verified);
  if (!unverified.length) return [];
  return [`The server couldn't verify that this session continues the one that held ${quotedShort(unverified.map((ok) => ok.alias))} (${unverified[0]!.restored!.detail}), so that session's status wasn't carried over: peer_status to set yours.`];
}

// The aliases a restart is taking back while its predecessor's session is in
// its grace (S11). The agent's own bind or unbind of one settles it.
const restoring = new Set<string>();

// Retries a restore after `ms`, until the holder's grace ends and the alias
// is free, or the holder comes back (an alias_held with no wait).
function restoreLater(alias: string, restoredFrom: string, ms: number): void {
  restoring.add(alias);
  setTimeout(() => {
    if (!restoring.has(alias)) return;
    void gate.bind(async () => {
      if (!restoring.has(alias)) return;
      try {
        const ok = await client.request<BindOk>({ type: "bind", alias, create: false, restored_from: restoredFrom });
        restoring.delete(alias);
        adopt(ok);
        nameNotice = [
          `This session took back "${short(ok.alias)}", which the grayboard process before it held; it sends as "${short(primary())}".`,
          ...restoredNote([ok]),
        ].join(" ");
        instructionsStale = true;
        console.error(`[grayboard] session ${client.id} restored "${ok.alias}"`);
      } catch (e) {
        // A holder in its grace, or the user's bind limit: both say when to retry.
        if (e instanceof ServerRefused && (e.code === "alias_held" || e.code === "rate_limited") && e.retryAfterMs !== undefined) {
          console.error(`[grayboard] session ${client.id} restoring "${alias}" retries in ${e.retryAfterMs}ms: ${e.code}`);
          return restoreLater(alias, restoredFrom, e.retryAfterMs);
        }
        restoring.delete(alias);
        nameNotice = restoreNote(short(alias), reason(e as Error), held.length > 0);
        console.error(`[grayboard] session ${client.id} didn't restore "${alias}": ${(e as Error).message}`);
      }
    });
  }, ms);
}

// A bind accepted: the server's held list is this session's from here.
function adopt(ok: BindOk): void {
  held = ok.held;
  boundNotices = ok.notices ?? [];
  restoring.delete(ok.alias);
  writeNames();
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// A no-op bind or unbind answer still carries the server's hold list: adopt
// it, so a mirror that drifted (a lost answer, a missed alias_lost) heals on
// the next call instead of staying wrong.
function syncHeld(now: string[]): void {
  if (sameList(held, now)) return;
  console.error(`[grayboard] session ${client.id} holds "${now.join('", "')}" (was "${held.join('", "')}")`);
  held = now;
  if (!held.length) boundNotices = [];
  writeNames();
  instructionsStale = true;
}
const quotedShort = (names: string[]) => names.map((n) => `"${short(n)}"`).join(", ");

// A reconnect's hello_ok. A resume re-attaches the session with its holds,
// so nothing is bound again (S11); a new ID (the old one ended during the
// outage, S4) re-binds each alias in order, proving descent with the old key.
function reattached(h: HelloOk, rekeyedFrom: string | null): void {
  if (rekeyedFrom === null) {
    const now = h.bound ?? [];
    if (!PUSH || sameList(now, held)) return;
    const lost = held.filter((a) => !now.includes(a));
    nameNotice = lost.length
      ? `This session reconnected without ${quotedShort(lost)}; ` + (now.length ? `it holds ${quotedShort(now)} and sends as "${short(now[0]!)}".` : `it acts as its ID now: bind(name) to take a name again.`)
      : `This session reconnected holding ${quotedShort(now)}.`;
    held = now;
    boundNotices = h.notices ?? [];
    instructionsStale = true;
    writeNames();
    return;
  }
  const changed = `This session's ID changed from ${idAddress(rekeyedFrom)} to ${h.id}: it was disconnected past the server's grace, so the old session ended and DMs sent to the old ID bounce.`;
  instructionsStale = true;
  // A tools-only session binds nothing: its new hello wrote as its writes_as again.
  if (!PUSH) {
    nameNotice = changed;
    return;
  }
  const aliases = held;
  held = [];
  boundNotices = [];
  if (!aliases.length) {
    nameNotice = changed;
    writeNames();
    return;
  }
  void gate.bind(async () => {
    const missed: string[] = [];
    for (const alias of aliases) {
      try {
        adopt(await client.request<BindOk>({ type: "bind", alias, previous_key: rekeyedFrom }));
      } catch (e) {
        missed.push(`"${short(alias)}" (${reason(e as Error)})`);
      }
    }
    writeNames();
    nameNotice = [
      changed,
      ...(held.length ? [`It took back ${quotedShort(held)}${held.length > 1 ? ` and sends as "${short(primary())}"` : ""}.`] : []),
      ...(missed.length ? [`It couldn't take back ${missed.join(", ")}${held.length ? "" : ", so it acts as its ID now: bind(name) to take a name again"}.`] : []),
    ].join(" ");
    console.error(`[grayboard] session ${idAddress(rekeyedFrom)} ended during an outage; now ${h.id}${held.length ? `, holding "${held.join('", "')}"` : ""}`);
  });
}

// Wait for hello_ok, and bind what startup binds, before the MCP handshake,
// so a refused session or an unreachable server shows as a failed server in
// the client, and so the instructions say what was bound.
hello = await helloWithin(client, STARTUP_LIMITED_BY).catch(fatal);
// Why this session started as it did, for its instructions.
const startNotes: string[] = [];
if (RECORDS) sweepRecords(RECORD_DIR);
const rec = RECORDS ? freshRecord(RECORD_DIR, process.ppid, serverUrl) : null;
if (hello.bound?.length) {
  // A keyed session restarted within its grace: it still holds its aliases.
  held = hello.bound;
  boundNotices = hello.notices ?? [];
} else if (PUSH && rec?.names.length) {
  // A restart under the same harness takes back its predecessor's names, in
  // their order, ahead of BUS_IDENTITY: it's the same session, mid-task
  // (#284 S10). Each is judged on its own; the first taken is the primary.
  // The process it replaces may still hold them for a moment, before its end lands.
  const until = Date.now() + 6000;
  testPause("restore:before-bind");
  const missed: { name: string; why: string }[] = [];
  const restored: BindOk[] = [];
  for (const name of rec.names) {
    for (;;) {
      try {
        const ok = await startupBind(name, { create: false, restored_from: rec.session_id });
        adopt(ok);
        restored.push(ok);
        break;
      } catch (e) {
        if (!(e instanceof ServerRefused)) fatal(e as Error);
        const refused = e as ServerRefused;
        if (refused.code === "alias_held" && refused.retryAfterMs !== undefined) {
          restoreLater(name, rec.session_id, refused.retryAfterMs);
          startNotes.push(`This grayboard process restarted; the one before it held "${short(name)}" and is in its reconnect grace, so this session is restoring it: it binds "${short(name)}" by itself within ${Math.ceil(refused.retryAfterMs / 1000)}s, and a tool result says when.`);
          break;
        }
        if (refused.code === "alias_held" && Date.now() < until) {
          await Bun.sleep(500);
          continue;
        }
        missed.push({ name, why: reason(refused) });
        break;
      }
    }
  }
  startNotes.push(...restoredNote(restored));
  // Once the loop is done, so each says whether the session holds others.
  for (const m of missed) startNotes.push(restoreNote(short(m.name), m.why, held.length > 0));
} else if (PUSH && EXPLICIT) {
  try {
    adopt(await startupBind(SUGGESTED!, { create: true }));
  } catch (e) {
    // A held explicit name starts the session unbound, naming the holder:
    // exiting would show the agent nothing it can act on.
    if (!(e instanceof ServerRefused && e.code === "alias_held")) fatal(e as Error);
    startNotes.push(heldNote(SUGGESTED!, (e as ServerRefused).holder ?? reason(e as Error)));
  }
}
if (!held.length && RECORDS) {
  const launcher = launcherName(process.ppid);
  if (launcher) startNotes.push(launcherNote(launcher));
}
if (WRITES_AS || held.length) boundNotices = [...(hello.notices ?? []), ...boundNotices.filter((n) => !hello.notices?.includes(n))];
writeNames();
started = true;
console.error(`[grayboard] server mode (${serverUrl}), session ${client.id}${KEYED ? " (keyed)" : ""}, ${held.length ? `identity "${held.join('", "')}"` : WRITES_AS ? `writing as "${WRITES_AS}"` : "unbound"}`);

// What a session acting as `name` is told (core's boundInstructions), with
// server mode's team, human and handle sentences, then `named`. `others`:
// the session's other holds.
function serverBoundInstructions(name: string, general: boolean, named: string[], others: string[] = []): string[] {
  return boundInstructions(
    name,
    DEFAULT_CHANNEL_SOURCE,
    general,
    () => [
      ...(hello.teams.length > 0 ? [TEAM_PRIVACY_INSTRUCTION] : []),
      ...(hello.human?.linked ? ownHumanInstruction(hello.human.handle) : []),
      `Handles are scope/name (user@org/name for a person's, team/name for a team's) or id:… for a session; dm_send also takes a bare name, resolved the same way as @name. In a post, @name means your own scope's name if there is one, else the one on the board with it (if several, name one); @scope/name and @id:… are exact.`,
    ],
    named,
    others,
  );
}

// The instructions for what this session acts as now: its primary, with its
// other holds. Unbound, it acts as its ID (#284 S13), with a sentence on
// binding a name. `notes`: why it started as it did.
const instructionsNow = (general: boolean, notes: string[] = []): string[] =>
  WRITES_AS || held.length
    ? serverBoundInstructions(short(primary()), general, [...notes, ...boundNotices], held.slice(1).map(short))
    : serverBoundInstructions(client.id, general, [unboundInstruction(client.id, [], notes), ...(hello.notices ?? [])]);
const currentInstructions = (notes: string[] = []): string[] => instructionsNow(true, notes);

// Built after hello_ok; notify waits for `initialized`, which needs it.
const server = new Server(
  { name: DEFAULT_CHANNEL_SOURCE, version: pkg.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [...(CHANNELS_OFF ? [CHANNELS_OFF_NOTICE] : []), ...currentInstructions(startNotes)].join(" "),
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
  if (nameNotice) out.push(nameNotice);
  nameNotice = null;
  if (missedBindNotice) out.push(missedBindNotice);
  missedBindNotice = null;
  const stale = staleNotice();
  return stale ? [...out, stale] : out;
};

const late = new LateCancels();
server.setRequestHandler(CallToolRequestSchema, async (req, { signal, requestId }) => {
  const { name, arguments: args = {} } = req.params;
  const run = () => call(name, args as Record<string, unknown>, signal);
  const r: { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: unknown } =
    // bind and unbind change the address set: no call overlaps either.
    await (name === "bind" || name === "unbind" ? gate.bind(run) : gate.call(run));
  // A cancelled call's result is dropped: its notices wait for the next one.
  if (signal.aborted) return r;
  const extra = notices();
  let out = extra.length ? { ...r, content: [...r.content, ...extra.map((text) => ({ type: "text" as const, text }))] } : r;
  if (instructionsStale && !out.structuredContent) {
    instructionsStale = false;
    out = { ...out, structuredContent: { name: WRITES_AS || held.length ? short(primary()) : null, instructions: currentInstructions() } };
  }
  late.answer(requestId, () => {
    if (name === "bind" && r.structuredContent) requeued.push(bindMissed((r.structuredContent as { name: string }).name, "it was cancelled", r.content[0]!.text));
    if (name === "unbind" && r.structuredContent) requeued.push(unbindMissed(String((args as Record<string, unknown>).name), "it was cancelled", r.content[0]!.text));
    requeued.push(...extra);
    if (out.structuredContent) instructionsStale = true;
  });
  return out;
});

async function call(name: string, a: Record<string, unknown>, signal: AbortSignal) {
  const bad = checkArgs(SERVER_TOOLS, name, a);
  if (bad) return { ...text(`error: ${bad}`), isError: true };
  if (name === "bind") return bind(a, signal);
  if (name === "unbind") return unbind(a, signal);
  if (name === "whoami") return text(whoami());
  const repeat = APPEND_WRITES.has(name) ? unmatchedRetry(name, a) : null;
  if (repeat) return { ...text(`error: ${repeat}`), isError: true };
  try {
    // What uploads act as: the call's `as`, else the primary (#284 S5).
    // The server binds them over the sending session's whole address set.
    const me = a.as !== undefined ? String(a.as) : primary();
    if (isBoardTool(name)) {
      const { attachments: paths, ...args } = a;
      if (paths !== undefined && name === "board_post") checkBody(args.body);
      const { result } = await withUploads(me, paths, (ids) =>
        client.request<CallOk>({ type: "call", tool: name, args: ids.length ? { ...args, attachment_ids: ids } : args }),
      );
      return text(result);
    }
    if (name === "dm_send") {
      if (a.attachments !== undefined) checkBody(a.body);
      const { type: _t, req_id: _r, ...rest } = await withUploads(me, a.attachments, (ids) =>
        client.request<SendOk>({
          type: "send",
          recipient: a.to,
          body: a.body,
          ...(a.parent_id !== undefined ? { parent_id: a.parent_id } : {}),
          ...(a.pending === true ? { pending: true } : {}),
          ...(ids.length ? { attachment_ids: ids } : {}),
          ...(a.resend === true ? { resend: true } : {}),
          ...(a.as !== undefined ? { as: a.as } : {}),
        }),
      );
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
      const limits = attachmentLimits();
      const target = await saveTarget(a.dir, ROOTS, serverBusDir(serverUrl));
      const { res, data } = await api().download(`/api/attachments/${id}?as=${encodeURIComponent(me)}`, limits.file);
      // Checked before anything is saved: the bytes must be the ones the server stored.
      const sha256 = sha256Hex(data);
      // A missing digest is a mismatch: every 2.x server sends one.
      if (digestSha256(res.headers.get("repr-digest")) !== sha256) throw new Error(`attachment ${id}: the bytes received don't match the server's sha256`);
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
      lostWrites.set(writeKey(name, a), { session: client.id, holds: held, at: Date.now() });
      return { ...text(`error: ${lostAnswer((e as Error).message, a.resend === true)}`), isError: true };
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
// One answer for every append write. The retry is safe unless the call
// forced a resend: a retry the server can't match is refused before it goes
// out (unmatchedRetry).
const lostAnswer = (why: string, resend: boolean) =>
  `the server's answer was lost (${why}); the write may have landed. ` +
  (resend
    ? `It was a resend, so calling again with resend sends again; calling again without resend within ${WRITE_DEDUP_WINDOW_TEXT} returns its result instead.`
    : `Calling again with the same arguments within ${WRITE_DEDUP_WINDOW_TEXT} is safe: the server returns the first result instead of sending twice.`);

// Append writes whose answer was lost, by tool and arguments, with the
// session and the holds it had: the server's dedup key
// (src/server/write_dedup.ts) holds the session and the sender, and the
// server resolves the sender from the arguments, the parent and the holds
// (#284 S3, S4), so unchanged holds mean an unchanged key. The lost request
// was rejected when its connection closed, before any reconnect could rekey
// the session.
const lostWrites = new Map<string, { session: string; holds: string[]; at: number }>();
const writeKey = (name: string, a: Record<string, unknown>) => {
  const { resend: _resend, ...args } = a;
  return canonicalJson({ tool: name, args });
};

// A repeat of a lost write after the session's ID changed (a rekey past the
// grace) or its holds did (a bind, unbind or restore) may reach the server under another
// key, so it would write twice: refused, unless the call forces a resend.
// A repeat under the same key goes out; the server replays the first result.
function unmatchedRetry(name: string, a: Record<string, unknown>): string | null {
  const now = Date.now();
  for (const [k, w] of lostWrites) if (now - w.at >= WRITE_DEDUP_WINDOW_MS) lostWrites.delete(k);
  const key = writeKey(name, a);
  const lost = lostWrites.get(key);
  if (!lost) return null;
  // Either answer settles it: the server's, or the agent's resend.
  if (a.resend === true || (lost.session === client.id && sameList(lost.holds, held))) {
    lostWrites.delete(key);
    return null;
  }
  const was = lost.session === client.id ? `while this session held ${lost.holds.length ? quotedShort(lost.holds) : "no name"}` : `from session ${lost.session}`;
  return `this repeats a ${name} whose answer was lost ${was}; this session has changed since, so the server can't match the repeat to it, and the first may have landed. Check dm_history, board_read or dm_inbox's promised list; to send it anyway, call again with resend: true.`;
}

const api = () => new ApiClient(serverUrl, currentToken());

// The live connection's attachment limits, which every hello_ok (a reconnect's
// too) carries.
function attachmentLimits(): AttachmentLimits {
  return client.assertConnected().attachment_limits;
}

// Reads and checks the files an agent named (all before any is sent), uploads
// each as `me` (an alias or this session's ID), and runs `send` with their
// ids; the server checks them again and binds them to that dm_send or
// board_post. Uploads go only over a live connection, and if any upload or
// the send fails, the ones made are released, so a refused send doesn't hold
// the user's unsent quota.
async function withUploads<T>(me: string, paths: unknown, send: (ids: number[]) => Promise<T>): Promise<T> {
  if (paths === undefined) return send([]);
  const files = await readAttachmentFiles(paths, ROOTS, { limits: attachmentLimits() });
  client.assertConnected();
  const ids: number[] = [];
  let sent = false;
  try {
    for (const f of files) {
      const q = `as=${encodeURIComponent(me)}&filename=${encodeURIComponent(f.filename)}`;
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
      await api().del(`/api/attachments/${id}?as=${encodeURIComponent(me)}`);
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

// The text a bind or unbind refusal carries: a lost answer may have landed.
const lostBind = (e: Error, verb: "bind" | "unbind") =>
  isLostAnswer(e) ? `${e.message}; the ${verb} may have completed: call ${verb} again with the same name, which is safe, to find out` : e.message;

// bind(name, create?, meta?): add an alias to this session's holds (#284
// S1). The server checks the name (a bare name in your own scope, or
// scope/name) and adds it to what this session's connection receives and may
// act as; it never drops another hold. It runs behind the gate, so no tool
// call overlaps it. A bind of a name already held only applies its labels,
// so an answer lost to a disconnect or a timeout is settled by calling again.
async function bind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  if (!PUSH) return fail(TOOLS_ONLY_BIND);
  let ok: BindOk;
  try {
    ok = await client.request<BindOk>({
      type: "bind", alias: String(a.name), create: a.create === true, ...(a.meta !== undefined ? { meta: a.meta as Record<string, unknown> } : {}),
    });
  } catch (e) {
    return fail(lostBind(e as Error, "bind"));
  }
  if (held.includes(ok.alias)) {
    syncHeld(ok.held);
    return text(`already bound to "${short(ok.alias)}"`);
  }
  testPause("bind:after-acquire");
  adopt(ok);
  nameNotice = null;
  const name = short(ok.alias);
  console.error(`[grayboard] session ${client.id} bound "${ok.alias}"; holds "${held.join('", "')}"`);
  const r = bindOk(name, held.map(short), instructionsNow);
  // A cancelled call's result is dropped (pi and opencode cancel on abort).
  if (signal.aborted) {
    missedBindNotice = bindMissed(name, "it was cancelled", r.content[0]!.text);
    instructionsStale = true;
  }
  return r;
}

// unbind(name): release one of this session's holds (#284 S2). Its mail and
// claims stay with the alias for its next holder; the server stops pushing
// it here before it answers.
async function unbind(a: Record<string, unknown>, signal: AbortSignal) {
  const fail = (why: string) => ({ ...text(`error: ${why}`), isError: true });
  if (!PUSH) return fail(TOOLS_ONLY_BIND);
  const before = primary();
  let ok: UnbindOk;
  try {
    ok = await client.request<UnbindOk>({ type: "unbind", alias: String(a.name) });
  } catch (e) {
    return fail(lostBind(e as Error, "unbind"));
  }
  // The agent's choice ends a restore still waiting on a grace.
  restoring.delete(ok.alias);
  if (!ok.released) {
    syncHeld(ok.held);
    return text(notHolding(short(ok.alias)));
  }
  held = ok.held;
  if (!held.length) boundNotices = [];
  writeNames();
  nameNotice = null;
  const name = short(ok.alias);
  console.error(`[grayboard] session ${client.id} released "${ok.alias}"; ${held.length ? `holds "${held.join('", "')}"` : "unbound"}`);
  const r = unbindOk(name, short(before), short(primary()), ok.left ?? [], instructionsNow);
  if (signal.aborted) {
    missedBindNotice = unbindMissed(name, "it was cancelled", r.content[0]!.text);
    instructionsStale = true;
  }
  return r;
}

// whoami (#284 S6), from this process's own state, which hello_ok, bind_ok,
// unbind_ok and alias_lost keep in step with the server's.
function whoami() {
  return {
    id: client.id,
    primary: primary(),
    aliases: held,
    principal: hello.user_email,
    ...(WRITES_AS ? { writes_as: primary() } : {}),
  };
}

// ── start stdio transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
late.watch(transport);

// An unkeyed session ends with its process (S4): end it now rather than
// leaving it to the server's grace. A keyed one only closes.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await client.end(2000);
  if (RECORDS && !held.length) dropUnboundRecord(RECORD_DIR, process.ppid, client.id);
  process.exit(0);
};
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
// Exit when the MCP client goes away, so an orphan can't keep holding the identity.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
