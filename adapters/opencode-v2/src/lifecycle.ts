import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { SdkHttpError } from "@modelcontextprotocol/client";
import { Controller, type Wait } from "./core/controller.js";
import { failureCode, failureMessage, type DiagnosticSink } from "./core/diagnostics.js";
import type { HostPort, SessionFacts } from "./core/port.js";
import { AccessExpired, Refusal, render } from "./core/model.js";
import { resolveRoot, type SessionPath } from "./core/sessions.js";
import { sessionIdentity } from "./core/naming.js";
import { NativeWire, subscriberError, unreachable, type Wire } from "./core/wire.js";
import { observeEvents } from "./core/events.js";
import { Approval, type OpenCodeEnrollment } from "./approval.js";
import { Binding, NEW_RUN, SIGN_IN, timedOut, type StaticMode } from "./binding.js";
import { Grayboard } from "./rpc.js";
import { RootInstructions, rewrite, type Fetcher, type Plan } from "./instructions.js";
import { attachmentTools } from "./transfer-tools.js";

// `static`: the service-credential mode (#270 D3), from the launcher's environment only (`staticMode`), never from
// plugin options, which any config layer, a repository's own included, can set.
export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean; launcher?: boolean; static?: StaticMode };
export const STATIC_AUTH = "GRAYBOARD_OPENCODE_AUTH", STATIC_ISSUER = "GRAYBOARD_OPENCODE_ISSUER", STATIC_PRINCIPAL = "GRAYBOARD_OPENCODE_PRINCIPAL";
// Static service-credential mode, read from the launcher's environment: `GRAYBOARD_OPENCODE_AUTH=static` turns it on
// and `GRAYBOARD_OPENCODE_ISSUER` pins the issuer, which it requires. Unset is OAuth mode; any other value, or a
// missing or malformed pin, is a refused static mode, never OAuth. Bun loads dotenv files from the working directory
// into the environment at startup, so a repository's `.env` could set them: a dotenv file there that names either
// variable refuses the mode. `GRAYBOARD_OPENCODE_PRINCIPAL`, optional, names the service whose run token may
// auto-enroll a root (whoami's `principal`, #270 audit F3); unset, any service's may.
export function staticMode(env: Record<string, string | undefined>, cwd: string): StaticMode | undefined {
  const auth = env[STATIC_AUTH];
  if (auth === undefined || auth === "") return;
  if (auth !== "static") return { refused: `${STATIC_AUTH} must be "static" or unset` };
  let files: string[] = [];
  try { files = readdirSync(cwd).filter(name => /^\.env(\..+)?$/.test(name)); } catch {}
  const named = new RegExp(`^\\s*(export\\s+)?(${STATIC_AUTH}|${STATIC_ISSUER}|${STATIC_PRINCIPAL})\\s*=`, "m");
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
  const principal = env[STATIC_PRINCIPAL];
  if (principal === undefined || principal === "") return { issuer };
  if (!/^[^\s/]{1,128}$/.test(principal)) return { refused: `${STATIC_PRINCIPAL} must be a service name` };
  return { issuer, principal };
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
// Static mode's auto-enroll retry (#1250): 250 ms doubling to 8 s, 8 retries (about 30 s of waits in all).
const ENROLL_RETRY_FIRST_MS = 250, ENROLL_RETRY_MAX_MS = 8_000, ENROLL_RETRIES = 8;
const TRANSIENT_CODES = new Set(["server_unreachable", "rate_limited", "internal_error"]);
// An outage, not an answer: worth another attempt. whoami's own 10 s timeout aborts its wire, which the wire then
// leaves unclassified, so a TimeoutError anywhere in the cause chain counts too; so does an HTTP 429 that outlasted
// the wire's own admission retries. `rate_limited` and `internal_error` arrive as whoami's isError codes (whoami).
function transientEnroll(error: unknown): boolean {
  if (TRANSIENT_CODES.has(failureCode(error)) || unreachable(error) || timedOut(error)) return true;
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof SdkHttpError && e.status === 429) return true;
  return false;
}
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
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
  // A static run has no person to enroll by hand (#1250): an attempt that fails on an outage (unreachable, a
  // 5xx, a timeout, a rate limit or the server's internal error) is retried on a capped backoff, ENROLL_RETRIES times;
  // any other answer stands. A retry stops when the controller closes, the session ends or the root is enrolled.
  // Close aborts an attempt's pin check and whoami (`enrollStop`, #1285) as well as a retry's wait.
  async serviceEnroll(sessionID: string) {
    if (this.stopped || !this.options.static) return;
    let error = await this.autoEnroll(sessionID);
    // Close can land during the first attempt, which close doesn't wait for: nothing records after it. Nothing has
    // recorded `retrying` yet either, so there's no record to finish.
    if (this.stopped) return;
    if (error === undefined || !transientEnroll(error)) return this.enrollRefused(sessionID, error);
    // Close during a retry ends the root's `retrying` record. Nothing restores a retry: a restart restores the record
    // as saved (`Saved retrying status`) for a root no `session.created` will ask about again, so a saved `retrying`
    // would claim a retry nothing runs. `unenrolled` is what the root is, and the outage is why. Close waits for this
    // loop (`enrollRetries`), so the record lands before its flush. A root enrolled meanwhile by another path (an
    // explicit enroll; paused counts, so `roots`, not `enrollment`) keeps its own record: it is enrolled.
    const closed = () => this.roots.has(sessionID) ? undefined : this.record({ state: "unenrolled", sessionID, message: "Shut down while auto-enroll was retrying; the root is not enrolled", operation: "enroll", code: "server_unreachable" });
    const retry = (async () => {
      for (let attempt = 0; attempt < ENROLL_RETRIES && error !== undefined && transientEnroll(error); attempt++) {
        this.record({ state: "retrying", sessionID, message: `Server unreachable; retrying auto-enroll (${attempt + 1}/${ENROLL_RETRIES})`, operation: "enroll", code: "server_unreachable" });
        await abortableSleep(Math.min(ENROLL_RETRY_MAX_MS, this.enrollRetryFirstMs * 2 ** attempt), this.enrollStop.signal);
        if (this.stopped) return closed();
        if (this.enrollment(sessionID)) return;
        // A root that never enrolled has no record `ended` replaces, so its `retrying` would outlive it.
        if (this.routes.isEnded(sessionID)) return this.record({ state: "unenrolled", sessionID, message: "Root ended before auto-enroll reached the server", operation: "enroll", code: "server_unreachable" });
        error = await this.autoEnroll(sessionID);
        // An attempt that enrolled, or recorded its own refusal, before close keeps its record. One that close cut
        // short is the shutdown even if its answer would have been a refusal (close wins): it stays unenrolled.
        if (this.stopped) return error === undefined ? undefined : closed();
      }
      if (error !== undefined && transientEnroll(error)) return this.enrollExhausted(sessionID, error);
      this.enrollRefused(sessionID, error);
    })().catch(() => this.backgroundFailure("enroll")).finally(() => this.enrollRetries.delete(retry));
    this.enrollRetries.add(retry);
  }
  // Static mode's retries: close ends their waits and in-flight attempts and waits them out, so none records or
  // enrolls after it.
  private readonly enrollStop = new AbortController();
  // The first retry's wait; a test shortens it to run the retries out.
  private enrollRetryFirstMs = ENROLL_RETRY_FIRST_MS;
  private readonly enrollRetries = new Set<Promise<void>>();
  override async close() {
    this.stopped = true; this.enrollStop.abort();
    while (this.enrollRetries.size) await Promise.all(this.enrollRetries);
    await super.close();
  }
  private enrollRefused(sessionID: string, error: unknown) {
    if (error === undefined) return;
    this.record({ state: "unenrolled", sessionID, message: error instanceof Refusal && !(error instanceof AccessExpired) ? error.message : failureMessage(error, this.port.resumeHint), operation: "enroll", code: failureCode(error) });
  }
  // The retries ran out on an outage (#1285 I-B). A static run has no person to enroll by hand, so the record names
  // what its operator can do, not "explicitly enroll again"; the code is the outage's, a raw HTTP 5xx from whoami's
  // call (which bypasses the wire's classification) as `server_unreachable`.
  private enrollExhausted(sessionID: string, error: unknown) {
    const code = failureCode(error), outage = TRANSIENT_CODES.has(code) ? code : "server_unreachable";
    this.record({ state: "unenrolled", sessionID, message: `Auto-enroll gave up after ${ENROLL_RETRIES} retries (${outage}); once the server answers, the launcher must start a new run`, operation: "enroll", code: outage });
  }
  // One auto-enroll attempt: undefined when it enrolled or recorded its own refusal, else the error that stopped it.
  private async autoEnroll(sessionID: string): Promise<unknown> {
    const mode = this.options.static;
    try {
      if ((await this.port.ancestry(sessionID)).root !== sessionID) return;
      const e = await this.binding.capture(sessionID, this.enrollStop.signal);
      const who = await whoami(this, e, this.enrollStop.signal);
      if (who.kind !== "service") {
        this.record({ state: "unenrolled", sessionID, message: "Static mode enrolls a root by itself only for a service run token; the server did not report one, so enroll explicitly", operation: "enroll", code: "refused" });
        return;
      }
      // The launcher named its service (#270 audit F3): another service's token, which a repository config could
      // put in the entry, never enrolls.
      const expected = mode && "principal" in mode ? mode.principal : undefined;
      if (expected !== undefined && who.principal !== expected) {
        this.record({ state: "unenrolled", sessionID, message: `Static mode enrolls a root by itself only for the run token of the service ${STATIC_PRINCIPAL} names; this token is another's`, operation: "enroll", code: "refused" });
        return;
      }
      // The enrollment's capture must read the entry whoami just checked (F4).
      this.binding.expectChecked(sessionID, e.configuration.configHash);
      try { await this.enroll(sessionID); } finally { this.binding.expectChecked(sessionID); }
    } catch (error) {
      return error ?? new Error("auto-enroll failed");
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

// The run token's principal and its kind (`whoami`'s `principal` and `principal_kind`), asked with no session key so
// the question starts no hosted session: a token that turns out to be a user's leaves nothing behind on the server.
// `stop`: auto-enroll's abort (#1285), on top of the 10 s timeout; the wire treats its own signal's abort as a stop,
// never an outage, and auto-enroll checks `stopped` before it reads the error.
export async function whoami(controller: OpenCodeController, e: OpenCodeEnrollment, stop?: AbortSignal): Promise<{ kind?: string; principal?: string }> {
  let current: string | undefined;
  const port = controller.port;
  const wire = new NativeWire({ url: e.configuration.url, sessionKey: port.sessionKey, client: port.client }, {
    token: async () => (current = await controller.binding.token(e)),
    onUnauthorized: async () => controller.binding.unauthorized(e, current ?? ""),
  }, stop ? AbortSignal.any([AbortSignal.timeout(10_000), stop]) : AbortSignal.timeout(10_000));
  await wire.connect();
  try {
    const result = await wire.client.callTool({ name: "whoami", arguments: {} }, wire.options());
    const content = result.content as { type?: string; text?: string }[] | undefined;
    // A tool error's code is in structuredContent (#806); its text is `error: <message>`, not JSON.
    const value = result.structuredContent ?? (!result.isError && content?.length === 1 && content[0]?.type === "text" ? JSON.parse(content[0].text ?? "null") : undefined);
    // The server's outage, not its answer (#1250): a rate limit or internal error throws, so auto-enroll retries it.
    // Any other error result stands as "not a service token".
    if (result.isError) { const refused = subscriberError(value, false); if (refused.code === "rate_limited" || refused.code === "internal_error") throw refused; }
    const fields = result.isError ? undefined : value as { principal_kind?: unknown; principal?: unknown } | undefined;
    const text = (v: unknown) => typeof v === "string" ? v : undefined;
    return { kind: text(fields?.principal_kind), principal: text(fields?.principal) };
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
