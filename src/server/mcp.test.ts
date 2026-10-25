import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication, type DeliveryEvent } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";
import { createOAuthServer } from "./oauth.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { randomBytes } from "node:crypto";
import { hashToken } from "./auth.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import { OPENCODE_CLIENT, sessionContext } from "./hosted.ts";
const meta = { "ai.opencode/sessionID": "test-root" };
const issuedOAuth = (repo: Parameters<typeof issueOAuth>[0], resource: string, email = "alice@example.com", scopes = ["grayboard:tools"]) => issueOAuth(repo, resource, email, scopes, Date.now(), OPENCODE_CLIENT);

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedMcp>;
let user: AuthedUser;
let token: string;
let oauth: ReturnType<typeof createOAuthServer>;
let blobDir: string;
const clients: Client[] = [];
beforeEach(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-mcp-"));
  store = openDatabase(":memory:", { blobDir });
  application = createApplication(store.repo, store.db);
  oauth = createOAuthServer(store.repo, { dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] });
  hosted = createHostedMcp(application, oauth, { trustedOrigin: "https://grayboard.example.com:443" });
  const issued = issuedOAuth(store.repo, oauth.resource);
  token = issued.token;
  user = issued.authed;
  const principal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.bind(principal, sessionContext(principal, meta), { name: "be", create: true, where: "tools" });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeGetStreams).toBe(0);
  expect(hosted.activeStreams).toBe(0);
  expect(hosted.activeBusListeners).toBe(0);
  expect(hosted.activeWatches).toBe(0);
  expect(hosted.activeLegacySessions).toBe(0);
  oauth.close();
  application.stopExpiry();
  await Bun.sleep(0);
  store.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});

test("unknown HTTP names fail with closest names without creating a context or identity", async () => {
  const response = await hosted.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "bee" } }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "identity_unknown", known: ["be"] });
  expect(store.repo.aliases.find(user.user_email, "bee")).toBeUndefined();
  expect(hosted.activeContexts).toBe(0);
});

async function connect(version = "2026-07-28", intercept?: (response: Response) => Promise<void>, headers?: Headers, observeRequest?: (request: Request) => void) {
  const client = new Client({ name: "unit", version: "1" }, {
    supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be", "X-Grayboard-Where": "tools" } },
    fetch: async (input, init) => {
      let request = new Request(input, init);
      if (request.method === "POST" && request.body) {
        const body = await request.json() as { params?: Record<string, unknown> };
        body.params = { ...body.params, _meta: { ...((body.params?._meta ?? {}) as object), ...meta } };
        request = new Request(request, { body: JSON.stringify(body) });
      }
      headers?.forEach((value, key) => request.headers.set(key, value));
      observeRequest?.(request);
      const response = await hosted.fetch(request);
      await intercept?.(response);
      return response;
    },
  }));
  return client;
}

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: tools-only contexts preserve live owner and its status`, async () => {
  const events: DeliveryEvent[] = [];
  const owner = (await application.selectIdentity(user, "fe", { deliver: e => { events.push(e); }, probe: async () => true, closed() {} }, { where: "owner" })).session;
  application.call(owner, "peer_status", { text: "working" });
  const client = await connect(version);
  for (let n = 0; n < 10; n++) {
    expect((await client.callTool({ name: "dm_send", arguments: { to: "fe", body: `hello ${n}` } })).isError).not.toBe(true);
  }
  expect(events).toHaveLength(10);
  const peers = application.call(owner, "peer_list", {}) as { peers: unknown[] };
  expect(peers.peers).toContainEqual(expect.objectContaining({ handle: "alice@example.com/fe", online: true, status: "working", where: "owner" }));
  expect(store.repo.cursors.directFor(owner.identityFull)).toBe(0);
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  await expect(application.selectIdentity(user, "fe", { deliver() {}, probe: async () => false, closed() {} })).rejects.toMatchObject({ code: "identity_in_use" });
});

test("Origin policy precedes authentication and context creation on every HTTP method", async () => {
  let selections = 0;
  const select = hosted.sessions.snapshot;
  hosted.sessions.snapshot = async (...args) => { selections++; return select(...args); };
  const forbidden = [
    "https://foreign.example.com", "http://grayboard.example.com", "null", "", "not an origin",
    "https://grayboard.example.com/", "https://grayboard.example.com/path", "https://grayboard.example.com?query",
    "https://grayboard.example.com#fragment", "https://user@grayboard.example.com",
    "https://grayboard.example.com https://foreign.example.com", "https://grayboard.example.com,https://foreign.example.com",
    "https://grayboard.example.com\\\\path", "https://%67rayboard.example.com", "HTTPS://grayboard.example.com",
  ];
  for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH", "HEAD"]) {
    for (const origin of forbidden) {
      for (const authorization of [undefined, `Bearer ${token}`]) {
        const response = await hosted.fetch(new Request("http://localhost/mcp", {
          method, headers: { Origin: origin, "X-Grayboard-Identity": "refused", ...(authorization ? { Authorization: authorization } : {}) },
        }));
        expect(response.status).toBe(403);
      }
    }
    for (const origin of [undefined, "https://grayboard.example.com", "https://grayboard.example.com:443"]) {
      const response = await hosted.fetch(new Request("http://localhost/mcp", { method, headers: origin === undefined ? {} : { Origin: origin } }));
      expect(response.status).toBe(401);
    }
  }
  expect(selections).toBe(0);
  expect(store.repo.aliases.find(user.user_email, "refused")).toBeUndefined();
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

test("legacy SSE context survives fetch return until SDK reader cancellation", async () => {
  let cancelled = false;
  await expect(connect("2025-11-25", async response => {
    if (!cancelled && response.headers.get("content-type")?.includes("text/event-stream")) {
      cancelled = true;
      expect(hosted.activeContexts).toBe(1);
      await response.body!.cancel();
      expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
      throw new Error("test cancelled response");
    }
  })).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

test("shutdown closes outstanding legacy SSE products and refuses new contexts", async () => {
  await connect("2025-11-25");
  await Bun.sleep(0);
  expect(hosted.activeGetStreams).toBe(1);
  expect(hosted.activeContexts).toBe(1);
  await hosted.close();
  expect(hosted.activeGetStreams).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.activeStreams).toBe(0);
  expect((await hosted.fetch(new Request("http://localhost/mcp"))).status).toBe(503);
});

test("shutdown racing the factory cannot leave a selected context behind", async () => {
  const select = hosted.sessions.snapshot;
  let selected!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await select(...args);
    selected();
    await gate;
    return result;
  };
  const pending = connect();
  await ready;
  await hosted.close();
  release();
  await expect(pending).rejects.toThrow();
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: only typed admission refusals bypass factory error redaction`, async () => {
  let last!: { status: number; retryAfter: string | null; body: string };
  const client = await connect(version, async response => {
    last = { status: response.status, retryAfter: response.headers.get("Retry-After"), body: await response.clone().text() };
  });
  const admit = application.admitIdentity;
  const secret = "SELECT token FROM /private/database.sqlite alice@example.com";
  for (const error of [new Error(secret), new ApplicationError("internal", secret), { code: "rate_limited", message: secret, extra: { retry_after_ms: 1250 } }, ...[0, -1, NaN, Infinity].map(retry_after_ms => new ApplicationError("rate_limited", secret, { retry_after_ms }))]) {
    for (const preflight of [true, false]) {
      application.admitIdentity = () => {
        if (preflight) throw error;
        return async () => { throw error; };
      };
      await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
      expect(last.status).toBe(500);
      expect(last.retryAfter).toBeNull();
      expect(last.body).not.toContain(secret);
      expect(last.body).not.toContain("retry_after_ms");
    }
  }
  application.admitIdentity = () => { throw new ApplicationError("rate_limited", secret, { retry_after_ms: 1250 }); };
  await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
  expect(last.status).toBe(429);
  expect(last.retryAfter).toBe("2");
  expect(JSON.parse(last.body)).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, data: { code: "rate_limited", retry_after_ms: 1250 } } });
  expect(last.body).not.toContain(secret);
  application.admitIdentity = admit;
  expect((await client.callTool({ name: "board_list", arguments: {} })).isError).not.toBe(true);
  expect(last.status).toBe(200);
  expect(last.retryAfter).toBeNull();
  let selections = 0;
  application.admitIdentity = (...args) => {
    const select = admit(...args);
    return async sink => {
      const n = ++selections;
      await Promise.resolve();
      if (n === 1) throw new ApplicationError("rate_limited", secret, { retry_after_ms: 1250 });
      return select(sink);
    };
  };
  const results = await Promise.allSettled([client.callTool({ name: "board_list", arguments: {} }), client.callTool({ name: "board_list", arguments: {} })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(selections).toBe(2);
  application.admitIdentity = admit;
  expect(hosted.activeContexts).toBe(0);
});

test("internal operation failures are redacted, including paths and SQL", async () => {
  const client = await connect();
  const original = application.call;
  application.call = () => { throw new Error("SELECT token FROM /private/database.sqlite secret"); };
  try {
    const result = await client.callTool({ name: "board_list", arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
  } finally { application.call = original; }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: unexpected hosted repo failures log once without credentials or tool arguments`, async () => {
  const client = await connect(version);
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const original = store.repo.messages.insert;
  const secret = `Bearer ${token} client_secret=hidden https://user:password@example.com/auth?code=hidden`;
  const multiline = new Error(`${secret}\n    at query (/private/server/${token}.ts:12:34)\n    at query (/private/server/mcp.ts:12:34)`);
  const forged = new Error(secret, { cause: new Error(secret) });
  forged.stack = `Error: failure\n    at query (/private/server/${token}.js:12:34)\n    at query (/private/server/mcp.ts:12:34)\n    at auth (https://example.com/${token}.ts?token=${token}:12:34)`;
  (forged.cause as Error).stack = `Error: cause\n    at query (/private/server/${token}.ts:12:34)`;
  const cycle = new Error(secret);
  cycle.cause = cycle;
  const getters = new Error("untrusted properties");
  let reads = 0;
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(getters, key, { get() { reads++; throw new Error(secret); } });
  try {
    for (const error of [multiline, forged, cycle, getters]) {
      logs.mockClear();
      store.repo.messages.insert = () => { throw error; };
      const result = await client.callTool({ name: "dm_send", arguments: { to: "be", body: "private tool body" } });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
      expect(logs).toHaveBeenCalledTimes(1);
      const line = String(logs.mock.calls[0]![0]);
      expect(line).toContain('"tool":"dm_send"');
      expect(line).toContain('"principal":');
      expect(line).toContain('"session":');
      expect(line).toContain('"source":"src/server/mcp.ts","operation":"tool","category":"unexpected"');
      expect(line.length).toBeLessThan(1024);
      for (const hidden of [token, "hidden", "password", "private tool body", "client_secret", "/auth?", "12:34"]) expect(line).not.toContain(hidden);
      expect(hosted.activeContexts).toBe(0);
    }
    expect(reads).toBe(0);
  } finally { store.repo.messages.insert = original; logs.mockRestore(); }
});

for (const version of ["2026-07-28", "2025-11-25"]) test(`${version}: factory errors log once, expected refusals do not log, and lost authentication returns 401`, async () => {
  let last!: Response;
  const client = await connect(version, async response => { last = response.clone(); });
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const original = application.admitIdentity;
  try {
    application.admitIdentity = () => async () => { throw new Error(`token=${token}`); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(500);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
    logs.mockClear();
    application.admitIdentity = () => async () => { throw new ApplicationError("unauthenticated", `revoked ${token}`); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(401);
    expect(await last.text()).not.toContain(token);
    expect(logs).not.toHaveBeenCalled();
    application.admitIdentity = () => async () => { throw new ApplicationError("rate_limited", "retry", { retry_after_ms: 1000 }); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(429);
    expect(logs).not.toHaveBeenCalled();
  } finally { application.admitIdentity = original; logs.mockRestore(); }
});

test("Origin and identity diagnostics are address-limited and omit URL secrets", async () => {
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let n = 0; n < 5; n++) {
      const response = await hosted.fetch(new Request("http://localhost/mcp", { headers: { Origin: "https://user:password@foreign.example.com/path?token=hidden", Authorization: `Bearer ${token}` } }), "192.0.2.1");
      expect(response.status).toBe(403);
    }
    expect(logs).toHaveBeenCalledTimes(1);
    const response = await hosted.fetch(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "human" } }), "192.0.2.2");
    expect(response.status).toBe(400);
    expect(logs).toHaveBeenCalledTimes(2);
    const text = JSON.stringify(logs.mock.calls);
    expect(text).toContain("https://foreign.example.com");
    expect(text).toContain("https://grayboard.example.com");
    for (const secret of [token, "password", "hidden", "?token"]) expect(text).not.toContain(secret);
  } finally { logs.mockRestore(); }
});

for (const revoked of [false, true]) test(`authentication lost between HTTP preflight and factory (${revoked ? "revoked" : "disabled"}) returns 401 without an unexpected log`, async () => {
  let last!: Response;
  const client = await connect("2026-07-28", async response => { last = response.clone(); });
  const original = application.admitIdentity;
  const logs = spyOn(console, "error").mockImplementation(() => {});
  application.admitIdentity = (...args) => {
    const select = original(...args);
    if (revoked) store.repo.sessions.revoke(user.session_id);
    return async sink => {
      store.repo.users.setDisabled(user.user_id, true);
      return select(sink);
    };
  };
  try {
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(401);
    expect(await last.json()).toMatchObject({ code: "unauthenticated" });
    expect(logs).not.toHaveBeenCalled();
    expect(hosted.activeContexts).toBe(0);
  } finally { application.admitIdentity = original; logs.mockRestore(); }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) for (const status of [401, 403]) test(`${version}: explicit factory ${status} response is preserved unchanged`, async () => {
  let response: Response | undefined;
  const client = await connect(version, async r => { response = r; });
  const credential = status === 401 ? "invalid" : issuedOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:delivery"]).token;
  const refusal = oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${credential}` } }));
  if (!(refusal instanceof Response)) throw new Error("expected fixture OAuth refusal");
  expect(refusal.status).toBe(status);
  const original = oauth.authenticate;
  let checks = 0;
  oauth.authenticate = (...args) => ++checks === 2 ? refusal : original(...args);
  try {
    await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }).catch(() => undefined);
    expect(response).toBe(refusal);
    expect(response!.headers.get("WWW-Authenticate")).toContain(`scope="grayboard:tools", error="${status === 401 ? "invalid_token" : "insufficient_scope"}"`);
    expect(response!.headers.get("WWW-Authenticate")).toContain(oauth.resourceMetadata);
    expect(checks).toBe(2);
    expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { oauth.authenticate = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: revocation during identity selection preserves the precommit OAuth challenge`, async () => {
  let response: Response | undefined;
  const client = await connect(version, async r => { response = r; });
  const original = hosted.sessions.snapshot;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await original(...args);
    selected();
    await barrier;
    return result;
  };
  try {
    const pending = client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }).catch(e => e);
    await selection;
    store.repo.sessions.revokeAllForUser(user.user_id);
    release();
    await pending;
    expect(response!.status).toBe(401);
    expect(response!.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${oauth.resourceMetadata}", scope="grayboard:tools", error="invalid_token"`);
    expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { release(); hosted.sessions.snapshot = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) for (const stop of ["abort", "close"] as const) test(`${version}: ${stop} during selection is not an OAuth refusal`, async () => {
  const original = hosted.sessions.snapshot;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await original(...args);
    selected();
    await barrier;
    return result;
  };
  const abort = new AbortController();
  const params = { name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" }, _meta: { ...meta }, ...(version === "2026-07-28" ? { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "barrier", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) };
  try {
    const pending = hosted.fetch(new Request("http://localhost/mcp", { method: "POST", signal: abort.signal, headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version, ...(version === "2026-07-28" ? { "Mcp-Method": "tools/call", "Mcp-Name": "board_create" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }));
    await selection;
    store.repo.sessions.revokeAllForUser(user.user_id);
    if (stop === "abort") abort.abort(); else await hosted.close();
    release();
    const response = await pending;
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    await response.arrayBuffer();
    expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { release(); hosted.sessions.snapshot = original; }
});

test("actual access revocation between factory and dispatch prevents mutation", async () => {
  const client = await connect();
  const original = oauth.isAuthorized;
  let checks = 0;
  oauth.isAuthorized = principal => {
    const valid = original(principal);
    if (++checks === 1) store.repo.oauth.revokeToken(principal.accessHash, principal.clientId, Date.now());
    return valid;
  };
  try {
    await expect(client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } })).rejects.toThrow("invalid_token");
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
  } finally { oauth.isAuthorized = original; }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: factory and dispatch persistence errors are redacted`, async () => {
  const client = await connect(version);
  const original = store.repo.oauth.findActiveAccess;
  for (const stage of [2, 3, 4]) {
    let checks = 0;
    store.repo.oauth.findActiveAccess = (...args) => {
      if (++checks === stage) throw new Error("SELECT secret FROM /private/oauth.sqlite");
      return original(...args);
    };
    try {
      let result: unknown;
      try { result = await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }); }
      catch (e) { result = String(e); }
      const encoded = JSON.stringify(result);
      expect(encoded).not.toMatch(/SELECT|private|sqlite|secret/);
      expect(encoded).toMatch(/internal|Internal/);
      expect(checks).toBe(stage);
      expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
      expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
    } finally { store.repo.oauth.findActiveAccess = original; }
  }
});

for (const version of ["2025-11-25", "2025-06-18"]) test(`${version}: concurrent refreshed exchanges keep their own access after reversed awaits`, async () => {
  const grant = issuedOAuth(store.repo, oauth.resource);
  const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
  const client = await connect(version, undefined, headers);
  await Bun.sleep(0);
  let refreshToken = grant.refreshToken;
  function rotate() {
    const access = randomBytes(32).toString("base64url"), refresh = randomBytes(32).toString("base64url"), now = Date.now();
    expect(store.repo.oauth.rotateRefresh({ ...grant.binding, refreshHash: hashToken(refreshToken), tokens: {
      ...grant.tokens, accessHash: hashToken(access), refreshHash: hashToken(refresh), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
    } }, now).status).toBe("ok");
    refreshToken = refresh;
    return access;
  }
  const firstAccess = rotate(), secondAccess = rotate();
  store.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, Date.now());
  const select = hosted.sessions.snapshot;
  const releases: Array<() => void> = [];
  async function selected(count: number) {
    const deadline = performance.now() + 1000;
    while (releases.length < count && performance.now() < deadline) await Bun.sleep(1);
    expect(releases.length).toBe(count);
  }
  hosted.sessions.snapshot = async (...args) => {
    const selected = await select(...args);
    await new Promise<void>(resolve => releases.push(resolve));
    return selected;
  };
  try {
    headers.set("Authorization", `Bearer ${firstAccess}`);
    const first = client.callTool({ name: "whoami", arguments: {} }).catch(error => error);
    await selected(1);
    headers.set("Authorization", `Bearer ${secondAccess}`);
    const second = client.callTool({ name: "peer_list", arguments: { include_offline: true } });
    await selected(2);
    store.repo.oauth.revokeToken(hashToken(firstAccess), grant.binding.clientId, Date.now());
    releases[1]!();
    expect(JSON.stringify(await second)).toContain("alice@example.com/be");
    releases[0]!();
    expect(await first).toBeInstanceOf(Error);
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { releases.forEach(release => release()); hosted.sessions.snapshot = select; }
});

test("modern listen capacity is reserved and reusable after cancellation", async () => {
  const client = await connect();
  await client.callTool({ name: "board_create", arguments: { name: "bounded", purpose: "listen quota" } });
  const filter = { resourceSubscriptions: ["grayboard://boards/bounded"] };
  const subscriptions = [];
  for (let i = 0; i < 128; i++) subscriptions.push(await client.listen(filter));
  expect(hosted.activeListens).toBe(128);
  expect(hosted.activeBusListeners).toBe(128);
  await expect(client.listen(filter)).rejects.toThrow();
  await Promise.all(subscriptions.map(sub => sub.close()));
  await Bun.sleep(0);
  expect(hosted.activeListens).toBe(0);
  expect(hosted.activeBusListeners).toBe(0);
  const replacement = await client.listen(filter);
  await replacement.close();
});

test("legacy registry is bounded and idle disconnected sessions are reclaimed", async () => {
  await hosted.close();
  let clock = Date.now();
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, now: () => clock });
  for (let i = 0; i < 256; i++) await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(256);
  await expect(connect("2025-11-25")).rejects.toThrow();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Bun.sleep(0);
  expect(hosted.activeGetStreams).toBe(0);
  clock += 60_001;
  await Bun.sleep(1100);
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(1);
});

test("global board watch bound cleans partial acquisitions without retiring other listeners", async () => {
  const client = await connect();
  const uris = [];
  for (let i = 0; i < 32; i++) {
    await client.callTool({ name: "board_create", arguments: { name: `b${i}`, purpose: "bounded watches" } });
    uris.push(`grayboard://boards/b${i}`);
  }
  await expect(client.listen({ resourceSubscriptions: [...uris, "grayboard://identity"] })).rejects.toThrow();
  expect(hosted.activeWatches).toBe(0);
  const subscriptions = [];
  for (let i = 0; i < 32; i++) subscriptions.push(await client.listen({ resourceSubscriptions: uris }));
  expect(hosted.activeWatches).toBe(1024);
  await expect(client.listen({ resourceSubscriptions: uris })).rejects.toThrow();
  expect(hosted.activeWatches).toBe(1024);
  expect(hosted.activeListens).toBe(32);
  await Promise.all(subscriptions.map(sub => sub.close()));
  await Bun.sleep(0);
  expect(hosted.activeWatches).toBe(0);
});

test("shutdown awaits pending original request source cancellation", async () => {
  let release!: () => void, cancelStarted = false, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel: async () => { cancelStarted = true; await gate; } });
  const request = new Request("http://localhost/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be", "Content-Type": "application/json" }, body });
  const pending = hosted.fetch(request);
  await Bun.sleep(0);
  const closing = hosted.close().then(() => { closed = true; });
  await Bun.sleep(0);
  expect(cancelStarted).toBe(true); expect(closed).toBe(false);
  release();
  await closing; await pending;
  expect(body.locked).toBe(false);
  expect(hosted.activePosts).toBe(0);
});

async function untilHosted(predicate: () => boolean) {
  const deadline = performance.now() + 1000;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

async function legacyWatchFixture(version: string, headers?: Headers) {
  const gets: Request[] = [], hints: string[] = [];
  const client = await connect(version, undefined, headers, request => { if (request.method === "GET") gets.push(request); });
  client.setNotificationHandler("notifications/resources/updated", n => { hints.push(n.params.uri); });
  expect((await client.callTool({ name: "board_create", arguments: { name: "rollback", purpose: "watch acquisition" } })).isError).not.toBe(true);
  await untilHosted(() => hosted.activeGetStreams === 1);
  return { client, gets, hints, uri: "grayboard://boards/rollback" };
}

for (const version of ["2025-11-25", "2025-06-18"]) for (const kind of ["database", "internal"] as const) test(`${version}: ${kind} observer failure rolls back registration and retry installs exactly one watch`, async () => {
  const { client, gets, hints, uri } = await legacyWatchFixture(version);
  const original = application.observeBoard;
  const fault = kind === "internal" ? new ApplicationError("internal", "SELECT secret FROM private_storage") : new Error("SELECT secret FROM private_storage");
  let failing = true, attempts = 0;
  application.observeBoard = (...args) => { attempts++; if (failing) throw fault; return original(...args); };
  try {
    await expect(client.subscribeResource({ uri: "grayboard://boards/missing" })).rejects.toMatchObject({ code: -32602 });
    expect(attempts).toBe(0);
    const failure = await client.subscribeResource({ uri }).catch(error => error);
    expect(failure).toMatchObject({ code: -32603 });
    expect(failure.message).toContain("internal error");
    expect(failure.message).not.toContain("private_storage");
    expect(hosted.activeWatches).toBe(0);
    expect(hosted.activeGetStreams).toBe(1);
    expect(gets).toHaveLength(1);
    expect(attempts).toBe(1);
    failing = false;
    expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "unregistered" } })).isError).not.toBe(true);
    expect(hints).toEqual([]);
    expect(await client.subscribeResource({ uri })).toEqual({});
    expect(hosted.activeWatches).toBe(1);
    expect(await client.subscribeResource({ uri })).toEqual({});
    expect(hosted.activeWatches).toBe(1);
    expect(attempts).toBe(2);
    expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "registered" } })).isError).not.toBe(true);
    await untilHosted(() => hints.length === 1);
    expect(hints).toEqual([uri]);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.signal.aborted).toBe(false);
    expect(store.repo.cursors.directFor("alice@example.com/be")).toBe(0);
    await client.unsubscribeResource({ uri });
    expect(hosted.activeWatches).toBe(0);
  } finally { application.observeBoard = original; }
});

for (const version of ["2025-11-25", "2025-06-18"]) for (const kind of ["database", "internal"] as const) test(`${version}: ${kind} fault checking the old GET is an internal error, not a successful registration`, async () => {
  const grant = issuedOAuth(store.repo, oauth.resource);
  const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
  const { client, gets, hints, uri } = await legacyWatchFixture(version, headers);
  const access = randomBytes(32).toString("base64url"), refresh = randomBytes(32).toString("base64url"), now = Date.now();
  expect(store.repo.oauth.rotateRefresh({ ...grant.binding, refreshHash: hashToken(grant.refreshToken), tokens: {
    ...grant.tokens, accessHash: hashToken(access), refreshHash: hashToken(refresh), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
  } }, now).status).toBe("ok");
  headers.set("Authorization", `Bearer ${access}`);
  const original = store.repo.oauth.findActiveAccess;
  const fault = kind === "internal" ? new ApplicationError("internal", "SELECT secret FROM private_storage") : new Error("SELECT secret FROM private_storage");
  let oldChecks = 0;
  store.repo.oauth.findActiveAccess = (...args) => {
    if (args[0] === grant.tokens.accessHash) { oldChecks++; throw fault; }
    return original(...args);
  };
  try {
    const failure = await client.subscribeResource({ uri }).catch(error => error);
    expect(failure).toMatchObject({ code: -32603 });
    expect(failure.message).toContain("internal error");
    expect(failure.message).not.toContain("private_storage");
    expect(oldChecks).toBe(1);
    expect(hosted.activeWatches).toBe(0);
    expect(hosted.activeGetStreams).toBe(1);
    expect(gets).toHaveLength(1);
  } finally { store.repo.oauth.findActiveAccess = original; }
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "unregistered" } })).isError).not.toBe(true);
  expect(hints).toEqual([]);
  expect(await client.subscribeResource({ uri })).toEqual({});
  expect(hosted.activeWatches).toBe(1);
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "recovered" } })).isError).not.toBe(true);
  await untilHosted(() => hints.length === 1);
  expect(hints).toEqual([uri]);
  expect(gets).toHaveLength(1);
});

test("authentication storage errors return a redacted HTTP 500 before identity selection", async () => {
  const original = store.repo.oauth.findActiveAccess;
  store.repo.oauth.findActiveAccess = () => { throw new Error("SELECT secret FROM /private/oauth.sqlite"); };
  try {
    const response = await hosted.fetch(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "unselected" } }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal", message: "internal error" });
    expect(store.repo.identities.findByUserAndName(user.user_id, "unselected")).toBeUndefined();
  } finally { store.repo.oauth.findActiveAccess = original; }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});
