import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { hashToken } from "./auth.ts";
import { createApplication } from "./application.ts";
import { openDatabase } from "./db.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { hostedPause } from "../../tests/support/hosted-pause.ts";
import { transactionProcess } from "../../tests/support/transaction-process.ts";

let dir: string, now: number;
let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
let delivery: ReturnType<typeof createDelivery>;
const resource = "https://grayboard.example/mcp";
const context = (p: OAuthPrincipal, raw = "root") => sessionContext(p, { [OPENCODE_SESSION_META]: raw });
function open() {
  database = openDatabase(join(dir, "bus.db"), { blobDir: join(dir, "blobs") });
  application = createApplication(database.repo, database.db);
  const isAuthorized = (p: OAuthPrincipal) => database.repo.oauth.isGrantActive(p.grantId, now);
  hosted = createHostedSessions(application, { now: () => now, isAuthorized });
  delivery = createDelivery(hosted, { isAuthorized });
}
function close() { delivery.close(); hosted.close(); application.stopExpiry(); database.db.close(); }
function issue(email = "you@example.com") {
  const issued = issueOAuth(database.repo, resource, email, ["grayboard:tools", "grayboard:delivery"], now, OPENCODE_CLIENT);
  const principal: OAuthPrincipal = { authed: issued.authed, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: issued.grantId, accessHash: hashToken(issued.token), accessExpiry: issued.tokens.accessExpiresAt, scopes: ["tools", "delivery"] };
  return { ...issued, principal };
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gb-hosted-durable-")); now = Date.now(); open(); });
afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });
const releases = () => database.db.query<{ detail: string }, []>("SELECT detail FROM binding_events WHERE event='released'").all();

async function overlap(first: Record<string, unknown>, second: Record<string, unknown>, pause: string) {
  delivery.close(); hosted.close(); application.stopExpiry();
  const release = join(dir, "release-transaction");
  const start = (operation: Record<string, unknown>, point: string) => transactionProcess("tests/support/hosted-operation.ts", [join(dir, "bus.db"), join(dir, "blobs"), JSON.stringify({ now, ...operation })], point, release);
  const workers = [start(first, pause), start(second, "")];
  try {
    await Promise.all(workers.map(w => w.wait("READY")));
    workers[0]!.proc.stdin.end();
    await workers[0]!.wait(`test pause hit: ${pause}`);
    workers[1]!.proc.stdin.end();
    await workers[1]!.wait("OPERATING");
    await Bun.write(release, "release");
    await Promise.all(workers.map(async w => { expect(await w.proc.exited).toBe(0); await w.done; }));
    return workers.map(w => JSON.parse(w.output().trim().split("\n").at(-1)!));
  } finally {
    await Bun.write(release, "release");
    for (const w of workers) { w.proc.kill(); await w.proc.exited; }
  }
}

for (const revokeFirst of [false, true]) test(`forced attachment/revoke transaction overlap, revoke first=${revokeFirst}`, async () => {
  const first = issue(), second = issue();
  await hosted.bind(first.principal, context(first.principal), { name: "fe", create: true });
  await hosted.register(first.principal, context(first.principal), "child");
  const attach = { operation: "bind", principal: second.principal };
  const revoke = { operation: "revoke", principal: second.principal, refreshHash: hashToken(second.refreshToken) };
  const results = await overlap(revokeFirst ? revoke : attach, revokeFirst ? attach : revoke, revokeFirst ? "hosted:revoke:in-txn" : "hosted:attach:in-txn");
  if (revokeFirst) {
    expect(results[1]).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(database.repo.hosted.all().every(row => row.grant_id === first.grantId)).toBe(true);
    expect(releases()).toEqual([]);
  } else {
    expect(results.every(result => result.ok)).toBe(true);
    expect(database.repo.hosted.all()).toEqual([]);
    expect(releases()).toEqual([{ detail: "revoked" }]);
  }
}, 15_000);

test("forced root registration/end overlap cannot leave an orphan child", async () => {
  const { principal } = issue();
  await hosted.bind(principal, context(principal), { name: "fe", create: true });
  const results = await overlap({ operation: "register", principal, child: "child" }, { operation: "end", principal }, "hosted:register:in-txn");
  expect(results.every(result => result.ok)).toBe(true);
  expect(database.repo.hosted.all()).toEqual([]);
  expect(releases()).toHaveLength(1);
}, 15_000);

test("forced expiry/rebind overlap releases only the expired ownership", async () => {
  const { principal } = issue();
  await hosted.bind(principal, context(principal), { name: "fe", create: true });
  const lease = await delivery.open(principal, context(principal));
  const results = await overlap({ operation: "sweep", principal, sweepAt: now + 30_001 }, { operation: "bind", principal }, "hosted:lease-expire:in-txn");
  expect(results.every(result => result.ok)).toBe(true);
  const rows = database.repo.hosted.all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.ownership_id).not.toBe(lease.ownership);
  expect(rows[0]?.name).toBe("fe");
  expect(releases()).toEqual([{ detail: "expired" }]);
}, 15_000);

function external(operation: Record<string, unknown>) {
  const result = Bun.spawnSync([process.execPath, "tests/support/hosted-operation.ts", join(dir, "bus.db"), join(dir, "blobs"), JSON.stringify({ now, ...operation })], { stdin: Buffer.from(""), env: { ...process.env, BUS_TEST_PAUSE: "", BUS_TEST_PAUSE_FILE: "" } });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
}

for (const owning of ["bind", "open", "register"] as const) {
  for (const change of ["convert", "recreate"] as const) test(`owning ${owning} refuses external ${change} before its transaction`, async () => {
    const first = issue(), second = issue(), p = second.principal;
    await hosted.whoami(first.principal, context(first.principal));
    if (owning === "open") await hosted.bind(first.principal, context(first.principal), { name: "fe", create: true });
    const id = (context(p) as { id: string }).id;
    const old = database.repo.hosted.get(id)!;
    const operation = () => owning === "bind" ? hosted.bind(p, context(p), { name: "new", create: true })
      : owning === "open" ? delivery.open(p, context(p)) : hosted.register(p, context(p), "new-child");
    const point = owning === "register" ? "hosted:register:before-txn" : "hosted:owning:before-txn";
    await expect(hostedPause(point, operation, async () => {
      if (change === "convert") {
        if (owning === "open") expect(external({ operation: "end", principal: first.principal }).ok).toBe(true);
        expect(external({ operation: "register", rawSession: "parent", child: "root", principal: first.principal }).ok).toBe(true);
      } else {
        expect(external({ operation: "end", principal: first.principal }).ok).toBe(true);
        expect(external({ operation: "bind", name: "be", principal: first.principal }).ok).toBe(true);
      }
    })).rejects.toBeDefined();
    const fresh = database.repo.hosted.get(id)!;
    expect(fresh.ownership_id).not.toBe(old.ownership_id);
    expect(fresh.grant_id).toBe(first.grantId);
    expect(fresh.name).toBe(change === "convert" ? null : "be");
    expect(database.repo.aliases.find(`${p.authed.user_email}/new`)).toBeUndefined();
    expect(database.repo.hosted.all().some(row => row.source_session_id === "new-child")).toBe(false);
    expect(delivery.activeLeaseCount).toBe(0);
  });
}

test("registration before bind/open preserves the graph and never extends a sticky deadline", async () => {
  const { principal: p } = issue();
  await hosted.register(p, context(p), "first");
  const id = (context(p) as { id: string }).id;
  const ownership = database.repo.hosted.get(id)!.ownership_id;
  await hosted.bind(p, context(p), { name: "fe", create: true });
  const lease = await delivery.open(p, context(p));
  now += 20_000;
  await hosted.register(p, context(p), "second");
  await hosted.register(p, context(p), "first");
  expect(database.repo.hosted.get(id)).toMatchObject({ ownership_id: ownership, lease_deadline: lease.expiresAt, last_seen_at: now });
  expect(database.repo.hosted.all()).toHaveLength(3);
  now = lease.expiresAt + 1;
  hosted.sweep();
  expect(database.repo.hosted.all()).toHaveLength(0);
});

test("successful new and idempotent registration refresh activity but refusals do not", async () => {
  const first = issue(), second = issue(), p = first.principal;
  await hosted.register(p, context(p), "first");
  const id = (context(p) as { id: string }).id;
  now += 899_000;
  await hosted.register(p, context(p), "second");
  expect(database.repo.hosted.get(id)?.last_seen_at).toBe(now);
  now += 899_000;
  await hosted.register(p, context(p), "second");
  expect(database.repo.hosted.get(id)?.last_seen_at).toBe(now);
  const active = now;
  now += 1_001;
  hosted.sweep();
  expect(database.repo.hosted.all()).toHaveLength(3);
  await hosted.bind(p, context(p, "blocked"), { name: "blocked", create: true });
  await expect(hosted.register(second.principal, context(second.principal), "blocked")).rejects.toMatchObject({ code: "child_bound" });
  expect(database.repo.hosted.get(id)?.last_seen_at).toBe(active);
  expect(database.repo.hosted.get(id)?.grant_id).toBe(first.grantId);
  await hosted.end(p, context(p, "blocked"));
  now = active + 900_001;
  hosted.sweep();
  expect(database.repo.hosted.all()).toHaveLength(0);
});

for (const operation of ["revoke", "bind"] as const) {
  test(`external ${operation} before receipt lock cannot consume an issued batch`, async () => {
    const issued = issue(), { principal } = issued;
    await hosted.bind(principal, context(principal), { name: "fe", create: true });
    const lease = await delivery.open(principal, context(principal));
    database.repo.messages.insert("sender@example.com/be", "user", "you@example.com/fe", "must remain", null, false);
    const batch = await delivery.pending(principal, context(principal), lease.capability);
    const receipt = hostedPause("hosted:receipt:before-txn", () => delivery.receipt(principal, context(principal), lease.capability, batch.map(item => item.id)), async () => {
      expect(external({ operation, principal, name: "be", refreshHash: hashToken(issued.refreshToken) }).ok).toBe(true);
    });
    await expect(receipt).rejects.toHaveProperty("code", "not_found");
    expect(database.repo.cursors.directFor("you@example.com/fe")).toBe(0);
  });

  test(`receipt lock precedes external ${operation}, consumes only the authorized batch`, async () => {
    const issued = issue(), { principal } = issued;
    await hosted.bind(principal, context(principal), { name: "fe", create: true });
    const message = database.repo.messages.insert("sender@example.com/be", "user", "you@example.com/fe", "admitted", null, false);
    const results = await overlap({ operation: "receipt", principal }, { operation, principal, name: "be", refreshHash: hashToken(issued.refreshToken) }, "hosted:receipt:in-txn");
    expect(results.every(result => result.ok)).toBe(true);
    expect(database.repo.cursors.directFor("you@example.com/fe")).toBe(message.id);
  }, 15_000);
}

for (const child of [false, true]) test(`external rebind during native dispatch await fences old snapshot, child=${child}`, async () => {
  const { principal } = issue();
  await hosted.bind(principal, context(principal), { name: "fe", create: true });
  if (child) await hosted.register(principal, context(principal), "child");
  let dispatched = false;
  const call = hostedPause("hosted:tool:in-gate", () => hosted.run(principal, context(principal, child ? "child" : "root"), "peer_status", session => {
    dispatched = true;
    return application.call(session, "peer_status", { text: "stale write" });
  }), async () => { expect(external({ operation: "bind", principal, name: "be" }).ok).toBe(true); });
  await expect(call).rejects.toHaveProperty("code", "unbound");
  expect(dispatched).toBe(false);
  expect(database.db.query<{ status: string | null }, [string]>("SELECT status FROM ids WHERE id=?").get((context(principal, child ? "child" : "root") as { id: string }).id)?.status).not.toBe("stale write");
});

test("two restarts retain ownership and deadline; downtime is credited; expiry releases exactly once", async () => {
  const { principal } = issue();
  await hosted.bind(principal, context(principal), { name: "fe", create: true });
  await hosted.register(principal, context(principal), "child");
  const before = await hosted.whoami(principal, context(principal));
  const lease = await delivery.open(principal, context(principal));
  close(); now += 5_000; open();
  expect(await hosted.whoami(principal, context(principal))).toMatchObject(before);
  expect(database.db.query("SELECT address, id FROM alias_holds").all()).toEqual([{ address: "you@example.com/fe", id: (context(principal) as { id: string }).id }]);
  const reopened = await delivery.open(principal, context(principal));
  expect(reopened.ownership).toBe(lease.ownership);
  expect(reopened.capability).not.toBe(lease.capability);
  close(); now += 5_000; open();
  expect(releases()).toEqual([]);
  expect(database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_events WHERE event='bound'").get()?.count).toBe(1);
  // Downtime longer than the TTL doesn't count against the lease (#423)...
  close(); now += 31_000; open();
  expect(releases()).toEqual([]);
  expect(database.repo.hosted.all()).toHaveLength(2);
  // ...but time while the server is up does.
  now += 31_000; hosted.sweep();
  expect(database.repo.hosted.all()).toEqual([]);
  expect(releases()).toEqual([{ detail: "expired" }]);
  close(); open();
  expect(releases()).toEqual([{ detail: "expired" }]);
});

test("G2 ordinary writes do not attach, G1 revoke releases atomically including children", async () => {
  const first = issue(), second = issue();
  await hosted.bind(first.principal, context(first.principal), { name: "fe", create: true });
  await hosted.register(first.principal, context(first.principal), "child");
  await hosted.run(second.principal, context(second.principal), "peer_status", () => true);
  database.repo.oauth.revokeToken(hashToken(first.refreshToken), OPENCODE_CLIENT, now);
  expect(database.repo.hosted.all()).toEqual([]);
  expect(releases()).toEqual([{ detail: "revoked" }]);
  expect(application.hostedHolder("you@example.com/fe")).toBeUndefined();
  await hosted.bind(second.principal, context(second.principal), { name: "fe" });
  expect(await hosted.whoami(second.principal, context(second.principal, "child"))).toHaveProperty("unbound", true);
});

test("successful G2 root registration reattaches once; G1 revoke cannot end it, disable does", async () => {
  const first = issue(), second = issue();
  await hosted.bind(first.principal, context(first.principal), { name: "fe", create: true });
  await hosted.register(first.principal, context(first.principal), "child");
  const lease = await delivery.open(first.principal, context(first.principal));
  await hosted.register(second.principal, context(second.principal), "child");
  expect(delivery.activeLeaseCount).toBe(0);
  await expect(delivery.renew(first.principal, context(first.principal), lease.capability)).rejects.toHaveProperty("code", "not_found");
  expect(database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM access_log WHERE action='hosted.child_registered'").get()?.count).toBe(1);
  expect(database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM access_log WHERE action='hosted.grant_attached'").get()?.count).toBe(1);
  database.repo.oauth.revokeToken(hashToken(first.refreshToken), OPENCODE_CLIENT, now);
  expect(await hosted.whoami(second.principal, context(second.principal))).toHaveProperty("name", "fe");
  expect(releases()).toEqual([]);
  database.repo.users.setDisabled(second.authed.user_id, true);
  expect(database.repo.hosted.all()).toEqual([]);
  expect(releases()).toEqual([{ detail: "disabled" }]);
  expect(application.hostedHolder("you@example.com/fe")).toBeUndefined();
});

test("opening a pre-hosted SQLite schema adds tables without changing users, messages or OAuth", async () => {
  const first = issue();
  database.repo.aliases.create({ scope_kind: "person", scope_ref: first.authed.user_email, name: "fe" }, first.authed.user_email);
  const message = database.repo.messages.insert("you@example.com/fe", "user", "you@example.com/fe", "existing", null, false);
  database.db.exec("DROP TABLE hosted_sessions; DROP TABLE hosted_ownerships;");
  close(); open();
  expect(database.repo.aliases.listForScope("person", first.authed.user_email).map(row => row.name)).toEqual(["fe"]);
  expect(database.repo.oauth.isGrantActive(first.grantId, now)).toBe(true);
  expect(database.db.query<{ body: string }, [number]>("SELECT body FROM messages WHERE id=?").get(message.id)?.body).toBe("existing");
  expect(database.repo.hosted.all()).toEqual([]);
  await hosted.bind(first.principal, context(first.principal), { name: "fe" });
  expect(await hosted.whoami(first.principal, context(first.principal))).toHaveProperty("name", "fe");
});
