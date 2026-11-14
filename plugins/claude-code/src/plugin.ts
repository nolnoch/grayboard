// The grayboard Claude Code plugin's one stdio MCP server (#281): the
// channel and the tool proxy for a hosted grayboard server, on hosted-core.
// It signs in as the built-in client `grayboard-claude-code` with its own
// grant (stored in CLAUDE_PLUGIN_DATA, shared by every session on this
// machine), forwards the server's tools with CLAUDE_CODE_SESSION_ID in
// `_meta` (hosted-core's HostedClient), and holds the session's delivery
// lease (hosted-core's RootDelivery) only when Claude Code will show its
// channel notifications (the shared rule, src/shared/claude_channels.ts).
//
// Claude Code runs one plugin process per session, and its subagents call
// through it. The plugin's hooks (hooks/hooks.json, dist/hook.js) record which
// agent made each grayboard call, keyed by its tool_use_id (#551,
// src/shared/claude_agents.ts): a subagent's call runs as a child session
// registered under this root, a main-agent call as the root, and a call with
// no record is refused, never attributed to the root. The process keeps
// CLAUDE_CODE_SESSION_ID across /clear (a reconnect starts a new one).
//
// The server stays on MCP SDK 1.x: Claude Code skips a channel whose session
// negotiated protocol 2026-07-28 or later, and 1.x tops out at 2025-11-25.
import { randomUUID } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult as ServerResult, type Tool as ListedTool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { channelParams } from "../../../adapters/hosted-core/src/channel.ts";
import { HostedClient, message } from "../../../adapters/hosted-core/src/client.ts";
import { Login, LoginFailed } from "../../../adapters/hosted-core/src/login.ts";
import { accessExpiry } from "../../../adapters/hosted-core/src/model.ts";
import * as signIns from "../../../adapters/hosted-core/src/offer.ts";
import type { Flow, SignInState } from "../../../adapters/hosted-core/src/offer.ts";
import { failure, hostTools, snapshotTools, type NativeTool } from "../../../adapters/hosted-core/src/proxy.ts";
import { NotStarted, RootDelivery } from "../../../adapters/hosted-core/src/root.ts";
import { CLAUDE_PLUGIN, claudeChannels, interactiveClaude, type ChannelsVerdict, type ClaudeFiles } from "../../../src/shared/claude_channels.ts";
import { attachRoots } from "../../../src/shared/attachments.ts";
import { dropSignIn, MISSING_TEXT, putSignIn, readFacts, sessionDir, takeEnded, takeRecord, TOOL_USE_META } from "../../../src/shared/claude_agents.ts";
import { SIGN_IN_FLOW_MS } from "../../../src/shared/signin.ts";
import { testPauseAsync } from "../../../src/shared/testpause.ts";
import { canonicalEndpoint } from "../../../src/shared/endpoint.ts";
import { configuredIdentity, describeLocation, sessionIdentity } from "../../../src/shared/identity.ts";
import { channelsOffNotice } from "../../../src/shared/toolguard.ts";

export const HARNESS = "Claude Code";
export const CLIENT_ID = "grayboard-claude-code";
// The channel's source as Claude Code names a plugin's server: plugin:<plugin>:<server>.
export const SOURCE = "plugin:grayboard:grayboard";
export const ENTRY = `plugin:${CLAUDE_PLUGIN}` as const;
export const RESUME_HINT = "call any grayboard tool to retry";
// How each kind of session signs in, for AccessExpired and the instructions.
export const LOGIN_INTERACTIVE = "open the sign-in link Claude Code shows under a grayboard tool call, or approve the sign-in prompt Claude Code shows";
export const LOGIN_ELSEWHERE = "sign in from an interactive Claude Code session (call any grayboard tool there)";
const INSTRUCTIONS_MS = 5_000;
// Claude Code 2.1.316 answers an elicitation that lands while it is still
// wiring the connection with an immediate cancel, never shown. A cancel this
// fast came from that handler, not a person: the prompt is sent again, up to
// RESENDS times, RESEND_MS apart, while the flow is still open.
const UNSHOWN_MS = 1_000;
const RESEND_MS = 500;
const RESENDS = 3;

export type PluginOptions = {
  env: Record<string, string | undefined>;
  parentCmd: string | null; // Claude Code's command line, or null when unreadable
  files: ClaudeFiles;
  version: string;
  cwd: string;
  // Claude Code's process (this server's parent) and its start time, read once
  // at startup: the hooks' record dir is keyed by it (CLAUDE_PID), and a dir
  // whose start differs is a recycled pid's.
  claude: { pid: number; start: string | null };
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
  // An explicit BUS_IDENTITY: this session binds it at its first start (#443).
  const configured = configuredIdentity(o.env, o.cwd);
  // The name local mode would suggest here (#522): the pin or the repo's, with the worktree suffix. None when the
  // directory gives no name (defaultIdentity throws).
  const suggestion = (() => { try { return sessionIdentity(o.env, o.cwd); } catch { return undefined; } })();
  // Attachments come from and go to the session's directory and the project's.
  const project = o.env.CLAUDE_PROJECT_DIR;
  const roots = [...new Set([...attachRoots(o.env, o.cwd), ...(project ? attachRoots({}, project) : [])])];
  const say = (message: string) => o.log(`[grayboard] ${message}`);

  let closed = false;
  let initialized = false;
  const { promise: ready, resolve: markInitialized } = Promise.withResolvers<void>();
  // This process's sign-in record (hosted-core offer.ts), and each flow's
  // open elicitation: one live prompt, withdrawn once the browser answers or
  // the flow shows another URL (a waiter's next holder's).
  type Prompt = { id: string; withdraw: AbortController };
  const signins: SignInState = {};
  const prompts = new WeakMap<Flow, Prompt>();

  // Made by connect(), once its initialize instructions are known: the 1.x
  // Server answers initialize from its constructor's options. Everything
  // below that uses it runs after initialize.
  let server: Server | undefined;

  const listChanged = () => { if (initialized && !closed) void server?.sendToolListChanged().catch(() => {}); };

  // ---- sign-in ----

  const login = "error" in config ? undefined : new Login({
    resource: config.url, clientId: CLIENT_ID, stateDir: config.dataDir, harness: HARNESS, loginAction,
    // Every grayboard call while the flow runs shows the URL under the call
    // (#497: Claude Code may never show the prompt, or show it only after the
    // result): the hook after the call prints it as the user's line, never the
    // model's (#500), so it is written before the waiting call's result
    // returns. Where it can, Claude Code also asks the user to open it (MCP
    // URL elicitation); a decline ends the flow and the next call starts one.
    // A session waiting on another process's flow gets that flow's URL too.
    present: async url => {
      const flow = signins.flow;
      await testPauseAsync("claude-sign-in-present", o.env);
      try { putSignIn(config.dataDir, o.claude.pid, url); }
      catch (error) { say(`couldn't save the sign-in link for the hook to show: ${message(error)}; approve the sign-in prompt, or open the link in this log`); }
      signIns.present(signins, url);
      say(`open ${url} to sign in to grayboard`);
      // Claude Code switched URL elicitation off (tengu_mcp_url_elicitation): the link alone.
      if (!server!.getClientCapabilities()?.elicitation?.url) return;
      // Login calls present only inside login(), which begin()'s signIns.start
      // runs after setting the flow, so there always is one (#506).
      if (!flow) return;
      for (let sent = 0; ; sent++) {
        const prompt: Prompt = { id: randomUUID(), withdraw: new AbortController() };
        prompts.get(flow)?.withdraw.abort();
        prompts.set(flow, prompt);
        say(`sign-in prompt sent (elicitation ${prompt.id})`);
        const start = Date.now();
        let result;
        try {
          result = await server!.elicitInput(
            { mode: "url", elicitationId: prompt.id, url, message: `Sign in to grayboard at ${new URL(config.url).origin} for this Claude Code session.` },
            { timeout: SIGN_IN_FLOW_MS, signal: AbortSignal.any([flow.abort.signal, prompt.withdraw.signal]) },
          );
        } catch (error) {
          // Withdrawn: the browser answered first, and the flow went on without it.
          if (prompt.withdraw.signal.aborted) return;
          say(`sign-in prompt (elicitation ${prompt.id}) ended without an answer: ${message(error)}`);
          throw error;
        }
        const ms = Date.now() - start;
        say(`sign-in prompt (elicitation ${prompt.id}) answered: ${result.action} after ${ms} ms`);
        // Only a decline ends the flow: Esc (cancel) may just free the keyboard
        // from a prompt Claude Code keeps up while the user finishes the link.
        if (result.action === "decline") throw new LoginFailed("sign-in declined");
        if (result.action !== "cancel" || ms >= UNSHOWN_MS) return;
        if (sent >= RESENDS) { say(`sign-in prompt cancelled unshown ${sent + 1} times; the link Claude Code shows under each grayboard call remains`); return; }
        say(`sign-in prompt cancelled unshown; sending it again (${sent + 1}/${RESENDS}) in ${RESEND_MS} ms`);
        await after(RESEND_MS);
        await testPauseAsync("claude-sign-in-resend", o.env);
        // The flow ended (signed in, failed, aborted) while waiting: nothing to ask.
        if (signins.flow !== flow || flow.abort.signal.aborted) { say("sign-in ended before the prompt was sent again"); return; }
        // A later URL's prompt replaced this one.
        if (prompts.get(flow) !== prompt) return;
      }
    },
    notify: message => {
      say(message);
      signIns.notify(signins, message);
    },
    // The link file's records (refused, unshared) only to the user's log:
    // the model can't act on them (#592).
    diagnostic: record => {
      if (record.state !== "degraded" && record.state !== "paused") return;
      if (record.operation !== "login_link") root?.noticeOnce(record.message, "last");
      say(record.message);
    },
  });

  // A bad fact file is said once and left out; the other fact still goes.
  const badFacts = new Set<string>();
  const badFact = (fact: string, error: string) => {
    if (badFacts.has(fact)) return;
    badFacts.add(fact);
    say(`the server gets no ${fact} for this session: ${error}`);
  };
  const client = "error" in config || !login ? undefined : new HostedClient({
    harness: HARNESS, clientId: CLIENT_ID, version: o.version, login, source: SOURCE,
    loginAction, resumeHint: RESUME_HINT, retryHint: RESUME_HINT, roots, env: o.env, launcher: o.env.BUS_LAUNCHER === "1", log: message => say(message),
    // The root's model and effort as the hooks last wrote them (#545), read per
    // request; a child session reports none (no hook names a subagent's model).
    facts: sessionID => sessionID === config.id ? readFacts(config.dataDir, o.claude.pid, o.claude.start, badFact) : undefined,
    // The root's suggested name, local mode's (#522); a child's is the server's to ignore, so it sends none.
    ...(suggestion ? { suggested: (sessionID: string) => sessionID === config.id ? suggestion : undefined } : {}),
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
    sessionID: config.id, stateDir: config.dataDir, place: () => place, push, ...(configured && "name" in configured ? { configured: configured.name } : {}),
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
  const badIdentity = configured && "error" in configured ? `BUS_IDENTITY is ignored: ${configured.error}` : undefined;
  if (badIdentity) say(badIdentity);
  const firstNotice = [offNotice, badIdentity].filter(Boolean).join(" ");
  if (firstNotice) root?.noticeOnce(firstNotice, "first");
  // At most one sign-in in this process; hosted-core's login lock keeps it to
  // one across processes (a waiter shares the winner's grant, and shows the
  // winner's link meanwhile). Never under -p or the SDK: the process may exit
  // before the browser returns.
  const begin = (origin: "offer" | "startup"): Flow | undefined => {
    if (signins.flow) return signins.flow;
    if (!login || !root || !interactive || closed || !initialized) return undefined;
    const flow = signIns.start(signins, login, { origin, browser: false, ifSignedOut: true, ended: async (flow, outcome) => {
      const prompt = prompts.get(flow);
      try {
        // The prompt is done either way: completed if it was accepted, and
        // withdrawn if the link the hook showed was opened instead.
        if (outcome === "signed in") {
          if (prompt) await server!.createElicitationCompletionNotifier(prompt.id)().catch(() => {});
          say(`signed in (${origin})`);
          await root.credentialChanged();
        } else if (outcome !== "cancelled") say(`sign-in failed (${[origin, ...(prompt ? [`elicitation ${prompt.id}`] : [])].join(", ")}): ${flow.failed}`);
      } finally {
        // However the flow ended, its prompt and link point at a closed callback.
        prompt?.withdraw.abort();
        // Only this flow's link: a later flow may have written its own.
        if (flow.url && !("error" in config)) {
          try { dropSignIn(config.dataDir, o.claude.pid, flow.url); }
          catch (error) { say(`couldn't remove the ended sign-in's link: ${message(error)}; the hook stops showing it ${SIGN_IN_FLOW_MS / 60_000} minutes after it was written`); }
        }
      }
    } });
    // Ends without `ended` when the store was already signed in (#592).
    void flow.done.then(() => { if (flow.outcome === "current") say(`sign-in not needed (${origin}): already signed in`); }, () => {});
    return flow;
  };
  // What a signed-out call's result says about its sign-in (hosted-core
  // offer.ts). The link itself never enters a result (#500).
  const notes = {
    started: "sign-in started: ask the user to open the sign-in link Claude Code shows under this call (or approve its sign-in prompt), then call a grayboard tool again",
    starting: "sign-in is starting; Claude Code shows its link under the next grayboard call: ask the user to open it, then call a grayboard tool again",
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
  const before = async (): Promise<string | undefined> =>
    await signIns.offer(signins, login!, { interactive, begin: () => begin("offer"), notes }) ?? await unpause();

  // ---- subagents (#551) ----

  // A subagent's hosted child id: its agent id under this root's session id,
  // unique on the server however Claude Code numbers its agents.
  const childOf = (agent: string) => `${(config as { id: string }).id}/agent/${agent}`;
  // SubagentStop's markers end each child's hosted session: the server's idle
  // sweep ends only roots, so an unended child lasts until its root does.
  // Watched once the first child call shows the session's record dir exists,
  // and drained by every child call too, so a missed or coalesced watch event
  // (or a failed watch) delays an end by one call at most.
  let endWatch: FSWatcher | undefined;
  const drainEnded = () => {
    if ("error" in config || closed) return;
    for (const agent of takeEnded(config.dataDir, o.claude.pid)) void root?.endChild(childOf(agent));
  };
  const watchEnded = () => {
    if (endWatch || "error" in config || closed) return;
    const dir = join(sessionDir(config.dataDir, o.claude.pid), "ended");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      endWatch = watch(dir, () => drainEnded());
      endWatch.on("error", error => { say(`stopped watching subagent ends: ${message(error)}; they end at the next subagent call, or with this session`); endWatch?.close(); });
    } catch (error) { say(`couldn't watch subagent ends: ${message(error)}; they end at the next subagent call, or with this session`); }
    drainEnded();
  };

  const call = async (name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined): Promise<CallToolResult> => {
    if ("error" in config) return failure(config.error);
    // No tool_use_id: not a model's call (nothing to join); it acts as the root.
    const toolUse = meta?.[TOOL_USE_META];
    if (toolUse === undefined) return root!.call(name, args, before);
    const taken = takeRecord(config.dataDir, o.claude.pid, o.claude.start, toolUse);
    if ("missing" in taken) {
      const cause = MISSING_TEXT[taken.missing];
      say(`refused ${name} (tool_use_id ${String(toolUse).slice(0, 160)}): no agent record: ${cause}`);
      return failure(`grayboard couldn't tell which Claude Code agent made this call (${cause}), so it didn't run. Restart Claude Code so the grayboard plugin's hooks run; hooks turned off (disableAllHooks, or managed settings that allow only managed hooks) stop every grayboard call.`);
    }
    if (taken.agent === null) return root!.call(name, args, before);
    watchEnded();
    drainEnded();
    return root!.call(name, args, before, { child: childOf(taken.agent) });
  };

  const tools = (): NativeTool[] => root?.tools() ?? hostTools(snapshotTools());

  const serve = (instructions: string): Server => {
    const s = new Server(
      { name: "grayboard", version: o.version },
      { capabilities: { experimental: { "claude/channel": {} }, tools: { listChanged: true } }, instructions },
    );
    // The SDK 2 client's tool and result shapes are the 1.x server's, field for field.
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() as ListedTool[] }));
    s.setRequestHandler(CallToolRequestSchema, async req => await call(req.params.name, req.params.arguments ?? {}, req.params._meta) as ServerResult);
    s.oninitialized = () => {
      initialized = true;
      markInitialized();
      // A session without a grant offers the sign-in at once.
      if (login && interactive) void login.token().catch(error => { if (accessExpiry(error)) begin("startup"); });
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
    // A link a killed predecessor left (Claude Code kills a stdio server 500 ms
    // after stop, and a /mcp reconnect replaces it) names a closed callback.
    if (!("error" in config)) {
      try { dropSignIn(config.dataDir, o.claude.pid); }
      catch (error) { say(`couldn't remove a sign-in link a previous server left: ${message(error)}`); }
    }
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
    endWatch?.close();
    signins.flow?.abort.abort();
    await root?.shutdown("release");
    await server?.close().catch(() => {});
  };

  return { connect: connectTransport, shutdown };
}
