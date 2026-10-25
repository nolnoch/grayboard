// The per-address limit on authentication failures (#240), and the plugin
// client's side of it: it stops retrying a refused token, and waits out a
// limited address instead of hammering it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mintSessionKey } from "../../src/core/bindings.ts";
import { GrayboardClient } from "../../src/plugin/client.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

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

// An upgrade attempt from `from` (an X-Forwarded-For, believed from the
// loopback peer by default), as fetch sees it: refusals come back as bodies.
const upgrade = (srv: TestServer, token: string | null, from: string) =>
  fetch(`${srv.base}/ws`, {
    headers: { Upgrade: "websocket", Connection: "Upgrade", "X-Forwarded-For": from, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
const get = (srv: TestServer, path: string, token: string | null, from: string) =>
  fetch(`${srv.base}${path}`, { headers: { "X-Forwarded-For": from, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
const audit = (srv: TestServer, action: string) =>
  srv.app.db.query(`SELECT actor, target, detail FROM access_log WHERE action = ?`).all(action) as { actor: string | null; target: string; detail: string }[];

const X = "198.51.100.1";
const Y = "198.51.100.2";

test("burst bad upgrades are refused 401; the next gets 429 with a wait, before any token lookup", async () => {
  const { srv, lookups } = serve();
  for (let i = 0; i < 3; i++) expect((await upgrade(srv, `bad${i}`, X)).status).toBe(401);
  expect(lookups()).toBe(3);
  const r = await upgrade(srv, "bad", X);
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("10");
  expect(await r.json()).toEqual({ code: "rate_limited", message: "too many authentication failures from this address; retry in 10s", retry_after_ms: 10_000 });
  expect(lookups()).toBe(3);
  // A missing token costs the same as a bad one.
  expect((await upgrade(srv, null, Y)).status).toBe(401);
  expect(srv.app.authGate.size).toBe(2);
});

test("a limited address is refused everything, a valid token and /healthz too; another address isn't", async () => {
  const { srv } = serve();
  const alice = await srv.login(A);
  for (let i = 0; i < 3; i++) await get(srv, "/api/whoami", "bad", X);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
  expect((await get(srv, "/healthz", null, X)).status).toBe(429);
  expect((await srv.client(alice, null, { headers: { "X-Forwarded-For": X } }).connect().catch((e: Error) => e.message))).toMatch(/socket/);
  expect((await get(srv, "/api/whoami", alice, Y)).status).toBe(200);
  expect((await srv.client(alice, null, { headers: { "X-Forwarded-For": Y } }).connect()).type).toBe("hello_ok");
});

test("valid traffic, 403s and 404s never spend; a 401 on any path does", async () => {
  const { srv } = serve({ authFailLimit: { burst: 1, perSec: 0.1 } });
  const alice = await srv.login(A);
  for (let i = 0; i < 5; i++) {
    expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
    expect((await srv.client(alice, null, { headers: { "X-Forwarded-For": X } }).connect()).type).toBe("hello_ok");
    // Not an admin, and no such route.
    expect((await fetch(`${srv.base}/api/admin/users`, { method: "POST", headers: { Authorization: `Bearer ${alice}`, "X-Forwarded-For": X }, body: "{}" })).status).toBe(403);
    expect((await get(srv, "/api/nothing-here", alice, X)).status).toBe(404);
  }
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(200);
  // An unknown path isn't a public route, so requireAuth answers it: a bad token is a 401, charged by chargeIf401.
  expect((await get(srv, "/api/nothing-here", "bad", X)).status).toBe(401);
  expect((await get(srv, "/api/whoami", alice, X)).status).toBe(429);
});

test("sign-in calls are charged on entry; dev-login with dev auth off is a 404 and isn't", async () => {
  const { srv } = serve();
  const devLogin = (from: string) => fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "X-Forwarded-For": from }, body: JSON.stringify({ email: A }) });
  for (let i = 0; i < 3; i++) expect((await devLogin(X)).status).toBe(200);
  expect((await devLogin(X)).status).toBe(429);
  // The audit's address is the resolved one, not the raw header.
  const logins = audit(srv, "auth.login").map((r) => JSON.parse(r.detail).ip);
  expect(logins.slice(-3)).toEqual([X, X, X]);

  const off = serve({ devAuth: false, googleClientSecret: "s" });
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
  expect(JSON.parse(started[0]!.detail)).toEqual({ path: "/api/claims", retry_after_ms: 10_000 });
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

const HELLO_OK = { type: "hello_ok", identity_full: `${A}/fe`, user_email: A, teams: [] };

// A stand-in server that accepts only the token `good()` names: anything
// else gets `refuse()` on the upgrade and on /api/whoami. Records when each
// upgrade attempt and probe came.
function stub(good: () => string, refuse: () => Response) {
  const upgrades: number[] = [];
  const whoami: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const ok = req.headers.get("authorization") === `Bearer ${good()}`;
      if (new URL(req.url).pathname === "/api/whoami") {
        whoami.push(Date.now());
        return ok ? Response.json({}) : refuse();
      }
      upgrades.push(Date.now());
      if (ok && server.upgrade(req)) return;
      return refuse();
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") ws.send(JSON.stringify({ req_id: m.req_id, ...HELLO_OK }));
      },
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://localhost:${server.port}`, upgrades, whoami, server };
}

const unauthenticated = () => Response.json({ code: "unauthenticated", message: "invalid token" }, { status: 401 });

test("after a confirmed 401 a running client stops retrying, and reconnects at once on a new token or after the slow retry", async () => {
  let valid = "t1";
  let token = "t1";
  const s = stub(() => valid, unauthenticated);
  const c = new GrayboardClient(s.url, () => token, "fe", mintSessionKey(), async () => {}, async () => {}, true, undefined, { tokenPollMs: 50, signedOutRetryMs: 3000 });
  cleanup.push(() => c.close());
  c.connect();
  await c.ready();

  // The token is revoked and the connection drops: one reconnect (after the
  // 1s backoff) is refused, and the probe confirms it.
  valid = "t2";
  (c as any).ws.close();
  await until(() => s.whoami.length === 1, 3000);
  const refusedAt = s.upgrades.length;
  // The slow retry tries the old token once more, and is refused again; the
  // backoff alone would have tried after 2s.
  await until(() => s.whoami.length === 2, 4000);
  expect(s.upgrades.length).toBe(refusedAt + 1);
  expect(s.whoami[1]! - s.whoami[0]!).toBeGreaterThanOrEqual(2900);

  // A new sign-in is seen at the next look (50ms), not at the slow retry.
  const t = Date.now();
  token = "t2";
  await c.ready();
  expect(Date.now() - t).toBeLessThan(1000);
}, 10_000);

const limited = (ms: number) => () => Response.json({ code: "rate_limited", message: "too many authentication failures from this address; retry in 1s", retry_after_ms: ms }, { status: 429 });

test("on a limited address the client waits at least its own backoff, keeps doubling it, and says which limit", async () => {
  let open = false;
  // The server asks for only 100ms each time.
  const s = stub(() => (open ? "t" : "never"), limited(100));
  const c = new GrayboardClient(s.url, () => "t", "fe", mintSessionKey(), async () => {}, async () => {});
  cleanup.push(() => c.close());
  c.connect();
  await until(() => c.rateLimited(), 2000);
  expect(c.rateLimited()).toMatchObject({ what: "this address after repeated authentication failures", message: "too many authentication failures from this address; retry in 1s" });
  await until(() => s.upgrades.length === 3, 5000);
  // 1s, then 2s: the floor is the backoff, which a 429 never resets.
  expect(s.upgrades[1]! - s.upgrades[0]!).toBeGreaterThanOrEqual(1000);
  expect(s.upgrades[2]! - s.upgrades[1]!).toBeGreaterThanOrEqual(2000);
  open = true;
  await c.ready();
  expect(c.rateLimited()).toBeNull();
}, 15_000);

test("at startup a limited address is waited out when the retry fits the window, and named when it doesn't", async () => {
  // Real time: the login spends one token and the bad call the other.
  const fits = new TestServer({ authFailLimit: { burst: 2, perSec: 4 } });
  cleanup.push(() => fits.stop());
  const alice = await fits.login(A);
  expect((await fetch(`${fits.base}/api/whoami`, { headers: { Authorization: "Bearer bad" } })).status).toBe(401);
  expect((await fetch(`${fits.base}/api/whoami`)).status).toBe(429);
  const s = await fits.session(alice, "fe", { BUS_TEST_HELLO_MS: "300", BUS_TEST_HELLO_LIMITED_MS: "4000" });
  expect(s.c.getInstructions()).toContain(`identity "fe"`);

  const stuck = new TestServer({ authFailLimit: { burst: 2, perSec: 0.1 } });
  cleanup.push(() => stuck.stop());
  const bob = await stuck.login("bob@example.com");
  await fetch(`${stuck.base}/api/whoami`, { headers: { Authorization: "Bearer bad" } });
  await expect(stuck.session(bob, "fe", { BUS_TEST_HELLO_MS: "300", BUS_TEST_HELLO_LIMITED_MS: "1000" })).rejects.toThrow(/rate-limiting this address after repeated authentication failures \(too many authentication failures from this address; retry in \d+s\)/);
}, 20_000);

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
