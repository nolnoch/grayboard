import { expect, test } from "bun:test";
import { Effect, Logger } from "effect";
import { captureLogger } from "../src/logger.js";
import { Diagnostics, logFields, type RecordStatus } from "../src/core/diagnostics.js";
import type { Context } from "@opencode/plugin/promise/plugin";

const record: RecordStatus = { sessionID: "R", held: ["you@example.com/be"], ownership: 7, state: "paused", message: "Bearer secret-canary\n at bearer-token.ts", operation: "subscriber", code: "retry_exhausted", time: 123 };
function storage() {
  const values = new Map<string, Awaited<ReturnType<Context["storage"]["get"]>>>(), writes: unknown[] = [];
  const store = { get: async (key: string) => values.get(key), set: async (key: string, value: Parameters<Context["storage"]["set"]>[1]) => { values.set(key, structuredClone(value)); writes.push(value); }, remove: async (key: string) => { values.delete(key); }, scan: async () => ({ entries: [] }) } satisfies Context["storage"];
  return { store, writes };
}
test("captured public Effect logger receives only fixed safe fields and stops on unload", async () => {
  const events: unknown[] = [];
  const logger = Logger.make(event => { events.push(event.message); });
  const emitter = await Effect.runPromise(captureLogger.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))));
  await emitter.emit(record);
  expect(events).toHaveLength(1);
  const text = JSON.stringify(events);
  expect(text).toContain("retry_exhausted"); expect(text).toContain('"ownership":7');
  expect(text).not.toContain("secret-canary"); expect(text).not.toContain("bearer-token.ts");
  emitter.close(); await emitter.emit(record); expect(events).toHaveLength(1);
});
test("diagnostic emissions are ordered and flush joins held logger work", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const seen: number[] = [], s = storage();
  const diagnostics = new Diagnostics(s.store, async r => { seen.push(r.ownership!); if (r.ownership === 7) { entered(); await held; } });
  diagnostics.record(record); diagnostics.record({ ...record, ownership: 8 });
  let done: Promise<unknown> = Promise.resolve();
  try {
    await started; expect(seen).toEqual([7]); expect(s.writes).toHaveLength(1);
    let flushed = false; done = diagnostics.flush().then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    release(); await done; expect(seen).toEqual([7, 8]); expect(s.writes).toHaveLength(2);
  } finally { release(); await done; }
});
test("logger rejection persists a safe root failure without recursive emission", async () => {
  const s = storage(); let calls = 0;
  const diagnostics = new Diagnostics(s.store, async () => { calls++; throw new Error("secret-canary"); });
  diagnostics.record(record); expect(await diagnostics.flush()).toBe(false);
  expect(calls).toBe(1); expect(s.writes).toHaveLength(2);
  const restored = new Diagnostics(s.store); await restored.restore(async id => id === "R");
  expect(restored.status().roots[0]!.state).toBe("paused");
  expect(restored.status().roots[0]!.operation).toBe("subscriber");
  expect(restored.status().roots[0]!.code).toBe("retry_exhausted");
  expect(restored.status().roots[0]!.failure?.operation).toBe("diagnostic_emit");
  expect(JSON.stringify(restored.status())).not.toContain("secret-canary");
});
test("persistence failure still reaches the safe emitter without exposing exception properties", async () => {
  const s = storage(), events: unknown[] = [];
  const diagnostics = new Diagnostics({ ...s.store, set: async () => { throw new Error("private-storage-path-canary"); } }, r => { events.push(logFields(r)); });
  diagnostics.record(record); expect(await diagnostics.flush()).toBe(false);
  expect(JSON.stringify(events)).toContain("diagnostic_save");
  expect(JSON.stringify(events)).not.toContain("private-storage-path-canary");
});
test("an older held logger rejection cannot overwrite a queued terminal pause", async () => {
  const s = storage(); let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const diagnostics = new Diagnostics(s.store, async () => {
    if (++calls === 1) { entered(); await held; throw new Error("synthetic-private-error"); }
  });
  try {
    diagnostics.record({ ...record, state: "active", operation: "delivery", code: undefined });
    await started;
    diagnostics.record(record);
    release(); await diagnostics.flush();
    const restored = new Diagnostics(s.store); await restored.restore(async id => id === "R");
    const terminal = restored.status().roots[0]!;
    expect(terminal.state).toBe("paused"); expect(terminal.code).toBe("retry_exhausted");
    expect(terminal.operation).toBe("subscriber"); expect(terminal.failure?.operation).toBe("diagnostic_emit");
    expect(calls).toBe(2); expect(JSON.stringify(restored.status())).not.toContain("synthetic-private-error");
  } finally { release(); await diagnostics.flush(); }
});

test("host field projection never executes malformed getters or forwards nested error data", () => {
  let read = false;
  expect(logFields({ ...record, get message() { read = true; throw new Error("secret-canary"); } })).toBeUndefined();
  expect(read).toBe(false);
  expect(logFields({ ...record, failure: { operation: "subscriber", code: "operation_failed", time: 1, error: "secret-canary" } })).toBeUndefined();
});
