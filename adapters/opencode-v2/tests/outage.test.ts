// Runs a real grayboard server, so it sits outside tsconfig.json's include (server sources use .ts import paths).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire, ServerUnreachable } from "../src/core/wire.js";
import { AccessExpired, accessExpiry } from "../src/core/model.js";
import { failureCode } from "../src/core/diagnostics.js";
import { startServer } from "../../../src/server/app.ts";
import { issueOAuth } from "../../../tests/helpers/oauth.ts";
import { OPENCODE_CLIENT } from "../../../src/server/oauth-config.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../../src/server/client_addr.ts";

test("a server that stops under a live wire surfaces ServerUnreachable on the next call and read (#423)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-423-"));
  const app = startServer({ dbPath: join(dir, "bus.db"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "http://127.0.0.1", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false });
  let stopped = false;
  try {
    const issued = issueOAuth(app.repo, app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
    const url = `http://127.0.0.1:${app.server.port}/mcp`;
    const wire = new Wire({ url, sessionKey: "ai.opencode/sessionID", client: { name: "grayboard-opencode", version: "1.10.0" } }, { token: async () => issued.token }, new AbortController().signal, "ses_root");
    await wire.connect();
    await wire.call("bind", { name: "be", create: true });
    wire.capability = ((await wire.call("delivery_open")) as { capability: string }).capability;
    const subscription = await wire.listen();
    await app.stop(); stopped = true;
    await subscription.closed.catch(() => undefined);
    await expect(wire.call("whoami")).rejects.toBeInstanceOf(ServerUnreachable);
    await expect(wire.read("grayboard://inbox")).rejects.toBeInstanceOf(ServerUnreachable);
  } finally {
    if (!stopped) await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// #424 item 5: the controller's fakes throw native expiry raw or wrapped in a `cause`; this drives a real connect.
// On SDK 2.4.0 the token provider runs outside the version probe's fetch, so the expiry arrives unwrapped;
// accessExpiry() (what the controller classifies with) finds it either way.
test("a real connect whose token provider finds the native token expired surfaces that expiry, not an outage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-424-"));
  const app = startServer({ dbPath: join(dir, "bus.db"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "http://127.0.0.1", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false });
  try {
    const expired = new AccessExpired("OpenCode", "reconnect or sign in using OpenCode", "expired");
    const url = `http://127.0.0.1:${app.server.port}/mcp`;
    const wire = new Wire({ url, sessionKey: "ai.opencode/sessionID", client: { name: "grayboard-opencode", version: "1.10.0" } }, { token: async () => { throw expired; } }, new AbortController().signal, "ses_root");
    const error = await wire.connect().then(() => undefined, e => e);
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ServerUnreachable);
    expect(accessExpiry(error)).toBe(expired);
    expect(failureCode(error)).toBe("native_access_expired");
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
