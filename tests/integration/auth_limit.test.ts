// The per-address limit on authentication failures (#240), and the plugin
// client's side of it: it stops retrying a refused token, and waits out a
// limited address instead of hammering it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/client";
import { OPENCODE_CLIENT } from "../../src/server/oauth-config.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { closeSessions } from "../support/mcp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const cleanup: (() => void)[] = [];

afterEach(async () => {
  await closeSessions();
  for (const f of cleanup.splice(0)) f();
});

// A server whose limiters run on a clock the test moves.
function serve(o: ConstructorParameters<typeof TestServer>[0] = {}) {
  const clock = { t: 1_000_000 };
  const srv = new TestServer({ authFailLimit: { burst: 3, perSec: 0.1 }, ...o }, { now: () => clock.t });
  cleanup.push(() => srv.stop());
  // Every token lookup, to show a refused request makes none.
  let lookups = 0;
  const find = srv.app.repo.sessions.findByTokenHash.bind(srv.app.repo.sessions);
  srv.app.repo.sessions.findByTokenHash = (h: string) => (lookups++, find(h));
  return { srv, clock, lookups: () => lookups };
}

const get = (srv: TestServer, path: string, token: string | null, from: string) =>
  fetch(`${srv.base}${path}`, { headers: { "X-Forwarded-For": from, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
// A hosted MCP tools/list from `from` with an OAuth access token: the session transport after WSS (#282).
const mcpList = (srv: TestServer, token: string, from: string) =>
  fetch(`${srv.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, "X-Forwarded-For": from, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list",
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "fixture", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } },
    }),
  });
const hostedToken = (srv: TestServer) => issueOAuth(srv.app.repo, srv.app.oauth.resource, A, ["grayboard:tools"], Date.now(), OPENCODE_CLIENT).token;
const audit = (srv: TestServer, action: string) =>
  srv.app.db.query(`SELECT actor, target, detail FROM access_log WHERE action = ?`).all(action) as { actor: string | null; target: string; detail: string }[];

const X = "198.51.100.1";
const Y = "198.51.100.2";

test("burst refused tokens on a route are refused 401; the next gets 429 with a wait, before any token lookup", async () => {
  const { srv, lookups } = serve();
  for (let i = 0; i < 3; i++) expect((await get(srv, "/api/whoami", `bad${i}`, X)).status).toBe(401);
  expect(lookups()).toBe(3);
  const r = await get(srv, "/api/whoami", "bad", X);
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("10");
  expect(await r.json()).toEqual({ code: "rate_limited", message: "too many authentication failures from this address; retry in 10s", retry_after_ms: 10_000 });
  expect(lookups()).toBe(3);
  // A missing token costs nothing: an <img> on any page can make a browser send this.
  for (let i = 0; i < 5; i++) expect((await get(srv, "/api/whoami", null, Y)).status).toBe(401);
  expect(srv.app.authGate.size).toBe(1);
});

test("a limited address is refused everything, a valid token, /healthz and the hosted MCP too; another address isn't", async () => {
  const { srv } = serve();
  const alice = await srv.login(A);
  const hosted = hostedToken(srv);
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", "bad", X);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
  expect((await get(srv, "/healthz", null, X)).status).toBe(429);
  expect((await mcpList(srv, hosted, X)).status).toBe(429);
  expect((await get(srv, "/api/whoami", alice, Y)).status).toBe(200);
  expect((await mcpList(srv, hosted, Y)).status).toBe(200);
});

test("valid traffic, hosted MCP included, 403s, 404s and requests with no token never spend; a refused token on any path does", async () => {
  const { srv } = serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  const alice = await srv.login(A);
  const hosted = hostedToken(srv);
  for (let i = 0; i < 5; i++) {
    expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
    expect((await mcpList(srv, hosted, X)).status).toBe(200);
    // Not an admin, and no such route.
    expect((await fetch(`${srv.base}/api/admin/users`, { method: "POST", headers: { Authorization: `Bearer ${alice}`, "X-Forwarded-For": X }, body: "{}" })).status).toBe(403);
    expect((await get(srv, "/api/nothing-here", alice, X)).status).toBe(404);
    // No token: an <img> on any page can make a browser send this.
    expect((await get(srv, "/api/whoami", null, X)).status).toBe(401);
  }
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
  // An unknown path isn't a public route, so requireAuth answers it: a bad token is a 401, charged by chargeRefusedToken.
  expect((await get(srv, "/api/nothing-here", "bad", X)).status).toBe(401);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
});

test("sign-in calls are charged on entry, and refused uncharged unless JSON; dev-login with dev auth off is a 404 and isn't", async () => {
  const { srv } = serve();
  const devLogin = (from: string) => fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": from, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ email: A }) });
  // A cross-origin form post: text/plain needs no preflight.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": X }, body: JSON.stringify({ email: A }) });
    expect(r.status).toBe(415);
    expect(await r.json()).toEqual({ code: "unsupported_media_type", message: "sign-in takes Content-Type: application/json" });
  }
  expect(srv.app.authGate.size).toBe(0);
  for (let i = 0; i < 3; i++) expect((await devLogin(X)).status).toBe(200);
  expect((await devLogin(X)).status).toBe(429);
  // The audit's address is the resolved one, not the raw header.
  const logins = audit(srv, "auth.login").map((r) => JSON.parse(r.detail).ip);
  expect(logins.slice(-3)).toEqual([X, X, X]);

  const off = serve({ devAuth: false, googleClientSecret: "s", publicUrl: "https://grayboard.example.com" });
  const r = (from: string) => fetch(`${off.srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": from }, body: "{}" });
  for (let i = 0; i < 5; i++) expect((await r(X)).status).toBe(404);
  expect(off.srv.app.authGate.size).toBe(0);
});

test("behind the trusted loopback each X-Forwarded-For has its own bucket, trusted hops skipped; with none trusted it's ignored", async () => {
  const { srv } = serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  expect((await get(srv, "/api/whoami", "bad", `6.6.6.6, ${X}, 127.0.0.1`)).status).toBe(401);
  expect((await get(srv, "/api/whoami", "bad", X)).status).toBe(429);
  expect((await get(srv, "/api/whoami", "bad", Y)).status).toBe(401);
  expect(audit(srv, "auth.rate_limited").map((r) => r.target)).toEqual([X]);

  const none = serve({ authFailLimit: { burst: 1, perSec: 0.1 }, trustedProxies: [] });
  expect((await get(none.srv, "/api/whoami", "bad", X)).status).toBe(401);
  expect((await get(none.srv, "/api/whoami", "bad", Y)).status).toBe(429);
  // Both keyed by the peer, whichever loopback address it was.
  const targets = audit(none.srv, "auth.rate_limited").map((r) => r.target);
  expect(targets).toHaveLength(1);
  expect([X, Y]).not.toContain(targets[0]);
});

test("a run of refusals writes one row and one log line at its start and one at its end", async () => {
  const { srv, clock } = serve();
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", "bad", X);
  for (let i = 0; i < 4; i++) expect((await get(srv, "/api/claims", "bad", X)).status).toBe(429);
  const started = audit(srv, "auth.rate_limited");
  expect(started.length).toBe(1);
  expect(started[0]!.actor).toBeNull();
  expect(started[0]!.target).toBe(X);
  // What tripped the limit, and the failure that drained the bucket (#240 audit item 8).
  expect(JSON.parse(started[0]!.detail)).toEqual({
    addr: X, path: "/api/claims", retry_after_ms: 10_000,
    last_failure: { addr: X, path: "/api/whoami", reason: "refused token", ua: expect.any(String) },
  });
  expect(audit(srv, "auth.rate_limit_ended")).toEqual([]);
  // Refilled (30s at 0.1/s), seen by the heartbeat's sweep.
  clock.t += 30_000;
  srv.app.sweepLimits();
  const ended = audit(srv, "auth.rate_limit_ended");
  expect(ended.length).toBe(1);
  expect(ended[0]!.target).toBe(X);
  expect(JSON.parse(ended[0]!.detail)).toEqual({ refused: 4 });
  expect(srv.app.authGate.size).toBe(0);
});

test("a CLI command on a limited address prints the server's wait", async () => {
  const srv = new TestServer({ authFailLimit: { burst: 1, perSec: 0.1 } });
  cleanup.push(() => srv.stop());
  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "credentials");
  writeFileSync(creds, JSON.stringify({ session_token: "stale", server: srv.base, user_email: A }));
  await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: "Bearer bad" } });
  const r = await runCli(["team", "list"], { env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds }) });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/Error \(rate_limited\): too many authentication failures from this address; retry in \d+s/);
}, 20_000);
