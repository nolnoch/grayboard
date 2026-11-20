// #430: the harness-neutral Controller against a fake HostPort: no session
// metadata, no tool list. Every case runs once with an adapter-owned grant
// (`approval: null`) and once with a fake approval port.
import { expect, setSystemTime, test } from "bun:test";
import { until } from "../../../tests/support/until.ts";
import { Controller, type ControllerOptions } from "../src/controller.js";
import { AccessExpired, Refusal, RefreshInProgress, same, type AccessReason, type Item } from "../src/model.js";
import type { ApprovalPort, CredentialPort, Enrollment, HostPort } from "../src/port.js";
import { resolveRoot } from "../src/sessions.js";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { LeaseUnavailable, OutcomeUnknown, ServerUnreachable, SubscriberError, subscriberError, Wire, type WireOptions } from "../src/wire.js";

type Mode = "adapter" | "approval";
type Row = { held: string[]; ownership: number; generation: number; capability?: string };
type Call = { sessionID: string; name: string; args: Record<string, unknown> };
const SESSION_KEY = "io.github.nolnoch.grayboard/sessionID";
const DELIVERY = { mode: "push" as const, source: "grayboard" };

function runtime(mode: Mode, options: { rotates?: boolean } = {}) {
  const rows = new Map<string, Row>(), storage = new Map<string, unknown>(), batches = new Map<string, Item[]>();
  const calls: Call[] = [], admits: { sessionID: string; id: string; item: string }[] = [], wires: WireOptions[] = [];
  const nodes = new Map<string, string | undefined>([["R", undefined], ["B", undefined], ["C", "R"], ["G", "C"]]);
  const watchers = new Set<() => void>(), drifts: (() => void)[] = [], streams = new Map<string, () => void>();
  const approvals = new Map<string, { approval: Enrollment; enabled: boolean }>();
  // Holds the server took (#453), per session: the subscriber whoami reports them, and the next delivery_open
  // takes the reported ones, as the server does.
  const lost = new Map<string, { alias: string; reason: string; reported: boolean }[]>();
  let ownership = 0, grant = 1, failReceipt = 0, renews = 0, receipts = 0, refreshBusy = 0, leaseLostAfter = Infinity, signedOut = false;
  let receiptFault: { at: number; error: () => Error; then?: () => void } | undefined, receiptsLost = false;
  // Whether the fake server's delivery_open lists `context` (#854); an older server's doesn't.
  let takesContext = true;
  // While set, the credential's token() finds the access token ended for this reason.
  let accessFault: AccessReason | undefined, checkSeesAccess = false;
  // The host's refresh requests (#661), and the addresses another session holds (a bind refuses alias_held).
  let refreshes = 0;
  // The deadline each delivery_renew reports (#481), when a test sets one; check()'s own failure, when set.
  let renewAt: (() => number) | undefined, checkFault: (() => Error) | undefined;
  const heldElsewhere = new Set<string>();
  // A prepare's whoami (a temporary wire: no beforeRetry) waits on this; the host's admit, on that.
  // Every session_register waits on `registerHold` while set; `ancestries` lists each ancestry lookup's session.
  let registerHold: Promise<void> | undefined;
  const ancestries: string[] = [];
  // While set, a temporary wire's connect waits for its signal's abort, as a server that never answers (#1294).
  let connectHold = 0, connecting = 0;
  // The next connect whose token() refuses runs this as the refusal lands: a stop that begins after a start's
  // real failure and before its catch records it (#1309).
  let onRefused: (() => void) | undefined;
  let prepareHold: Promise<void> | undefined, admitHold: ((signal: AbortSignal) => Promise<void>) | undefined, beforeOpen: (() => void) | undefined;
  let whoamiFault: (() => Error) | undefined;
  // The host's receipt hook (#441), when a test sets one.
  let receiptHook: ((sessionID: string, ids: readonly string[]) => void) | undefined;
  const loops: FakeWire[] = [];
  // The credential's token-change listeners (#1379); every listen the run loop opened, in order, while `open`;
  // the most listens one session had open at once; the next listen waits on `listenHold` (released by its gate,
  // or refused by its wire's abort); the next `failListen` listens throw; the next `hangClose` closes end the stream
  // locally but never return, as a server that never answers the cancel POST.
  const rotations = new Set<() => void>();
  const listens: { sessionID: string; open: boolean }[] = [];
  let mostOpen = 0, listenHold: Promise<void> | undefined, failListen = 0, hangClose = 0;
  const address = (name: string) => name.includes("/") ? name : `you@example.com/${name}`;
  // A bind adds a hold; an unbind releases one and bumps the generation too (#451).
  const bind = (id: string, name: string) => { const old = rows.get(id), held = old?.held ?? []; rows.set(id, { held: held.includes(address(name)) ? held : [...held, address(name)], ownership: old?.ownership ?? ++ownership, generation: (old?.generation ?? 0) + 1 }); };
  class FakeWire {
    capability?: string;
    admissionRetryAfterMs?: number;
    client = { setNotificationHandler: () => {} };
    constructor(options: WireOptions, readonly auth: { token(): Promise<string> }, readonly signal: AbortSignal, readonly sessionID: string, readonly beforeRetry?: () => Promise<void>) { wires.push(options); if (beforeRetry) loops.push(this); }
    // Only the run loop's wire has beforeRetry. The SDK reads the token while
    // connecting and wraps a token() failure in its version-negotiation error.
    async connect() {
      if (!this.beforeRetry && connectHold > 0) {
        connectHold--; connecting++;
        await new Promise<never>((_, reject) => this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true }));
      }
      if (this.beforeRetry && refreshBusy > 0) { refreshBusy--; throw new Error("Version negotiation probe failed", { cause: new RefreshInProgress("pi") }); }
      try { await this.auth.token(); } catch (error) {
        if (onRefused) { const hook = onRefused; onRefused = undefined; hook(); }
        throw new Error("Version negotiation probe failed", { cause: error });
      }
    }
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ sessionID: this.sessionID, name, args });
      let row = rows.get(this.sessionID);
      if (name === "whoami") {
        if (!this.beforeRetry && prepareHold) await prepareHold;
        if (!this.beforeRetry && whoamiFault) { const fault = whoamiFault; whoamiFault = undefined; throw fault(); }
        // The server reports each loss to the Controller until its next delivery_open (#453).
        const taken = lost.get(this.sessionID) ?? [];
        for (const l of taken) l.reported = true;
        return { held: row?.held ?? [], primary: row?.held[0] ?? null, ownership: row?.ownership ?? null, ...(taken.length ? { alias_lost: taken.map(({ alias, reason }) => ({ alias, reason })) } : {}), ...(!row?.held.length ? { unbound: true } : {}) };
      }
      if (name === "bind") {
        if (address(args.name as string).endsWith("/gone") || heldElsewhere.has(address(args.name as string))) throw new SubscriberError("alias_held");
        if (!args.create && !rows.get(this.sessionID) && !["you@example.com/be", "you@example.com/fe"].includes(address(args.name as string))) throw new Error("identity_unknown");
        bind(this.sessionID, args.name as string); row = rows.get(this.sessionID)!;
        lost.set(this.sessionID, (lost.get(this.sessionID) ?? []).filter(l => l.alias !== address(args.name as string)));
        return { name: row.held[0]!.split("/")[1], ownership: row.ownership, instructions: ["bound"] };
      }
      if (name === "unbind") {
        if (row) { row.held = row.held.filter(h => h !== address(args.name as string)); row.generation++; }
        return { name: row?.held[0]?.split("/")[1] ?? null, ownership: row?.ownership, instructions: ["unbound"] };
      }
      if (name === "session_register") { await registerHold; return { registered: true }; }
      if (name === "session_end" || name === "delivery_release") { rows.delete(this.sessionID); return { ok: true }; }
      if (name === "delivery_open") {
        if (beforeOpen) { const hook = beforeOpen; beforeOpen = undefined; hook(); row = rows.get(this.sessionID); }
        if (!row?.held.length) throw new Error("unbound");
        lost.set(this.sessionID, (lost.get(this.sessionID) ?? []).filter(l => !l.reported));
        row.capability = `${row.ownership}_${row.generation}`.padEnd(43, "a");
        return { capability: row.capability, ownership: row.ownership, bind_gen: row.generation, expiresAt: Date.now() + 30_000, identity: { user_email: "you@example.com", identity_full: row.held[0] } };
      }
      if (name.startsWith("delivery_") && (!row?.capability || row.capability !== this.capability)) throw new LeaseUnavailable();
      if (name === "delivery_renew") {
        if (++renews > leaseLostAfter) throw new LeaseUnavailable();
        if (renewAt) return { ok: true, expiresAt: renewAt() };
      }
      if (name === "delivery_receipt") {
        if (++receipts === receiptFault?.at) { receiptFault.then?.(); throw receiptFault.error(); }
        if (renews >= leaseLostAfter || receiptsLost) throw new LeaseUnavailable();
        if (failReceipt > 0) { failReceipt--; throw new Error("receipt lost"); }
        batches.set(this.sessionID, (batches.get(this.sessionID) ?? []).filter(item => !(args.ids as string[]).includes(item.id)));
      }
      return { ok: true };
    }
    async read() { return { items: batches.get(this.sessionID) ?? [] }; }
    async takes(tool: string, arg: string) { calls.push({ sessionID: this.sessionID, name: "tools/list", args: {} }); return takesContext && tool === "delivery_open" && arg === "context"; }
    // The server closes the stream on its own: a revoked grant closes it at once.
    async listen() {
      if (listenHold) {
        const hold = listenHold; listenHold = undefined;
        await Promise.race([hold, new Promise<never>((_, reject) => this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true }))]);
      }
      if (failListen > 0) { failListen--; throw new ServerUnreachable(new Error("listen refused")); }
      const { promise: closed, resolve } = Promise.withResolvers<void>();
      const entry = { sessionID: this.sessionID, open: true };
      listens.push(entry);
      mostOpen = Math.max(mostOpen, listens.filter(l => l.open && l.sessionID === this.sessionID).length);
      streams.set(this.sessionID, resolve);
      return { closed, close: async () => { entry.open = false; resolve(); if (hangClose > 0) { hangClose--; await new Promise<never>(() => {}); } } };
    }
  }
  const configuration = () => ({ type: "remote" as const, url: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", clientID: "grayboard-pi", scope: "grayboard:delivery grayboard:tools", configHash: `grant-${grant}` });
  const credential: CredentialPort<Enrollment> = {
    capture: async sessionID => { if (signedOut) throw new AccessExpired("pi", "run /grayboard login"); return { version: 2, sessionID, configuration: configuration() }; },
    check: async e => {
      if (e.configuration.configHash !== `grant-${grant}`) throw new Refusal("binding", "Grant changed");
      if (checkSeesAccess && accessFault) throw new AccessExpired("pi", "run /grayboard login", accessFault);
      if (checkFault) throw checkFault();
    },
    watch: async (_e, drift) => { watchers.add(drift); drifts.push(drift); return { dispose: async () => { watchers.delete(drift); } }; },
    token: async () => { if (accessFault) throw new AccessExpired("pi", "run /grayboard login", accessFault); return "access"; },
    unauthorized: async () => { throw new Refusal("auth", "unauthorized"); },
    refresh: async () => { refreshes++; return true; },
    ...(options.rotates === false ? {} : { rotated: (_e: Enrollment, changed: () => void) => { const fn = () => changed(); rotations.add(fn); return { dispose: () => { rotations.delete(fn); } }; } }),
  };
  const approval: ApprovalPort<Enrollment> | null = mode === "approval" ? {
    key: e => JSON.stringify([e.sessionID, e.configuration]),
    save: async (e, saved, enabled) => { approvals.set(e.sessionID, { approval: structuredClone(saved), enabled }); },
    approved: async (e, saved) => { const s = approvals.get(e.sessionID); return !!s?.enabled && same(s.approval, saved); },
    saved: async () => [...approvals].map(([sessionID, s]) => ({ sessionID, approval: structuredClone(s.approval), enabled: s.enabled })),
    drop: async sessionID => { approvals.delete(sessionID); },
  } : null;
  const port: HostPort<Enrollment> = {
    harness: "pi", resumeHint: "run /grayboard resume", loginAction: "run /grayboard login", sessionKey: SESSION_KEY,
    client: { name: "grayboard-test", version: "1.0.0" }, delivery: DELIVERY,
    storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, structuredClone(value)); } },
    place: () => "/work",
    ancestry: sessionID => (ancestries.push(sessionID), resolveRoot(sessionID, async id => { if (!nodes.has(id)) throw new Error("missing"); return { id, parentID: nodes.get(id), time: {} }; })),
    credential, approval,
    admit: async (e, item, id, _identity, signal) => { admits.push({ sessionID: e.sessionID, id, item: item.id }); await admitHold?.(signal); },
    receipted: (e, ids) => receiptHook?.(e.sessionID, ids),
  };
  const make = (options: ControllerOptions = {}) => new Controller(port, { Transport: FakeWire as unknown as typeof Wire, ...options });
  const controller = make();
  // The item a fresh root's first bind of `be` will be issued (ownership 1, generation 1).
  const item = (id: string): Item => ({ id, actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" });
  const named = (name: string) => calls.filter(c => c.name === name);
  return {
    controller, make, rows, storage, batches, calls, admits, wires, nodes, approvals, item, named, drifts, loops, ancestries,
    holdRegister: (gate?: Promise<void>) => { registerHold = gate; },
    // Every prepare's whoami waits on `gate` from now on.
    holdPrepare: (gate: Promise<void>) => { prepareHold = gate; },
    // The next `n` temporary wires' connects hang until their signals abort.
    hangConnect: (n = Infinity) => { connectHold = n; },
    get connecting() { return connecting; },
    onRefused: (hook: () => void) => { onRefused = hook; },
    // The next delivery_open runs `hook` first (a revocation landing between a whoami and the open).
    beforeOpen: (hook: () => void) => { beforeOpen = hook; },
    // The next temporary wire's whoami (a start's prepare) throws `fault()` (the server refusing the access token).
    failWhoami: (fault: () => Error) => { whoamiFault = fault; },
    holdAdmit: (hold: (signal: AbortSignal) => Promise<void>) => { admitHold = hold; },
    onReceipted: (hook: (sessionID: string, ids: readonly string[]) => void) => { receiptHook = hook; },
    drift: () => { grant++; for (const w of [...watchers]) w(); },
    // The grant changes before any watch's next tick; the server then closes `id`'s stream.
    revoke: (id: string) => { grant++; streams.get(id)?.(); },
    closeStream: (id: string) => { streams.get(id)?.(); },
    // The server takes a hold (#453, a revoked access): released, the generation bumped, the stream closed,
    // and whoami reports it until the next delivery_open.
    loseHold: (id: string, name: string, reason: string) => {
      const row = rows.get(id)!;
      row.held = row.held.filter(h => h !== address(name)); row.generation++;
      lost.set(id, [...(lost.get(id) ?? []), { alias: address(name), reason, reported: false }]);
      streams.get(id)?.();
    },
    failReceipt: (n: number) => { failReceipt = n; },
    refreshBusy: (n: number) => { refreshBusy = n; },
    // token() refuses with AccessExpired(reason) until called again without one.
    expireAccess: (reason?: AccessReason) => { accessFault = reason; },
    // check() refuses with the access fault too, as a host whose check reads the token's expiry.
    checkSeesAccess: () => { checkSeesAccess = true; },
    // Every delivery_renew reports `at()` as the lease's deadline.
    renewExpiresAt: (at: () => number) => { renewAt = at; },
    // check() throws `fault()` until called again without one.
    failCheck: (fault?: () => Error) => { checkFault = fault; },
    // The nth delivery_receipt throws `error` once, after running `then`.
    failReceiptAt: (at: number, error: () => Error, then?: () => void) => { receiptFault = { at, error, ...(then ? { then } : {}) }; },
    // The lease lapses after the nth delivery_renew: every later renew and receipt finds no live lease (an
    // expired lease the server won't renew).
    loseLeaseAfterRenew: (at: number) => { leaseLostAfter = at; },
    // Every delivery_receipt finds no live lease while renews still succeed.
    loseReceipts: () => { receiptsLost = true; },
    // The grant store is logged out: a capture finds no sign-in.
    signOut: () => { signedOut = true; },
    get refreshes() { return refreshes; },
    // Another session takes `name`: this root's rebind of it is refused alias_held.
    holdElsewhere: (name: string) => { heldElsewhere.add(address(name)); },
    olderServer: () => { takesContext = false; },
    root: (c: Controller, id = "R") => c.status().roots.find(r => r.sessionID === id),
    // The credential's access token changed (#1379): every listener hears it.
    rotate: () => { for (const fn of [...rotations]) fn(); },
    get rotationListeners() { return rotations.size; },
    listens,
    get mostOpen() { return mostOpen; },
    // The next listen waits until `gate` resolves (or its wire aborts).
    holdListen: (gate: Promise<void>) => { listenHold = gate; },
    // The next `n` listens are refused as an outage.
    failListen: (n: number) => { failListen = n; },
    // The next `n` stream closes never answer their cancel.
    hangClose: (n: number) => { hangClose = n; },
  };
}
const modes: Mode[] = ["adapter", "approval"];

test.each(modes)("enroll binds, opens delivery with the port's session key and delivery declaration, admits and receipts (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.named("delivery_receipt").length === 1);
    expect(r.admits.map(a => [a.sessionID, a.item])).toEqual([["R", "direct:1"]]);
    expect(r.admits[0]!.id).toMatch(/^msg_[a-f0-9]{64}$/);
    expect(r.root(r.controller)).toMatchObject({ state: "active", held: ["you@example.com/be"] });
    expect(r.named("bind")[0]!.args).toEqual({ name: "be", create: true, where: "/work" });
    expect(r.wires.every(w => w.sessionKey === SESSION_KEY && same(w.delivery, DELIVERY) && w.client.name === "grayboard-test")).toBe(true);
    if (mode === "approval") expect(r.approvals.get("R")?.enabled).toBe(true);
    else expect(r.approvals.size).toBe(0);
  } finally { await r.controller.close(); }
});

test.each(modes)("context: false opens the lease with context:false where the server lists it, plainly where it doesn't; by default it never asks (%s)", async mode => {
  for (const older of [false, true]) {
    const r = runtime(mode);
    if (older) r.olderServer();
    const c = r.make({ context: false });
    try {
      await c.enroll("R", ["be"], true);
      await until(() => r.root(c)?.state === "active");
      expect(r.named("delivery_open").map(o => o.args)).toEqual([older ? {} : { context: false }]);
    } finally { await c.close(); await r.controller.close(); }
  }
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    expect(r.named("delivery_open").map(o => o.args)).toEqual([{}]);
    expect(r.named("tools/list")).toEqual([]);
  } finally { await r.controller.close(); }
});

test.each(modes)("a descendant can't enroll; ancestry is the port's (%s)", async mode => {
  const r = runtime(mode);
  try {
    await expect(r.controller.enroll("C")).rejects.toThrow("An active top-level root is required");
    await expect(r.controller.enroll("missing")).rejects.toThrow();
  } finally { await r.controller.close(); }
});

test.each(modes)("resume rebinds the remembered name with create:false after a restart (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const restarted = r.make(), binds = r.named("bind").length;
  try {
    await restarted.resume("R");
    await until(() => r.root(restarted)?.state === "active");
    expect(r.named("bind").slice(binds).map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
    if (mode === "approval") await expect(restarted.resume("B")).rejects.toThrow("No saved approval for this root; run /grayboard resume");
    else {
      await restarted.resume("B");
      expect(r.root(restarted, "B")).toMatchObject({ state: "unbound" });
    }
  } finally { await restarted.close(); }
});

// #895: pi, omp and Claude Code resume a root at every start; a host restarted during a server outage (an
// upgrade) retries it on the outage backoff, as a saved root's restore does (#424 6), rather than staying dark.
test.each(modes)("a resume during a server outage retries on the outage backoff, never pausing, and rebinds the remembered name (#895, %s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  // Every prepare's whoami finds the server down until the second wait.
  const down = Promise.reject(new ServerUnreachable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
  down.catch(() => {});
  r.holdPrepare(down);
  const waits: number[] = [], states: (string | undefined)[] = [];
  const restarted: Controller = r.make({ wait: async ms => {
    waits.push(ms); states.push(r.root(restarted)?.state);
    if (waits.length === 2) r.holdPrepare(Promise.resolve());
  } });
  const binds = r.named("bind").length;
  try {
    await restarted.resume("R");
    expect(r.root(restarted)).toMatchObject({ state: "retrying", operation: "restore", code: "server_unreachable" });
    await until(() => r.root(restarted)?.state === "active");
    expect(waits).toEqual([500, 1000]);
    expect(states).toEqual(["retrying", "retrying"]);
    expect(r.named("bind").slice(binds).map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
  } finally { await restarted.close(); }
});
// The server back, the remembered name is now refused: a root without a saved approval ends as its resume would
// have without the outage (unpaused, with the cause), so the agent's own bind starts delivery; an approval
// host's saved root pauses, as its restore's retry always has.
test.each(modes)("a resume's outage retry that comes back to a refused name ends with the cause (#895, %s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const down = Promise.reject(new ServerUnreachable(new Error("down")));
  down.catch(() => {});
  r.holdPrepare(down);
  const restarted: Controller = r.make({ wait: async () => { r.holdElsewhere("be"); r.holdPrepare(Promise.resolve()); } });
  try {
    await restarted.resume("R");
    expect(r.root(restarted)).toMatchObject({ state: "retrying", message: mode === "approval" ? "Server unreachable at restore; retrying, approval retained" : "Server unreachable at resume; retrying" });
    await until(() => r.root(restarted)?.state !== "retrying");
    if (mode === "approval") expect(r.root(restarted)).toMatchObject({ state: "degraded", operation: "restore" });
    else {
      expect(r.root(restarted)).toMatchObject({ state: "approved", operation: "enroll", code: "alias_held" });
      await restarted.beforeCall({ sessionID: "R", tool: "bind" });
      r.rows.set("R", { held: ["you@example.com/fe"], ownership: 99, generation: 1 });
      await restarted.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "fe", ownership: 99, instructions: ["bound"] } } });
      await until(() => r.root(restarted)?.state === "active");
    }
  } finally { await restarted.close(); }
});
// #1325 audit M-1: the server back, the resume's outage retry draws a 401 on prepare's whoami. A sign-out pauses the root,
// as every start path's does: a root without a saved approval records it paused with the cause, an approval host's
// saved root degrades with the cause's code (as its restore does). `expired` retries until the host rotates it.
test.each(modes.flatMap(mode => (["expired", "login_required"] as const).map(reason => [mode, reason] as const)))("a resume's outage retry that comes back to AccessExpired pauses only on a sign-out (#1325, %s, %s)", async (mode, reason) => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const down = Promise.reject(new ServerUnreachable(new Error("down")));
  down.catch(() => {});
  r.holdPrepare(down);
  let waits = 0;
  const restarted: Controller = r.make({ wait: async () => {
    if (++waits === 1) { r.holdPrepare(Promise.resolve()); r.failWhoami(() => new AccessExpired("pi", "run /grayboard login", reason)); }
  } });
  try {
    await restarted.resume("R");
    expect(r.root(restarted)?.state).toBe("retrying");
    if (reason === "expired") {
      await until(() => r.root(restarted)?.state === "active");
      expect(waits).toBe(2);
    } else {
      await until(() => r.root(restarted)?.state !== "retrying");
      expect(r.root(restarted)).toMatchObject(mode === "approval" ? { state: "degraded", operation: "restore", code: "login_required" } : { state: "paused", operation: "enroll", code: "login_required" });
      expect(waits).toBe(1);
      expect(r.named("delivery_open")).toHaveLength(1);
    }
  } finally { await restarted.close(); }
});
// Several processes sharing one grant store restart during an upgrade: one holds the refresh lock while the
// server is slow, and the others' prepares find the refresh in progress. They retry, as the run loop does.
test.each(modes)("a resume that finds the token refresh in another process retries on the outage backoff (#895, %s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const busy = Promise.reject(new RefreshInProgress("pi"));
  busy.catch(() => {});
  r.holdPrepare(busy);
  let waits = 0;
  const restarted: Controller = r.make({ wait: async () => { if (++waits === 2) r.holdPrepare(Promise.resolve()); } });
  try {
    await restarted.resume("R");
    expect(r.root(restarted)).toMatchObject({ state: "retrying", code: "refresh_in_progress" });
    await until(() => r.root(restarted)?.state === "active");
    expect(waits).toBe(2);
  } finally { await restarted.close(); }
});
test.each(modes)("a close during a resume's outage retry ends it: nothing prepares after it (#895, %s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  const down = Promise.reject(new ServerUnreachable(new Error("down")));
  down.catch(() => {});
  r.holdPrepare(down);
  let waited = 0;
  const restarted: Controller = r.make({ wait: async (_ms, signal) => { waited++; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } });
  await restarted.resume("R");
  await until(() => waited === 1);
  const whoamis = r.named("whoami").length;
  await restarted.close();
  expect(r.named("whoami").length).toBe(whoamis);
  expect(waited).toBe(1);
});
// #1294: close aborts an enroll's or prepare's wire still connecting, rather than waiting out its 10 s timeout;
// the abort is a stop, never an outage to retry.
test.each(modes.flatMap(mode => (["enroll", "enroll with a name", "resume"] as const).map(how => [mode, how] as const)))("close ends a start's wire still connecting at once (#1294, %s, %s)", async (mode, how) => {
  const r = runtime(mode);
  if (how === "resume") { await r.controller.enroll("R", ["be"], true); await until(() => r.root(r.controller)?.state === "active"); await r.controller.close(); }
  const c = how === "resume" ? r.make() : r.controller;
  r.hangConnect();
  const calls = r.calls.length;
  const starting = how === "resume" ? c.resume("R") : c.enroll("R", how === "enroll" ? [] : ["be"], true);
  await until(() => r.connecting === 1);
  const began = performance.now();
  await c.close();
  expect(performance.now() - began).toBeLessThan(1000);
  expect((await starting).state).not.toBe("retrying");
  expect(r.calls.length).toBe(calls);
  expect(r.connecting).toBe(1);
  // A stop, not a failure: no code, and nothing the next start restores as one.
  expect(r.root(c)).toMatchObject({ message: expect.stringMatching(/stopped before delivery opened/i) });
  expect(r.root(c)?.code).toBeUndefined();
  expect(r.root(c)?.failure).toBeUndefined();
});
// #1309: a stop is decided by cause, not timing: a sign-in refusal that lands just before close (or the session's
// shutdown) begins keeps its failure and code, rather than reading as "stopped before delivery opened".
test.each(modes.flatMap(mode => (["enroll", "enroll with a name", "resume"] as const).flatMap(how => (["close", "shutdown"] as const).map(stop => [mode, how, stop] as const))))("a start's real failure that races a stop keeps its code (#1309, %s, %s, %s)", async (mode, how, stop) => {
  const r = runtime(mode);
  if (how === "resume") { await r.controller.enroll("R", ["be"], true); await until(() => r.root(r.controller)?.state === "active"); await r.controller.close(); }
  const c = how === "resume" ? r.make() : r.controller;
  r.expireAccess("login_required");
  // The refusal lands, then the stop begins before the start's catch records it.
  let stopping: Promise<unknown> | undefined;
  r.onRefused(() => { stopping = stop === "close" ? c.close() : c.shutdown("R", "release"); });
  const status = await (how === "resume" ? c.resume("R") : c.enroll("R", how === "enroll" ? [] : ["be"], true));
  expect(stopping).toBeDefined();
  expect(status.state).not.toBe("retrying");
  expect(r.root(c)?.message).not.toMatch(/stopped before delivery opened/i);
  expect(r.root(c)?.code).toBe("login_required");
  await stopping;
  await c.close();
});
// #1309 audit M-1: an access token the host is rotating (#472) is retried on the rotation grace's polls; a close that
// ends the grace rethrows the pending expiry. That expiry was never a failure: the start records a stop, not a sign-out.
test.each(modes.flatMap(mode => (["enroll", "resume"] as const).map(how => [mode, how] as const)))("a close during a start's rotation grace records a stop, not a sign-out (#1309, %s, %s)", async (mode, how) => {
  const r = runtime(mode);
  if (how === "resume") { await r.controller.enroll("R", ["be"], true); await until(() => r.root(r.controller)?.state === "active"); await r.controller.close(); }
  let closing: Promise<void> | undefined, waits = 0;
  const c: Controller = r.make({ wait: async () => { waits++; closing ??= c.close(); } });
  r.expireAccess("expired");
  await (how === "resume" ? c.resume("R") : c.enroll("R"));
  expect(waits).toBe(1);
  expect(r.root(c)?.message).toMatch(/stopped before delivery opened/i);
  expect(r.root(c)?.code).toBeUndefined();
  expect(r.root(c)?.failure).toBeUndefined();
  await closing;
});
// #1312: a start whose access ends in a sign-out pauses its root, as the run loop does; `expired` (a token the host
// rotates itself) doesn't: past the rotation grace it ends `approved`, since no awaitRefresh would wake a paused root.
test.each(modes.flatMap(mode => (["enroll", "resume"] as const).flatMap(how => ([["expired", "approved"], ["login_required", "paused"]] as const).map(([reason, state]) => [mode, how, reason, state] as const))))("a start that ends on AccessExpired pauses only on a sign-out (#1312, %s, %s, %s)", async (mode, how, reason, state) => {
  const r = runtime(mode);
  if (how === "resume") { await r.controller.enroll("R", ["be"], true); await until(() => r.root(r.controller)?.state === "active"); await r.controller.close(); }
  let waits = 0;
  const c = r.make({ wait: async () => { waits++; } });
  r.expireAccess(reason);
  try {
    await (how === "resume" ? c.resume("R") : c.enroll("R"));
    expect(r.root(c)?.state).toBe(state);
    // `expired` ran out the rotation grace first; a sign-out ends at once.
    if (reason === "expired") expect(waits).toBeGreaterThan(0); else expect(waits).toBe(0);
  } finally { await c.close(); }
});
// #1325: the recovery's own start is one more start path. Its stored token reads fresh, then the server refuses it on
// prepare's whoami: `expired` goes back to waiting for the host's rotation (#661); a sign-out pauses the root.
test.each(modes.flatMap(mode => (["expired", "login_required"] as const).map(reason => [mode, reason] as const)))("a recovery whose start ends on AccessExpired pauses on a sign-out, and waits again on `expired` (#1325, %s, %s)", async (mode, reason) => {
  const o = await expiredPause(mode, (n, r) => {
    if (n === 1) { r.expireAccess(); r.failWhoami(() => { r.expireAccess(reason); return new AccessExpired("pi", "run /grayboard login", reason); }); }
  });
  try {
    if (reason === "expired") await until(() => o.recovering() >= 2);
    else await until(() => o.r.root(o.c)?.operation === "recover" && o.r.root(o.c)?.state !== "retrying");
    await o.c.close();
    expect(o.r.root(o.c)?.state).toBe("paused");
    expect(o.r.root(o.c)?.code).toBe(reason === "expired" ? "native_access_expired" : "login_required");
    if (reason === "login_required") expect(o.recovering()).toBe(1);
    expect(o.r.named("delivery_open")).toHaveLength(o.opened);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// #1334: the recovery's start finds another process holding the token refresh (processes sharing one grant store).
// It retries on restore's outage backoff, as resume's and restore's own prepares do, and opens once the lock frees.
test.each(modes)("a recovery whose start finds the token refresh in another process retries on the outage backoff (#1334, %s)", async mode => {
  const busy = Promise.reject(new RefreshInProgress("pi"));
  busy.catch(() => {});
  const o = await expiredPause(mode, (n, r) => {
    if (n === 1) { r.expireAccess(); r.holdPrepare(busy); }
    // restore's retry: its first wait is 500 ms; the second (1000 ms) frees the lock.
    if (n === 2) r.holdPrepare(Promise.resolve());
  });
  try {
    await until(() => o.recovering() >= 2 && o.r.root(o.c)?.state === "active");
    const seen = o.states.map(s => [s.state, s.operation, s.code].join(":"));
    expect(seen).toContain("retrying:recover:refresh_in_progress");
    expect(seen).toContain("retrying:restore:refresh_in_progress");
    expect(seen.filter(s => s.startsWith("approved:recover") || s.startsWith("paused:recover"))).toEqual([]);
    expect(o.recovering()).toBe(2);
    expect(o.r.named("delivery_open")).toHaveLength(o.opened + 1);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// #1334: the recovery's credential check itself finds the refresh in progress: it keeps waiting, rather than pausing for good.
test.each(modes)("a recovery check that finds the token refresh in another process keeps waiting (#1334, %s)", async mode => {
  const o = await expiredPause(mode, (n, r) => {
    if (n === 1) r.failCheck(() => new RefreshInProgress("pi"));
    if (n === 2) { r.failCheck(); r.expireAccess(); }
  });
  try {
    await until(() => o.recovering() >= 2 && o.r.root(o.c)?.state === "active");
    expect(o.recovering()).toBe(2);
    expect(o.states.some(s => s.code === "refresh_in_progress")).toBe(false);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// #1294 audit M-1: pi, omp and the Claude Code plugin stop through RootDelivery, which shuts the session down
// (queued behind the start) before it closes: the shutdown itself ends the start's wire, and its release still runs.
test.each(modes.flatMap(mode => (["enroll", "enroll with a name", "resume"] as const).map(how => [mode, how] as const)))("shutdown then close ends a start's wire still connecting at once and still releases (#1294, %s, %s)", async (mode, how) => {
  const r = runtime(mode);
  if (how === "resume") { await r.controller.enroll("R", ["be"], true); await until(() => r.root(r.controller)?.state === "active"); await r.controller.close(); }
  const c = how === "resume" ? r.make() : r.controller;
  r.hangConnect(1);
  const starting = how === "resume" ? c.resume("R") : c.enroll("R", how === "enroll" ? [] : ["be"], true);
  await until(() => r.connecting === 1);
  const began = performance.now();
  await c.shutdown("R", "release");
  await c.close();
  expect(performance.now() - began).toBeLessThan(1000);
  expect((await starting).state).not.toBe("retrying");
  expect(r.named("session_end").length).toBe(1);
  expect(r.named("delivery_open")).toHaveLength(how === "resume" ? 1 : 0);
});

test.each(modes)("resume rebinds only the remembered holds the server lost, and skips one it now refuses (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be", "fe"], true);
  await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 2);
  await r.controller.close();
  // The server lost fe but kept be (a partial loss); the remembered set also names a hold now refused.
  r.rows.get("R")!.held = ["you@example.com/be"];
  (r.storage.get("rememberedHeld:R") as { held: string[] }).held.push("you@example.com/gone");
  const restarted = r.make(), binds = r.named("bind").length;
  try {
    await restarted.resume("R");
    await until(() => r.root(restarted)?.state === "active");
    expect(r.named("bind").slice(binds).map(c => c.args.name)).toEqual(["you@example.com/fe", "you@example.com/gone"]);
    expect(r.root(restarted)).toMatchObject({ held: ["you@example.com/be", "you@example.com/fe"] });
  } finally { await restarted.close(); }
});

test.each(modes)("a drift from a watch already disposed (a check in flight when resume replaced the root) pauses nothing (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    const stale = r.drifts.at(-1)!;
    await r.controller.resume("R");
    await until(() => r.root(r.controller)?.state === "active");
    stale();
    expect(r.root(r.controller)).toMatchObject({ state: "active", held: ["you@example.com/be"] });
    // The live root's own watch still pauses it.
    r.drift();
    expect(r.root(r.controller)).toMatchObject({ state: "paused" });
  } finally { await r.controller.close(); }
});

test.each(modes)("carried() is the holds a resume would rebind now: none once the grant changed (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    expect(await r.controller.carried("R")).toEqual(["you@example.com/be"]);
    expect(await r.controller.carried("B")).toBeUndefined();
    r.drift();
    expect(await r.controller.carried("R")).toBeUndefined();
  } finally { await r.controller.close(); }
});

test.each(modes)("pause releases ownership and keeps every root paused (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.pause();
    expect(r.named("delivery_release").map(c => c.sessionID)).toEqual(["R"]);
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["R"]);
    expect(r.root(r.controller)).toMatchObject({ state: "paused", message: "Ownership ended; run /grayboard resume" });
    expect(r.rows.has("R")).toBe(false);
    if (mode === "approval") expect(r.approvals.get("R")?.enabled).toBe(false);
  } finally { await r.controller.close(); }
});

test.each(modes.flatMap(mode => (["release", "detach"] as const).map(how => [mode, how] as const)))("shutdown %s/%s", async (mode, how) => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.shutdown("R", how);
    expect(r.root(r.controller)).toMatchObject({ state: "paused", message: how === "release" ? "Session shut down; ownership released" : "Session detached; lease retained for reload" });
    expect(r.named("session_end")).toHaveLength(how === "release" ? 1 : 0);
    expect(r.named("delivery_release")).toHaveLength(how === "release" ? 1 : 0);
    expect(r.rows.has("R")).toBe(how === "detach");
    const opens = r.named("delivery_open").length;
    await r.controller.afterCall({ sessionID: "R", tool: "dm_send", result: { status: "completed", output: { unbound: true } } });
    expect(r.named("delivery_open")).toHaveLength(opens);
  } finally { await r.controller.close(); }
});

test.each(modes)("credential drift pauses every root until it is resumed (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await r.controller.enroll("B", ["fe"], true);
    await until(() => r.root(r.controller, "B")?.state === "active" && r.root(r.controller)?.state === "active");
    r.drift();
    for (const id of ["R", "B"]) expect(r.root(r.controller, id)).toMatchObject({ state: "paused", message: "Grayboard credential changed; run /grayboard resume" });
    expect(r.storage.get("paused:R")).toBe(true);
    if (mode === "approval") {
      await r.controller.enroll("R");
      await until(() => r.root(r.controller)?.state === "active");
    } else {
      await r.controller.resume("R");
      await until(() => r.root(r.controller)?.state === "active");
    }
    expect(r.root(r.controller, "B")).toMatchObject({ state: "paused" });
  } finally { await r.controller.close(); }
});

// The pi logout race: the server closes the stream of a revoked grant at
// once, so the run loop's own credential check sees the change before any
// watch ticks. It is the same drift, not one root's generic failure.
test.each(modes)("a credential change the run loop's check sees before any watch pauses every root as the watch's drift does (%s)", async mode => {
  const r = runtime(mode);
  const c = r.make({ wait: async () => {} });
  try {
    await c.enroll("R", ["be"], true);
    await c.enroll("B", ["fe"], true);
    await until(() => r.root(c, "B")?.state === "active" && r.root(c)?.state === "active");
    r.revoke("R");
    await until(() => r.root(c)?.state === "paused");
    for (const id of ["R", "B"]) expect(r.root(c, id)).toMatchObject({ state: "paused", message: "Grayboard credential changed; run /grayboard resume" });
    expect(r.storage.get("paused:B")).toBe(true);
  } finally { await c.close(); await r.controller.close(); }
});

test.each(modes)("an ended root releases ownership; an ended child ends only its own registration (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    await r.controller.ended("C");
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["C"]);
    expect(r.root(r.controller)).toMatchObject({ state: "active" });
    await r.controller.ended("R");
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["C", "R"]);
    expect(r.named("delivery_release").map(c => c.sessionID)).toEqual(["R"]);
    expect(r.root(r.controller)).toMatchObject({ state: "paused", message: "Root ended; ownership released" });
    expect(r.storage.get("paused:R")).toBe(true);
    await r.controller.ended("R");
    expect(r.named("session_end")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

test.each(modes)("child registration runs on the root's wire before the child's call, with via only below a direct child (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    await r.controller.beforeCall({ sessionID: "G", tool: "dm_send" });
    expect(r.named("session_register")).toEqual([
      { sessionID: "R", name: "session_register", args: { child: "C" } },
      { sessionID: "R", name: "session_register", args: { child: "G", via: ["C"] } },
    ]);
    r.nodes.delete("C");
    await expect(r.controller.beforeCall({ sessionID: "G", tool: "dm_send" })).rejects.toThrow("ancestry");
    expect(r.named("session_register")).toHaveLength(2);
    await r.controller.beforeCall({ sessionID: "R", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

test.each(modes)("childRoot resolves a descendant of an enrolled, unpaused root once, and nothing for a root, an unenrolled or paused root, or a missing session (#535) (%s)", async mode => {
  const r = runtime(mode);
  try {
    expect(await r.controller.childRoot("C")).toBeUndefined();
    // A lookup isn't a route: ending a session the server never saw sends nothing.
    expect(await r.controller.childRoot("B")).toBeUndefined();
    await r.controller.ended("B");
    expect(r.named("session_end")).toEqual([]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    expect(await r.controller.childRoot("R")).toBeUndefined();
    expect(await r.controller.childRoot("missing")).toBeUndefined();
    expect(await r.controller.childRoot("G")).toEqual({ sessionID: "G", root: "R", via: ["C"] });
    // Resolved once: the route stays when OpenCode no longer has the session.
    r.nodes.delete("C");
    expect(await r.controller.childRoot("G")).toEqual({ sessionID: "G", root: "R", via: ["C"] });
    await r.controller.pause();
    expect(await r.controller.childRoot("G")).toBeUndefined();
  } finally { await r.controller.close(); }
});

test.each(modes)("a descendant that ends while its registration is in flight ends the row it made and isn't routed (#535) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    const enlisting = r.controller.enlist({ sessionID: "C", root: "R", via: [] });
    await r.controller.ended("C");
    await expect(enlisting).rejects.toThrow("ended during registration");
    expect(r.named("session_register").map(c => c.args)).toEqual([{ child: "C" }]);
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["C"]);
    expect(await r.controller.childRoot("C")).toBeUndefined();
  } finally { await r.controller.close(); }
});

// #567: under an enrolled root, a child's calls and instructions fetches share one registration, in flight or
// done, until the root's epoch moves (here a pause).
test.each(modes)("a child's calls and fetches share one registration until its root's epoch moves (#567) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await Promise.all([r.controller.beforeCall({ sessionID: "C", tool: "dm_send" }), r.controller.enlist({ sessionID: "C", root: "R", via: [] }, true)]);
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(1);
    await r.controller.pause();
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

// #567: a call that joined a registration in flight which then fails (an older request's deadline, spent at a held
// bind gate) registers once on its own instead of failing with it.
test.each(modes)("a call whose joined registration fails registers once on its own (#567) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    let fail!: (error: Error) => void;
    r.holdRegister(new Promise<void>((_, reject) => { fail = reject; }));
    const fetching = r.controller.enlist({ sessionID: "C", root: "R", via: [] }, true);
    await until(() => r.named("session_register").length === 1);
    const calling = r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    r.holdRegister();
    fail(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"));
    await expect(fetching).rejects.toThrow("timed out");
    await calling;
    expect(r.named("session_register")).toHaveLength(2);
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

// #1176: a joined registration's failure the request's own fault may explain (an outage, a deadline however it
// surfaced, a refresh another process held, the server's `unbound`) is retried once; a refusal or a sign-in, which the
// retry would meet too, stands with exactly one registration.
const CHILD = { sessionID: "C", root: "R", via: [] };
// The instructions fetch starts the registration; a call joins it; the registration then fails with `error`, and
// the call's own retry, if any, with `retry` (or succeeds).
async function joinedFailure(r: ReturnType<typeof runtime>, c: Controller, error: unknown, retry?: Error) {
  let fail!: (error: unknown) => void;
  r.holdRegister(new Promise<void>((_, reject) => { fail = reject; }));
  const fetching = c.enlist(CHILD, true);
  await until(() => r.named("session_register").length === 1);
  const calling = c.enlist(CHILD);
  const again = retry ? Promise.reject(retry) : undefined;
  again?.catch(() => {});
  r.holdRegister(again);
  fail(error);
  return Promise.allSettled([fetching, calling]);
}
const deterministic: [string, () => unknown][] = [
  // The server's session_register refusals, as the wire makes them: each keeps its own code (#1349).
  ...["child_bound", "child_registered_elsewhere", "has_children", "root_is_child", "invalid_registration"].map(code => [code, () => subscriberError({ code }, false)] as [string, () => unknown]),
  ["forbidden", () => subscriberError({ code: "forbidden" }, false)],
  ["AccessExpired", () => new AccessExpired("pi", "run /grayboard login", "login_required")],
  ["AccessExpired, wrapped by connect", () => new Error("Version negotiation probe failed", { cause: new AccessExpired("pi", "run /grayboard login", "expired") })],
  ["auth Refusal", () => new Refusal("auth", "unauthorized")],
  ["invalid response", () => new Error("Invalid delivery response")],
];
const transient: [string, () => unknown][] = [
  ["ServerUnreachable", () => new ServerUnreachable(Object.assign(new Error("reset"), { code: "ECONNRESET" }))],
  ["OutcomeUnknown", () => new OutcomeUnknown(new Error("socket closed"))],
  ["SDK request timeout", () => new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")],
  ["wire deadline", () => new SdkError(SdkErrorCode.RequestTimeout, String(new DOMException("The operation timed out.", "TimeoutError")))],
  ["abort TimeoutError", () => new DOMException("The operation timed out.", "TimeoutError")],
  ["RefreshInProgress, wrapped by connect", () => new Error("Version negotiation probe failed", { cause: new RefreshInProgress("pi") })],
  ["unbound", () => subscriberError({ code: "unbound" }, false)],
];
test.each(modes)("a joined registration's refusal stands; its transient failure is retried once (#1176) (%s)", async mode => {
  for (const [kind, cases] of [["deterministic", deterministic], ["transient", transient]] as const) {
    for (const [name, make] of cases) {
      const r = runtime(mode);
      try {
        await r.controller.enroll("R", ["be"], true);
        await until(() => r.root(r.controller)?.state === "active");
        const error = make();
        const [fetching, calling] = await joinedFailure(r, r.controller, error);
        expect([name, fetching]).toEqual([name, { status: "rejected", reason: error }]);
        expect([name, calling]).toEqual([name, kind === "deterministic" ? { status: "rejected", reason: error } : { status: "fulfilled", value: undefined }]);
        expect([name, r.named("session_register").length]).toEqual([name, kind === "deterministic" ? 1 : 2]);
      } finally { await r.controller.close(); }
    }
  }
});

// #1176: a retry that fails too reports one child_register failure, for the call; the fetch it joined reports none.
// A retry that succeeds leaves no degraded record.
test.each(modes)("a joined registration's retry reports one failure when it fails too, none when it succeeds (#1176) (%s)", async mode => {
  for (const outcome of ["fails", "succeeds"] as const) {
    const r = runtime(mode);
    const records: { state: string; operation: string }[] = [];
    const c = r.make({ sink: record => { records.push({ state: record.state, operation: record.operation }); } });
    try {
      await c.enroll("R", ["be"], true);
      await until(() => r.root(c)?.state === "active");
      const first = new ServerUnreachable(new Error("reset")), second = new ServerUnreachable(new Error("reset again"));
      const [fetching, calling] = await joinedFailure(r, c, first, outcome === "fails" ? second : undefined);
      expect(fetching).toEqual({ status: "rejected", reason: first });
      expect(calling).toEqual(outcome === "fails" ? { status: "rejected", reason: second } : { status: "fulfilled", value: undefined });
      expect(r.named("session_register")).toHaveLength(2);
      await c.flushDiagnostics();
      expect(records.filter(x => x.operation === "child_register")).toEqual(outcome === "fails" ? [{ state: "degraded", operation: "child_register" }] : []);
      expect(records.filter(x => x.state === "degraded")).toHaveLength(outcome === "fails" ? 1 : 0);
      if (outcome === "succeeds") expect(r.root(c)).toMatchObject({ state: "active" });
    } finally { await c.close(); await r.controller.close(); }
  }
});

// #1176: two calls that joined one failed registration share one retry: two registrations in all, not three.
test.each(modes)("two calls whose joined registration fails share one retry (#1176) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    let fail!: (error: unknown) => void;
    r.holdRegister(new Promise<void>((_, reject) => { fail = reject; }));
    const fetching = r.controller.enlist(CHILD, true);
    await until(() => r.named("session_register").length === 1);
    const calls = [r.controller.enlist(CHILD), r.controller.enlist(CHILD)];
    r.holdRegister();
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
    fail(timeout);
    expect(await Promise.allSettled([fetching, ...calls])).toEqual([{ status: "rejected", reason: timeout }, { status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    expect(r.named("session_register")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

// #567 audit: the retry happens only while nothing the call registers under has moved: a root paused, or a child
// ended, while the joined registration was held fails the call with it rather than starting an ownership nothing ends.
test.each(modes)("a call whose joined registration fails after its root paused or its child ended doesn't register again (#567) (%s)", async mode => {
  for (const move of ["pause", "end"] as const) {
    const r = runtime(mode);
    try {
      await r.controller.enroll("R", ["be"], true);
      await until(() => r.root(r.controller)?.state === "active");
      let fail!: (error: Error) => void;
      r.holdRegister(new Promise<void>((_, reject) => { fail = reject; }));
      const fetching = r.controller.enlist({ sessionID: "C", root: "R", via: [] }, true);
      await until(() => r.named("session_register").length === 1);
      const calling = r.controller.enlist({ sessionID: "C", root: "R", via: [] });
      r.holdRegister();
      if (move === "pause") await r.controller.pause(); else await r.controller.ended("C");
      // A deadline, which unmoved would retry (#1176).
      const timeout = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
      fail(timeout);
      const out = await Promise.allSettled([fetching, calling]);
      expect(out.map(o => o.status === "rejected" && o.reason)).toEqual([timeout, timeout]);
      expect(r.named("session_register")).toHaveLength(1);
    } finally { await r.controller.close(); }
  }
});

// #567 audit: the server's end of a root's ownership (a lapsed lease, an idle sweep) deletes its child rows without
// moving the root's epoch: a run loop that reopens under a new ownership invalidates the remembered registration,
// as does a child call the server answers unbound.
test.each(modes)("a child registers again after its root's ownership changes under it, or after a call answered unbound (#567) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    const before = r.root(r.controller)?.ownership;
    r.rows.delete("R"); r.closeStream("R");
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.ownership !== before);
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(2);
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(2);
    await r.controller.afterCall({ sessionID: "C", tool: "dm_send", result: { status: "completed", output: { unbound: true } } });
    await r.controller.beforeCall({ sessionID: "C", tool: "dm_send" });
    expect(r.named("session_register")).toHaveLength(3);
  } finally { await r.controller.close(); }
});

// #567: a pause whose release lands before a fetch's registration: that registration started the root's key a
// new ownership, so the fetch ends it and the child's row, and gives up.
test.each(modes)("an instructions fetch whose root pauses while it registers ends the rows it made (#567) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    let release!: () => void;
    r.holdRegister(new Promise<void>(resolve => { release = resolve; }));
    const enlisting = r.controller.enlist({ sessionID: "C", root: "R", via: [] }, true);
    await until(() => r.named("session_register").length === 1);
    await r.controller.pause();
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["R"]);
    release();
    await expect(enlisting).rejects.toThrow("paused during registration");
    expect(r.named("session_end").map(c => c.sessionID)).toEqual(["R", "C", "R"]);
    expect(await r.controller.childRoot("C")).toBeUndefined();
  } finally { await r.controller.close(); }
});

// #567 audit: a pause that keeps the ownership (a drift) released nothing, so a fetch registering through it ends no row.
test.each(modes)("an instructions fetch whose root drifts while it registers ends no row (#567) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    let release!: () => void;
    r.holdRegister(new Promise<void>(resolve => { release = resolve; }));
    const enlisting = r.controller.enlist({ sessionID: "C", root: "R", via: [] }, true);
    await until(() => r.named("session_register").length === 1);
    r.drift();
    await until(() => r.root(r.controller)?.state === "paused");
    release();
    await enlisting;
    expect(r.named("session_end")).toEqual([]);
  } finally { await r.controller.close(); }
});

// #567: a new root's configured bind reuses the ancestry `session.created`'s lookup just resolved.
test.each(modes)("a configured bind after a lookup resolves ancestry once (#567) (%s)", async mode => {
  const r = runtime(mode);
  const c = r.make({ configured: { name: "be", create: false } });
  try {
    expect(await c.childRoot("B")).toBeUndefined();
    await c.configuredBind("B");
    expect(r.ancestries.filter(id => id === "B")).toHaveLength(1);
    expect(r.named("bind").map(call => call.sessionID)).toEqual(["B"]);
  } finally { await c.close(); await r.controller.close(); }
});

test.each(modes)("a root's bind stops delivery before the call and reopens under the new name after it (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.beforeCall({ sessionID: "R", tool: "bind" });
    expect(r.root(r.controller)).toMatchObject({ state: "rebinding", operation: "before_bind" });
    r.rows.set("R", { held: ["you@example.com/be", "you@example.com/fe"], ownership: r.rows.get("R")!.ownership, generation: r.rows.get("R")!.generation + 1 });
    await r.controller.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "fe", ownership: r.rows.get("R")!.ownership, instructions: ["bound"] } } });
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 2);
    expect(r.storage.get("rememberedHeld:R")).toMatchObject({ held: ["you@example.com/be", "you@example.com/fe"] });
    await r.controller.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "fe" } } });
    expect(r.root(r.controller)).toMatchObject({ state: "approved", operation: "after" });
  } finally { await r.controller.close(); }
});

test.each(modes)("five rebinds in a row each reopen delivery: a bind restarts the run, so lease recovery never accumulates across rebinds (#250) (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    const opens = r.named("delivery_open").length;
    for (let i = 1; i <= 5; i++) {
      await r.controller.beforeCall({ sessionID: "R", tool: "bind" });
      const row = r.rows.get("R")!;
      r.rows.set("R", { ...row, generation: row.generation + 1 });
      await r.controller.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "be", ownership: row.ownership, instructions: ["bound"] } } });
      await until(() => r.root(r.controller)?.state === "active" && r.named("delivery_open").length === opens + i);
    }
  } finally { await r.controller.close(); }
});

test.each(modes)("an unbound result from any tool rebinds the remembered name (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    r.rows.delete("R");
    const binds = r.named("bind").length;
    await r.controller.afterCall({ sessionID: "R", tool: "dm_send", result: { status: "completed", output: { unbound: true } } });
    await until(() => r.root(r.controller)?.state === "active");
    expect(r.named("bind").slice(binds).map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
    const after = r.named("bind").length;
    await r.controller.afterCall({ sessionID: "R", tool: "dm_send", result: { status: "error" } });
    expect(r.named("bind")).toHaveLength(after);
  } finally { await r.controller.close(); }
});

// #1325 reverify: afterCall's delivery restart is one more start path. A native bind (whatever its status), or a tool
// result that says unbound, restarts delivery through prepare; a sign-out there pauses the root rather than recording it approved.
test.each(modes.flatMap(mode => (["bind", "dm_send"] as const).map(tool => [mode, tool] as const)))("afterCall's delivery restart pauses its root on a sign-out (#1325, %s, %s)", async (mode, tool) => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active");
    const opens = r.named("delivery_open").length;
    r.failWhoami(() => new AccessExpired("pi", "run /grayboard login", "login_required"));
    const output = tool === "bind" ? { name: "be", ownership: r.rows.get("R")!.ownership, instructions: ["bound"] } : { unbound: true };
    await r.controller.afterCall({ sessionID: "R", tool, result: { status: "completed", output } });
    expect(r.root(r.controller)).toMatchObject({ state: "paused", operation: "after", code: "login_required" });
    expect(r.named("delivery_open")).toHaveLength(opens);
  } finally { await r.controller.close(); }
});

test.each(modes)("a receipt that fails once leaves the item admitted once and receipted on the next read (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.failReceipt(1);
    r.batches.set("R", [r.item("direct:1"), r.item("direct:2")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "direct:2"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"], ["direct:2"]]);
  } finally { await r.controller.close(); }
});

test.each(modes)("a receipt hook that throws: each receipt still commits once, the root isn't paused, the sink names the hook (%s)", async mode => {
  const r = runtime(mode);
  const records: { state: string; operation: string; sessionID?: string }[] = [];
  const c = r.make({ sink: record => { records.push({ ...record }); } });
  const hooked: [string, string[]][] = [];
  r.onReceipted((sessionID, ids) => { hooked.push([sessionID, [...ids]]); throw new Error("session file gone"); });
  try {
    r.batches.set("R", [r.item("direct:1"), r.item("direct:2")]);
    await c.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0 && hooked.length === 2, 10_000);
    expect(hooked).toEqual([["R", ["direct:1"]], ["R", ["direct:2"]]]);
    // Neither item replayed, nor the lease reopened: the loop never saw the throw.
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "direct:2"]);
    expect(r.named("delivery_receipt").map(x => x.args.ids)).toEqual([["direct:1"], ["direct:2"]]);
    expect(r.named("delivery_open")).toHaveLength(1);
    // Reported, not paused: the last record is the hook's, and delivery goes on.
    expect(r.root(c)).toMatchObject({ state: "degraded", operation: "receipt_hook" });
    expect(records.filter(x => x.operation === "receipt_hook")).toEqual([
      expect.objectContaining({ state: "degraded", sessionID: "R" }),
      expect.objectContaining({ state: "degraded", sessionID: "R" }),
    ]);
  } finally { await c.close(); await r.controller.close(); }
});

// One item costs one renew before admission and its receipt: no renew sits between admission and receipt,
// since the server's receipt checks the lease itself (#845).
test.each(modes)("an item's delivery calls are one renew then its receipt (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.batches.set("R", [r.item("direct:1"), r.item("direct:2")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.calls.filter(c => c.name.startsWith("delivery_")).map(c => c.name)).toEqual(["delivery_open", "delivery_renew", "delivery_receipt", "delivery_renew", "delivery_receipt"]);
  } finally { await r.controller.close(); }
});

// A receipt that finds the lease gone still belongs to its item: it spends the item's attempt budget, not
// the lease-recovery budget, which would pause the root after 3.
test.each(modes)("receipts that keep losing the lease stop at the item's attempt budget, not the recovery limit (%s)", async mode => {
  const r = runtime(mode);
  const c = r.make({ wait: async () => {} });
  try {
    r.loseReceipts();
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "paused", 10_000);
    expect(r.root(c)?.message).toStartWith("Retry limit reached for direct:1; item remains unreceipted");
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    expect(r.named("delivery_receipt")).toHaveLength(8);
  } finally { await c.close(); await r.controller.close(); }
});

// The receipt is the first call after the host accepted the item.
test.each(modes)("a receipt that fails once (an outage) shows the item once and receipts it after reconnecting (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.failReceiptAt(1, () => new ServerUnreachable(new Error("blip")));
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"]]); // the refused one, then the one that commits
    expect(r.named("delivery_open")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

test.each(modes)("a receipt that loses the lease: the next lease of the same bind_gen receipts without admitting again (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.failReceiptAt(1, () => new LeaseUnavailable());
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"]]); // the refused one, then the one that commits
    expect(r.named("delivery_open")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

// The real-host expiry case: an admitted key skips only the admission, so a
// lease that can never renew spends the item's attempt budget and never
// receipts the admission it couldn't prove.
test.each(modes)("a lease that can't renew after admission never commits its receipt and stops at the attempt budget (%s)", async mode => {
  const r = runtime(mode);
  const c = r.make({ wait: async () => {} });
  try {
    r.loseLeaseAfterRenew(1);
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "paused", 10_000);
    expect(r.root(c)?.message).toStartWith("Retry limit reached for direct:1; item remains unreceipted");
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    // The one receipt tried, under the lease that lapsed during admission, was refused; none commits.
    expect(r.named("delivery_receipt")).toHaveLength(1);
    expect(r.batches.get("R")).toHaveLength(1);
  } finally { await c.close(); await r.controller.close(); }
});

test.each(modes)("a lease lost after admission whose next lease has a new bind_gen admits the item again under it (%s)", async mode => {
  const r = runtime(mode);
  try {
    // The name was rebound meanwhile: the next lease and its inbox carry bind_gen 2.
    r.failReceiptAt(1, () => new LeaseUnavailable(), () => {
      const row = r.rows.get("R")!;
      r.rows.set("R", { held: row.held, ownership: row.ownership, generation: row.generation + 1 });
      r.batches.set("R", [{ ...r.item("direct:1"), bind_gen: 2 }]);
    });
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "direct:1"]);
    expect(r.admits[1]!.id).toBe(r.admits[0]!.id);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"]]); // the refused one, then the one that commits
  } finally { await r.controller.close(); }
});

test.each(modes)("a refresh another process holds is retried like an outage, past the retry budget, and never pauses (%s)", async mode => {
  const r = runtime(mode);
  const waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    r.refreshBusy(12);
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(waits).toEqual([500, 1000, 2000, 4000, ...Array(8).fill(8000)]);
    expect(r.root(c)).toMatchObject({ state: "active", failure: { operation: "reopen", code: "refresh_in_progress" } });
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
  } finally { await c.close(); await r.controller.close(); }
});

// #472: a host that rotates its own access token (OpenCode's native grant)
// does so at or just after expiry, up to ~1.5 s after the server closed the
// stream for it. Virtual time is the backoff waited since that close.
test.each(modes)("an `expired` access token at a stream close is polled until the host rotates it: same ownership, no budget spent (%s)", async mode => {
  const r = runtime(mode), waits: number[] = [];
  let elapsed = 0;
  const c = r.make({ wait: async ms => { waits.push(ms); if ((elapsed += ms) >= 1500) r.expireAccess(); } });
  try {
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "active");
    const ownership = r.root(c)?.ownership;
    r.batches.set("R", [r.item("direct:1")]);
    r.expireAccess("expired"); r.closeStream("R");
    await until(() => r.batches.get("R")?.length === 0);
    // The close's own backoff, then 500 ms rotation polls; a spent failure would back off 1000 ms.
    expect(waits).toEqual([500, 500, 500]);
    expect(r.root(c)).toMatchObject({ state: "active", ownership, failure: { operation: "reopen", code: "native_access_expired" } });
    expect(r.named("delivery_open")).toHaveLength(2);
    expect(r.named("bind")).toHaveLength(1);
  } finally { await c.close(); await r.controller.close(); }
});

// #661: past the grace the root stays paused, `native_access_expired`, while it asks the host to refresh and re-reads
// the stored token on a backoff capped at 30 s, for an hour of waits. Waiting makes no server request.
const GRACE = Array(21).fill(500), RECOVERY = [1000, 2000, 4000, 8000, 16000, ...Array(119).fill(30_000)];
test.each(modes)("an `expired` access token the host never rotates pauses after the 10 s grace, then waits for the refresh on a capped backoff without a request (%s)", async mode => {
  const r = runtime(mode), waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "active");
    const before = r.calls.length;
    r.expireAccess("expired"); r.closeStream("R");
    await until(() => r.root(c)?.message.startsWith("Access still expired after an hour") === true);
    expect(waits).toEqual([...GRACE, ...RECOVERY]);
    expect(RECOVERY.reduce((a, b) => a + b)).toBeGreaterThanOrEqual(3_600_000);
    // One refresh request per attempt; the port acts at most once per expiry.
    expect(r.refreshes).toBe(RECOVERY.length);
    expect(r.root(c)).toMatchObject({ state: "paused", operation: "recover", code: "native_access_expired" });
    expect(r.calls.slice(before).map(c => c.name)).toEqual([]);
    expect(r.named("delivery_open")).toHaveLength(1);
  } finally { await c.close(); await r.controller.close(); }
});
// #481: an expiry after a healthy subscription gets the whole grace: the subscription's own time (here a 1 s admit)
// is no part of it, so the polls number as many as an expiry at the open's.
test.each(modes)("an expiry after a long healthy subscription gets the full rotation grace (%s)", async mode => {
  const r = runtime(mode), waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    r.holdAdmit(() => Bun.sleep(1000));
    r.failReceiptAt(1, () => new AccessExpired("pi", "run /grayboard login", "expired"), () => r.expireAccess("expired"));
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => waits.some(ms => ms >= 1000), 10_000);
    // GRACE less the stream close's own backoff: 20 polls.
    expect(waits.slice(0, waits.findIndex(ms => ms >= 1000))).toEqual(GRACE.slice(1));
  } finally { await c.close(); await r.controller.close(); }
});
// Pauses R on an expired token past the grace; `during(n)` runs at the nth recovery wait.
async function expiredPause(mode: Mode, during: (n: number, r: ReturnType<typeof runtime>, c: Controller) => unknown, roots = ["R"]) {
  const r = runtime(mode), waits: number[] = [], states: { id: string; state: string; operation?: string; code?: string }[] = [];
  let recovering = 0;
  const c: Controller = r.make({
    wait: async ms => { waits.push(ms); if (ms >= 1000) await during(++recovering, r, c); },
    sink: record => { states.push({ id: record.sessionID ?? "", state: record.state, ...(record.operation ? { operation: record.operation } : {}), ...(record.code ? { code: record.code } : {}) }); },
  });
  for (const [index, id] of roots.entries()) { await c.enroll(id, [index ? "fe" : "be"], true); await until(() => r.root(c, id)?.state === "active"); }
  const opened = r.named("delivery_open").length, calls = r.calls.length;
  r.expireAccess("expired");
  for (const id of roots) r.closeStream(id);
  return { r, c, waits, states, opened, after: () => r.calls.slice(calls), recovering: () => recovering };
}
test.each(modes)("a refresh landing after the grace resumes on its own: the remembered holds rebind create:false and a queued message is delivered (%s)", async mode => {
  const o = await expiredPause(mode, (n, r) => {
    // The server ended the ownership meanwhile (its lease lapsed); the refresh lands at the third check.
    if (n === 1) r.rows.delete("R");
    if (n === 3) { r.expireAccess(); r.batches.set("R", [{ ...r.item("direct:1"), ownership: 2 }]); }
  });
  try {
    await until(() => o.r.admits.length === 1);
    await until(() => o.r.root(o.c)?.state === "active");
    expect(o.waits).toEqual([...GRACE, 1000, 2000, 4000]);
    const seen = o.states.map(s => [s.state, s.operation, s.code].join(":"));
    expect(seen).toContain("paused:subscriber:native_access_expired");
    expect(seen).toContain("retrying:recover:");
    expect(seen.indexOf("paused:subscriber:native_access_expired")).toBeLessThan(seen.indexOf("retrying:recover:"));
    expect(o.after().filter(c => c.name === "bind").map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
    expect(o.r.root(o.c)).toMatchObject({ state: "active", ownership: 2, held: ["you@example.com/be"] });
  } finally { await o.c.close(); await o.r.controller.close(); }
});
test.each(modes)("a remembered name another session took meanwhile is recorded alias_held, never taken, and nothing opens (%s)", async mode => {
  const o = await expiredPause(mode, (n, r) => { if (n === 1) { r.rows.delete("R"); r.holdElsewhere("be"); r.expireAccess(); } });
  try {
    await until(() => o.r.root(o.c)?.code === "alias_held");
    expect(o.r.root(o.c)?.state).not.toBe("active");
    expect(o.after().filter(c => c.name === "bind").map(c => c.args.create)).toEqual([false]);
    expect(o.r.named("delivery_open")).toHaveLength(o.opened);
    expect(o.r.rows.get("R")).toBeUndefined();
  } finally { await o.c.close(); await o.r.controller.close(); }
});
for (const [what, act] of [
  ["an explicit pause", async (_r: ReturnType<typeof runtime>, c: Controller) => { await c.pause(); }],
  ["a credential drift", async (r: ReturnType<typeof runtime>) => { r.drift(); }],
  ["a session end", async (_r: ReturnType<typeof runtime>, c: Controller) => { await c.ended("R"); }],
  ["a shutdown", async (_r: ReturnType<typeof runtime>, c: Controller) => { await c.shutdown("R", "detach"); }],
] as const) test.each(modes)(`${what} during the wait ends the recovery: a refresh after it resumes nothing (%s)`, async mode => {
  const o = await expiredPause(mode, async (n, r, c) => { if (n === 1) { await act(r, c); r.expireAccess(); } });
  try {
    await until(() => o.recovering() >= 1);
    // close waits out the recovery's last check.
    await o.c.close();
    expect(o.recovering()).toBe(1);
    expect(o.r.named("delivery_open")).toHaveLength(o.opened);
    expect(o.after().some(c => c.name === "bind" || c.name === "whoami")).toBe(false);
    expect(o.r.root(o.c)?.state).toBe("paused");
    expect(o.r.root(o.c)?.code).toBeUndefined();
  } finally { await o.c.close(); await o.r.controller.close(); }
});
for (const [what, act, code] of [
  ["a sign-out", (r: ReturnType<typeof runtime>) => r.expireAccess("login_required"), "login_required"],
  ["a changed grant", (r: ReturnType<typeof runtime>) => { r.expireAccess(); r.revoke("none"); }, "refused"],
] as const) test.each(modes)(`${what} during the wait is the pause's cause from then on, never resumed (%s)`, async mode => {
  const o = await expiredPause(mode, (n, r) => { if (n === 1) act(r); });
  try {
    await until(() => o.r.root(o.c)?.operation === "recover" || o.r.root(o.c)?.message.startsWith("Grayboard credential changed") === true);
    await o.c.close();
    expect(o.recovering()).toBe(1);
    expect(o.r.root(o.c)?.state).toBe("paused");
    expect(o.r.root(o.c)?.code).not.toBe("native_access_expired");
    if (code === "login_required") expect(o.r.root(o.c)?.code).toBe(code);
    expect(o.r.named("delivery_open")).toHaveLength(o.opened);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
test.each(modes)("two roots awaiting one refresh both resume (%s)", async mode => {
  let landed = false;
  const o = await expiredPause(mode, (n, r) => { if (n === 2 && !landed) { landed = true; r.expireAccess(); } }, ["R", "B"]);
  try {
    await until(() => landed);
    await until(() => ["R", "B"].every(id => o.r.root(o.c, id)?.state === "active"));
    expect(o.r.named("delivery_open").slice(o.opened).map(c => c.sessionID).sort()).toEqual(["B", "R"]);
    expect(o.states.filter(s => s.code === "native_access_expired" && s.state === "paused").map(s => s.id).sort()).toEqual(["B", "R"]);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
test.each(modes)("a native unbind that completes during the wait sets the holds: the recovery never rebinds the name (%s)", async mode => {
  const o = await expiredPause(mode, async (n, r, c) => {
    if (n !== 1) return;
    // The native call's own 401 refreshed the token.
    r.expireAccess();
    await c.beforeCall({ sessionID: "R", tool: "unbind" });
    r.rows.get("R")!.held = [];
    await c.afterCall({ sessionID: "R", tool: "unbind", result: { status: "completed", output: { name: null, ownership: 1, instructions: [] } } });
  });
  try {
    await until(() => o.r.root(o.c)?.state === "unbound");
    await o.c.close();
    expect(o.recovering()).toBe(1);
    expect(o.after().some(c => c.name === "bind")).toBe(false);
    expect(o.r.storage.get("rememberedHeld:R")).toMatchObject({ held: [] });
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// Audit F (#661): the token refreshed while a native unbind is still in flight; a recovery check then must not rebind its name.
test.each(modes)("a recovery check while a native unbind is in flight waits for its completion, never rebinding the name (%s)", async mode => {
  const o = await expiredPause(mode, async (n, r, c) => {
    if (n === 1) {
      // The native call's own 401 refreshed the token, and the unbind committed server-side; afterCall hasn't run.
      r.expireAccess();
      await c.beforeCall({ sessionID: "R", tool: "unbind" });
      r.rows.get("R")!.held = [];
    }
    if (n === 2) await c.afterCall({ sessionID: "R", tool: "unbind", result: { status: "completed", output: { name: null, ownership: 1, instructions: [] } } });
  });
  try {
    await until(() => o.r.root(o.c)?.state === "unbound");
    await o.c.close();
    expect(o.recovering()).toBe(2);
    expect(o.after().some(c => c.name === "bind")).toBe(false);
    expect(o.r.storage.get("rememberedHeld:R")).toMatchObject({ held: [] });
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// A native bind that fails during the wait sets no holds: the wait goes on, and a later refresh rebinds the remembered name.
test.each(modes)("a native bind that fails during the wait leaves it waiting; a later refresh resumes the remembered holds (%s)", async mode => {
  const o = await expiredPause(mode, async (n, r, c) => {
    if (n === 1) {
      await c.beforeCall({ sessionID: "R", tool: "bind" });
      await c.afterCall({ sessionID: "R", tool: "bind", result: { status: "error" } });
    }
    if (n === 2) { r.rows.delete("R"); r.expireAccess(); }
  });
  try {
    await until(() => o.recovering() >= 2 && o.r.root(o.c)?.state === "active");
    expect(o.waits).toEqual([...GRACE, 1000, 2000]);
    expect(o.states).toContainEqual({ id: "R", state: "paused", operation: "after", code: "native_access_expired" });
    expect(o.after().filter(c => c.name === "bind").map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
    expect(o.r.root(o.c)).toMatchObject({ state: "active", held: ["you@example.com/be"] });
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// A drift clears the wait; a later enroll of another root clears the controller's drift, which must not revive it.
test.each(modes)("a drift during the wait ends it even after another root enrolls: a refresh then resumes nothing (%s)", async mode => {
  const o = await expiredPause(mode, async (n, r, c) => { if (n === 1) { r.drift(); r.expireAccess(); await c.enroll("B", ["fe"], true); } });
  try {
    await until(() => o.r.root(o.c, "B")?.state === "active");
    await o.c.close();
    expect(o.recovering()).toBe(1);
    expect(o.r.named("delivery_open").filter(c => c.sessionID === "R")).toHaveLength(o.opened);
    expect(o.r.root(o.c)?.state).toBe("paused");
    expect(o.r.root(o.c)?.message.startsWith("Grayboard credential changed")).toBe(true);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// The recovery opens delivery, which expires again before it is active: the next wait carries the backoff on.
test.each(modes)("a recovery whose delivery expires again before it opens keeps its backoff (%s)", async mode => {
  const o = await expiredPause(mode, (n, r) => {
    if (n === 2) { r.expireAccess(); r.beforeOpen(() => { r.expireAccess("expired"); throw new AccessExpired("pi", "run /grayboard login", "expired"); }); }
    if (n === 4) r.expireAccess();
  });
  try {
    await until(() => o.recovering() >= 4 && o.r.root(o.c)?.state === "active");
    expect(o.waits.filter(ms => ms >= 1000)).toEqual([1000, 2000, 4000, 8000]);
    expect(o.r.named("delivery_open").length).toBeGreaterThan(o.opened + 1);
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// A host whose check() reads the expiry (OpenCode V2) fails restore's own check: that branch waits too.
test("a reload whose restore check still sees the expiry waits for the refresh and resumes (#661)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    o.r.checkSeesAccess();
    let polls = 0;
    const restarted = o.r.make({ wait: async ms => { if (ms >= 1000 && ++polls === 2) o.r.expireAccess(); } });
    try {
      await restarted.restore();
      await until(() => o.r.root(restarted)?.state === "active");
      expect(polls).toBe(2);
      expect(o.r.root(restarted)).toMatchObject({ state: "active", held: ["you@example.com/be"] });
    } finally { await restarted.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});
test("a reload during the wait restores the root into the same wait, which a later refresh resumes (#661)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    expect(o.r.root(o.c)).toMatchObject({ state: "paused", code: "native_access_expired" });
    let polls = 0;
    const restarted = o.r.make({ wait: async ms => { if (ms >= 1000 && ++polls === 2) o.r.expireAccess(); } });
    try {
      await restarted.restore();
      await until(() => o.r.root(restarted)?.state === "active");
      expect(polls).toBe(2);
      expect(o.r.root(restarted)).toMatchObject({ state: "active", held: ["you@example.com/be"] });
    } finally { await restarted.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});

// #481: the grace stops LEASE_MARGIN_MS (2 s) before the deadline the last renew reported, whatever the 10 s cap
// leaves: a lease with less than that left gets no rotation polls, and the root goes straight to the refresh wait.
test.each(modes)("a renew's deadline inside the lease margin ends the rotation grace at once (%s)", async mode => {
  const r = runtime(mode), waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    // The open's deadline is 30 s out; the item's renew reports one 1 s out.
    r.renewExpiresAt(() => Date.now() + 1_000);
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => r.batches.get("R")?.length === 0);
    r.expireAccess("expired"); r.closeStream("R");
    await until(() => r.root(c)?.message.startsWith("Access still expired after an hour") === true);
    // The close's own backoff, then the refresh wait: none of the grace's 20 polls.
    expect(waits).toEqual([500, ...RECOVERY]);
    expect(r.root(c)).toMatchObject({ state: "paused", code: "native_access_expired" });
  } finally { await c.close(); await r.controller.close(); }
});
// #481: an idle subscription's periodic renew (no item in flight) also moves the deadline the grace stops before.
test.each(modes)("an idle renew's deadline inside the lease margin ends the rotation grace at once (%s)", async mode => {
  const r = runtime(mode), waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "active");
    // The renew reports a deadline 1 s out in real time; the clock jumps past the 10 s renew interval to send it.
    const deadline = Date.now() + 1_000;
    r.renewExpiresAt(() => deadline);
    setSystemTime(new Date(Date.now() + 11_000));
    await until(() => r.named("delivery_renew").length === 1);
    setSystemTime();
    r.expireAccess("expired"); r.closeStream("R");
    await until(() => r.root(c)?.message.startsWith("Access still expired after an hour") === true);
    expect(waits).toEqual([500, ...RECOVERY]);
  } finally { setSystemTime(); await c.close(); await r.controller.close(); }
});
// #481 item 14: a reload whose check fails for another cause after an expiry pause records that cause's code. A
// failure that isn't a refusal is no pause: the restart after it checks again and resumes.
test("a restore check that fails for a non-expiry cause after an expiry pause records its own code (#481)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    o.r.expireAccess(); o.r.failCheck(() => new Error("disk gone"));
    const restarted = o.r.make({ wait: async () => {} });
    try {
      await restarted.restore();
      expect(o.r.root(restarted)).toMatchObject({ state: "degraded", operation: "restore", code: "operation_failed" });
    } finally { await restarted.close(); }
    o.r.failCheck();
    const again = o.r.make({ wait: async () => {} });
    try {
      await again.restore();
      await until(() => o.r.root(again)?.state === "active");
    } finally { await again.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// The same, for a refusal: another account's grant is the pause's cause, and a restart leaves it paused.
test("a restore check refused after an expiry pause pauses with the refusal's code (#481)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    o.r.expireAccess(); o.r.failCheck(() => new Refusal("auth", "another account"));
    const restarted = o.r.make({ wait: async () => {} });
    try {
      await restarted.restore();
      expect(o.r.root(restarted)).toMatchObject({ state: "paused", operation: "restore" });
    } finally { await restarted.close(); }
    o.r.failCheck();
    const again = o.r.make({ wait: async () => {} });
    try {
      await again.restore();
      expect(o.r.root(again)?.state).toBe("paused");
    } finally { await again.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});
test("a restore that fails outside the expiry branches records a degraded root with the failure's code (#481)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    // The check passes; the prepare's rebind finds the name taken.
    o.r.expireAccess(); o.r.rows.delete("R"); o.r.holdElsewhere("be");
    const restarted = o.r.make({ wait: async () => {} });
    try {
      await restarted.restore();
      await until(() => o.r.root(restarted)?.code === "alias_held");
      expect(o.r.root(restarted)).toMatchObject({ state: "degraded", operation: "restore", code: "alias_held" });
    } finally { await restarted.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// #1334 audit L-1: a restore's prepare finds another process holding the token refresh (processes sharing one grant
// store restarting together): it retries on the outage backoff, as resume's does, rather than degrading.
test("a restore whose prepare finds the token refresh in another process retries on the outage backoff (#1334)", async () => {
  const r = runtime("approval");
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  const busy = Promise.reject(new RefreshInProgress("pi"));
  busy.catch(() => {});
  r.holdPrepare(busy);
  const waits: number[] = [];
  const restarted: Controller = r.make({ wait: async ms => { waits.push(ms); if (waits.length === 2) r.holdPrepare(Promise.resolve()); } });
  try {
    await restarted.restore();
    expect(r.root(restarted)).toMatchObject({ state: "retrying", operation: "restore", code: "refresh_in_progress" });
    await until(() => r.root(restarted)?.state === "active");
    expect(waits).toEqual([500, 1000]);
  } finally { await restarted.close(); }
});
// The same for restore's check after an expiry pause: a refresh in progress there retries too, rather than degrading.
test("a restore check that finds the token refresh in another process after an expiry pause retries (#1334)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    o.r.expireAccess(); o.r.failCheck(() => new RefreshInProgress("pi"));
    const states: string[] = [];
    const restarted = o.r.make({ wait: async () => { o.r.failCheck(); }, sink: record => { states.push(`${record.state}:${record.code ?? ""}`); } });
    try {
      await restarted.restore();
      expect(o.r.root(restarted)).toMatchObject({ state: "retrying", operation: "restore", code: "refresh_in_progress" });
      await until(() => o.r.root(restarted)?.state === "active");
      expect(states.filter(s => s.startsWith("degraded") || s.startsWith("paused"))).toEqual([]);
    } finally { await restarted.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});
// #481 item 15: a close during a restore's rotation poll ends the restore: no credential watch (which nothing would
// dispose) and no prepare after it.
test("a close during a restore's rotation wait refuses the retry: no watch, no prepare (#481)", async () => {
  const o = await expiredPause("approval", () => {});
  try {
    await until(() => o.recovering() >= 1);
    await o.c.close();
    o.r.checkSeesAccess();
    const calls = o.r.calls.length, watches = o.r.drifts.length;
    let polls = 0;
    const restarted: Controller = o.r.make({ wait: async (ms, signal) => {
      if (ms !== 500) return;
      // The first poll: the host shuts down, and the token rotates meanwhile.
      if (++polls === 1) { o.r.expireAccess(); void restarted.close(); }
      if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
    } });
    try {
      await restarted.restore();
      expect(polls).toBe(1);
      expect(o.r.drifts).toHaveLength(watches);
      expect(o.r.calls.slice(calls).map(c => c.name)).toEqual([]);
      expect(o.r.root(restarted)?.state).not.toBe("active");
    } finally { await restarted.close(); }
  } finally { await o.c.close(); await o.r.controller.close(); }
});

// Own-login adapters (pi, omp, Claude Code) refresh 60 s early and end a grant
// only with these reasons: they get no rotation grace.
test.each(modes)("own-login access ends (`login_required`, `refresh_outcome_unknown`) still pause at once, with no rotation polls (%s)", async mode => {
  for (const reason of ["login_required", "refresh_outcome_unknown"] as const) {
    const r = runtime(mode), waits: number[] = [];
    const c = r.make({ wait: async ms => { waits.push(ms); } });
    try {
      await c.enroll("R", ["be"], true);
      await until(() => r.root(c)?.state === "active");
      r.expireAccess(reason); r.closeStream("R");
      await until(() => r.root(c)?.state === "paused");
      expect(waits).toEqual([500]);
      expect(r.root(c)?.code).toBe(reason);
    } finally { await c.close(); await r.controller.close(); }
  }
});

// #444: the per-session stop before the control queue.
// An admit that waits until the run loop's signal aborts.
const heldAdmit = (signals: AbortSignal[]) => (signal: AbortSignal) => {
  signals.push(signal);
  const { promise, reject } = Promise.withResolvers<void>();
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  return promise;
};

test.each(modes)("shutdown aborts the run loop before the control queue; a resume or enroll queued after it refuses (%s)", async mode => {
  const r = runtime(mode);
  try {
    const signals: AbortSignal[] = [];
    r.holdAdmit(heldAdmit(signals));
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", ["be"], true);
    await until(() => signals.length === 1);
    // B's enroll holds the queue in its prepare.
    const gate = Promise.withResolvers<void>();
    r.holdPrepare(gate.promise);
    const blocking = r.controller.enroll("B", ["fe"], true);
    await until(() => r.named("whoami").some(c => c.sessionID === "B"));
    const shutdown = r.controller.shutdown("R", "release");
    expect(signals[0]!.aborted).toBe(true);
    // Bun's `expect(p).rejects` settles `p` on the spot, so capture the errors instead.
    const resumed = r.controller.resume("R").then(() => undefined, (error: Error) => error.message);
    const enrolled = r.controller.enroll("R", ["be"]).then(() => undefined, (error: Error) => error.message);
    gate.resolve();
    await blocking;
    expect(await shutdown).toBeUndefined();
    expect(await resumed).toBe("Grayboard is stopping");
    expect(await enrolled).toBe("Grayboard is stopping");
    expect(r.rows.has("R")).toBe(false);
    expect(r.root(r.controller)).toMatchObject({ state: "paused", message: "Session shut down; ownership released" });
    await until(() => r.root(r.controller, "B")?.state === "active");
    expect(r.root(r.controller, "B")).toMatchObject({ held: ["you@example.com/fe"] });
  } finally { await r.controller.close(); }
});

test.each(modes)("an admit receives the run loop's signal; a shutdown's abort releases it and records no pause (%s)", async mode => {
  const r = runtime(mode);
  const records: { state: string; operation: string; sessionID?: string }[] = [];
  const c = r.make({ sink: record => { records.push({ ...record }); } });
  try {
    const signals: AbortSignal[] = [];
    r.holdAdmit(heldAdmit(signals));
    r.batches.set("R", [r.item("direct:1")]);
    await c.enroll("R", ["be"], true);
    await until(() => signals.length === 1);
    expect(signals[0]).toBe(r.loops.at(-1)!.signal);
    await c.shutdown("R", "detach");
    expect(signals[0]!.aborted).toBe(true);
    expect(records.filter(x => x.state === "paused" && x.operation !== "session_end")).toEqual([]);
    expect(r.root(c)).toMatchObject({ state: "paused", message: "Session detached; lease retained for reload" });
    // Detached: the lease and the item stay for the reload.
    expect(r.rows.get("R")?.capability).toBeDefined();
    expect(r.named("delivery_receipt")).toEqual([]);
  } finally { await c.close(); await r.controller.close(); }
});

test.each(modes)("shutdown with carry returns the root's name read in the queue: a resume in flight ends at its next check without rebinding (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  // A restart: the server lost the binding, so the resume would rebind be.
  r.rows.delete("R");
  const c = r.make(), binds = r.named("bind").length, whoamis = r.named("whoami").length;
  try {
    const gate = Promise.withResolvers<void>();
    r.holdPrepare(gate.promise);
    const resumed = c.resume("R");
    await until(() => r.named("whoami").length > whoamis);
    const carried = c.shutdown("R", "release", { carry: true });
    gate.resolve();
    expect(await carried).toEqual(["you@example.com/be"]);
    await resumed;
    expect(r.named("bind").slice(binds)).toEqual([]);
    expect(r.named("delivery_open").filter(x => x.sessionID === "R")).toHaveLength(1);
    expect(r.named("session_end").map(x => x.sessionID)).toEqual(["R"]);
    expect(r.root(c)).toMatchObject({ state: "paused", message: "Session shut down; ownership released" });
  } finally { await c.close(); }
});

test.each(modes)("shutdown with carry after a completed resume returns the name it rebound (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const c = r.make(), binds = r.named("bind").length;
  try {
    await c.resume("R");
    await until(() => r.root(c)?.state === "active");
    expect(r.named("bind").slice(binds).map(x => x.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/work" }]);
    expect(await c.shutdown("R", "detach", { carry: true })).toEqual(["you@example.com/be"]);
    expect(r.rows.get("R")?.held).toEqual(["you@example.com/be"]);
  } finally { await c.close(); }
});

test.each(modes)("a release with no live root (its start never reached the queue) still ends the session (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active");
  // A /reload: the old runtime detaches and keeps the lease.
  await r.controller.shutdown("R", "detach");
  await r.controller.close();
  expect(r.rows.get("R")?.capability).toBeDefined();
  const c = r.make();
  try {
    expect(await c.shutdown("R", "release")).toBeUndefined();
    expect(r.named("session_end").map(x => x.sessionID)).toEqual(["R"]);
    expect(r.rows.has("R")).toBe(false);
    await expect(c.resume("R")).rejects.toThrow("Grayboard is stopping");
  } finally { await c.close(); }
});

test.each(modes)("a release with no live root while signed out records its failed session_end (%s)", async mode => {
  const r = runtime(mode);
  const records: { state: string; operation?: string; sessionID?: string }[] = [];
  const c = r.make({ sink: record => { records.push({ ...record }); } });
  try {
    r.signOut();
    await c.shutdown("R", "release");
    await until(() => records.some(x => x.operation === "session_end"));
    expect(records.filter(x => x.operation === "session_end")).toEqual([expect.objectContaining({ state: "degraded", sessionID: "R", message: expect.stringMatching(/^session_end failed \(/) })]);
    expect(r.named("session_end")).toEqual([]);
  } finally { await c.close(); await r.controller.close(); }
});

const at = (name: string) => `you@example.com/${name}`;

test.each(modes)("a root with two holds admits mail for either, refuses an item for a hold it lacks (%s)", async mode => {
  const r = runtime(mode);
  try {
    // Two binds: the lease is generation 2.
    r.batches.set("R", [{ ...r.item("direct:1"), bind_gen: 2, address: at("fe") }, { ...r.item("push:2"), bind_gen: 2, address: undefined }, { ...r.item("direct:3"), bind_gen: 2, address: at("other") }]);
    await r.controller.enroll("R", ["be", "fe"], true);
    await until(() => r.root(r.controller)?.state === "paused");
    expect(r.root(r.controller)).toMatchObject({ held: [at("be"), at("fe")] });
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "push:2"]);
  } finally { await r.controller.close(); }
});

test.each(modes)("an unbind result restarts delivery under the remaining holds; the last one leaves the root unbound and forgets them (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be", "fe"], true);
    await until(() => r.root(r.controller)?.state === "active");
    const row = r.rows.get("R")!;
    await r.controller.beforeCall({ sessionID: "R", tool: "unbind" });
    expect(r.root(r.controller)).toMatchObject({ state: "rebinding", operation: "before_bind" });
    r.rows.set("R", { ...row, held: [at("fe")], generation: row.generation + 1 });
    await r.controller.afterCall({ sessionID: "R", tool: "unbind", result: { status: "completed", output: { name: "fe", ownership: row.ownership, instructions: ["x"] } } });
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.[0] === at("fe"));
    expect(r.storage.get("rememberedHeld:R")).toMatchObject({ held: [at("fe")] });
    r.rows.set("R", { ...row, held: [], generation: row.generation + 2 });
    await r.controller.afterCall({ sessionID: "R", tool: "unbind", result: { status: "completed", output: { name: null, ownership: row.ownership, instructions: ["x"] } } });
    await until(() => r.root(r.controller)?.state === "unbound");
    expect(await r.controller.carried("R")).toBeUndefined();
    const binds = r.named("bind").length;
    await r.controller.afterCall({ sessionID: "R", tool: "dm_send", result: { status: "completed", output: { unbound: true } } });
    expect(r.named("bind").length).toBe(binds);
  } finally { await r.controller.close(); }
});

test.each(modes)("resume rebinds every remembered hold in order, and a hold dropped without a native completion pauses (%s)", async mode => {
  const r = runtime(mode);
  await r.controller.enroll("R", ["be", "fe"], true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const c = r.make(), binds = r.named("bind").length;
  try {
    await c.resume("R");
    await until(() => r.root(c)?.state === "active");
    expect(r.named("bind").slice(binds).map(x => x.args.name)).toEqual([at("be"), at("fe")]);
    expect(r.rows.get("R")?.held).toEqual([at("be"), at("fe")]);
    // A drop no whoami's alias_lost explains (another process's unbind): the held set no longer matches what this root started with.
    const row = r.rows.get("R")!;
    r.rows.set("R", { ...row, held: [at("fe")], generation: row.generation + 1 });
    r.closeStream("R");
    await until(() => r.root(c)?.state === "paused");
  } finally { await c.close(); }
});

// #453: a hold the server took, which whoami reports as alias_lost, is a known loss, not an unexplained change.
test.each(modes)("a hold whoami reports lost leaves the root receiving under the rest, remembered and on the status line; losing the last leaves it unbound (%s)", async mode => {
  const r = runtime(mode);
  const reason = "you@example.com isn't a member of team eng";
  try {
    await r.controller.enroll("R", ["be", "eng/build"], true);
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 2);
    r.loseHold("R", "eng/build", reason);
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 1);
    expect(r.root(r.controller)).toMatchObject({ held: [at("be")], message: `Subscribed as be (lost build: ${reason}); receipts follow durable root admission` });
    expect(r.storage.get("rememberedHeld:R")).toMatchObject({ held: [at("be")] });
    expect(await r.controller.carried("R")).toEqual([at("be")]);
    // The second loss's status line names only it: the first was taken by the reopen's delivery_open.
    r.loseHold("R", "be", reason);
    await until(() => r.root(r.controller)?.state === "unbound");
    expect(r.root(r.controller)!.message).toBe(`Root approved, unbound (lost be: ${reason}); bind(name) to take one`);
    expect(r.storage.get("rememberedHeld:R")).toMatchObject({ held: [] });
    // Neither loss is bound again.
    expect(r.named("bind").map(c => c.args.name)).toEqual(["be", "eng/build"]);
  } finally { await r.controller.close(); }
});

test.each(modes)("a loss a resume's whoami finds stays on the status line and isn't bound again (%s)", async mode => {
  const r = runtime(mode);
  const reason = "you@example.com isn't a member of team eng";
  await r.controller.enroll("R", ["be", "eng/build"], true);
  await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 2);
  await r.controller.close();
  // The fake stores a team alias as written (`eng/build`), as its binds did.
  r.rows.set("R", { held: [at("be"), "eng/build"], ownership: 1, generation: 5 });
  r.loseHold("R", "eng/build", reason);
  const restarted = r.make(), binds = r.named("bind").length;
  try {
    await restarted.resume("R");
    await until(() => r.root(restarted)?.state === "active");
    expect(r.root(restarted)).toMatchObject({ held: [at("be")], message: `Subscribed as be (lost build: ${reason}); receipts follow durable root admission` });
    expect(r.named("bind").slice(binds)).toEqual([]);
  } finally { await restarted.close(); }
});

test.each(modes)("a primary lost between the run loop's whoami and delivery_open reopens under the rest instead of pausing (%s)", async mode => {
  const r = runtime(mode);
  const reason = "you@example.com isn't a member of team eng";
  try {
    await r.controller.enroll("R", ["be", "eng/build"], true);
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 2);
    r.beforeOpen(() => r.loseHold("R", "be", reason));
    r.closeStream("R");
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.held?.length === 1);
    expect(r.root(r.controller)).toMatchObject({ held: ["eng/build"], message: `Subscribed as build (lost be: ${reason}); receipts follow durable root admission` });
  } finally { await r.controller.close(); }
});

// #1379: an own-login provider's token refresh replaces the listen at once, under the same lease.
test.each(modes)("a token change replaces the listen under the same lease: close before open, no whoami or delivery_open, and a message sent across the swap is admitted once (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active" && r.listens.length === 1);
    const whoamis = r.named("whoami").length, opens = r.named("delivery_open").length;
    let release!: () => void;
    r.holdListen(new Promise<void>(resolve => { release = resolve; }));
    r.rotate();
    // The old listen is closed while the new one is still opening; a message lands in the gap.
    await until(() => !r.listens[0]!.open);
    r.batches.set("R", [r.item("direct:7")]);
    release();
    await until(() => r.named("delivery_receipt").length === 1);
    expect(r.admits.filter(a => a.item === "direct:7")).toHaveLength(1);
    expect(r.listens.map(l => l.open)).toEqual([false, true]);
    expect(r.mostOpen).toBe(1);
    expect(r.named("whoami").length).toBe(whoamis);
    expect(r.named("delivery_open").length).toBe(opens);
    // The replaced stream's end is ours, not the server's: nothing reopened for it.
    expect(r.root(r.controller)?.state).toBe("active");
  } finally { await r.controller.close(); }
  expect(r.rotationListeners).toBe(0);
});

test.each(modes)("token changes while the first listen opens replace it once it's open; repeated changes replace it once (%s)", async mode => {
  const r = runtime(mode);
  let release!: () => void;
  r.holdListen(new Promise<void>(resolve => { release = resolve; }));
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.rotationListeners === 1);
    r.rotate(); r.rotate(); r.rotate();
    release();
    await until(() => r.listens.length === 2 && r.listens[1]!.open);
    r.batches.set("R", [r.item("direct:1")]);
    r.closeStream("R");
    // The new stream's own end still reopens: the server closing it is no token change.
    await until(() => r.named("delivery_open").length === 2 && r.named("delivery_receipt").length === 1);
    expect(r.listens.map(l => l.open)).toEqual([false, false, true]);
    expect(r.mostOpen).toBe(1);
    expect(r.admits.filter(a => a.item === "direct:1")).toHaveLength(1);
  } finally { await r.controller.close(); }
});

test.each(modes)("a replacement listen that fails is an ordinary reopen: whoami, delivery_open, then delivery again (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active" && r.listens.length === 1);
    const whoamis = r.named("whoami").length;
    r.failListen(1);
    r.rotate();
    await until(() => r.named("delivery_open").length === 2 && r.listens.length === 2 && r.root(r.controller)?.state === "active");
    expect(r.named("whoami").length).toBe(whoamis + 1);
    r.batches.set("R", [r.item("direct:3")]);
    r.closeStream("R");
    await until(() => r.named("delivery_receipt").length === 1);
    expect(r.admits.filter(a => a.item === "direct:3")).toHaveLength(1);
  } finally { await r.controller.close(); }
});

test.each([["close"], ["shutdown"]] as const)("a %s during the swap ends the replacement listen's open and the run loop", async how => {
  const r = runtime("adapter");
  await r.controller.enroll("R", ["be"], true);
  await until(() => r.root(r.controller)?.state === "active" && r.listens.length === 1);
  r.holdListen(new Promise<void>(() => {}));
  r.rotate();
  await until(() => !r.listens[0]!.open);
  if (how === "close") await r.controller.close();
  else { await r.controller.shutdown("R", "release"); await r.controller.close(); }
  expect(r.listens).toHaveLength(1);
  expect(r.named("delivery_open")).toHaveLength(1);
  expect(r.rotationListeners).toBe(0);
});

// #1379 audit L1: the old stream's cancel POST has no timeout of its own. A server that never answers it doesn't
// stall the swap: the old stream ends locally at once, the swap waits SWAP_CLOSE_MS (here the injected wait) and
// opens the new listen, with the cancel still pending.
test.each(modes)("a swap whose old stream's cancel never answers still opens the new listen after the bound (%s)", async mode => {
  const r = runtime(mode);
  const waits: number[] = [];
  const c = r.make({ wait: async ms => { waits.push(ms); } });
  try {
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "active" && r.listens.length === 1);
    const whoamis = r.named("whoami").length, opens = r.named("delivery_open").length;
    r.hangClose(1);
    r.rotate();
    await until(() => r.listens.length === 2 && r.listens[1]!.open);
    expect(r.listens[0]!.open).toBe(false);
    expect(waits).toEqual([1000]);
    r.batches.set("R", [r.item("direct:9")]);
    r.closeStream("R");
    // The new stream is the live one: its end reopens, and delivery carries on.
    await until(() => r.named("delivery_receipt").length === 1);
    expect(r.admits.filter(a => a.item === "direct:9")).toHaveLength(1);
    expect(r.named("whoami").length).toBe(whoamis + 1);
    expect(r.named("delivery_open").length).toBe(opens + 1);
    expect(r.mostOpen).toBe(1);
  } finally { await c.close(); }
});

// #1379 audit M4: a token change heard while the loop reads or admits (no idle wait to wake) is acted on before the
// loop next idles: the first 1 s idle tick after the admission finds the replacement listen already open.
test.each(modes)("a token change during an admission replaces the listen before the loop next idles (%s)", async mode => {
  const r = runtime(mode);
  // Backoffs and the swap's close bound go through the injected wait, so every 1000 ms timer is an idle tick.
  const c = r.make({ wait: async () => {} });
  const realSetTimeout = globalThis.setTimeout;
  // The listens open at each of the run loop's idle ticks (its 1000 ms sleep) once the admission is released.
  let watching = false;
  const idles: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (watching && ms === 1000) idles.push(r.listens.length);
    return realSetTimeout(handler, ms, ...rest);
  }) as typeof setTimeout;
  try {
    await c.enroll("R", ["be"], true);
    await until(() => r.root(c)?.state === "active" && r.listens.length === 1);
    let release!: () => void, admitting!: () => void;
    const admitted = new Promise<void>(resolve => { admitting = resolve; });
    r.holdAdmit(() => { admitting(); return new Promise<void>(resolve => { release = resolve; }); });
    r.batches.set("R", [r.item("direct:5")]);
    r.closeStream("R");
    await admitted;
    const opens = r.named("delivery_open").length, before = r.listens.length;
    r.rotate();
    watching = true;
    release();
    await until(() => r.named("delivery_receipt").length === 1 && idles.length >= 1);
    expect(idles[0]).toBe(before + 1);
    expect(r.listens).toHaveLength(before + 1);
    expect(r.listens.at(-1)!.open).toBe(true);
    expect(r.named("delivery_open").length).toBe(opens);
  } finally { watching = false; globalThis.setTimeout = realSetTimeout; await c.close(); }
});

test.each(modes)("a credential that reports no token changes (a static run token) never replaces its listen (%s)", async mode => {
  const r = runtime(mode, { rotates: false });
  try {
    await r.controller.enroll("R", ["be"], true);
    await until(() => r.root(r.controller)?.state === "active" && r.listens.length === 1);
    r.rotate();
    r.batches.set("R", [r.item("direct:1"), r.item("direct:2")]);
    r.closeStream("R");
    await until(() => r.named("delivery_receipt").length >= 1 && r.listens.length === 2);
    // Only the server's close reopened it.
    expect(r.rotationListeners).toBe(0);
    expect(r.named("delivery_open")).toHaveLength(2);
  } finally { await r.controller.close(); }
});
