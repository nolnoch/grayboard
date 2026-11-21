// hosted-core's tool proxy (#430) against a real in-process server: the
// pre-login snapshot and its one login error, a write tool that binds a
// session through `_meta`, tool `_meta` (alwaysLoad) on the live list, the
// Controller hooks around each call, re-listing on each new connection,
// per-session instructions, and local-path attachments with a verified
// download. Tokens are issued for the built-in pi client, as the server's
// own OAuth issuance would.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, SdkError, SdkErrorCode, type AuthProvider, type CallToolResult } from "@modelcontextprotocol/client";
import { AccessExpired } from "../../adapters/hosted-core/src/model.ts";
import type { CallOutcome } from "../../adapters/hosted-core/src/controller.ts";
import { CallAborted, hostTools, unlessAborted, loadMode, snapshotTools, ToolProxy, type CallHooks, type NativeTool, type ProxyOptions } from "../../adapters/hosted-core/src/proxy.ts";
import { ConnectProbeFailed, connectProbe, NativeWire, OutcomeUnknown, ServerBusy, ServerUnreachable } from "../../adapters/hosted-core/src/wire.ts";
import { failureText } from "../../adapters/hosted-core/src/client.ts";
import { hashToken } from "../../src/server/auth.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { ATTACHMENT_LIMITS_CAPABILITY, ATTACHMENTS_PARAM, attachRoots, publishedLimits } from "../../src/shared/attachments.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { seed } from "../support/seed.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { drained, row as sqlRow, rows as sqlRows } from "../support/repo_sql.ts";

const CLIENT = "grayboard-pi";
let srv: TestServer, dir: string;
const proxies: ToolProxy[] = [];
beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  // Resolved: attachment paths are compared after symlinks (macOS /var → /private/var).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-proxy-")));
});
afterEach(async () => {
  await Promise.all(proxies.splice(0).map(p => p.close()));
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

const issue = (email = "alice@example.com", scopes = ["grayboard:tools", "grayboard:delivery"]) => issueOAuth(srv.app.repo, srv.app.oauth.resource, email, scopes, Date.now(), CLIENT);
type Recorded = { phase: "before" | "after"; sessionID: string; tool: string; result?: CallOutcome };
function recorder(): CallHooks & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async beforeCall(call) { calls.push({ phase: "before", ...call }); },
    async afterCall(call) { calls.push({ phase: "after", ...call }); },
  };
}
function proxy(auth: AuthProvider, extra: Partial<ProxyOptions> = {}) {
  const reports: [string, unknown][] = [];
  const p = new ToolProxy({
    wire: { url: `${srv.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" }, delivery: { mode: "push", source: "grayboard-pi" } },
    harness: "pi", loginAction: "run /grayboard login", auth, roots: attachRoots({ BUS_ATTACH_ROOTS: dir }, dir), env: { GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved") },
    report: (operation, error) => { reports.push([operation, error]); }, ...extra,
  });
  proxies.push(p);
  return Object.assign(p, { reports });
}
const textOf = (result: CallToolResult) => {
  const [only] = result.content;
  if (result.content.length !== 1 || only?.type !== "text") throw new Error(`expected one text content: ${JSON.stringify(result)}`);
  return only.text;
};
const tool = (tools: NativeTool[], name: string) => tools.find(t => t.name === name)!;
// The session's row with its primary (oldest) hold's name: ties by address in byte order (SQLite's BINARY collation).
const hostedRow = async (raw: string, user: number) => {
  const id = hostedSessionId(user, CLIENT, raw);
  const r = await sqlRow<{ source_session_id: string; client_id: string }>(srv, "SELECT source_session_id, client_id FROM hosted_sessions WHERE session_id = ?", id);
  if (!r) return null;
  const holds = await sqlRows<{ address: string; bound_at: number }>(srv, "SELECT address, bound_at FROM alias_holds WHERE id = ?", id);
  const hold = holds.sort((x, y) => Number(x.bound_at) - Number(y.bound_at) || (x.address < y.address ? -1 : x.address > y.address ? 1 : 0))[0];
  return { name: hold ? hold.address.slice(hold.address.indexOf("/") + 1) : null, ...r };
};

test("before login: the snapshot's tools with local-path attachments, and every call returns one error naming the login action", async () => {
  const hooks = recorder();
  let tokens = 0;
  const signedOut = proxy({ token: async () => { tokens++; return undefined; } }, { hooks });
  const tools = signedOut.tools();
  expect(tools).toEqual(hostTools(snapshotTools()));
  expect(tools.map(t => t.name)).toContain("attachment_get");
  for (const name of ["dm_send", "board_post"]) {
    const properties = tool(tools, name).inputSchema.properties!;
    expect(properties.attachments).toEqual(ATTACHMENTS_PARAM);
    expect(properties).not.toHaveProperty("attachment_ids");
    expect(tool(tools, name).description).not.toMatch(/attachment_ids|uploaded IDs/);
  }
  expect([loadMode(tool(tools, "dm_inbox")), loadMode(tool(tools, "dm_ack")), loadMode(tool(tools, "whoami"))]).toEqual(["essential", "essential", "discoverable"]);
  for (const name of ["whoami", "bind", "attachment_get"]) {
    expect(await signedOut.call(name, { name: "early" }, "pi-root")).toEqual({ content: [{ type: "text", text: "error: Signed out of grayboard in pi; run /grayboard login" }], isError: true });
  }
  expect(hooks.calls).toEqual([]);
  expect(tokens).toBe(3);
  // A credential that throws AccessExpired (the login store's loginRequired) reads the same.
  const expired = proxy({ token: async () => { throw new AccessExpired("pi", "run /grayboard login", "refresh_outcome_unknown"); } });
  expect(textOf(await expired.call("whoami", {}, "pi-root"))).toBe("error: Signed out of grayboard in pi; run /grayboard login");
  await expect(expired.instructions("pi-root")).rejects.toBeInstanceOf(AccessExpired);
});

test("the MCP URL must be canonical HTTPS or loopback HTTP, without credentials, query or fragment", () => {
  const wire = { sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" }, delivery: { mode: "push" as const, source: "grayboard-pi" } };
  for (const url of ["http://grayboard.example.com/mcp", "https://user:pw@grayboard.example.com/mcp", "https://grayboard.example.com/mcp?x=1", "https://grayboard.example.com/mcp#f"])
    expect(() => proxy({ token: async () => undefined }, { wire: { ...wire, url } })).toThrow("Grayboard MCP URL must be canonical HTTPS (or HTTP loopback)");
  expect(proxy({ token: async () => undefined }, { wire: { ...wire, url: "https://grayboard.example.com/mcp" } }).tools()).toEqual(hostTools(snapshotTools()));
});

test("a write tool round trip binds the calling session through _meta; results come back verbatim; hooks wrap each call", async () => {
  const { token, authed } = await issue();
  const hooks = recorder();
  const changed: NativeTool[][] = [];
  const p = proxy({ token: async () => token }, { hooks, onTools: tools => { changed.push(tools); } });
  // After login: the live list replaces the snapshot; it matches it, so no re-register.
  const live = await p.connect();
  expect(live).toEqual(hostTools(snapshotTools()));
  expect(changed).toEqual([]);
  // The tool definition's `_meta` survives the live list.
  expect([tool(live, "dm_inbox")._meta, tool(live, "dm_ack")._meta]).toEqual([{ "anthropic/alwaysLoad": true }, { "anthropic/alwaysLoad": true }]);
  expect([loadMode(tool(live, "dm_inbox")), loadMode(tool(live, "dm_ack"))]).toEqual(["essential", "essential"]);

  const bound = await p.call("bind", { name: "proxy-run", create: true }, "pi-root");
  expect(bound.isError).toBeUndefined();
  const output = bound.structuredContent as { name: string; ownership: number; instructions: string[] };
  expect(output.name).toBe("proxy-run");
  expect(Number.isSafeInteger(output.ownership)).toBe(true);
  expect(output.instructions.length).toBeGreaterThan(0);
  expect(textOf(bound)).toStartWith(`Bound to "proxy-run"`);
  // The server's own record: the session named in `_meta`, under the pi client.
  expect(await hostedRow("pi-root", authed.user_id)).toEqual({ name: "proxy-run", source_session_id: "pi-root", client_id: CLIENT });
  expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-run" });
  // The shared connection routes per call: another session is still unbound.
  expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-other")))).toMatchObject({ unbound: true });
  expect((await hostedRow("pi-other", authed.user_id))?.name ?? null).toBeNull();
  // A refusal comes back as the server wrote it, and afterCall sees an error.
  const taken = await p.call("bind", { name: "proxy-run", create: true }, "pi-other");
  expect(taken.isError).toBe(true);
  expect(JSON.parse(textOf(taken))).toMatchObject({ code: "alias_held" });

  expect(hooks.calls).toEqual([
    { phase: "before", sessionID: "pi-root", tool: "bind" },
    { phase: "after", sessionID: "pi-root", tool: "bind", result: { status: "completed", output } },
    { phase: "before", sessionID: "pi-root", tool: "whoami" },
    { phase: "after", sessionID: "pi-root", tool: "whoami", result: { status: "completed", output: expect.objectContaining({ primary: expect.stringMatching(/\/proxy-run$/) }) } },
    { phase: "before", sessionID: "pi-other", tool: "whoami" },
    { phase: "after", sessionID: "pi-other", tool: "whoami", result: { status: "completed", output: expect.objectContaining({ unbound: true }) } },
    { phase: "before", sessionID: "pi-other", tool: "bind" },
    { phase: "after", sessionID: "pi-other", tool: "bind", result: { status: "error" } },
  ]);
  expect(p.reports).toEqual([]);
});

test("each new native connection re-lists the tools; a changed list reaches the adapter", async () => {
  const { token } = await issue();
  const changed: string[][] = [];
  const p = proxy({ token: async () => token }, { onTools: tools => { changed.push(tools.map(t => t.name)); } });
  const list = NativeWire.prototype.listTools, call = NativeWire.prototype.callTool;
  let lists = 0, failNext = false, dropRetract = false;
  NativeWire.prototype.listTools = async function () {
    lists++;
    const tools = await list.call(this);
    return dropRetract ? tools.filter(t => t.name !== "dm_retract") : tools;
  };
  NativeWire.prototype.callTool = async function (...args) {
    if (failNext) { failNext = false; throw new ServerUnreachable(new Error("fixture outage")); }
    return call.apply(this, args);
  };
  const hooks = recorder();
  try {
    await p.connect();
    expect(lists).toBe(1);
    // The first call reuses that connection.
    await p.call("whoami", {}, "pi-root");
    expect(lists).toBe(1);
    // A transport failure throws the wire's classified error, afterCall sees an
    // error, and the next call opens a new connection, which re-lists.
    const failing = proxy({ token: async () => token }, { hooks });
    await failing.connect();
    failNext = true;
    await expect(failing.call("whoami", {}, "pi-root")).rejects.toBeInstanceOf(ServerUnreachable);
    expect(hooks.calls.at(-1)).toEqual({ phase: "after", sessionID: "pi-root", tool: "whoami", result: { status: "error" } });
    dropRetract = true;
    const listsBefore = lists;
    expect(JSON.parse(textOf(await failing.call("whoami", {}, "pi-root")))).toMatchObject({ unbound: true });
    expect(lists).toBe(listsBefore + 1);
    expect(failing.tools().map(t => t.name)).not.toContain("dm_retract");
    // connect() after a login also re-lists, and reports the difference.
    await p.connect();
    expect(changed).toEqual([hostTools(snapshotTools()).map(t => t.name).filter(n => n !== "dm_retract")]);
  } finally {
    NativeWire.prototype.listTools = list;
    NativeWire.prototype.callTool = call;
  }
});

test("a call's own failure leaves the shared connection to the calls in flight on it; a transport failure replaces it", async () => {
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  const list = NativeWire.prototype.listTools, call = NativeWire.prototype.callTool, fetch0 = globalThis.fetch;
  let lists = 0, fail: Error | undefined;
  NativeWire.prototype.listTools = async function () { lists++; return list.call(this); };
  NativeWire.prototype.callTool = async function (...args) {
    const error = args[0] === "whoami" ? fail : undefined;
    if (error) { fail = undefined; throw error; }
    return call.apply(this, args);
  };
  const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  // A board_list request held at the network: in flight on the shared connection.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.method === "POST" && (await input.clone().text()).includes(`"name":"board_list"`)) { entered(); await held; }
    return fetch0(input, init);
  }) as typeof fetch;
  try {
    await p.call("bind", { name: "proxy-flight", create: true }, "pi-root");
    expect(lists).toBe(1);
    const inFlight = p.call("board_list", {}, "pi-root");
    await reached;
    // A JSON-RPC error (an unknown tool), then a request that timed out.
    await expect(p.call("no_such_tool", {}, "pi-root")).rejects.toThrow();
    fail = new ServerUnreachable(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"));
    await expect(p.call("whoami", {}, "pi-root")).rejects.toBeInstanceOf(ServerUnreachable);
    release();
    expect((await inFlight).isError).toBeFalsy();
    expect(lists).toBe(1);
    // A broken transport retires it: the next call opens and lists a new one.
    fail = new ServerUnreachable(new Error("fixture outage"));
    await expect(p.call("whoami", {}, "pi-root")).rejects.toBeInstanceOf(ServerUnreachable);
    expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-flight" });
    expect(lists).toBe(2);
  } finally {
    release();
    globalThis.fetch = fetch0;
    NativeWire.prototype.listTools = list;
    NativeWire.prototype.callTool = call;
  }
});

test("connect() and retire() leave calls in flight to finish: a new connection takes the new calls, and the one it replaced closes after its last", async () => {
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  const list = NativeWire.prototype.listTools, close = NativeWire.prototype.close, fetch0 = globalThis.fetch;
  let lists = 0, closes = 0;
  NativeWire.prototype.listTools = async function () { lists++; return list.call(this); };
  NativeWire.prototype.close = async function () { closes++; return close.call(this); };
  // The next board_list request is held at the network: in flight on its connection.
  let hold: { entered(): void; held: Promise<void> } | undefined;
  const holdNext = () => {
    const reached = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    hold = { entered: reached.resolve, held: held.promise };
    return { reached: reached.promise, release: held.resolve };
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (hold && input instanceof Request && input.method === "POST" && (await input.clone().text()).includes(`"name":"board_list"`)) {
      const h = hold;
      hold = undefined;
      h.entered();
      await h.held;
    }
    return fetch0(input, init);
  }) as typeof fetch;
  const first = holdNext();
  try {
    await p.call("bind", { name: "proxy-swap", create: true }, "pi-root");
    const inFlight = p.call("board_list", {}, "pi-root");
    await first.reached;
    // A login's reconnect: a new connection, listed; the old one stays open under its call.
    await p.connect();
    expect([lists, closes]).toEqual([2, 0]);
    expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-swap" });
    first.release();
    expect((await inFlight).isError).toBeFalsy();
    await until(() => closes === 1, 5_000, "the replaced connection closed");

    // A host replacing the whole proxy retires it: closed once its calls settle.
    const last = holdNext();
    const pending = p.call("board_list", {}, "pi-root");
    await last.reached;
    // Closing now would abort the held request (the proxy's closing signal),
    // so its success shows retire() waited for it.
    const retiring = p.retire();
    last.release();
    expect((await pending).isError).toBeFalsy();
    await retiring;
    expect(closes).toBe(2);
  } finally {
    first.release();
    globalThis.fetch = fetch0;
    NativeWire.prototype.listTools = list;
    NativeWire.prototype.close = close;
  }
});

test("instructions are per session and cached until that session's bind result or forget()", async () => {
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  const first = p.instructions("pi-root");
  expect(p.instructions("pi-root")).toBe(first);
  const unbound = await first;
  expect(unbound).toBeString();
  expect(unbound).not.toContain("proxy-inst");
  const other = p.instructions("pi-other");
  expect(other).not.toBe(first);
  await p.call("bind", { name: "proxy-inst", create: true }, "pi-root");
  const after = p.instructions("pi-root");
  expect(after).not.toBe(first);
  expect(await after).toContain("proxy-inst");
  // Another session's cache is untouched by this one's bind.
  expect(p.instructions("pi-other")).toBe(other);
  // forget(): a binding the host changed outside this proxy (its Controller's own bind).
  p.forget("pi-other");
  expect(p.instructions("pi-other")).not.toBe(other);
});

test("dm_send with a local file uploads and attaches it; attachment_get saves it after checking the digest", async () => {
  const alice = await issue("alice@example.com"), bob = await issue("bob@example.com");
  const sender = proxy({ token: async () => alice.token }), reader = proxy({ token: async () => bob.token });
  await sender.call("bind", { name: "proxy-a", create: true }, "pi-a");
  await reader.call("bind", { name: "proxy-b", create: true }, "pi-b");
  const bytes = "proxy attachment report\n";
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "report.txt"), bytes);

  const sent = await sender.call("dm_send", { to: "bob@example.com/proxy-b", body: "see attached", attachments: [join(dir, "report.txt")] }, "pi-a");
  expect(sent.isError).toBeUndefined();
  await drained(srv);
  const message = (await sqlRow<{ id: number }>(srv, "SELECT id FROM messages WHERE body = 'see attached'"))!;
  const stored = await sqlRows<{ id: number; filename: string; sha256: string; message_id: number | null }>(srv, "SELECT id, filename, sha256, message_id FROM attachments");
  expect(stored).toEqual([{ id: expect.any(Number), filename: "report.txt", sha256: sha256Hex(new TextEncoder().encode(bytes)), message_id: message.id }]);
  const id = stored[0]!.id;

  // The default directory is server mode's: this bus's folder under GRAYBOARD_ATTACHMENTS_DIR.
  const saved = JSON.parse(textOf(await reader.call("attachment_get", { id }, "pi-b"))) as { path: string; filename: string; type: string; size: number; sha256: string };
  expect(saved).toEqual({ path: join(dir, "saved", new URL(srv.base).host.replace(/[^A-Za-z0-9.-]/g, "_"), `${id}-report.txt`), filename: "report.txt", type: "text/plain", size: bytes.length, sha256: stored[0]!.sha256 });
  expect(readFileSync(saved.path, "utf8")).toBe(bytes);
  const into = JSON.parse(textOf(await reader.call("attachment_get", { id, dir: join(dir, "out") }, "pi-b"))) as { path: string };
  expect(into.path).toBe(join(dir, "out", `${id}-report.txt`));

  // Bytes that don't match the server's Repr-Digest are refused before any save.
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch0(input, init);
    if (init?.method !== "GET" || !String(input).includes("/attachments/")) return response;
    return new Response(new TextEncoder().encode("tampered bytes\n"), { status: 200, headers: response.headers });
  }) as typeof fetch;
  mkdirSync(join(dir, "tampered"));
  try {
    const tampered = await reader.call("attachment_get", { id, dir: join(dir, "tampered") }, "pi-b");
    expect(tampered).toEqual({ content: [{ type: "text", text: `error: attachment ${id}: the bytes received don't match the server's sha256` }], isError: true });
    expect(readdirSync(join(dir, "tampered"))).toEqual([]);
  } finally { globalThis.fetch = fetch0; }

  // A refused send releases its uploads: one was made, nothing is left unsent.
  // Uploads the server stored (each an attachments row whose transaction committed; what SQLite's sqlite_sequence
  // counted, on either backend). An insert whose transaction rolls back drops its afterCommit effect, so isn't counted.
  let stores = 0;
  const insertUpload = srv.app.repo.attachments.insertUpload.bind(srv.app.repo.attachments);
  const storeSpy = spyOn(srv.app.repo.attachments, "insertUpload").mockImplementation(async (tx, upload) => { const out = await insertUpload(tx, upload); tx.afterCommit(() => { stores++; }); return out; });
  const uploads = () => stores;
  const before = uploads();
  writeFileSync(join(dir, "second.txt"), "second\n");
  const refused = await sender.call("dm_send", { to: "nobody@example.com/missing", body: "lost", attachments: [join(dir, "second.txt")] }, "pi-a");
  expect(refused.isError).toBe(true);
  storeSpy.mockRestore();
  expect(uploads()).toBe(before + 1);
  await drained(srv);
  expect((await sqlRow<{ n: number }>(srv, "SELECT count(*) AS n FROM attachments WHERE message_id IS NULL AND post_id IS NULL"))!.n).toBe(0);
  // A path outside the roots never leaves the host.
  const outside = await sender.call("dm_send", { to: "bob@example.com/proxy-b", body: "x", attachments: [join(tmpdir(), "nope.txt")] }, "pi-a");
  expect(outside.isError).toBe(true);
  expect(textOf(outside)).toStartWith("error: attachment ");
  expect(sender.reports).toEqual([]);
});

// #438 item 26: the harness's abort (pi's Esc, /new) ends the wait for one
// call: it throws CallAborted, never an outage, and leaves the shared
// connection, the other calls on it and the proxy's retire() alone.
test("a call's signal aborts only that call: CallAborted, the shared connection and its other calls untouched, nothing saved", async () => {
  const { token } = await issue();
  const hooks = recorder();
  const p = proxy({ token: async () => token }, { hooks });
  const list = NativeWire.prototype.listTools, fetch0 = globalThis.fetch;
  let lists = 0, posts = 0;
  NativeWire.prototype.listTools = async function () { lists++; return list.call(this); };
  // board_list POSTs and attachment GETs are held at the network until their own signal aborts.
  const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const getReached = Promise.withResolvers<void>();
  const stall = async (init?: RequestInit, reached = entered) => {
    reached();
    await Promise.race([held, new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))]);
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.method === "POST") {
      const body = await input.clone().text();
      if (body.includes(`"name":"whoami"`) || body.includes(`"name":"board_list"`)) posts++;
      if (body.includes(`"name":"board_list"`)) await stall({ signal: input.signal });
    }
    if (init?.method === "GET" && String(input).includes("/attachments/")) await stall(init, getReached.resolve);
    return fetch0(input, init);
  }) as typeof fetch;
  try {
    await p.call("bind", { name: "proxy-abort", create: true }, "pi-root");
    // Already aborted: nothing goes out.
    const before = posts;
    await expect(p.call("whoami", {}, "pi-root", AbortSignal.abort())).rejects.toBeInstanceOf(CallAborted);
    expect(posts).toBe(before);

    const ac = new AbortController();
    const aborted = p.call("board_list", {}, "pi-root", ac.signal);
    await reached;
    ac.abort();
    await expect(aborted).rejects.toBeInstanceOf(CallAborted);
    // The shared connection stays: a call after the abort runs on it, unlisted again.
    expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-abort" });
    expect(lists).toBe(1);
    expect(p.reports).toEqual([]);
    // afterCall still ran for the aborted call, as an error.
    expect(hooks.calls.filter(c => c.tool === "board_list").map(c => [c.phase, c.result?.status])).toEqual([["before", undefined], ["after", "error"]]);

    // An aborted download saves nothing.
    writeFileSync(join(dir, "small.txt"), "small file");
    const sent = JSON.parse(textOf(await p.call("dm_send", { to: "proxy-abort", body: "file", attachments: [join(dir, "small.txt")] }, "pi-root"))) as { attachments: { id: number }[] };
    const download = new AbortController();
    const got = p.call("attachment_get", { id: sent.attachments[0]!.id, dir }, "pi-root", download.signal);
    await getReached.promise;
    download.abort();
    await expect(got).rejects.toBeInstanceOf(CallAborted);
    expect(readdirSync(dir)).toEqual(["small.txt"]);

    // /new's teardown: retire() settles at once after an abort.
    const last = new AbortController();
    const pending = p.call("board_list", {}, "pi-root", last.signal);
    last.abort();
    await expect(pending).rejects.toBeInstanceOf(CallAborted);
    await p.retire();
  } finally {
    release();
    globalThis.fetch = fetch0;
    NativeWire.prototype.listTools = list;
  }
});

// An aborted send never leaves its uploads unsent: the releases don't take
// the call's signal, so each upload is deleted and nothing is reported.
test("an aborted dm_send with attachments still releases every upload", async () => {
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  await p.call("bind", { name: "abort-send", create: true }, "pi-send");
  writeFileSync(join(dir, "a.txt"), "first file");
  writeFileSync(join(dir, "b.txt"), "second file");
  const unsent = async () => { await drained(srv); return (await sqlRow<{ n: number }>(srv, "SELECT count(*) AS n FROM attachments WHERE message_id IS NULL"))!.n; };
  const before = await unsent();
  const fetch0 = globalThis.fetch;
  const deletes: string[] = [];
  const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") deletes.push(String(input));
    if (input instanceof Request && input.method === "POST" && (await input.clone().text()).includes(`"name":"dm_send"`)) {
      entered();
      // Held until its own signal aborts: the server never takes the send.
      await new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    }
    return fetch0(input, init);
  }) as typeof fetch;
  try {
    const ac = new AbortController();
    const sending = p.call("dm_send", { to: "abort-send", body: "files", attachments: [join(dir, "a.txt"), join(dir, "b.txt")] }, "pi-send", ac.signal);
    await reached;
    expect(await unsent()).toBe(before + 2);
    ac.abort();
    await expect(sending).rejects.toBeInstanceOf(CallAborted);
    expect(deletes).toHaveLength(2);
    expect(await unsent()).toBe(before);
    expect(p.reports).toEqual([]);
  } finally { globalThis.fetch = fetch0; }
  await p.retire();
});

// A connect still in flight (here, its tool listing) is shared: an abort ends
// only the aborted call's wait for it, and the next call still gets it.
test("an abort ends a call's wait for the shared connect, which the next call still uses", async () => {
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  const list = NativeWire.prototype.listTools;
  const { promise: listing, resolve: listed } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  NativeWire.prototype.listTools = async function () { listed(); await gate; return list.call(this); };
  try {
    const ac = new AbortController();
    const waiting = p.call("whoami", {}, "pi-connect", ac.signal);
    await listing;
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(CallAborted);
    const next = p.call("whoami", {}, "pi-connect");
    open();
    expect((await next).isError).toBeFalsy();
  } finally {
    open();
    NativeWire.prototype.listTools = list;
  }
  await p.retire();
});

// An already-aborted signal still observes the work: a connect only this call
// opened would otherwise reject unhandled, and pi exits on that.
test("unlessAborted with an already-aborted signal leaves the work's later rejection handled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { promise: work, reject } = Promise.withResolvers<never>();
    await expect(unlessAborted(work, AbortSignal.abort())).rejects.toBeInstanceOf(CallAborted);
    reject(new Error("connect failed"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("attachment_get cancels an oversized download before saving it", async () => {
  await srv.stop();
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, attachmentLimits: { file: 16, total: 32 } });
  const alice = await issue(), p = proxy({ token: async () => alice.token });
  await p.call("bind", { name: "download-cap", create: true }, "pi-cap");
  writeFileSync(join(dir, "small.txt"), "small file");
  const sent = JSON.parse(textOf(await p.call("dm_send", { to: "download-cap", body: "file", attachments: [join(dir, "small.txt")] }, "pi-cap"))) as { attachments: { id: number }[] };
  const id = sent.attachments[0]!.id, fetch0 = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch0(input, init);
    if (init?.method !== "GET" || !String(input).includes("/attachments/")) return response;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel() { cancelled = true; } }), { headers: response.headers });
  }) as typeof fetch;
  try {
    const result = await p.call("attachment_get", { id, dir }, "pi-cap");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exceeds the 16B limit per file");
    expect(cancelled).toBe(true);
    expect(readdirSync(dir)).toEqual(["small.txt"]);
  } finally { globalThis.fetch = fetch0; }
});

test("uploads are checked against the server's published caps; a server that publishes none gets the defaults", async () => {
  await srv.stop();
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, attachmentLimits: { file: 16, total: 32 } });
  const alice = await issue("alice@example.com");
  const p = proxy({ token: async () => alice.token });
  await p.call("bind", { name: "proxy-caps", create: true }, "pi-caps");
  writeFileSync(join(dir, "big.txt"), "twenty bytes long!!\n");
  const fetch0 = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/mcp/attachments")) uploads++;
    return fetch0(input, init);
  }) as typeof fetch;
  // hosted-core resolves its own copy of the SDK: patch the Client its wire uses.
  const HostedClient = Object.getPrototypeOf(new NativeWire({ url: `${srv.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" } }, { token: async () => undefined }, AbortSignal.abort()).client) as Client;
  const capabilities = HostedClient.getServerCapabilities;
  try {
    // Published: the 16-byte cap refuses the file before any byte leaves the host.
    const local = await p.call("dm_send", { to: "alice@example.com/proxy-caps", body: "big", attachments: [join(dir, "big.txt")] }, "pi-caps");
    expect(local).toEqual({ content: [{ type: "text", text: `error: attachment ${join(dir, "big.txt")}: 20B exceeds the 16B limit per file` }], isError: true });
    expect(uploads).toBe(0);
    // None published (an older server): the defaults let it through, and the server's own cap refuses the upload.
    HostedClient.getServerCapabilities = function (this: Client) {
      const { experimental: _, ...rest } = capabilities.call(this) ?? {};
      return rest;
    };
    await p.connect();
    const remote = await p.call("dm_send", { to: "alice@example.com/proxy-caps", body: "big", attachments: [join(dir, "big.txt")] }, "pi-caps");
    expect(remote).toEqual({ content: [{ type: "text", text: "error: file big.txt: 20B exceeds the 16B limit per file" }], isError: true });
    expect(uploads).toBe(1);
  } finally {
    globalThis.fetch = fetch0;
    HostedClient.getServerCapabilities = capabilities;
  }
  await drained(srv);
  expect((await sqlRow<{ n: number }>(srv, "SELECT count(*) AS n FROM attachments"))!.n).toBe(0);
  expect(() => publishedLimits({ [ATTACHMENT_LIMITS_CAPABILITY]: { file: 0, total: 32 } })).toThrow(`Invalid ${ATTACHMENT_LIMITS_CAPABILITY} capability from the server`);
  expect(publishedLimits({})).toBeUndefined();
});

test("an attachment request refused with 401 runs the credential's onUnauthorized once, then retries", async () => {
  const { token } = await issue();
  let refreshed = 0, current = token;
  const p = proxy({ token: async () => current, onUnauthorized: async () => { refreshed++; current = token; } });
  await p.call("bind", { name: "proxy-self", create: true }, "pi-root");
  writeFileSync(join(dir, "note.txt"), "note\n");
  // The access token went stale: the upload, this call's first request, meets the 401.
  current = "stale-token";
  const sent = await p.call("dm_send", { to: "alice@example.com/proxy-self", body: "to self", attachments: [join(dir, "note.txt")] }, "pi-root");
  expect(refreshed).toBe(1);
  expect(sent.isError).toBeUndefined();
  await drained(srv);
  expect((await sqlRow<{ n: number }>(srv, "SELECT count(*) AS n FROM attachments WHERE message_id IS NOT NULL"))!.n).toBe(1);
});

test("a token without the tools scope needs a new login, never a refresh", async () => {
  const { token } = await issue("alice@example.com", ["grayboard:delivery"]);
  let refreshed = 0;
  const p = proxy({ token: async () => token, onUnauthorized: async () => { refreshed++; } });
  expect(textOf(await p.call("whoami", {}, "pi-root"))).toBe("error: Signed out of grayboard in pi; run /grayboard login");
  expect(refreshed).toBe(0);
});

test("a 401 the credential's refresh doesn't fix needs a new login: tool calls, uploads and instructions alike", async () => {
  const { token, refreshToken } = await issue();
  let refreshed = 0;
  const p = proxy({ token: async () => token, onUnauthorized: async () => { refreshed++; } });
  expect((await p.call("bind", { name: "proxy-gone", create: true }, "pi-root")).isError).toBeUndefined();
  // Revoking the refresh token revokes the grant (RFC 7009), so the access token dies with it.
  await seed(srv.app.repo, tx => srv.app.repo.oauth.revokeToken(tx, hashToken(refreshToken), CLIENT, Date.now()));
  const signedOut = "error: Signed out of grayboard in pi; run /grayboard login";
  expect(await p.call("whoami", {}, "pi-root")).toEqual({ content: [{ type: "text", text: signedOut }], isError: true });
  writeFileSync(join(dir, "gone.txt"), "gone\n");
  expect(textOf(await p.call("dm_send", { to: "alice@example.com/proxy-gone", body: "x", attachments: [join(dir, "gone.txt")] }, "pi-root"))).toBe(signedOut);
  const instructions = await p.instructions("pi-root").then(() => undefined, (error: unknown) => error);
  expect(instructions).toBeInstanceOf(AccessExpired);
  expect(instructions).toMatchObject({ reason: "expired", message: "Signed out of grayboard in pi; run /grayboard login" });
  // Each refused request ran the credential's refresh once before giving up.
  expect(refreshed).toBe(3);
});

// #1345: a call whose request left before the transport failed (a gateway 503, a reset after the server ran it) may
// have taken effect, so the agent hears "check before calling it again", never "call the tool again"; a socket that
// never opened (refused, at the call or at the shared connect) ran nothing and stays "Server unreachable". The broken
// connection is still dropped, and nothing sends the call again. A credential's own outage (a refresh on the
// request's token() or in onUnauthorized) also ran nothing and stays unreachable; a call in flight when its proxy
// closes is a stop, not an outage. Every call here runs the connect probe (#1347): one that passes changes nothing (the
// 503 and the reset are still unknown), one that can't connect by its deadline fails the call unsent.
test("a call cut off after its request left reports its outcome unknown and is sent once; a socket that never opened, a credential outage and a proxy close are not (#1345, #1347)", async () => {
  const listening = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  // A peer that resets every connection once the request arrives: Bun's own ECONNRESET.
  const resetter = createServer(socket => { socket.once("data", () => socket.destroy()); });
  const resetPort = await listening(resetter);
  // A port nothing listens on: Bun's own ECONNREFUSED.
  const closed = createServer();
  const deadPort = await listening(closed);
  await new Promise(resolve => closed.close(resolve));
  const { token } = await issue();
  const p = proxy({ token: async () => token });
  const list = NativeWire.prototype.listTools, fetch0 = globalThis.fetch;
  const probe0 = { ...connectProbe };
  // The probe is skipped behind a proxy: none here, whatever this machine sets.
  const proxyVars = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"], proxyEnv = proxyVars.map(n => process.env[n]);
  for (const n of proxyVars) delete process.env[n];
  let probes = 0;
  connectProbe.coldMs = 0;
  connectProbe.open = (host, port) => { probes++; return probe0.open(host, port); };
  let lists = 0, mode: "pass" | "503" | "reset" | "refused" | "hold" | "blackhole" = "pass";
  const { promise: holding, resolve: held } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const posts: string[] = [];
  NativeWire.prototype.listTools = async function () { lists++; return list.call(this); };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (mode !== "pass" && input instanceof Request && input.method === "POST") {
      const body = await input.clone().text();
      if (body.includes(`"method":"tools/call"`) && body.includes(`"name":"board_post"`)) {
        if (mode === "hold") { held(); await released; return fetch0(input, init); }
        posts.push(mode);
        if (mode === "503") return new Response("", { status: 503 });
        if (mode === "refused") return fetch0(`http://127.0.0.1:${deadPort}/mcp`, { method: "POST", body: "x" });
        // The server runs the post; its answer is lost to a reset.
        await (await fetch0(input, init)).text();
        return fetch0(`http://127.0.0.1:${resetPort}/mcp`, { method: "POST", body: "x" });
      }
    }
    return fetch0(input, init);
  }) as typeof fetch;
  const failed = (body: string) => p.call("board_post", { board: "outage", body }, "pi-root").then(() => { throw new Error("expected a failure"); }, (error: unknown) => error);
  const bodies = async () => (JSON.parse(textOf(await p.call("board_read", { board: "outage" }, "pi-root"))) as { posts: { body: string }[] }).posts.map(post => post.body);
  const unknownText = "Server unreachable mid-call; it may have taken effect, so check (dm_history, board_read, claim_list) before calling it again";
  try {
    expect((await p.call("bind", { name: "proxy-outage", create: true }, "pi-root")).isError).toBeUndefined();
    expect((await p.call("board_create", { name: "outage", purpose: "#1345" }, "pi-root")).isError).toBeUndefined();
    expect(lists).toBe(1);

    mode = "503";
    let probed = probes;
    const gateway = await failed("gateway");
    // It passed a real probe first, and is still unknown.
    expect(probes).toBe(probed + 1);
    expect(gateway).toBeInstanceOf(OutcomeUnknown);
    expect(gateway).toBeInstanceOf(ServerUnreachable);
    expect(failureText(gateway, "call the tool again")).toBe(unknownText);
    mode = "pass";
    expect(await bodies()).toEqual([]);
    // The broken connection was dropped: that read opened and listed a new one.
    expect(lists).toBe(2);

    mode = "reset";
    probed = probes;
    const reset = await failed("landed");
    expect(probes).toBe(probed + 1);
    expect(reset).toBeInstanceOf(OutcomeUnknown);
    expect(failureText(reset, "call the tool again")).toBe(unknownText);
    mode = "pass";
    // It took effect, once.
    expect(await bodies()).toEqual(["landed"]);
    expect(lists).toBe(3);

    mode = "refused";
    const refused = await failed("never");
    expect(refused).toBeInstanceOf(ServerUnreachable);
    expect(refused).not.toBeInstanceOf(OutcomeUnknown);
    expect(failureText(refused, "call the tool again")).toBe("Server unreachable; call the tool again");
    expect(failureText(new ServerBusy(800), "call the tool again")).toBe("Server at capacity; call the tool again"); // #1553
    mode = "pass";
    expect(await bodies()).toEqual(["landed"]);
    expect(lists).toBe(4);
    // A blackholed endpoint (#1347): the probe's connect never completes, so the call fails at its deadline, well
    // inside the request timeout, as plain unreachable, and its request never reaches fetch.
    const before = probes;
    connectProbe.deadlineMs = 100;
    connectProbe.open = () => { probes++; return new Socket(); };
    mode = "blackhole";
    const blackholed = await failed("unsent");
    expect(blackholed).toBeInstanceOf(ConnectProbeFailed);
    expect(blackholed).toBeInstanceOf(ServerUnreachable);
    expect(blackholed).not.toBeInstanceOf(OutcomeUnknown);
    expect(failureText(blackholed, "call the tool again")).toBe("Server unreachable; call the tool again");
    expect(probes).toBe(before + 1);
    connectProbe.deadlineMs = probe0.deadlineMs;
    connectProbe.open = (host, port) => { probes++; return probe0.open(host, port); };
    mode = "pass";
    expect(await bodies()).toEqual(["landed"]);
    // A failed probe says nothing of the pooled socket, so the shared connection was kept: no new one was listed.
    expect(lists).toBe(4);
    // One request per call: nothing resent any of them, and the blackholed one never left.
    expect(posts).toEqual(["503", "reset", "refused"]);

    // A credential's own outage ran nothing, so it stays unreachable: a refresh on the request's token() (after
    // signedOut()'s), and one after the server refused a stale token with 401. Both on an open connection.
    let armed = false, fetches = 0, current = token;
    const refreshing = proxy({ token: async () => {
      if (armed && ++fetches === 2) throw new ServerUnreachable(new Error("token endpoint down"));
      return current;
    }, onUnauthorized: async () => { throw new ServerUnreachable(new Error("token endpoint down")); } });
    // Each refresh outage drops the shared connection, so each case first opens a new one with a good token.
    const opened = async () => expect(JSON.parse(textOf(await refreshing.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-outage" });
    await opened();
    current = "bogus";
    const afterRefusal = await refreshing.call("board_post", { board: "outage", body: "refused" }, "pi-root").then(() => undefined, (error: unknown) => error);
    current = token;
    await opened();
    armed = true;
    const beforeSend = await refreshing.call("board_post", { board: "outage", body: "unsent" }, "pi-root").then(() => undefined, (error: unknown) => error);
    armed = false;
    for (const error of [beforeSend, afterRefusal]) {
      expect(error).toBeInstanceOf(ServerUnreachable);
      expect(error).not.toBeInstanceOf(OutcomeUnknown);
      expect(failureText(error, "call the tool again")).toBe("Server unreachable; call the tool again");
    }
    expect(fetches).toBe(2);
    expect(await bodies()).toEqual(["landed"]);

    // A call in flight when its proxy closes: the wire's own abort is a stop, never an outage (reachable()'s rule).
    const closing = proxy({ token: async () => token });
    expect(JSON.parse(textOf(await closing.call("whoami", {}, "pi-root")))).toMatchObject({ primary: "alice@example.com/proxy-outage" });
    mode = "hold";
    const inFlight = closing.call("board_post", { board: "outage", body: "held" }, "pi-root").then(() => undefined, (error: unknown) => error);
    await holding;
    await closing.close();
    const stopped = await inFlight;
    expect(stopped).toBeInstanceOf(Error);
    expect(stopped).not.toBeInstanceOf(ServerUnreachable);
    mode = "pass";

    // A shared connect that can't open its socket: unreachable, as before.
    const dead = proxy({ token: async () => token }, { wire: { url: `http://127.0.0.1:${deadPort}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" } } });
    const down = await dead.call("board_post", { board: "outage", body: "down" }, "pi-root").then(() => undefined, (error: unknown) => error);
    expect(down).toBeInstanceOf(ServerUnreachable);
    expect(down).not.toBeInstanceOf(OutcomeUnknown);
    expect(failureText(down, "call the tool again")).toBe("Server unreachable; call the tool again");
  } finally {
    release();
    globalThis.fetch = fetch0;
    NativeWire.prototype.listTools = list;
    Object.assign(connectProbe, probe0);
    proxyVars.forEach((n, i) => { if (proxyEnv[i] === undefined) delete process.env[n]; else process.env[n] = proxyEnv[i]; });
    resetter.close();
  }
});
