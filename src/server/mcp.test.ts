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

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedMcp>;
let user: AuthedUser;
let token: string;
let oauth: ReturnType<typeof createOAuthServer>;
let blobDir: string;
const clients: Client[] = [];
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-mcp-"));
  store = openDatabase(":memory:", { blobDir });
  application = createApplication(store.repo, store.db);
  oauth = createOAuthServer(store.repo, { dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] });
  hosted = createHostedMcp(application, oauth, { trustedOrigin: "https://grayboard.example.com:443" });
  const issued = issueOAuth(store.repo, oauth.resource);
  token = issued.token;
  user = issued.authed;
  store.repo.aliases.create(user.user_email, "be");
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
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

async function connect(version = "2026-07-28", intercept?: (response: Response) => Promise<void>) {
  const client = new Client({ name: "unit", version: "1" }, {
    supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be", "X-Grayboard-Where": "tools" } },
    fetch: async (input, init) => {
      const response = await hosted.fetch(new Request(input, init));
      await intercept?.(response);
      return response;
    },
  }));
  return client;
}

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: tools-only contexts preserve live owner and its status`, async () => {
  const events: DeliveryEvent[] = [];
  const owner = (await application.selectIdentity(user, "be", { deliver: e => { events.push(e); }, probe: async () => true, closed() {} }, { where: "owner" })).session;
  application.call(owner, "peer_status", { text: "working" });
  const client = await connect(version);
  for (let n = 0; n < 10; n++) {
    expect((await client.callTool({ name: "dm_send", arguments: { to: "be", body: `hello ${n}` } })).isError).not.toBe(true);
  }
  expect(events).toHaveLength(10);
  const peers = application.call(owner, "peer_list", {}) as { peers: unknown[] };
  expect(peers.peers).toMatchObject([{ handle: "alice@example.com/be", online: true, status: "working", where: "owner" }]);
  expect(store.repo.cursors.directFor(owner.identityFull)).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  await expect(application.selectIdentity(user, "be", { deliver() {}, probe: async () => false, closed() {} })).rejects.toMatchObject({ code: "identity_in_use" });
});

test("Origin policy precedes authentication and context creation on every HTTP method", async () => {
  let selections = 0;
  const admit = application.admitIdentity;
  application.admitIdentity = (...args) => { selections++; return admit(...args); };
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
  expect(hosted.activeContexts).toBe(0);
});

test("legacy SSE context survives fetch return until SDK reader cancellation", async () => {
  let cancelled = false;
  await expect(connect("2025-11-25", async response => {
    if (!cancelled && response.headers.get("content-type")?.includes("text/event-stream")) {
      cancelled = true;
      expect(hosted.activeContexts).toBe(1);
      await response.body!.cancel();
      expect(hosted.activeContexts).toBe(0);
      throw new Error("test cancelled response");
    }
  })).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(hosted.activeContexts).toBe(0);
});

test("shutdown closes outstanding legacy SSE products and refuses new contexts", async () => {
  let shutdown = false;
  await expect(connect("2025-11-25", async response => {
    if (!shutdown && response.headers.get("content-type")?.includes("text/event-stream")) {
      shutdown = true;
      expect(hosted.activeContexts).toBe(1);
      await hosted.close();
      expect(hosted.activeContexts).toBe(0);
    }
  })).rejects.toThrow();
  expect(shutdown).toBe(true);
  expect((await hosted.fetch(new Request("http://localhost/mcp"))).status).toBe(503);
});

test("shutdown racing the factory cannot leave a selected context behind", async () => {
  const admit = application.admitIdentity;
  let selected!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  application.admitIdentity = (...args) => {
    const select = admit(...args);
    return async sink => {
      const result = await select(sink);
      selected();
      await gate;
      return result;
    };
  };
  const pending = connect();
  await ready;
  await hosted.close();
  release();
  await expect(pending).rejects.toThrow();
  expect(hosted.activeContexts).toBe(0);
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
  expect(hosted.activeContexts).toBe(0);
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
  const credential = status === 401 ? "invalid" : issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:delivery"]).token;
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
    expect(hosted.activeContexts).toBe(0);
  } finally { oauth.authenticate = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: revocation during identity selection preserves the precommit OAuth challenge`, async () => {
  let response: Response | undefined;
  const client = await connect(version, async r => { response = r; });
  const original = application.selectIdentity;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  application.selectIdentity = async (...args) => {
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
    expect(hosted.activeContexts).toBe(0);
  } finally { release(); application.selectIdentity = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) for (const stop of ["abort", "close"] as const) test(`${version}: ${stop} during selection is not an OAuth refusal`, async () => {
  const original = application.selectIdentity;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  application.selectIdentity = async (...args) => {
    const result = await original(...args);
    selected();
    await barrier;
    return result;
  };
  const abort = new AbortController();
  const params = { name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" }, ...(version === "2026-07-28" ? { _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "barrier", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) };
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
    expect(hosted.activeContexts).toBe(0);
  } finally { release(); application.selectIdentity = original; }
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
    const result = await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: unauthenticated" }] });
    expect(checks).toBe(2);
    expect(store.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
  } finally { oauth.isAuthorized = original; }
  expect(hosted.activeContexts).toBe(0);
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
      expect(hosted.activeContexts).toBe(0);
    } finally { store.repo.oauth.findActiveAccess = original; }
  }
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
  expect(hosted.activeContexts).toBe(0);
});
