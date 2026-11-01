// One root session's delivery (#444) on top of HostedClient, for every hosted
// harness adapter (pi, omp, Claude Code): the session's delivery lock, or a
// wait for it while another process holds it; the Controller that holds the
// lease and admits items; its diagnostic sink; the epoch-guarded restart
// after a credential change; the notices shown with the next tool result;
// and the one shutdown order. The host renders and delivers an item
// (`admit`), registers the tool list, and passes a /new or /fork's carried
// name (pi/omp).
//
// Not vendored to OpenCode V2 (scripts/sync_hosted_core.ts): it imports
// login, storage and proxy, which OpenCode doesn't carry.
import type { CallToolResult } from "@modelcontextprotocol/client";
import { message, type Disposable, type HostedClient } from "./client.js";
import { Controller, DRIFTED, type Status } from "./controller.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type { Lock } from "./lock.js";
import { accessExpiry, DeliveryHeldElsewhere, Refusal, type AccessExpired, type Identity, type Item } from "./model.js";
import type { HostPort } from "./port.js";
import { failure, hostTools, snapshotTools, type NativeTool, type ToolProxy } from "./proxy.js";
import { AncestryError } from "./sessions.js";
import { deliveryPath, FileStorage, sessionPath, tryDelivery, waitDelivery } from "./storage.js";

export type RootOptions = {
  sessionID: string;
  stateDir: string;                 // deliveryPath / sessionPath base
  place: () => string;              // the bind's `where`
  push: boolean;                    // false: tools-only (Claude Code with channels off): no lock, no Controller
  carried?: string;                 // a /new or /fork's carried name (pi/omp), taken by the first start that binds it
  // The host renders and delivers; `signal` is the Controller run loop's, which
  // a host whose admit waits (Claude Code's `initialized`) races.
  admit(item: Item, stableID: string, identity: Identity, signal: AbortSignal): Promise<void>;
  onTools(tools: NativeTool[]): void;
};
export type RootStatus = {
  held?: string;                    // another process holds this session's delivery
  error?: string;                   // the delivery lock couldn't be taken: "couldn't take delivery: <message>"
  signedOut?: AccessExpired;        // why the last start failed for want of a sign-in
  controller?: Status;
};
// instructions() before the root has a connection.
export class NotStarted extends Error {
  constructor() { super("starting"); }
}

// Notices are keyed slots shown with the next tool result, in this order:
// each keeps only its latest text, so a superseded pause or held notice is
// never shown. "first" and "last" are the host's (noticeOnce).
const SLOTS = ["held", "start", "sink", "first", "last"] as const;
type Slot = typeof SLOTS[number];

export class RootDelivery {
  private closed = false;          // shutdown began: nothing new starts
  private done = false;            // shutdown finished: nothing more is said
  private shutting: Promise<string | undefined> | undefined;
  private controller: Controller | undefined;
  private lock: Lock | undefined;
  private proxy: ToolProxy | undefined;
  private waiter: AbortController | undefined;
  private watcher: Disposable | undefined;
  private subscription: Disposable | undefined;
  private held: string | undefined;
  private error: string | undefined;
  private signedOut: AccessExpired | undefined;
  private begun: string | undefined;     // the store epoch this root last (re)started under
  private carrying: string | undefined;  // the carried name, until a start takes it
  private starting: Promise<void> | undefined;   // own(): the Controller and push proxy coming up
  private restarting: Promise<void> | undefined;
  private used = false;                  // a call went out under this session's id
  private readonly notices = new Map<Slot, string>();
  private lastBinding: string | undefined;
  private lastRecord: string | undefined;

  constructor(private readonly client: HostedClient, private readonly o: RootOptions) {
    this.carrying = o.carried;
  }

  // Said through the host until shutdown finishes: the shutdown's own
  // records (a release that failed) are said too.
  private log(text: string, level: "info" | "warning" | "error") {
    if (!this.done) this.client.options.log(text, level);
  }
  private path() { return deliveryPath(this.o.stateDir, this.client.login.resource, this.client.options.clientId, this.o.sessionID); }
  private async epoch() { return (await this.client.login.read().catch(() => undefined))?.epoch; }

  // Takes this session's delivery, or runs tools-only while another process
  // holds it (and takes over when it exits), or tools-only for good when the
  // host asked for no push. Never rejects: every failure is said and leaves a status.
  async start(): Promise<void> {
    if (this.closed || this.watcher) return;
    this.watcher = this.client.watch();
    this.subscription = this.client.onChange(signedIn => { if (signedIn) void this.restartIfChanged(); });
    if (!this.o.push) { this.toolsOnly(); return; }
    await this.take();
  }
  private async take(): Promise<void> {
    // resume() runs take() again: an earlier attempt's waiter would keep
    // polling beside this one's, and could start a second Controller.
    this.waiter?.abort();
    let taken: Lock | undefined;
    try { taken = tryDelivery(this.path()); }
    catch (error) {
      // Not BUSY (permissions, I/O): no waiter, whose every try would fail
      // the same way. A definitive answer, so an earlier held claim no longer
      // stands (and no longer keeps the shutdown from ending what calls bound).
      this.clearHeld();
      this.failedLock(error);
      this.toolsOnly();
      return;
    }
    if (taken) return this.starting = this.own(taken);
    // BUSY is definitive too: another process holds delivery, so an earlier
    // lock error no longer stands.
    this.clearError();
    this.held = new DeliveryHeldElsewhere(this.client.options.harness).message;
    this.notices.set("held", this.held);
    this.toolsOnly();
    const waiter = this.waiter = new AbortController();
    void waitDelivery(this.path(), waiter.signal).then(
      next => { if (waiter.signal.aborted) next.release(); else this.starting = this.own(next); },
      // The wait stopped but the holder may still run: `held` stays, so the
      // shutdown never ends that process's session.
      error => { if (!waiter.signal.aborted) this.failedLock(error); },
    );
  }
  private failedLock(error: unknown) {
    this.error = `couldn't take delivery: ${message(error)}`;
    this.notices.set("start", this.error);
    this.log(this.error, "error");
  }
  // A held claim or lock error that no longer stands, with its notice if nobody saw it yet.
  private clearHeld() {
    if (this.held && this.notices.get("held") === this.held) this.notices.delete("held");
    this.held = undefined;
  }
  private clearError() {
    if (this.error && this.notices.get("start") === this.error) this.notices.delete("start");
    this.error = undefined;
  }
  private toolsOnly() {
    if (this.proxy) return;
    this.proxy = this.client.proxy("poll", { onTools: tools => this.listed(tools) });
    void this.client.connect(this.proxy);
  }
  private listed(tools: NativeTool[]) { if (!this.closed) this.o.onTools(tools); }

  // The lock is ours: run the Controller and declare push delivery. Never
  // rejects. Every await re-checks `closed`, so a start the shutdown overtook
  // builds nothing more; the shutdown awaits it, then closes the connection
  // it built (this.proxy), however long the host waited.
  private async own(taken: Lock): Promise<void> {
    if (this.closed) { taken.release(); return; }
    this.lock = taken;
    // A held claim or lock error no longer stands.
    this.clearHeld();
    this.clearError();
    try {
      // Read before the Controller exists: a degraded record its restore
      // makes (an unreadable state file) is weighed against this epoch.
      this.begun = await this.epoch();
      if (this.closed) return;
      const controller = this.controller = new Controller(this.port(), { sink: this.sink });
      await controller.restore();
      if (this.closed) return;
      // The tools-only proxy's calls in flight finish on it.
      const proxy = this.client.proxy("push", { hooks: controller, onTools: tools => this.listed(tools), onAfterFailure: () => controller.backgroundFailure("after") });
      const old = this.proxy;
      this.proxy = proxy;
      if (old) void this.client.retire(old);
      await this.client.connect(proxy);
      if (this.closed) return;
      await this.restart();
    } catch (error) { this.log(`couldn't start delivery: ${message(error)}`, "error"); }
  }

  private port(): HostPort {
    const c = this.client.options, id = this.o.sessionID, wire = this.client.wireOptions("push");
    return {
      harness: c.harness, resumeHint: c.resumeHint, loginAction: c.loginAction, sessionKey: wire.sessionKey,
      client: wire.client, delivery: wire.delivery!,
      storage: new FileStorage(sessionPath(this.o.stateDir, this.client.login.resource, c.clientId, id)),
      place: this.o.place,
      ancestry: async sessionID => {
        if (sessionID !== id) throw new AncestryError(`Grayboard session ${sessionID} isn't this ${c.harness} session's root`);
        return { sessionID, root: id, via: [] };
      },
      credential: this.client.login.credential(),
      approval: null,
      // The run loop's signal aborted (a shutdown, a restart): the host never sees the item.
      admit: async (_e, item, stableID, identity, signal) => {
        if (signal.aborted) throw new Refusal("paused", `the ${c.harness} session closed`);
        await this.o.admit(item, stableID, identity, signal);
      },
    };
  }

  // (Re)starts delivery: under the carried name until a start takes it (one
  // the server refused, or couldn't be reached for, is retried by the next
  // start), else rebinding the name a resume restores. A name that didn't
  // take is said, and in the next tool result; a pause, by the sink.
  private restart(): Promise<void> {
    return this.restarting ??= this.begin().finally(() => { this.restarting = undefined; });
  }
  private async begin(): Promise<void> {
    const controller = this.controller;
    if (!controller || this.closed) return;
    const id = this.o.sessionID, carried = this.carrying;
    try {
      // Set before the start: the sink weighs a pause its run loop reaches
      // before resume returns against this epoch.
      this.begun = await this.epoch();
      const expected = carried ?? await controller.carried(id);
      const status = carried ? await controller.enroll(id, carried, false) : await controller.resume(id);
      if (this.closed) return;
      this.signedOut = undefined;
      // The Controller's own bind changed what the server's instructions say.
      this.proxy?.forget(id);
      const root = status.roots.find(r => r.sessionID === id);
      // enroll's and resume's failures record operation "enroll"; a resume
      // names its root before the rebind, so the name alone proves nothing.
      const bound = root && root.operation !== "enroll" && root.state !== "unbound" ? root.name : undefined;
      if (carried && bound && this.carrying === carried) this.carrying = undefined;
      if (expected && bound !== expected && root?.state !== "paused") {
        const now = bound ? `it is bound as ${bound}` : "it is unbound";
        const text = carried ? `this session couldn't take the name ${carried} it carried over (${root?.message ?? status.message}); ${now}`
          : `this session couldn't take back its name ${expected} (${root?.message ?? status.message}); ${now}`;
        this.notices.set("start", text);
        this.log(text, "warning");
      }
    } catch (error) {
      if (this.closed) return;
      const expired = accessExpiry(error);
      if (!expired) { this.log(`couldn't start delivery: ${message(error)}`, "error"); return; }
      this.signedOut = expired;
      // Once per sign-out: the watch, a racing restart or the host's own
      // logout may have said it already.
      if (!this.client.announced) { this.client.markAnnounced(); this.log(expired.message, "warning"); }
    }
  }

  // A sign-in (the watch's, or the host's own: pi's /grayboard login, the
  // plugin's sign-in): the Controller's own watch pauses this root, so it
  // restarts under the new grant unless it already started under it. One
  // path, guarded by the store's epoch, so two triggers restart once.
  async credentialChanged(): Promise<void> {
    if (this.closed) return;
    try { await this.client.login.token(); }
    catch (error) {
      // Signed out: the watch says it once; the Controller's watch pauses the root.
      if (!accessExpiry(error)) this.log(`couldn't read the sign-in: ${message(error)}`, "warning");
      return;
    }
    if (this.proxy) await this.client.connect(this.proxy);
    await this.restartIfChanged();
  }
  private async restartIfChanged(): Promise<void> {
    if (this.closed || !this.controller) return;
    // A restart already running may have read the old grant.
    await this.restarting;
    const epoch = await this.epoch();
    if (!this.signedOut && epoch !== undefined && epoch === this.begun) return;
    await this.restart();
  }

  // The Controller's records. A pause or degradation its run loop reaches
  // on its own (retry budget, identity, lease recovery, admission limits) is
  // said at once and in the next tool result. A credential change is the
  // watch's to say: the Controller pauses for it with the drift message, and
  // any other pause after it is skipped too (the store's epoch moved since
  // this root started). The shutdown's own pause is nobody's; a release that
  // failed is always said, whatever the epoch (a logout, then a quit). A
  // change of state or name drops the cached instructions: the Controller's
  // own binds never pass through the proxy's bind result. A record with no
  // session is this Controller's own (it runs one root).
  private sink: DiagnosticSink = async record => {
    const id = this.o.sessionID;
    if (record.sessionID !== undefined && record.sessionID !== id) return;
    const binding = `${record.state}\n${record.name ?? ""}`;
    if (binding !== this.lastBinding) { this.lastBinding = binding; this.proxy?.forget(id); }
    if (record.state === "active") this.carrying = undefined;
    const key = `${record.state}\n${record.message}`;
    if (key === this.lastRecord) return;
    this.lastRecord = key;
    if (record.state !== "paused" && record.state !== "degraded") return;
    if (record.state === "paused" && record.operation === "session_end") return;
    if (record.message.startsWith(DRIFTED)) return;
    const release = record.state === "degraded" && (record.operation === "session_end" || record.operation === "delivery_release");
    if (!release && await this.epoch() !== this.begun) return;
    const text = `delivery ${record.state}: ${record.message}`;
    this.notices.set("sink", text);
    this.log(text, "warning");
  };

  // A held root refuses bind and unbind; then the host's `before` (the
  // plugin's sign-in offer and unpause), whose notice is shown last; then
  // the call. The notices go first, each as its own text block.
  async call(tool: string, args: Record<string, unknown>, before?: () => Promise<string | undefined>): Promise<CallToolResult> {
    if (!this.proxy) return failure(`grayboard hasn't started in this ${this.client.options.harness} session yet`);
    // The process holding delivery owns this session's binding: a tools-only one rebinding it would fight the holder.
    if (this.held && (tool === "bind" || tool === "unbind")) return failure(`${this.held}; bind and unbind work from the process that holds delivery`);
    const after = before ? await before() : undefined;
    this.used = true;
    const result = await this.client.call(this.proxy, tool, args, this.o.sessionID);
    const shown = [...SLOTS.map(slot => this.notices.get(slot)), after].filter((n): n is string => !!n);
    this.notices.clear();
    return shown.length ? { ...result, content: [...shown.map(n => ({ type: "text" as const, text: `grayboard: ${n}` })), ...result.content] } : result;
  }

  tools(): NativeTool[] { return this.proxy?.tools() ?? hostTools(snapshotTools()); }

  // The server's instructions for this session. Rejects as the proxy does
  // (AccessExpired when only a sign-in can fetch them), and with NotStarted
  // before there is a connection.
  async instructions(): Promise<string | undefined> {
    if (!this.proxy) throw new NotStarted();
    return this.proxy.instructions(this.o.sessionID);
  }

  // pi's /grayboard resume, the plugin's unpause: a lock that couldn't be
  // opened is tried again; a running Controller restarts (single-flight).
  async resume(): Promise<void> {
    if (this.closed) return;
    if (this.error && !this.lock) { await this.take(); return; }
    await this.restart();
  }

  status(): RootStatus {
    return {
      ...(this.held ? { held: this.held } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.signedOut ? { signedOut: this.signedOut } : {}),
      ...(this.controller ? { controller: this.controller.status() } : {}),
    };
  }

  // A host notice shown once, with the next tool result; "first" before the
  // host's "last", both after the root's own.
  noticeOnce(text: string, position: "first" | "last"): void { this.notices.set(position, text); }

  // The one shutdown order. Nothing network-bound runs ahead of the lease's
  // release, which frees the name now rather than when the lease lapses: the
  // delivery lock the kernel frees on a kill, the lease it can't. The
  // Controller stops this session's run loop before its queue, so a start in
  // flight costs at most the request it is in. `carry` returns the name a
  // successor binds (pi's /new and /fork). Idempotent.
  shutdown(mode: "release" | "detach", o: { carry?: boolean } = {}): Promise<string | undefined> {
    return this.shutting ??= this.stop(mode, o);
  }
  private async stop(mode: "release" | "detach", o: { carry?: boolean }): Promise<string | undefined> {
    this.closed = true;
    this.watcher?.dispose();
    this.subscription?.dispose();
    this.waiter?.abort();
    const id = this.o.sessionID;
    let carried: string | undefined;
    if (this.controller) {
      carried = await this.controller.shutdown(id, mode, o).catch(error => { this.log(`couldn't release delivery: ${message(error)}`, "warning"); return undefined; });
    }
    // No Controller: a session whose calls bound it outside a lease (tools-only
    // by choice, or a delivery lock that couldn't be opened) ends what they
    // bound, and a start that took the lock but hasn't built its Controller
    // ends the session (a lease an earlier runtime kept). Never while another
    // process holds this session's delivery: that would end its session.
    else if (mode === "release" && (this.lock || (this.used && !this.held))) await this.client.endSession(id);
    await this.controller?.close().catch(error => this.log(`couldn't stop delivery: ${message(error)}`, "warning"));
    this.lock?.release();
    await this.starting;
    await this.restarting;
    if (this.proxy) await this.client.close(this.proxy);
    this.done = true;
    return carried;
  }
}
