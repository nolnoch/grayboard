import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliveryEvent } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { openDatabase } from "./db.ts";
import { hashToken, mintToken, type AuthedUser } from "./auth.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedMcp>;
let user: AuthedUser;
let token: string;
let blobDir: string;
const clients: Client[] = [];
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-mcp-"));
  store = openDatabase(":memory:", { blobDir });
  application = createApplication(store.repo, store.db);
  hosted = createHostedMcp(application, store.repo, { trustedOrigin: "https://grayboard.example.com:443" });
  const u = store.repo.users.upsertByEmail("alice@example.com", null);
  token = mintToken();
  const session = store.repo.sessions.create(u.id, hashToken(token), "test");
  user = { user_id: u.id, user_email: u.email, session_id: session.id };
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
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

for (const version of ["2026-07-28", "2025-11-25"]) test(`${version}: tools-only contexts preserve live owner and its status`, async () => {
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
