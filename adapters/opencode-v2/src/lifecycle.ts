import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller, type Wait } from "./core/controller.js";
import { failureCode, type DiagnosticSink } from "./core/diagnostics.js";
import type { HostPort, SessionFacts } from "./core/port.js";
import { Refusal, render } from "./core/model.js";
import { resolveRoot, type SessionPath } from "./core/sessions.js";
import { NativeWire, type Wire } from "./core/wire.js";
import { observeEvents } from "./core/events.js";
import { Approval, type OpenCodeEnrollment } from "./approval.js";
import { Binding, SIGN_IN } from "./binding.js";
import { Grayboard } from "./rpc.js";
import { RootInstructions, rewrite, type Fetcher, type Plan } from "./instructions.js";
import { attachmentTools } from "./transfer-tools.js";

export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean; launcher?: boolean };
type Invocation = { tool: string; sessionID: string; id: string };
const VERSION = "1.10.0";
// Sessions whose model is remembered: the most recently active ones.
const FACTS_LIMIT = 256;
// OpenCode's own root session IDs: restored diagnostics for them skip the root lookup.
export const OPENCODE_SESSION = /^ses_[a-f0-9]{64}$/;

// The OpenCode host behind the HostPort: its location, plugin storage,
// session tree, native MCP grant, metadata approval and synthetic admission.
function hostPort(ctx: Context, options: Options, binding: Binding, facts: Map<string, SessionFacts>): HostPort<OpenCodeEnrollment> {
  return {
    harness: "OpenCode", resumeHint: "explicitly enroll again", loginAction: SIGN_IN,
    sessionKey: "ai.opencode/sessionID", client: { name: "grayboard-opencode", version: VERSION },
    // Plugin option `launcher: true`, OpenCode's BUS_LAUNCHER=1 (#520): the Controller's wires declare it.
    ...(options.launcher ? { launcher: true as const } : {}),
    storage: ctx.storage,
    facts: sessionID => facts.get(sessionID),
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
    const binding = new Binding(ctx, options.mcpName, () => latch.drift("Native binding changed; explicitly enroll again"), options.issuer);
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
  async before(event: Invocation) {
    const tool = await this.native(event.tool);
    if (tool !== undefined) await this.beforeCall({ sessionID: event.sessionID, tool });
  }
  async after(event: Invocation & ({ status: "completed"; result: { output?: unknown } } | { status: "error" })) {
    const tool = await this.native(event.tool);
    if (tool === undefined) return;
    try { await this.afterCall({ sessionID: event.sessionID, tool, result: event.status === "completed" ? { status: "completed", output: event.result.output } : { status: "error" } }); }
    finally { if (tool === "bind" || tool === "unbind") this.bindingChanged?.(event.sessionID); }
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
  async observe(type: string, data: unknown) {
    if (this.stopped) return;
    if (type === "session.created") {
      const id = (data as { sessionID?: string })?.sessionID;
      // Routed now, so a subagent's first request finds its root without a lookup (#535).
      if (id) {
        const path = await this.childRoot(id);
        if (path && this.enrollment(path.root)) this.childCreated?.(path);
        await this.configuredBind(id);
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
      await controller.enlist(path, false);
    }
    const port = controller.port, enrollment = e;
    let current: string | undefined;
    const wire = new NativeWire({ url: e.configuration.url, sessionKey: port.sessionKey, client: port.client, ...(launcher ? { launcher: true as const } : {}), ...(port.facts ? { facts: (id: string) => port.facts!(id) } : {}) }, {
      token: async () => (current = await controller.binding.token(enrollment)),
      onUnauthorized: async () => controller.binding.unauthorized(enrollment, current ?? ""),
    }, signal, sessionID);
    try { await wire.connect(); return wire.instructions(); }
    finally { void wire.close().catch(() => {}); }
  };
}

// A root's record whose state, holds or ownership changed: what its server
// instructions describe may have changed with it (#531).
export function watchRoots(sink: DiagnosticSink, changed: (sessionID: string) => void): DiagnosticSink {
  const seen = new Map<string, string>();
  return record => {
    if (record.sessionID && record.operation !== "instructions") {
      const shape = JSON.stringify([record.state, record.held ?? [], record.ownership ?? null]);
      if (seen.get(record.sessionID) !== shape) { seen.set(record.sessionID, shape); changed(record.sessionID); }
    }
    return sink(record);
  };
}

export type Debug = (message: string, fields: Record<string, unknown>) => void;
export async function setup(ctx: Context, sink: DiagnosticSink, debug: Debug = () => {}, fetcher?: Fetcher) {
  const options: Options = {
    mcpName: typeof ctx.options.mcpName === "string" ? ctx.options.mcpName : "grayboard",
    issuer: typeof ctx.options.issuer === "string" ? ctx.options.issuer : "",
    name: typeof ctx.options.name === "string" ? ctx.options.name : undefined,
    create: ctx.options.create === true,
    launcher: ctx.options.launcher === true,
  };
  let instructions: RootInstructions | undefined;
  const controller = new OpenCodeController(ctx, options, undefined, undefined, watchRoots(sink, id => instructions?.invalidate(id)));
  // A subagent's failure lands on its root's record.
  instructions = new RootInstructions(fetcher ?? nativeFetcher(controller), (sessionID, error, root) => controller.instructionsFailure(root ?? sessionID, error));
  controller.bindingChanged = id => instructions?.invalidate(id);
  controller.sessionEnded = id => instructions?.forget(id);
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
    await restoring;
    await listening;
    await before.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await after.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await transfers.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await rpc.dispose().catch(() => controller.backgroundFailure("rpc_dispose"));
    await controller.flushDiagnostics();
  };
}
