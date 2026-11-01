// The grayboard Claude Code plugin's one stdio MCP server (#281): the
// channel and the tool proxy for a hosted grayboard server, on hosted-core.
// It signs in as the built-in client `grayboard-claude-code` with its own
// grant (stored in CLAUDE_PLUGIN_DATA, shared by every session on this
// machine), forwards the server's tools with CLAUDE_CODE_SESSION_ID in
// `_meta` (hosted-core's HostedClient), and holds the session's delivery
// lease (hosted-core's RootDelivery) only when Claude Code will show its
// channel notifications (the shared rule, src/shared/claude_channels.ts).
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
import type { CallToolResult } from "@modelcontextprotocol/client";
import { channelParams } from "../../../adapters/hosted-core/src/channel.ts";
import { HostedClient } from "../../../adapters/hosted-core/src/client.ts";
import { Login, LoginFailed } from "../../../adapters/hosted-core/src/login.ts";
import { accessExpiry, Refusal } from "../../../adapters/hosted-core/src/model.ts";
import { failure, hostTools, snapshotTools, type NativeTool } from "../../../adapters/hosted-core/src/proxy.ts";
import { NotStarted, RootDelivery } from "../../../adapters/hosted-core/src/root.ts";
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
  const place = describeLocation(o.cwd) ?? HARNESS;
  // Attachments come from and go to the session's directory and the project's.
  const project = o.env.CLAUDE_PROJECT_DIR;
  const roots = [...new Set([...attachRoots(o.env, o.cwd), ...(project ? attachRoots({}, project) : [])])];
  const say = (message: string) => o.log(`[grayboard] ${message}`);

  let closed = false;
  let initialized = false;
  const { promise: ready, resolve: markInitialized } = Promise.withResolvers<void>();
  let signingIn: { abort: AbortController; done: Promise<void> } | undefined;

  // Made by connect(), once its initialize instructions are known: the 1.x
  // Server answers initialize from its constructor's options. Everything
  // below that uses it runs after initialize.
  let server: Server | undefined;

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
        const text = `open ${url} to sign in to grayboard`;
        root?.noticeOnce(text, "last");
        say(text);
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
      root?.noticeOnce(record.message, "last");
      say(record.message);
    },
  });
  let complete: (() => Promise<void>) | undefined;

  const client = login && new HostedClient({
    harness: HARNESS, clientId: CLIENT_ID, version: o.version, login, source: SOURCE,
    loginAction, resumeHint: RESUME_HINT, retryHint: RESUME_HINT, roots, env: o.env, log: message => say(message),
  });

  // Resolves at `initialized`; rejects once `signal` (the run loop's) aborts.
  const initializedOr = (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const { promise: aborted, reject } = Promise.withResolvers<void>();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return Promise.race([ready, aborted]).finally(() => signal.removeEventListener("abort", abort));
  };

  const root = client && !("error" in config) ? new RootDelivery(client, {
    sessionID: config.id, stateDir: config.dataDir, place: () => place, push,
    // Claude Code drops a notification sent before `initialized`; the
    // Controller receipts only after this resolves, and its admission set
    // keeps a failed receipt from showing an item twice. A stop (the run
    // loop's signal) releases the wait without a pause.
    admit: async (item, _stableID, identity, signal) => {
      if (!initialized) await initializedOr(signal);
      await server!.notification({ method: "notifications/claude/channel", params: channelParams(item, identity) });
    },
    onTools: () => listChanged(),
  }) : undefined;
  if (offNotice) root?.noticeOnce(offNotice, "first");
  // Another process's sign-in landed: this one's prompt is moot.
  const changes = client?.onChange(signedIn => { if (signedIn) signingIn?.abort.abort(); });

  // At most one sign-in in this process; hosted-core's login lock keeps it to
  // one across processes (a waiter shares the winner's grant). Never under
  // -p or the SDK: the process may exit before the browser returns.
  const signIn = () => {
    if (!login || !root || !interactive || closed || signingIn || !initialized) return;
    const abort = new AbortController();
    const done = login.login(abort.signal).then(
      async () => {
        await complete?.();
        say("signed in");
        await root.credentialChanged();
      },
      error => {
        const message = error instanceof LoginFailed || error instanceof Refusal ? error.message : (error as Error)?.message ?? String(error);
        if (!abort.signal.aborted) say(`sign-in failed: ${message}`);
      },
    ).finally(() => { complete = undefined; if (signingIn?.done === done) signingIn = undefined; });
    signingIn = { abort, done };
  };

  // ---- tools ----

  // Before each call, unless signed out: a root paused for anything but a
  // sign-out restarts, and a delivery lock that couldn't be taken is tried
  // again (Claude Code has no resume command); the result says why, then how
  // it went. A lock retry that fails again says so itself (the root's own
  // notice), so nothing is added for it.
  const unpause = async (): Promise<string | undefined> => {
    if (!root || "error" in config) return undefined;
    const before = root.status();
    if (before.signedOut) return undefined;
    const state = () => {
      const now = root.status();
      if (now.held) return "another process holds delivery";
      const record = now.controller?.roots.find(r => r.sessionID === config.id);
      return record ? `${record.state}${record.state === "active" ? "" : `, ${record.message}`}` : "not running";
    };
    if (before.error) {
      await root.resume();
      return root.status().error ? undefined : `delivery couldn't start (${before.error}); retried: ${state()}`;
    }
    const paused = before.controller?.roots.find(r => r.sessionID === config.id);
    if (paused?.state !== "paused") return undefined;
    await root.resume();
    return `delivery was paused (${paused.message}); restarted: ${state()}`;
  };
  // Before each call: only a missing or expired sign-in offers one; a
  // transient failure (5xx, a refresh in progress) goes to the call, which
  // reports it.
  const before = async (): Promise<string | undefined> => {
    try { await login!.token(); }
    catch (error) { if (accessExpiry(error)) { signIn(); return undefined; } }
    return unpause();
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if ("error" in config) return failure(config.error);
    return root!.call(name, args, before);
  };

  const tools = (): NativeTool[] => root?.tools() ?? hostTools(snapshotTools());

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

  // A timer that never keeps the process alive.
  const after = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms).unref?.();
    return promise;
  };

  // The server's own initialize instructions for this session, as written for
  // the declared delivery; Claude Code reads instructions only at initialize.
  const instructions = async (): Promise<string> => {
    if ("error" in config) return `Warning: grayboard is unavailable: ${config.error}. Tell the user.`;
    let body: string;
    try {
      const text = await Promise.race([root!.instructions(), after(INSTRUCTIONS_MS).then(() => { throw new Error("timeout"); })]);
      body = text ?? "";
    } catch (error) {
      const expired = accessExpiry(error);
      body = error instanceof NotStarted
        ? "Grayboard is still starting, so these instructions are incomplete; its tools work once it is up. Bind a name with bind before posting."
        : expired
        ? `Grayboard (${login!.resource}) is signed out in Claude Code: ${loginAction}. Until then its tools return a sign-in error.`
        : `Warning: the grayboard server at ${new URL(login!.resource).origin} couldn't be reached at startup, so these instructions are incomplete; its tools retry on every call. Bind a name with bind before posting.`;
    }
    const { held, error } = root!.status();
    const warning = held ? `Warning: ${held}; this session is tools-only until it exits.`
      : error ? `Warning: grayboard delivery couldn't start (${error}); this session is tools-only, and each grayboard tool call retries it.`
      : undefined;
    return [offNotice, warning, body].filter(Boolean).join("\n\n");
  };

  const connectTransport = async (transport: Transport) => {
    // Delivery starts (and rebinds) first, so the instructions say the bound
    // name; start() never rejects, so the race is safe.
    await Promise.race([root?.start(), after(INSTRUCTIONS_MS)]);
    server = serve(await instructions());
    if (offNotice) say(offNotice);
    await server.connect(transport);
  };

  // The lease's release (RootDelivery's shutdown order) goes first: Claude
  // Code kills a stdio server 500 ms after it asks it to stop.
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    changes?.dispose();
    signingIn?.abort.abort();
    await root?.shutdown("release");
    await server?.close().catch(() => {});
  };

  return { connect: connectTransport, shutdown };
}
