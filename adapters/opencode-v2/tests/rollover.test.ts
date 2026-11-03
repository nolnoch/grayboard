// Runs a real grayboard server, so it sits outside tsconfig.json's include (server sources use .ts import paths).
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { OpenCodeController } from "../src/lifecycle.js";
import { fixture } from "./native-fixture.js";
import { until } from "../../../tests/support/until.ts";
import { startServer } from "../../../src/server/app.ts";
import { hashToken } from "../../../src/server/auth.ts";
import { OAUTH_TTL } from "../../../src/server/oauth-types.ts";
import { issueOAuth } from "../../../tests/helpers/oauth.ts";
import { OPENCODE_CLIENT } from "../../../src/server/oauth-config.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../../src/server/client_addr.ts";
import { createBoard, post, subscribe } from "../../../src/core/boards.ts";

const ORIGIN = "https://grayboard.example.com", ROOT = `ses_${"a".repeat(64)}`;

// #472: the server's own 1 s timer closes the subscriber stream when the
// access token expires; OpenCode's refresh lands on the adapter's second
// expiry poll, about 1.5 s after that close, as on prod.
test("a real access-expiry stream close with OpenCode's refresh landing after it keeps the ownership and push delivery (#472)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollover-472-"));
  const app = startServer({ dbPath: join(dir, "bus.db"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: ORIGIN, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false });
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    return url.origin === ORIGIN ? fetch0(new Request(`http://127.0.0.1:${app.server.port}${url.pathname}${url.search}`, req)) : fetch0(req);
  }) as typeof fetch;
  let controller: OpenCodeController | undefined;
  try {
    // The access token expires 3 s from now; OpenCode stamped its stored expiry
    // 300 ms later, when the token response arrived.
    const issued = issueOAuth(app.repo, app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now() - OAUTH_TTL.access + 3_000, OPENCODE_CLIENT);
    const f = fixture();
    f.rotate(issued.token, issued.tokens.accessExpiresAt + 300 - Date.now());
    let expiredPolls = 0, rotation: string | undefined;
    // OpenCode's own refresh: the grant's refresh token rotates, and native MCP stores the new access token.
    const refresh = () => {
      const token = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url"), now = Date.now();
      rotation = app.repo.oauth.rotateRefresh({ clientId: issued.binding.clientId, resource: issued.binding.resource, scopes: issued.binding.scopes, refreshHash: hashToken(issued.refreshToken), tokens: {
        ...issued.tokens, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
      } }, now).status;
      f.rotate(token);
    };
    const sessions = new Map([[ROOT, { id: ROOT, time: {}, metadata: {} as Record<string, unknown> }]]);
    const admitted: string[] = [], states: string[] = [];
    const ctx = { ...f.ctx, location: { directory: dir }, session: {
      get: async ({ sessionID }: { sessionID: string }) => structuredClone(sessions.get(sessionID)),
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => { sessions.get(sessionID)!.metadata = metadata; },
      synthetic: async ({ text }: { text: string }) => { admitted.push(text); },
    } } as unknown as Context;
    controller = new OpenCodeController(ctx, { mcpName: "grayboard" } as ConstructorParameters<typeof OpenCodeController>[1], undefined, undefined, record => {
      states.push(record.state);
      if (record.state === "retrying" && record.code === "native_access_expired" && ++expiredPolls === 2) refresh();
    });
    const root = () => controller!.status().roots.find(r => r.sessionID === ROOT);
    const audits = () => app.db.query<{ action: string; detail: string | null }, []>("SELECT action, detail FROM access_log WHERE action LIKE 'hosted.%' ORDER BY rowid").all().map(r => ({ action: r.action, ...JSON.parse(r.detail ?? "{}") as Record<string, unknown> }));
    const opened = () => audits().filter(a => a.action === "hosted.lease_opened");
    await controller.enroll(ROOT, ["be"], true);
    await until(() => root()?.state === "active", 10_000, "delivery active");
    const ownership = root()!.ownership;
    expect(ownership).toBeGreaterThan(0);
    await until(() => expiredPolls === 2 && root()?.state === "active", 20_000, "delivery back after the rollover");
    expect(rotation).toBe("ok");
    expect(expiredPolls).toBe(2);
    expect(states).not.toContain("paused");
    expect(root()).toMatchObject({ state: "active", ownership });
    const all = audits(), closes = all.filter(a => a.action === "hosted.stream_closed");
    expect(closes.some(a => a.role === "subscriber" && a.ownership === ownership)).toBe(true);
    expect(closes.every(a => a.reason === "access_expired")).toBe(true);
    expect(all.filter(a => a.action === "hosted.lease_closed")).toEqual([]);
    // The reopen found the lease still live and attached it again: never closed, never reopened.
    expect(opened().map(a => [a.ownership, a.reopened])).toEqual([[ownership, false]]);
    // Push delivery still reaches the root.
    const board = createBoard(app.db, "you@example.com/sim", "rollover", "Rollover"); subscribe(app.db, "you@example.com/be", board.name, "push");
    const posted = post(app.db, "you@example.com/sim", board.name, "After the rollover"); app.application.boardsChanged([board.name]); app.application.wake(posted.wake);
    await until(() => admitted.some(text => text.includes("After the rollover")), 10_000, "post admitted after the rollover");
  } finally {
    await controller?.close();
    await app.stop();
    globalThis.fetch = fetch0;
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
