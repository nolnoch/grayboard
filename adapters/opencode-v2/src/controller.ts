import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "./binding.js";
import { LeaseUnavailable, Wire } from "./wire.js";
import { METADATA, Refusal, admitPrefix, bindingOf, enrollmentHash, itemsOf, leaseOf, render, same, stableID, type Enrollment, type Lease } from "./model.js";
import { SessionRoutes, resolveRoot } from "./sessions.js";

export type Options = { mcpName: string; issuer?: string; name?: string; create?: boolean };
export type Status = { state: string; message: string; sessionID?: string };
type Root = { e: Enrollment; epoch: number; paused: boolean; status: Status; abort?: AbortController; task?: Promise<void>; lease?: Lease };
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
  private state: Status = { state: "unenrolled", message: "Approve an active root; approval does not bind a name" };
  constructor(readonly ctx: Context, readonly options: Options, readonly Transport: typeof Wire = Wire) {
    this.binding = new Binding(ctx, options.mcpName, () => this.latch("Native binding changed; explicitly enroll again"));
  }
  status(): Status { return { ...this.state }; }
  private set(r: Root, state: string, message: string) { this.state = r.status = { state, message, sessionID: r.e.sessionID }; }
  private serial<T>(call: () => Promise<T>): Promise<T> {
    const result = this.controls.then(call, call);
    this.controls = result.catch(() => {});
    return result;
  }
  private latch(message: string) {
    this.drifted = true;
    for (const r of this.roots.values()) {
      r.paused = true; r.epoch++; r.abort?.abort(); this.set(r, "paused", message);
      void this.ctx.storage.set(`paused:${r.e.sessionID}`, true).catch(() => {});
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
  private async save(r: Root, enabled = !r.paused) {
    const session = await this.activeRoot(r.e.sessionID);
    await this.ctx.session.update({ sessionID: session.id, metadata: { ...session.metadata, [METADATA]: { enabled, enrollment: r.e } } });
    await this.ctx.storage.set(`enrollmentHash:${session.id}`, enrollmentHash(r.e));
    await this.ctx.storage.set(`paused:${session.id}`, !enabled);
    await this.ctx.storage.set("rootSessionIDs", [...this.roots.keys()]);
  }
  private async guard(r: Root, epoch: number, signal: AbortSignal) {
    const e = r.e, hash = enrollmentHash(e);
    const check = () => { if (this.stopped || this.drifted || r.paused || signal.aborted || r.epoch !== epoch || this.roots.get(e.sessionID) !== r || enrollmentHash(r.e) !== hash) throw new Refusal("paused", "Admission target changed"); };
    check();
    await this.binding.check(e);
    const session = await this.activeRoot(e.sessionID);
    const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
    if (!saved?.enabled || !same(saved.enrollment, e)) { r.paused = true; throw new Refusal("root", "Root approval changed; explicitly enroll again"); }
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
    try { return await call(wire); } finally { await wire.close().catch(() => {}); }
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
    const r: Root = { e, epoch: (previous?.epoch ?? 0) + 1, paused: false, status: this.state };
    this.roots.set(sessionID, r); this.drifted = false;
    await this.save(r);
    this.watches.set(sessionID, await this.binding.watch(e));
    this.set(r, "approved", "Root approved; bind a name to receive deliveries");
    try {
      if (name) await this.temporary(e, w => w.call("bind", { name, create, where: this.ctx.location.directory }));
      await this.prepare(r, !!previous?.paused && !name);
    } catch (error) { this.set(r, "approved", `Root approval saved; binding refused: ${error instanceof Error ? error.message : "unknown refusal"}`); }
    return this.status();
  }); }
  private async prepare(r: Root, resume = false) {
    const epoch = r.epoch;
    await this.temporary(r.e, async wire => {
      let current = bindingOf(await wire.call("whoami"));
      if (!current.name && r.e.name && resume) {
        await wire.call("bind", { name: r.e.name, create: false, where: this.ctx.location.directory });
        current = bindingOf(await wire.call("whoami"));
      }
      if (r.epoch !== epoch || r.paused || this.stopped) return;
      if (!current.name) { this.set(r, "unbound", `Root approved, unbound; bind(name) to take one. Candidates: ${JSON.stringify(current.candidates ?? [])}`); return; }
      r.e = { ...r.e, name: current.name };
      await this.save(r);
      if (r.epoch === epoch && !r.paused && !this.stopped) this.start(r);
    });
  }
  private start(r: Root) {
    if (r.task || r.paused || this.stopped) return;
    const epoch = r.epoch, e = structuredClone(r.e), abort = r.abort = new AbortController();
    r.task = this.run(r, e, epoch, abort.signal).catch(error => {
      if (!abort.signal.aborted) { r.paused = true; this.set(r, "paused", error instanceof Error ? error.message : "Subscriber stopped"); void this.ctx.storage.set(`paused:${e.sessionID}`, true); }
    });
  }
  private async run(r: Root, e: Enrollment, epoch: number, signal: AbortSignal) {
    let failures = 0, recoveries = 0, throttles = 0;
    while (!signal.aborted && failures < 8) {
      let wire: Wire | undefined;
      try {
        await this.guard(r, epoch, signal);
        wire = await this.wire(e, e.sessionID, signal, () => this.guard(r, epoch, signal));
        const current = bindingOf(await wire.call("whoami"));
        if (!current.name) {
          r.lease = undefined;
          await wire.call("bind", { name: e.name, create: false, where: this.ctx.location.directory });
        } else if (current.name !== e.name) throw new Refusal("identity", "Root binding changed without a native completion; explicitly enroll again");
        const lease = leaseOf(await wire.call("delivery_open"), e);
        await this.guard(r, epoch, signal);
        r.lease = lease; wire.capability = lease.capability;
        failures = 0; recoveries = 0;
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
              });
              throttles = 0;
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
        } finally { await subscription.close().catch(() => {}); }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof Refusal) throw error;
        if (error instanceof LeaseUnavailable) {
          r.lease = undefined;
          if (++recoveries > 3) throw new Refusal("paused", "Lease recovery limit reached; explicitly enroll again");
        } else if (error instanceof Error && /identity_in_use|already in use|identity_unknown/.test(error.message)) throw error;
        else failures++;
        this.set(r, "retrying", `Revalidating the approved root before reopening delivery: ${error instanceof Error ? error.message : "transport failure"}`);
        if (wire?.admissionRetryAfterMs) {
          if (++throttles > 8) throw new Error("Admission retry limit reached; explicitly enroll again");
          await sleep(Math.max(wire.admissionRetryAfterMs, Math.min(8000, 500 * 2 ** throttles)), signal);
        } else await sleep(Math.min(8000, 250 * 2 ** failures), signal);
      } finally { await wire?.close().catch(() => {}); }
    }
    if (failures >= 8) throw new Error("Retry limit reached; explicitly enroll again");
  }
  private async stop(r: Root) { r.epoch++; r.abort?.abort(); await r.task; r.task = undefined; r.abort = undefined; }
  private async release(r: Root) {
    const lease = r.lease; r.lease = undefined;
    await this.temporary(r.e, async wire => {
      if (lease) { wire.capability = lease.capability; await wire.call("delivery_release").catch(() => {}); }
      await wire.call("session_end");
    });
  }
  async pause(message = "Ownership ended; explicitly enroll to resume") { return this.serial(async () => {
    for (const r of this.roots.values()) {
      r.paused = true; await this.stop(r);
      await this.release(r).catch(() => {});
      await this.save(r, false).catch(() => {});
      this.set(r, "paused", message);
    }
    return this.status();
  }); }
  async restore() {
    const ids = await this.ctx.storage.get("rootSessionIDs");
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== "string" || this.stopped) continue;
      let session: Awaited<ReturnType<Context["session"]["get"]>>;
      try { session = await this.activeRoot(id); }
      catch { continue; }
      const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
      const e = saved?.enrollment;
      if (!e || e.version !== 2 || e.sessionID !== id || e.mcpName !== this.options.mcpName || await this.ctx.storage.get(`enrollmentHash:${id}`) !== enrollmentHash(e)) throw new Refusal("root", "Saved enrollment was edited; explicitly enroll again");
      const paused = !saved?.enabled || await this.ctx.storage.get(`paused:${id}`) === true;
      const r: Root = { e, epoch: 0, paused, status: this.state };
      this.roots.set(id, r);
      if (paused) { this.set(r, "paused", "Saved approval paused; explicitly enroll to resume"); continue; }
      await this.binding.check(e);
      this.watches.set(id, await this.binding.watch(e));
      await this.prepare(r, true);
    }
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
      if (current) await this.stop(current);
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
      } catch (error) { this.set(r, "approved", `Approval retained; lease unavailable: ${error instanceof Error ? error.message : "unknown refusal"}`); }
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
            this.state = { state: "unenrolled", sessionID: id, message: `Bound ${this.options.name}; receiving still requires human approval` };
          } catch (error) { this.state = { state: "unbound", sessionID: id, message: error instanceof Error ? error.message : "Configured binding refused" }; }
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
          await this.stop(r); await this.release(r).catch(() => {});
          await this.ctx.storage.set(`paused:${id}`, true); this.set(r, "paused", "Root ended; ownership released");
        });
      } else {
        const e = r?.e ?? await this.capture(path.root);
        await this.temporary(e, w => w.call("session_end"), id).catch(() => {});
      }
    }
  }
  async close() {
    this.stopped = true;
    for (const r of this.roots.values()) r.abort?.abort();
    await this.controls;
    for (const r of this.roots.values()) await this.stop(r);
    for (const watch of this.watches.values()) await watch.dispose().catch(() => {});
    this.watches.clear();
  }
}
