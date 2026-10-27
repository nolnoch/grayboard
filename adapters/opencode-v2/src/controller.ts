import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "./binding.js";
import { LeaseUnavailable, SubscriberError, Wire } from "./wire.js";
import { METADATA, Refusal, admitPrefix, bindingOf, enrollmentHash, itemsOf, leaseOf, render, same, stableID, type Enrollment, type Lease } from "./model.js";
import { SessionRoutes, resolveRoot } from "./sessions.js";
import { Diagnostics, DeliveryStopped, failureCode, failureMessage, type DiagnosticSink, type Status } from "./diagnostics.js";
export type { Status } from "./diagnostics.js";

export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean };
type Root = { e: Enrollment; approval: Enrollment; epoch: number; paused: boolean; status: Status; abort?: AbortController; task?: Promise<void>; lease?: Lease };
type Invocation = { tool: string; sessionID: string; id: string };
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export class Controller {
  readonly binding: Binding;
  readonly routes = new SessionRoutes();
  private roots = new Map<string, Root>();
  private watches = new Map<string, { dispose(): Promise<void> }>();
  private stopped = false;
  private drifted = false;
  private controls: Promise<unknown> = Promise.resolve();
  private state: Status = { state: "unenrolled", message: "Approve an active root; approval does not bind a name", roots: [] };
  private readonly diagnostics: Diagnostics;
  private readonly directory: string;
  constructor(readonly ctx: Context, readonly options: Options, readonly Transport: typeof Wire = Wire, private readonly wait = sleep, sink?: DiagnosticSink) {
    this.directory = ctx.location.directory;
    this.diagnostics = new Diagnostics(ctx.storage, sink);
    this.binding = new Binding(ctx, options.mcpName, () => this.latch("Native binding changed; explicitly enroll again"));
  }
  status(): Status { return this.diagnostics.status(); }
  async flushDiagnostics() { await this.diagnostics.flush(); }
  private set(r: Root, state: string, message: string, operation = "delivery", code?: string) {
    this.diagnostics.record({ state, message, operation, sessionID: r.e.sessionID, ...(r.e.name ? { name: r.e.name } : {}), ...(r.lease ? { ownership: r.lease.ownership } : {}), ...(code ? { code } : {}) });
    r.status = { state, message, sessionID: r.e.sessionID, roots: [] };
  }
  private failure(operation: string, error: unknown, r?: Root) {
    this.diagnostics.record({ state: "degraded", message: `${operation} failed (${failureCode(error)})`, operation, ...(r ? { sessionID: r.e.sessionID, ...(r.e.name ? { name: r.e.name } : {}), ...(r.lease ? { ownership: r.lease.ownership } : {}) } : {}), code: failureCode(error) });
  }
  private serial<T>(call: () => Promise<T>): Promise<T> {
    const result = this.controls.then(call, call);
    this.controls = result.catch(() => {});
    return result;
  }
  private latch(message: string) {
    this.drifted = true;
    for (const r of this.roots.values()) {
      r.paused = true; r.epoch++; r.abort?.abort(); this.set(r, "paused", message);
      void this.ctx.storage.set(`paused:${r.e.sessionID}`, true).catch(error => this.failure("latch_save", error, r));
    }
  }
  private async path(sessionID: string) {
    const path = await resolveRoot(sessionID, id => this.ctx.session.get({ sessionID: id }));
    this.routes.remember({ sessionID: path.root, root: path.root, via: [] });
    for (const [index, id] of path.via.entries()) this.routes.remember({ sessionID: id, root: path.root, via: path.via.slice(index + 1) });
    this.routes.remember(path);
    return path;
  }
  private async activeRoot(sessionID: string) {
    const path = await this.path(sessionID);
    if (path.root !== sessionID) throw new Refusal("root", "An active top-level root is required");
    return this.ctx.session.get({ sessionID });
  }
  private async save(r: Root, enabled: boolean) {
    const session = await this.activeRoot(r.e.sessionID);
    await this.ctx.session.update({ sessionID: session.id, metadata: { ...session.metadata, [METADATA]: { enabled, enrollment: r.approval } } });
    await this.ctx.storage.set(`enrollmentHash:${session.id}`, enrollmentHash(r.approval));
    await this.ctx.storage.set(`paused:${session.id}`, !enabled);
    await this.ctx.storage.set("rootSessionIDs", [...this.roots.keys()]);
  }
  private async guard(r: Root, epoch: number, signal: AbortSignal) {
    const e = r.e, hash = enrollmentHash(e);
    const check = () => { if (this.ctx.location.directory !== this.directory || this.stopped || this.drifted || r.paused || signal.aborted || r.epoch !== epoch || this.roots.get(e.sessionID) !== r || enrollmentHash(r.e) !== hash) throw new Refusal("paused", "Admission target changed"); };
    check();
    await this.binding.check(e);
    const session = await this.activeRoot(e.sessionID);
    const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
    if (!saved?.enabled || !same(saved.enrollment, r.approval)) { r.paused = true; throw new Refusal("root", "Root approval changed; explicitly enroll again"); }
    check();
  }
  private async wire(e: Enrollment, sessionID = e.sessionID, signal = AbortSignal.timeout(10_000), beforeRetry?: () => Promise<void>) {
    const key = `rejectedAccess:${e.integrationID}:${e.connectionID}`;
    let accessHash: string | undefined;
    const wire = new this.Transport(e.configuration, { token: async () => {
      const token = await this.binding.access(e);
      accessHash = createHash("sha256").update(token).digest("hex");
      if (await this.ctx.storage.get(key) === accessHash) throw new Refusal("auth", "Native access was rejected; restore native authentication before resuming");
      return token;
    }, onUnauthorized: async () => {
      if (accessHash) await this.ctx.storage.set(key, accessHash);
      throw new Refusal("auth", "Restore authentication through native MCP; the plugin never refreshes credentials");
    } }, signal, sessionID, beforeRetry);
    await wire.connect();
    return wire;
  }
  private async temporary<T>(e: Enrollment, call: (wire: Wire) => Promise<T>, sessionID = e.sessionID) {
    const wire = await this.wire(e, sessionID);
    try { return await call(wire); } finally { await wire.close().catch(error => this.failure("wire_close", error)); }
  }
  private async capture(sessionID: string): Promise<Enrollment> {
    const captured = await this.binding.capture();
    if (this.options.issuer && captured.configuration.issuer !== this.options.issuer) throw new Refusal("identity", "Native issuer does not match the pinned issuer");
    return { version: 2, sessionID, mcpName: this.options.mcpName, ...captured };
  }
  async enroll(sessionID: string, name?: string, create = false) { return this.serial(async () => {
    if (this.stopped) throw new Refusal("paused", "Plugin is stopping");
    await this.activeRoot(sessionID);
    if (this.drifted) {
      for (const watch of this.watches.values()) await watch.dispose();
      this.watches.clear();
    }
    await this.watches.get(sessionID)?.dispose(); this.watches.delete(sessionID);
    const previous = this.roots.get(sessionID);
    if (previous) await this.stop(previous);
    const captured = await this.capture(sessionID);
    const e = { ...captured, ...(previous?.e.name ? { name: previous.e.name } : {}) };
    const r: Root = { e, approval: structuredClone(e), epoch: (previous?.epoch ?? 0) + 1, paused: false, status: this.state };
    this.roots.set(sessionID, r); this.drifted = false;
    await this.save(r, true);
    this.watches.set(sessionID, await this.binding.watch(e));
    this.set(r, "approved", "Root approved; bind a name to receive deliveries");
    try {
      if (name) {
        const epoch = r.epoch, signal = new AbortController().signal;
        await this.temporary(e, async w => {
          await this.guard(r, epoch, signal);
          await w.call("bind", { name, create, where: this.ctx.location.directory });
          await this.guard(r, epoch, signal);
        });
      }
      await this.prepare(r, !!previous?.paused && !name);
    } catch (error) { this.set(r, "approved", `Root approval saved; ${failureMessage(error)}`, "enroll", failureCode(error)); }
    await this.diagnostics.flush();
    return { ...r.status, roots: this.status().roots };
  }); }
  private async prepare(r: Root, resume = false) {
    const epoch = r.epoch, signal = new AbortController().signal;
    await this.temporary(r.e, async wire => {
      await this.guard(r, epoch, signal);
      let current = bindingOf(await wire.call("whoami"));
      await this.guard(r, epoch, signal);
      if (!current.name && r.e.name && resume) {
        await wire.call("bind", { name: r.e.name, create: false, where: this.ctx.location.directory });
        await this.guard(r, epoch, signal);
        current = bindingOf(await wire.call("whoami"));
        await this.guard(r, epoch, signal);
      }
      if (r.epoch !== epoch || r.paused || this.stopped) return;
      if (!current.name) { this.set(r, "unbound", "Root approved, unbound; bind(name) to take one"); return; }
      await this.guard(r, epoch, signal);
      r.e = { ...r.e, name: current.name };
      await this.ctx.storage.set(`rememberedName:${r.e.sessionID}`, { approval: enrollmentHash(r.approval), name: current.name });
      await this.guard(r, epoch, signal);
      if (r.epoch === epoch && !r.paused && !this.stopped) {
        this.set(r, "approved", `Bound ${current.name}; opening delivery`, "prepare");
        this.start(r);
      }
    });
  }
  private start(r: Root) {
    if (r.task || r.paused || this.stopped) return;
    const epoch = r.epoch, e = structuredClone(r.e), abort = r.abort = new AbortController();
    r.task = this.run(r, e, epoch, abort.signal).catch(error => {
      if (!abort.signal.aborted) { r.paused = true; this.set(r, "paused", failureMessage(error), "subscriber", failureCode(error)); }
    });
  }
  private async run(r: Root, e: Enrollment, epoch: number, signal: AbortSignal) {
    let failures = 0, recoveries = 0, throttles = 0;
    let pendingItem: string | undefined;
    const attempts = new Map<string, number>();
    while (!signal.aborted && failures < 8) {
      let wire: Wire | undefined;
      try {
        await this.guard(r, epoch, signal);
        wire = await this.wire(e, e.sessionID, signal, () => this.guard(r, epoch, signal));
        await this.guard(r, epoch, signal);
        const current = bindingOf(await wire.call("whoami"));
        await this.guard(r, epoch, signal);
        if (!current.name) {
          r.lease = undefined;
          await wire.call("bind", { name: e.name, create: false, where: this.ctx.location.directory });
          await this.guard(r, epoch, signal);
        } else if (current.name !== e.name) throw new Refusal("identity", "Root binding changed without a native completion; explicitly enroll again");
        const lease = leaseOf(await wire.call("delivery_open"), e);
        await this.guard(r, epoch, signal);
        r.lease = lease; wire.capability = lease.capability;
        recoveries = 0;
        this.set(r, "active", `Subscribed as ${e.name}; receipts follow durable root admission`);
        let dirty = true, wake: (() => void) | undefined, closed = false;
        wire.client.setNotificationHandler("notifications/resources/updated", () => { dirty = true; wake?.(); });
        const subscription = await wire.listen();
        void subscription.closed.then(() => { closed = true; wake?.(); }, () => { closed = true; wake?.(); });
        let renewal = Date.now() + 10_000;
        try {
          while (!signal.aborted) {
            if (dirty) {
              dirty = false;
              const items = itemsOf(await wire.read("grayboard://inbox"));
              await admitPrefix(items, async item => {
                pendingItem = /^(direct|push):[1-9][0-9]*$/.test(item.id) ? item.id : `item#${createHash("sha256").update(item.id).digest("hex").slice(0, 12)}`;
                const count = (attempts.get(item.id) ?? 0) + 1;
                if (count > 8) throw new DeliveryStopped(pendingItem);
                attempts.set(item.id, count);
                if (item.ownership !== lease.ownership || item.bind_gen !== lease.bind_gen || item.name !== lease.identity.identity) throw new Refusal("identity", "Issued batch does not match the immutable lease");
                await this.guard(r, epoch, signal);
                await wire!.call("delivery_renew");
                await this.guard(r, epoch, signal);
                await this.ctx.session.synthetic({ sessionID: e.sessionID, id: stableID(e, item.id, lease.identity), text: render(item), delivery: "queue", resume: item.actionable, metadata: { source: "grayboard" } });
                await this.guard(r, epoch, signal);
                await wire!.call("delivery_renew");
                await this.guard(r, epoch, signal);
              }, async ids => {
                await this.guard(r, epoch, signal);
                await wire!.call("delivery_receipt", { ids });
                for (const id of ids) attempts.delete(id);
                failures = 0; throttles = 0; pendingItem = undefined;
              });
              if (items.length === 100) dirty = true;
            }
            if (closed) throw new Error("Subscription closed");
            if (Date.now() >= renewal) {
              await this.guard(r, epoch, signal); await wire.call("delivery_renew");
              renewal = Date.now() + 10_000; dirty = true;
            }
            if (dirty) continue;
            const timer = new AbortController();
            await Promise.race([sleep(1000, AbortSignal.any([signal, timer.signal])), new Promise<void>(resolve => { wake = resolve; })]);
            wake = undefined; timer.abort();
          }
        } finally { await subscription.close().catch(error => this.failure("subscription_close", error, r)); }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof Refusal || error instanceof DeliveryStopped) throw error;
        if (error instanceof LeaseUnavailable) {
          r.lease = undefined;
          if (++recoveries > 3) throw new Refusal("paused", "Lease recovery limit reached; explicitly enroll again");
        } else if (error instanceof SubscriberError && ["identity_in_use", "identity_unknown"].includes(error.code)) throw error;
        else {
          failures++;
          if (error instanceof SubscriberError && error.code === "receipt_capacity") {
            await this.guard(r, epoch, signal);
            if (!wire || !r.lease) throw new Refusal("paused", "Capacity recovery requires the current lease");
            await wire.call("delivery_release");
            r.lease = undefined;
            await this.guard(r, epoch, signal);
          }
        }
        this.set(r, "retrying", `Revalidating the approved root before reopening delivery (${failureCode(error)})`, "reopen", failureCode(error));
        if (wire?.admissionRetryAfterMs) {
          if (++throttles > 8) throw new Error("Admission retry limit reached; explicitly enroll again");
          await this.wait(Math.max(wire.admissionRetryAfterMs, Math.min(8000, 500 * 2 ** throttles)), signal);
        } else await this.wait(Math.min(8000, 250 * 2 ** failures), signal);
      } finally { await wire?.close().catch(error => this.failure("wire_close", error, r)); }
    }
    if (failures >= 8) throw new DeliveryStopped(pendingItem);
  }
  private async stop(r: Root) { r.epoch++; r.abort?.abort(); await r.task; r.task = undefined; r.abort = undefined; }
  private async release(r: Root) {
    const lease = r.lease; r.lease = undefined;
    await this.temporary(r.e, async wire => {
      if (lease) { wire.capability = lease.capability; await wire.call("delivery_release").catch(error => this.failure("delivery_release", error, r)); }
      await wire.call("session_end");
    });
  }
  async pause(message = "Ownership ended; explicitly enroll to resume") { return this.serial(async () => {
    for (const r of this.roots.values()) {
      r.paused = true; await this.stop(r);
      await this.release(r).catch(error => this.failure("session_end", error, r));
      await this.save(r, false).catch(error => this.failure("pause_save", error, r));
      this.set(r, "paused", message);
    }
    return this.status();
  }); }
  async restore() {
    await this.diagnostics.restore(async id => (await this.activeRoot(id)).id === id);
    const ids = await this.ctx.storage.get("rootSessionIDs");
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== "string" || this.stopped) continue;
      try {
        let session: Awaited<ReturnType<Context["session"]["get"]>>;
        try { session = await this.activeRoot(id); }
        catch { continue; }
        const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
        const e = saved?.enrollment;
        if (!e || e.version !== 2 || e.sessionID !== id || e.mcpName !== this.options.mcpName || await this.ctx.storage.get(`enrollmentHash:${id}`) !== enrollmentHash(e)) throw new Refusal("root", "Saved enrollment was edited; explicitly enroll again");
        const previous = this.status().roots.find(record => record.sessionID === id);
        const paused = !saved?.enabled || await this.ctx.storage.get(`paused:${id}`) === true || previous?.state === "paused";
        const remembered = await this.ctx.storage.get(`rememberedName:${id}`);
        const name = remembered && typeof remembered === "object" ? Object.getOwnPropertyDescriptor(remembered, "name")?.value : undefined;
        const approval = remembered && typeof remembered === "object" ? Object.getOwnPropertyDescriptor(remembered, "approval")?.value : undefined;
        const r: Root = { e: { ...e, ...(approval === enrollmentHash(e) && typeof name === "string" && /^[a-z0-9_-]{1,32}$/.test(name) ? { name } : {}) }, approval: structuredClone(e), epoch: 0, paused, status: this.state };
        this.roots.set(id, r);
        if (paused) { this.set(r, "paused", "Saved approval paused; explicitly enroll to resume"); continue; }
        await this.binding.check(e);
        this.watches.set(id, await this.binding.watch(e));
        await this.prepare(r, true);
      } catch {
        const r = this.roots.get(id);
        if (r) { r.paused = true; await this.stop(r); this.set(r, "degraded", "Saved root unavailable; approval retained, explicitly enroll to retry", "restore"); }
        else this.diagnostics.record({ state: "paused", sessionID: id, message: "Saved enrollment invalid; explicitly enroll again", operation: "restore" });
      }
    }
  }
  backgroundFailure(operation: "event" | "stream" | "restore" | "enroll" | "after" | "hook_dispose" | "rpc_dispose") {
    this.failure(operation, undefined);
  }
  private async native(tool: string) {
    const namespace = this.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_");
    return (await this.ctx.tool.list()).some(t => t.id === tool && t.options?.namespace === namespace);
  }
  async before(event: Invocation) {
    if (!await this.native(event.tool)) return;
    const path = await this.path(event.sessionID), r = this.roots.get(path.root);
    if (path.root !== event.sessionID) {
      const e = r?.e ?? await this.capture(path.root);
      await this.temporary(e, wire => wire.call("session_register", { child: event.sessionID, via: path.via }));
      this.routes.remember(path);
    }
    const bindID = this.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_") + "_bind";
    if (event.tool === bindID && path.root === event.sessionID) await this.serial(async () => {
      const current = this.roots.get(path.root);
      if (current) { this.set(current, "rebinding", "Delivery stopped before native bind", "before_bind"); await this.stop(current); }
      else this.diagnostics.record({ state: "rebinding", sessionID: path.root, message: "Native bind pending; receiving requires approval", operation: "before_bind" });
    });
  }
  async after(event: Invocation & ({ status: "completed"; result: { output?: unknown } } | { status: "error" })) {
    if (!await this.native(event.tool)) return;
    const bindID = this.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_") + "_bind";
    return this.serial(async () => {
      const r = this.roots.get(event.sessionID);
      if (!r || r.paused || this.drifted || this.stopped) return;
      try {
        if (event.tool !== bindID) {
          const output = event.status === "completed" ? event.result.output as { unbound?: unknown } | undefined : undefined;
          if (output?.unbound === true && r.e.name) {
            await this.stop(r); r.lease = undefined;
            await this.prepare(r, true);
          }
          return;
        }
        await this.stop(r);
        if (event.status === "completed") {
          const output = event.result.output as { name?: unknown; ownership?: unknown; instructions?: unknown } | undefined;
          if (!output || typeof output.name !== "string" || !Number.isSafeInteger(output.ownership) || !Array.isArray(output.instructions) || !output.instructions.every(line => typeof line === "string")) throw new Error("Native bind completion lacked validated output");
        }
        await this.prepare(r, false);
      } catch (error) { this.set(r, "approved", failureMessage(error), "after", failureCode(error)); }
    });
  }
  async observe(type: string, data: unknown) {
    if (this.stopped) return;
    if (type === "session.created" && this.options.name) {
      const id = (data as { sessionID?: string })?.sessionID;
      if (id) {
        const path = await this.path(id);
        if (path.root === id) {
          try {
            const e = await this.capture(id);
            await this.temporary(e, w => w.call("bind", { name: this.options.name, create: this.options.create === true, where: this.ctx.location.directory }));
            this.diagnostics.record({ state: "unenrolled", sessionID: id, message: "Configured binding completed; receiving still requires human approval", operation: "configured_bind" });
          } catch (error) { this.diagnostics.record({ state: "unbound", sessionID: id, message: failureMessage(error), operation: "configured_bind", code: failureCode(error) }); }
        }
      }
    }
    if (type === "credential.switched") {
      const id = (data as { integrationID?: string })?.integrationID;
      if ([...this.roots.values()].some(r => r.e.integrationID === id)) this.latch("Selected native account changed; explicitly enroll again");
    }
    if (type === "session.deleted" || type === "session.archived") {
      const id = (data as { sessionID?: string })?.sessionID;
      if (!id) return;
      const path = this.routes.end(id);
      if (!path) return;
      const r = this.roots.get(path.root);
      if (id === path.root && r) {
        r.paused = true; r.epoch++; r.abort?.abort();
        await this.serial(async () => {
          await this.stop(r); await this.release(r).catch(error => this.failure("session_end", error, r));
          await this.ctx.storage.set(`paused:${id}`, true); this.set(r, "paused", "Root ended; ownership released");
        });
      } else {
        const e = r?.e ?? await this.capture(path.root);
        await this.temporary(e, w => w.call("session_end"), id).catch(error => this.failure("child_end", error, r));
      }
    }
  }
  async close() {
    this.stopped = true;
    for (const r of this.roots.values()) r.abort?.abort();
    await this.controls;
    for (const r of this.roots.values()) await this.stop(r);
    for (const watch of this.watches.values()) await watch.dispose().catch(error => this.failure("watch_dispose", error));
    this.watches.clear();
    await this.diagnostics.flush();
  }
}
