// Every server audit row written while handling a request carries the client
// address and user agent it came from, and a hosted MCP request's OAuth client (#847);
// work no request caused carries null (security audit F-19, src/server/request_context.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { requestOrigin, type RequestOrigin } from "../../src/server/request_context.ts";
import { auditOrigins } from "../support/audit.ts";
import { exec, row, rows as sqlRows } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let srv: TestServer;
beforeEach(async () => { srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }); });
afterEach(async () => { await srv.stop(); });

const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

// A CLI /api route behind the trusted local proxy: the forwarded client, not the proxy.
// Dev sign-in itself is loopback-only (security audit F-04), so the row comes from an authenticated route.
test("a CLI route's row carries the forwarded client address and user agent", async () => {
  const token = await srv.login("alice@example.com");
  const r = await fetch(`${srv.base}/api/teams`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", "User-Agent": "audit-origin-test/1" },
    body: JSON.stringify({ name: "eng" }),
  });
  expect(r.status).toBe(201);
  const rows = await auditOrigins(srv, "team.created");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ ip: "203.0.113.7", ua: "audit-origin-test/1", client_id: null });
});

// A hosted tool call's write row (the hosted store's own writer), over /mcp.
test("a hosted write's row carries the address of the request that made it", async () => {
  const s = await srv.hosted("alice@example.com", "be");
  await s.call("board_create", { name: "e2e", purpose: "fixtures" });
  const rows = await auditOrigins(srv, "hosted.write");
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.ip).toMatch(LOOPBACK);
});

// #847: an application row a hosted tool call writes (not only the hosted store's own) names the OAuth client.
test("an application row written during a hosted tool call carries the request's OAuth client", async () => {
  const s = await srv.hosted("alice@example.com", null);
  await s.call("bind", { name: "be", create: true });
  const client = (await sqlRows<{ client_id: string }>(srv, "SELECT DISTINCT client_id FROM hosted_sessions")).map(r => r.client_id);
  expect(client).toHaveLength(1);
  const rows = await auditOrigins(srv, "alias.created");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ip: expect.stringMatching(LOOPBACK), client_id: client[0] });
});

// The claim-expiry timer is armed by a request but fires for every holder: its writes carry no request (detached).
test("a claim expiry armed by a request writes outside it", async () => {
  const s = await srv.hosted("alice@example.com", "be");
  await s.call("board_create", { name: "lobby", purpose: "general" });
  await s.call("claim_take", { key: "ticket:1", board: "lobby", ttl_minutes: 60 });
  // Lapse soon, but after the next claim call, which re-arms the timer from inside its request (a call that ran
  // past the lapse would sweep it itself: the check below says so rather than passing on nothing).
  await exec(srv, "UPDATE claims SET expires_at = ? WHERE key = 'ticket:1'", Date.now() + 1500);
  const write = srv.app.repo.write.bind(srv.app.repo);
  const after: (RequestOrigin | undefined)[] = [];
  let armed = false;
  srv.app.repo.write = ((fn: Parameters<typeof write>[0]) => { if (armed) after.push(requestOrigin()); return write(fn); }) as typeof write;
  await s.call("claim_take", { key: "ticket:2", board: "lobby", ttl_minutes: 60 });
  armed = true;
  expect(await row(srv, "SELECT 1 AS one FROM claims WHERE key = 'ticket:1'")).toBeTruthy();
  await until(async () => !(await row(srv, "SELECT 1 AS one FROM claims WHERE key = 'ticket:1'")), 5000, "ticket:1 lapsed");
  expect(after.length).toBeGreaterThan(0);
  expect(after).toEqual(after.map(() => undefined));
});

// An OAuth route: a refused authorize request is audited with its caller.
test("an OAuth route's row carries the caller's address", async () => {
  const r = await fetch(`${srv.base}/oauth/authorize?client_id=nope&response_type=code`, { headers: { "User-Agent": "audit-origin-test/2" }, redirect: "manual" });
  await r.body?.cancel();
  // The refusal's row is a post: on Postgres it commits after the response (a post is always queued there).
  const rows = await until(async () => {
    const got = await sqlRows<{ action: string; ip: string | null; ua: string | null }>(srv, "SELECT action, ip, ua FROM access_log WHERE action LIKE 'oauth.%'");
    return got.length > 0 && got;
  }, 5000, "an oauth.* audit row");
  for (const row of rows) expect(row).toMatchObject({ ip: expect.stringMatching(LOOPBACK), ua: "audit-origin-test/2" });
});

// Boot serves no request: its row carries no address.
test("a row no request caused carries no address", async () => {
  await srv.app.ready;
  expect(await auditOrigins(srv, "server.started")).toEqual([{ ip: null, ua: null, client_id: null }]);
});
