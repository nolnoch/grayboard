import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./app.ts";

import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META, sessionContext } from "./hosted.ts";

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

for (const expired of [false, true]) test(`actual server restart restores or expires live graph, expired=${expired}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-restart-"));
  const config = { dbPath: join(dir, "bus.db"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://restart.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES };
  let app: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer(config, { hostname, background: false });
    const issued = issueOAuth(app.repo, app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
    const principal = app.oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${issued.token}` } }));
    if (principal instanceof Response) throw new Error("fixture unauthorized");
    const context = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
    await app.mcp.sessions.bind(principal, context, { name: "be", create: true });
    await app.mcp.sessions.register(principal, context, "child");
    const lease = await app.mcp.delivery.open(principal, context);
    if (expired) app.db.exec("UPDATE hosted_sessions SET lease_deadline=1");
    await app.stop(); app = undefined;
    app = startServer(config, { hostname, background: false });
    const rows = app.repo.hosted.all();
    if (expired) {
      expect(rows).toEqual([]);
      expect(app.db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_events WHERE event='released' AND detail='expired'").get()?.count).toBe(1);
      app.mcp.sessions.sweep();
      expect(app.repo.hosted.all()).toEqual([]);
    } else {
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.ownership_id === lease.ownership)).toBe(true);
      expect(rows.find(row => !row.root_session_id)?.lease_deadline).toBe(lease.expiresAt);
      expect(app.application.hostedHolder("you@example.com/be")).toBeDefined();
      expect(app.db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_events WHERE event='bound'").get()?.count).toBe(1);
      expect((await app.mcp.delivery.open(principal, context)).ownership).toBe(lease.ownership);
    }
  } finally { await app?.stop(); rmSync(dir, { recursive: true, force: true }); }
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
