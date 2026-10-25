import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller } from "../src/controller.js";
import { Wire, LeaseUnavailable } from "../src/wire.js";
import type { Enrollment, Item } from "../src/model.js";
import { fixture } from "./binding.test.js";

type Row = { name: string | null; ownership: number; generation: number; capability?: string };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(5); } throw new Error("condition timed out"); }
function runtime(options: { name?: string; create?: boolean } = {}) {
  const f = fixture(), rows = new Map<string, Row>(), nodes = new Map<string, { id: string; parentID?: string; time: { archived?: number }; metadata: Record<string, unknown> }>();
  const storage = new Map<string, unknown>(), calls: { sessionID: string; name: string; args: Record<string, unknown> }[] = [], admissions: { sessionID: string; id: string; resume: boolean }[] = [];
  const batches = new Map<string, Item[]>();
  let holdRegister: (() => Promise<void>) | undefined, admit: (() => Promise<void>) | undefined, holdReceipt = false, refuseBind = false;
  let ownership = 0;
  const node = (id: string, parentID?: string) => { nodes.set(id, { id, parentID, time: {}, metadata: {} }); };
  node("R"); node("B"); node("C", "R"); node("G", "C");
  const bind = (id: string, name: string) => { const old = rows.get(id); rows.set(id, { name, ownership: old?.ownership ?? ++ownership, generation: (old?.generation ?? 0) + 1 }); };
  class FakeWire {
    capability?: string;
    client = { setNotificationHandler: () => {} };
    constructor(_config: unknown, _auth: unknown, readonly signal: AbortSignal, readonly sessionID: string) {}
    async connect() {}
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ sessionID: this.sessionID, name, args });
      let row = rows.get(this.sessionID);
      if (name === "whoami") return { name: row?.name ?? null, ownership: row?.ownership ?? null, ...(!row?.name ? { unbound: true, candidates: ["be", "fe"] } : {}) };
      if (name === "bind") {
        if (refuseBind) throw new Error('identity_in_use: identity is already in use by the live session holder');
        bind(this.sessionID, args.name as string); row = rows.get(this.sessionID)!;
        return { name: row.name, ownership: row.ownership, instructions: "bound" };
      }
      if (name === "session_register") { await holdRegister?.(); return { registered: true }; }
      if (name === "session_end" || name === "delivery_release") { rows.delete(this.sessionID); return { ok: true }; }
      if (name === "delivery_open") {
        if (!row?.name) throw new Error("unbound");
        row.capability = (String(row.ownership) + String(row.generation)).padEnd(43, "a");
        return { capability: row.capability, ownership: row.ownership, bind_gen: row.generation, expiresAt: Date.now() + 30_000, identity: { user: { id: 1, email: "you@example.com" }, identity: row.name, identity_full: `you@example.com/${row.name}`, issuer: f.metadata.issuer, resource: f.config.url } };
      }
      if (name.startsWith("delivery_") && (!row?.capability || row.capability !== this.capability)) throw new LeaseUnavailable("no live delivery lease");
      if (name === "delivery_receipt") {
        if (holdReceipt) { holdReceipt = false; throw new Error("receipt failed"); }
        batches.set(this.sessionID, []);
      }
      return { ok: true };
    }
    async read() { return { items: batches.get(this.sessionID) ?? [] }; }
    async listen() { return { closed: new Promise<void>(() => {}), close: async () => {} }; }
  }
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const value = nodes.get(sessionID); if (!value) throw new Error("missing"); return structuredClone(value); },
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => { nodes.get(sessionID)!.metadata = structuredClone(metadata); },
      synthetic: async (input: { sessionID: string; id: string; resume: boolean }) => { admissions.push(input); await admit?.(); },
    },
    tool: { list: async () => ["bind", "dm_send", "whoami"].map(name => ({ id: `grayboard_${name}`, options: { namespace: "grayboard" } })) },
  } as unknown as Context;
  const controller = new Controller(ctx, { mcpName: "grayboard", ...options }, FakeWire as unknown as typeof Wire);
  const before = (sessionID: string, tool = "grayboard_dm_send") => controller.before({ sessionID, tool, id: "call" });
  const after = (sessionID: string, name: string) => controller.after({ sessionID, tool: "grayboard_bind", id: "call", status: "completed", result: { output: { name, ownership: rows.get(sessionID)?.ownership, instructions: "bound" } } });
  return { controller, restart: () => new Controller(ctx, { mcpName: "grayboard", ...options }, FakeWire as unknown as typeof Wire), rows, storage, nodes, calls, admissions, batches, bind, before, after, f, holdRegistration: (call: () => Promise<void>) => { holdRegister = call; }, admission: (call: () => Promise<void>) => { admit = call; }, rejectReceipt: () => { holdReceipt = true; }, refuse: () => { refuseBind = true; } };
}
test("approval without name does not bind, lease, admit or receipt; native completion opens once", async () => {
  const r = runtime();
  try {
    expect((await r.controller.enroll("R")).state).toBe("unbound");
    expect(r.calls.map(c => c.name)).toEqual(["whoami"]);
    await r.before("R", "grayboard_bind"); r.bind("R", "be"); await r.after("R", "be");
    await until(() => r.controller.status().state === "active");
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(1);
    expect(r.admissions).toHaveLength(0);
  } finally { await r.controller.close(); }
});
test("two approved roots on shared native config keep independent names, leases and admissions", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, name: "be" }]);
    r.batches.set("B", [{ id: "direct:2", actionable: false, event: {}, ownership: 2, bind_gen: 1, name: "fe" }]);
    await r.controller.enroll("R"); await r.controller.enroll("B");
    await until(() => r.calls.filter(c => c.name === "delivery_receipt").length === 2);
    expect(r.admissions.map(a => [a.sessionID, a.resume])).toEqual([["R", true], ["B", false]]);
    expect(r.calls.filter(c => c.name === "delivery_open").map(c => c.sessionID)).toEqual(["R", "B"]);
  } finally { await r.controller.close(); }
});
test("before awaits G registration directly under R via C, rejects missing ancestry", async () => {
  const r = runtime(); let done!: () => void;
  try {
    r.holdRegistration(() => new Promise(resolve => { done = resolve; }));
    let allowed = false; const pending = r.before("G").then(() => { allowed = true; });
    await until(() => !!done); expect(allowed).toBe(false);
    expect(r.calls.at(-1)).toEqual({ sessionID: "R", name: "session_register", args: { child: "G", via: ["C"] } });
    done(); await pending; expect(allowed).toBe(true);
    r.nodes.delete("C"); await expect(r.before("G")).rejects.toThrow("missing C");
  } finally { await r.controller.close(); }
});
test("retained routes close children independently, child-first and root-first lifecycle are idempotent", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await r.before("G");
    r.nodes.delete("C"); await r.controller.observe("session.deleted", { sessionID: "C" });
    expect(r.rows.get("R")?.name).toBe("be");
    await r.controller.observe("session.deleted", { sessionID: "C" });
    expect(r.calls.filter(c => c.name === "session_end" && c.sessionID === "C")).toHaveLength(1);
    r.nodes.delete("R"); await r.controller.observe("session.archived", { sessionID: "R" });
    await r.controller.observe("session.deleted", { sessionID: "G" });
    expect(r.calls.filter(c => c.name === "session_end" && c.sessionID === "R")).toHaveLength(1);
    expect(r.calls.filter(c => c.name === "session_end" && c.sessionID === "G")).toHaveLength(1);
    await expect(r.before("G")).rejects.toThrow();
  } finally { await r.controller.close(); }
});
test("FOUR native rebinds preserve approval and reopen exactly once each without release", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await until(() => r.controller.status().state === "active");
    for (let i = 1; i <= 4; i++) {
      await r.before("R", "grayboard_bind"); r.bind("R", `name-${i}`); await r.after("R", `name-${i}`);
      await until(() => r.calls.filter(c => c.name === "delivery_open").length === i + 1);
    }
    expect(r.calls.filter(c => c.name === "delivery_release")).toHaveLength(0);
    expect(r.rows.get("R")?.ownership).toBe(1);
  } finally { await r.controller.close(); }
});
test("pause ends ownership, resume rebinds remembered name create:false; held name refuses once", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await until(() => r.controller.status().state === "active");
    await r.controller.pause(); expect(r.rows.has("R")).toBe(false);
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "active");
    expect(r.calls.find(c => c.name === "bind")?.args).toMatchObject({ name: "be", create: false });
    await r.controller.pause(); r.refuse(); await r.controller.enroll("R"); await Bun.sleep(20);
    expect(r.controller.status().message).toContain("approval saved");
    expect(r.calls.filter(c => c.name === "bind")).toHaveLength(2);
  } finally { await r.controller.close(); }
});
test("restart skips ended roots, restores another root, and resumes a paused durable name", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await r.controller.enroll("R"); await r.controller.enroll("B");
    r.nodes.delete("R"); await r.controller.observe("session.deleted", { sessionID: "R" });
    await r.controller.pause(); await r.controller.close();
    restarted = r.restart(); await restarted.restore();
    expect(restarted.status().state).toBe("paused");
    await restarted.enroll("B"); await until(() => restarted!.status().state === "active");
    expect(r.calls.filter(c => c.name === "bind").at(-1)?.args).toMatchObject({ name: "fe", create: false });
  } finally { await restarted?.close(); await r.controller.close(); }
});
test("ordinary native unbound result rebinds the durable name once with create:false", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R");
    await until(() => r.controller.status().state === "active");
    r.rows.delete("R");
    await r.controller.after({ sessionID: "R", tool: "grayboard_whoami", id: "call", status: "completed", result: { output: { unbound: true, name: null, ownership: null } } });
    await until(() => r.calls.filter(c => c.name === "delivery_open").length === 2);
    expect(r.calls.filter(c => c.name === "bind").map(c => c.args)).toEqual([{ name: "be", create: false, where: "/worktree" }]);
    await r.before("G");
    expect(r.calls.at(-1)?.args).toEqual({ child: "G", via: ["C"] });
  } finally { await r.controller.close(); }
});
test("pause during awaited admission suppresses receipt without pretending host write was recalled", async () => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, name: "be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock);
    const pausing = r.controller.pause(); await Bun.sleep(5); unblock(); await pausing;
    expect(r.admissions).toHaveLength(1);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.admissions[0]?.sessionID).toBe("R");
  } finally { await r.controller.close(); }
});
test.each(["session.archived", "session.deleted", "credential.switched", "rebind", "expiry"])("%s during host admission suppresses stale receipt", async mode => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, name: "be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock);
    let ending: Promise<unknown> | undefined;
    if (mode === "credential.switched") ending = r.controller.observe(mode, { integrationID: "native-integration" });
    else if (mode === "rebind") ending = r.before("R", "grayboard_bind");
    else if (mode === "expiry") r.rows.delete("R");
    else { r.nodes.delete("R"); ending = r.controller.observe(mode, { sessionID: "R" }); }
    await Bun.sleep(5); unblock(); await ending;
    if (mode === "expiry") await until(() => r.controller.status().state === "retrying");
    await Bun.sleep(10);
    expect(r.admissions.map(a => a.sessionID)).toEqual(["R"]);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
  } finally { await r.controller.close(); }
});
test("configuration away-and-back during host admission remains latched and sends no receipt", async () => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, name: "be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock);
    r.f.config.url = "https://other.example.com/mcp"; r.f.reload();
    r.f.config.url = "https://grayboard.example.com/mcp"; r.f.reload();
    unblock(); await Bun.sleep(20);
    expect(r.controller.status().state).toBe("paused");
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.admissions[0]?.sessionID).toBe("R");
  } finally { await r.controller.close(); }
});
test("configured name binds create:false on root start without approving or leasing", async () => {
  const r = runtime({ name: "be" });
  try {
    await r.controller.observe("session.created", { sessionID: "R" });
    expect(r.calls).toEqual([{ sessionID: "R", name: "bind", args: { name: "be", create: false, where: "/worktree" } }]);
    expect(r.storage.get("rootSessionIDs")).toBeUndefined();
    expect(r.controller.status().state).toBe("unenrolled");
  } finally { await r.controller.close(); }
});
test("registration refusal rejects the child's native call before dispatch", async () => {
  const r = runtime();
  try {
    r.holdRegistration(async () => { throw new Error("child_bound: end the child first"); });
    await expect(r.before("G")).rejects.toThrow("child_bound");
    expect(r.calls).toHaveLength(1);
  } finally { await r.controller.close(); }
});
test("issued stamp mismatch never admits or receipts", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 99, bind_gen: 1, name: "be" }]);
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "paused");
    expect(r.admissions).toHaveLength(0); expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
  } finally { await r.controller.close(); }
});
test("lost receipt reopens safely with the identical root admission ID", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.rejectReceipt();
    r.batches.set("R", [{ id: "direct:1", actionable: false, event: {}, ownership: 1, bind_gen: 1, name: "be" }]);
    await r.controller.enroll("R"); await until(() => r.calls.filter(c => c.name === "delivery_receipt").length === 2);
    expect(r.admissions).toHaveLength(2); expect(r.admissions[0]?.id).toBe(r.admissions[1]?.id);
    expect(r.admissions.map(a => a.sessionID)).toEqual(["R", "R"]);
  } finally { await r.controller.close(); }
});
test("outer CodeMode execute and malformed native output never open a lease", async () => {
  const r = runtime();
  try {
    await r.controller.enroll("R"); r.bind("R", "be");
    await r.controller.after({ sessionID: "R", tool: "execute", id: "call", status: "completed", result: { output: { name: "be", ownership: 1, instructions: "bound" } } });
    await r.controller.after({ sessionID: "R", tool: "grayboard_bind", id: "call", status: "completed", result: { output: { name: "be" } } });
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(0);
  } finally { await r.controller.close(); }
});
