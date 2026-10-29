import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { tokenSession } from "../../tests/support/token_session.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication } from "./application.ts";
import { createHostedMcp, MCP_PROTOCOL_VERSIONS } from "./mcp.ts";
import { openDatabase } from "./db.ts";
import { createOAuthServer } from "./oauth.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT } from "./oauth-config.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import { createBoard, post, subscribe } from "../core/boards.ts";
const meta = { "ai.opencode/sessionID": "resource-root" };

let store: ReturnType<typeof openDatabase>, application: ReturnType<typeof createApplication>;
let oauth: ReturnType<typeof createOAuthServer>, hosted: ReturnType<typeof createHostedMcp>;
let dir: string, grant: ReturnType<typeof issueOAuth>;
const clients: Client[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-mcp-resource-unit-"));
  store = openDatabase(":memory:", { blobDir: dir });
  application = createApplication(store.repo, store.db);
  oauth = createOAuthServer(store.repo, { dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES });
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer });
  grant = issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
  const principal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.bind(principal, sessionContext(principal, meta), { name: "be", create: true });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
  expect(hosted.activeGetStreams).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeLeases).toBe(0);
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  expect(hosted.activeResourceContexts).toBe(hosted.activeGetStreams);
  oauth.close();
  application.stopExpiry();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function connect(version: string, role = "subscriber", signal?: AbortSignal, headers?: Headers) {
  const client = new Client({ name: "resource-unit", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${grant.token}`, "X-Grayboard-Identity": "be", ...(role === "native" ? {} : { "X-Grayboard-Client": role }) } },
    fetch: async (input, init) => {
      let request = new Request(input, { ...init, ...(signal ? { signal } : {}) });
      if (request.method === "POST" && request.body) {
        const body = await request.json() as { params?: Record<string, unknown> };
        body.params = { ...body.params, _meta: { ...((body.params?._meta ?? {}) as object), ...meta } };
        request = new Request(request, { body: JSON.stringify(body) });
      }
      headers?.forEach((value, key) => request.headers.set(key, value));
      return hosted.fetch(request);
    },
  }));
  return client;
}

test("subscriber errors preserve domain codes through actual SDK tool and resource transports", async () => {
  const headers = new Headers({ "X-Grayboard-Lease": "x".repeat(43) });
  const client = await connect("2026-07-28", "subscriber", undefined, headers);
  const unknown = await client.callTool({ name: "bind", arguments: { name: "missing" } });
  expect(unknown).toMatchObject({ isError: true, structuredContent: { code: "identity_unknown" } });
  const stale = await client.callTool({ name: "delivery_renew", arguments: {} });
  expect(stale).toMatchObject({ isError: true, structuredContent: { code: "not_found" } });
  await expect(client.readResource({ uri: "grayboard://inbox" })).rejects.toMatchObject({ code: -32602, data: { code: "not_found" } });
  const original = hosted.delivery.pending;
  hosted.delivery.pending = async () => { throw new ApplicationError("unbound", "bind again"); };
  // A valid lease reaches pending rather than failing its header check.
  const opened = await client.callTool({ name: "delivery_open", arguments: {} });
  const cap = JSON.parse((opened.content as { text: string }[])[0]!.text).capability;
  headers.set("X-Grayboard-Lease", cap);
  try { await expect(client.readResource({ uri: "grayboard://inbox" })).rejects.toMatchObject({ code: -32602, data: { code: "unbound" } }); }
  finally { hosted.delivery.pending = original; }
});

test("receipt capacity is structured and release then bind false reopens under a fresh ownership", async () => {
  const headers = new Headers(), client = await connect("2026-07-28", "subscriber", undefined, headers);
  const opened = await client.callTool({ name: "delivery_open", arguments: {} });
  const first = JSON.parse((opened.content as { text: string }[])[0]!.text);
  headers.set("X-Grayboard-Lease", first.capability);
  const principal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  createBoard(store.db, "alice@example.com/be", "capacity", "digest receipt bound");
  subscribe(store.db, "alice@example.com/be", "capacity", "digest");
  for (let i = 0; i < 1000; i++) {
    post(store.db, "alice@example.com/sender", "capacity", `version ${i}`);
    await hosted.delivery.pending(principal, sessionContext(principal, meta), first.capability);
  }
  post(store.db, "alice@example.com/sender", "capacity", "overflow");
  await expect(client.readResource({ uri: "grayboard://inbox" })).rejects.toMatchObject({ data: { code: "receipt_capacity" } });
  const renew = hosted.delivery.renew;
  hosted.delivery.renew = async () => { throw new ApplicationError("receipt_capacity", "receipt capacity reached"); };
  try { expect((await client.callTool({ name: "delivery_renew", arguments: {} })).structuredContent).toEqual({ code: "receipt_capacity" }); }
  finally { hosted.delivery.renew = renew; }
  const alias = store.repo.aliases.find(`${grant.authed.user_email}/be`);
  await client.callTool({ name: "delivery_release", arguments: {} });
  expect((await client.callTool({ name: "bind", arguments: { name: "be", create: false } })).isError).not.toBe(true);
  const replacement = JSON.parse(((await client.callTool({ name: "delivery_open", arguments: {} })).content as { text: string }[])[0]!.text);
  expect(replacement.capability).not.toBe(first.capability);
  expect(replacement.ownership).not.toBe(first.ownership);
  headers.set("X-Grayboard-Lease", replacement.capability);
  expect((await client.readResource({ uri: "grayboard://inbox" })).contents).toHaveLength(1);
  expect(store.repo.aliases.find(`${grant.authed.user_email}/be`)).toEqual(alias);
  await expect(hosted.delivery.pending(principal, sessionContext(principal, meta), first.capability)).rejects.toHaveProperty("code", "not_found");
});

test("subscriber known suggestions stay account scoped and reject malformed extra fields without getters", async () => {
  const bob = issueOAuth(store.repo, oauth.resource, "bob@example.com", ["grayboard:tools"], Date.now(), OPENCODE_CLIENT);
  const principal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${bob.token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.bind(principal, sessionContext(principal, meta), { name: "private-name", create: true });
  const client = await connect("2026-07-28");
  expect((await client.callTool({ name: "bind", arguments: { name: "missing" } })).structuredContent).toEqual({ code: "identity_unknown", known: ["be"] });
  const bind = hosted.sessions.bind;
  let reads = 0;
  const extra = Object.defineProperty({}, "known", { get() { reads++; throw new Error("PRIVATE"); } });
  hosted.sessions.bind = async () => { throw new ApplicationError("identity_unknown", "unknown name", extra); };
  try {
    expect((await client.callTool({ name: "bind", arguments: { name: "missing" } })).structuredContent).toEqual({ code: "identity_unknown" });
    for (const known of [["be", 1], "be", Array(257).fill("be"), ["x".repeat(33)]]) {
      hosted.sessions.bind = async () => { throw new ApplicationError("identity_unknown", "unknown name", Object.defineProperty({}, "known", { value: known })); };
      expect((await client.callTool({ name: "bind", arguments: { name: "missing" } })).structuredContent).toEqual({ code: "identity_unknown" });
    }
  }
  finally { hosted.sessions.bind = bind; }
  expect(reads).toBe(0);
  const headers = new Headers();
  const reader = await connect("2026-07-28", "subscriber", undefined, headers);
  const opened = await reader.callTool({ name: "delivery_open", arguments: {} });
  headers.set("X-Grayboard-Lease", JSON.parse((opened.content as { text: string }[])[0]!.text).capability);
  const pending = hosted.delivery.pending;
  try {
    hosted.delivery.pending = async () => { throw new ApplicationError("identity_unknown", "unknown name", { known: ["be"], holder: "PRIVATE" }); };
    const refused = await reader.readResource({ uri: "grayboard://inbox" }).then(() => undefined, error => error);
    expect(refused.data).toEqual({ code: "identity_unknown", known: ["be"] });
    hosted.delivery.pending = async () => { throw Object.defineProperty(new Error(), "message", { get() { reads++; throw new Error("PRIVATE"); } }); };
    await expect(reader.readResource({ uri: "grayboard://inbox" })).rejects.toMatchObject({ data: { code: "internal_error" }, message: "internal error" });
    expect(reads).toBe(0);
  } finally { hosted.delivery.pending = pending; }
});

test("subscriber in-use refusals name the holder as bounded plain text", async () => {
  const principal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.bind(principal, sessionContext(principal, { "ai.opencode/sessionID": "other-root" }), { name: "fe", create: true, where: "/work/app" });
  const client = await connect("2026-07-28");
  const refused = (await client.callTool({ name: "bind", arguments: { name: "fe", create: false } })).structuredContent as { code: string; holder: string };
  expect(refused.code).toBe("identity_in_use");
  expect(refused.holder).toMatch(/^the hosted session \S+, in \/work\/app, last seen \d+s ago$/);
  const bind = hosted.sessions.bind;
  try {
    for (const holder of ["", "x".repeat(2049), "held\nby", "held\u009bby", "held‮by", 42]) {
      hosted.sessions.bind = async () => { throw new ApplicationError("identity_in_use", "in use", Object.defineProperty({}, "holder", { value: holder })); };
      expect((await client.callTool({ name: "bind", arguments: { name: "fe" } })).structuredContent).toEqual({ code: "identity_in_use" });
    }
    hosted.sessions.bind = async () => { throw new ApplicationError("identity_in_use", "in use", { holder: "the live session x", known: ["be"] }); };
    expect((await client.callTool({ name: "bind", arguments: { name: "fe" } })).structuredContent).toEqual({ code: "identity_in_use", holder: "the live session x" });
  } finally { hosted.sessions.bind = bind; }
});

test("hosted audit actors and clients survive grant deletion and ownership cleanup", async () => {
  const client = await connect("2026-07-28");
  const opened = await client.callTool({ name: "delivery_open", arguments: {} });
  expect(opened.isError).not.toBe(true);
  const p = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (p instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.register(p, sessionContext(p, meta), "audit-child");
  await hosted.sessions.end(p, sessionContext(p, meta));
  store.repo.oauth.cleanup(Date.now() + OAUTH_TTL.grant + 1);
  const rows = store.db.query<{ actor: string; detail: string }, []>("SELECT actor,detail FROM access_log WHERE action LIKE 'hosted.%'").all();
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const row of rows) {
    expect(row.actor).toBe("alice@example.com");
    expect(JSON.parse(row.detail).client_id).toBe(OPENCODE_CLIENT);
  }
  expect(store.db.query("SELECT count(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });
});

test("a live subscriber hint failure closes its stream with one private-safe diagnostic", async () => {
  const headers = new Headers();
  const sub = await connect("2026-07-28", "subscriber", undefined, headers);
  const opened = await sub.callTool({ name: "delivery_open", arguments: {} });
  headers.set("X-Grayboard-Lease", JSON.parse((opened.content as { text: string }[])[0]!.text).capability);
  const listen = await sub.listen({ resourceSubscriptions: ["grayboard://inbox"] });
  const native = await connect("2026-07-28", "native");
  const original = hosted.delivery.describe;
  const log = spyOn(console, "error").mockImplementation(() => {});
  hosted.delivery.describe = () => { throw new Error("Bearer PRIVATE\n    at f (/private/refresh-token.ts:1:1)", { cause: "AUTHORIZATION-CODE" }); };
  try {
    expect((await native.callTool({ name: "dm_send", arguments: { to: "be", body: "hint fixture" } })).isError).not.toBe(true);
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"mcp.hint","category":"failure","level":"error","class":"Error"}']);
    expect(hosted.activeListens).toBe(0);
  } finally { hosted.delivery.describe = original; log.mockRestore(); await listen.close(); }
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const creatorHeld of [false, true]) test(`${version}: canceled open cannot release a successful shared lease, creatorHeld=${creatorHeld}`, async () => {
  const p = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (p instanceof Response) throw new Error("fixture unauthorized");
  const context = sessionContext(p, meta);
  await hosted.sessions.register(p, context, "child");
  const successful = await connect(version);
  if (!creatorHeld) expect((await successful.callTool({ name: "delivery_open", arguments: {} })).isError).not.toBe(true);
  const abort = new AbortController(), canceled = await connect(version, "subscriber", abort.signal);
  const original = hosted.delivery.open;
  let entered!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
  let first = true;
  hosted.delivery.open = async (...args) => {
    const result = await original(...args);
    if (first) { first = false; entered(); await held; }
    return result;
  };
  try {
    const pending = canceled.callTool({ name: "delivery_open", arguments: {} }, { signal: abort.signal }).catch(error => error);
    await reached;
    if (creatorHeld) expect((await successful.callTool({ name: "delivery_open", arguments: {} })).isError).not.toBe(true);
    const rows = store.repo.hosted.all(), ownership = rows[0]!.ownership_id;
    abort.abort(); resume(); await pending; await Bun.sleep(0);
    expect(hosted.activeLeases).toBe(1);
    expect(store.repo.hosted.all()).toHaveLength(2);
    expect(store.repo.hosted.all().every(row => row.ownership_id === ownership)).toBe(true);
    expect((await successful.callTool({ name: "whoami", arguments: {} })).isError).not.toBe(true);
    expect((await successful.callTool({ name: "delivery_open", arguments: {} })).isError).not.toBe(true);
  } finally { resume(); hosted.delivery.open = original; }
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const stop of ["access", "abort", "close"] as const) test(`${version}: ${stop} after async lease selection releases new ownership`, async () => {
  const abort = new AbortController();
  const client = await connect(version, "subscriber", abort.signal);
  const original = hosted.delivery.open;
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { resume = r; });
  hosted.delivery.open = async (...args) => {
    const selected = await original(...args);
    entered(); await gate;
    return selected;
  };
  try {
    const pending = client.callTool({ name: "delivery_open", arguments: {} }, { signal: abort.signal }).catch(e => e);
    await ready;
    expect(hosted.activeLeases).toBe(1);
    if (stop === "access") store.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, Date.now());
    if (stop === "abort") abort.abort();
    const closing = stop === "close" ? hosted.close() : undefined;
    resume();
    await closing;
    if (stop === "close") await client.close();
    const result = await pending;
    if (stop === "access") expect(result).toMatchObject({ isError: true });
    await Bun.sleep(0);
    expect(hosted.activeLeases).toBe(0);
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
    expect(hosted.activeResourceContexts).toBe(hosted.activeGetStreams);
    if (stop !== "close") {
      const replacement = await application.selectIdentity(tokenSession(application.repo, grant.authed), "be", { deliver() {}, probe: async () => true, closed() {} });
      application.close(replacement.session);
    }
  } finally { resume(); hosted.delivery.open = original; }
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: resource and control storage failures are redacted, not fabricated auth failures`, async () => {
  const native = await connect(version, "native");
  const sub = await connect(version);
  const catalog = application.boardCatalog;
  application.boardCatalog = () => { throw new Error("SELECT secret FROM /private/database.sqlite"); };
  try {
    await expect(native.listResources()).rejects.toThrow("internal error");

  } finally { application.boardCatalog = catalog; }
  const select = hosted.delivery.open;
  hosted.delivery.open = async () => { throw new Error("SELECT secret FROM /private/database.sqlite"); };
  try {
    const result = await sub.callTool({ name: "delivery_open", arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
    expect(hosted.activeLeases).toBe(0);
  } finally { hosted.delivery.open = select; }
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const method of ["list", "read"] as const) for (const boundary of ["grant", "session"] as const) test(`${version}: resource ${method} extra ${boundary} storage check preserves internal-error provenance`, async () => {
  const client = await connect(version, "native");
  const findAccess = store.repo.oauth.findActiveAccess, validate = application.revalidateSession;
  let accessChecks = 0, sessionChecks = 0;
  store.repo.oauth.findActiveAccess = (...args) => {
    accessChecks++;
    if (boundary === "grant" && accessChecks === 5) throw new Error("SELECT secret FROM private_database");
    return findAccess(...args);
  };
  application.revalidateSession = session => {
    sessionChecks++;
    if (boundary === "session" && sessionChecks === 2) throw new Error("SELECT secret FROM private_database");
    validate(session);
  };
  try {
    const request = method === "list" ? client.listResources() : client.readResource({ uri: "grayboard://boards/general" });
    await expect(request).rejects.toThrow(/internal.*error/i);
    expect(accessChecks).toBeGreaterThanOrEqual(5);
    expect(sessionChecks).toBe(boundary === "grant" ? 0 : 2);
    expect(store.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  } finally { store.repo.oauth.findActiveAccess = findAccess; application.revalidateSession = validate; }
  expect((await client.listResources()).resources.every(r => r.uri !== "grayboard://identity")).toBe(true);
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const method of ["renew", "inbox"] as const) for (const faultAt of [1, 2, 3, 4]) test(`${version}: ${method} grant storage fault at check ${faultAt} preserves the lease`, async () => {
  const headers = new Headers();
  const client = await connect(version, "subscriber", undefined, headers);
  const opened = await client.callTool({ name: "delivery_open", arguments: {} });
  const lease = JSON.parse((opened.content[0] as { text: string }).text) as { capability: string };
  headers.set("X-Grayboard-Lease", lease.capability);
  const isActive = store.repo.oauth.findActiveAccess;
  let calls = 0;
  store.repo.oauth.findActiveAccess = (...args) => {
    if (++calls === faultAt) throw new Error("SELECT secret FROM private_database");
    return isActive(...args);
  };
  try {
    if (method === "renew") {
      const result = await client.callTool({ name: "delivery_renew", arguments: {} }).catch(error => error);
      expect(JSON.stringify(result)).toMatch(/internal.*error/i);
      expect(JSON.stringify(result)).not.toMatch(/SELECT|private_database/);
    } else {
      await expect(client.readResource({ uri: "grayboard://inbox" })).rejects.toThrow(/internal.*error/i);
    }
    expect(calls).toBe(faultAt);
    expect(hosted.activeLeases).toBe(1);
    expect(store.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  } finally { store.repo.oauth.findActiveAccess = isActive; }
  const renewed = await client.callTool({ name: "delivery_renew", arguments: {} });
  expect(renewed.isError).toBeUndefined();
  expect(JSON.parse((renewed.content[0] as { text: string }).text).capability).toBe(lease.capability);
});
