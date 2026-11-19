import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller, type Wait } from "./core/controller.js";
import { failureCode, failureMessage, type DiagnosticSink } from "./core/diagnostics.js";
import type { HostPort, SessionFacts } from "./core/port.js";
import { AccessExpired, Refusal, render } from "./core/model.js";
import { resolveRoot, type SessionPath } from "./core/sessions.js";
import { sessionIdentity } from "./core/naming.js";
import { NativeWire, type Wire } from "./core/wire.js";
import { observeEvents } from "./core/events.js";
import { Approval, type OpenCodeEnrollment } from "./approval.js";
import { Binding, NEW_RUN, SIGN_IN, type StaticMode } from "./binding.js";
import { Grayboard } from "./rpc.js";
import { RootInstructions, rewrite, type Fetcher, type Plan } from "./instructions.js";
import { attachmentTools } from "./transfer-tools.js";

// `static`: the service-credential mode (#270 D3), from the launcher's environment only (`staticMode`), never from
// plugin options, which any config layer, a repository's own included, can set.
export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean; launcher?: boolean; static?: StaticMode };
export const STATIC_AUTH = "GRAYBOARD_OPENCODE_AUTH", STATIC_ISSUER = "GRAYBOARD_OPENCODE_ISSUER";
// Static service-credential mode, read from the launcher's environment: `GRAYBOARD_OPENCODE_AUTH=static` turns it on
// and `GRAYBOARD_OPENCODE_ISSUER` pins the issuer, which it requires. Unset is OAuth mode; any other value, or a
// missing or malformed pin, is a refused static mode, never OAuth. Bun loads dotenv files from the working directory
// into the environment at startup, so a repository's `.env` could set them: a dotenv file there that names either
// variable refuses the mode.
export function staticMode(env: Record<string, string | undefined>, cwd: string): StaticMode | undefined {
  const auth = env[STATIC_AUTH];
  if (auth === undefined || auth === "") return;
  if (auth !== "static") return { refused: `${STATIC_AUTH} must be "static" or unset` };
  let files: string[] = [];
  try { files = readdirSync(cwd).filter(name => /^\.env(\..+)?$/.test(name)); } catch {}
  const named = new RegExp(`^\\s*(export\\s+)?(${STATIC_AUTH}|${STATIC_ISSUER})\\s*=`, "m");
  for (const file of files) {
    let text: string;
    try { text = readFileSync(join(cwd, file), "utf8"); } catch { return { refused: `Static mode refused: ${file} in the working directory is unreadable` }; }
    if (named.test(text)) return { refused: `Static mode refused: ${file} in the working directory sets its variables; the launcher sets them` };
  }
  const issuer = env[STATIC_ISSUER];
  if (!issuer) return { refused: `Static mode needs a pinned issuer (${STATIC_ISSUER})` };
  let url: URL;
  try { url = new URL(issuer); } catch { return { refused: `${STATIC_ISSUER} must be an HTTPS URL` }; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return { refused: `${STATIC_ISSUER} must be an HTTPS URL without credentials, query or fragment` };
  return { issuer };
}
type Invocation = { tool: string; sessionID: string; id: string };
const VERSION = "1.10.0";
// Sessions whose model is remembered: the most recently active ones.
const FACTS_LIMIT = 256;
// After a reconnect, how long a native call waits for OpenCode to list its tool again, and how often it looks.
const RELIST_WAIT_MS = 2_000, RELIST_STEP_MS = 25;
// OpenCode's own root session IDs: restored diagnostics for them skip the root lookup.
export const OPENCODE_SESSION = /^ses_[a-f0-9]{64}$/;

// The name local mode would give a session in the plugin's directory, read once
// per directory: no BUS_IDENTITY (the plugin's `name` option is the explicit one).
// Undefined where none derives (the root directory).
export function suggestion(directory: () => string): () => string | undefined {
  let at: string | undefined, name: string | undefined;
  return () => {
    const dir = directory();
    if (dir !== at) { at = dir; try { name = sessionIdentity({}, dir); } catch { name = undefined; } }
    return name;
  };
}

// The OpenCode host behind the HostPort: its location, plugin storage,
// session tree, native MCP grant, metadata approval and synthetic admission.
function hostPort(ctx: Context, options: Options, binding: Binding, facts: Map<string, SessionFacts>): HostPort<OpenCodeEnrollment> {
  return {
    harness: "OpenCode", resumeHint: "explicitly enroll again", loginAction: options.static ? NEW_RUN : SIGN_IN,
    sessionKey: "ai.opencode/sessionID", client: { name: "grayboard-opencode", version: VERSION },
    // Plugin option `launcher: true`, OpenCode's BUS_LAUNCHER=1 (#520): the Controller's wires declare it.
    ...(options.launcher ? { launcher: true as const } : {}),
    storage: ctx.storage,
    facts: sessionID => facts.get(sessionID),
    // Local mode's name for this directory (repo or pin, worktree suffix), offered first to an unbound root (#696).
    suggested: suggestion(() => ctx.location.directory),
    place: () => ctx.location.directory,
    ancestry: sessionID => resolveRoot(sessionID, id => ctx.session.get({ sessionID: id })),
    credential: binding,
    approval: new Approval(ctx, options.mcpName),
    admit: async (e, item, id, identity) => { await ctx.session.synthetic({ sessionID: e.sessionID, id, text: render(item, identity), delivery: "queue", resume: item.actionable, metadata: { source: "grayboard" } }); },
  };
}

// The core Controller wired to OpenCode: native tool detection, tool hooks and
// host event names stay here; everything else is hosted-core's.
export class OpenCodeController extends Controller<OpenCodeEnrollment> {
  readonly binding: Binding;
  constructor(readonly ctx: Context, readonly options: Options, Transport?: typeof Wire, wait?: Wait, sink?: DiagnosticSink) {
    const latch = { drift: (_message: string) => {} };
    const binding = new Binding(ctx, options.mcpName, () => latch.drift("Native binding changed; explicitly enroll again"), options.issuer, options.static);
    const facts = new Map<string, SessionFacts>();
    super(hostPort(ctx, options, binding, facts), { Transport, wait, sink, knownRoot: OPENCODE_SESSION, ...(options.name ? { configured: { name: options.name, create: options.create === true } } : {}) });
    latch.drift = message => this.drift(message);
    this.binding = binding;
    this.facts = facts;
  }
  // Each session's model as its latest request used it (#364): `providerID/id`,
  // the variant as effort. The Controller's wires send them for that session.
  private readonly facts: Map<string, SessionFacts>;
  noteModel(sessionID: string, model: { id: string; providerID: string; variant?: string | undefined } | undefined) {
    if (!model?.id || !model.providerID) return;
    this.facts.delete(sessionID);
    // No variant is the model's default: none, which clears the server's effort (#558).
    this.facts.set(sessionID, { model: `${model.providerID}/${model.id}`, effort: model.variant || null });
    if (this.facts.size > FACTS_LIMIT) this.facts.delete(this.facts.keys().next().value!);
  }
  private namespace() { return this.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_"); }
  // The bare native tool name, or undefined for any other tool.
  private async native(tool: string) {
    const namespace = this.namespace();
    if (!(await this.ctx.tool.list()).some(t => t.id === tool && t.options?.namespace === namespace)) return;
    return tool.startsWith(namespace + "_") ? tool.slice(namespace.length + 1) : tool;
  }
  private async relisted(tool: string) {
    const deadline = Date.now() + RELIST_WAIT_MS;
    for (;;) {
      const found = await this.native(tool);
      if (found !== undefined || Date.now() >= deadline) return found;
      await new Promise(done => setTimeout(done, RELIST_STEP_MS));
    }
  }
  async before(event: Invocation) {
    // In flight until its after hook, for the reconnect `refresh` asks (#661), and held from before the tool list
    // is read: mid-reconnect the entry lists no tools, so the call waits that out first (#917). Another tool's
    // call, or a refused one, never runs as native.
    const wait = await this.binding.calling(event.id);
    try {
      let tool = await this.native(event.tool);
      // OpenCode rebuilds its tool list from the entry 100 ms (debounced) after the reload settles, so a call
      // released by it can find its own tool not listed yet: one in this entry's namespace waits for it, bounded.
      if (tool === undefined && wait !== "none" && event.tool.startsWith(this.namespace() + "_")) tool = await this.relisted(event.tool);
      if (wait === "timeout" || (tool === undefined && wait === "waited" && event.tool.startsWith(this.namespace() + "_"))) {
        this.record({ state: "degraded", message: `A native ${event.tool} call outwaited a reconnect that didn't finish; it ran unclassified`, operation: "refresh", sessionID: event.sessionID, code: "operation_failed" });
      }
      if (tool === undefined) { this.binding.called(event.id); return; }
      await this.beforeCall({ sessionID: event.sessionID, tool });
    } catch (error) { this.binding.called(event.id); throw error; }
  }
  async after(event: Invocation & ({ status: "completed"; result: { output?: unknown } } | { status: "error" })) {
    // In flight until afterCall settles, so no reconnect lands between (#661).
    try {
      const tool = await this.native(event.tool);
      if (tool === undefined) return;
      try { await this.afterCall({ sessionID: event.sessionID, tool, result: event.status === "completed" ? { status: "completed", output: event.result.output } : { status: "error" } }); }
      finally { if (tool === "bind" || tool === "unbind") this.bindingChanged?.(event.sessionID); }
    } finally { this.binding.called(event.id); }
  }
  // A native bind or unbind ran for this session: its server instructions may have changed (#531).
  bindingChanged?: (sessionID: string) => void;
  // A session was deleted or archived: its cached instructions go (#535).
  sessionEnded?: (sessionID: string) => void;
  // A subagent of an enrolled root was created: its instructions fetch starts
  // now, so its first request needn't wait out registration and connect (#535).
  childCreated?: (path: SessionPath) => void;
  // An enrolled root's enrollment while it isn't paused; children, unenrolled and
  // paused roots (a drift pauses every root) have none, so no fetch runs on a
  // stale enrollment or starts an ownership a pause ended.
  enrollment(sessionID: string): OpenCodeEnrollment | undefined {
    const r = this.roots.get(sessionID);
    return r && !r.paused ? r.e : undefined;
  }
  // A fetch failure goes on the root's own record, its state and message kept,
  // so a later success or restart doesn't leave a background `degraded` behind.
  instructionsFailure(sessionID: string, error: unknown) {
    const r = this.roots.get(sessionID);
    if (!r) return;
    this.record({ state: r.status.state, message: r.status.message, operation: "instructions", sessionID, ...(r.e.held?.length ? { held: r.e.held } : {}), ...(r.lease ? { ownership: r.lease.ownership } : {}), code: failureCode(error) });
  }
  // An instructions fetch's wire that failed to close, recorded as the
  // Controller's temporary wires are but with no session ID: on a root's record
  // it would read as the root's change (watchRoots) and fetch again (#538).
  fetchCloseFailure(error: unknown) { this.failure("wire_close", error); }
  async observe(type: string, data: unknown) {
    if (this.stopped) return;
    if (type === "session.created") {
      const id = (data as { sessionID?: string })?.sessionID;
      // Routed now, so a subagent's first request finds its root without a lookup (#535).
      if (id) {
        const path = await this.childRoot(id);
        if (path && this.enrollment(path.root)) this.childCreated?.(path);
        await this.configuredBind(id);
        await this.serviceEnroll(id);
      }
    }
    if (type === "credential.switched") {
      const id = (data as { integrationID?: string })?.integrationID;
      if ([...this.roots.values()].some(r => r.e.integrationID === id)) this.drift("Selected native account changed; explicitly enroll again");
    }
    if (type === "session.deleted" || type === "session.archived") {
      const id = (data as { sessionID?: string })?.sessionID;
      if (id) { this.sessionEnded?.(id); await this.ended(id); }
    }
  }
  // Static mode (#270 D3): a new root enrolls with no `/grayboard-enroll` once the pinned issuer vouches for the
  // entry (Binding.capture) and the server's whoami says the run token's principal is a service. Not an agent
  // approving itself (principle 10): the launcher set the mode, the pin and the token, and the kind is the
  // server's, which a user's token can't claim. Grayboard starts nothing here (principle 7): the launcher started
  // this OpenCode and its session; enrollment only lets the server deliver to it.
  async serviceEnroll(sessionID: string) {
    if (this.stopped || !this.options.static) return;
    try {
      if ((await this.port.ancestry(sessionID)).root !== sessionID) return;
      const kind = await principalKind(this, await this.binding.capture(sessionID));
      if (kind !== "service") {
        this.record({ state: "unenrolled", sessionID, message: "Static mode enrolls a root by itself only for a service run token; the server did not report one, so enroll explicitly", operation: "enroll", code: "refused" });
        return;
      }
      await this.enroll(sessionID);
    } catch (error) {
      this.record({ state: "unenrolled", sessionID, message: error instanceof Refusal && !(error instanceof AccessExpired) ? error.message : failureMessage(error, this.port.resumeHint), operation: "enroll", code: failureCode(error) });
    }
  }
  async enrollmentFailure(sessionID: string) {
    try {
      await this.activeRoot(sessionID);
      this.record({ state: "degraded", message: "Enrollment failed; approval is unchanged", operation: "enroll", sessionID, code: "operation_failed" });
    } catch { this.backgroundFailure("enroll"); }
  }
}

// A session's current server instructions over a native connection that names
// it, as the root's own wires would (same URL and client; no delivery
// declaration, so no lease): one connect and close per fetch. A root's wire
// declares a launcher as its own do. A subagent's runs under its root's
// enrollment, registered first (an unregistered key would start an ownership of
// its own), and never declares one: a child is never a launcher (#535).
export function nativeFetcher(controller: OpenCodeController): Fetcher {
  return async (sessionID, signal) => {
    let e = controller.enrollment(sessionID), launcher = !!e && !!controller.port.launcher;
    if (!e) {
      const path = await controller.childRoot(sessionID);
      e = path && controller.enrollment(path.root);
      if (!path || !e) return;
      await controller.enlist(path, true);
    }
    // A session (or its root) that ended since the lookup or the registration: an `initialize` landing after its
    // end would start an ownership for its key that only the idle sweep ends (#567). `forget` aborts `signal`.
    const root = controller.routes.get(sessionID)?.root ?? sessionID;
    // A root paused meanwhile: its release ended the rows an `initialize` would start again (#567).
    if (signal.aborted || controller.routes.isEnded(sessionID) || controller.routes.isEnded(root) || !controller.enrollment(root)) return;
    const port = controller.port, enrollment = e;
    let current: string | undefined;
    const wire = new NativeWire({ url: e.configuration.url, sessionKey: port.sessionKey, client: port.client, ...(launcher ? { launcher: true as const } : {}), ...(port.facts ? { facts: (id: string) => port.facts!(id) } : {}), ...(port.suggested ? { suggested: (id: string) => port.suggested!(id) } : {}) }, {
      token: async () => (current = await controller.binding.token(enrollment)),
      onUnauthorized: async () => controller.binding.unauthorized(enrollment, current ?? ""),
    }, signal, sessionID);
    try { await wire.connect(); return wire.instructions(); }
    finally { void wire.close().catch(error => controller.fetchCloseFailure(error)); }
  };
}

// The run token's principal kind (`whoami`'s `principal_kind`), asked with no session key so the question starts no
// hosted session: a token that turns out to be a user's leaves nothing behind on the server.
export async function principalKind(controller: OpenCodeController, e: OpenCodeEnrollment): Promise<string | undefined> {
  let current: string | undefined;
  const port = controller.port;
  const wire = new NativeWire({ url: e.configuration.url, sessionKey: port.sessionKey, client: port.client }, {
    token: async () => (current = await controller.binding.token(e)),
    onUnauthorized: async () => controller.binding.unauthorized(e, current ?? ""),
  }, AbortSignal.timeout(10_000));
  await wire.connect();
  try {
    const result = await wire.client.callTool({ name: "whoami", arguments: {} }, wire.options());
    const content = result.content as { type?: string; text?: string }[] | undefined;
    const value = result.structuredContent ?? (content?.length === 1 && content[0]?.type === "text" ? JSON.parse(content[0].text ?? "null") : undefined);
    const kind = result.isError ? undefined : (value as { principal_kind?: unknown } | undefined)?.principal_kind;
    return typeof kind === "string" ? kind : undefined;
  } finally { await wire.close().catch(() => {}); }
}

// A root's record whose state, holds or ownership changed: what its server
// instructions describe may have changed with it (#531).
// `forget` drops an ended session's last shape (#538), but an ended root's own
// end record (and a later drift's pause) lands after it, so the map is also
// bounded, least recently recorded first: an evicted root's next record only refetches.
export function watchRoots(sink: DiagnosticSink, changed: (sessionID: string) => void, limit = FACTS_LIMIT): DiagnosticSink & { forget(sessionID: string): void } {
  const seen = new Map<string, string>();
  return Object.assign((record: Parameters<DiagnosticSink>[0]) => {
    if (record.sessionID && record.operation !== "instructions") {
      const shape = JSON.stringify([record.state, record.held ?? [], record.ownership ?? null]);
      const news = seen.get(record.sessionID) !== shape;
      // Least recently recorded first: a live root's every record keeps it.
      seen.delete(record.sessionID); seen.set(record.sessionID, shape);
      if (seen.size > limit) seen.delete(seen.keys().next().value!);
      if (news) changed(record.sessionID);
    }
    return sink(record);
  }, { forget: (sessionID: string) => { seen.delete(sessionID); } });
}

export type Debug = (message: string, fields: Record<string, unknown>) => void;
// The plugin's options: OpenCode's plugin options (any config layer, a repository's included) for everything but
// static mode, which only the launcher's environment sets (`staticMode`); no plugin option is read for it.
export function pluginOptions(input: Context["options"], env: Record<string, string | undefined>, cwd: string): Options {
  const static_ = staticMode(env, cwd);
  return {
    ...(static_ ? { static: static_ } : {}),
    mcpName: typeof input.mcpName === "string" ? input.mcpName : "grayboard",
    issuer: typeof input.issuer === "string" ? input.issuer : "",
    name: typeof input.name === "string" ? input.name : undefined,
    create: input.create === true,
    launcher: input.launcher === true,
  };
}
export async function setup(ctx: Context, sink: DiagnosticSink, debug: Debug = () => {}, fetcher?: Fetcher, env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  const options = pluginOptions(ctx.options, env, cwd);
  let instructions: RootInstructions | undefined;
  const watched = watchRoots(sink, id => instructions?.invalidate(id));
  const controller = new OpenCodeController(ctx, options, undefined, undefined, watched);
  // A subagent's failure lands on its root's record.
  instructions = new RootInstructions(fetcher ?? nativeFetcher(controller), (sessionID, error, root) => controller.instructionsFailure(root ?? sessionID, error));
  controller.bindingChanged = id => instructions?.invalidate(id);
  controller.sessionEnded = id => { instructions?.forget(id); watched.forget(id); };
  controller.childCreated = path => { void instructions?.current(path.sessionID, path.root); };
  // Every primary request of an enrolled root, or of a subagent under one, carries
  // its current instructions; other sessions' go as built.
  // A rejected hook fails OpenCode's step, so it never rejects.
  const context = await ctx.session.hook("context", async request => {
    try {
      controller.noteModel(request.sessionID, request.model);
      const enrolled = !!controller.enrollment(request.sessionID);
      const root = enrolled ? undefined : (await controller.childRoot(request.sessionID))?.root;
      if (!enrolled && !root) { instructions?.forget(request.sessionID); return; }
      const plan: Plan = await rewrite(request, options.mcpName, id => instructions!.current(id, root));
      debug("Grayboard instructions", { [root ? "child" : "root"]: request.sessionID, ...(root ? { root } : {}), plan, text: instructions!.state(request.sessionID) });
    } catch {}
  });
  let restoring: Promise<unknown> = Promise.resolve();
  const rpc = await ctx.rpc.register(Grayboard, {
    status: async () => controller.status(),
    enroll: async input => {
      try { await restoring; return await controller.enroll(input.sessionID, input.name ? [input.name] : [], input.create); }
      catch { await controller.enrollmentFailure(input.sessionID); return { state: "paused", message: "Enrollment refused; check the active root, trusted issuer and native MCP configuration/sign-in", roots: controller.status().roots }; }
    },
    pause: async () => { await restoring; return controller.pause(); },
  });
  const before = await ctx.tool.hook("execute.before", event => controller.before(event));
  const after = await ctx.tool.hook("execute.after", event => controller.after(event).catch(() => controller.backgroundFailure("after")));
  const transfers = await attachmentTools(ctx, controller);
  const events = new AbortController();
  const listening = observeEvents(
    () => ctx.event.subscribe({ signal: events.signal }),
    event => controller.observe(event.type, event.data),
    operation => controller.backgroundFailure(operation),
    events.signal,
  );
  restoring = (async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let attempt = 0; attempt < 50 && !events.signal.aborted; attempt++) {
      try { await controller.binding.configuration(); break; }
      catch (error) {
        if (!(error instanceof Refusal) || error.code !== "binding" || attempt === 49) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await controller.restore().catch(() => { if (!events.signal.aborted) controller.backgroundFailure("restore"); });
  })();
  return async () => {
    instructions.close();
    await context.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    events.abort();
    await controller.close();
    await controller.binding.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await restoring;
    await listening;
    await before.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await after.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await transfers.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await rpc.dispose().catch(() => controller.backgroundFailure("rpc_dispose"));
    await controller.flushDiagnostics();
  };
}
