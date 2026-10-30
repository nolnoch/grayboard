// #430: the harness-neutral Controller against a fake HostPort: no session
// metadata, no tool list. Every case runs once with an adapter-owned grant
// (`approval: null`) and once with a fake approval port.
import { expect, test } from "bun:test";
import { until } from "../../../tests/support/until.ts";
import { Controller } from "../src/controller.js";
import { Refusal, same, type Item } from "../src/model.js";
import type { ApprovalPort, CredentialPort, Enrollment, HostPort } from "../src/port.js";
import { resolveRoot } from "../src/sessions.js";
import { LeaseUnavailable, ServerUnreachable, Wire, type WireOptions } from "../src/wire.js";

type Mode = "adapter" | "approval";
type Row = { name: string | null; ownership: number; generation: number; capability?: string };
type Call = { sessionID: string; name: string; args: Record<string, unknown> };
const SESSION_KEY = "io.github.nolnoch.grayboard/sessionID";
const DELIVERY = { mode: "push" as const, source: "grayboard" };

function runtime(mode: Mode) {
  const rows = new Map<string, Row>(), storage = new Map<string, unknown>(), batches = new Map<string, Item[]>();
  const calls: Call[] = [], admits: { sessionID: string; id: string; item: string }[] = [], wires: WireOptions[] = [];
  const nodes = new Map<string, string | undefined>([["R", undefined], ["B", undefined], ["C", "R"], ["G", "C"]]);
  const watchers = new Set<() => void>();
  const approvals = new Map<string, { approval: Enrollment; enabled: boolean }>();
  let ownership = 0, grant = 1, failReceipt = 0, renews = 0;
  let renewFault: { at: number; error: () => Error; then?: () => void } | undefined;
  const bind = (id: string, name: string) => { const old = rows.get(id); rows.set(id, { name, ownership: old?.ownership ?? ++ownership, generation: (old?.generation ?? 0) + 1 }); };
  class FakeWire {
    capability?: string;
    admissionRetryAfterMs?: number;
    client = { setNotificationHandler: () => {} };
    constructor(options: WireOptions, _auth: unknown, readonly signal: AbortSignal, readonly sessionID: string) { wires.push(options); }
    async connect() {}
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ sessionID: this.sessionID, name, args });
      let row = rows.get(this.sessionID);
      if (name === "whoami") return { name: row?.name ?? null, ownership: row?.ownership ?? null, ...(!row?.name ? { unbound: true } : {}) };
      if (name === "bind") {
        if (!args.create && !rows.get(this.sessionID) && args.name !== "be" && args.name !== "fe") throw new Error("identity_unknown");
        bind(this.sessionID, args.name as string); row = rows.get(this.sessionID)!;
        return { name: row.name, ownership: row.ownership, instructions: ["bound"] };
      }
      if (name === "session_register") return { registered: true };
      if (name === "session_end" || name === "delivery_release") { rows.delete(this.sessionID); return { ok: true }; }
      if (name === "delivery_open") {
        if (!row?.name) throw new Error("unbound");
        row.capability = `${row.ownership}_${row.generation}`.padEnd(43, "a");
        return { capability: row.capability, ownership: row.ownership, bind_gen: row.generation, expiresAt: Date.now() + 30_000, identity: { user_email: "you@example.com", identity_full: `you@example.com/${row.name}` } };
      }
      if (name.startsWith("delivery_") && (!row?.capability || row.capability !== this.capability)) throw new LeaseUnavailable();
      if (name === "delivery_renew" && ++renews === renewFault?.at) { renewFault.then?.(); throw renewFault.error(); }
      if (name === "delivery_receipt") {
        if (failReceipt > 0) { failReceipt--; throw new Error("receipt lost"); }
        batches.set(this.sessionID, (batches.get(this.sessionID) ?? []).filter(item => !(args.ids as string[]).includes(item.id)));
      }
      return { ok: true };
    }
    async read() { return { items: batches.get(this.sessionID) ?? [] }; }
    async listen() { return { closed: new Promise<void>(() => {}), close: async () => {} }; }
  }
  const configuration = () => ({ type: "remote" as const, url: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", clientID: "grayboard-pi", scope: "grayboard:delivery grayboard:tools", configHash: `grant-${grant}` });
  const credential: CredentialPort<Enrollment> = {
    capture: async sessionID => ({ version: 2, sessionID, configuration: configuration() }),
    check: async e => { if (e.configuration.configHash !== `grant-${grant}`) throw new Refusal("binding", "Grant changed"); },
    watch: async (_e, drift) => { watchers.add(drift); return { dispose: async () => { watchers.delete(drift); } }; },
    token: async () => "access",
    unauthorized: async () => { throw new Refusal("auth", "unauthorized"); },
  };
  const approval: ApprovalPort<Enrollment> | null = mode === "approval" ? {
    key: e => JSON.stringify([e.sessionID, e.configuration]),
    save: async (e, saved, enabled) => { approvals.set(e.sessionID, { approval: structuredClone(saved), enabled }); },
    approved: async (e, saved) => { const s = approvals.get(e.sessionID); return !!s?.enabled && same(s.approval, saved); },
    saved: async () => [...approvals].map(([sessionID, s]) => ({ sessionID, approval: structuredClone(s.approval), enabled: s.enabled })),
  } : null;
  const port: HostPort<Enrollment> = {
    harness: "pi", resumeHint: "run /grayboard resume", loginAction: "run /grayboard login", sessionKey: SESSION_KEY,
    client: { name: "grayboard-test", version: "1.0.0" }, delivery: DELIVERY,
    storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, structuredClone(value)); } },
    place: () => "/work",
    ancestry: sessionID => resolveRoot(sessionID, async id => { if (!nodes.has(id)) throw new Error("missing"); return { id, parentID: nodes.get(id), time: {} }; }),
    credential, approval,
    admit: async (e, item, id) => { admits.push({ sessionID: e.sessionID, id, item: item.id }); },
  };
  const make = () => new Controller(port, { Transport: FakeWire as unknown as typeof Wire });
  const controller = make();
  // The item a fresh root's first bind of `be` will be issued (ownership 1, generation 1).
  const item = (id: string): Item => ({ id, actionable: true, event: {}, ownership: 1, bind_gen: 1, name: "be" });
  const named = (name: string) => calls.filter(c => c.name === name);
  return {
    controller, make, rows, storage, batches, calls, admits, wires, nodes, approvals, item, named,
    drift: () => { grant++; for (const w of [...watchers]) w(); },
    failReceipt: (n: number) => { failReceipt = n; },
    // The nth delivery_renew throws `error` once, after running `then`.
    failRenewAt: (at: number, error: () => Error, then?: () => void) => { renewFault = { at, error, ...(then ? { then } : {}) }; },
    root: (c: Controller, id = "R") => c.status().roots.find(r => r.sessionID === id),
  };
}
const modes: Mode[] = ["adapter", "approval"];

test.each(modes)("enroll binds, opens delivery with the port's session key and delivery declaration, admits and receipts (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", "be", true);
    await until(() => r.named("delivery_receipt").length === 1);
    expect(r.admits.map(a => [a.sessionID, a.item])).toEqual([["R", "direct:1"]]);
    expect(r.admits[0]!.id).toMatch(/^msg_[a-f0-9]{64}$/);
    expect(r.root(r.controller)).toMatchObject({ state: "active", name: "be" });
    expect(r.named("bind")[0]!.args).toEqual({ name: "be", create: true, where: "/work" });
    expect(r.wires.every(w => w.sessionKey === SESSION_KEY && same(w.delivery, DELIVERY) && w.client.name === "grayboard-test")).toBe(true);
    if (mode === "approval") expect(r.approvals.get("R")?.enabled).toBe(true);
    else expect(r.approvals.size).toBe(0);
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
  await r.controller.enroll("R", "be", true);
  await until(() => r.root(r.controller)?.state === "active");
  await r.controller.close();
  r.rows.delete("R");
  const restarted = r.make(), binds = r.named("bind").length;
  try {
    await restarted.resume("R");
    await until(() => r.root(restarted)?.state === "active");
    expect(r.named("bind").slice(binds).map(c => c.args)).toEqual([{ name: "be", create: false, where: "/work" }]);
    if (mode === "approval") await expect(restarted.resume("B")).rejects.toThrow("No saved approval for this root; run /grayboard resume");
    else {
      await restarted.resume("B");
      expect(r.root(restarted, "B")).toMatchObject({ state: "unbound" });
    }
  } finally { await restarted.close(); }
});

test.each(modes)("pause releases ownership and keeps every root paused (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", "be", true);
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
    await r.controller.enroll("R", "be", true);
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
    await r.controller.enroll("R", "be", true);
    await r.controller.enroll("B", "fe", true);
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

test.each(modes)("an ended root releases ownership; an ended child ends only its own registration (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", "be", true);
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

test.each(modes)("a root's bind stops delivery before the call and reopens under the new name after it (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", "be", true);
    await until(() => r.root(r.controller)?.state === "active");
    await r.controller.beforeCall({ sessionID: "R", tool: "bind" });
    expect(r.root(r.controller)).toMatchObject({ state: "rebinding", operation: "before_bind" });
    r.rows.set("R", { name: "fe", ownership: r.rows.get("R")!.ownership, generation: r.rows.get("R")!.generation + 1 });
    await r.controller.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "fe", ownership: r.rows.get("R")!.ownership, instructions: ["bound"] } } });
    await until(() => r.root(r.controller)?.state === "active" && r.root(r.controller)?.name === "fe");
    expect(r.storage.get("rememberedName:R")).toMatchObject({ name: "fe" });
    await r.controller.afterCall({ sessionID: "R", tool: "bind", result: { status: "completed", output: { name: "fe" } } });
    expect(r.root(r.controller)).toMatchObject({ state: "approved", operation: "after" });
  } finally { await r.controller.close(); }
});

test.each(modes)("an unbound result from any tool rebinds the remembered name (%s)", async mode => {
  const r = runtime(mode);
  try {
    await r.controller.enroll("R", "be", true);
    await until(() => r.root(r.controller)?.state === "active");
    r.rows.delete("R");
    const binds = r.named("bind").length;
    await r.controller.afterCall({ sessionID: "R", tool: "dm_send", result: { status: "completed", output: { unbound: true } } });
    await until(() => r.root(r.controller)?.state === "active");
    expect(r.named("bind").slice(binds).map(c => c.args)).toEqual([{ name: "be", create: false, where: "/work" }]);
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
    await r.controller.enroll("R", "be", true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "direct:2"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"], ["direct:2"]]);
  } finally { await r.controller.close(); }
});

// The item's first renew is #2 (#1 is the pre-admission renew): it fails
// after the host accepted the item.
test.each(modes)("a post-admission renew that fails once (an outage) shows the item once and receipts it after reconnecting (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.failRenewAt(2, () => new ServerUnreachable(new Error("blip")));
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", "be", true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"]]);
    expect(r.named("delivery_open")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

test.each(modes)("a post-admission renew that loses the lease: the next lease of the same bind_gen receipts without admitting again (%s)", async mode => {
  const r = runtime(mode);
  try {
    r.failRenewAt(2, () => new LeaseUnavailable());
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", "be", true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1"]);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"]]);
    expect(r.named("delivery_open")).toHaveLength(2);
  } finally { await r.controller.close(); }
});

test.each(modes)("a lease lost after admission whose next lease has a new bind_gen admits the item again under it (%s)", async mode => {
  const r = runtime(mode);
  try {
    // The name was rebound meanwhile: the next lease and its inbox carry bind_gen 2.
    r.failRenewAt(2, () => new LeaseUnavailable(), () => {
      const row = r.rows.get("R")!;
      r.rows.set("R", { name: row.name, ownership: row.ownership, generation: row.generation + 1 });
      r.batches.set("R", [{ ...r.item("direct:1"), bind_gen: 2 }]);
    });
    r.batches.set("R", [r.item("direct:1")]);
    await r.controller.enroll("R", "be", true);
    await until(() => r.batches.get("R")?.length === 0, 10_000);
    expect(r.admits.map(a => a.item)).toEqual(["direct:1", "direct:1"]);
    expect(r.admits[1]!.id).toBe(r.admits[0]!.id);
    expect(r.named("delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"]]);
  } finally { await r.controller.close(); }
});
