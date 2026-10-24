import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliveryEvent } from "./application.ts";
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
  const select = application.selectIdentity;
  application.selectIdentity = async (...args) => { selections++; return select(...args); };
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
  expect(store.repo.identities.findByUserAndName(user.user_id, "refused")).toBeUndefined();
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
  const select = application.selectIdentity;
  let selected!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  application.selectIdentity = async (...args) => {
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
