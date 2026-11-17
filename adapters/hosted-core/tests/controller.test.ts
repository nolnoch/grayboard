// #430: the harness-neutral Controller against a fake HostPort: no session
// metadata, no tool list. Every case runs once with an adapter-owned grant
// (`approval: null`) and once with a fake approval port.
import { expect, test } from "bun:test";
import { until } from "../../../tests/support/until.ts";
import { Controller, type ControllerOptions } from "../src/controller.js";
import { AccessExpired, Refusal, RefreshInProgress, same, type AccessReason, type Item } from "../src/model.js";
import type { ApprovalPort, CredentialPort, Enrollment, HostPort } from "../src/port.js";
import { resolveRoot } from "../src/sessions.js";
import { LeaseUnavailable, ServerUnreachable, SubscriberError, Wire, type WireOptions } from "../src/wire.js";

type Mode = "adapter" | "approval";
type Row = { held: string[]; ownership: number; generation: number; capability?: string };
type Call = { sessionID: string; name: string; args: Record<string, unknown> };
const SESSION_KEY = "io.github.nolnoch.grayboard/sessionID";
const DELIVERY = { mode: "push" as const, source: "grayboard" };

function runtime(mode: Mode) {
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
  const heldElsewhere = new Set<string>();
  // A prepare's whoami (a temporary wire: no beforeRetry) waits on this; the host's admit, on that.
  // Every session_register waits on `registerHold` while set; `ancestries` lists each ancestry lookup's session.
  let registerHold: Promise<void> | undefined;
  const ancestries: string[] = [];
  let prepareHold: Promise<void> | undefined, admitHold: ((signal: AbortSignal) => Promise<void>) | undefined, beforeOpen: (() => void) | undefined;
  // The host's receipt hook (#441), when a test sets one.
  let receiptHook: ((sessionID: string, ids: readonly string[]) => void) | undefined;
  const loops: FakeWire[] = [];
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
      if (this.beforeRetry && refreshBusy > 0) { refreshBusy--; throw new Error("Version negotiation probe failed", { cause: new RefreshInProgress("pi") }); }
      try { await this.auth.token(); } catch (error) { throw new Error("Version negotiation probe failed", { cause: error }); }
    }
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ sessionID: this.sessionID, name, args });
      let row = rows.get(this.sessionID);
      if (name === "whoami") {
        if (!this.beforeRetry && prepareHold) await prepareHold;
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
      const { promise: closed, resolve } = Promise.withResolvers<void>();
      streams.set(this.sessionID, resolve);
      return { closed, close: async () => {} };
    }
  }
  const configuration = () => ({ type: "remote" as const, url: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", clientID: "grayboard-pi", scope: "grayboard:delivery grayboard:tools", configHash: `grant-${grant}` });
  const credential: CredentialPort<Enrollment> = {
    capture: async sessionID => { if (signedOut) throw new AccessExpired("pi", "run /grayboard login"); return { version: 2, sessionID, configuration: configuration() }; },
    check: async e => {
      if (e.configuration.configHash !== `grant-${grant}`) throw new Refusal("binding", "Grant changed");
      if (checkSeesAccess && accessFault) throw new AccessExpired("pi", "run /grayboard login", accessFault);
    },
    watch: async (_e, drift) => { watchers.add(drift); drifts.push(drift); return { dispose: async () => { watchers.delete(drift); } }; },
    token: async () => { if (accessFault) throw new AccessExpired("pi", "run /grayboard login", accessFault); return "access"; },
    unauthorized: async () => { throw new Refusal("auth", "unauthorized"); },
    refresh: async () => { refreshes++; return true; },
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
    // The next delivery_open runs `hook` first (a revocation landing between a whoami and the open).
    beforeOpen: (hook: () => void) => { beforeOpen = hook; },
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
