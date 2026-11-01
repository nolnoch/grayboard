// hosted-core's tool proxy (#430) against a real in-process server: the
// pre-login snapshot and its one login error, a write tool that binds a
// session through `_meta`, tool `_meta` (alwaysLoad) on the live list, the
// Controller hooks around each call, re-listing on each new connection,
// per-session instructions, and local-path attachments with a verified
// download. Tokens are issued for the built-in pi client, as the server's
// own OAuth issuance would.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, SdkError, SdkErrorCode, type AuthProvider, type CallToolResult } from "@modelcontextprotocol/client";
import { AccessExpired } from "../../adapters/hosted-core/src/model.ts";
import type { CallOutcome } from "../../adapters/hosted-core/src/controller.ts";
import { hostTools, loadMode, snapshotTools, ToolProxy, type CallHooks, type NativeTool, type ProxyOptions } from "../../adapters/hosted-core/src/proxy.ts";
import { NativeWire, ServerUnreachable } from "../../adapters/hosted-core/src/wire.ts";
import { hashToken } from "../../src/server/auth.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { ATTACHMENT_LIMITS_CAPABILITY, ATTACHMENTS_PARAM, attachRoots, publishedLimits } from "../../src/shared/attachments.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
let srv: TestServer, dir: string;
const proxies: ToolProxy[] = [];
beforeEach(() => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
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
const hostedRow = (raw: string, user: number) => srv.app.db.query<{ name: string | null; source_session_id: string; client_id: string }, [string]>(
  "SELECT name, source_session_id, client_id FROM hosted_sessions WHERE session_id = ?").get(hostedSessionId(user, CLIENT, raw));

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
  const { token, authed } = issue();
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
  expect(hostedRow("pi-root", authed.user_id)).toEqual({ name: "proxy-run", source_session_id: "pi-root", client_id: CLIENT });
  expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ name: "proxy-run" });
  // The shared connection routes per call: another session is still unbound.
  expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-other")))).toMatchObject({ unbound: true });
  expect(hostedRow("pi-other", authed.user_id)?.name ?? null).toBeNull();
  // A refusal comes back as the server wrote it, and afterCall sees an error.
  const taken = await p.call("bind", { name: "proxy-run", create: true }, "pi-other");
  expect(taken.isError).toBe(true);
  expect(JSON.parse(textOf(taken))).toMatchObject({ code: "identity_in_use" });

  expect(hooks.calls).toEqual([
    { phase: "before", sessionID: "pi-root", tool: "bind" },
    { phase: "after", sessionID: "pi-root", tool: "bind", result: { status: "completed", output } },
    { phase: "before", sessionID: "pi-root", tool: "whoami" },
    { phase: "after", sessionID: "pi-root", tool: "whoami", result: { status: "completed", output: expect.objectContaining({ name: "proxy-run" }) } },
    { phase: "before", sessionID: "pi-other", tool: "whoami" },
    { phase: "after", sessionID: "pi-other", tool: "whoami", result: { status: "completed", output: expect.objectContaining({ unbound: true }) } },
    { phase: "before", sessionID: "pi-other", tool: "bind" },
    { phase: "after", sessionID: "pi-other", tool: "bind", result: { status: "error" } },
  ]);
  expect(p.reports).toEqual([]);
});

test("each new native connection re-lists the tools; a changed list reaches the adapter", async () => {
  const { token } = issue();
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
  const { token } = issue();
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
    expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ name: "proxy-flight" });
    expect(lists).toBe(2);
  } finally {
    release();
    globalThis.fetch = fetch0;
    NativeWire.prototype.listTools = list;
    NativeWire.prototype.callTool = call;
  }
});

test("connect() and retire() leave calls in flight to finish: a new connection takes the new calls, and the one it replaced closes after its last", async () => {
  const { token } = issue();
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
    expect(JSON.parse(textOf(await p.call("whoami", {}, "pi-root")))).toMatchObject({ name: "proxy-swap" });
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
  const { token } = issue();
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
  const alice = issue("alice@example.com"), bob = issue("bob@example.com");
  const sender = proxy({ token: async () => alice.token }), reader = proxy({ token: async () => bob.token });
  await sender.call("bind", { name: "proxy-a", create: true }, "pi-a");
  await reader.call("bind", { name: "proxy-b", create: true }, "pi-b");
  const bytes = "proxy attachment report\n";
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "report.txt"), bytes);

  const sent = await sender.call("dm_send", { to: "bob@example.com/proxy-b", body: "see attached", attachments: [join(dir, "report.txt")] }, "pi-a");
  expect(sent.isError).toBeUndefined();
  const message = srv.app.db.query<{ id: number }, []>("SELECT id FROM messages WHERE body = 'see attached'").get()!;
  const stored = srv.app.db.query<{ id: number; filename: string; sha256: string; message_id: number | null }, []>("SELECT id, filename, sha256, message_id FROM attachments").all();
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
  const uploads = () => srv.app.db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'attachments'").get()!.seq;
  const before = uploads();
  writeFileSync(join(dir, "second.txt"), "second\n");
  const refused = await sender.call("dm_send", { to: "nobody@example.com/missing", body: "lost", attachments: [join(dir, "second.txt")] }, "pi-a");
  expect(refused.isError).toBe(true);
  expect(uploads()).toBe(before + 1);
  expect(srv.app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM attachments WHERE message_id IS NULL AND post_id IS NULL").get()!.n).toBe(0);
  // A path outside the roots never leaves the host.
  const outside = await sender.call("dm_send", { to: "bob@example.com/proxy-b", body: "x", attachments: [join(tmpdir(), "nope.txt")] }, "pi-a");
  expect(outside.isError).toBe(true);
  expect(textOf(outside)).toStartWith("error: attachment ");
  expect(sender.reports).toEqual([]);
});

test("uploads are checked against the server's published caps; a server that publishes none gets the defaults", async () => {
  await srv.stop();
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, attachmentLimits: { file: 16, total: 32 } });
  const alice = issue("alice@example.com");
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
  expect(srv.app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM attachments").get()!.n).toBe(0);
  expect(() => publishedLimits({ [ATTACHMENT_LIMITS_CAPABILITY]: { file: 0, total: 32 } })).toThrow(`Invalid ${ATTACHMENT_LIMITS_CAPABILITY} capability from the server`);
  expect(publishedLimits({})).toBeUndefined();
});

test("an attachment request refused with 401 runs the credential's onUnauthorized once, then retries", async () => {
  const { token } = issue();
  let refreshed = 0, current = token;
  const p = proxy({ token: async () => current, onUnauthorized: async () => { refreshed++; current = token; } });
  await p.call("bind", { name: "proxy-self", create: true }, "pi-root");
  writeFileSync(join(dir, "note.txt"), "note\n");
  // The access token went stale: the upload, this call's first request, meets the 401.
  current = "stale-token";
  const sent = await p.call("dm_send", { to: "alice@example.com/proxy-self", body: "to self", attachments: [join(dir, "note.txt")] }, "pi-root");
  expect(refreshed).toBe(1);
  expect(sent.isError).toBeUndefined();
  expect(srv.app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM attachments WHERE message_id IS NOT NULL").get()!.n).toBe(1);
});

test("a token without the tools scope needs a new login, never a refresh", async () => {
  const { token } = issue("alice@example.com", ["grayboard:delivery"]);
  let refreshed = 0;
  const p = proxy({ token: async () => token, onUnauthorized: async () => { refreshed++; } });
  expect(textOf(await p.call("whoami", {}, "pi-root"))).toBe("error: Signed out of grayboard in pi; run /grayboard login");
  expect(refreshed).toBe(0);
});

test("a 401 the credential's refresh doesn't fix needs a new login: tool calls, uploads and instructions alike", async () => {
  const { token, refreshToken } = issue();
  let refreshed = 0;
  const p = proxy({ token: async () => token, onUnauthorized: async () => { refreshed++; } });
  expect((await p.call("bind", { name: "proxy-gone", create: true }, "pi-root")).isError).toBeUndefined();
  // Revoking the refresh token revokes the grant (RFC 7009), so the access token dies with it.
  srv.app.repo.oauth.revokeToken(hashToken(refreshToken), CLIENT, Date.now());
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
