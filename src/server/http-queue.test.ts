// #807 P1b-4c: the CLI's HTTP routes and the session touch write through the server's write queue (D4). A request
// that arrives while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createTouchQueue, hashToken, verifySessionToken } from "./auth.ts";
import { queueFor } from "./store/queue.ts";
import { TestServer } from "../../tests/support/server.ts";
import { handleHttp } from "./http.ts";
import type { Config } from "./config.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { until } from "../../tests/support/until.ts";
import { seed } from "../../tests/support/seed.ts";
import { registerId } from "../core/boards.ts";
import { runRetention } from "./retention.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function hold(db: object): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  return { release, done };
}

test("#807: a session touch that fires while another body holds the write queue waits behind it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-touch-"));
  const { db, repo } = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
  const touches = createTouchQueue();
  cleanups.push(() => touches.cancelAll());
  const session = await seed(repo, async tx => {
    const user = await repo.users.upsertByEmail(tx, "you@example.com", null);
    const created = await repo.sessions.create(tx, user.id, hashToken("raw-token"), "test");
    db.run("UPDATE sessions SET last_used_at = 0 WHERE id = ?", [created.id]);
    return created;
  });
  const lastUsed = async () => (await repo.sessions.findById(repo.read, session.id))!.last_used_at;
  const touched = spyOn(repo.sessions, "touch");
  const holder = hold(db);
  expect(await verifySessionToken("raw-token", repo, touches, 0)).not.toBeNull();
  await new Promise(r => setImmediate(r)); // the scheduled touch fires
  await new Promise(r => setImmediate(r));
  expect(touched).not.toHaveBeenCalled();
  holder.release();
  await holder.done;
  await until(() => touched.mock.calls.length > 0, 5000, "the touch ran after the holder released");
  expect(await lastUsed()).toBeGreaterThan(0);
  touched.mockRestore();
});

test("#807: a team route that arrives while another body holds the write queue waits, then writes in its own transaction", async () => {
  const srv = new TestServer();
  cleanups.push(() => srv.stop());
  const token = await srv.login("you@example.com");
  const write = spyOn(srv.app.repo, "write");
  const holder = hold(srv.app.db);
  const created = srv.api(token, "POST", "/api/teams", { name: "core" });
  await until(() => write.mock.calls.length > 0, 5000, "the team route reached the write queue");
  expect((await srv.app.repo.teams.findByName(srv.app.repo.read, "core"))).toBeFalsy();
  holder.release();
  await holder.done;
  expect(await created).toMatchObject({ status: 201, body: { name: "core" } });
  expect((await srv.app.repo.teams.findByName(srv.app.repo.read, "core"))).toBeTruthy();
  write.mockRestore();
});

for (const [route, action] of [["revoke-session", "auth.session_revoked"], ["disable-user", "auth.user_disabled"]] as const) {
  test(`#807: an admin ${route} whose transaction rolls back leaves the user's live sessions connected`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-admin-"));
    const { db, repo } = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
    const touches = createTouchQueue();
    cleanups.push(() => touches.cancelAll());
    const config: Config = {
      dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0,
      devAuth: true, publicUrl: "http://localhost", googleClientId: "dev", googleClientSecret: "",
      messageRetentionDays: 90, auditRetentionDays: 90, admins: ["root@example.com"], helloLimit: DEFAULT_HELLO_LIMIT,
      authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, orgDomain: "example.com",
    };
    const disconnected: number[] = [];
    const hooks = { disconnectUser: (id: number) => { disconnected.push(id); }, accessChanged: async () => {} };
    const call = (path: string, body: unknown, token?: string) => handleHttp(
      new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      repo, config, touches, () => {}, undefined, hooks, "127.0.0.1");
    const login = async (email: string) => (await (await call("/api/auth/dev-login", { email })).json() as { session_token: string }).session_token;
    const root = await login("root@example.com");
    const bobToken = await login("bob@example.com");
    // The change lands, then the audit row after it fails: the transaction rolls back.
    const write = repo.audit.write.bind(repo.audit);
    const audit = spyOn(repo.audit, "write").mockImplementation((tx, row) => {
      if (row.action === action) throw new Error("disk full");
      write(tx, row);
    });
    await expect(call(`/api/admin/${route}`, { email: "bob@example.com" }, root)).rejects.toThrow("disk full");
    audit.mockRestore();
    expect(disconnected).toEqual([]);
    const bob = (await repo.users.findByEmail(repo.read, "bob@example.com"))!;
    // Rolled back: no audit row, bob still enabled and signed in.
    expect(await repo.audit.last(repo.read, action, "bob@example.com")).toBeUndefined();
    expect(bob.disabled_at).toBeNull();
    expect((await handleHttp(new Request("http://localhost/api/whoami", { headers: { Authorization: `Bearer ${bobToken}` } }),
      repo, config, touches, () => {}, undefined, hooks, "127.0.0.1")).status).toBe(200);
    const ok = await call(`/api/admin/${route}`, { email: "bob@example.com" }, root);
    expect(ok.status).toBe(200);
    expect(disconnected).toEqual([bob.id]);
  });
}

// #807 P1c-15c-1: the claim, identity and team routes reach core's helpers through `repo.coreOn(handle)`: their write
// body's `Tx` inside it, the pool outside (the claim list). P3 B1a: and their binding reads through `repo.bindings`, the same way.
test("#807 P1c-15c-1: claim, identity and team routes reach core on their body's Tx", async () => {
  const srv = new TestServer();
  cleanups.push(() => srv.stop());
  const { repo, db } = srv.app;
  const you = await srv.login("you@example.com"), bob = await srv.login("bob@example.com");
  const checks: { route: string; op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  let route = "";
  const bindingSpies = [repo.bindings, repo.claims].flatMap(group => (Object.keys(group) as (keyof typeof group)[]).map(name => {
    const own = (group[name] as (...a: unknown[]) => unknown).bind(group);
    return spyOn(group, name as never).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push({ route, op: String(name), inTxn: db.inTransaction, handle: r === repo.read ? "pool" : "tx" });
      return own(r, ...rest);
    }) as never);
  }));
  const original = repo.coreOn.bind(repo);
  const spy = spyOn(repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => {
    checks.push({ route, op: "coreOn", inTxn: db.inTransaction, handle: h === repo.read ? "pool" : "tx" });
    return original(h);
  }) as never);
  const call = async (name: string, token: string, method: string, path: string, body?: unknown, status = 200) => {
    route = name;
    expect((await srv.api(token, method, path, body)).status).toBe(status);
  };
  try {
    await call("team create", you, "POST", "/api/teams", { name: "core" }, 201);
    // bob's alias makes the join and leave loops (follow, unsubscribe) run.
    await call("bob identity", bob, "POST", "/api/identities", { name: "helper" }, 201);
    await call("team add", you, "POST", "/api/teams/core/add", { email: "bob@example.com" });
    await call("identity create", you, "POST", "/api/identities", { name: "agent" }, 201);
    await call("claim call", you, "POST", "/api/claims/call", { as: "agent", tool: "claim_take", args: { key: "k" } });
    // A session-ID `as` reaches ownAddress's ID branch, which reads the `ids` row on the claim call's Tx.
    await seed(repo, tx => { registerId(repo.coreOn(tx), { id: "id:0000000000001", principal: "you@example.com", launcher: false }); });
    await call("claim call as id", you, "POST", "/api/claims/call", { as: "id:0000000000001", tool: "claim_take", args: { key: "j" } });
    await call("claim list", you, "GET", "/api/claims");
    await call("identity delete", you, "DELETE", "/api/identities/agent");
    await seed(repo, tx => repo.aliases.create(tx, { scope_kind: "team", scope_ref: "core", name: "bot" }, "you@example.com"));
    await call("team delete-alias", you, "POST", "/api/teams/core/delete-alias", { name: "bot" });
    await call("team remove", you, "POST", "/api/teams/core/remove", { email: "bob@example.com" });
    await call("team add again", you, "POST", "/api/teams/core/add", { email: "bob@example.com" });
    await call("team leave", bob, "POST", "/api/teams/core/leave");
    const inBody = ["team create", "team add", "identity create", "claim call", "claim call as id", "identity delete", "team delete-alias", "team remove", "team leave"];
    // Each in-body route reached core at least once, so the last check isn't vacuous for it.
    expect(inBody.filter(r => !checks.some(c => c.route === r && c.handle === "tx"))).toEqual([]);
    // B2: the claim list reads through repo.claims, on the pool.
    expect(checks.some(c => c.route === "claim list" && c.op === "list" && c.handle === "pool")).toBe(true);
    // B1a: the ID branch's row, the alias-in-use checks and the claim's address set read on the body's Tx.
    // The expiry timer's re-arm (`nextExpiry`) runs detached after a claim call's commit, so its route label is whichever
    // call is current when it lands: it is left out of the per-route reads and must read on the pool, outside any body.
    expect(checks.filter(c => c.op === "nextExpiry" && (c.handle !== "pool" || c.inTxn))).toEqual([]);
    const reads = (r: string) => checks.filter(c => c.route === r && c.op !== "coreOn" && c.op !== "nextExpiry").map(c => `${c.op}:${c.handle}`);
    expect(reads("claim call as id")).toEqual(["idRow:tx", "addressSet:tx"]);
    expect(reads("claim call")).toEqual(["userOf:tx", "addressSet:tx"]);
    expect(reads("identity delete")).toEqual(["userOf:tx"]);
    expect(reads("team delete-alias")).toEqual(["userOf:tx"]);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { spy.mockRestore(); for (const s of bindingSpies) s.mockRestore(); }
});

// #807 P1c-15c-2: the attachment routes and retention reach the store on the handle of their context: a write body's
// `Tx` inside it (the upload's and release's writes, the guarded download's recheck, retention's prunes), the pool
// outside (the download's first access check, the blob sweep's reads). P3 B3: the attachment rows through repo.attachments.
test("#807 P1c-15c-2: attachment routes and retention reach the store on their body's Tx, the pool outside one", async () => {
  const srv = new TestServer();
  cleanups.push(() => srv.stop());
  const { repo, db } = srv.app;
  const you = await srv.login("you@example.com");
  expect((await srv.api(you, "POST", "/api/identities", { name: "agent" })).status).toBe(201);
  const checks: { route: string; op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  let route = "";
  const groupSpies = [repo.attachments, repo.sessionEnd].flatMap(group => (Object.keys(group) as (keyof typeof group)[]).map(name => {
    const own = (group[name] as (...a: unknown[]) => unknown).bind(group);
    return spyOn(group, name as never).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push({ route, op: String(name), inTxn: db.inTransaction, handle: r === repo.read ? "pool" : "tx" });
      return own(r, ...rest);
    }) as never);
  }));
  const original = repo.coreOn.bind(repo);
  const spy = spyOn(repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => {
    checks.push({ route, op: "coreOn", inTxn: db.inTransaction, handle: h === repo.read ? "pool" : "tx" });
    return original(h);
  }) as never);
  try {
    route = "upload";
    const up = await srv.uploadAs(you, "agent", "a.txt", "hello");
    expect(up.status).toBe(201);
    route = "download";
    // A guard makes the download recheck access inside its write body, on that body's Tx.
    expect((await srv.downloadAs(you, "agent", up.body.id as number, () => {})).status).toBe(200);
    route = "release";
    expect((await srv.releaseAs(you, "agent", up.body.id as number)).status).toBe(200);
    route = "retention";
    await runRetention(repo, { ...srv.config, messageRetentionDays: 1, auditRetentionDays: 1 }, Date.now() + 30 * 86_400_000);
    // The download's reach (core's attachmentReach) stays on coreOn until B5a ports the post reads it takes;
    // retention's coreOn body is its post prune; its ended-ID prune goes through repo.sessionEnd (P3 B4a).
    const ops = (r: string) => checks.filter(c => c.route === r).map(c => `${c.op}:${c.handle}`);
    expect(ops("upload")).toEqual(["insertUpload:tx"]);
    expect(ops("download")).toEqual(["coreOn:pool", "get:pool", "coreOn:tx", "get:tx"]);
    expect(ops("release")).toEqual(["dropUnsent:tx", "unnamedBlobs:pool", "named:pool", "dropBlobEntry:tx"]);
    expect(ops("retention")).toEqual(["coreOn:tx", "pruneEnded:tx", "pruneUnbound:tx", "unnamedBlobs:pool"]);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { spy.mockRestore(); for (const s of groupSpies) s.mockRestore(); }
});
