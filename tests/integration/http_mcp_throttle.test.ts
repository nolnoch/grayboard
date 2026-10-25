import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: hosted admission exposes throttling and recovers without dispatching refused tools`, async () => {
  const srv = new TestServer({}, { helloLimit: { burst: 10, perSec: 1 } });
  const client = new Client({ name: "throttle-test", version: "1" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  let last: { status: number; retryAfter: string | null; body: string } | undefined;
  try {
    const token = await srv.login("alice@example.com");
    const user = srv.app.repo.users.findByEmail("alice@example.com")!;
    srv.app.repo.identities.create(user.id, "be");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be" } },
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
    expect(srv.app.mcp.activeContexts).toBe(0);
    const before = srv.app.db.query("SELECT * FROM boards").all();
    await expect(client.callTool({ name: "board_create", arguments: { name: "refused", purpose: "must not dispatch" } })).rejects.toThrow();
    expect(last!.status).toBe(429);
    expect(srv.app.db.query("SELECT * FROM boards").all()).toEqual(before);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'binding.bound'").all()).toEqual([]);
    expect(srv.app.db.query("SELECT * FROM access_log WHERE action = 'hello.rate_limited'").all()).toHaveLength(1);
    await until(async () => {
      try { return await client.callTool({ name: "board_list", arguments: {} }); }
      catch { expect(last!.status).toBe(429); return false; }
    }, 3000, "shared admission bucket to refill");
    expect(last!.status).toBe(200);
    expect(last!.retryAfter).toBeNull();
    expect(srv.app.db.query("SELECT * FROM boards").all()).toEqual(before);
    expect(srv.app.mcp.activeContexts).toBe(0);
  } finally {
    await client.close();
    await srv.stop();
  }
});
