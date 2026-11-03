import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller, type Wait } from "./core/controller.js";
import type { DiagnosticSink } from "./core/diagnostics.js";
import type { HostPort } from "./core/port.js";
import { Refusal, render } from "./core/model.js";
import { resolveRoot } from "./core/sessions.js";
import type { Wire } from "./core/wire.js";
import { observeEvents } from "./core/events.js";
import { Approval, type OpenCodeEnrollment } from "./approval.js";
import { Binding, SIGN_IN } from "./binding.js";
import { Grayboard } from "./rpc.js";

export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean };
type Invocation = { tool: string; sessionID: string; id: string };
const VERSION = "1.10.0";
// OpenCode's own root session IDs: restored diagnostics for them skip the root lookup.
export const OPENCODE_SESSION = /^ses_[a-f0-9]{64}$/;

// The OpenCode host behind the HostPort: its location, plugin storage,
// session tree, native MCP grant, metadata approval and synthetic admission.
function hostPort(ctx: Context, options: Options, binding: Binding): HostPort<OpenCodeEnrollment> {
  return {
    harness: "OpenCode", resumeHint: "explicitly enroll again", loginAction: SIGN_IN,
    sessionKey: "ai.opencode/sessionID", client: { name: "grayboard-opencode", version: VERSION },
    storage: ctx.storage,
    place: () => ctx.location.directory,
    ancestry: sessionID => resolveRoot(sessionID, id => ctx.session.get({ sessionID: id })),
    credential: binding,
    approval: new Approval(ctx, options.mcpName),
    admit: async (e, item, id) => { await ctx.session.synthetic({ sessionID: e.sessionID, id, text: render(item), delivery: "queue", resume: item.actionable, metadata: { source: "grayboard" } }); },
  };
}

// The core Controller wired to OpenCode: native tool detection, tool hooks and
// host event names stay here; everything else is hosted-core's.
export class OpenCodeController extends Controller<OpenCodeEnrollment> {
  readonly binding: Binding;
  constructor(readonly ctx: Context, readonly options: Options, Transport?: typeof Wire, wait?: Wait, sink?: DiagnosticSink) {
    const latch = { drift: (_message: string) => {} };
    const binding = new Binding(ctx, options.mcpName, () => latch.drift("Native binding changed; explicitly enroll again"), options.issuer);
    super(hostPort(ctx, options, binding), { Transport, wait, sink, knownRoot: OPENCODE_SESSION, ...(options.name ? { configured: { name: options.name, create: options.create === true } } : {}) });
    latch.drift = message => this.drift(message);
    this.binding = binding;
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
    if (tool !== undefined) await this.afterCall({ sessionID: event.sessionID, tool, result: event.status === "completed" ? { status: "completed", output: event.result.output } : { status: "error" } });
  }
  async observe(type: string, data: unknown) {
    if (this.stopped) return;
    if (type === "session.created") {
      const id = (data as { sessionID?: string })?.sessionID;
      if (id) await this.configuredBind(id);
    }
    if (type === "credential.switched") {
      const id = (data as { integrationID?: string })?.integrationID;
      if ([...this.roots.values()].some(r => r.e.integrationID === id)) this.drift("Selected native account changed; explicitly enroll again");
    }
    if (type === "session.deleted" || type === "session.archived") {
      const id = (data as { sessionID?: string })?.sessionID;
      if (id) await this.ended(id);
    }
  }
  async enrollmentFailure(sessionID: string) {
    try {
      await this.activeRoot(sessionID);
      this.record({ state: "degraded", message: "Enrollment failed; approval is unchanged", operation: "enroll", sessionID, code: "operation_failed" });
    } catch { this.backgroundFailure("enroll"); }
  }
}

export async function setup(ctx: Context, sink: DiagnosticSink) {
  const options: Options = {
    mcpName: typeof ctx.options.mcpName === "string" ? ctx.options.mcpName : "grayboard",
    issuer: typeof ctx.options.issuer === "string" ? ctx.options.issuer : "",
    name: typeof ctx.options.name === "string" ? ctx.options.name : undefined,
    create: ctx.options.create === true,
  };
  const controller = new OpenCodeController(ctx, options, undefined, undefined, sink);
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
    events.abort();
    await controller.close();
    await restoring;
    await listening;
    await before.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await after.dispose().catch(() => controller.backgroundFailure("hook_dispose"));
    await rpc.dispose().catch(() => controller.backgroundFailure("rpc_dispose"));
    await controller.flushDiagnostics();
  };
}
