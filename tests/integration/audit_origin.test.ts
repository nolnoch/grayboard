// Every server audit row written while handling a request carries the client
// address and user agent it came from; work no request caused carries null
// (security audit F-19, src/server/request_context.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { auditOrigins } from "../support/audit.ts";
import { TestServer } from "../support/server.ts";

let srv: TestServer;
beforeEach(() => { srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }); });
afterEach(async () => { await srv.stop(); });

const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

// A CLI /api route behind the trusted local proxy: the forwarded client, not the proxy.
test("a CLI route's row carries the forwarded client address and user agent", async () => {
  const r = await fetch(`${srv.base}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", "User-Agent": "audit-origin-test/1" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(r.status).toBe(200);
  const rows = auditOrigins(srv.app.db, "auth.login");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ip: "203.0.113.7", ua: "audit-origin-test/1" });
});

// A hosted tool call's write row (the hosted store's own writer), over /mcp.
test("a hosted write's row carries the address of the request that made it", async () => {
  const s = await srv.hosted("alice@example.com", "be");
  await s.call("board_create", { name: "e2e", purpose: "fixtures" });
  const rows = auditOrigins(srv.app.db, "hosted.write");
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.ip).toMatch(LOOPBACK);
});

// An OAuth route: a refused authorize request is audited with its caller.
test("an OAuth route's row carries the caller's address", async () => {
  const r = await fetch(`${srv.base}/oauth/authorize?client_id=nope&response_type=code`, { headers: { "User-Agent": "audit-origin-test/2" }, redirect: "manual" });
  await r.body?.cancel();
  const rows = (srv.app.db.query("SELECT action, ip, ua FROM access_log WHERE action LIKE 'oauth.%'").all() as { action: string; ip: string | null; ua: string | null }[]);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).toMatchObject({ ip: expect.stringMatching(LOOPBACK), ua: "audit-origin-test/2" });
});

// Boot serves no request: its row carries no address.
test("a row no request caused carries no address", () => {
  expect(auditOrigins(srv.app.db, "server.started")).toEqual([{ ip: null, ua: null }]);
});
