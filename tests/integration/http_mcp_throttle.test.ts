import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { hostedRowCount } from "../support/hosted_rows.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT } from "../../src/server/oauth-config.ts";

// The per-user bind bucket (helloLimit: the hello that shared it is gone, #282)
// is the application's, separate from the hosted request bucket; the binds are
// application sessions'.
test("hosted traffic at 5 requests/s cannot starve same-user binds; exhaustion is isolated", async () => {
  let now = 0;
  const srv = new TestServer({}, { now: () => now });
  const client = new Client({ name: "load", version: "1" }, { supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    const token = await srv.login("alice@example.com");
    const other = await srv.login("bob@example.com");
    const hostedToken = (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", ["grayboard:tools"], Date.now(), OPENCODE_CLIENT)).token;
    const otherHostedToken = (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "bob@example.com")).token;
    srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: "alice@example.com", name: "be" }, "alice@example.com");
    srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: "bob@example.com", name: "be" }, "bob@example.com");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${hostedToken}` } },
      fetch: async (input, init) => {
        let request = new Request(input, init);
        if (request.method === "POST" && request.body) {
          const body = await request.json();
          body.params = { ...body.params, _meta: { ...body.params?._meta, "ai.opencode/sessionID": "throttle-root" } };
          request = new Request(request, { body: JSON.stringify(body) });
        }
        return fetch(request);
      },
    }));
    expect((await client.callTool({ name: "bind", arguments: { name: "be" } })).isError).not.toBe(true);
    // Real HTTP dispatches; virtual admission time makes the >1/s drain deterministic.
    for (let n = 0; n < 600; n++) {
      now += 200;
      expect((await client.callTool({ name: "board_list", arguments: {} })).isError).not.toBe(true);
    }
    await srv.appSession(token, "ops").connect();
    let refused = false;
    for (let n = 0; n < 121; n++) {
      try { await client.callTool({ name: "board_list", arguments: {} }); }
      catch { refused = true; break; }
    }
    expect(refused).toBe(true);
    await srv.appSession(token, "qa").connect();
    const response = await fetch(`${srv.base}/mcp`, { headers: { Authorization: `Bearer ${otherHostedToken}` } });
    expect(response.status).toBe(405);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'bind.rate_limited'").all()).toHaveLength(0);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'hosted.rate_limited'").all()).toHaveLength(1);
  } finally { await client.close(); await srv.stop(); }
}, 60_000);

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: hosted admission exposes throttling and recovers without dispatching refused tools`, async () => {
  const srv = new TestServer({}, { hostedRequestLimit: { burst: 10, perSec: 1 } });
  const client = new Client({ name: "throttle-test", version: "1" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  let last: { status: number; retryAfter: string | null; body: string } | undefined;
  try {
    const { token, authed } = await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com");
    const user = srv.app.repo.users.findByEmail("alice@example.com")!;
    srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: user.email, name: "be" }, user.email);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        last = { status: res.status, retryAfter: res.headers.get("Retry-After"), body: await res.clone().text() };
        return res;
      },
    }));
    let refused = false;
    for (let i = 0; i < 12; i++) {
      try { await client.callTool({ name: "board_list", arguments: {} }); }
      catch { refused = true; break; }
    }
    expect(refused).toBe(true);
    expect(last!.status).toBe(429);
    const envelope = JSON.parse(last!.body);
    expect(envelope.jsonrpc).toBe("2.0");
    expect(typeof envelope.id).toBe("number");
    const error = envelope.error;
    expect(error.data.retry_after_ms).toBeGreaterThan(0);
    expect(error.data.retry_after_ms).toBeLessThanOrEqual(1000);
    expect(last!.retryAfter).toBe(String(Math.ceil(error.data.retry_after_ms / 1000)));
    expect(error).toMatchObject({ code: -32000, data: { code: "rate_limited" } });
    expect(last!.body).not.toContain(user.email);
    expect(srv.app.mcp.activeContexts).toBe(srv.app.mcp.activeGetStreams);
    expect(() => srv.app.application.admitHosted(authed, null, "native")).toThrow(expect.objectContaining({ code: "rate_limited" }));
    expect(hostedRowCount(srv.app.db)).toBe(0);
    const before = srv.app.db.query("SELECT * FROM boards").all();
    await expect(client.callTool({ name: "board_create", arguments: { name: "refused", purpose: "must not dispatch" } })).rejects.toThrow();
    expect(last!.status).toBe(429);
    expect(srv.app.db.query("SELECT * FROM boards").all()).toEqual(before);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'binding.bound'").all()).toEqual([]);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'hosted.rate_limited'").all()).toHaveLength(1);
    await until(async () => {
      try { return await client.callTool({ name: "board_list", arguments: {} }); }
      catch { expect(last!.status).toBe(429); return false; }
    }, 3000, "hosted request bucket to refill");
    expect(last!.status).toBe(200);
    expect(last!.retryAfter).toBeNull();
    expect(srv.app.db.query("SELECT * FROM boards").all()).toEqual(before);
    expect(srv.app.mcp.activeContexts).toBe(srv.app.mcp.activeGetStreams);
  } finally {
    await client.close();
    await srv.stop();
  }
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: native hosted preflight spends once before candidate reads`, async () => {
  let now = 0;
  const srv = new TestServer({}, { hostedRequestLimit: { burst: 2, perSec: 1 }, now: () => now });
  try {
    const { token } = await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com");
    srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: "alice@example.com", name: "be" }, "alice@example.com");
    const aliases = srv.app.repo.aliases;
    const find = aliases.find.bind(aliases), listFor = aliases.listForScope.bind(aliases);
    let finds = 0, lists = 0;
    aliases.find = (...args) => { finds++; return find(...args); };
    aliases.listForScope = (...args) => { lists++; return listFor(...args); };
    let legacySession: string | null = null;
    const call = async (name: string, id: number, extra: Record<string, string> = {}) => {
      const response = await fetch(`${srv.base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "MCP-Protocol-Version": version, ...(legacySession ? { "Mcp-Session-Id": legacySession } : {}), ...(version === "2026-07-28" ? { "Mcp-Method": "tools/list" } : {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: version !== "2026-07-28" && !legacySession ? "initialize" : "tools/list", ...(version === "2026-07-28" ? { params: { _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_INFO_META_KEY]: { name: "fixture", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } } : !legacySession ? { params: { protocolVersion: version, clientInfo: { name: "fixture", version: "1" }, capabilities: {} } } : {}) }),
      });
      legacySession ??= response.headers.get("Mcp-Session-Id");
      return { response, text: await response.text() };
    };
    expect((await call("bee", 1, { Origin: "https://foreign.example.com" })).response.status).toBe(403);
    expect((await call("bee", 1, { Authorization: "" })).response.status).toBe(401);
    expect([finds, lists]).toEqual([0, 0]);
    const first = await call("human", 1);
    expect(first.response.status).toBe(200);
    const second = await call("bee", 2);
    expect(second.response.status).toBe(200);
    expect(second.text).toContain('"tools"');
    expect(hostedRowCount(srv.app.db)).toBe(0);
    expect(srv.app.repo.aliases.listForScope("person", "alice@example.com").map(alias => alias.name)).toEqual(["be"]);
    const before = [finds, lists];
    expect(finds).toBe(0);
    expect(lists).toBeGreaterThan(1);
    for (const [name, id] of [["be", 3], ["bee", 4]] as const) {
      const blocked = await call(name, id);
      expect(blocked.response.status).toBe(429);
      expect(blocked.response.headers.get("Retry-After")).toBe("1");
      expect(JSON.parse(blocked.text)).toMatchObject({ jsonrpc: "2.0", id, error: { code: -32000, data: { code: "rate_limited", retry_after_ms: 1000 } } });
      expect([finds, lists]).toEqual(before);
    }
    for (const method of ["GET", "DELETE", "OPTIONS", "HEAD"]) {
      const blocked = await fetch(`${srv.base}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, "MCP-Protocol-Version": version, ...(legacySession ? { "Mcp-Session-Id": legacySession as string } : {}) } });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBe("1");
      await blocked.text();
      expect([finds, lists]).toEqual(before);
    }
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'hosted.rate_limited'").all()).toHaveLength(1);
    now += 1000;
    expect((await call("be", 5)).response.status).toBe(200);
    const after = [finds, lists];
    expect((await call("be", 6)).response.status).toBe(429);
    expect([finds, lists]).toEqual(after);
    expect(srv.app.mcp.activeContexts).toBe(0);
  } finally {
    await srv.stop();
  }
});

test("the hosted attachment byte routes charge a refused bearer to the address gate, and a request with none costs nothing (#401)", async () => {
  let now = 0;
  const srv = new TestServer({ authFailLimit: { burst: 2, perSec: 1 } }, { now: () => now });
  try {
    const token = await srv.login("alice@example.com");
    now = 10_000;
    const bytes = (bearer?: string) => fetch(`${srv.base}/mcp/attachments/1?identity=be`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});
    for (let n = 0; n < 3; n++) expect((await bytes()).status).toBe(401);
    // A malformed token and a well-formed one the server never issued.
    for (const bad of ["not-a-token", "A".repeat(43)]) {
      const response = await bytes(bad);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(bad);
    }
    // Another token: a repeated refused one is answered from memory, uncharged (#923).
    const blocked = await bytes("B".repeat(43));
    expect(blocked.status).toBe(429);
    expect((await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(429);
    expect(srv.app.db.query("SELECT target, detail FROM access_log WHERE action = 'auth.rate_limited'").all()).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('"path":"/mcp/attachments/1"') }),
    ]);
  } finally {
    await srv.stop();
  }
});

test("native HTTP charges only presented invalid tokens in the shared address gate", async () => {
  let now = 0;
  const srv = new TestServer({ authFailLimit: { burst: 2, perSec: 1 } }, { now: () => now });
  try {
    const token = await srv.login("alice@example.com");
    now = 10_000;
    for (let n = 0; n < 3; n++) expect((await fetch(`${srv.base}/mcp`)).status).toBe(401);
    // Two distinct tokens: a repeated refused one is answered from memory, uncharged (#923).
    for (let n = 0; n < 2; n++) {
      const response = await fetch(`${srv.base}/mcp`, { headers: { Authorization: `Bearer not-a-token-${n}` } });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("not-a-token");
    }
    const blocked = await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'auth.rate_limited'").all()).toHaveLength(1);
    now += 2000;
    expect((await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally {
    await srv.stop();
  }
});

// Delivery upkeep draws on its own per-user bucket (#845): a user's spent tool-call bucket doesn't
// refuse their subscriber requests, nor the reverse, and each bucket's refusal run is audited apart.
test("subscriber-role requests and tool calls draw on separate per-user buckets (#845)", async () => {
  let now = 0;
  const srv = new TestServer({}, { hostedRequestLimit: { burst: 2, perSec: 1 }, hostedSubscriberLimit: { burst: 3, perSec: 1 }, now: () => now });
  try {
    const tools = (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", ["grayboard:tools"])).token;
    const delivery = (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", ["grayboard:delivery"])).token;
    const version = "2026-07-28";
    const call = async (token: string, id: number, role?: string) => {
      const response = await fetch(`${srv.base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "MCP-Protocol-Version": version, "Mcp-Method": "tools/list", "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(role ? { "X-Grayboard-Client": role } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_INFO_META_KEY]: { name: "fixture", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }),
      });
      await response.text();
      return response.status;
    };
    expect([await call(tools, 1), await call(tools, 2), await call(tools, 3)]).toEqual([200, 200, 429]);
    // The tool bucket is spent; delivery upkeep still has its own three.
    expect([await call(delivery, 4, "subscriber"), await call(delivery, 5, "subscriber"), await call(delivery, 6, "subscriber"), await call(delivery, 7, "subscriber")]).toEqual([200, 200, 200, 429]);
    expect(await call(tools, 8)).toBe(429);
    const runs = srv.app.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'hosted.rate_limited' ORDER BY id").all();
    expect(runs.map(r => JSON.parse(r.detail).bucket)).toEqual(["native", "subscriber"]);
    now += 1000;
    expect(await call(tools, 9)).toBe(200);
    expect(await call(delivery, 10, "subscriber")).toBe(200);
    expect(srv.app.application.limiterSizes()).toMatchObject({ hosted: 1, subscriber: 1 });
    // Refilled buckets are swept, and each run's end is audited with its bucket.
    now += 10_000;
    srv.app.application.sweepHellos();
    expect(srv.app.application.limiterSizes()).toMatchObject({ hosted: 0, subscriber: 0 });
    const ends = srv.app.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'hosted.rate_limit_ended' ORDER BY id").all();
    expect(ends.map(r => JSON.parse(r.detail).bucket).sort()).toEqual(["native", "subscriber"]);
  } finally {
    await srv.stop();
  }
});
