// The per-address limit on authentication failures (#240), and the plugin
// client's side of it: it stops retrying a refused token, and waits out a
// limited address instead of hammering it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/client";
import { OPENCODE_CLIENT } from "../../src/server/oauth-config.ts";
import { accessAudits } from "../support/audit.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { closeSessions } from "../support/mcp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { TestServer, type TestServerOverrides } from "../support/server.ts";
import { REFUSED_TOKEN_TTL_MS } from "../../src/server/auth_gate.ts";
import { stubAuthRead } from "../support/auth_stub.ts";

const A = "alice@example.com";
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  await closeSessions();
  for (const f of cleanup.splice(0)) await f();
});

// A server whose limiters run on a clock the test moves.
async function serve(o: TestServerOverrides = {}) {
  const clock = { t: 1_000_000 };
  const srv = await TestServer.open({ authFailLimit: { burst: 3, perSec: 0.1 }, ...o }, { now: () => clock.t });
  cleanup.push(() => srv.stop());
  // Every token lookup, to show a refused request makes none.
  let lookups = 0;
  const find = srv.app.repo.sessions.findByTokenHash.bind(srv.app.repo.sessions);
  srv.app.repo.sessions.findByTokenHash = (...a: Parameters<typeof find>) => (lookups++, find(...a));
  // The hosted MCP's access-token lookup too.
  const restoreFindActiveAccess = stubAuthRead(srv.app.repo, "findActiveAccess", access => (...a) => (lookups++, access(...a)));
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
const hostedToken = async (srv: TestServer) => (await issueOAuth(srv.app.repo, srv.app.oauth.resource, A, ["grayboard:tools"], Date.now(), OPENCODE_CLIENT)).token;
const audit = (srv: TestServer, action: string) => accessAudits(srv, action);

const X = "198.51.100.1";
const Y = "198.51.100.2";

test("burst refused tokens on a route are refused 401; the next gets 429 with a wait, before any token lookup", async () => {
  const { srv, lookups } = await serve();
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
  const { srv } = await serve();
  const alice = await srv.login(A);
  const hosted = await hostedToken(srv);
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", `bad${i}`, X);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
  expect((await get(srv, "/healthz", null, X)).status).toBe(429);
  expect((await mcpList(srv, hosted, X)).status).toBe(429);
  expect((await get(srv, "/api/whoami", alice, Y)).status).toBe(200);
  expect((await mcpList(srv, hosted, Y)).status).toBe(200);
});

test("valid traffic, hosted MCP included, 403s, 404s and requests with no token never spend; a refused token on any path does", async () => {
  const { srv } = await serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  const alice = await srv.login(A);
  const hosted = await hostedToken(srv);
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
  const { srv } = await serve();
  const devLogin = (from: string) => fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": from, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ email: A }) });
  // A cross-origin form post: text/plain needs no preflight.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": X }, body: JSON.stringify({ email: A }) });
    expect(r.status).toBe(415);
    expect(await r.json()).toEqual({ code: "unsupported_media_type", message: "sign-in takes Content-Type: application/json" });
  }
  expect(srv.app.authGate.size).toBe(0);
  // A remote client (behind the trusted loopback proxy) is refused dev
  // sign-in (security audit F-04), and each refusal is still charged.
  for (let i = 0; i < 3; i++) expect((await devLogin(X)).status).toBe(403);
  expect((await devLogin(X)).status).toBe(429);
  // The audit's address is the resolved one, not the raw header.
  expect((await audit(srv, "auth.dev_login_refused")).map((r) => r.detail.ip)).toEqual([X, X, X]);
  expect(await audit(srv, "auth.login")).toEqual([]);
  // A client on the host signs in, its address audited.
  expect((await devLogin("127.0.0.5")).status).toBe(200);
  expect((await audit(srv, "auth.login")).map((r) => r.detail.ip)).toEqual(["127.0.0.5"]);

  const off = await serve({ devAuth: false, googleClientSecret: "s", publicUrl: "https://grayboard.example.com" });
  const r = (from: string) => fetch(`${off.srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": from }, body: "{}" });
  for (let i = 0; i < 5; i++) expect((await r(X)).status).toBe(404);
  expect(off.srv.app.authGate.size).toBe(0);
});

test("behind the trusted loopback each X-Forwarded-For has its own bucket, trusted hops skipped; with none trusted it's ignored", async () => {
  const { srv } = await serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  expect((await get(srv, "/api/whoami", "bad0", `6.6.6.6, ${X}, 127.0.0.1`)).status).toBe(401);
  expect((await get(srv, "/api/whoami", "bad1", X)).status).toBe(429);
  expect((await get(srv, "/api/whoami", "bad2", Y)).status).toBe(401);
  expect((await audit(srv, "auth.rate_limited")).map((r) => r.target)).toEqual([X]);

  const none = await serve({ authFailLimit: { burst: 1, perSec: 0.1 }, trustedProxies: [] });
  expect((await get(none.srv, "/api/whoami", "bad0", X)).status).toBe(401);
  expect((await get(none.srv, "/api/whoami", "bad1", Y)).status).toBe(429);
  // Both keyed by the peer, whichever loopback address it was.
  const targets = (await audit(none.srv, "auth.rate_limited")).map((r) => r.target);
  expect(targets).toHaveLength(1);
  expect([X, Y]).not.toContain(targets[0]);
});

// #274: through startServer, an IPv6 X-Forwarded-For spends its /64 and its
// /48, on the auth gate and on the OAuth routes (app.ts passes caller.site).
test("IPv6 /64s rotating under one /48 drain it on the auth gate and the OAuth routes; another /48 is unaffected", async () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { srv } = await serve({ authFailLimit: { burst: 1, perSec: 0.001 }, oauthLimit: { burst: 1, perSec: 0.001 } });
    const v6 = (site: number, net: number) => `2001:db8:${site}:${net}::1`;
    // Auth gate: the /48 holds 4, so four /64s each fail once and the fifth is refused before any lookup.
    for (let net = 0; net < 4; net++) expect((await get(srv, "/api/whoami", `bad${net}`, v6(1, net))).status).toBe(401);
    const refused = await get(srv, "/api/whoami", "bad9", v6(1, 9));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { message: string }).message).toContain("this network (/48)");
    expect((await get(srv, "/api/whoami", "bad9", v6(2, 9))).status).toBe(401);
    expect((await audit(srv, "auth.rate_limited")).map((r) => r.target)).toEqual(["2001:db8:1::/48"]);
    // OAuth: a browser route from four /64s of /48 3 spends its OAuth /48 sibling; the fifth is refused.
    const browse = (from: string) => fetch(`${srv.base}/oauth/unknown`, { headers: { "X-Forwarded-For": from } }).then((r) => r.status);
    for (let net = 0; net < 4; net++) expect(await browse(v6(3, net))).not.toBe(429);
    expect(await browse(v6(3, 9))).toBe(429);
    expect(await browse(v6(4, 9))).not.toBe(429);
    const oauthScopes = (await audit(srv, "oauth.rate_limited")).map((r) => [r.target, (r.detail as { scope: string }).scope]);
    expect(oauthScopes).toEqual([["2001:db8:3::/48", "site"]]);
  } finally {
    err.mockRestore();
  }
});

test("a run of refusals writes one row and one log line at its start and one at its end", async () => {
  const { srv, clock } = await serve();
  // The limiter's own lines, out of everything else the server logs (#277).
  const err = spyOn(console, "error");
  cleanup.push(() => err.mockRestore());
  const logged = () => err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("rate-limit"));
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", `bad${i}`, X);
  for (let i = 0; i < 4; i++) expect((await get(srv, "/api/claims", "bad", X)).status).toBe(429);
  expect(logged()).toEqual([`[grayboard] rate-limiting ${X} after repeated authentication failures`]);
  const started = await audit(srv, "auth.rate_limited");
  expect(started.length).toBe(1);
  expect(started[0]!.actor).toBeNull();
  expect(started[0]!.target).toBe(X);
  // Stamped by the server's clock, the one the limiter runs on (#297).
  expect(started[0]!.at).toBe(clock.t);
  // What tripped the limit, and the failure that drained the bucket (#240 audit item 8).
  expect(started[0]!.detail).toEqual({
    addr: X, path: "/api/claims", retry_after_ms: 10_000,
    last_failure: { addr: X, path: "/api/whoami", reason: "refused token", ua: expect.any(String) },
  });
  expect(await audit(srv, "auth.rate_limit_ended")).toEqual([]);
  // Refilled (30s at 0.1/s), seen by the heartbeat's sweep.
  clock.t += 30_000;
  srv.app.sweepLimits();
  const ended = await audit(srv, "auth.rate_limit_ended");
  expect(ended.length).toBe(1);
  expect(ended[0]!.target).toBe(X);
  expect(ended[0]!.at).toBe(clock.t);
  expect(logged()).toEqual([
    `[grayboard] rate-limiting ${X} after repeated authentication failures`,
    `[grayboard] ${X} no longer rate-limited; 4 refused`,
  ]);
  expect(ended[0]!.detail).toEqual({ refused: 4 });
  expect(srv.app.authGate.size).toBe(0);
});

test("a stale token looping from a shared address is answered from memory: one lookup, one charge, and its neighbours are never limited (#923)", async () => {
  const { srv, clock, lookups } = await serve();
  const alice = await srv.login(A);
  for (let i = 0; i < 100; i++) {
    const r = await get(srv, "/api/whoami", "stale", X);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ code: "unauthenticated", message: "invalid or missing token" });
  }
  expect(lookups()).toBe(1);
  expect(srv.app.authGate.refusedSize).toBe(1);
  expect(await audit(srv, "auth.rate_limited")).toEqual([]);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
  // Remembered per path: the same token elsewhere is looked up and charged again.
  expect((await get(srv, "/api/claims", "stale", X)).status).toBe(401);
  expect(srv.app.authGate.refusedSize).toBe(2);
  expect(lookups()).toBe(3);  // the stale token on each path, and alice's valid one
  // Once forgotten it's looked up and charged again, one token a minute, under any allowed refill.
  clock.t += REFUSED_TOKEN_TTL_MS;
  expect((await get(srv, "/api/whoami", "stale", X)).status).toBe(401);
  expect(lookups()).toBe(4);
  // The heartbeat's sweep drops expired entries.
  clock.t += REFUSED_TOKEN_TTL_MS;
  srv.app.sweepLimits();
  expect(srv.app.authGate.refusedSize).toBe(0);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
  // Distinct bad tokens still drain the bucket, as a scan does.
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", `scan${i}`, X);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
  // A remembered token still gets its 401, not the 429, uncharged.
  expect((await get(srv, "/api/whoami", "scan0", X)).status).toBe(401);
});

test("a stale token sent in parallel stays one entry; the same token in another shape or query is its own entry", async () => {
  const { srv } = await serve();
  const alice = await srv.login(A);
  const all = await Promise.all(Array.from({ length: 6 }, () => get(srv, "/api/whoami", "stale", X)));
  expect(all.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  expect(srv.app.authGate.refusedSize).toBe(1);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
  // A refusal of a mangled header or an extra query never shadows the token as sent correctly.
  expect((await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: `Bearer  ${alice}`, "X-Forwarded-For": Y } })).status).toBe(200);
  expect((await get(srv, "/api/whoami?x=1", "stale", X)).status).toBe(401);
  expect(srv.app.authGate.refusedSize).toBe(2);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
});

test("a hosted MCP refusal is replayed with its WWW-Authenticate, so an OAuth client still re-authorizes", async () => {
  const { srv, lookups } = await serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  const stale = "s".repeat(43);
  const first = await mcpList(srv, stale, X);
  expect(first.status).toBe(401);
  const challenge = first.headers.get("www-authenticate");
  expect(challenge).toContain("resource_metadata=");
  const body = await first.text();
  const before = lookups();
  expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) {
    const r = await mcpList(srv, stale, X);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(challenge);
    expect(await r.text()).toBe(body);
  }
  expect(lookups()).toBe(before);
  // The one charge spent a burst of one: a new bad token from X is limited, the stale one isn't.
  expect((await mcpList(srv, "t".repeat(43), X)).status).toBe(429);
  expect((await mcpList(srv, stale, X)).status).toBe(401);
});

test("a CLI command on a limited address prints the server's wait", async () => {
  const srv = await TestServer.open({ authFailLimit: { burst: 1, perSec: 0.1 } });
  cleanup.push(() => srv.stop());
  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "credentials");
  writeFileSync(creds, JSON.stringify({ session_token: "stale", server: srv.base, user_email: A }));
  await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: "Bearer bad" } });
  const r = await runCli(["team", "list"], { env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds }) });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/Error \(rate_limited\): too many authentication failures from this address; retry in \d+s/);
}, 20_000);
