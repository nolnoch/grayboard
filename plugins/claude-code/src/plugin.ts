// The grayboard Claude Code plugin's one stdio MCP server (#281): the
// channel and the tool proxy for a hosted grayboard server, on hosted-core.
// It signs in as the built-in client `grayboard-claude-code` with its own
// grant (stored in CLAUDE_PLUGIN_DATA, shared by every session on this
// machine), forwards the server's tools with CLAUDE_CODE_SESSION_ID in
// `_meta`, and holds the session's delivery lease only when Claude Code will
// show its channel notifications (the shared rule, src/shared/claude_channels.ts).
//
// Claude Code runs one plugin process per session, and its subagents and
// in-process work call through it, so they act as the root. The process
// keeps CLAUDE_CODE_SESSION_ID across /clear (a reconnect starts a new one).
//
// The server stays on MCP SDK 1.x: Claude Code skips a channel whose session
// negotiated protocol 2026-07-28 or later, and 1.x tops out at 2025-11-25.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult as ServerResult, type Tool as ListedTool } from "@modelcontextprotocol/sdk/types.js";
import type { AuthProvider, CallToolResult } from "@modelcontextprotocol/client";
import { Controller } from "../../../adapters/hosted-core/src/controller.ts";
import { Login, LoginFailed } from "../../../adapters/hosted-core/src/login.ts";
import { AccessExpired, accessExpiry, DeliveryHeldElsewhere, Refusal } from "../../../adapters/hosted-core/src/model.ts";
import type { HostPort } from "../../../adapters/hosted-core/src/port.ts";
import { failure, hostTools, snapshotTools, ToolProxy, type NativeTool } from "../../../adapters/hosted-core/src/proxy.ts";
import { AncestryError } from "../../../adapters/hosted-core/src/sessions.ts";
import { deliveryPath, FileStorage, sessionPath, tryDelivery, waitDelivery } from "../../../adapters/hosted-core/src/storage.ts";
import type { Lock } from "../../../adapters/hosted-core/src/lock.ts";
import { channelParams } from "../../../adapters/hosted-core/src/channel.ts";
import { Wire, type WireOptions } from "../../../adapters/hosted-core/src/wire.ts";
import { failureMessage, type DiagnosticSink } from "../../../adapters/hosted-core/src/diagnostics.ts";
import { GRAYBOARD_SESSION_META } from "../../../src/server/oauth-config.ts";
import { CLAUDE_PLUGIN, claudeChannels, interactiveClaude, type ChannelsVerdict, type ClaudeFiles } from "../../../src/shared/claude_channels.ts";
import { attachRoots } from "../../../src/shared/attachments.ts";
import { canonicalEndpoint } from "../../../src/shared/endpoint.ts";
import { describeLocation } from "../../../src/shared/identity.ts";
import { channelsOffNotice } from "../../../src/shared/toolguard.ts";

export const HARNESS = "Claude Code";
export const CLIENT_ID = "grayboard-claude-code";
// The channel's source as Claude Code names a plugin's server: plugin:<plugin>:<server>.
export const SOURCE = "plugin:grayboard:grayboard";
export const ENTRY = `plugin:${CLAUDE_PLUGIN}` as const;
export const RESUME_HINT = "call any grayboard tool to retry";
// How each kind of session signs in, for AccessExpired and the instructions.
export const LOGIN_INTERACTIVE = "approve the grayboard sign-in Claude Code shows (any grayboard tool call offers it again)";
export const LOGIN_ELSEWHERE = "sign in from an interactive Claude Code session (call any grayboard tool there)";
const INSTRUCTIONS_MS = 5_000;
const FLOW_MS = 10 * 60_000;
// hosted-core's Controller pauses every root with this when the store's
// epoch changes (a login or logout in any process).
const DRIFTED = "Grayboard credential changed";

export type PluginOptions = {
  env: Record<string, string | undefined>;
  parentCmd: string | null; // Claude Code's command line, or null when unreadable
  files: ClaudeFiles;
  version: string;
  cwd: string;
  log(message: string): void; // stderr: Claude Code keeps it in the MCP log
};

export type Plugin = {
  // Connects `transport` once the initialize answer is ready; resolves when connected.
  connect(transport: Transport): Promise<void>;
  // Releases the lease (else ends a bound session) and closes; idempotent.
  shutdown(): Promise<void>;
};

// The plugin's configuration from Claude Code's environment, or why it can't run.
type Config = { id: string; dataDir: string; url: string } | { error: string };
export function pluginConfig(env: Record<string, string | undefined>): Config {
  const id = env.CLAUDE_CODE_SESSION_ID, dataDir = env.CLAUDE_PLUGIN_DATA, url = env.GRAYBOARD_SERVER_URL?.trim();
  if (!id) return { error: "CLAUDE_CODE_SESSION_ID is unset: this server runs only as Claude Code's grayboard plugin" };
  if (!dataDir) return { error: "CLAUDE_PLUGIN_DATA is unset: this server runs only as Claude Code's grayboard plugin" };
  const reconfigure = "run `grayboard setup --server <url>`, or `claude plugin install grayboard@grayboard --config server_url=<server>/mcp`";
  if (!url || url.startsWith("${")) return { error: `the grayboard plugin has no server_url; ${reconfigure}` };
  // The URL itself stays out of the message: it may carry credentials.
  if (!canonicalEndpoint(url)) return { error: `the grayboard plugin's server_url isn't canonical HTTPS (or HTTP loopback) without credentials, query or fragment; ${reconfigure}` };
  return { id, dataDir, url };
}

export function createPlugin(o: PluginOptions): Plugin {
  const config = pluginConfig(o.env);
  const interactive = interactiveClaude(o.env, o.parentCmd);
  const loginAction = interactive ? LOGIN_INTERACTIVE : LOGIN_ELSEWHERE;
  // Unknown counts as off: a push Claude Code doesn't show would be receipted and lost.
  const verdict: ChannelsVerdict = claudeChannels({ env: o.env, parentCmd: o.parentCmd, entry: ENTRY, files: o.files });
  const push = verdict.state === "on";
  // The reason carries its remedy where there is one; the instructions, the
  // first tool result and stderr each say it once, as the local servers do.
  const offNotice = verdict.state === "on" ? undefined : channelsOffNotice(verdict.reason);
  let offPending = offNotice !== undefined;
  const place = describeLocation(o.cwd) ?? HARNESS;
  // Attachments come from and go to the session's directory and the project's.
  const project = o.env.CLAUDE_PROJECT_DIR;
  const roots = [...new Set([...attachRoots(o.env, o.cwd), ...(project ? attachRoots({}, project) : [])])];
  const say = (message: string) => o.log(`[grayboard] ${message}`);

  let closed = false;
  let initialized = false;
  let markInitialized!: () => void;
  const ready = new Promise<void>(r => { markInitialized = r; });
  let notice: string | undefined;        // shown once, at the head of the next tool result
  let held: string | undefined;          // set while another process holds delivery for this session
  let signedOut: AccessExpired | undefined; // why the last start failed for want of a sign-in
  let begun: string | undefined;         // the store epoch this root last (re)started under
  let used = false;                      // a call went out under this session's id
  let controller: Controller | undefined, lock: Lock | undefined, proxy: ToolProxy | undefined;
  let waiter: AbortController | undefined;
  let watcher: { dispose(): void } | undefined;
  let restarting: Promise<void> | undefined;
  let signingIn: { abort: AbortController; done: Promise<void> } | undefined;

  // Made by connect(), once its initialize instructions are known: the 1.x
  // Server answers initialize from its constructor's options. Everything
  // below that uses it runs after initialize.
  let server: Server | undefined;

  const tools = (): NativeTool[] => proxy?.tools() ?? hostTools(snapshotTools());
  const listChanged = () => { if (initialized && !closed) void server?.sendToolListChanged().catch(() => {}); };

  // ---- sign-in ----

  const login = "error" in config ? undefined : new Login({
    resource: config.url, clientId: CLIENT_ID, stateDir: config.dataDir, harness: HARNESS, loginAction,
    // MCP URL elicitation: Claude Code asks the user to open the authorization
    // URL. A decline ends this flow; the next tool call offers it again.
    present: async url => {
      const abort = signingIn?.abort.signal;
      if (!server!.getClientCapabilities()?.elicitation?.url) {
        // Claude Code switched URL elicitation off (tengu_mcp_url_elicitation):
        // the next tool result carries the URL instead.
        notice = `open ${url} to sign in to grayboard`;
        say(notice);
        return;
      }
      const elicitationId = randomUUID();
      const result = await server!.elicitInput(
        { mode: "url", elicitationId, url, message: `Sign in to grayboard at ${new URL(config.url).origin} for this Claude Code session.` },
        { timeout: FLOW_MS, ...(abort ? { signal: abort } : {}) },
      );
      if (result.action !== "accept") throw new LoginFailed(result.action === "decline" ? "sign-in declined" : "sign-in cancelled");
      complete = () => server!.createElicitationCompletionNotifier(elicitationId)().catch(() => {});
    },
    notify: message => say(message),
    diagnostic: record => {
      if (record.state !== "degraded" && record.state !== "paused") return;
      notice = record.message;
      say(record.message);
    },
  });
  let complete: (() => Promise<void>) | undefined;

  // At most one sign-in in this process; hosted-core's login lock keeps it to
  // one across processes (a waiter shares the winner's grant). Never under
  // -p or the SDK: the process may exit before the browser returns.
  const signIn = () => {
    if (!login || !interactive || closed || signingIn || !initialized) return;
    const abort = new AbortController();
    const done = login.login(abort.signal).then(
      async () => {
        await complete?.();
        say("signed in");
        await credentialChanged();
      },
      error => {
        const message = error instanceof LoginFailed || error instanceof Refusal ? error.message : (error as Error)?.message ?? String(error);
        if (!abort.signal.aborted) say(`sign-in failed: ${message}`);
      },
    ).finally(() => { complete = undefined; if (signingIn?.done === done) signingIn = undefined; });
    signingIn = { abort, done };
  };

  let last: string | undefined;
  const auth: AuthProvider = {
    token: async () => (last = await login!.token()),
    onUnauthorized: async () => login!.unauthorized(last ?? ""),
  };
  const wireOptions = (mode: "push" | "poll"): WireOptions => ({
    url: login!.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT_ID, version: o.version }, delivery: { mode, source: SOURCE },
  });

  // ---- delivery ----

  const port = (id: string, store: FileStorage): HostPort => ({
    harness: HARNESS, resumeHint: RESUME_HINT, loginAction, sessionKey: GRAYBOARD_SESSION_META,
    client: { name: CLIENT_ID, version: o.version }, delivery: { mode: "push", source: SOURCE },
    storage: store,
    place: () => place,
    ancestry: async sessionID => {
      if (sessionID !== id) throw new AncestryError(`Grayboard session ${sessionID} isn't this Claude Code session`);
      return { sessionID, root: id, via: [] };
    },
    credential: login!.credential(),
    approval: null,
    // Claude Code drops a notification sent before `initialized`; the
    // Controller receipts only after this resolves, and its admission set
    // keeps a failed receipt from showing an item twice.
    admit: async (_e, item, _stableID, identity) => {
      await ready;
      if (closed) throw new Refusal("paused", "the Claude Code session closed");
      await server!.notification({ method: "notifications/claude/channel", params: channelParams(item, identity) });
    },
  });

  const newProxy = (mode: "push" | "poll") => new ToolProxy({
    wire: wireOptions(mode), harness: HARNESS, loginAction, auth, roots, env: o.env,
    ...(mode === "push" && controller ? { hooks: controller } : {}),
    report: (operation, error) => {
      if (operation === "after") controller?.backgroundFailure("after");
      say(`${operation} failed: ${(error as Error)?.message ?? String(error)}`);
    },
    onTools: () => listChanged(),
  });

  const connect = async () => {
    if (!proxy) return;
    try { await proxy.connect(); }
    catch (error) { if (!accessExpiry(error)) say(`couldn't reach the server: ${(error as Error).message}`); }
  };

  // (Re)starts this session's delivery, rebinding the name it last held. A
  // name that didn't take back is said in the next tool result.
  const begin = async () => {
    if (!controller || "error" in config || closed) return;
    const id = config.id;
    try {
      begun = (await login!.read().catch(() => undefined))?.epoch;
      const expected = await controller.carried(id);
      const status = await controller.resume(id);
      signedOut = undefined;
      proxy?.forget(id);
      const root = status.roots.find(r => r.sessionID === id);
      const bound = root && root.operation !== "enroll" && root.state !== "unbound" ? root.name : undefined;
      if (expected && bound !== expected && root?.state !== "paused") {
        notice = `this session couldn't take back its name ${expected} (${root?.message ?? status.message}); ${bound ? `it is bound as ${bound}` : "it is unbound"}`;
        say(notice);
      }
    } catch (error) {
      const expired = accessExpiry(error);
      if (!expired) { say(`couldn't start delivery: ${(error as Error).message}`); return; }
      signedOut = expired;
    }
  };
  const restart = () => restarting ??= begin().finally(() => { restarting = undefined; });

  // The Controller's records. A pause or degradation its run loop reaches on
  // its own is said in the next tool result; a credential change is
  // credentialChanged's (the drift message), and a shutdown's pause nobody's.
  let lastBinding: string | undefined, lastRecord: string | undefined;
  const sink: DiagnosticSink = async record => {
    if ("error" in config || record.sessionID !== config.id) return;
    const binding = `${record.state}\n${record.name ?? ""}`;
    if (binding !== lastBinding) { lastBinding = binding; proxy?.forget(config.id); }
    const key = `${record.state}\n${record.message}`;
    if (key === lastRecord) return;
    lastRecord = key;
    if (record.state !== "paused" && record.state !== "degraded" || record.operation === "session_end" || record.message.startsWith(DRIFTED)) return;
    const epoch = (await login!.read().catch(() => undefined))?.epoch;
    if (epoch !== begun) return;
    notice = `delivery ${record.state}: ${record.message}`;
    say(notice);
  };

  // The lock is ours: run the Controller and declare push delivery.
  const own = async (taken: Lock) => {
    if (closed || "error" in config) { taken.release(); return; }
    lock = taken; if (notice === held) notice = undefined; held = undefined;
    controller = new Controller(port(config.id, new FileStorage(sessionPath(config.dataDir, login!.resource, CLIENT_ID, config.id))), { sink });
    await controller.restore().catch(() => {});
    // The tools-only proxy's calls in flight finish on it.
    const old = proxy;
    proxy = newProxy("push");
    void old?.retire().catch(() => {});
    void connect();
    await begin();
  };

  // Delivery for this session id, unless another process (`claude --resume
  // <id>` in a second terminal) holds it: tools only until that one exits.
  const start = async () => {
    if ("error" in config) return;
    watcher = login!.watch(() => { void credentialChanged(); });
    if (!push) { proxy = newProxy("poll"); void connect(); return; }
    const path = deliveryPath(config.dataDir, login!.resource, CLIENT_ID, config.id);
    const taken = tryDelivery(path);
    if (taken) return own(taken);
    held = new DeliveryHeldElsewhere(HARNESS).message;
    notice = held;
    proxy = newProxy("poll");
    void connect();
    waiter = new AbortController();
    void waitDelivery(path, waiter.signal).then(next => own(next), () => {});
  };

  // A sign-in or sign-out in any process (the store's epoch).
  const credentialChanged = async () => {
    if (closed) return;
    try { await login!.token(); }
    catch (error) {
      const expired = accessExpiry(error);
      if (!expired) say(`couldn't read the sign-in: ${(error as Error)?.message ?? String(error)}`);
      return;
    }
    // Another process's sign-in landed first: this one's prompt is moot.
    signingIn?.abort.abort();
    void connect();
    if (!controller) return;
    await restarting;
    const epoch = (await login!.read().catch(() => undefined))?.epoch;
    if (!signedOut && epoch !== undefined && epoch === begun) return;
    await restart();
  };

  // ---- tools ----

  // A root paused for anything but a sign-out restarts on the next call;
  // the result says why it had paused, then how the restart went.
  const unpause = async (): Promise<string | undefined> => {
    if (!controller || "error" in config) return undefined;
    const root = controller.status().roots.find(r => r.sessionID === config.id);
    if (root?.state !== "paused" || signedOut) return undefined;
    const why = root.message;
    await restart();
    const now = controller.status().roots.find(r => r.sessionID === config.id);
    return `delivery was paused (${why}); restarted: ${now ? `${now.state}${now.state === "active" ? "" : `, ${now.message}`}` : "not running"}`;
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if ("error" in config) return failure(config.error);
    if (!proxy) return failure("the grayboard plugin hasn't started yet");
    const signed = await login!.token().then(() => true, () => false);
    if (!signed) signIn();
    const restarted = signed ? await unpause() : undefined;
    used = true;
    let result: CallToolResult;
    try { result = await proxy.call(name, args, config.id); }
    catch (error) { result = failure(failureMessage(error, RESUME_HINT)); }
    const shown = [offPending ? offNotice : undefined, notice, restarted].filter((n): n is string => !!n);
    notice = undefined;
    offPending = false;
    return shown.length ? { ...result, content: [...shown.map(n => ({ type: "text" as const, text: `grayboard: ${n}` })), ...result.content] } : result;
  };

  const serve = (instructions: string): Server => {
    const s = new Server(
      { name: "grayboard", version: o.version },
      { capabilities: { experimental: { "claude/channel": {} }, tools: { listChanged: true } }, instructions },
    );
    // The SDK 2 client's tool and result shapes are the 1.x server's, field for field.
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() as ListedTool[] }));
    s.setRequestHandler(CallToolRequestSchema, async req => await call(req.params.name, req.params.arguments ?? {}) as ServerResult);
    s.oninitialized = () => {
      initialized = true;
      markInitialized();
      // A session without a grant offers the sign-in at once.
      if (login && interactive) void login.token().catch(error => { if (accessExpiry(error)) signIn(); });
    };
    return s;
  };

  // ---- instructions ----

  // The server's own initialize instructions for this session, as written for
  // the declared delivery; Claude Code reads instructions only at initialize.
  const instructions = async (): Promise<string> => {
    if ("error" in config) return `Warning: grayboard is unavailable: ${config.error}. Tell the user.`;
    const lead = offNotice;
    let body: string;
    try {
      const text = await Promise.race([
        proxy!.instructions(config.id),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), INSTRUCTIONS_MS).unref?.()),
      ]);
      body = text ?? "";
    } catch (error) {
      const expired = accessExpiry(error);
      body = expired
        ? `Grayboard (${login!.resource}) is signed out in Claude Code: ${loginAction}. Until then its tools return a sign-in error.`
        : `Warning: the grayboard server at ${new URL(login!.resource).origin} couldn't be reached at startup, so these instructions are incomplete; its tools retry on every call. Bind a name with bind before posting.`;
    }
    return [lead, held ? `Warning: ${held}; this session is tools-only until it exits.` : undefined, body].filter(Boolean).join("\n\n");
  };

  const connectTransport = async (transport: Transport) => {
    // Delivery starts (and rebinds) first, so the instructions say the bound name.
    const deadline = new Promise<void>(r => setTimeout(r, INSTRUCTIONS_MS).unref?.());
    await Promise.race([start(), deadline]);
    server = serve(await instructions());
    if (offNotice) say(offNotice);
    await server.connect(transport);
  };

  const shutdown = async () => {
    if (closed) return;
    closed = true;
    watcher?.dispose();
    waiter?.abort();
    signingIn?.abort.abort();
    if (!("error" in config)) {
      const id = config.id;
      // The lease's release frees the name now, not at the idle sweep.
      if (controller) await controller.shutdown(id, "release").catch(error => say(`couldn't release delivery: ${(error as Error)?.message ?? String(error)}`));
      // Channels off: no lease, so end the session the calls bound. Never
      // while another process holds this session's delivery: that would end its session.
      else if (used && !held && login) {
        const wire = new Wire(wireOptions("poll"), auth, AbortSignal.timeout(5_000), id);
        try { await wire.connect(); await wire.call("session_end"); }
        catch (error) { if (!accessExpiry(error)) say(`couldn't end session ${id} on the server: ${(error as Error)?.message ?? String(error)}`); }
        finally { await wire.close().catch(() => {}); }
      }
    }
    await controller?.close().catch(() => {});
    lock?.release();
    await proxy?.close().catch(() => {});
    await server?.close().catch(() => {});
  };

  return { connect: connectTransport, shutdown };
}
