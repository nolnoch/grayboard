import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./application.ts";
import { createHostedMcp, MCP_PROTOCOL_VERSIONS } from "./mcp.ts";
import { openDatabase } from "./db.ts";
import { createOAuthServer } from "./oauth.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";

let store: ReturnType<typeof openDatabase>, application: ReturnType<typeof createApplication>;
let oauth: ReturnType<typeof createOAuthServer>, hosted: ReturnType<typeof createHostedMcp>;
let dir: string, grant: ReturnType<typeof issueOAuth>;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-mcp-resource-unit-"));
  store = openDatabase(":memory:", { blobDir: dir });
  application = createApplication(store.repo, store.db);
  oauth = createOAuthServer(store.repo, { dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] });
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer });
  grant = issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools", "grayboard:delivery"]);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
  expect(hosted.activeLeases).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeResourceContexts).toBe(0);
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
    fetch: (input, init) => {
      const request = new Request(input, { ...init, ...(signal ? { signal } : {}) });
      headers?.forEach((value, key) => request.headers.set(key, value));
      return hosted.fetch(request);
    },
  }));
  return client;
}

for (const version of MCP_PROTOCOL_VERSIONS) for (const stop of ["access", "abort", "close"] as const) test(`${version}: ${stop} after async lease selection releases new ownership`, async () => {
  const abort = new AbortController();
  const client = await connect(version, "subscriber", abort.signal);
  const original = application.selectIdentity;
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { resume = r; });
  application.selectIdentity = async (...args) => {
    const selected = await original(...args);
    if (args[3]?.push === true) { entered(); await gate; }
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
    expect(hosted.activeContexts).toBe(0);
    expect(hosted.activeResourceContexts).toBe(0);
    const replacement = await original(grant.authed, "be", { deliver() {}, probe: async () => true, closed() {} });
    application.close(replacement.session);
  } finally { resume(); application.selectIdentity = original; }
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: resource and control storage failures are redacted, not fabricated auth failures`, async () => {
  const native = await connect(version, "native");
  const sub = await connect(version);
  const catalog = application.boardCatalog;
  application.boardCatalog = () => { throw new Error("SELECT secret FROM /private/database.sqlite"); };
  try {
    await expect(native.listResources()).rejects.toThrow("internal error");

  } finally { application.boardCatalog = catalog; }
  const select = application.selectIdentity;
  application.selectIdentity = (...args) => {
    if (args[3]?.push === true) throw new Error("SELECT secret FROM /private/database.sqlite");
    return select(...args);
  };
  try {
    const result = await sub.callTool({ name: "delivery_open", arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
    expect(hosted.activeLeases).toBe(0);
  } finally { application.selectIdentity = select; }
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
    await expect(request).rejects.toMatchObject({ message: "internal error" });
    expect(accessChecks).toBe(5);
    expect(sessionChecks).toBe(boundary === "grant" ? 1 : 2);
    expect(store.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  } finally { store.repo.oauth.findActiveAccess = findAccess; application.revalidateSession = validate; }
  expect((await client.listResources()).resources[0]!.uri).toBe("grayboard://identity");
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const method of ["renew", "inbox"] as const) for (const faultAt of [1, 2, 3, 4]) test(`${version}: ${method} grant storage fault at check ${faultAt} preserves the lease`, async () => {
  const headers = new Headers();
  const client = await connect(version, "subscriber", undefined, headers);
  const opened = await client.callTool({ name: "delivery_open", arguments: {} });
  const lease = JSON.parse((opened.content[0] as { text: string }).text) as { capability: string };
  headers.set("X-Grayboard-Lease", lease.capability);
  const isActive = store.repo.oauth.isGrantActive;
  let calls = 0;
  store.repo.oauth.isGrantActive = (...args) => {
    if (++calls === faultAt) throw new Error("SELECT secret FROM private_database");
    return isActive(...args);
  };
  try {
    if (method === "renew") {
      expect(await client.callTool({ name: "delivery_renew", arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
    } else {
      await expect(client.readResource({ uri: "grayboard://inbox" })).rejects.toMatchObject({ message: "internal error" });
    }
    expect(calls).toBe(faultAt);
    expect(hosted.activeLeases).toBe(1);
    expect(store.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  } finally { store.repo.oauth.isGrantActive = isActive; }
  const renewed = await client.callTool({ name: "delivery_renew", arguments: {} });
  expect(renewed.isError).toBeUndefined();
  expect(JSON.parse((renewed.content[0] as { text: string }).text).capability).toBe(lease.capability);
});
