import { createHash } from "node:crypto";
import type { Enrollment, HostPort } from "./port.js";
import { abortOf, InsufficientScope, LeaseUnavailable, listenCapacity, ServerUnreachable, SubscriberError, SubscriptionClosed, unreachable, Wire, type WireOptions } from "./wire.js";
import { AccessExpired, Refusal, RefreshInProgress, accessExpiry, admitPrefix, bindingOf, itemsOf, leaseOf, sameHeld, shortOf, stableID, validHeld, type BindingState, type Lease } from "./model.js";
import { AncestryError, SessionRoutes, type SessionPath } from "./sessions.js";
import { end, register, type Temporary } from "./children.js";
import { Diagnostics, DeliveryStopped, failureCode, failureMessage, type DiagnosticSink, type Operation, type Status } from "./diagnostics.js";
export type { Status } from "./diagnostics.js";
// Every root's pause message after a credential change (a login or logout in any process) starts with this.
export const DRIFTED = "Grayboard credential changed";

export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
export type ControllerOptions = {
  Transport?: typeof Wire;
  wait?: Wait;
  sink?: DiagnosticSink;
  // A name every new root binds before approval (OpenCode's plugin options).
  configured?: { name: string; create: boolean };
  // The host's own session-ID shape: restored diagnostics for such IDs skip the
  // active-root lookup (OpenCode passes `ses_…`).
  knownRoot?: RegExp;
  // A host that starts a turn for every item it admits (Claude Code): the lease withholds non-waking items
  // until a waking one carries them (#854), where the server knows the option.
  context?: false;
};
// A forwarded native tool call's outcome, as a host reports it to afterCall:
// the tool's parsed result object, or a failure.
export type CallOutcome = { status: "completed"; output: unknown } | { status: "error" };
// `admitted` holds `ownership:bind_gen:item` keys admitted but not yet
// receipted, across reconnects in this process: a receipt failure goes straight
// to the receipt on the next read instead of showing the item again. A key
// joins as soon as the host accepted the item, before the guard and receipt,
// so a receipt that fails (an outage, a lost lease, this Controller's own stop)
// never shows it twice. There's no renew between admission and receipt: the
// server's receipt checks the lease itself (#845). The item lasts through its
// receipt, so a lost lease there spends the item's attempt budget, not the
// recovery budget. An admitted key skips only the admission: the pre-admission
// renew still proves the current lease first, so a lease that can't renew
// never receipts (it spends the item's attempt budget instead). A new lease
// under another ownership or bind_gen has another key, so it admits the item
// again.
// `awaiting` marks a root paused on an expired host-rotated token whose
// recovery loop is live (#661); anything that takes the root clears it.
// `recovery` is that wait's backoff, kept until delivery is active again, so a
// recovery whose delivery expires again before it opens never starts over.
// `binding` counts the root's own native binds and unbinds between beforeCall
// and afterCall: the recovery never resumes under one, whose completion sets the holds.
type Root<E extends Enrollment> = { e: E; approval: E; epoch: number; paused: boolean; status: Status; admitted: Set<string>; abort?: AbortController; task?: Promise<void>; lease?: Lease; awaiting?: object; recovery?: { attempt: number; spent: number }; binding?: number; released?: number };
// Time left in `grace`: its own budget less what it spent, and never past the protected lease's deadline.
function graceLeft(grace: Grace): number {
  const lease = grace.lease?.();
  return Math.min(ROTATION_GRACE_MS - grace.spent, lease ? lease.expiresAt - LEASE_MARGIN_MS - Date.now() : Infinity);
}
// A renew's answer carries the lease's new deadline; anything else keeps the old one (it bounds only the grace).
function renewed(lease: Lease, answer: unknown) {
  const at = typeof answer === "object" && answer !== null ? (answer as { expiresAt?: unknown }).expiresAt : undefined;
  if (typeof at === "number" && Number.isFinite(at)) lease.expiresAt = at;
}
const ADMITTED_LIMIT = 100;
// Ancestry lookups `childRoot` keeps for sessions not (yet) routed.
const LOOKUPS = 1024;
// A host that rotates its own access token (OpenCode's native grant) stores
// the refresh at or just after expiry: up to ~1.5 s after the server closed
// the stream for it (#472). An `expired` token outside an outage is polled
// for up to ROTATION_GRACE_MS of elapsed time before it pauses. A root holding
// a lease also stops LEASE_MARGIN_MS before the lease's own `expiresAt` (kept
// from each renew, #481), so the reopen lands while the lease still holds its
// ownership whatever the server's TTL. `expiresAt` is the server's clock: the
// bound only shortens the grace, so a client clock behind the server's changes
// nothing, and one far ahead ends the grace early into the refresh wait (#661).
// Own-login adapters (pi, omp, Claude Code) never hit it: they
// refresh 60 s early and end a grant as `login_required` or `refresh_outcome_unknown`.
const ROTATION_POLL_MS = 500, ROTATION_GRACE_MS = 10_000, LEASE_MARGIN_MS = 2_000;
// Renews stay on the client's own clock: a cadence read from `expiresAt` would follow clock skew.
const RENEW_MS = 10_000;
// How long a listen swap (#1379) waits for the old stream's close: its local end is at once, but its
// `notifications/cancelled` POST has no timeout of its own, and a server that never answers it must not stall the swap.
const SWAP_CLOSE_MS = 1_000;
// Listen-cap refusals a swap's replacement listen retries (#1394): 250 ms doubling, 7.75 s in all, well inside the
// lease's 30 s TTL, which nothing renews meanwhile.
const SWAP_CAPACITY_RETRIES = 5;
// One rotation grace: `spent` charges each retry its poll plus the failed attempt's own time (a slow
// reconnect counts); `lease` is the ownership it protects, if any.
type Grace = { spent: number; lease?: () => Lease | undefined };
// Past the grace a root waits for the refresh (#661): it asks the host to
// refresh (`credential.refresh`, once per expiry), then re-checks the stored credential, a local read, on this backoff,
// for an hour of waits: after that the pause stands until a reload's restore. The outage retries (run loop and
// restore) ask the host the same way once the server answers with the expiry, and keep their own backoff (#916).
const RECOVERY_FIRST_MS = 1_000, RECOVERY_MAX_MS = 30_000, RECOVERY_BUDGET_MS = 60 * 60_000;
const UNREACHABLE_AT_RECOVER = "Server unreachable while recovering; retrying, approval retained";
const refreshingAtRecover = (harness: string) => `Token refresh in progress in another ${harness} process while recovering; retrying, approval retained`;
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
// The SDK wraps errors thrown while connecting (SdkError EraNegotiationFailed
// {cause}), so a scope refusal or a busy refresh can arrive nested.
function causeOf<T>(error: unknown, type: abstract new (...args: never[]) => T): T | undefined {
  for (let e = error, depth = 0; e && depth < 8; e = e instanceof Error ? e.cause : undefined, depth++) if (e instanceof type) return e;
  return undefined;
}
// A failure an older request's own fault may explain, so a newer request may not meet it (#1176): an outage or a
// deadline, however the SDK or a wire's own timeout signal surfaced it (a ServerUnreachable, an
// SdkError RequestTimeout or ConnectionClosed, a gateway status, a network code, an abort's TimeoutError), a token
// refresh another process held, or the server's `unbound` (the root's binding moved while it waited at the gate).
// A refusal (child_bound, child_registered_elsewhere, has_children, root_is_child, invalid_registration, each a
// SubscriberError with its own code), a malformed answer, or a sign-in's is the same for every request.
function transient(error: unknown): boolean {
  if (unreachable(error) || causeOf(error, RefreshInProgress)) return true;
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { name?: unknown }).name === "TimeoutError" || (e instanceof SubscriberError && e.code === "unbound")) return true;
  }
  return false;
}
// The admission target's identity when the host keeps no approval key.
function fingerprint(e: Enrollment) {
  const c = e.configuration;
  return createHash("sha256").update(JSON.stringify([e.version, e.sessionID, c.type, c.url, c.issuer, c.clientID, c.scope, c.configHash, e.held ?? []])).digest("hex");
}
// An address as a status line writes it: the name without its scope (its user's, or a team's).
const display = (address: string) => shortOf(address.slice(0, address.lastIndexOf("/")), address);

export class Controller<E extends Enrollment = Enrollment> {
  readonly routes = new SessionRoutes();
  private readonly lookups = new Map<string, SessionPath>();
  // A descendant's registration under its enrolled root (#567): shared while in flight, and once done kept only
  // while the root keeps its epoch and its lease's server ownership (whose end deletes child rows server-side).
  private readonly registered = new Map<string, { r: Root<E>; epoch: number; ownership?: number; settled: boolean; done: Promise<void> }>();
  readonly Transport: typeof Wire;
  protected roots = new Map<string, Root<E>>();
  private watches = new Map<string, { dispose(): Promise<void> }>();
  protected stopped = false;
  // Sessions a shutdown has begun for: treated like `stopped`, per session,
  // since one Controller may run several roots (OpenCode V2).
  private readonly ending = new Set<string>();
  // Aborted by close: ends a wait outside any root's run loop (a restore's rotation grace) and an
  // enroll's or prepare's wire (#1294). A subclass whose close waits on its own work first aborts it then.
  protected readonly closing = new AbortController();
  // Per session, aborted by its shutdown (which queues behind a start in flight): ends that session's
  // enroll and prepare wires, as close does every session's (#1294). Never a release's or session end's.
  private readonly ends = new Map<string, AbortController>();
  private endOf(sessionID: string) {
    let end = this.ends.get(sessionID);
    if (!end) this.ends.set(sessionID, end = new AbortController());
    return end;
  }
  private startStop(sessionID: string) { return AbortSignal.any([this.closing.signal, this.endOf(sessionID).signal]); }
  // A start that failed because close or the session's shutdown stopped it says so, with no failure code: its
  // error is that stop's abort, or the controller's own refusal of a stopping start, or (after close) an access
  // token the host is still rotating, which `rotated` rethrows when close cuts its grace short: not yet a
  // failure. Any other error that merely lands once the stop began (a sign-in refusal) keeps its code (#1309).
  private stoppedBy(sessionID: string, error: unknown) {
    if (!this.stopped && !this.ending.has(sessionID)) return false;
    return abortOf(error, this.closing.signal) || abortOf(error, this.endOf(sessionID).signal) || error instanceof Refusal && error.code === "paused"
      || this.stopped && accessExpiry(error)?.reason === "expired";
  }
  private drifted = false;
  private controls: Promise<unknown> = Promise.resolve();
  private state: Status;
  private readonly diagnostics: Diagnostics;
  private readonly place: string;
  private readonly wait: Wait;
  private readonly configured?: { name: string; create: boolean };
  private readonly context?: false;
  // Saved roots restore skipped because their session had ended: the next
  // save drops their records (`prune`). An edited record stays, and every
  // restore reports it, since it may be another location's (#660).
  private readonly skipped = new Set<string>();
  // Restore retries in flight (#424 6): close waits them out, so none writes after it.
  private readonly retries = new Set<Promise<void>>();
  constructor(readonly port: HostPort<E>, options: ControllerOptions = {}) {
    this.Transport = options.Transport ?? Wire;
    this.wait = options.wait ?? sleep;
    this.configured = options.configured;
    if (options.context === false) this.context = false;
    this.place = port.place();
    const idle = port.approval ? "Approve an active root; approval does not bind a name" : "No active root";
    this.state = { state: "unenrolled", message: idle, roots: [] };
    this.diagnostics = new Diagnostics(port.storage, options.sink, { idle, ...(options.knownRoot ? { knownRoot: options.knownRoot } : {}) });
  }
  private get hint() { return this.port.resumeHint; }
  status(): Status { return this.diagnostics.status(); }
  async flushDiagnostics() { await this.diagnostics.flush(); }
  private set(r: Root<E>, state: string, message: string, operation: Operation = "delivery", code?: string) {
    this.diagnostics.record({ state, message, operation, sessionID: r.e.sessionID, ...(r.e.held?.length ? { held: r.e.held } : {}), ...(r.lease ? { ownership: r.lease.ownership } : {}), ...(code ? { code } : {}) });
    r.status = { state, message, sessionID: r.e.sessionID, roots: [] };
  }
  protected failure(operation: Operation, error: unknown, r?: Root<E>) {
    this.diagnostics.record({ state: "degraded", message: `${operation} failed (${failureCode(error)})`, operation, ...(r ? { sessionID: r.e.sessionID, ...(r.e.held?.length ? { held: r.e.held } : {}), ...(r.lease ? { ownership: r.lease.ownership } : {}) } : {}), code: failureCode(error) });
  }
  protected record(input: Parameters<Diagnostics["record"]>[0]) { this.diagnostics.record(input); }
  private serial<T>(call: () => Promise<T>): Promise<T> {
    const result = this.controls.then(call, call);
    this.controls = result.catch(() => {});
    return result;
  }
  // The credential behind every root changed: pause them all until each is resumed.
  drift(message: string) {
    this.drifted = true;
    for (const r of this.roots.values()) {
      r.paused = true; r.awaiting = undefined; r.epoch++; r.abort?.abort(); this.set(r, "paused", message);
      void this.port.storage.set(`paused:${r.e.sessionID}`, true).catch(error => this.failure("latch_save", error, r));
    }
  }
  // The watch's and a guard's drift alike; hosts key on DRIFTED (pi's describe, a root's sink).
  private credentialChanged() { this.drift(`${DRIFTED}; ${this.hint}`); }
  // The port's refusal of a changed credential (Refusal "binding"), however a request surfaced it, while `live`
  // (the root that met it is still the current one): the watch's drift, seen before the watch's next tick, so
  // every root pauses with its message, not one with a generic failure (#1400). A replaced root's drifts nothing,
  // like a disposed watch. Says whether it drifted.
  private signInChanged(error: unknown, live: boolean) {
    if (!live || causeOf(error, Refusal)?.code !== "binding") return false;
    this.credentialChanged();
    return true;
  }
  private async path(sessionID: string) { return this.route(await this.port.ancestry(sessionID)); }
  private route(path: SessionPath) {
    this.routes.remember({ sessionID: path.root, root: path.root, via: [] });
    for (const [index, id] of path.via.entries()) this.routes.remember({ sessionID: id, root: path.root, via: path.via.slice(index + 1) });
    this.routes.remember(path);
    return path;
  }
  // The path of a descendant of an enrolled root that isn't paused, else undefined
  // (a root, a descendant of an unenrolled or paused root, a session whose
  // ancestry doesn't resolve). Ancestry resolves once per session; only a
  // failure resolves again. A lookup isn't a route: `routes` holds only sessions
  // the server knows (an `ended` one gets a `session_end`), so a lookup is kept
  // apart, for the most recent LOOKUPS sessions (#535).
  async childRoot(sessionID: string): Promise<SessionPath | undefined> {
    let path = this.routes.get(sessionID) ?? this.lookups.get(sessionID);
    if (!path) {
      if (this.routes.isEnded(sessionID)) return;
      try { path = await this.port.ancestry(sessionID); } catch { return; }
      if (this.routes.isEnded(sessionID) || this.routes.isEnded(path.root)) return;
      this.lookups.set(sessionID, path);
      if (this.lookups.size > LOOKUPS) this.lookups.delete(this.lookups.keys().next().value!);
    }
    const r = this.roots.get(path.root);
    return path.root !== sessionID && r && !r.paused ? path : undefined;
  }
  // A descendant registers under its root: before its first native call, and
  // before a native wire names it, which unregistered would start an ownership
  // of its own (#535). One that ended while registering may have sent its end
  // before this registration landed, so it ends the row it made. A refusal is
  // the root's `child_register` failure unless this is an instructions `fetch`,
  // which reports its own, without degrading the root. Under an enrolled root,
  // calls and fetches share a registration in flight; a done one serves while
  // the root keeps its epoch (a stop, pause or re-enroll moves it) and the
  // server ownership its lease names: any end of that ownership (a release, a
  // lapsed lease the run loop reopens, an idle sweep) deletes child rows (#567).
  async enlist(path: SessionPath, fetch = false): Promise<void> {
    const r = this.roots.get(path.root), live = !!r && !r.paused, releases = r?.released ?? 0, epoch = r?.epoch;
    const e = r?.e ?? await this.port.credential.capture(path.root);
    const call: Temporary = (sessionID, c) => this.temporary(e, c, sessionID);
    const shared = () => {
      const known = r && this.registered.get(path.sessionID);
      return known && known.r === r && known.epoch === r.epoch && (!known.settled || known.ownership !== undefined && known.ownership === r.lease?.ownership) ? known.done : undefined;
    };
    const start = () => {
      const started = register(call, { root: path.root, via: path.via, child: path.sessionID });
      if (r) {
        const entry = { r, epoch: r.epoch, ...(r.lease ? { ownership: r.lease.ownership } : {}), settled: false, done: started };
        this.registered.set(path.sessionID, entry);
        if (this.registered.size > LOOKUPS) this.registered.delete(this.registered.keys().next().value!);
        started.then(() => { entry.settled = true; }, () => {});
      }
      started.catch(() => { if (this.registered.get(path.sessionID)?.done === started) this.registered.delete(path.sessionID); });
      return started;
    };
    // A joined registration that fails may have failed on an older request's deadline (one held at the bind
    // gate, its 10s spent before this call began): this call then registers once on its own, as it would have
    // unshared, joining instead any newer one a peer started first (#567). Only on a failure that request's own
    // fault may explain (`transient`: an outage, a deadline, a busy refresh, `unbound`); a refusal or a sign-in
    // would refuse the retry too, so it stands (#1176). And only while nothing it registers under has moved
    // since it began: a root stopped, paused, re-enrolled or ended, or a child ended, would have the retry
    // start an ownership nothing then ends, so the joined failure stands.
    const unmoved = () => !this.stopped && !this.routes.isEnded(path.sessionID) && !this.routes.isEnded(path.root)
      && this.roots.get(path.root) === r && !!r && !r.paused && r.epoch === epoch;
    let done = shared(), joined = !!done;
    for (;;) {
      done ??= start();
      const error = await done.then(() => undefined, (error: unknown) => ({ error }));
      if (!error) break;
      if (joined && transient(error.error) && unmoved()) { joined = false; done = shared(); continue; }
      if (!fetch) this.failure("child_register", error.error, r);
      throw error.error;
    }
    if (this.routes.isEnded(path.sessionID) || this.routes.isEnded(path.root)) {
      await end(call, { child: path.sessionID }).catch(error => this.failure("child_end", error, r));
      throw new AncestryError("Grayboard session ended during registration");
    }
    // A fetch whose root released its ownership while it registered: the release may have landed first, and
    // the registration then started the root's key a new ownership. A root still paused ends it again, with
    // the child's row; one a re-enroll replaced, or a resume restarted, owns its key, so its rows stand (#567).
    if (fetch && live && (this.roots.get(path.root) !== r || (r!.released ?? 0) !== releases)) {
      if (this.registered.get(path.sessionID)?.done === done) this.registered.delete(path.sessionID);
      if (this.roots.get(path.root) === r && r!.paused) {
        await end(call, { child: path.sessionID }).catch(error => this.failure("child_end", error, r));
        await end(call, { child: path.root }).catch(error => this.failure("session_end", error, r));
      }
      throw new AncestryError("Grayboard root paused during registration");
    }
    this.routes.remember(path);
  }
  protected async activeRoot(sessionID: string) {
    const path = await this.path(sessionID);
    if (path.root !== sessionID) throw new Refusal("root", "An active top-level root is required");
  }
  // Remembered holds and admission-target checks key on the approval (OpenCode)
  // or, with an adapter-owned grant, on the grant's configuration.
  private approvalKey(e: E) { return this.port.approval ? this.port.approval.key(e) : e.configuration.configHash; }
  private key(e: E) { return this.port.approval ? this.port.approval.key(e) : fingerprint(e); }
  private async remembered(sessionID: string, approval: E): Promise<string[] | undefined> {
    const remembered = await this.port.storage.get(`rememberedHeld:${sessionID}`);
    const held = remembered && typeof remembered === "object" ? Object.getOwnPropertyDescriptor(remembered, "held")?.value : undefined;
    const key = remembered && typeof remembered === "object" ? Object.getOwnPropertyDescriptor(remembered, "approval")?.value : undefined;
    return key === this.approvalKey(approval) && validHeld(held) && held.length ? held : undefined;
  }
  private async save(r: Root<E>, enabled: boolean) {
    if (!this.port.approval) return;
    await this.activeRoot(r.e.sessionID);
    await this.port.approval.save(r.e, r.approval, enabled);
    await this.port.storage.set(`paused:${r.e.sessionID}`, !enabled);
    this.skipped.delete(r.e.sessionID);
    await this.prune();
  }
  // Drops the saved records of roots restore skipped as ended, each only while
  // its session still doesn't resolve: another location may enroll it again
  // after this one's restore (#660). A failed drop never fails the save.
  private async prune() {
    for (const id of this.skipped) {
      this.skipped.delete(id);
      try { await this.activeRoot(id); continue; } catch {}
      await this.port.approval!.drop(id).catch(error => this.failure("restore", error));
    }
  }
  private async guard(r: Root<E>, epoch: number, signal: AbortSignal) {
    const e = r.e, key = this.key(e);
    const current = () => this.port.place() === this.place && !this.stopped && !this.ending.has(e.sessionID) && !this.drifted && !r.paused && !signal.aborted && r.epoch === epoch && this.roots.get(e.sessionID) === r && this.key(r.e) === key;
    const check = () => { if (!current()) throw new Refusal("paused", "Admission target changed"); };
    check();
    // The port's check sees a changed credential (Refusal "binding") before the
    // watch's next tick when the server acts first: a revoked grant closes the
    // run loop's stream at once. That is the watch's drift, so every root
    // pauses with its message, not this one alone with a generic failure; a
    // guard whose root was replaced meanwhile drifts nothing, like a disposed watch.
    await this.port.credential.check(e).catch(error => { this.signInChanged(error, current()); throw error; });
    await this.activeRoot(e.sessionID);
    if (this.port.approval && !await this.port.approval.approved(e, r.approval)) { r.paused = true; throw new Refusal("root", `Root approval changed; ${this.hint}`); }
    check();
  }
  private wireOptions(e: E): WireOptions {
    return { url: e.configuration.url, sessionKey: this.port.sessionKey, client: this.port.client, ...(this.port.delivery ? { delivery: this.port.delivery } : {}), ...(this.port.launcher ? { launcher: true as const } : {}), ...(this.port.facts ? { facts: (id: string) => this.port.facts!(id) } : {}), ...(this.port.suggested ? { suggested: (id: string) => this.port.suggested!(id) } : {}) };
  }
  private async wire(e: E, sessionID = e.sessionID, signal = AbortSignal.timeout(10_000), beforeRetry?: () => Promise<void>) {
    let current: string | undefined;
    const wire = new this.Transport(this.wireOptions(e), {
      token: async () => (current = await this.port.credential.token(e)),
      onUnauthorized: async () => this.port.credential.unauthorized(e, current ?? ""),
    }, signal, sessionID, beforeRetry);
    await wire.connect();
    return wire;
  }
  // `stop` ends the wire before its timeout: close, for a start's wire; a release's or session end's has none.
  private async temporary<T>(e: E, call: (wire: Wire) => Promise<T>, sessionID = e.sessionID, stop?: AbortSignal) {
    const wire = await this.wire(e, sessionID, stop && AbortSignal.any([AbortSignal.timeout(10_000), stop]));
    try { return await call(wire); } finally { await wire.close().catch(error => this.failure("wire_close", error)); }
  }
  // A start's failure that only a sign-in (or, in static mode, a new run) fixes pauses its root, as the run loop's
  // and restore's do (#1312); `expired`, a token the host rotates itself, isn't one.
  private signedOut(error: unknown) { const e = this.expired(error); return e instanceof AccessExpired && e.reason !== "expired"; }
  // A 403 insufficient_scope needs a new sign-in exactly like an ended grant;
  // a refresh another process holds is retried, however deep the SDK wrapped it.
  private expired(error: unknown) {
    return accessExpiry(error) ?? (causeOf(error, InsufficientScope) ? new AccessExpired(this.port.harness, this.port.loginAction, "login_required") : causeOf(error, RefreshInProgress) ?? error);
  }
  // A check a disposed watch already had in flight drifts nothing: the root it
  // watched was replaced (a resume or enroll unwatches before the new root),
  // and the new root's own watch sees any later change.
  private async watch(e: E) {
    let live = true;
    const watch = await this.port.credential.watch(e, () => { if (live) this.credentialChanged(); });
    this.watches.set(e.sessionID, { dispose: async () => { live = false; await watch.dispose(); } });
  }
  private async unwatch(sessionID: string) {
    if (this.drifted) {
      for (const watch of this.watches.values()) await watch.dispose();
      this.watches.clear();
    }
    await this.watches.get(sessionID)?.dispose(); this.watches.delete(sessionID);
  }
  // `names`: holds to bind now (each added to the root's others); none enrolls without binding.
  async enroll(sessionID: string, names: readonly string[] = [], create = false) { return this.serial(async () => {
    if (this.stopped || this.ending.has(sessionID)) throw new Refusal("paused", "Grayboard is stopping");
    await this.activeRoot(sessionID);
    await this.unwatch(sessionID);
    const previous = this.roots.get(sessionID);
    if (previous) await this.stop(previous);
    const captured = await this.port.credential.capture(sessionID);
    const e: E = { ...captured, ...(previous?.e.held?.length ? { held: previous.e.held } : {}) };
    const r: Root<E> = { e, approval: structuredClone(e), epoch: (previous?.epoch ?? 0) + 1, paused: false, status: this.state, admitted: previous?.admitted ?? new Set() };
    this.roots.set(sessionID, r); this.drifted = false;
    await this.save(r, true);
    await this.watch(e);
    this.set(r, "approved", "Root approved; bind a name to receive deliveries");
    // Past the binds, a failure is prepare's: the server holds every name (#544 item 2).
    let bound = false;
    try {
      if (names.length) {
        const epoch = r.epoch, signal = new AbortController().signal;
        await this.temporary(e, async w => {
          await this.guard(r, epoch, signal);
          for (const name of names) await w.call("bind", { name, create, where: this.port.place() });
          await this.guard(r, epoch, signal);
        }, sessionID, this.startStop(sessionID));
        bound = true;
      }
      await this.rotated({ spent: 0 }, () => this.prepare(r, !!previous?.paused && !names.length));
    } catch (error) {
      // A drift during it (a guard saw the change) already said why every root paused.
      const what = this.port.approval ? (r.paused ? "Root approval unavailable" : "Root approval saved") : (r.paused ? "Root paused" : "Root enrolled");
      const stopped = this.stoppedBy(sessionID, error);
      if (!stopped) this.signInChanged(error, this.roots.get(sessionID) === r);
      // Its message keeps what the enrollment did; the sign-out is its cause.
      if (!stopped && this.signedOut(error)) r.paused = true;
      if (!this.drifted) this.set(r, r.paused ? "paused" : "approved", `${what}; ${stopped ? "stopped before delivery opened" : failureMessage(this.expired(error), this.hint)}`, bound ? "prepare" : "enroll", stopped ? undefined : failureCode(this.expired(error)));
    }
    await this.diagnostics.flush();
    return { ...r.status, roots: this.status().roots };
  }); }
  // Start a root without a human enrollment: its remembered name rebinds with
  // create:false. An approval host needs that root's saved, enabled approval.
  async resume(sessionID: string) { return this.serial(async () => {
    if (this.stopped || this.ending.has(sessionID)) throw new Refusal("paused", "Grayboard is stopping");
    await this.activeRoot(sessionID);
    await this.unwatch(sessionID);
    const previous = this.roots.get(sessionID);
    if (previous) await this.stop(previous);
    const approval = await this.approvalFor(sessionID);
    // A new grant (possibly another account) never inherits the old holds.
    const held = await this.remembered(sessionID, approval) ?? (previous && this.approvalKey(previous.approval) === this.approvalKey(approval) ? previous.e.held : undefined);
    const r: Root<E> = { e: { ...approval, ...(held?.length ? { held } : {}) }, approval: structuredClone(approval), epoch: (previous?.epoch ?? 0) + 1, paused: false, status: this.state, admitted: previous?.admitted ?? new Set() };
    this.roots.set(sessionID, r); this.drifted = false;
    await this.watch(r.e);
    this.set(r, "approved", held?.length ? `Resuming ${this.names(r.e)}` : "Root approved; bind a name to receive deliveries");
    try { await this.rotated({ spent: 0 }, () => this.prepare(r, true)); }
    catch (caught) {
      const error = this.expired(caught);
      // A host that restarted during a server outage (an upgrade) resumes its root here: retry it on the
      // outage backoff, as a saved root's restore does, rather than leave it dark until the next start (#895).
      if ((error instanceof ServerUnreachable || error instanceof RefreshInProgress) && this.restorable(r, r.epoch)) {
        this.retrying(r, error);
        this.retryRestore(r);
      } else if (!this.stoppedBy(sessionID, error) && this.signInChanged(error, this.roots.get(sessionID) === r)) {
        // The drift said why every root paused.
      } else if (!this.drifted) {
        const stopped = this.stoppedBy(sessionID, error);
        if (!stopped && this.signedOut(error)) r.paused = true;
        this.set(r, r.paused ? "paused" : "approved", stopped ? "Stopped before delivery opened" : failureMessage(error, this.hint), "enroll", stopped ? undefined : failureCode(error));
      }
    }
    await this.diagnostics.flush();
    return { ...r.status, roots: this.status().roots };
  }); }
  // The approval a root of `sessionID` starts under now: its saved, enabled
  // approval on an approval host, else the current credential.
  private async approvalFor(sessionID: string): Promise<E> {
    if (!this.port.approval) return this.port.credential.capture(sessionID);
    const saved = (await this.port.approval.saved()).find(s => s.sessionID === sessionID);
    if (!saved?.approval || !saved.enabled) throw new Refusal("root", `No saved approval for this root; ${this.hint}`);
    await this.port.credential.check(saved.approval);
    return saved.approval;
  }
  // The holds a successor of `sessionID` binds (pi's /new and /fork): the holds
  // a resume of it would rebind now (remembered, else its live root's, under
  // the current approval only), so a hold a new sign-in dropped never
  // carries. Undefined when there are none or they can't be read (signed out).
  async carried(sessionID: string): Promise<string[] | undefined> {
    const back = await this.takeBack(sessionID);
    return back === "unreadable" ? undefined : back;
  }
  // carried()'s holds for a start (#544 item 1): "unreadable" when the
  // remembered holds couldn't be read (a storage error) and no live root
  // answers, so the start binds nothing over them.
  async takeBack(sessionID: string): Promise<string[] | "unreadable" | undefined> {
    let approval: E;
    try { approval = await this.approvalFor(sessionID); } catch { return undefined; }
    const live = this.roots.get(sessionID);
    const held = live && this.approvalKey(live.approval) === this.approvalKey(approval) && live.e.held?.length ? live.e.held : undefined;
    try { return await this.remembered(sessionID, approval) ?? held; } catch { return held ?? "unreadable"; }
  }
  // A root's holds as its user writes them, for a status line.
  private names(e: E) { return (e.held ?? []).map(display).join(", "); }
  // A whoami's holds the server took (#453), for the status line it sets.
  private lostNote(current: BindingState) { return current.alias_lost?.length ? ` (lost ${current.alias_lost.map(l => `${display(l.alias)}: ${l.reason}`).join("; ")})` : ""; }
  // Drops the holds a whoami says the server took (#453) from those the root expects, durably, so neither the
  // run loop nor a resume binds them again and the rest keep receiving. Any other change still pauses.
  // The server reports them until the next delivery_open, so a repeat is a no-op; one held again isn't lost.
  private async dropLost(r: Root<E>, current: BindingState) {
    const lost = new Set(current.alias_lost?.map(l => l.alias).filter(address => !current.held.includes(address)));
    const kept = r.e.held?.filter(address => !lost.has(address));
    if (!kept || kept.length === r.e.held!.length) return false;
    r.e = { ...r.e, held: kept };
    await this.port.storage.set(`rememberedHeld:${r.e.sessionID}`, { approval: this.approvalKey(r.approval), held: kept });
    return true;
  }
  // Binds the remembered holds `have` lacks (all of them after an ended ownership, the missing ones after a partial
  // loss). `tolerant` (a resume's prepare): a hold now refused (revoked, taken, deleted) is skipped and recorded, so
  // it doesn't keep the others from resuming (a team the user left reads as missing, not_found, #1020), and the refusals are returned for the caller to raise if nothing ends
  // up held, or record if something did; the run loop, which must end up holding exactly `held`, and anything else (sign-in, outage) throws.
  private async bindAll(r: Root<E>, wire: Wire, held: readonly string[], have: readonly string[], tolerant = false) {
    const refused: SubscriberError[] = [];
    for (const address of held) {
      if (have.includes(address)) continue;
      try { await wire.call("bind", { name: address, create: false, where: this.port.place() }); }
      catch (error) {
        if (!(tolerant && error instanceof SubscriberError && ["alias_held", "identity_unknown", "forbidden", "not_found"].includes(error.code))) throw error;
        refused.push(error);
      }
    }
    return refused;
  }
  private async prepare(r: Root<E>, resume = false, waitForStart = false) {
    const epoch = r.epoch, signal = new AbortController().signal;
    // A shutdown that began while this start waited (on the approval, the
    // watch) refuses it before it connects.
    if (this.stopped || this.ending.has(r.e.sessionID)) throw new Refusal("paused", "Grayboard is stopping");
    await this.temporary(r.e, async wire => {
      await this.guard(r, epoch, signal);
      let current = bindingOf(await wire.call("whoami"));
      await this.guard(r, epoch, signal);
      if (await this.dropLost(r, current)) await this.guard(r, epoch, signal);
      if (r.e.held?.some(address => !current.held.includes(address)) && resume) {
        const refused = await this.bindAll(r, wire, r.e.held, current.held, true);
        await this.guard(r, epoch, signal);
        current = bindingOf(await wire.call("whoami"));
        await this.guard(r, epoch, signal);
        if (refused[0] && !current.held.length) throw refused[0];
        for (const error of refused) this.diagnostics.record({ state: "degraded", message: `Could not resume a held name (${error.code}); it is no longer held`, operation: "prepare", sessionID: r.e.sessionID, code: error.code });
      }
      if (r.epoch !== epoch || r.paused || this.stopped) return;
      if (!current.held.length) { this.set(r, "unbound", `Root approved, unbound${this.lostNote(current)}; bind(name) to take one`); return; }
      await this.guard(r, epoch, signal);
      r.e = { ...r.e, held: current.held };
      await this.port.storage.set(`rememberedHeld:${r.e.sessionID}`, { approval: this.approvalKey(r.approval), held: current.held });
      await this.guard(r, epoch, signal);
      if (r.epoch === epoch && !r.paused && !this.stopped) {
        this.set(r, "approved", `Bound ${this.names(r.e)}${this.lostNote(current)}; opening delivery`, "prepare");
        const started = this.start(r);
        if (waitForStart) await started;
      }
    }, r.e.sessionID, this.startStop(r.e.sessionID));
  }
  private start(r: Root<E>) {
    if (r.task || r.paused || this.stopped || this.ending.has(r.e.sessionID)) return;
    const epoch = r.epoch, e = structuredClone(r.e), abort = r.abort = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    r.task = this.run(r, e, epoch, abort.signal, ready).catch(caught => {
      const error = this.expired(caught);
      if (abort.signal.aborted) return;
      if (this.signInChanged(error, this.roots.get(r.e.sessionID) === r && r.epoch === epoch)) return;
      r.paused = true;
      if (error instanceof AccessExpired && error.reason === "expired") this.awaitRefresh(r, "subscriber");
      else this.set(r, "paused", failureMessage(error, this.hint), "subscriber", failureCode(error));
    }).finally(ready);
    return started;
  }
  private async run(r: Root<E>, e: E, epoch: number, signal: AbortSignal, ready: () => void) {
    // recoveries counts lease losses outside an item (inbox read, renew) since
    // the lease last proved healthy; a loss inside an item spends that item's attempts.
    // unreachable counts consecutive outage retries (the server down, the
    // subscription closed under it, or another process holding the refresh
    // lock): they back off without limit and never spend failures, since
    // leases don't count server downtime (#423) and a busy refresh is never
    // taken over; only a healthy lease (renew or receipt) resets the backoff.
    // outage is set only by a failed request: the server also closes the
    // stream when access expires, and that expiry waits only for the host's
    // rotation (`grace`: the one started since the last whoami succeeded).
    let failures = 0, recoveries = 0, throttles = 0, unreachable = 0, outage = false, inItem = false, reidentified = false;
    let grace: Grace = { spent: 0, lease: () => r.lease };
    let pendingItem: string | undefined;
    const attempts = new Map<string, number>();
    while (!signal.aborted && failures < 8) {
      let wire: Wire | undefined;
      // Only an attempt that never reached its whoami charges its own time: past it, the grace restarts, and a
      // healthy subscription's length is no part of the next expiry's grace (#481).
      const began = performance.now(), attempt = grace;
      try {
        await this.guard(r, epoch, signal);
        wire = await this.wire(e, e.sessionID, signal, () => this.guard(r, epoch, signal));
        await this.guard(r, epoch, signal);
        const current = bindingOf(await wire.call("whoami"));
        outage = false; grace = { spent: 0, lease: () => r.lease };
        await this.guard(r, epoch, signal);
        if (await this.dropLost(r, current)) {
          e = { ...e, held: r.e.held };
          await this.guard(r, epoch, signal);
          if (!e.held?.length) { r.lease = undefined; this.set(r, "unbound", `Root approved, unbound${this.lostNote(current)}; bind(name) to take one`); return; }
        }
        if (!current.held.length) {
          r.lease = undefined;
          await this.bindAll(r, wire, e.held ?? [], []);
          await this.guard(r, epoch, signal);
        } else if (!sameHeld(current.held, e.held)) throw new Refusal("identity", `Root holds changed without a native completion; ${this.hint}`);
        let lease: Lease;
        try { lease = leaseOf(await wire.call("delivery_open", this.context === false && await wire.takes("delivery_open", "context") ? { context: false } : {}), e); }
        catch (error) {
          // The primary revoked between this whoami and delivery_open (#453) gives a lease naming another
          // identity: the next iteration's whoami reports the loss. Once; a second refusal pauses.
          if (!(error instanceof Refusal) || reidentified) throw error;
          reidentified = true;
          continue;
        }
        reidentified = false;
        await this.guard(r, epoch, signal);
        r.lease = lease; wire.capability = lease.capability; r.recovery = undefined;
        this.set(r, "active", `Subscribed as ${this.names(e)}${this.lostNote(current)}; receipts follow durable root admission`);
        ready();
        let dirty = true, wake: (() => void) | undefined, closed = false, tokenChanged = false;
        wire.client.setNotificationHandler("notifications/resources/updated", () => { dirty = true; wake?.(); });
        let subscription: Awaited<ReturnType<Wire["listen"]>> | undefined;
        // Only the current listen's end counts: a replaced one's close is ours.
        const listen = async () => {
          const opened = subscription = await wire!.listen();
          const ended = () => { if (subscription === opened) { closed = true; wake?.(); } };
          void opened.closed.then(ended, ended);
        };
        // An own-login provider's token changed (#1379): the server closes a listen at the expiry of the token it
        // was opened with, so it is replaced now, under this lease. Heard from before the first listen opens, so a
        // refresh during that open replaces it once it's open; repeated changes replace it once.
        const rotation = this.port.credential.rotated?.(e, () => { tokenChanged = true; wake?.(); });
        let renewal = Date.now() + RENEW_MS;
        try {
          await listen();
          while (!signal.aborted) {
            // Close, then open: listens count against a per-user cap, and every session on one credential renews
            // at once. Hints don't consume and the server keeps the inbox position, so the re-read finds whatever
            // arrived in between. Not an outage: no whoami, no delivery_open, no backoff; a failed open is an
            // ordinary reopen, but for the listen cap's race below. Ahead of `closed`: an old stream the expiry already
            // closed is replaced the same way. The old stream ends locally at once (its `closed` settles, which the
            // `subscription === opened` guard ignores, and its request is aborted); its cancel POST gets
            // SWAP_CLOSE_MS, then runs on unawaited.
            if (tokenChanged) {
              tokenChanged = false;
              const old = subscription;
              subscription = undefined; closed = false;
              if (old) {
                const bound = new AbortController();
                const closing = old.close().catch(error => this.failure("subscription_close", error, r));
                await Promise.race([closing, this.wait(SWAP_CLOSE_MS, AbortSignal.any([signal, bound.signal]))]);
                bound.abort();
              }
              await this.guard(r, epoch, signal);
              // The server frees the old slot when it notices the dropped request, so at the listen cap (per-user or global) the
              // new listen can race it and be refused (#1394): that refusal alone is retried here, on a short
              // backoff under the same lease, and spends no failure. Past SWAP_CAPACITY_RETRIES it is an ordinary
              // reopen (one failure), as a listen the cap refuses outside a swap is.
              for (let retry = 0; ; retry++) {
                try { await listen(); break; }
                catch (error) { if (signal.aborted || retry >= SWAP_CAPACITY_RETRIES || !listenCapacity(error)) throw error; }
                await this.wait(Math.min(4000, 250 * 2 ** retry), signal);
                await this.guard(r, epoch, signal);
              }
              dirty = true;
            }
            if (dirty) {
              dirty = false;
              const items = itemsOf(await wire.read("grayboard://inbox"));
              await admitPrefix(items, async item => {
                inItem = true;
                pendingItem = /^(direct|push):[1-9][0-9]*$/.test(item.id) ? item.id : `item#${createHash("sha256").update(item.id).digest("hex").slice(0, 12)}`;
                const count = (attempts.get(item.id) ?? 0) + 1;
                if (count > 8) throw new DeliveryStopped(pendingItem);
                attempts.set(item.id, count);
                if (item.ownership !== lease.ownership || item.bind_gen !== lease.bind_gen || item.address !== undefined && !e.held?.includes(item.address)) throw new Refusal("identity", "Issued batch does not match the immutable lease");
                await this.guard(r, epoch, signal);
                const key = `${item.ownership}:${item.bind_gen}:${item.id}`;
                renewed(lease, await wire!.call("delivery_renew"));
                await this.guard(r, epoch, signal);
                if (r.admitted.has(key)) return;
                await this.port.admit(e, item, stableID(e, item, lease.identity), lease.identity, signal);
                r.admitted.add(key);
                while (r.admitted.size > ADMITTED_LIMIT) r.admitted.delete(r.admitted.values().next().value!);
                await this.guard(r, epoch, signal);
              }, async ids => {
                await this.guard(r, epoch, signal);
                await wire!.call("delivery_receipt", { ids });
                inItem = false;
                for (const id of ids) { attempts.delete(id); r.admitted.delete(`${lease.ownership}:${lease.bind_gen}:${id}`); }
                failures = 0; throttles = 0; recoveries = 0; unreachable = 0; pendingItem = undefined;
                try { this.port.receipted?.(e, ids); } catch (error) { this.failure("receipt_hook", error, r); }
              });
              if (items.length === 100) dirty = true;
            }
            if (closed) throw new SubscriptionClosed();
            if (Date.now() >= renewal) {
              await this.guard(r, epoch, signal); renewed(lease, await wire.call("delivery_renew"));
              renewal = Date.now() + RENEW_MS; dirty = true; recoveries = 0; unreachable = 0;
            }
            if (dirty || tokenChanged) continue;
            const timer = new AbortController();
            await Promise.race([sleep(1000, AbortSignal.any([signal, timer.signal])), new Promise<void>(resolve => { wake = resolve; })]);
            wake = undefined; timer.abort();
          }
        } finally {
          rotation?.dispose();
          await subscription?.close().catch(error => this.failure("subscription_close", error, r));
        }
      } catch (caught) {
        if (signal.aborted) break;
        const error = this.expired(caught);
        // An access token that expires mid-outage couldn't be refreshed either:
        // keep retrying rather than pausing, and ask the host to refresh (#916).
        if (error instanceof ServerUnreachable || error instanceof SubscriptionClosed || error instanceof RefreshInProgress || (error instanceof AccessExpired && error.reason === "expired" && outage)) {
          if (error instanceof ServerUnreachable) outage = true;
          this.set(r, "retrying", error instanceof ServerUnreachable ? "Server unreachable; retrying, approval retained"
            : error instanceof SubscriptionClosed ? "Subscription closed; reopening, approval retained"
            : error instanceof RefreshInProgress ? `Token refresh in progress in another ${this.port.harness} process; retrying, approval retained`
            : `Access expired during a server outage; retrying until ${this.port.harness} refreshes it`, "reopen", failureCode(error));
          ready();
          // The expiry came back from the server, so it's reachable again: ask the host to refresh now,
          // as the recovery does; the port acts at most once per expiry.
          // A failed request is recorded apart from the root (a drift's pause record must stand).
          if (error instanceof AccessExpired && this.port.credential.refresh) await this.port.credential.refresh(e).catch(failure => this.failure("reopen", failure));
          await this.wait(Math.min(8000, 250 * 2 ** ++unreachable), signal);
          continue;
        }
        if (error instanceof AccessExpired && error.reason === "expired" && graceLeft(grace) > 0) {
          grace.spent += (grace === attempt ? performance.now() - began : 0) + ROTATION_POLL_MS;
          this.set(r, "retrying", `Access expired; waiting for ${this.port.harness} to refresh it, approval retained`, "reopen", failureCode(error));
          ready();
          await this.wait(ROTATION_POLL_MS, signal);
          continue;
        }
        if (error instanceof Refusal || error instanceof DeliveryStopped) throw error;
        if (error instanceof LeaseUnavailable) {
          r.lease = undefined;
          if (!inItem && ++recoveries > 3) throw new Refusal("paused", `Lease recovery limit reached; ${this.hint}`);
        } else if (error instanceof SubscriberError && ["alias_held", "identity_unknown"].includes(error.code)) throw error;
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
        ready();
        if (wire?.admissionRetryAfterMs) {
          if (++throttles > 8) throw new Error(`Admission retry limit reached; ${this.hint}`);
          await this.wait(Math.max(wire.admissionRetryAfterMs, Math.min(8000, 500 * 2 ** throttles)), signal);
        } else await this.wait(Math.min(8000, 250 * 2 ** failures), signal);
      } finally { inItem = false; await wire?.close().catch(error => this.failure("wire_close", error, r)); }
    }
    if (failures >= 8) throw new DeliveryStopped(pendingItem);
  }
  private async stop(r: Root<E>) { r.epoch++; r.abort?.abort(); await r.task; r.task = undefined; r.abort = undefined; }
  private async release(r: Root<E>) {
    const lease = r.lease; r.lease = undefined; r.released = (r.released ?? 0) + 1;
    await this.temporary(r.e, async wire => {
      if (lease) { wire.capability = lease.capability; await wire.call("delivery_release").catch(error => this.failure("delivery_release", error, r)); }
      await wire.call("session_end");
    });
  }
  async pause(message = `Ownership ended; ${this.hint}`) { return this.serial(async () => {
    for (const r of this.roots.values()) {
      r.paused = true; r.awaiting = undefined; await this.stop(r);
      await this.release(r).catch(error => this.failure("session_end", error, r));
      await this.save(r, false).catch(error => this.failure("pause_save", error, r));
      this.set(r, "paused", message);
    }
    return this.status();
  }); }
  // Stop one root for good: "release" ends its ownership (frees the name);
  // "detach" keeps the lease for an in-process reload that reopens within its TTL.
  // Before entering the queue it marks the session ending and aborts its run
  // loop, so the release isn't queued behind a start in flight: that start
  // refuses at its next check (guard, start, enroll, resume), costing at most
  // the request it is already in. With `carry`, the name a successor binds is
  // read in the queue after the stop and before the release, so a rebind that
  // landed is visible and no admit can land during the read. A "release" with
  // no live root (its start never reached the queue, as a /reload's resume in
  // flight) still ends the session, freeing a lease an earlier runtime kept;
  // one that fails, a sign-out included, is recorded: the lease then stays
  // until it lapses.
  shutdown(sessionID: string, mode: "release" | "detach", o: { carry?: boolean } = {}): Promise<string[] | undefined> {
    this.ending.add(sessionID); this.endOf(sessionID).abort();
    this.roots.get(sessionID)?.abort?.abort();
    return this.serial(async () => {
      const r = this.roots.get(sessionID);
      if (r) { r.paused = true; r.awaiting = undefined; await this.stop(r); }
      const carried = o.carry ? await this.carried(sessionID) : undefined;
      if (!r) {
        if (mode === "release") await this.endUnowned(sessionID);
        return carried;
      }
      await this.watches.get(sessionID)?.dispose().catch(error => this.failure("watch_dispose", error, r)); this.watches.delete(sessionID);
      if (mode === "release") await this.release(r).catch(error => this.failure("session_end", error, r));
      this.set(r, "paused", mode === "release" ? "Session shut down; ownership released" : "Session detached; lease retained for reload", "session_end");
      this.roots.delete(sessionID);
      return carried;
    });
  }
  private async endUnowned(sessionID: string) {
    try {
      const e = await this.port.credential.capture(sessionID);
      await this.temporary(e, wire => wire.call("session_end"));
    } catch (error) {
      this.diagnostics.record({ state: "degraded", message: `session_end failed (${failureCode(error)})`, operation: "session_end", sessionID, code: failureCode(error) });
    }
  }
  // Runs `call`, retrying it while the host's access token reads `expired`, one
  // poll per attempt, for as long as `grace` has time left (#472).
  private async rotated<T>(grace: Grace, call: () => Promise<T>): Promise<T> {
    for (;;) {
      const began = performance.now();
      try { return await call(); }
      catch (error) {
        if (this.stopped || accessExpiry(error)?.reason !== "expired" || graceLeft(grace) <= 0) throw error;
        grace.spent += performance.now() - began + ROTATION_POLL_MS;
        await this.wait(ROTATION_POLL_MS, this.closing.signal);
        // A close that ended the wait refuses the retry: nothing would dispose what it registers.
        if (this.stopped) throw error;
      }
    }
  }
  async restore() {
    await this.diagnostics.restore(async id => { await this.activeRoot(id); return true; });
    if (!this.port.approval) return;
    // One rotation grace for the whole pass: the roots share the host's credential.
    const grace: Grace = { spent: 0 };
    for (const saved of await this.port.approval.saved()) {
      const id = saved.sessionID;
      if (this.stopped) continue;
      try {
        try { await this.activeRoot(id); }
        catch { this.skipped.add(id); continue; }
        if (!saved.approval) throw new Refusal("root", `Saved enrollment was edited; ${this.hint}`);
        const e = saved.approval;
        const previous = this.status().roots.find(record => record.sessionID === id);
        // A pause for an access token the host rotates itself isn't a refusal
        // (#472): a restart re-checks the credential and resumes. Its cause is
        // the record's code, or the failure an earlier restart's own paused
        // record carried forward.
        const expired = previous?.state === "paused" && (previous.code ?? previous.failure?.code) === "native_access_expired";
        const paused = !saved.enabled || await this.port.storage.get(`paused:${id}`) === true || previous?.state === "paused" && !expired;
        const held = await this.remembered(id, e);
        const r: Root<E> = { e: { ...e, ...(held ? { held } : {}) }, approval: structuredClone(e), epoch: 0, paused, status: this.state, admitted: new Set() };
        this.roots.set(id, r);
        if (paused) { this.set(r, "paused", `Saved approval paused; ${this.hint}`); continue; }
        // Say the pause is clearing before the grace: the old paused record would otherwise stand for up to its length.
        if (expired) this.set(r, "retrying", `Access expired before the restart; waiting for ${this.port.harness} to refresh it, approval retained`, "restore", "native_access_expired");
        try { await this.rotated(grace, () => this.port.credential.check(e)); }
        catch (error) {
          if (!expired) throw error;
          // A session ended, or a native bind started this root, during the grace: that state stands.
          if (this.roots.get(id) !== r || r.paused || r.task) continue;
          // Still expired after the grace: the next restart checks again. A
          // refusal now (another account, a revoked grant) is the pause's cause from here on; any other
          // failure is the outer catch's (an outage retry, or a degraded record the next restart re-checks).
          const cause = this.expired(error);
          if (!(cause instanceof Refusal)) throw error;
          r.paused = true;
          // Still expired: wait for the refresh here too, so a reload during the wait recovers (#661).
          if (cause instanceof AccessExpired && cause.reason === "expired") this.awaitRefresh(r, "restore");
          else this.set(r, "paused", failureMessage(cause, this.hint), "restore", failureCode(cause));
          continue;
        }
        if (this.roots.get(id) !== r) continue;
        await this.watch(e);
        await this.rotated(grace, () => this.prepare(r, true, true));
      } catch (caught) {
        const r = this.roots.get(id), error = this.expired(caught);
        // A changed credential the prepare met: the watch's drift, which says why every root paused (#1400). Before
        // the watch, the check's refusal is the saved approval's own staleness, which only this root's record reports.
        if (r && this.watches.has(id) && (this.drifted || this.signInChanged(error, this.restorable(r, r.epoch)))) continue;
        // An outage, or another process holding the token refresh: retry on the outage backoff (#424 6, #895, #1334).
        if (r && (error instanceof ServerUnreachable || error instanceof RefreshInProgress) && this.restorable(r, r.epoch)) {
          this.retrying(r, error);
          this.retryRestore(r);
        } else if (r && error instanceof AccessExpired && error.reason === "expired" && this.restorable(r, r.epoch)) {
          // The token expired between the check and the prepare: the same wait (#661).
          r.paused = true; this.awaitRefresh(r, "restore");
        } else if (r) { r.paused = true; await this.stop(r); this.set(r, "degraded", `Saved root unavailable (${failureCode(error)}); approval retained, ${this.hint}`, "restore", failureCode(error)); }
        else this.diagnostics.record({ state: "paused", sessionID: id, message: `Saved enrollment invalid; ${this.hint}`, operation: "restore" });
      }
    }
  }
  // A restore's or resume's prepare that found the server unreachable, or another
  // process holding the token refresh (#424 6, #895): retrying. Only an approval
  // host has a saved approval to retain, or a restore to speak of.
  private retrying(r: Root<E>, error: ServerUnreachable | RefreshInProgress) {
    const text = error instanceof RefreshInProgress ? `Token refresh in progress in another ${this.port.harness} process; retrying`
      : `Server unreachable at ${this.port.approval ? "restore" : "resume"}; retrying`;
    this.set(r, "retrying", this.port.approval ? `${text}, approval retained` : text, "restore", failureCode(error));
  }
  // A saved root a retry may still prepare: nothing (a stop, pause, drift,
  // shutdown, native bind, resume or session end) has taken it since `epoch`.
  private restorable(r: Root<E>, epoch: number) {
    return !this.stopped && !this.drifted && !this.ending.has(r.e.sessionID) && !r.paused && !r.task && r.epoch === epoch && this.roots.get(r.e.sessionID) === r;
  }
  // A saved root whose restore, or a root whose resume, found the server
  // unreachable (a host restarted during a server upgrade) retries its prepare
  // on the run loop's outage backoff, without limit, instead of pausing until
  // the next reload or start (#424 6, #895).
  // Each attempt runs in the control queue, as resume's does; anything that
  // takes the root meanwhile ends the retry, and close ends its wait.
  private retryRestore(r: Root<E>) {
    const epoch = r.epoch;
    const retry = (async () => {
      let expired = false;
      for (let attempt = 1; ; attempt++) {
        // Outside the control queue, as the recovery's request is (#916).
        // A failed request is recorded apart from the root, as the recovery's is.
        if (expired && this.restorable(r, epoch) && this.port.credential.refresh) await this.port.credential.refresh(r.e).catch(error => this.failure("restore", error));
        expired = false;
        await this.wait(Math.min(8000, 250 * 2 ** attempt), this.closing.signal);
        const done = await this.serial(async () => {
          if (!this.restorable(r, epoch)) return true;
          try {
            if (!this.watches.has(r.e.sessionID)) await this.watch(r.e);
            await this.prepare(r, true, true);
            return true;
          } catch (caught) {
            const error = this.expired(caught);
            if (!this.restorable(r, epoch) || this.signInChanged(error, true)) return true;
            if (error instanceof ServerUnreachable || error instanceof RefreshInProgress) { this.retrying(r, error); return false; }
            // As in the run loop's outage: a token that expired while the server
            // (its issuer) was down couldn't be refreshed; ask the host before the next try.
            if (error instanceof AccessExpired && error.reason === "expired") {
              this.set(r, "retrying", `Access expired during a server outage; retrying until ${this.port.harness} refreshes it`, "restore", failureCode(error));
              expired = true;
              return false;
            }
            // A resumed root with no saved approval (pi, omp, Claude Code) ends as its
            // resume would have without the outage: unpaused unless signed out, with the cause (#895, #1325).
            if (!this.port.approval) {
              if (this.signedOut(error)) r.paused = true;
              this.set(r, r.paused ? "paused" : "approved", failureMessage(error, this.hint), "enroll", failureCode(error));
            } else { r.paused = true; await this.stop(r); this.set(r, "degraded", `Saved root unavailable (${failureCode(error)}); approval retained, ${this.hint}`, "restore", failureCode(error)); }
            return true;
          }
        });
        if (done) return;
      }
    })().catch(error => this.failure("restore", error, r)).finally(() => this.retries.delete(retry));
    this.retries.add(retry);
  }
  // A root whose host-rotated access token stayed expired past the rotation
  // grace (#661). It stays paused (its record `native_access_expired`, which a
  // restart also resumes) while this loop asks the host to refresh, once per
  // expiry where the port can (`credential.refresh`), and re-checks the stored
  // credential on a capped backoff. A valid credential resumes it the way a
  // resume does: its remembered holds rebind with create:false, and one held
  // elsewhere is recorded, never taken. Any other refusal (a changed account or
  // grant, a sign-out, a rejected token) is the pause's cause from then on. A
  // pause, drift, shutdown, session end, enroll, resume or completed native
  // bind clears `awaiting` or replaces the root, which ends the loop; close
  // ends its wait. While a native bind is in flight it only keeps waiting.
  private awaitingSet(r: Root<E>, operation: Operation) {
    this.set(r, "paused", `Access expired; delivery resumes once ${this.port.harness} refreshes it, approval retained (or ${this.port.loginAction})`, operation, "native_access_expired");
  }
  private awaitRefresh(r: Root<E>, operation: Operation) {
    const mark = r.awaiting = {}, id = r.e.sessionID;
    const awaiting = () => this.awaitingSet(r, operation);
    awaiting();
    const live = () => r.awaiting === mark && !this.stopped && !this.drifted && !this.ending.has(id) && this.roots.get(id) === r;
    const recovery = (async () => {
      const progress = r.recovery ??= { attempt: 0, spent: 0 };
      while (live()) {
        if (progress.spent >= RECOVERY_BUDGET_MS) {
          r.awaiting = undefined;
          this.set(r, "paused", `Access still expired after an hour; ${this.hint}`, "recover", "native_access_expired");
          return;
        }
        // A failed request is recorded apart from the root, whose record stays the wait's.
        if (this.port.credential.refresh) await this.port.credential.refresh(r.e).catch(error => this.failure("recover", error));
        const ms = Math.min(RECOVERY_MAX_MS, RECOVERY_FIRST_MS * 2 ** progress.attempt++);
        await this.wait(ms, this.closing.signal);
        progress.spent += ms;
        const done = await this.serial(async () => {
          if (!live()) return true;
          // A native bind in flight: its afterCall sets the holds and ends the wait.
          if (r.binding) return false;
          // token(), not check(): only it reads the access token's expiry.
          try { await this.port.credential.check(r.e); await this.port.credential.token(r.e); }
          catch (caught) {
            const error = this.expired(caught);
            if (!live()) return true;
            // Still expired, or another process holding the token refresh: the next check reads its outcome (#1334).
            if ((error instanceof AccessExpired && error.reason === "expired") || error instanceof RefreshInProgress) return false;
            if (this.signInChanged(error, true)) return true;
            r.awaiting = undefined;
            this.set(r, "paused", failureMessage(error, this.hint), "recover", failureCode(error));
            return true;
          }
          r.awaiting = undefined;
          await this.stop(r); r.lease = undefined; r.paused = false;
          this.set(r, "retrying", "Access refreshed; recovering ownership, approval retained", "recover");
          try {
            if (!this.watches.has(id)) await this.watch(r.e);
            await this.prepare(r, true);
          } catch (caught) {
            const error = this.expired(caught);
            if (this.drifted || this.stopped || this.ending.has(id) || this.roots.get(id) !== r || this.signInChanged(error, true)) return true;
            if (error instanceof AccessExpired && error.reason === "expired") { r.paused = true; r.awaiting = mark; awaiting(); return false; }
            // An outage now, or another process holding the token refresh: restore's retry, on the outage
            // backoff, as resume's and restore's own prepares do (#424 6, #895, #1334).
            if ((error instanceof ServerUnreachable || error instanceof RefreshInProgress) && this.restorable(r, r.epoch)) {
              this.set(r, "retrying", error instanceof RefreshInProgress ? refreshingAtRecover(this.port.harness) : UNREACHABLE_AT_RECOVER, "recover", failureCode(error));
              this.retryRestore(r);
              return true;
            }
            // A sign-out pauses the root, as every start's does (#1325).
            if (this.signedOut(error)) r.paused = true;
            this.set(r, r.paused ? "paused" : "approved", failureMessage(error, this.hint), "recover", failureCode(error));
          }
          return true;
        });
        if (done) return;
      }
    })().catch(error => this.failure("recover", error, r)).finally(() => this.retries.delete(recovery));
    this.retries.add(recovery);
  }
  // Before a native call: a descendant registers under its root first; a root's
  // own bind stops delivery until afterCall reconciles it.
  async beforeCall(event: { sessionID: string; tool: string }): Promise<void> {
    const path = await this.path(event.sessionID);
    if (path.root !== event.sessionID) await this.enlist(path);
    if ((event.tool === "bind" || event.tool === "unbind") && path.root === event.sessionID) await this.serial(async () => {
      const current = this.roots.get(path.root);
      if (current) { current.binding = (current.binding ?? 0) + 1; this.set(current, "rebinding", "Delivery stopped before native bind", "before_bind"); await this.stop(current); }
      else this.diagnostics.record({ state: "rebinding", sessionID: path.root, message: this.port.approval ? "Native bind pending; receiving requires approval" : "Native bind pending", operation: "before_bind" });
    });
  }
  // After a native call: a bind or unbind result restarts delivery under the new
  // hold set; an `unbound` result from any tool rebinds the remembered holds.
  async afterCall(event: { sessionID: string; tool: string; result: CallOutcome }): Promise<void> {
    // A descendant's call the server answered unbound found no child row (one evicted, or its root's ownership
    // ended unseen): its next call registers again (#567).
    if (!this.roots.has(event.sessionID) && event.result.status === "completed" && (event.result.output as { unbound?: unknown } | undefined)?.unbound === true) this.registered.delete(event.sessionID);
    return this.serial(async () => {
      const r = this.roots.get(event.sessionID);
      const own = event.tool === "bind" || event.tool === "unbind";
      if (r && own && r.binding) r.binding--;
      if (!r || this.drifted || this.stopped) return;
      let resumed = false;
      // A native bind or unbind that completed while the root awaited a refresh
      // (its own 401 refreshed the token) sets the holds: delivery restarts
      // under them, so the recovery never rebinds a name just unbound (#661).
      // One that failed leaves the wait as it was.
      if (r.paused && r.awaiting && (event.tool === "bind" || event.tool === "unbind")) {
        if (event.result.status !== "completed") { this.awaitingSet(r, "after"); return; }
        r.awaiting = undefined; r.paused = false; resumed = true;
      }
      if (r.paused) return;
      try {
        // A wait restore entered never watched the credential; delivery doesn't run unwatched.
        if (resumed && !this.watches.has(r.e.sessionID)) await this.watch(r.e);
        if (event.tool !== "bind" && event.tool !== "unbind") {
          const output = event.result.status === "completed" ? event.result.output as { unbound?: unknown } | undefined : undefined;
          if (output?.unbound === true && r.e.held?.length) {
            await this.stop(r); r.lease = undefined;
            await this.rotated({ spent: 0 }, () => this.prepare(r, true));
          }
          return;
        }
        await this.stop(r);
        if (event.result.status === "completed") {
          const output = event.result.output as { name?: unknown; ownership?: unknown; instructions?: unknown } | undefined;
          // An unbind that released the last hold answers name null: nothing is left to rebind.
          const last = event.tool === "unbind" && output?.name === null;
          if (!output || !(typeof output.name === "string" || last) || !Number.isSafeInteger(output.ownership) || !Array.isArray(output.instructions) || !output.instructions.every(line => typeof line === "string")) throw new Error("Native bind completion lacked validated output");
          if (last) {
            r.e = { ...r.e, held: [] };
            await this.port.storage.set(`rememberedHeld:${r.e.sessionID}`, { approval: this.approvalKey(r.approval), held: [] });
          }
        }
        await this.rotated({ spent: 0 }, () => this.prepare(r, false));
      } catch (error) {
        if (this.drifted) return;
        // A sign-out pauses the root, as every start's does (#1325).
        if (this.signedOut(error)) r.paused = true;
        this.set(r, r.paused ? "paused" : "approved", failureMessage(this.expired(error), this.hint), "after", failureCode(this.expired(error)));
      }
    });
  }
  // A new top-level root binds the configured name; receiving still needs approval where the host keeps one.
  // `session.created` resolved its ancestry a moment ago (`childRoot`): that lookup serves (#567).
  async configuredBind(sessionID: string) {
    if (this.stopped || !this.configured) return;
    const known = this.lookups.get(sessionID);
    const path = known ? this.route(known) : await this.path(sessionID);
    if (path.root !== sessionID) return;
    try {
      const e = await this.port.credential.capture(sessionID);
      await this.temporary(e, w => w.call("bind", { name: this.configured!.name, create: this.configured!.create, where: this.port.place() }));
      this.diagnostics.record({ state: "unenrolled", sessionID, message: this.port.approval ? "Configured binding completed; receiving still requires human approval" : "Configured binding completed", operation: "configured_bind" });
    } catch (error) { this.diagnostics.record({ state: "unbound", sessionID, message: failureMessage(this.expired(error), this.hint), operation: "configured_bind", code: failureCode(this.expired(error)) }); }
  }
  // A session ended (deleted, archived, shut down): a root releases its
  // ownership; a descendant ends its registration without ending its root.
  async ended(sessionID: string) {
    if (this.stopped) return;
    this.lookups.delete(sessionID); this.registered.delete(sessionID);
    const path = this.routes.end(sessionID);
    if (!path) return;
    const r = this.roots.get(path.root);
    if (sessionID === path.root && r) {
      r.paused = true; r.awaiting = undefined; r.epoch++; r.abort?.abort();
      await this.serial(async () => {
        await this.stop(r); await this.release(r).catch(error => this.failure("session_end", error, r));
        await this.port.storage.set(`paused:${sessionID}`, true); this.set(r, "paused", "Root ended; ownership released", "session_end");
      });
    } else {
      const e = r?.e ?? await this.port.credential.capture(path.root);
      await end((id, call) => this.temporary(e, call, id), { child: sessionID }).catch(error => this.failure("child_end", error, r));
    }
  }
  // A host's failure outside any call result (the tool proxy's `report`).
  backgroundFailure(operation: Extract<Operation, "event" | "stream" | "restore" | "enroll" | "after" | "hook_dispose" | "rpc_dispose" | "release_upload">) {
    this.failure(operation, undefined);
  }
  async close() {
    this.stopped = true; this.closing.abort();
    for (const r of this.roots.values()) r.abort?.abort();
    await this.controls;
    while (this.retries.size) await Promise.all(this.retries);
    for (const r of this.roots.values()) await this.stop(r);
    for (const watch of this.watches.values()) await watch.dispose().catch(error => this.failure("watch_dispose", error));
    this.watches.clear();
    await this.diagnostics.flush();
  }
}
