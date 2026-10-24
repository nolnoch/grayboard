import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "./binding.js";
import { LeaseUnavailable, Wire } from "./wire.js";
import { METADATA, Refusal, admitPrefix, enrollmentHash, identityOf, itemsOf, render, same, stableID, type Enrollment } from "./model.js";

export type Options = { mcpName: string; issuer: string; rootSessionID?: string };
export type Status = { state: string; message: string; sessionID?: string };
function fingerprint(access: string) { return createHash("sha256").update(access).digest("hex"); }
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
  private enrollment?: Enrollment;
  private abort?: AbortController;
  private task?: Promise<void>;
  private controls: Promise<unknown> = Promise.resolve();
  private pendingControls = 0;
  private latched = false;
  private stopped = false;
  private rejected?: string;
  private lastAccess?: string;
  private persistence: Promise<void> = Promise.resolve();
  private state: Status = { state: "unenrolled", message: "Explicitly enroll an active root session" };
  constructor(readonly ctx: Context, readonly options: Options) {
    this.binding = new Binding(ctx, options.mcpName, () => this.latch("Native binding changed; explicitly enroll again"));
  }
  status(): Status { return { ...this.state }; }
  private serial<T>(call: () => Promise<T>): Promise<T> {
    if (this.pendingControls >= 8) return Promise.reject(new Refusal("paused", "Too many pending controls; retry after the current operation"));
    this.pendingControls++;
    const result = this.controls.then(call, call).finally(() => { this.pendingControls--; });
    this.controls = result.catch(() => {});
    return result;
  }
  private latch(message: string) {
    this.persistence = this.persistence.then(() => this.ctx.storage.set("paused", true)).catch(() => {});
    this.latched = true;
    this.state = { state: "paused", message, sessionID: this.enrollment?.sessionID };
    this.abort?.abort();
  }
  observe(type: string, data: unknown) {
    if (!this.enrollment || this.stopped) return;
    if (type === "credential.switched" && (data as { integrationID?: string })?.integrationID === this.enrollment.integrationID) this.latch("Selected native account changed; explicitly enroll again");
  }
  private async root(sessionID: string) {
    const session = await this.ctx.session.get({ sessionID });
    if (session.parentID || session.time.archived) throw new Refusal("root", "An active root session is required");
    return session;
  }
  private async guard(e: Enrollment, signal?: AbortSignal) {
    if (this.latched || signal?.aborted) throw new Refusal("paused", "Subscriber paused");
    try {
      await this.binding.check(e);
      const session = await this.root(e.sessionID);
      const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
      if (!saved?.enabled || !same(saved.enrollment, e)) throw new Refusal("root", "Root enrollment changed; explicitly enroll again");
    } catch (error) {
      if (!signal?.aborted && !this.stopped && error instanceof Refusal) this.latch(error.message);
      throw error;
    }
    if (signal?.aborted || this.latched) throw new Refusal("paused", "Subscriber paused");
  }
  private async access(e: Enrollment, signal: AbortSignal) {
    await this.guard(e, signal);
    const access = await this.binding.access(e);
    const hash = fingerprint(access);
    if (hash === this.rejected) throw new Refusal("auth", "Native access was rejected; restore native authentication before resuming");
    this.lastAccess = hash;
    return access;
  }
  private wire(e: Enrollment, signal: AbortSignal) {
    return new Wire(e.configuration, { token: () => this.access(e, signal), onUnauthorized: async () => {
      const rejected = this.rejected = this.lastAccess;
      if (rejected) this.persistence = this.persistence.then(() => this.ctx.storage.set("rejectedAccessHash", rejected)).catch(() => {});
      this.state = { state: "auth", message: "Subscriber authorization refused; reconnect or sign in using native MCP, then resume", sessionID: e.sessionID };
      throw new Refusal("auth", this.state.message);
    } }, signal);
  }
  async enroll(sessionID: string) { return this.serial(async () => {
    if (this.stopped) throw new Refusal("paused", "Plugin is stopping");
    await this.stopLoop();
    if (this.enrollment && this.enrollment.sessionID !== sessionID) {
      const old = await this.ctx.session.get({ sessionID: this.enrollment.sessionID }).catch(() => undefined);
      if (old) await this.ctx.session.update({ sessionID: old.id, metadata: { ...old.metadata, [METADATA]: { enabled: false, enrollment: this.enrollment } } });
    }
    await this.root(sessionID);
    const captured = await this.binding.capture();
    const discovery = await fetch(captured.configuration.discovery, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const discoveredIssuer = discovery.ok ? (await discovery.json() as { issuer?: string }).issuer : undefined;
    const issuer = this.options.issuer || discoveredIssuer;
    if (!issuer || discoveredIssuer !== issuer) throw new Refusal("identity", "Trusted discovery issuer mismatch");
    const parsedIssuer = new URL(issuer);
    if (parsedIssuer.protocol !== "https:" || parsedIssuer.username || parsedIssuer.password || parsedIssuer.search || parsedIssuer.hash) throw new Refusal("identity", "Trusted discovery must declare an HTTPS issuer");
    this.latched = false;
    const provisional: Enrollment = { version: 1, sessionID, mcpName: this.options.mcpName, ...captured, identity: { user: { id: 1, email: "" }, identity: "", identity_full: "/", issuer: "", resource: "" } };
    const ac = new AbortController();
    // Enrollment reads identity before owning delivery; no session metadata exists yet.
    const wire = new Wire(captured.configuration, { token: async () => {
      if (this.latched) throw new Refusal("binding", "Binding changed during enrollment");
      const access = await this.binding.access(captured);
      if (fingerprint(access) === this.rejected) throw new Refusal("auth", "Restore native authentication before enrollment");
      return access;
    }, onUnauthorized: async () => { throw new Refusal("auth", "Use native MCP sign-in"); } }, ac.signal);
    try {
      await wire.connect();
      const identity = identityOf(await wire.read("grayboard://identity"));
      if (identity.issuer !== issuer || identity.resource !== captured.configuration.url || identity.identity !== captured.configuration.identity) throw new Refusal("identity", "Authenticated identity does not match trusted enrollment");
      await this.binding.check(captured);
      if (this.latched) throw new Refusal("binding", "Binding changed during enrollment");
      const session = await this.root(sessionID);
      const e: Enrollment = { ...provisional, identity };
      await this.ctx.session.update({ sessionID, metadata: { ...session.metadata, [METADATA]: { enabled: true, enrollment: e } } });
      this.enrollment = e;
      await this.ctx.storage.set("rootSessionID", sessionID);
      await this.ctx.storage.set("enrollmentHash", enrollmentHash(e));
      await this.persistence;
      await this.ctx.storage.set("paused", false);
    } finally { await wire.close().catch(() => {}); ac.abort(); }
    this.start();
    return this.status();
  }); }
  async pause(message = "Explicitly enroll to resume") { return this.serial(async () => {
    await this.stopLoop();
    this.latch(message);
    await this.persistence;
    if (this.enrollment) {
      const session = await this.ctx.session.get({ sessionID: this.enrollment.sessionID }).catch(() => undefined);
      if (session) await this.ctx.session.update({ sessionID: this.enrollment.sessionID, metadata: { ...session.metadata, [METADATA]: { enabled: false, enrollment: this.enrollment } } });
    }
    this.state = { state: "paused", message, sessionID: this.enrollment?.sessionID };
    return this.status();
  }); }
  async restore() {
    if (this.stopped) return;
    const rejected = await this.ctx.storage.get("rejectedAccessHash");
    if (typeof rejected === "string") this.rejected = rejected;
    if (await this.ctx.storage.get("paused") === true) {
      this.latched = true;
      this.state = { state: "paused", message: "Saved subscriber pause; explicitly enroll to resume" };
      return;
    }
    const stored = await this.ctx.storage.get("rootSessionID");
    const sessionID = this.options.rootSessionID ?? (typeof stored === "string" ? stored : undefined);
    if (!sessionID) return;
    const session = await this.root(sessionID);
    const saved = session.metadata?.[METADATA] as { enabled?: boolean; enrollment?: Enrollment } | undefined;
    if (!saved?.enabled || !saved.enrollment) {
      if (this.options.rootSessionID && !saved) return this.enroll(sessionID);
      return;
    }
    {
      const e = saved.enrollment;
      if (e.sessionID !== sessionID) throw new Refusal("root", "Saved enrollment target changed");
      identityOf(e.identity);
      if (await this.ctx.storage.get("enrollmentHash") !== enrollmentHash(e)) throw new Refusal("root", "Saved enrollment was edited; explicitly enroll again");
      if (e.version !== 1 || e.mcpName !== this.options.mcpName || (this.options.issuer && e.identity.issuer !== this.options.issuer) || e.identity.resource !== e.configuration.url) throw new Refusal("identity", "Saved enrollment does not match trusted options");
      this.enrollment = e;
      for (let attempt = 0; ; attempt++) {
        if (this.stopped) return;
        try { await this.binding.check(e); break; }
        catch (error) {
          if (this.latched || !(error instanceof Refusal) || attempt >= 49) throw error;
          await sleep(100, new AbortController().signal);
        }
      }
      await this.guard(e);
      this.start();
    }
  }
  private start() {
    if (!this.enrollment || this.stopped) return;
    this.latched = false;
    this.state = { state: "connecting", message: "Connecting subscriber", sessionID: this.enrollment.sessionID };
    const ac = this.abort = new AbortController();
    this.task = this.run(this.enrollment, ac.signal).catch(() => {
      if (!ac.signal.aborted) this.state = { state: "paused", message: "Delivery stopped; inspect native MCP status and explicitly enroll again", sessionID: this.enrollment?.sessionID };
    });
  }
  private async run(e: Enrollment, signal: AbortSignal) {
    let wire: Wire | undefined;
    let capability: string | undefined;
    let attempts = 0, recoveries = 0;
    try {
      while (!signal.aborted && attempts < 8) {
        try {
          await this.guard(e, signal);
          this.state = { state: "connecting", message: "Connecting subscriber", sessionID: e.sessionID };
          wire = this.wire(e, signal);
          await wire.connect();
          if (!same(identityOf(await wire.read("grayboard://identity")), e.identity)) throw new Refusal("identity", "Authenticated account changed; explicitly enroll again");
          this.rejected = undefined;
          await this.persistence;
          await this.ctx.storage.remove("rejectedAccessHash");
          if (!capability) {
            const lease = await wire.call("delivery_open") as { capability?: string; identity?: { identity_full?: string } };
            if (!lease.capability || !/^[A-Za-z0-9_-]{43}$/.test(lease.capability) || lease.identity?.identity_full !== e.identity.identity_full) throw new Refusal("identity", "Invalid delivery lease");
            capability = lease.capability;
          }
          wire.capability = capability;
          await wire.call("delivery_renew");
          let subscription = await wire.listen();
          let dirty = true;
          let wake: (() => void) | undefined;
          wire.client.setNotificationHandler("notifications/resources/updated", () => { dirty = true; wake?.(); });
          this.state = { state: "active", message: "Subscribed; receipts follow durable root admission", sessionID: e.sessionID };
          let renewal = Date.now() + 10_000;
          let subscriptionClosed = false;
          const watch = (current: typeof subscription) => {
            const closed = () => { if (current === subscription) { subscriptionClosed = true; wake?.(); } };
            void current.closed.then(closed, closed);
          };
          watch(subscription);
          while (!signal.aborted) {
            if (dirty) {
              dirty = false;
              const items = itemsOf(await wire.read("grayboard://inbox"));
              await admitPrefix(items, async item => {
                await this.guard(e, signal);
                await this.ctx.session.synthetic({ sessionID: e.sessionID, id: stableID(e, item.id), text: render(item), delivery: "queue", resume: item.actionable, metadata: { source: "grayboard" } });
                await this.guard(e, signal);
              }, async ids => {
                await this.guard(e, signal);
                await wire!.call("delivery_receipt", { ids });
              });
              if (items.length === 100) dirty = true;
            }
            if (signal.aborted) break;
            if (subscriptionClosed) throw new Error("Subscription closed");
            if (Date.now() >= renewal) {
              await this.guard(e, signal);
              await wire.call("delivery_renew");
              await subscription.close();
              subscription = await wire.listen();
              subscriptionClosed = false;
              watch(subscription);
              renewal = Date.now() + 10_000;
              dirty = true;
            }
            if (dirty) continue;
            const timer = new AbortController();
            await Promise.race([sleep(Math.min(1000, Math.max(1, renewal - Date.now())), AbortSignal.any([signal, timer.signal])), new Promise<void>(resolve => { wake = resolve; })]);
            wake = undefined;
            timer.abort();
          }
          await subscription.close().catch(() => {});
          break;
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof LeaseUnavailable) {
            capability = undefined;
            await wire?.close().catch(() => {});
            wire = undefined;
            if (++recoveries > 3) { this.latch("Lease recovery limit reached; explicitly enroll again"); break; }
            attempts = 0;
            this.state = { state: "retrying", message: "Lease expired; revalidating the enrolled account before reacquiring", sessionID: e.sessionID };
            await sleep(500, signal);
            continue;
          }
          if (error instanceof Refusal) {
            if (error.code !== "auth") this.latch(error.message);
            else this.state = { state: "auth", message: error.message, sessionID: e.sessionID };
            break;
          }
          attempts++;
          this.state = { state: "retrying", message: "Delivery interrupted; pending items remain durable", sessionID: e.sessionID };
          await wire?.close().catch(() => {});
          wire = undefined;
          await sleep(Math.min(8000, 250 * 2 ** attempts), signal);
        }
      }
      if (attempts >= 8) this.latch("Retry limit reached; explicitly enroll again");
    } finally {
      await wire?.close().catch(() => {});
      // Never use a cached access token or a changed account for old-lease cleanup.
      if (capability && !this.rejected) {
        const cleanup = new AbortController();
        const timeout = setTimeout(() => cleanup.abort(), 3000);
        let release: Wire | undefined;
        try {
          await this.binding.check(e);
          release = new Wire(e.configuration, { token: () => this.binding.access(e), onUnauthorized: async () => { throw new Error("Cleanup refused"); } }, cleanup.signal);
          release.capability = capability;
          await release.connect();
          await release.call("delivery_release");
        } catch {} finally { await release?.close().catch(() => {}); clearTimeout(timeout); cleanup.abort(); }
      }
    }
  }
  private async stopLoop() { this.abort?.abort(); await this.task; this.task = undefined; this.abort = undefined; }
  async close() { this.stopped = true; this.abort?.abort(); await this.controls; await this.stopLoop(); await this.persistence; }
}
