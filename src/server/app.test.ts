import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./app.ts";

const hostname = "127.0.0.1";

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
      messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [],
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
