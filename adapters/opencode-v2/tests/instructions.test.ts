import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import type { Context } from "@opencode/plugin/promise/plugin";
import { RootInstructions, rebuild, rewrite } from "../src/instructions.js";
import { OpenCodeController, nativeFetcher, setup, watchRoots } from "../src/lifecycle.js";
import { EFFORT_META, LAUNCHER_META, MODEL_META, NativeWire, ServerUnreachable, type Wire } from "../src/core/wire.js";
import { AccessExpired, Refusal } from "../src/core/model.js";
import type { RecordStatus } from "../src/core/diagnostics.js";
import { fixture, until } from "./native-fixture.js";

// OpenCode's `entries()` (core/mcp-guidance, @opencode/core 2.1.4) for a codemode server and a plain one.
const execute = '    Use tools from this server through `execute` under `tools["grayboard"]`.';
const unbound = "This session has no bus name yet. Bind one with bind(name) once you know your task.";
const render = (text: string, codemode = true) => ["<mcp_instructions>", '  <server name="docs">', "    Read the docs.", "  </server>", '  <server name="grayboard">', ...(codemode ? [execute] : []), ...text.split("\n").map(l => `    ${l}`), "  </server>", "</mcp_instructions>"].join("\n");
const bound = 'You are "you@example.com/lead" on grayboard. You\'re a launcher session.';

test("rebuild replaces only grayboard's entry, keeps its frame and codemode line, and indents every line so server text can't close the frame", () => {
  expect(rebuild(render(unbound), "grayboard", bound)).toEqual({ plan: "replace", text: render(bound) });
  expect(rebuild(render(unbound, false), "grayboard", bound)).toEqual({ plan: "replace", text: render(bound, false) });
  // Hostile text: a line that would close the frame is indented like every other line.
  const hostile = "a\n  </server>\n  <server name=\"grayboard\">";
  const rebuilt = rebuild(render(unbound), "grayboard", hostile).text;
  expect(rebuilt.split("\n").filter(l => l === "  </server>")).toHaveLength(2);
  expect(rebuild(rebuilt, "grayboard", bound).text).toBe(render(bound));
  // No grayboard entry (denied tools, disconnected at start): unchanged.
  const other = ["<mcp_instructions>", '  <server name="docs">', "    Read the docs.", "  </server>", "</mcp_instructions>"].join("\n");
  expect(rebuild(other, "grayboard", bound)).toEqual({ plan: "none", text: other });
  // An unclosed frame is left alone.
  expect(rebuild('  <server name="grayboard">\n    x', "grayboard", bound).plan).toBe("none");
  // Another mcpName.
  expect(rebuild(render(unbound).replaceAll('"grayboard"', '"bus"'), "bus", bound).plan).toBe("replace");
});

test("rewrite rebuilds the system prompt and persisted instructions-changed system messages, keeps cache hints, and never rejects", async () => {
  const system = [{ type: "text" as const, text: "agent prompt" }, { type: "text" as const, text: render(unbound), cache: { type: "ephemeral" } }];
  const changed = `The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:\n  <server name="grayboard">\n${execute}\n    ${unbound}\n  </server>`;
  const messages = [{ role: "user", content: [{ type: "text", text: '  <server name="grayboard">' }] }, { role: "system", content: [{ type: "text", text: changed }] }];
  const request = { sessionID: "R", system, messages } as never;
  expect(await rewrite(request, "grayboard", async () => bound)).toBe("replace");
  expect(system[0]!.text).toBe("agent prompt");
  expect(system[1]).toEqual({ type: "text", text: render(bound), cache: { type: "ephemeral" } });
  expect(messages[1]!.content[0]!.text).toContain(`    ${bound}\n  </server>`);
  expect(messages[1]!.content[0]!.text).not.toContain(unbound);
  // A user message is never touched.
  expect(messages[0]!.content[0]!.text).toBe('  <server name="grayboard">');
  // Unchanged text leaves the same bytes; no text leaves the request as built.
  const before = system[1]!.text;
  expect(await rewrite(request, "grayboard", async () => bound)).toBe("replace");
  expect(system[1]!.text).toBe(before);
  expect(await rewrite(request, "grayboard", async () => undefined)).toBe("none");
  expect(await rewrite(request, "grayboard", async () => { throw new Error("boom"); })).toBe("none");
  expect(system[1]!.text).toBe(before);
});

test("RootInstructions caches per root, refetches after invalidate, falls back to the last text on an outage or the deadline, and clears it on sign-out", async () => {
  let text = "one", fail: unknown, hang: Promise<void> | undefined, fetches = 0;
  const reports: unknown[] = [];
  const cache = new RootInstructions(async () => { fetches++; await hang; if (fail) throw fail; return text; }, (_id, error) => { reports.push(error); }, 50);
  expect(await cache.current("R")).toBe("one");
  expect(await cache.current("R")).toBe("one");
  expect(fetches).toBe(1);
  text = "two"; cache.invalidate("R");
  expect(await cache.current("R")).toBe("two");
  // Outage: the last text, reported once until a fetch succeeds.
  fail = new ServerUnreachable(new Error("down")); cache.invalidate("R");
  const outage = fetches;
  expect(await cache.current("R")).toBe("two");
  expect(await cache.current("R")).toBe("two");
  expect(reports).toHaveLength(1);
  // The failed fetch keeps the last text until the next invalidation: one wait per outage, not per request.
  expect(fetches).toBe(outage + 1);
  expect(cache.state("R")).toBe("stale");
  // Token rollover (`expired`) is transient too: the last text stays.
  fail = new AccessExpired("OpenCode", "sign in"); cache.invalidate("R");
  expect(await cache.current("R")).toBe("two");
  cache.invalidate("R");
  // A hung fetch: the deadline returns the last text, and the late result still fills the cache.
  fail = undefined; text = "three";
  let release!: () => void; hang = new Promise<void>(resolve => { release = resolve; });
  const started = Date.now();
  expect(await cache.current("R")).toBe("two");
  expect(Date.now() - started).toBeLessThan(1_000);
  const inflight = fetches;
  expect(await cache.current("R")).toBe("two");
  expect(fetches).toBe(inflight);
  release(); hang = undefined;
  await Bun.sleep(0);
  expect(await cache.current("R")).toBe("three");
  // An invalidation during a fetch fetches again, so the cache never keeps a stale answer as fresh.
  hang = new Promise<void>(resolve => { release = resolve; });
  cache.invalidate("R");
  const pending = cache.current("R");
  text = "four"; cache.invalidate("R");
  release(); hang = undefined;
  await pending; await Bun.sleep(0);
  expect(await cache.current("R")).toBe("four");
  // Sign-out clears the root's text; a later success reports again on the next failure.
  expect(cache.state("R")).toBe("fresh");
  for (const error of [new AccessExpired("OpenCode", "sign in", "login_required"), new AccessExpired("OpenCode", "sign in", "refresh_outcome_unknown"), new Refusal("auth", "x"), new Refusal("binding", "y")]) {
    fail = error; cache.invalidate("R");
    expect(await cache.current("R")).toBeUndefined();
    expect(cache.state("R")).toBe("none");
    fail = undefined; text = "back"; cache.invalidate("R");
    expect(await cache.current("R")).toBe("back");
  }
  // Roots are separate.
  text = "other";
  expect(await cache.current("B")).toBe("other");
  expect(await cache.current("R")).toBe("back");
  cache.close();
  expect(await cache.current("R")).toBeUndefined();
});

test("close aborts an in-flight fetch and answers nothing after it", async () => {
  let seen: AbortSignal | undefined;
  const cache = new RootInstructions((_id, signal) => { seen = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }, () => {}, 5_000);
  const pending = cache.current("R");
  await Bun.sleep(0);
  expect(seen?.aborted).toBe(false);
  cache.close();
  expect(seen?.aborted).toBe(true);
  expect(await pending).toBeUndefined();
});

test("watchRoots invalidates a root when its state, holds or ownership change, never on the instructions operation or a background record", async () => {
  const changed: string[] = [], forwarded: string[] = [];
  const sink = watchRoots(record => { forwarded.push(record.operation); }, id => { changed.push(id); });
  const rec = (r: Partial<RecordStatus>) => sink({ state: "active", message: "", operation: "delivery", time: 0, ...r } as RecordStatus);
  rec({ sessionID: "R", held: ["you@example.com/be"], ownership: 1 });
  rec({ sessionID: "R", held: ["you@example.com/be"], ownership: 1, message: "same shape" });
  rec({ sessionID: "R", state: "degraded", operation: "instructions" });
  rec({ sessionID: "R", held: ["you@example.com/be", "you@example.com/fe"], ownership: 1 });
  rec({ sessionID: "R", held: ["you@example.com/be", "you@example.com/fe"], ownership: 2 });
  rec({ sessionID: "R", state: "paused", held: ["you@example.com/be", "you@example.com/fe"], ownership: 2 });
  rec({ state: "degraded", operation: "wire_close" });
  rec({ sessionID: "B" });
  expect(changed).toEqual(["R", "R", "R", "R", "B"]);
  expect(forwarded).toHaveLength(8);
});

test("the native fetcher names the root on a native connection with the launcher declaration and no delivery, and the controller reports bind and unbind", async () => {
  const f = fixture(), metadata = new Map<string, Record<string, unknown>>();
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: {}, metadata: metadata.get(sessionID) ?? {} }), update: async ({ sessionID, metadata: m }: { sessionID: string; metadata: Record<string, unknown> }) => { metadata.set(sessionID, m); }, synthetic: async () => {} },
    tool: { list: async () => ["bind", "unbind", "whoami"].map(name => ({ id: `grayboard_${name}`, options: { namespace: "grayboard" } })) },
  } as unknown as Context;
  class IdleWire { client = { setNotificationHandler: () => {} }; constructor(_o: unknown, _a: unknown, readonly signal: AbortSignal, readonly sessionID: string) {} async connect() {} async close() {} async call(name: string) { return name === "whoami" ? { held: [], primary: null, unbound: true, candidates: [] } : {}; } async read() { return { items: [] }; } async listen() { return { closed: new Promise<void>(() => {}), close: async () => {} }; } }
  const controller = new OpenCodeController(ctx, { mcpName: "grayboard", launcher: true }, IdleWire as unknown as typeof Wire);
  const seen: unknown[] = [];
  const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const instructions = spyOn(NativeWire.prototype, "instructions").mockImplementation(function(this: NativeWire) {
    seen.push({ meta: (this as unknown as { meta(): Record<string, unknown> }).meta(), headers: (() => { const h = new Headers(); (this as unknown as { decorate(h: Headers): void }).decorate(h); return [...h.keys()]; })() });
    return bound;
  });
  try {
    const fetch = nativeFetcher(controller);
    expect(await fetch("R", new AbortController().signal)).toBeUndefined();
    expect((await controller.enroll("R")).state).toBe("approved");
    expect(await fetch("R", new AbortController().signal)).toBe(bound);
    expect(seen).toEqual([{ meta: { "ai.opencode/sessionID": "R", [LAUNCHER_META]: true }, headers: [] }]);
    // The root's noted model rides its next native connection (#364).
    controller.noteModel("R", { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
    await fetch("R", new AbortController().signal);
    expect(seen[1]).toEqual({ meta: { "ai.opencode/sessionID": "R", [LAUNCHER_META]: true, [MODEL_META]: "anthropic/claude-opus-5-5", [EFFORT_META]: "high" }, headers: [] });
    const changed: string[] = [];
    controller.bindingChanged = id => { changed.push(id); };
    for (const tool of ["grayboard_bind", "grayboard_unbind", "grayboard_whoami", "other_bind"]) await controller.after({ sessionID: "R", tool, id: "c", status: "error" });
    expect(changed).toEqual(["R", "R"]);
  } finally {
    await controller.close();
    instructions.mockRestore(); connect.mockRestore(); close.mockRestore();
  }
});

// Each session's model as its latest context request used it (#364): `providerID/id`, the variant as effort, none (null, a clear: #558) without one; a request
// with no model leaves what was noted; past 256 sessions the least recently noted is forgotten.
test("the controller keeps each session's latest model for its wires, for the 256 most recent sessions", async () => {
  const f = fixture();
  const ctx = { ...f.ctx, location: { directory: "/worktree" }, session: { get: async () => ({}), update: async () => {}, synthetic: async () => {} }, tool: { list: async () => [] } } as unknown as Context;
  const controller = new OpenCodeController(ctx, { mcpName: "grayboard" });
  const facts = (id: string) => controller.port.facts!(id);
  try {
    controller.noteModel("R", { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
    controller.noteModel("S", { providerID: "openai", id: "gpt-6" });
    expect(facts("R")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
    expect(facts("S")).toEqual({ model: "openai/gpt-6", effort: null });
    controller.noteModel("R", undefined);
    expect(facts("R")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
    controller.noteModel("R", { providerID: "anthropic", id: "claude-sonnet-5-5" });
    for (let i = 0; i < 255; i++) controller.noteModel(`X${i}`, { providerID: "p", id: `m${i}` });
    expect(facts("S")).toBeUndefined();
    expect(facts("R")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: null });
  } finally { await controller.close(); }
});

test("setup's context hook leaves unenrolled sessions as built, never rejects, and shuts down before the controller", async () => {
  const f = fixture();
  let hook: ((request: unknown) => Promise<void>) | undefined;
  const order: string[] = [];
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" }, options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: {}, metadata: {} }), update: async () => {}, synthetic: async () => {},
      hook: async (name: string, callback: (request: unknown) => Promise<void>) => { expect(name).toBe("context"); hook = callback; return { dispose: async () => { order.push("context"); } }; },
    },
    rpc: { register: async () => ({ dispose: async () => { order.push("rpc"); } }) },
    tool: { list: async () => [], hook: async (name: string) => ({ dispose: async () => { order.push(name); } }) },
    event: { async *subscribe({ signal }: { signal: AbortSignal }) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } },
  } as unknown as Context;
  const close = spyOn(RootInstructions.prototype, "close").mockImplementation(function(this: RootInstructions) { order.push("instructions"); close.mockRestore(); this.close(); });
  const noted = spyOn(OpenCodeController.prototype, "noteModel");
  const cleanup = await setup(ctx, () => {}, () => {}, async () => bound);
  const system = [{ type: "text", text: "agent" }, { type: "text", text: render(unbound) }];
  // Every session's model is noted, enrolled or not: a child's wires report its own (#364).
  const model = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" };
  await hook!({ sessionID: "ses_unenrolled", model, system, messages: [] });
  expect(noted.mock.calls).toEqual([["ses_unenrolled", model]]);
  noted.mockRestore();
  expect(system[1]!.text).toBe(render(unbound));
  await expect(hook!({ sessionID: "R", system: null, messages: null })).resolves.toBeUndefined();
  await cleanup!();
  // In-flight fetches abort first, then the hook goes, before the controller closes.
  expect(order.slice(0, 2)).toEqual(["instructions", "context"]);
  expect(order).toContain("execute.before");
});

test("a subagent's cached text follows its root: invalidating the root refetches it, a failure names the root, a changed root starts over (#535)", async () => {
  const fetched: string[] = [], reported: [string, string | undefined][] = [];
  let fail = false;
  const cache = new RootInstructions(async id => { fetched.push(id); if (fail) throw new ServerUnreachable("down"); return `text ${id} ${fetched.length}`; }, (id, _e, root) => { reported.push([id, root]); });
  expect(await cache.current("C", "R")).toBe("text C 1");
  expect(await cache.current("C", "R")).toBe("text C 1");
  cache.invalidate("R");
  expect(await cache.current("C", "R")).toBe("text C 2");
  // A child's own invalidation (its refused bind) touches only itself.
  cache.invalidate("C");
  expect(await cache.current("C", "R")).toBe("text C 3");
  fail = true; cache.invalidate("R");
  expect(await cache.current("C", "R")).toBe("text C 3");
  expect(reported).toEqual([["C", "R"]]);
  fail = false;
  // Asked under another root (or as a root), the entry is dropped and fetched afresh.
  expect(await cache.current("C")).toBe("text C 5");
  expect(fetched).toEqual(["C", "C", "C", "C", "C"]);
  cache.close();
});

test("the native fetcher registers a subagent under its enrolled root before naming it, and its wire declares no launcher (#535)", async () => {
  const f = fixture(), metadata = new Map<string, Record<string, unknown>>();
  const parents: Record<string, string> = { C: "R", G: "C", U: "S", X: "R" };
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: {}, metadata: metadata.get(sessionID) ?? {}, ...(parents[sessionID] ? { parentID: parents[sessionID] } : {}) }), update: async ({ sessionID, metadata: m }: { sessionID: string; metadata: Record<string, unknown> }) => { metadata.set(sessionID, m); }, synthetic: async () => {} },
    tool: { list: async () => [] },
  } as unknown as Context;
  const order: string[] = [];
  class IdleWire { client = { setNotificationHandler: () => {} }; constructor(_o: unknown, _a: unknown, readonly signal: AbortSignal, readonly sessionID: string) {} async connect() {} async close() {} async call(name: string, args?: unknown) { if (name === "session_register") { order.push(`register ${this.sessionID} ${JSON.stringify(args)}`); if ((args as { child: string }).child === "X") throw new Error("child_bound"); } return name === "whoami" ? { held: [], primary: null, unbound: true, candidates: [] } : {}; } async read() { return { items: [] }; } async listen() { return { closed: new Promise<void>(() => {}), close: async () => {} }; } }
  const records: RecordStatus[] = [];
  const controller = new OpenCodeController(ctx, { mcpName: "grayboard", launcher: true }, IdleWire as unknown as typeof Wire, undefined, record => { records.push(record); });
  const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const instructions = spyOn(NativeWire.prototype, "instructions").mockImplementation(function(this: NativeWire) {
    order.push(`initialize ${JSON.stringify((this as unknown as { meta(): Record<string, unknown> }).meta())}`);
    return "child text";
  });
  try {
    const fetch = nativeFetcher(controller);
    // An unenrolled root's subagent gets nothing and registers nothing.
    expect(await fetch("C", new AbortController().signal)).toBeUndefined();
    expect(await controller.childRoot("U")).toBeUndefined();
    expect(order).toEqual([]);
    expect((await controller.enroll("R")).state).toBe("approved");
    expect(await controller.childRoot("R")).toBeUndefined();
    expect(await controller.childRoot("G")).toEqual({ sessionID: "G", root: "R", via: ["C"] });
    expect(await fetch("G", new AbortController().signal)).toBe("child text");
    expect(order).toEqual([`register R {"child":"G","via":["C"]}`, `initialize {"ai.opencode/sessionID":"G"}`]);
    // A refused registration names no wire: unregistered, the key would start an ownership of its own.
    order.length = 0;
    await expect(fetch("X", new AbortController().signal)).rejects.toThrow("child_bound");
    expect(order).toEqual([`register R {"child":"X"}`]);
    // The fetch reports its own failure; the refusal doesn't degrade the root.
    expect(records.filter(r => r.operation === "child_register")).toEqual([]);
  } finally {
    await controller.close();
    instructions.mockRestore(); connect.mockRestore(); close.mockRestore();
  }
});

test("setup prefetches a subagent's text when it's created, its context hook rewrites the subagent with it, and forgets it when the subagent is deleted (#535)", async () => {
  const f = fixture();
  let hook: ((request: unknown) => Promise<void>) | undefined;
  let remove!: () => void;
  const deleted = new Promise<void>(resolve => { remove = resolve; });
  const ctx = {
    ...f.ctx, location: { directory: "/worktree" }, options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: {}, metadata: {}, ...(sessionID === "C" ? { parentID: "R" } : {}) }), update: async () => {}, synthetic: async () => {},
      hook: async (_name: string, callback: (request: unknown) => Promise<void>) => { hook = callback; return { dispose: async () => {} }; },
    },
    rpc: { register: async () => ({ dispose: async () => {} }) },
    tool: { list: async () => [], hook: async () => ({ dispose: async () => {} }) },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        yield { type: "session.created", data: { sessionID: "C" } };
        await deleted;
        yield { type: "session.deleted", data: { sessionID: "C" } };
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  } as unknown as Context;
  const forgot = spyOn(RootInstructions.prototype, "forget");
  const enrolled = spyOn(OpenCodeController.prototype, "enrollment").mockImplementation((id: string) => id === "R" ? {} as never : undefined);
  const childRoot = spyOn(OpenCodeController.prototype, "childRoot").mockImplementation(async (id: string) => id === "C" ? { sessionID: "C", root: "R", via: [] } : undefined);
  const fetched: string[] = [];
  const cleanup = await setup(ctx, () => {}, () => {}, async id => { fetched.push(id); return id === "C" ? "child text" : bound; });
  try {
    await until(() => fetched.includes("C"));
    const system = [{ type: "text", text: "agent" }, { type: "text", text: render(unbound) }];
    await hook!({ sessionID: "C", system, messages: [] });
    expect(system[1]!.text).toBe(render("child text"));
    const other = [{ type: "text", text: "agent" }, { type: "text", text: render(unbound) }];
    await hook!({ sessionID: "S", system: other, messages: [] });
    expect(other[1]!.text).toBe(render(unbound));
    expect(fetched).toEqual(["C"]);
    // A deleted subagent's text goes; a session reusing the ID would fetch afresh.
    remove();
    await until(() => forgot.mock.calls.some(([id]) => id === "C"));
    await hook!({ sessionID: "C", system: [{ type: "text", text: render(unbound) }], messages: [] });
    expect(fetched).toEqual(["C", "C"]);
  } finally {
    await cleanup!();
    enrolled.mockRestore(); childRoot.mockRestore(); forgot.mockRestore();
  }
});
