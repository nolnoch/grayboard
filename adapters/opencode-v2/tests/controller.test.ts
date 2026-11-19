import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { Client, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import type { Context } from "@opencode/plugin/promise/plugin";
import { OpenCodeController as Controller, OPENCODE_SESSION, setup as setupPlugin, STATIC_AUTH, STATIC_ISSUER } from "../src/lifecycle.js";
import { Controller as CoreController } from "../src/core/controller.js";
import { Diagnostics, failureCode, failureMessage as failureMessageWith } from "../src/core/diagnostics.js";
const failureMessage = (error: unknown) => failureMessageWith(error, "explicitly enroll again");
import { observeEvents } from "../src/core/events.js";
import { Wire, LAUNCHER_META, SUGGESTED_META, LeaseUnavailable, ServerUnreachable, SubscriberError } from "../src/core/wire.js";
import { Approval, METADATA, enrollmentHash, type OpenCodeEnrollment as Enrollment } from "../src/approval.js";
import { AccessExpired, Refusal, type Item } from "../src/core/model.js";
import { NEW_RUN, SIGN_IN, type StaticMode } from "../src/binding.js";
class NativeAccessExpired extends AccessExpired { constructor() { super("OpenCode", SIGN_IN); } }
import { fixture } from "./native-fixture.js";
import { until } from "./until.ts";
import { FailedContinuation } from "./failed-continuation.js";
import { observeRuns } from "./subscriber-work.js";
import { barrier, bounded } from "./reload-state.js";
import { afterProducers } from "./causal.js";

type Row = { held: string[]; ownership: number; generation: number; capability?: string };
function runtime(options: { name?: string; create?: boolean; static?: StaticMode } = {}, wait?: (ms: number, signal: AbortSignal) => Promise<void>) {
  const f = fixture(), rows = new Map<string, Row>(), nodes = new Map<string, { id: string; parentID?: string; time: { archived?: number }; metadata: Record<string, unknown> }>();
  const storage = new Map<string, unknown>(), calls: { sessionID: string; name: string; args: Record<string, unknown> }[] = [], admissions: { sessionID: string; id: string; resume: boolean }[] = [];
  const batches = new Map<string, Item[]>();
  let holdRegister: (() => Promise<void>) | undefined, admit: (() => Promise<void>) | undefined, holdReceipt = false, refuseBind = false;
  let ownership = 0, throttledReads = 0;
  let readFailure: (() => void) | undefined;
  let observation: ((operation: string, signal: AbortSignal) => Promise<void>) | undefined;
  let subscription: (() => Promise<void> | undefined) | undefined;
  const node = (id: string, parentID?: string) => { nodes.set(id, { id, parentID, time: {}, metadata: {} }); };
  node("R"); node("B"); node("C", "R"); node("G", "C");
  const bind = (id: string, name: string) => { const old = rows.get(id), address = name.includes("/") ? name : `you@example.com/${name}`, held = old?.held ?? []; rows.set(id, { held: held.includes(address) ? held : [...held, address], ownership: old?.ownership ?? ++ownership, generation: (old?.generation ?? 0) + 1 }); };
  class FakeWire {
    capability?: string;
    admissionRetryAfterMs?: number;
    client = { setNotificationHandler: () => {} };
    constructor(_config: unknown, _auth: unknown, readonly signal: AbortSignal, readonly sessionID: string) {}
    async connect() { await observation?.("connect", this.signal); }
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ sessionID: this.sessionID, name, args });
      let row = rows.get(this.sessionID);
      if (name === "whoami") { await observation?.("whoami"); return { held: row?.held ?? [], primary: row?.held[0] ?? null, ownership: row?.ownership ?? null, ...(!row?.held.length ? { unbound: true, candidates: ["be", "fe"] } : {}) }; }
      if (name === "bind") {
        if (refuseBind) throw new SubscriberError("alias_held", undefined, "the hosted session ses_other, in /work/app, last seen 3s ago");
        bind(this.sessionID, args.name as string); row = rows.get(this.sessionID)!;
        await observation?.("bind");
        return { name: row.held[0]!.split("/")[1], ownership: row.ownership, instructions: ["bound"] };
      }
      if (name === "session_register") { await holdRegister?.(); return { registered: true }; }
      if (name === "session_end" || name === "delivery_release") { rows.delete(this.sessionID); return { ok: true }; }
      if (name === "delivery_open") {
        if (!row?.held.length) throw new Error("unbound");
        row.capability = (String(row.ownership) + String(row.generation)).padEnd(43, "a");
        return { capability: row.capability, ownership: row.ownership, bind_gen: row.generation, expiresAt: Date.now() + 30_000, identity: { user_email: "you@example.com", identity_full: row.held[0] } };
      }
      if (name === "delivery_renew" || name === "delivery_receipt") await observation?.(name);
      if (name.startsWith("delivery_") && (!row?.capability || row.capability !== this.capability)) throw new LeaseUnavailable();
      if (name === "delivery_receipt") {
        if (holdReceipt) { holdReceipt = false; throw new Error("receipt failed"); }
        batches.set(this.sessionID, (batches.get(this.sessionID) ?? []).filter(item => !(args.ids as string[]).includes(item.id)));
      }
      return { ok: true };
    }
    async read() {
      readFailure?.();
      if (throttledReads > 0) { throttledReads--; this.admissionRetryAfterMs = 100; throw new Error("typed HTTP429"); }
      return { items: batches.get(this.sessionID) ?? [] };
    }
    async listen() { return { closed: subscription?.() ?? new Promise<void>(() => {}), close: async () => {} }; }
  }
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" },
    // One entry per scan page, so every restore walks OpenCode's `next` cursor.
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); }, remove: async (key: string) => { storage.delete(key); },
      scan: async ({ prefix, after }: { prefix: string; after?: string }) => {
        const keys = [...storage.keys()].filter(key => key.startsWith(prefix) && (after === undefined || key > after)).sort();
        return { entries: keys.slice(0, 1).map(key => ({ key, value: structuredClone(storage.get(key)) })), ...(keys.length > 1 ? { next: keys[0] } : {}) };
      } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const value = nodes.get(sessionID); if (!value) throw new Error("missing"); return structuredClone(value); },
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => { nodes.get(sessionID)!.metadata = structuredClone(metadata); },
      synthetic: async (input: { sessionID: string; id: string; resume: boolean }) => { admissions.push(input); await admit?.(); },
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: { list: async () => ["bind", "dm_send", "whoami"].map(name => ({ id: `grayboard_${name}`, options: { namespace: "grayboard" } })) },
  } as unknown as Context;
  const controller = new Controller(ctx, { mcpName: "grayboard", ...options }, FakeWire as unknown as typeof Wire, wait);
  const before = (sessionID: string, tool = "grayboard_dm_send") => controller.before({ sessionID, tool, id: "call" });
  const after = (sessionID: string, name: string) => controller.after({ sessionID, tool: "grayboard_bind", id: "call", status: "completed", result: { output: { name, ownership: rows.get(sessionID)?.ownership, instructions: ["bound"] } } });
  return { ctx, controller, observe: (call: (operation: string, signal: AbortSignal) => Promise<void>) => { observation = call; }, subscriptions: (call: () => Promise<void> | undefined) => { subscription = call; }, readFailure: (call: () => void) => { readFailure = call; }, restart: (restartWait?: (ms: number, signal: AbortSignal) => Promise<void>) => new Controller(ctx, { mcpName: "grayboard", ...options }, FakeWire as unknown as typeof Wire, restartWait), rows, storage, nodes, calls, admissions, batches, bind, before, after, f, throttle: (count: number) => { throttledReads = count; }, holdRegistration: (call: () => Promise<void>) => { holdRegister = call; }, admission: (call: () => Promise<void>) => { admit = call; }, rejectReceipt: () => { holdReceipt = true; }, refuse: () => { refuseBind = true; } };
}
test("diagnostic failures never inspect hostile error properties and retain cleanup classification", async () => {
  let reads = 0; const error = new Error();
  for (const key of ["message", "stack", "cause", "code"]) Object.defineProperty(error, key, { get() { reads++; throw new Error("secret"); } });
  expect(failureCode(error)).toBe("operation_failed");
  expect(failureMessage(error)).not.toContain("secret");
  expect(reads).toBe(0);
  const storage = new Map<string, unknown>(), emitted: unknown[] = [];
  const d = new Diagnostics({ get: async key => storage.get(key), set: async (key, value) => { storage.set(key, structuredClone(value)); } } as Context["storage"], record => { emitted.push(record); });
  d.record({ state: "degraded", message: "Cleanup failed", operation: "session_end", code: failureCode(error), sessionID: "R" });
  d.record({ state: "paused", message: "Ownership ended", operation: "pause", sessionID: "R" });
  await d.flush();
  expect(d.status().roots[0]?.failure).toMatchObject({ operation: "session_end", code: "operation_failed" });
  expect(emitted).toHaveLength(2);
  const restored = new Diagnostics({ get: async key => storage.get(key) } as Context["storage"]); await restored.restore(async id => id === "R");
  expect(restored.status().roots[0]?.failure).toMatchObject({ operation: "session_end", code: "operation_failed" });
  const broken = new Diagnostics({ get: async () => undefined, set: async () => { throw error; }, remove: async () => {}, scan: async () => ({ entries: [] }) });
  broken.record({ state: "active", message: "Active", operation: "delivery", sessionID: "R" });
  expect(await broken.flush()).toBe(false); expect(broken.status().state).toBe("degraded"); expect(reads).toBe(0);
});

test("stored diagnostics are closed DTOs and hostile records cannot escape or stop healthy history", async () => {
  const sessionID = "ses_" + "b".repeat(64), secret = "PRIVATE_DIAGNOSTIC_CANARY";
  let getters = 0;
  const safe = { state: "paused", message: secret, sessionID, operation: "delivery", time: 1, held: ["you@example.com/be"], ownership: 1 };
  const hostile = { ...safe, sessionID: "ses_" + "c".repeat(64) };
  Object.defineProperty(hostile, "message", { enumerable: true, get() { getters++; throw new Error(secret); } });
  const values = [hostile, { ...safe, ownership: -1 }, { ...safe, failure: { operation: "session_end", code: "operation_failed", time: 1, exception: secret } }, safe];
  const d = new Diagnostics({ get: async () => values, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) }, undefined, { knownRoot: OPENCODE_SESSION });
  await d.restore();
  expect(getters).toBe(0); expect(d.status().roots).toHaveLength(1);
  expect(d.status().roots[0]).toMatchObject({ state: "paused", sessionID, ownership: 1 });
  expect(JSON.stringify(d.status())).not.toContain(secret);
  d.record({ state: "active", message: "Active", sessionID, operation: "delivery" });
  expect(JSON.stringify(d.status())).not.toContain(secret);
  expect(d.status().roots[0]?.failure).toBeUndefined();
});

test("diagnostics retain each root across unrelated activity and restart without granting approval", async () => {
  const r = runtime({}, async () => {}); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(async () => { throw new Error("secret-token\n at bearer-token.ts:1"); });
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "paused", 1000);
    r.admission(async () => {});
    const reply = await r.controller.enroll("B");
    expect(reply.message).toContain("fe");
    await until(() => r.controller.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(r.controller.status().roots.find(root => root.sessionID === "R")?.message).toContain("direct:1");
    expect(r.controller.status().state).toBe("paused");
    await r.controller.close();
    expect(JSON.stringify(r.storage.get("diagnostics:v1"))).not.toContain("secret-token");
    restarted = r.restart(); const start = r.calls.length; await restarted.restore();
    await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(restarted.status().roots.find(root => root.sessionID === "R")?.state).toBe("paused");
    expect(r.calls.slice(start).some(call => call.name === "delivery_open" && call.sessionID === "R")).toBe(false);
    expect(r.storage.get("paused:R")).toBe(false);
  } finally { await restarted?.close(); await r.controller.close(); }
});

test("an ended root stays listed but never speaks for the live roots", async () => {
  const r = runtime({}, async () => {}); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await r.controller.enroll("R"); await r.controller.enroll("B");
    await until(() => r.controller.status().roots.filter(root => root.state === "active").length === 2, 1000);
    r.nodes.delete("B"); await r.controller.observe("session.deleted", { sessionID: "B" });
    expect(r.controller.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "paused", operation: "session_end" });
    expect(r.controller.status()).toMatchObject({ state: "active", sessionID: "R" });
    expect(r.controller.status().message).toContain("be");
    await r.controller.close();
    restarted = r.restart(); await restarted.restore();
    await until(() => restarted!.status().state === "active", 1000);
    expect(restarted.status().sessionID).toBe("R");
  } finally { await restarted?.close(); await r.controller.close(); }
});

test.each([false, true])("expiry failed-continuation barrier joins actual subscriber admission and detects late model work (%j)", async forbidden => {
  const work = observeRuns(CoreController.prototype), gate = new FailedContinuation();
  const admission = barrier(), releaseAdmission = barrier(), model = barrier();
  const waits: number[] = [], models: string[] = [];
  let outage = false, forwarded = false, retired = false;
  const error = new Error("controlled network unavailable");
  const r = runtime({}, async (ms, signal) => {
    waits.push(ms);
    if (waits.length >= 5 && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    r.bind("R", "be");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(async () => { admission.release(); await releaseAdmission.promise; forwarded = true; gate.returned(); });
    r.observe(async operation => {
      if (outage && ["delivery_renew", "delivery_receipt", "connect"].includes(operation)) await gate.observe(async () => { throw error; });
    });
    await r.controller.enroll("R"); await bounded(admission.promise, 1000, "Actual subscriber entered held admission");
    const original = work.current("R"); void original.then(() => { retired = true; });
    gate.arm(); outage = true; releaseAdmission.release();
    await bounded(gate.failed.promise, 1000, "Actual post-admission receipt failed and is held");
    expect(forwarded).toBe(true); expect(retired).toBe(false); expect(waits).toEqual([]);
    expect(r.admissions).toHaveLength(1); expect(r.batches.get("R")).toHaveLength(1); // the receipt the outage failed committed nothing
    const completion = afterProducers(() => gate.failed.promise, async () => {
      await model.promise; models.push("R"); if (forbidden) models.push("B");
    }, () => assert.deepEqual(models, ["R"]));
    const checked = forbidden ? assert.rejects(completion, /deep-equal/) : completion;
    model.release(); await bounded(Promise.resolve(checked), 1000, "Counted model work drains before absence check");
    gate.release();
    await until(() => waits.length === 5, 1000);
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000]); expect(retired).toBe(false);
    expect((r.nodes.get("R")!.metadata[METADATA] as { enabled: boolean }).enabled).toBe(true);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(1); expect(r.batches.get("R")).toHaveLength(1);
    await r.controller.close(); await original; expect(retired).toBe(true);
  } finally { gate.release(); releaseAdmission.release(); model.release(); await r.controller.close(); work.restore(); }
});

test.each([false, true])("terminal retry pause survives diagnostic emission failure and requires explicit re-enrollment (%j)", async reject => {
  const r = runtime(); let exhausted = false, restored: Controller | undefined;
  const controller = new Controller(r.ctx, { mcpName: "grayboard" }, r.controller.Transport, async () => {}, async record => {
    if (record.code === "retry_exhausted") exhausted = true;
    if (reject) throw new Error("Bearer synthetic-private-error\\n at secret-canary.ts:1");
  });
  try {
    r.bind("R", "be");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(async () => { throw new Error("synthetic-private-error"); });
    await controller.enroll("R"); await until(() => exhausted, 1000); await controller.close();
    expect(r.admissions).toHaveLength(8);
    const terminal = (r.storage.get("diagnostics:v1") as { state: string; code?: string; operation: string; failure?: { operation: string } }[]).find(record => record.code === "retry_exhausted")!;
    expect(terminal.state).toBe("paused"); expect(terminal.operation).toBe("subscriber");
    if (reject) expect(terminal.failure?.operation).toBe("diagnostic_emit");
    expect(JSON.stringify(r.storage.get("diagnostics:v1"))).not.toContain("synthetic-private-error");
    expect((r.nodes.get("R")!.metadata[METADATA] as { enabled: boolean }).enabled).toBe(true);
    const opens = r.calls.filter(call => call.name === "delivery_open").length;
    r.admission(async () => {});
    restored = new Controller(r.ctx, { mcpName: "grayboard" }, r.controller.Transport, async () => {});
    await restored.restore(); await restored.flushDiagnostics();
    expect(restored.status().roots.find(root => root.sessionID === "R")?.state).toBe("paused");
    expect(r.calls.filter(call => call.name === "delivery_open")).toHaveLength(opens);
    expect(r.admissions).toHaveLength(8); expect(r.calls.filter(call => call.name === "delivery_receipt")).toEqual([]);
    await restored.enroll("R"); await until(() => r.calls.some(call => call.name === "delivery_receipt"), 1000);
    expect(r.admissions).toHaveLength(9);
  } finally { await restored?.close(); await controller.close(); await r.controller.close(); }
});

test("remembered-name bookkeeping cannot grant approval after a concurrent revocation", async () => {
  const r = runtime(); const original = r.ctx.storage.set;
  let revoked = false;
  Object.defineProperty(r.ctx.storage, "set", { configurable: true, value: async (key: string, value: Parameters<Context["storage"]["set"]>[1]) => {
    await original(key, value);
    if (key === "rememberedHeld:R" && !revoked) {
      revoked = true;
      const saved = r.nodes.get("R")!.metadata[METADATA] as { enabled: boolean };
      saved.enabled = false;
    }
  } });
  try {
    r.bind("R", "be"); await r.controller.enroll("R");
    expect(revoked).toBe(true);
    expect((r.nodes.get("R")!.metadata[METADATA] as { enabled: boolean }).enabled).toBe(false);
    expect(r.calls.filter(c => c.name === "delivery_open")).toEqual([]);
    Object.defineProperty(r.ctx.storage, "set", { configurable: true, value: original });
    await r.controller.enroll("R"); await until(() => r.controller.status().roots.some(root => root.sessionID === "R" && root.state === "active"), 1000);
    expect((r.nodes.get("R")!.metadata[METADATA] as { enabled: boolean }).enabled).toBe(true);
  } finally { Object.defineProperty(r.ctx.storage, "set", { configurable: true, value: original }); await r.controller.close(); }
});

test("diagnostic read failure does not block independently authorized roots", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await r.controller.close();
    const original = r.ctx.storage.get;
    Object.defineProperty(r.ctx.storage, "get", { value: async (key: string) => { if (key === "diagnostics:v1") throw new Error("secret storage failure"); return original(key); } });
    restarted = r.restart(); await restarted.restore();
    await until(() => restarted!.status().roots.some(root => root.sessionID === "R" && root.state === "active"), 1000);
    expect(JSON.stringify(restarted.status())).not.toContain("secret storage failure");
  } finally { await restarted?.close(); await r.controller.close(); }
});

test("before bind immediately reports rebinding without waiting for an after hook", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    await r.before("R", "grayboard_bind");
    expect(r.controller.status().roots.find(root => root.sessionID === "R")?.state).toBe("rebinding");
    await r.before("B", "grayboard_bind");
    expect(r.controller.status().roots.find(root => root.sessionID === "B")?.state).toBe("rebinding");
    expect(r.nodes.get("B")!.metadata).toEqual({});
  } finally { await r.controller.close(); }
});

test.each(["edited", "prepare"])("restore isolates a %s root without releasing a healthy root or persisting human pause", async mode => {
  const r = runtime(); let restored: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await r.controller.enroll("R"); await r.controller.enroll("B");
    await r.controller.close();
    if (mode === "edited") r.storage.set("enrollmentHash:R", "edited");
    restored = r.restart();
    if (mode === "prepare") {
      const check = restored.binding.check.bind(restored.binding);
      restored.binding.check = async e => { if ((e as Enrollment).sessionID === "R") throw new Error("temporary timeout secret"); await check(e); };
    }
    const start = r.calls.length;
    await restored.restore();
    await until(() => r.calls.slice(start).some(c => c.name === "delivery_open" && c.sessionID === "B"), 1000);
    expect(r.calls.slice(start).some(c => ["session_end", "delivery_release"].includes(c.name))).toBe(false);
    expect(r.calls.slice(start).some(c => c.name === "delivery_open" && c.sessionID === "R")).toBe(false);
    expect(r.storage.get("paused:R")).toBe(false);
    expect(r.storage.get("paused:B")).toBe(false);
    expect(r.rows.get("B")?.held).toEqual(["you@example.com/fe"]);
  } finally { await restored?.close(); await r.controller.close(); }
});

test("one event failure cannot lose later credential latching; stream retries are bounded", async () => {
  const r = runtime({ name: "be" }), abort = new AbortController(), failures: string[] = [], waits: number[] = [];
  try {
    r.bind("R", "be"); await r.controller.enroll("R");
    let subscriptions = 0, returned = 0;
    const subscribe = async function* () {
      subscriptions++;
      try {
        if (subscriptions === 1) {
          yield { type: "session.created", data: { sessionID: "missing" } };
          yield { type: "credential.switched", data: { integrationID: "native-integration" } };
        }
        throw new Error("stream token secret");
      } finally { returned++; }
    };
    await observeEvents(subscribe, event => r.controller.observe(event.type, event.data), kind => failures.push(kind), abort.signal, async ms => { waits.push(ms); });
    expect(failures.filter(k => k === "event")).toHaveLength(1);
    expect(failures.filter(k => k === "stream")).toHaveLength(8);
    expect(subscriptions).toBe(8); expect(returned).toBe(8);
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000]);
    expect(r.controller.status().state).toBe("paused");
    expect(r.calls.some(c => c.name === "delivery_release" || c.name === "session_end")).toBe(false);
  } finally { abort.abort(); await r.controller.close(); }
});

test("expired capture deleting an unenrolled child does not terminate later credential events", async () => {
  const r = runtime(), abort = new AbortController(), failures: string[] = [];
  try {
    r.bind("B", "fe"); await r.controller.enroll("B");
    await r.before("G"); r.f.expire();
    await observeEvents(async function* () {
      yield { type: "session.deleted", data: { sessionID: "C" } };
      yield { type: "credential.switched", data: { integrationID: "native-integration" } };
      abort.abort();
    }, event => r.controller.observe(event.type, event.data), kind => failures.push(kind), abort.signal);
    expect(failures).toEqual(["event"]);
    expect(r.controller.status().state).toBe("paused");
    expect(r.calls.some(c => c.name === "session_end" || c.name === "delivery_release")).toBe(false);
  } finally { abort.abort(); await r.controller.close(); }
});

test("a stream that delivered events restarts the resubscription budget", async () => {
  const abort = new AbortController(), waits: number[] = []; let subscriptions = 0;
  await observeEvents(async function* () {
    if (++subscriptions === 20) abort.abort();
    yield { type: "session.idle", data: {} };
    throw new Error("closed");
  }, async () => {}, () => {}, abort.signal, async ms => { waits.push(ms); });
  expect(subscriptions).toBe(20);
  expect(waits).toEqual(Array(19).fill(250));
});

test("event resubscription cancellation ends backoff without another subscriber", async () => {
  const abort = new AbortController(); let attempts = 0;
  await observeEvents(async function* () { attempts++; throw new Error("closed"); }, async () => {}, () => {}, abort.signal, async () => { abort.abort(); });
  expect(attempts).toBe(1);
});

test.each(["connect", "whoami", "bind"].flatMap(boundary => ["approval", "generation", "directory", "account", "endpoint"].map(change => [boundary, change] as const)))("recovery fences %s completion after %s drift before new authority", async (boundary, change) => {
  const r = runtime({}, async () => {}); let recovering = false, changed = false;
  try {
    r.bind("R", "be");
    r.readFailure(() => { if (!recovering) { recovering = true; throw new SubscriberError("receipt_capacity"); } });
    r.observe(async operation => {
      if (!recovering || changed || operation !== boundary) return;
      changed = true;
      if (change === "approval") (r.nodes.get("R")!.metadata["grayboard.enrollment"] as { enabled: boolean }).enabled = false;
      if (change === "generation") await r.controller.observe("credential.switched", { integrationID: "native-integration" });
      if (change === "directory") (r.ctx.location as { directory: string }).directory = "/other";
      if (change === "account") r.f.select("other");
      if (change === "endpoint") r.f.config.url = "https://other.example.com/mcp";
    });
    await r.controller.enroll("R");
    await until(() => r.controller.status().roots.find(root => root.sessionID === "R")?.state === "paused", 1000);
    await r.controller.close();
    expect(changed).toBe(true);
    const release = r.calls.findIndex(call => call.name === "delivery_release"); expect(release).toBeGreaterThan(-1);
    const authority = r.calls.slice(release + 1).filter(call => ["bind", "delivery_open"].includes(call.name));
    expect(authority.map(call => call.name)).toEqual(boundary === "bind" ? ["bind"] : []);
    if (authority.length) expect(authority[0]?.args.create).toBe(false);
    expect(r.calls.filter(call => call.name === "delivery_receipt")).toHaveLength(0);
    expect(r.admissions).toHaveLength(0);
  } finally { await r.controller.close(); }
});

test("capacity recovery rebinds without creation and receipts the reissued item under new ownership", async () => {
  const r = runtime({}, async () => {});
  try {
    r.bind("R", "be");
    let reads = 0;
    r.readFailure(() => {
      if (++reads === 1) throw new SubscriberError("receipt_capacity");
      const row = r.rows.get("R")!;
      r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: row.ownership, bind_gen: row.generation, name: "be" }]);
    });
    await r.controller.enroll("R");
    await until(() => r.calls.some(c => c.name === "delivery_receipt"), 1000);
    expect(r.rows.get("R")?.ownership).toBe(2);
    expect(r.calls.filter(c => c.name === "delivery_release")).toHaveLength(1);
    expect(r.calls.filter(c => c.name === "bind").map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/worktree" }]);
    expect(r.admissions).toHaveLength(1);
    expect(r.batches.get("R")).toEqual([]);
    expect(r.nodes.get("R")?.metadata).toMatchObject({ "grayboard.enrollment": { enabled: true } });
  } finally { await r.controller.close(); }
});

test.each(["receipt_capacity", "bad_request"])("only typed %s controls bounded capacity recovery", async code => {
  const r = runtime({}, async () => {});
  try {
    r.bind("R", "be");
    r.readFailure(() => { throw new SubscriberError(code); });
    await r.controller.enroll("R");
    await until(() => r.controller.status().state === "paused", 1000);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(8);
    const releases = r.calls.filter(c => c.name === "delivery_release");
    expect(releases).toHaveLength(code === "receipt_capacity" ? 8 : 0);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.calls.filter(c => c.name === "bind").map(c => c.args)).toEqual(code === "receipt_capacity" ? Array.from({ length: 7 }, () => ({ name: "you@example.com/be", create: false, where: "/worktree" })) : []);
    if (code === "receipt_capacity") {
      const first = r.calls.findIndex(c => c.name === "delivery_release");
      expect(r.calls.slice(first, first + 4).map(c => c.name)).toEqual(["delivery_release", "whoami", "bind", "delivery_open"]);
    }
  } finally { await r.controller.close(); }
});

test("a poison item exhausts eight attempts despite successful same-lease opens, without receipts or skipping", async () => {
  const waits: number[] = [];
  const r = runtime({}, async ms => { waits.push(ms); });
  try {
    r.bind("R", "be");
    r.batches.set("R", [1, 2].map(id => ({ id: `direct:${id}`, actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" })));
    r.admission(async () => { throw new Error("synthetic refused"); });
    await r.controller.enroll("R");
    await until(() => r.controller.status().state === "paused", 1000);
    expect(r.admissions).toHaveLength(8);
    expect(new Set(r.admissions.map(a => a.id)).size).toBe(1);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(8);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.batches.get("R")).toHaveLength(2);
    expect(r.controller.status().message).toContain("direct:1; item remains unreceipted");
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  } finally { await r.controller.close(); }
});
test("a successful receipt alone resets progress budget for the next item", async () => {
  const r = runtime({}, async () => {});
  try {
    r.bind("R", "be");
    r.batches.set("R", [1, 2].map(id => ({ id: `direct:${id}`, actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" })));
    let tries = 0;
    r.admission(async () => { if (++tries !== 8) throw new Error("synthetic refused"); });
    await r.controller.enroll("R");
    await until(() => r.controller.status().state === "paused", 1000);
    expect(r.admissions).toHaveLength(16);
    expect(r.calls.filter(c => c.name === "delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"]]);
    expect(r.batches.get("R")?.map(i => i.id)).toEqual(["direct:2"]);
    expect(r.controller.status().message).toContain("direct:2; item remains unreceipted");
  } finally { await r.controller.close(); }
});
test("repeated successful opens reset lease recovery but cannot erase one item's attempt budget", async () => {
  const r = runtime({}, async () => {});
  try {
    r.bind("R", "be");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(async () => { throw new LeaseUnavailable(); });
    await r.controller.enroll("R");
    await until(() => r.controller.status().state === "paused", 1000);
    expect(r.admissions).toHaveLength(8);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(9);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.controller.status().message).toContain("direct:1; item remains unreceipted");
  } finally { await r.controller.close(); }
});
test("a lease lost outside any item pauses after bounded recoveries despite successful opens", async () => {
  const r = runtime({}, async () => {});
  try {
    r.bind("R", "be");
    r.readFailure(() => { throw new LeaseUnavailable(); });
    await r.controller.enroll("R");
    await until(() => r.controller.status().state === "paused", 1000);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(4);
  } finally { await r.controller.close(); }
});
// An approved root on an actual controller with an immediate backoff, whose
// first subscription closes on demand (the server stopping, #423). `waited`
// sees the backoff waited so far, a virtual clock from that close.
async function outage(waited?: (elapsed: number, ms: number) => void | Promise<void>) {
  const r = runtime(), waits: number[] = [], codes: string[] = [], states: string[] = [];
  let elapsed = 0;
  const controller = new Controller(r.ctx, { mcpName: "grayboard" }, r.controller.Transport, async ms => { waits.push(ms); await waited?.(elapsed += ms, ms); }, record => { states.push(record.state); if (record.code) codes.push(record.code); });
  const first = Promise.withResolvers<void>();
  let listens = 0;
  r.subscriptions(() => ++listens === 1 ? first.promise : undefined);
  r.bind("R", "be");
  await controller.enroll("R");
  await until(() => controller.status().state === "active" && listens === 1, 1000);
  return { r, controller, waits, codes, states, stop: () => first.resolve() };
}
// #661: past the grace, the wait for the refresh backs off to 30 s for an hour of waits.
const RECOVERY = [1000, 2000, 4000, 8000, 16000, ...Array(119).fill(30_000)];
const STILL_EXPIRED = "Access still expired after an hour";
const item = { id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" };
test("server outages and subscription closures never spend the failure budget, and recovery reopens", async () => {
  const o = await outage();
  try {
    let refused = 10;
    o.r.observe(async operation => { if (operation === "connect" && refused > 0) { refused--; throw new ServerUnreachable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })); } });
    // After the outage: ten more closed subscriptions, then a live one with an item.
    let closures = 10;
    o.r.subscriptions(() => {
      if (closures-- > 0) return Promise.resolve();
      o.r.batches.set("R", [item]);
      return undefined;
    });
    o.stop();
    await until(() => o.r.calls.some(c => c.name === "delivery_receipt"), 1000);
    // Closures back off too: only a healthy lease (renew or receipt) resets it.
    expect(o.waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, ...Array(10).fill(8000)]);
    expect(o.codes).toContain("server_unreachable");
    expect(o.codes).toContain("subscription_closed");
    expect(o.codes).not.toContain("retry_exhausted");
    expect(o.r.calls.filter(c => c.name === "delivery_open")).toHaveLength(12);
    expect(o.r.admissions).toHaveLength(1);
    expect(o.controller.status().state).toBe("active");
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
test("a native token that expires during an outage keeps retrying; outside one it waits out the rotation grace, then pauses and waits for the refresh", async () => {
  const o = await outage();
  try {
    const failures: Error[] = [new ServerUnreachable(new Error("down")), new NativeAccessExpired(), new NativeAccessExpired()];
    o.r.observe(async operation => { if (operation === "connect" && failures.length) throw failures.shift()!; });
    o.r.subscriptions(() => { o.r.batches.set("R", [item]); return undefined; });
    o.stop();
    await until(() => o.r.calls.some(c => c.name === "delivery_receipt"), 1000);
    expect(o.waits).toEqual([500, 1000, 2000, 4000]);
    expect(o.codes).toContain("native_access_expired");
    expect(o.controller.status().state).toBe("active");
  } finally { await o.controller.close(); await o.r.controller.close(); }
  // Outside an outage: an ordinary failure reconnects, and every connect from then on finds the token expired.
  const waits: number[] = [], p = runtime({}, async ms => { waits.push(ms); });
  try {
    let connects = 0;
    p.readFailure(() => { p.readFailure(() => {}); throw new Error("transient"); });
    p.observe(async operation => { if (operation === "connect" && ++connects >= 3) throw new NativeAccessExpired(); });
    p.bind("R", "be");
    await p.controller.enroll("R");
    await until(() => p.controller.status().roots.find(root => root.sessionID === "R")?.message.startsWith(STILL_EXPIRED) === true, 1000);
    // The failure's backoff, then the rotation grace: 20 polls of 500 ms (#472).
    expect(waits.slice(0, 21)).toEqual([500, ...Array(20).fill(500)]);
    // The stored token reads valid, so each recovery attempt's prepare connects, finds it expired and keeps the
    // backoff: one connect per attempt, never a fresh grace (#661).
    expect(waits.slice(21)).toEqual(RECOVERY);
    expect(connects).toBe(23 + RECOVERY.length);
    expect(p.controller.status().roots.find(root => root.sessionID === "R")?.code).toBe("native_access_expired");
  } finally { await p.controller.close(); }
});
// #916: an access token that expires while the server is down gets no 401 to make OpenCode refresh it; once the
// server answers with the expiry, the run loop asks the host (`credential.refresh`), as the #661 recovery does.
test("a native token that expires during an outage asks OpenCode to refresh once the server answers the expiry (#916)", async () => {
  let reloadsAtRotate = -1;
  const o = await outage(elapsed => {
    // OpenCode stores its refresh once the reconnect lands; the cap keeps a regression from looping forever.
    if (reloadsAtRotate < 0 && (o.r.f.reloads > 0 || elapsed > 30_000)) { reloadsAtRotate = o.r.f.reloads; o.r.f.rotate("fake-access-two"); }
  });
  try {
    let down = true;
    o.r.observe(async operation => { if (operation === "connect" && down) { down = false; o.r.f.expire(); throw new ServerUnreachable(new Error("down")); } });
    o.r.subscriptions(() => { o.r.batches.set("R", [item]); return undefined; });
    o.stop();
    await until(() => o.r.calls.some(c => c.name === "delivery_receipt"), 1000);
    expect(reloadsAtRotate).toBe(1);
    expect(o.r.f.reloads).toBe(1);
    expect(o.codes).toContain("native_access_expired");
    expect(o.controller.status().state).toBe("active");
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
// The outage retry's refresh selects the native entry; a changed account drifts there, and that pause's record stands.
test("a native account change found by the outage retry's refresh keeps the drift's pause, not a refresh failure (#916)", async () => {
  const o = await outage();
  try {
    let down = true, armed = false;
    // The retry's own token read resolves the stored credential first; the account changes just after it.
    o.r.f.afterResolve(() => { if (armed) { armed = false; o.r.f.select("credential-two"); } });
    o.r.observe(async operation => { if (operation === "connect" && down) { down = false; o.r.f.expire(); armed = true; throw new ServerUnreachable(new Error("down")); } });
    o.stop();
    await until(() => o.controller.status().roots.find(root => root.sessionID === "R")?.state === "paused", 1000);
    await o.controller.close();
    expect(o.controller.status().roots.find(root => root.sessionID === "R")).toMatchObject({ state: "paused", message: expect.stringContaining("enroll again") });
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
test("a closed subscription is not an outage: native expiry on every reconnect, even wrapped by the SDK, pauses once the rotation grace runs out", async () => {
  const o = await outage();
  try {
    let connects = 0;
    // The SDK wraps errors thrown during connect (EraNegotiationFailed {cause}).
    o.r.observe(async operation => { if (operation === "connect") { connects++; throw new Error("era negotiation failed", { cause: new NativeAccessExpired() }); } });
    o.stop();
    await until(() => o.controller.status().roots.find(root => root.sessionID === "R")?.message.startsWith(STILL_EXPIRED) === true, 1000);
    expect(connects).toBe(21 + RECOVERY.length);
    expect(o.waits).toEqual([...Array(21).fill(500), ...RECOVERY]);
    expect(o.codes).toContain("subscription_closed");
    expect(o.controller.status().roots.find(root => root.sessionID === "R")?.code).toBe("native_access_expired");
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
// #472: OpenCode refreshes its native token at or just after expiry, up to
// ~1.5 s after the server closed the stream for it; until then the real
// Binding finds the stored token expired. Virtual time is the backoff waited since the close.
for (const lands of [600, 1500]) test(`OpenCode's refresh landing ${lands} ms after the access-expiry close resumes the same ownership without pausing or spending budget`, async () => {
  const o = await outage(elapsed => { if (elapsed >= lands) o.r.f.rotate("fake-access-two"); });
  try {
    const ownership = o.controller.status().roots.find(root => root.sessionID === "R")?.ownership;
    expect(ownership).toBe(1);
    o.r.f.expire();
    o.r.subscriptions(() => { o.r.batches.set("R", [item]); return undefined; });
    o.stop();
    await until(() => o.r.calls.some(c => c.name === "delivery_receipt"), 1000);
    // The close's own backoff, then 500 ms rotation polls; a spent failure would back off 1000 ms.
    expect(o.waits).toEqual(lands === 600 ? [500, 500] : [500, 500, 500]);
    expect(o.codes).toContain("native_access_expired");
    expect(o.states).not.toContain("paused");
    expect(o.codes).not.toContain("retry_exhausted");
    expect(o.controller.status().roots.find(root => root.sessionID === "R")).toMatchObject({ state: "active", ownership });
    expect(o.r.calls.filter(c => c.name === "delivery_open")).toHaveLength(2);
    expect(o.r.calls.some(c => c.name === "bind")).toBe(false);
    expect(o.r.admissions).toHaveLength(1);
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
test("a native refresh that never lands within the rotation grace pauses, asks OpenCode to reconnect once, and waits an hour without releasing the lease (#661)", async () => {
  const o = await outage();
  try {
    o.r.f.expire();
    o.stop();
    await until(() => o.controller.status().roots.find(root => root.sessionID === "R")?.message.startsWith(STILL_EXPIRED) === true, 1000);
    expect(o.waits).toEqual([...Array(21).fill(500), ...RECOVERY]);
    // Once per stored expiry, though every attempt asks.
    expect(o.r.f.reloads).toBe(1);
    expect(o.r.f.config).not.toHaveProperty("timeout");
    expect(o.r.f.applied).toMatchObject({ timeout: { catalog: 30_001 } });
    expect(o.controller.status().roots.find(root => root.sessionID === "R")?.code).toBe("native_access_expired");
    expect(o.r.calls.filter(c => c.name === "delivery_open")).toHaveLength(1);
    expect(o.r.calls.some(c => ["delivery_release", "session_end"].includes(c.name))).toBe(false);
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
test("a native call refused before dispatch never holds the reconnect (#661)", async () => {
  const o = await outage();
  try {
    o.r.holdRegistration(async () => { throw new Error("child_bound: end the child first"); });
    await expect(o.controller.before({ sessionID: "G", tool: "grayboard_dm_send", id: "refused" })).rejects.toThrow("child_bound");
    o.r.f.expire();
    o.stop();
    await until(() => o.r.f.reloads === 1, 1000);
    expect(o.waits.slice(0, 22)).toEqual([...Array(21).fill(500), 1000]);
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
// #917: OpenCode relists the entry's tools 100 ms (debounced) after a reload settles. A native call the reload
// released waits for its tool to be listed again, so it still runs as native (here a child's call, refused at
// registration); another tool's call is released at once and holds nothing.
test("a native call released by a reconnect waits for its tool to be listed again; another tool's doesn't (#917)", async () => {
  const o = await outage();
  try {
    const ctx = o.r.ctx as unknown as { tool: { list: () => Promise<unknown[]> } };
    const list = ctx.tool.list;
    let listed = true, empty = 0;
    ctx.tool = { ...ctx.tool, list: async () => listed ? list() : (empty++, []) };
    const binding = (o.controller as unknown as { binding: { reconnecting?: Promise<void>; calls: Map<string, number> } }).binding;
    const reload = Promise.withResolvers<void>();
    binding.reconnecting = reload.promise;
    listed = false;
    o.r.holdRegistration(async () => { throw new Error("child_bound: end the child first"); });
    let settled = false;
    const native = o.controller.before({ sessionID: "G", tool: "grayboard_dm_send", id: "mid" }).finally(() => { settled = true; });
    native.catch(() => {});
    const other = o.controller.before({ sessionID: "G", tool: "bash", id: "other" });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(empty).toBe(0);
    binding.reconnecting = undefined;
    reload.resolve();
    await other;
    expect(binding.calls.has("other")).toBe(false);
    await until(() => empty >= 3, 1000);
    expect(settled).toBe(false);
    listed = true;
    await expect(native).rejects.toThrow("child_bound");
    expect(binding.calls.has("mid")).toBe(false);
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
test("a refresh that lands while the server is down resumes on restore's outage backoff, never pausing again (#661)", async () => {
  let down = false, refused = 0, during: unknown;
  const o: Awaited<ReturnType<typeof outage>> = await outage((_elapsed, ms) => {
    // The first recovery wait: the token is refreshed, and the server is down for the prepare's connect.
    if (ms === 1000) { o.r.f.rotate("fake-access-two"); down = true; }
    else if (refused) during = o.controller.status().roots.find(root => root.sessionID === "R");
  });
  try {
    o.r.observe(async operation => { if (operation === "connect" && down) { down = false; refused++; throw new ServerUnreachable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })); } });
    o.r.f.expire();
    o.stop();
    await until(() => refused === 1 && o.controller.status().roots.find(root => root.sessionID === "R")?.state === "active", 1000);
    // The grace, one recovery wait, then restore's outage backoff: never the recovery's again.
    expect(o.waits).toEqual([...Array(21).fill(500), 1000, 500]);
    expect(during).toMatchObject({ state: "retrying", operation: "recover", code: "server_unreachable" });
    expect(o.controller.status().roots.find(root => root.sessionID === "R")).toMatchObject({ state: "active", ownership: 1 });
    expect(o.r.calls.some(c => c.name === "bind")).toBe(false);
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
// #661: OpenCode 2.1.4 refreshes only when a request draws a 401. Past the grace the plugin makes OpenCode
// reconnect the entry, never while a native call is in flight (a reconnect kills it), and the refresh that
// reconnect causes resumes delivery under the same ownership.
test("a native call in flight holds the reconnect until its after hook; the refresh it causes resumes the same ownership", async () => {
  let recovering = 0, reloadsWhileHeld = -1;
  const o: Awaited<ReturnType<typeof outage>> = await outage(async (_elapsed, ms) => {
    if (ms < 1000 || ++recovering !== 3) return;
    reloadsWhileHeld = o.r.f.reloads;
    await o.controller.after({ sessionID: "R", tool: "grayboard_dm_send", id: "held", status: "error" });
  });
  const controller = o.controller;
  try {
    await controller.before({ sessionID: "R", tool: "grayboard_dm_send", id: "held" });
    // OpenCode's provider refreshes on the reconnect's 401.
    const reload = o.r.ctx.mcp.reload;
    (o.r.ctx.mcp as { reload: () => Promise<void> }).reload = async () => { await reload(); o.r.f.rotate("fake-access-two"); };
    o.r.f.expire();
    o.stop();
    await until(() => recovering >= 3 && controller.status().roots.find(root => root.sessionID === "R")?.state === "active", 1000);
    expect(reloadsWhileHeld).toBe(0);
    expect(o.r.f.reloads).toBe(1);
    expect(o.waits).toEqual([...Array(21).fill(500), 1000, 2000, 4000, 8000]);
    expect(controller.status().roots.find(root => root.sessionID === "R")).toMatchObject({ state: "active", ownership: 1 });
    expect(o.r.calls.some(c => c.name === "bind")).toBe(false);
    expect(o.r.f.config).not.toHaveProperty("timeout");
  } finally { await o.controller.close(); await o.r.controller.close(); }
});
// #472: a restart restores a pause from its diagnostic record. One whose cause
// was native access expiry is not a refusal: the restored root re-checks the
// host's credential, waiting for a refresh that lands after load, and resumes.
// A record 2.2.0 wrote carries the cause only as its `failure.code`.
test.each([false, true])("a native access expiry pause doesn't survive a restart: restore waits for the host's refresh and resumes the same ownership (code only in failure: %j)", async legacy => {
  const r = runtime({}, async () => {}); let restarted: Controller | undefined;
  try {
    const first = Promise.withResolvers<void>();
    let listens = 0;
    r.subscriptions(() => ++listens === 1 ? first.promise : undefined);
    // Restore walks saved roots in storage-key order (#660): the expired root
    // is B, so it is restored first and the grace's first poll samples it.
    r.bind("B", "be"); r.bind("R", "fe");
    await r.controller.enroll("B"); await until(() => r.controller.status().state === "active" && listens === 1, 1000);
    await r.controller.enroll("R"); await until(() => r.controller.status().roots.filter(root => root.state === "active").length === 2, 1000);
    r.f.expire(); first.resolve();
    await until(() => r.controller.status().roots.find(root => root.sessionID === "B")?.state === "paused", 1000);
    expect(r.controller.status().roots.find(root => root.sessionID === "B")?.code).toBe("native_access_expired");
    await r.controller.close();
    if (legacy) {
      const saved = r.storage.get("diagnostics:v1") as { sessionID?: string; code?: string; time: number }[];
      r.storage.set("diagnostics:v1", saved.map(({ code, ...d }) => d.sessionID === "B" ? { ...d, failure: { operation: "reopen", code: "native_access_expired", time: d.time } } : { ...d, ...(code ? { code } : {}) }));
    }
    // OpenCode restarts with the token still expired and refreshes it after the plugin loads.
    let polls = 0, during: unknown;
    restarted = r.restart(async () => {
      if (++polls === 1) during = restarted!.status().roots.find(root => root.sessionID === "B");
      if (polls === 3) r.f.rotate("fake-access-two");
    });
    const start = r.calls.length;
    await restarted.restore();
    await until(() => restarted!.status().roots.filter(root => root.state === "active").length === 2, 1000);
    expect(polls).toBe(3);
    // The grace is visible: the old paused record gives way to a retrying one before the check.
    expect(during).toMatchObject({ state: "retrying", operation: "restore", code: "native_access_expired" });
    expect(restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "active", ownership: 1 });
    expect(r.calls.slice(start).filter(c => c.name === "delivery_open").map(c => c.sessionID).sort()).toEqual(["B", "R"]);
    expect(r.calls.slice(start).some(c => c.name === "bind")).toBe(false);
    expect(r.storage.get("paused:B")).toBe(false);
  } finally { await restarted?.close(); await r.controller.close(); }
});
// The host restarts while the server is down (a release's upgrade): the first `refused` connects are refused.
async function restoredDuringOutage(refused: number, waited?: (restarted: Controller, r: ReturnType<typeof runtime>) => Promise<void>) {
  const r = runtime({}, async () => {});
  r.bind("B", "be");
  await r.controller.enroll("B");
  await until(() => r.controller.status().state === "active", 1000);
  await r.controller.close();
  r.observe(async operation => { if (operation === "connect" && refused > 0) { refused--; throw new ServerUnreachable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })); } });
  const waits: number[] = [], states: string[] = [];
  const restarted: Controller = r.restart(async ms => {
    waits.push(ms);
    states.push(restarted.status().roots.find(root => root.sessionID === "B")!.state);
    await waited?.(restarted, r);
  });
  const start = r.calls.length;
  await restarted.restore();
  return { r, restarted, waits, states, calls: () => r.calls.slice(start) };
}
test("a restore during a server outage retries on the outage backoff, never pausing, and resumes the same ownership (#424 6)", async () => {
  const o = await restoredDuringOutage(4);
  try {
    expect(o.restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ operation: "restore", code: "server_unreachable" });
    await until(() => o.restarted.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(o.restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "active", ownership: 1 });
    expect(o.waits).toEqual([500, 1000, 2000, 4000]);
    expect(o.states).toEqual(Array(4).fill("retrying"));
    expect(o.calls().filter(c => c.name === "delivery_open").map(c => c.sessionID)).toEqual(["B"]);
    expect(o.calls().some(c => c.name === "bind")).toBe(false);
  } finally { await o.restarted.close(); await o.r.controller.close(); }
});
test("a token that expires during a restore's outage retry waits for the host's refresh, never pausing (#424 6)", async () => {
  let seen: unknown, waited = 0, reloads = -1;
  const o = await restoredDuringOutage(1, async (restarted, r) => {
    if (++waited === 1) r.f.expire();
    else { seen = restarted.status().roots.find(root => root.sessionID === "B"); reloads = r.f.reloads; r.f.rotate("fake-access-two"); }
  });
  try {
    await until(() => o.restarted.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(seen).toMatchObject({ state: "retrying", operation: "restore", code: "native_access_expired" });
    // The retry asked OpenCode to refresh before its next wait (#916).
    expect(reloads).toBe(1);
    expect(o.waits).toEqual([500, 1000]);
    expect(o.restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "active", ownership: 1 });
    expect(o.calls().filter(c => c.name === "delivery_open").map(c => c.sessionID)).toEqual(["B"]);
  } finally { await o.restarted.close(); await o.r.controller.close(); }
});
test("a native account change found by a restore's outage-retry refresh keeps the drift's pause (#916)", async () => {
  let waited = 0, armed = false;
  const o = await restoredDuringOutage(1, async (_restarted, r) => {
    if (++waited !== 1) return;
    r.f.expire(); armed = true;
    r.f.afterResolve(() => { if (armed) { armed = false; r.f.select("credential-two"); } });
  });
  try {
    await until(() => o.restarted.status().roots.find(root => root.sessionID === "B")?.state === "paused", 1000);
    await o.restarted.close();
    expect(o.restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "paused", message: expect.stringContaining("enroll again") });
  } finally { await o.restarted.close(); await o.r.controller.close(); }
});
test("a shutdown during a restore's outage retry ends it: nothing opens once the server is back (#424 6)", async () => {
  let shut = false;
  const o = await restoredDuringOutage(1, async restarted => { if (!shut) { shut = true; await restarted.shutdown("B", "detach"); } });
  try {
    await until(() => shut, 1000);
    // close waits out the control queue, so the retry's last check has run.
    await o.restarted.close();
    expect(o.calls().some(c => c.name === "delivery_open")).toBe(false);
    expect(o.waits).toHaveLength(1);
    // The shutdown's record stands: the retry wrote nothing after it.
    expect(o.restarted.status().roots.find(root => root.sessionID === "B")).toMatchObject({ state: "paused", operation: "session_end" });
  } finally { await o.restarted.close(); await o.r.controller.close(); }
});
test.each(["account", "revoked"])("a genuine refusal at restart keeps a native access expiry pause, for good (%s)", async refusal => {
  const r = runtime({}, async () => {}); let restarted: Controller | undefined, again: Controller | undefined;
  try {
    const first = Promise.withResolvers<void>();
    r.subscriptions(() => first.promise);
    r.bind("R", "be");
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    r.f.expire(); first.resolve();
    await until(() => r.controller.status().state === "paused", 1000);
    await r.controller.close();
    r.f.rotate("fake-access-two");
    if (refusal === "account") r.f.select("other"); else r.f.status("needs_auth");
    restarted = r.restart(async () => {});
    const start = r.calls.length;
    await restarted.restore();
    expect(restarted.status().roots.find(root => root.sessionID === "R")?.state).toBe("paused");
    await restarted.close();
    // The refusal is now the pause's cause: a later restart with the host healthy again still doesn't resume it.
    if (refusal === "account") r.f.select("credential-one"); else r.f.status(undefined);
    again = r.restart(async () => {}); await again.restore();
    expect(again.status().roots.find(root => root.sessionID === "R")?.state).toBe("paused");
    expect(r.calls.slice(start).some(c => c.name === "delivery_open")).toBe(false);
  } finally { await again?.close(); await restarted?.close(); await r.controller.close(); }
});
test("typed HTTP429 backoff survives successful opens until a complete admission cycle", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.throttle(2);
    r.batches.set("R", [{ id: "direct:throttled", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    const started = Date.now(); await r.controller.enroll("R");
    for (let i = 0; i < 500 && !r.calls.some(c => c.name === "delivery_receipt"); i++) await Bun.sleep(10);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(r.admissions).toHaveLength(1);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(1);
  } finally { await r.controller.close(); }
}, 10000);
test("approval without name does not bind, lease, admit or receipt; native completion opens once", async () => {
  const r = runtime();
  try {
    expect((await r.controller.enroll("R")).state).toBe("unbound");
    expect(r.calls.map(c => c.name)).toEqual(["whoami"]);
    await r.before("R", "grayboard_bind"); r.bind("R", "be"); await r.after("R", "be");
    await until(() => r.controller.status().state === "active", 1000);
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(1);
    expect(r.admissions).toHaveLength(0);
  } finally { await r.controller.close(); }
});
test("two approved roots on shared native config keep independent names, leases and admissions", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.batches.set("B", [{ id: "direct:2", actionable: false, event: {}, ownership: 2, bind_gen: 1, name: "fe" }]);
    await r.controller.enroll("R"); await r.controller.enroll("B");
    await until(() => r.calls.filter(c => c.name === "delivery_receipt").length === 2, 1000);
    expect(r.admissions.map(a => [a.sessionID, a.resume])).toEqual([["R", true], ["B", false]]);
    expect(r.calls.filter(c => c.name === "delivery_open").map(c => c.sessionID)).toEqual(["R", "B"]);
  } finally { await r.controller.close(); }
});
test("before awaits G registration directly under R via C, rejects missing ancestry", async () => {
  const r = runtime(); let done!: () => void;
  try {
    r.holdRegistration(() => new Promise(resolve => { done = resolve; }));
    let allowed = false; const pending = r.before("G").then(() => { allowed = true; });
    await until(() => !!done, 1000); expect(allowed).toBe(false);
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
    expect(r.rows.get("R")?.held).toEqual(["you@example.com/be"]);
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
    r.bind("R", "be"); await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    for (let i = 1; i <= 4; i++) {
      await r.before("R", "grayboard_bind"); r.bind("R", `name-${i}`); await r.after("R", `name-${i}`);
      await until(() => r.calls.filter(c => c.name === "delivery_open").length === i + 1, 1000);
    }
    expect(r.calls.filter(c => c.name === "delivery_release")).toHaveLength(0);
    expect(r.rows.get("R")?.ownership).toBe(1);
  } finally { await r.controller.close(); }
});
test.each(["completion", "enroll", "pause", "session.archived", "session.deleted"])("parallel bind reconciliation respects %s", async transition => {
  const r = runtime();
  try {
    r.bind("R", "initial"); await r.controller.enroll("R");
    await until(() => r.calls.filter(c => c.name === "delivery_open").length === 1, 1000);
    await Promise.all([r.before("R", "grayboard_bind"), r.before("R", "grayboard_bind")]);
    r.bind("R", "first"); await r.after("R", "first");
    await until(() => r.calls.filter(c => c.name === "delivery_open").length === 2, 1000);
    if (transition === "enroll") { await r.controller.enroll("R"); await until(() => r.calls.filter(c => c.name === "delivery_open").length === 3, 1000); }
    else if (transition === "pause") await r.controller.pause();
    else if (transition.startsWith("session.")) await r.controller.observe(transition, { sessionID: "R" });
    r.bind("R", "final"); await r.after("R", "final");
    if (transition === "completion" || transition === "enroll") {
      await until(() => r.controller.status().state === "active" && r.controller.status().message.includes("final"), 1000);
      expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(transition === "enroll" ? 4 : 3);
      expect(r.calls.filter(c => c.name === "delivery_release")).toHaveLength(0);
      expect(r.rows.get("R")?.ownership).toBe(1);
    } else {
      expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(2);
      expect(r.controller.status().state).toBe("paused");
    }
  } finally { await r.controller.close(); }
});
test("pause ends ownership, resume rebinds remembered name create:false; held name refuses once", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    await r.controller.pause(); expect(r.rows.has("R")).toBe(false);
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    expect(r.calls.find(c => c.name === "bind")?.args).toMatchObject({ name: "you@example.com/be", create: false });
    await r.controller.pause(); r.refuse(); await r.controller.enroll("R"); await Bun.sleep(20);
    expect(r.controller.status().message).toContain("approval saved");
    expect(r.controller.status().message.split("; held by the hosted session ses_other, in /work/app, last seen 3s ago")).toHaveLength(2);
    expect(r.calls.filter(c => c.name === "bind")).toHaveLength(2);
  } finally { await r.controller.close(); }
});
test("restart skips ended roots, restores another root, and resumes a paused durable name", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  const ended = "ses_" + "a".repeat(64);
  r.nodes.set(ended, { ...r.nodes.get("R")!, id: ended });
  try {
    r.bind(ended, "be"); r.bind("B", "fe");
    await r.controller.enroll(ended); await r.controller.enroll("B");
    r.nodes.delete(ended); await r.controller.observe("session.deleted", { sessionID: ended });
    await r.controller.pause(); await r.controller.close();
    restarted = r.restart(); await restarted.restore();
    expect(restarted.status().state).toBe("paused");
    await restarted.enroll("B"); await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(restarted.status().roots.find(root => root.sessionID === ended)?.state).toBe("paused");
    expect(r.calls.filter(c => c.name === "bind").at(-1)?.args).toMatchObject({ name: "you@example.com/fe", create: false });
  } finally { await restarted?.close(); await r.controller.close(); }
});

const savedRoots = (storage: Map<string, unknown>) => [...storage.keys()].filter(key => key.startsWith("enrollmentHash:")).map(key => key.slice("enrollmentHash:".length)).sort();
test("saving an approval prunes the saved roots that restore dropped", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await r.controller.enroll("R"); await r.controller.enroll("B");
    expect(savedRoots(r.storage)).toEqual(["B", "R"]);
    await r.controller.close();
    // R ended while OpenCode was down: restore skips it, and the next save drops it.
    r.nodes.delete("R");
    restarted = r.restart(); await restarted.restore();
    expect(savedRoots(r.storage)).toEqual(["B", "R"]);
    await restarted.enroll("B"); await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(savedRoots(r.storage)).toEqual(["B"]);
  } finally { await restarted?.close(); await r.controller.close(); }
});
// Plugin storage is shared by every location, so a save prunes nothing it
// can't show is gone: a root restore found ended but another location brought
// back, an edited record, and a root another plugin configuration saved all stay.
test("a save drops only saved roots still ended, keeps edited and foreign ones, and survives a failed drop (#660)", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  try {
    for (const id of ["X", "E", "O"]) r.nodes.set(id, { id, time: {}, metadata: {} });
    for (const [id, name] of [["R", "be"], ["B", "fe"], ["X", "x"], ["E", "e"], ["O", "o"]] as const) { r.bind(id, name); await r.controller.enroll(id); }
    await r.controller.close();
    const back = r.nodes.get("R")!; r.nodes.delete("R"); r.nodes.delete("X");
    r.storage.set("enrollmentHash:E", "edited");
    const foreign = r.nodes.get("O")!.metadata[METADATA] as { enrollment: Enrollment };
    foreign.enrollment = { ...foreign.enrollment, mcpName: "gb" }; r.storage.set("enrollmentHash:O", enrollmentHash(foreign.enrollment));
    restarted = r.restart(); await restarted.restore();
    expect(restarted.status().roots.find(root => root.sessionID === "E")?.message).toContain("Saved enrollment invalid");
    expect(restarted.status().roots.find(root => root.sessionID === "O")?.message ?? "").not.toContain("Saved enrollment invalid");
    // R's session resolves again (another location re-enrolled it); X's stays gone, but removing it fails once.
    r.nodes.set("R", back);
    const remove = r.ctx.storage.remove; let failed = 0;
    r.ctx.storage.remove = async key => { failed++; throw new Error(`remove ${key}`); };
    await restarted.enroll("B"); await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(failed).toBe(1); expect(r.storage.get("paused:B")).toBe(false);
    expect(savedRoots(r.storage)).toEqual(["B", "E", "O", "R", "X"]);
    r.ctx.storage.remove = remove;
    await restarted.close(); restarted = r.restart(); await restarted.restore();
    await restarted.enroll("B"); await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(savedRoots(r.storage)).toEqual(["B", "E", "O", "R"]);
  } finally { await restarted?.close(); await r.controller.close(); }
});
// Two Controllers on one plugin storage are two OpenCode locations of one
// shared service. Before #660 each save rewrote one shared root list with its
// own Controller's roots, so the other location's root dropped out of restore.
test("one location's saves never drop another location's saved root (#660)", async () => {
  const r = runtime(), other = r.restart(), approval = new Approval(r.ctx, "grayboard"); let restarted: Controller | undefined;
  const saved = async () => (await approval.saved()).map(s => [s.sessionID, !!s.approval, s.enabled]).sort();
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await Promise.all([r.controller.enroll("R"), other.enroll("B")]);
    expect(await saved()).toEqual([["B", true, true], ["R", true, true]]);
    await r.controller.pause(); await other.enroll("B");
    expect(await saved()).toEqual([["B", true, true], ["R", true, false]]);
    await r.controller.close(); await other.close();
    // R comes back from its saved approval, not only from its diagnostic record.
    restarted = r.restart(); await restarted.restore();
    await until(() => restarted!.status().roots.find(root => root.sessionID === "B")?.state === "active", 1000);
    expect(restarted.status().roots.find(root => root.sessionID === "R")).toMatchObject({ state: "paused", message: "Saved approval paused; explicitly enroll again" });
  } finally { await restarted?.close(); await other.close(); await r.controller.close(); }
});
// Storage written before #660: the shared index lost B to another location's
// save, but B's fingerprint record stayed. Restore brings both roots back
// without re-enrollment and retires the index.
test("restore migrates the pre-#660 root index without re-enrollment", async () => {
  const r = runtime(); let restarted: Controller | undefined;
  try {
    r.bind("R", "be"); r.bind("B", "fe");
    await r.controller.enroll("R"); await r.controller.enroll("B");
    await r.controller.close();
    r.storage.set("rootSessionIDs", ["R"]);
    restarted = r.restart(); await restarted.restore();
    await until(() => ["R", "B"].every(id => restarted!.status().roots.find(root => root.sessionID === id)?.state === "active"), 1000);
    expect(r.storage.has("rootSessionIDs")).toBe(false);
    expect(savedRoots(r.storage)).toEqual(["B", "R"]);
  } finally { await restarted?.close(); await r.controller.close(); }
});
test("ordinary native unbound result rebinds the durable name once with create:false", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); await r.controller.enroll("R");
    await until(() => r.controller.status().state === "active", 1000);
    r.rows.delete("R");
    await r.controller.after({ sessionID: "R", tool: "grayboard_whoami", id: "call", status: "completed", result: { output: { unbound: true, name: null, ownership: null } } });
    await until(() => r.calls.filter(c => c.name === "delivery_open").length === 2, 1000);
    expect(r.calls.filter(c => c.name === "bind").map(c => c.args)).toEqual([{ name: "you@example.com/be", create: false, where: "/worktree" }]);
    await r.before("G");
    expect(r.calls.at(-1)?.args).toEqual({ child: "G", via: ["C"] });
  } finally { await r.controller.close(); }
});
test("pause during awaited admission suppresses receipt without pretending host write was recalled", async () => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock, 1000);
    const pausing = r.controller.pause(); await Bun.sleep(5); unblock(); await pausing;
    expect(r.admissions).toHaveLength(1);
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
    expect(r.admissions[0]?.sessionID).toBe("R");
  } finally { await r.controller.close(); }
});
test.each(["session.archived", "session.deleted", "credential.switched", "rebind", "expiry"])("%s during host admission never commits a stale receipt", async mode => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock, 1000);
    let ending: Promise<unknown> | undefined;
    if (mode === "credential.switched") ending = r.controller.observe(mode, { integrationID: "native-integration" });
    else if (mode === "rebind") ending = r.before("R", "grayboard_bind");
    else if (mode === "expiry") r.rows.delete("R");
    else { r.nodes.delete("R"); ending = r.controller.observe(mode, { sessionID: "R" }); }
    await Bun.sleep(5); unblock(); await ending;
    if (mode === "expiry") await until(() => r.controller.status().state === "retrying", 1000);
    await Bun.sleep(10);
    expect(r.admissions.map(a => a.sessionID)).toEqual(["R"]);
    // An expired lease's receipt goes out and the server refuses it (#845: no renew precedes it); a guard
    // stops every other case before the receipt.
    expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(mode === "expiry" ? 1 : 0);
    expect(r.batches.get("R")).toHaveLength(1);
  } finally { await r.controller.close(); }
});
test("configuration away-and-back during host admission remains latched and sends no receipt", async () => {
  const r = runtime(); let unblock!: () => void;
  try {
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    r.admission(() => new Promise(resolve => { unblock = resolve; }));
    await r.controller.enroll("R"); await until(() => !!unblock, 1000);
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
    expect(savedRoots(r.storage)).toEqual([]);
    expect(r.controller.status().state).toBe("unenrolled");
  } finally { await r.controller.close(); }
});
test.each([true, false, undefined])("configured creation %s reaches startup bind without approval or lease", async create => {
  const r = runtime({ name: "fe", create });
  try {
    await r.controller.observe("session.created", { sessionID: "C" });
    expect(r.calls).toEqual([]);
    await r.controller.observe("session.created", { sessionID: "R" });
    expect(r.calls).toEqual([{ sessionID: "R", name: "bind", args: { name: "fe", create: create === true, where: "/worktree" } }]);
    expect(savedRoots(r.storage)).toEqual([]);
    expect(r.nodes.get("R")!.metadata).toEqual({});
    expect(r.admissions).toEqual([]);
    expect(r.controller.status().state).toBe("unenrolled");
  } finally { await r.controller.close(); }
});
test.each([true, false, undefined, "true", "false", 1, {}, null])("Promise lifecycle forwards only literal true (%j) to actual startup binding", async create => {
  const entry = "../index.js";
  const { default: plugin } = await import(entry) as typeof import("../src/index.js");
  const { setup } = await import("../src/lifecycle.js");
  expect(typeof plugin.effect).toBe("function");
  const r = runtime();
  let complete!: () => void;
  const bound = new Promise<void>(resolve => { complete = resolve; });
  const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const call = spyOn(Wire.prototype, "call").mockImplementation(async function(this: Wire, name, args = {}) {
    r.calls.push({ sessionID: this.sessionID, name, args });
    complete();
    return {};
  });
  let cleanup: (() => void | Promise<void>) | void = undefined;
  try {
    cleanup = await setup({ ...r.ctx, options: { name: "fe", create },
      rpc: { register: async () => ({ dispose: async () => {} }) },
      tool: { ...r.ctx.tool, hook: async () => ({ dispose: async () => {} }), transform: async () => ({ dispose: async () => {} }) },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        yield { type: "session.created", data: { sessionID: "R" } };
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } },
    } as unknown as Context, () => {});
    await bound;
    expect(r.calls).toEqual([{ sessionID: "R", name: "bind", args: { name: "fe", create: create === true, where: "/worktree" } }]);
    expect(savedRoots(r.storage)).toEqual([]);
    expect(r.nodes.get("R")!.metadata).toEqual({});
  } finally {
    await cleanup?.(); await r.controller.close();
    call.mockRestore(); connect.mockRestore(); close.mockRestore();
  }
});
test.each([[true, true], ["true", false], [1, false], [undefined, false]])("plugin option launcher %j: the Controller's wires declare the launcher only for literal true (#520)", async (launcher, declared) => {
  const { setup } = await import("../src/lifecycle.js");
  const r = runtime();
  let complete!: () => void;
  const bound = new Promise<void>(resolve => { complete = resolve; });
  const seen: unknown[] = [];
  const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const call = spyOn(Wire.prototype, "call").mockImplementation(async function(this: Wire) {
    seen.push((this as unknown as { meta(): Record<string, unknown> }).meta());
    complete();
    return {};
  });
  let cleanup: (() => void | Promise<void>) | void = undefined;
  try {
    cleanup = await setup({ ...r.ctx, options: { name: "fe", launcher },
      rpc: { register: async () => ({ dispose: async () => {} }) },
      tool: { ...r.ctx.tool, hook: async () => ({ dispose: async () => {} }), transform: async () => ({ dispose: async () => {} }) },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        yield { type: "session.created", data: { sessionID: "R" } };
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } },
    } as unknown as Context, () => {});
    await bound;
    expect(seen).toEqual([{ "ai.opencode/sessionID": "R", ...(declared ? { [LAUNCHER_META]: true } : {}), [SUGGESTED_META]: "worktree" }]);
  } finally {
    await cleanup?.(); await r.controller.close();
    call.mockRestore(); connect.mockRestore(); close.mockRestore();
  }
});
test("startup creation is not remembered as permission to create on resume or recovery", async () => {
  const r = runtime({ name: "fe", create: true });
  let restarted: Controller | undefined;
  try {
    await r.controller.observe("session.created", { sessionID: "R" });
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "active", 1000);
    await r.controller.pause(); await r.controller.enroll("R");
    await until(() => r.controller.status().state === "active", 1000);
    r.rows.delete("R");
    await r.controller.after({ sessionID: "R", tool: "grayboard_whoami", id: "call", status: "completed", result: { output: { unbound: true } } });
    await until(() => r.controller.status().state === "active", 1000);
    await r.controller.close(); r.rows.delete("R");
    restarted = r.restart(); await restarted.restore();
    await until(() => restarted!.status().state === "active", 1000);
    expect(r.calls.filter(c => c.name === "bind").map(c => c.args.create)).toEqual([true, false, false, false]);
  } finally { await restarted?.close(); await r.controller.close(); }
});
test("configured creation alone never chooses a name or approves receiving", async () => {
  const r = runtime({ create: true });
  try {
    await r.controller.observe("session.created", { sessionID: "R" });
    expect(r.calls).toEqual([]);
    expect(r.storage.size).toBe(0);
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
    r.bind("R", "be"); r.batches.set("R", [{ id: "direct:1", actionable: true, event: {}, ownership: 99, bind_gen: 1, address: "you@example.com/be" }]);
    await r.controller.enroll("R"); await until(() => r.controller.status().state === "paused", 1000);
    expect(r.admissions).toHaveLength(0); expect(r.calls.filter(c => c.name === "delivery_receipt")).toHaveLength(0);
  } finally { await r.controller.close(); }
});
// #430: admission is idempotent per (ownership, bind_gen, item): a lost receipt
// goes straight to the receipt on the next read, never a second admission.
test("lost receipt reopens and receipts without admitting the item again", async () => {
  const r = runtime();
  try {
    r.bind("R", "be"); r.rejectReceipt();
    r.batches.set("R", [{ id: "direct:1", actionable: false, event: {}, ownership: 1, bind_gen: 1, address: "you@example.com/be" }]);
    await r.controller.enroll("R"); await until(() => r.calls.filter(c => c.name === "delivery_receipt").length === 2, 1000);
    expect(r.admissions.map(a => a.sessionID)).toEqual(["R"]);
    expect(r.calls.filter(c => c.name === "delivery_receipt").map(c => c.args.ids)).toEqual([["direct:1"], ["direct:1"]]);
    expect(r.batches.get("R")).toEqual([]);
  } finally { await r.controller.close(); }
});
test("outer CodeMode execute and malformed native output never open a lease", async () => {
  const r = runtime();
  try {
    await r.controller.enroll("R"); r.bind("R", "be");
    await r.controller.after({ sessionID: "R", tool: "execute", id: "call", status: "completed", result: { output: { name: "be", ownership: 1, instructions: ["bound"] } } });
    await r.controller.after({ sessionID: "R", tool: "grayboard_bind", id: "call", status: "completed", result: { output: { name: "be" } } });
    expect(r.calls.filter(c => c.name === "delivery_open")).toHaveLength(0);
  } finally { await r.controller.close(); }
});

// Static service-credential mode (#270 D3): a new root enrolls itself only when the pinned issuer vouches for the
// entry and the server's whoami calls the run token's principal a service. principalKind's whoami goes over a real
// NativeWire, whose client's connect and callTool are stubbed here; the delivery wires are the runtime's FakeWire.
async function staticRuntime(kind: unknown, mode: StaticMode = { issuer: "https://grayboard.example.com" }, metadata: unknown = { resource: "https://grayboard.example.com/mcp", authorization_servers: ["https://grayboard.example.com"] }, answered: (f: ReturnType<typeof runtime>["f"], options?: { signal?: AbortSignal }) => unknown = () => {}) {
  const token = "run-token-CANARY-0123456789abcdef";
  const r = runtime({ static: mode });
  r.f.config.oauth = false;
  r.f.config.headers.Authorization = `Bearer ${token}`;
  const fetch0 = globalThis.fetch, asked: { name: string; meta: unknown }[] = [];
  globalThis.fetch = (async () => Response.json(metadata)) as unknown as typeof fetch;
  const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const callTool = spyOn(Client.prototype, "callTool").mockImplementation((async (params: { name: string; _meta?: unknown }, options?: { signal?: AbortSignal }) => {
    asked.push({ name: params.name, meta: params._meta });
    const result = answered(r.f, options);
    if (result !== undefined) return result;
    return { content: [{ type: "text", text: JSON.stringify({ id: null, principal: "svc", principal_kind: kind, held: [] }) }] };
  }) as unknown as Client["callTool"]);
  const restore = async () => { await r.controller.close(); globalThis.fetch = fetch0; connect.mockRestore(); close.mockRestore(); callTool.mockRestore(); };
  return { r, token, asked, restore };
}
const rootRecord = (c: Controller, id: string) => c.status().roots.find(root => root.sessionID === id);
test("static mode: a root whose run token is a service's enrolls itself on creation; its whoami starts no hosted session", async () => {
  const s = await staticRuntime("service");
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(s.asked).toEqual([{ name: "whoami", meta: undefined }]);
    expect(savedRoots(s.r.storage)).toHaveLength(1);
    expect(s.r.controller.enrollment("R")).toMatchObject({ integrationID: "static", connectionID: "static", configuration: { issuer: "https://grayboard.example.com" } });
    // A subagent never enrolls on its own: its root's enrollment covers it.
    await s.r.controller.observe("session.created", { sessionID: "C" });
    expect(s.asked).toHaveLength(1);
    const written = JSON.stringify([...s.r.storage.entries()]) + JSON.stringify([...s.r.nodes.values()]) + JSON.stringify(s.r.controller.status());
    expect(written).not.toContain(s.token);
  } finally { await s.restore(); }
});
test.each([["user"], [undefined], ["SERVICE"]])("static mode: a run token whose principal_kind is %j never enrolls a root by itself", async kind => {
  const s = await staticRuntime(kind);
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(s.asked).toHaveLength(1);
    expect(savedRoots(s.r.storage)).toEqual([]);
    expect(s.r.controller.enrollment("R")).toBeUndefined();
    expect(s.r.calls).toEqual([]);
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "refused" });
  } finally { await s.restore(); }
});
test.each([
  ["no pinned issuer", { refused: "Static mode needs a pinned issuer (GRAYBOARD_OPENCODE_ISSUER)" }, undefined],
  ["metadata naming another issuer", undefined, { resource: "https://grayboard.example.com/mcp", authorization_servers: ["https://elsewhere.example.com"] }],
] as const)("static mode with %s asks no whoami and enrolls nothing", async (_name, mode, metadata) => {
  const s = await staticRuntime("service", mode, metadata);
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(s.asked).toEqual([]);
    expect(savedRoots(s.r.storage)).toEqual([]);
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll" });
  } finally { await s.restore(); }
});
// #270 audit F3: with GRAYBOARD_OPENCODE_PRINCIPAL set, only that service's run token enrolls a root by itself.
test.each([["svc", true], ["ingest", false]] as const)("static mode with the launcher's principal %j: whoami's principal \"svc\" enrolls: %j", async (principal, enrolls) => {
  const s = await staticRuntime("service", { issuer: "https://grayboard.example.com", principal });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(s.asked).toHaveLength(1);
    expect(savedRoots(s.r.storage)).toHaveLength(enrolls ? 1 : 0);
    if (!enrolls) {
      expect(s.r.controller.enrollment("R")).toBeUndefined();
      expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "refused" });
    }
  } finally { await s.restore(); }
});
// #270 audit F4: the enrollment's capture must read the entry whose token whoami checked; a token swapped in between
// (a config reload) is refused, never enrolled unchecked.
test("static mode refuses to enroll when the entry's run token changed between the kind check and the enrollment", async () => {
  const s = await staticRuntime("service", undefined, undefined, f => { f.config.headers.Authorization = "Bearer run-token-SWAPPED-0123456789abcdef"; });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(s.asked).toHaveLength(1);
    expect(savedRoots(s.r.storage)).toEqual([]);
    expect(s.r.controller.enrollment("R")).toBeUndefined();
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", message: "Native binding changed during enrollment; explicitly enroll again" });
    // The expectation doesn't outlive the attempt: a later explicit enroll reads the entry afresh.
    await s.r.controller.enroll("R");
    expect(s.r.controller.enrollment("R")).toBeDefined();
  } finally { await s.restore(); }
});
// #1250: a static run has no person to enroll by hand, so an auto-enroll that met an outage is retried; an answer
// (a refusal) is not, and close ends a retry's wait without enrolling.
const unavailable = () => new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, "Service Unavailable", { status: 503 });
test("static mode retries an auto-enroll whose whoami met a 503, and enrolls the root once the server answers", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying", operation: "enroll" });
    expect(s.r.controller.enrollment("R")).toBeUndefined();
    await until(() => s.r.controller.enrollment("R"), 5000, "the retry enrolls R");
    expect(s.asked).toHaveLength(2);
    expect(savedRoots(s.r.storage)).toHaveLength(1);
  } finally { await s.restore(); }
});
test("static mode doesn't retry an auto-enroll the server refused", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => { throw new Refusal("auth", "token refused"); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", message: "token refused" });
    expect(s.asked).toHaveLength(1);
  } finally { await s.restore(); }
});
test("static mode: close ends an auto-enroll retry's wait, and nothing enrolls after it", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => { throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await s.r.controller.close();
    expect(s.asked).toHaveLength(1);
    expect(savedRoots(s.r.storage)).toEqual([]);
  } finally { await s.restore(); }
});
// The retry loop's private in-flight set, so a test can wait a retry out instead of sleeping.
const retriesSettled = (c: Controller) => Promise.all((c as unknown as { enrollRetries: Set<Promise<void>> }).enrollRetries);
const metadataOK = () => Response.json({ resource: "https://grayboard.example.com/mcp", authorization_servers: ["https://grayboard.example.com"] });
const networkError = () => Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
// #1250 audit M1: the pin check's metadata fetch is a run's first request, so an outage there is retried and never
// reads as a pin mismatch; a 4xx other than 429, or metadata naming another issuer, stays the identity refusal.
test.each([
  ["a 503", () => new Response("unavailable", { status: 503 })],
  ["a 500", () => new Response(null, { status: 500 })],
  ["a 429", () => new Response(null, { status: 429 })],
  ["a refused connection", () => { throw networkError(); }],
  ["a timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }],
] as const)("static mode retries an auto-enroll whose pin check met %s, and enrolls once the metadata answers", async (_name, outage) => {
  const s = await staticRuntime("service");
  let failures = 1;
  globalThis.fetch = (async () => failures-- > 0 ? outage() : metadataOK()) as unknown as typeof fetch;
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying", operation: "enroll", code: "server_unreachable" });
    expect(s.asked).toEqual([]);
    await until(() => s.r.controller.enrollment("R"), 5000, "the retry enrolls R");
    expect(s.asked).toHaveLength(1);
  } finally { await s.restore(); }
});
test.each([[404], [401]])("static mode: a pin check answered HTTP %j is the identity refusal, not retried", async status => {
  const s = await staticRuntime("service");
  globalThis.fetch = (async () => new Response(null, { status })) as unknown as typeof fetch;
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", message: "Native issuer does not match the pinned issuer" });
    await retriesSettled(s.r.controller);
    expect(s.asked).toEqual([]);
  } finally { await s.restore(); }
});
// #1250 audit M2: the server answers whoami's domain errors as isError results; its outage codes are retried.
test.each([["rate_limited"], ["internal_error"]])("static mode retries an auto-enroll whose whoami answered isError %j, and enrolls once it answers", async code => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => failures-- > 0 ? { content: [{ type: "text", text: `error: ${code}` }], structuredContent: { code }, isError: true } : undefined);
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying", operation: "enroll", code: "server_unreachable" });
    await until(() => s.r.controller.enrollment("R"), 5000, "the retry enrolls R");
    expect(s.asked).toHaveLength(2);
  } finally { await s.restore(); }
});
// An HTTP 429 that outlasted the wire's own admission retries reaches auto-enroll as the SDK's error: an outage too.
test("static mode retries an auto-enroll whose whoami met an HTTP 429", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, "Too Many Requests", { status: 429 }); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await until(() => s.r.controller.enrollment("R"), 5000, "the retry enrolls R");
  } finally { await s.restore(); }
});
// The pin check classifies its own fetch's failures, so a plugin wire's token (Binding.check) reports a timeout as
// the server unreachable, which the core's outage paths match, never as an unclassified error.
test.each([
  ["a timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }],
  ["a refused connection", () => { throw networkError(); }],
] as const)("static mode: the pin check reports %s as ServerUnreachable", async (_name, outage) => {
  const s = await staticRuntime("service");
  globalThis.fetch = (async () => outage()) as unknown as typeof fetch;
  try {
    expect(await s.r.controller.binding.capture("R").then(() => undefined, (error: unknown) => error)).toBeInstanceOf(ServerUnreachable);
  } finally { await s.restore(); }
});
test("static mode: whoami's other isError answers stand as not a service token", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => ({ content: [{ type: "text", text: "error: forbidden" }], structuredContent: { code: "forbidden" }, isError: true }));
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "refused" });
    await retriesSettled(s.r.controller);
    expect(s.asked).toHaveLength(1);
  } finally { await s.restore(); }
});
test("static mode retries an auto-enroll whose whoami timed out", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw new Error("whoami failed", { cause: new DOMException("The operation timed out.", "TimeoutError") }); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await until(() => s.r.controller.enrollment("R"), 5000, "the retry enrolls R");
  } finally { await s.restore(); }
});
// #1250 audit L1: close during the first attempt (which close doesn't wait for) leaves no retrying record behind.
test("static mode: close during the first auto-enroll attempt records nothing after it", async () => {
  const s = await staticRuntime("service");
  let fail!: (error: unknown) => void, fetched = false;
  globalThis.fetch = (() => { fetched = true; return new Promise((_, reject) => { fail = reject; }); }) as unknown as typeof fetch;
  try {
    const observed = s.r.controller.observe("session.created", { sessionID: "R" });
    await until(() => fetched, 5000, "the pin check's fetch starts");
    await s.r.controller.close();
    fail(networkError());
    await observed;
    await retriesSettled(s.r.controller);
    expect(rootRecord(s.r.controller, "R")).toBeUndefined();
    expect(s.asked).toEqual([]);
  } finally { await s.restore(); }
});
// #1250 audit L2/L3: a retry stops when the session ends (recording why) or the root was enrolled meanwhile.
test("static mode: a root that ends during a retry's wait is asked no more, and isn't left retrying", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => { throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await s.r.controller.observe("session.deleted", { sessionID: "R" });
    await retriesSettled(s.r.controller);
    expect(s.asked).toHaveLength(1);
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", message: "Root ended before auto-enroll reached the server" });
  } finally { await s.restore(); }
});
test("static mode: a root enrolled during a retry's wait isn't enrolled again", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await s.r.controller.enroll("R");
    const enrolled = s.r.controller.enrollment("R");
    expect(enrolled).toBeDefined();
    await retriesSettled(s.r.controller);
    expect(s.asked).toHaveLength(1);
    expect(s.r.controller.enrollment("R")).toBe(enrolled!);
  } finally { await s.restore(); }
});
test("static mode: close ends a retry's wait promptly", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => { throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    // The third wait is 1 s: close must not wait it out.
    await until(() => rootRecord(s.r.controller, "R")?.message.includes("(3/8)"), 5000, "the third retry's wait starts");
    const started = performance.now();
    await s.r.controller.close();
    expect(performance.now() - started).toBeLessThan(500);
    expect(s.asked).toHaveLength(3);
    // #1285: the wait's `retrying` record doesn't outlive close.
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "server_unreachable", message: "Shut down while auto-enroll was retrying; the root is not enrolled" });
  } finally { await s.restore(); }
});
// #1285: close during an in-flight retry attempt aborts it (a server that never answers would hold close for the
// attempt's 10 s timeouts) and ends the root's `retrying` record before close's flush, so a restart restores no
// retry that nothing runs; nothing records after close returns.
const hung = (signal: AbortSignal | undefined) => new Promise<never>((_, reject) => {
  if (!signal) return;
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const savedRecord = (r: ReturnType<typeof runtime>, id: string) => (r.storage.get("diagnostics:v1") as { sessionID?: string }[] | undefined)?.find(d => d.sessionID === id);
async function closeDuringAttempt(s: Awaited<ReturnType<typeof staticRuntime>>, started: () => boolean) {
  await s.r.controller.observe("session.created", { sessionID: "R" });
  expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying", message: expect.stringContaining("(1/8)") });
  await until(started, 5000, "the second attempt's request starts");
  const began = performance.now();
  await s.r.controller.close();
  expect(performance.now() - began).toBeLessThan(500);
  const closed = { state: "unenrolled", operation: "enroll", code: "server_unreachable", message: "Shut down while auto-enroll was retrying; the root is not enrolled" };
  const after = rootRecord(s.r.controller, "R");
  expect(after).toMatchObject(closed);
  expect(savedRecord(s.r, "R")).toMatchObject(closed);
  await retriesSettled(s.r.controller);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(rootRecord(s.r.controller, "R")).toEqual(after!);
  expect(savedRoots(s.r.storage)).toEqual([]);
}
test("static mode: close during a retry's pin check aborts it and ends the retrying record", async () => {
  const s = await staticRuntime("service");
  let fetches = 0;
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => ++fetches === 1 ? new Response(null, { status: 503 }) : hung(init?.signal)) as unknown as typeof fetch;
  try {
    await closeDuringAttempt(s, () => fetches === 2);
    expect(s.asked).toEqual([]);
  } finally { await s.restore(); }
});
test("static mode: close during a retry's whoami aborts it and ends the retrying record", async () => {
  let calls = 0;
  const s = await staticRuntime("service", undefined, undefined, (_f, options) => { if (++calls === 1) throw unavailable(); return hung(options?.signal); });
  try {
    await closeDuringAttempt(s, () => calls === 2);
  } finally { await s.restore(); }
});
// #1294: close aborts a retry attempt's enroll whose prepare wire is still connecting before it waits for the retry,
// rather than waiting out the wire's 10 s timeout. The root enrolled before its prepare: that record stands.
test("static mode: close during a retry's prepare connect aborts it", async () => {
  let calls = 0, connecting = 0;
  const s = await staticRuntime("service", undefined, undefined, () => { if (++calls === 1) throw unavailable(); });
  (s.r.controller as unknown as { enrollRetryFirstMs: number }).enrollRetryFirstMs = 1;
  s.r.observe(async (operation, signal) => { if (operation === "connect") { connecting++; await hung(signal); } });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    await until(() => connecting === 1, 5000, "the retry's prepare connects");
    const began = performance.now();
    await s.r.controller.close();
    expect(performance.now() - began).toBeLessThan(500);
    expect(calls).toBe(2);
    expect(connecting).toBe(1);
    expect(s.r.calls).toEqual([]);
    expect(rootRecord(s.r.controller, "R")).not.toMatchObject({ state: "retrying" });
  } finally { await s.restore(); }
});
// #1294 audit L-2: an enroll's bind wire, still connecting, ends at close too; the root's record says it stopped.
test("close during an enroll's bind connect aborts it and records a stop, not a failure", async () => {
  const r = runtime();
  let connecting = 0;
  r.observe(async (operation, signal) => { if (operation === "connect") { connecting++; await hung(signal); } });
  const enrolling = r.controller.enroll("R", ["be"], true);
  await until(() => connecting === 1, 5000, "the enroll's bind connects");
  const began = performance.now();
  await r.controller.close();
  expect(performance.now() - began).toBeLessThan(500);
  await enrolling;
  expect(r.calls).toEqual([]);
  const record = rootRecord(r.controller, "R");
  expect(record?.message).toContain("stopped before delivery opened");
  expect(record?.code).toBeUndefined();
});
// #1285 audit: close never calls a root enrolled during the retry "not enrolled"; nor does it overwrite the record
// of an attempt that answered before close stopped it.
const whoamiAnswer = (kind: string) => ({ content: [{ type: "text", text: JSON.stringify({ id: null, principal: "svc", principal_kind: kind, held: [] }) }] });
const closedRecord = { state: "unenrolled", message: "Shut down while auto-enroll was retrying; the root is not enrolled" };
test("static mode: close during a retry's wait keeps the record of a root enrolled meanwhile", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await s.r.controller.enroll("R");
    const enrolled = rootRecord(s.r.controller, "R");
    await s.r.controller.close();
    expect(rootRecord(s.r.controller, "R")).toEqual(enrolled!);
    expect(rootRecord(s.r.controller, "R")).not.toMatchObject(closedRecord);
    expect(savedRecord(s.r, "R")).toMatchObject({ state: enrolled!.state, message: enrolled!.message });
    expect(savedRoots(s.r.storage)).toHaveLength(1);
  } finally { await s.restore(); }
});
test("static mode: close during a retry attempt keeps the record of a root enrolled meanwhile", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = await staticRuntime("service", undefined, undefined, () => { if (++calls === 1) throw unavailable(); if (calls === 2) return gate.then(() => whoamiAnswer("service")); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    await until(() => calls === 2, 5000, "the retry's whoami starts");
    // The explicit enroll's own prepare asks whoami over the runtime's FakeWire, not this stub.
    await s.r.controller.enroll("R");
    const enrolled = rootRecord(s.r.controller, "R");
    const closing = s.r.controller.close();
    release();
    await closing;
    expect(rootRecord(s.r.controller, "R")).toEqual(enrolled!);
    expect(savedRoots(s.r.storage)).toHaveLength(1);
  } finally { await s.restore(); }
});
// A paused root is still enrolled (its enrollment is saved): close keeps its `paused` record.
test("static mode: close keeps the paused record of a root enrolled and paused during a retry's wait", async () => {
  let failures = 1;
  const s = await staticRuntime("service", undefined, undefined, () => { if (failures-- > 0) throw unavailable(); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "retrying" });
    await s.r.controller.enroll("R");
    await s.r.controller.pause();
    const paused = rootRecord(s.r.controller, "R");
    expect(paused).toMatchObject({ state: "paused" });
    await s.r.controller.close();
    expect(rootRecord(s.r.controller, "R")).toEqual(paused!);
    expect(savedRecord(s.r, "R")).toMatchObject({ state: "paused", message: paused!.message });
  } finally { await s.restore(); }
});
test("static mode: an attempt's own refusal that lands as close starts keeps its record", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = await staticRuntime("user", undefined, undefined, () => { if (++calls === 1) throw unavailable(); if (calls === 2) return gate.then(() => whoamiAnswer("user")); });
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    await until(() => calls === 2, 5000, "the retry's whoami starts");
    const closing = s.r.controller.close();
    release();
    await closing;
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "refused" });
    expect(savedRecord(s.r, "R")).toMatchObject({ state: "unenrolled", code: "refused" });
  } finally { await s.restore(); }
});
// #1285 I-B: a static run's retries that run out name what its operator can do, and the outage, not "explicitly
// enroll again" and operation_failed.
test("static mode: retries run out on whoami 503s record the outage and a new run", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => { throw unavailable(); });
  (s.r.controller as unknown as { enrollRetryFirstMs: number }).enrollRetryFirstMs = 1;
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    await retriesSettled(s.r.controller);
    expect(s.asked).toHaveLength(9);
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "server_unreachable", message: "Auto-enroll gave up after 8 retries (server_unreachable); once the server answers, the launcher must start a new run" });
  } finally { await s.restore(); }
});
// #1250 re-verify I-A: an isError result with no structuredContent is never parsed as whoami's JSON answer.
test("static mode: a whoami isError result without structuredContent stands as not a service token", async () => {
  const s = await staticRuntime("service", undefined, undefined, () => ({ content: [{ type: "text", text: "error: forbidden" }], isError: true }));
  try {
    await s.r.controller.observe("session.created", { sessionID: "R" });
    expect(rootRecord(s.r.controller, "R")).toMatchObject({ state: "unenrolled", operation: "enroll", code: "refused" });
    expect(s.asked).toHaveLength(1);
  } finally { await s.restore(); }
});
test("static mode tells the person to start a new run, not to sign in through OpenCode", async () => {
  const r = runtime({ static: { issuer: "https://grayboard.example.com" } }), oauth = runtime();
  try {
    expect(r.controller.port.loginAction).toBe(NEW_RUN);
    expect(oauth.controller.port.loginAction).toBe(SIGN_IN);
  } finally { await r.controller.close(); await oauth.controller.close(); }
});
