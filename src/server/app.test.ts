import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./app.ts";
import { Database } from "bun:sqlite";
import { until } from "../../tests/support/until.ts";

import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";

const hostname = "127.0.0.1";

for (const trusted of [true, false]) test(`OAuth address limits use the actual app's trusted proxy decision, trusted=${trusted}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-oauth-rate-"));
  let app: ReturnType<typeof startServer> | undefined;
  let clock = Date.now();
  try {
    app = startServer({
      dbPath: ":memory:", blobDir: dir, httpPort: 0,
      googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://rate.example.com",
      messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT,
      trustedProxies: trusted ? DEFAULT_TRUSTED_PROXIES : [], oauthLimit: { burst: 1, perSec: 1 }, oauthGlobalLimit: { burst: 10, perSec: 1 },
    }, { hostname, background: false, oauth: { now: () => clock } });
    const request = (ip: string) => fetch(`http://${hostname}:${app!.server.port}/oauth/unknown?secret=not-for-audit`, { headers: { "X-Forwarded-For": ip } });
    expect((await request("198.51.100.1")).status).toBe(405);
    const refused = await request("198.51.100.1");
    expect(refused.status).toBe(429); expect(refused.headers.get("retry-after")).toBe("1");
    expect((await request("198.51.100.2")).status).toBe(trusted ? 405 : 429);
    expect((await request("198.51.100.1")).status).toBe(429);
    const audit = () => app!.db.query<{ action: string; detail: string }, []>("SELECT action, detail FROM access_log WHERE action LIKE 'oauth.rate%'").all();
    expect(audit()).toHaveLength(1);
    expect(audit()[0]!.detail).toContain('"scope":"address"');
    expect(JSON.stringify(audit())).not.toContain("not-for-audit");
    clock += 1000;
    expect((await request("198.51.100.1")).status).toBe(405);
    expect(audit().filter(row => row.action === "oauth.rate_limit_ended")).toHaveLength(1);
  } finally {
    await app?.stop(); app?.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

const restartConfig = (dir: string) => ({ dbPath: join(dir, "bus.db"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://restart.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES });

// A bound root with a child and an open delivery lease on a real server.
async function leasedRoot(app: ReturnType<typeof startServer>) {
  const issued = issueOAuth(app.repo, app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
  const principal = app.oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${issued.token}` } }));
  if (principal instanceof Response) throw new Error("fixture unauthorized");
  const context = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
  await app.mcp.sessions.bind(principal, context, { name: "be", create: true });
  await app.mcp.sessions.register(principal, context, "child");
  const lease = await app.mcp.delivery.open(principal, context);
  return { principal, context, lease };
}

const restartCredits = (app: ReturnType<typeof startServer>) => app.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action='hosted.lease_restart_credit'").all().map(row => JSON.parse(row.detail));
const serverStarts = (app: ReturnType<typeof startServer>) => app.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action='server.started' ORDER BY id").all().map(row => JSON.parse(row.detail));

// Between the stop and the restart the test rewrites the stopped server's
// liveness and the lease, so a 5- or 20-minute outage costs no wall time (#423).
for (const scenario of ["credited", "capped", "idle", "expired", "no-heartbeat"] as const) test(`actual server restart credits downtime to a live lease: ${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-restart-"));
  const config = restartConfig(dir);
  let app: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer(config, { hostname, background: false });
    const { principal, context, lease } = await leasedRoot(app);
    await app.stop(); app = undefined;
    const alive = Date.now() - (scenario === "idle" ? 20 * 60_000 : 300_000);
    const outage = new Database(config.dbPath);
    try {
      if (scenario === "no-heartbeat") outage.run("DELETE FROM server_state");
      else outage.run("UPDATE server_state SET value = ? WHERE key = 'alive_at'", [alive]);
      if (scenario === "idle") outage.run("UPDATE hosted_sessions SET lease_deadline = NULL, last_seen_at = ? WHERE root_session_id IS NULL", [alive - 60_000]);
      else {
        // credited: 20s left at the last heartbeat; capped: 200s left, more
        // than a TTL past now once credited; no-heartbeat: 20s left now;
        // expired: the lease lapsed while the server was still up.
        const deadline = { credited: alive + 20_000, capped: alive + 200_000, expired: alive - 1, "no-heartbeat": Date.now() + 20_000 }[scenario];
        outage.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE root_session_id IS NULL", [deadline]);
      }
    } finally { outage.close(); }
    const before = Date.now();
    app = startServer(config, { hostname, background: false });
    const after = Date.now();
    const rows = app.repo.hosted.all();
    const credits = restartCredits(app);
    const released = () => app!.db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_events WHERE event='released' AND detail='expired'").get()?.count;
    expect(app.repo.hosted.aliveAt()).toBeGreaterThanOrEqual(before);
    // Every start is audited, credited or not; a fresh database has no heartbeat.
    const starts = serverStarts(app);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual({ alive_at: null, now: expect.any(Number), downtime_ms: null, credited: 0 });
    if (scenario === "no-heartbeat") expect(starts[1]).toEqual({ alive_at: null, now: expect.any(Number), downtime_ms: null, credited: 0 });
    else {
      expect(starts[1]).toEqual({ alive_at: alive, now: expect.any(Number), downtime_ms: starts[1].now - alive, credited: scenario === "expired" ? 0 : 1 });
      expect(starts[1].now).toBeGreaterThanOrEqual(before);
    }
    if (scenario === "expired") {
      expect(rows).toEqual([]);
      expect(credits).toEqual([]);
      expect(released()).toBe(1);
      app.mcp.sessions.sweep();
      expect(released()).toBe(1);
      return;
    }
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ownership_id === lease.ownership)).toBe(true);
    const root = rows.find(row => !row.root_session_id)!;
    if (scenario === "idle") {
      expect(root.lease_deadline).toBeNull();
      expect(root.last_seen_at).toBeGreaterThanOrEqual(before - 60_000);
      expect(root.last_seen_at).toBeLessThanOrEqual(after - 60_000);
      expect(credits).toEqual([{ ownership: lease.ownership, client_id: OPENCODE_CLIENT, field: "last_seen_at", before: alive - 60_000, after: root.last_seen_at, downtime_ms: expect.any(Number) }]);
      expect(credits[0].downtime_ms).toBeGreaterThanOrEqual(before - alive);
    } else {
      const deadline = root.lease_deadline!;
      if (scenario === "credited") {
        expect(deadline).toBeGreaterThanOrEqual(before + 20_000);
        expect(deadline).toBeLessThanOrEqual(after + 20_000);
        expect(credits).toEqual([{ ownership: lease.ownership, client_id: OPENCODE_CLIENT, field: "lease_deadline", before: alive + 20_000, after: deadline, downtime_ms: deadline - alive - 20_000 }]);
      } else if (scenario === "capped") {
        expect(deadline).toBeGreaterThanOrEqual(before + 30_000);
        expect(deadline).toBeLessThanOrEqual(after + 30_000);
        expect(credits).toEqual([{ ownership: lease.ownership, client_id: OPENCODE_CLIENT, field: "lease_deadline", before: alive + 200_000, after: deadline, downtime_ms: expect.any(Number) }]);
        expect(credits[0].downtime_ms).toBeGreaterThan(deadline - alive - 200_000);
      } else {
        expect(deadline).toBeLessThanOrEqual(before + 20_000);
        expect(credits).toEqual([]);
      }
    }
    expect(released()).toBe(0);
    expect(app.application.hostedHolder("you@example.com/be")).toBeDefined();
    expect(app.db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_events WHERE event='bound'").get()?.count).toBe(1);
    if (scenario !== "idle") expect((await app.mcp.delivery.open(principal, context)).ownership).toBe(lease.ownership);
  } finally { await app?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a clean stop records its time, so a quick restart credits nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-clean-stop-"));
  const config = restartConfig(dir);
  let app: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer(config, { hostname, background: false });
    await leasedRoot(app);
    const deadline = app.repo.hosted.all().find(row => !row.root_session_id)!.lease_deadline!;
    const stopping = Date.now();
    await app.stop(); app = undefined;
    const stopped = Date.now();
    const outage = new Database(config.dbPath);
    try {
      const alive = outage.query<{ value: number }, []>("SELECT value FROM server_state WHERE key = 'alive_at'").get()!.value;
      expect(alive).toBeGreaterThanOrEqual(stopping);
      expect(alive).toBeLessThanOrEqual(stopped);
    } finally { outage.close(); }
    app = startServer(config, { hostname, background: false });
    expect(app.repo.hosted.all().find(row => !row.root_session_id)!.lease_deadline).toBe(deadline);
    expect(restartCredits(app)).toEqual([]);
  } finally { await app?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a second opener during a credited restart doesn't credit the outage again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-credit-once-"));
  const config = restartConfig(dir);
  let app: ReturnType<typeof startServer> | undefined, second: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer(config, { hostname, background: false });
    await leasedRoot(app);
    await app.stop(); app = undefined;
    const alive = Date.now() - 300_000;
    const outage = new Database(config.dbPath);
    try {
      outage.run("UPDATE server_state SET value = ? WHERE key = 'alive_at'", [alive]);
      outage.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE root_session_id IS NULL", [alive + 20_000]);
    } finally { outage.close(); }
    app = startServer(config, { hostname, background: false });
    const credited = app.repo.hosted.all().find(row => !row.root_session_id)!.lease_deadline!;
    second = startServer(config, { hostname, background: false });
    expect(restartCredits(second)).toEqual([expect.objectContaining({ before: alive + 20_000, after: credited })]);
    expect(second.repo.hosted.all().find(row => !row.root_session_id)!.lease_deadline).toBe(credited);
  } finally { await second?.stop(); await app?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a running server's liveness heartbeat advances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-heartbeat-"));
  const app = startServer(restartConfig(dir), { hostname, background: false });
  try {
    const first = app.repo.hosted.aliveAt()!;
    await until(() => app.repo.hosted.aliveAt()! > first, 5_000);
  } finally { await app.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("an exact-address listener refuses an occupied same-address port", async () => {
  const occupied = Bun.serve({ hostname, port: 0, fetch: () => new Response("other listener") });
  let duplicate: ReturnType<typeof Bun.serve> | undefined;
  let failure: unknown;
  try {
    try {
      duplicate = Bun.serve({ hostname, port: occupied.port, fetch: () => new Response("duplicate") });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await duplicate?.stop(true);
    await occupied.stop(true);
  }
});

test("an explicit startup hostname binds the application's own fixture URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-listener-"));
  const publicUrl = `https://listener-${randomUUID()}.example.com`;
  let app: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer({
      dbPath: ":memory:", blobDir: dir, httpPort: 0,
      googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl,
      messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES,
    }, { hostname, background: false });
    expect(app.server.hostname).toBe(hostname);
    const response = await fetch(`http://${hostname}:${app.server.port}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ issuer: publicUrl });
  } finally {
    try {
      await app?.stop();
    } finally {
      app?.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
