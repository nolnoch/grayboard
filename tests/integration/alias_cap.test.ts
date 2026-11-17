// #347: a scope holds at most the server's aliasScopeCap names, checked on
// every create path a client reaches (bind, a tools-only writes_as, HTTP's
// identity add); an existing name binds at any count; a team owner or an
// admin deletes a team's unused name to free a slot.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { seed } from "../support/seed.ts";

const ROOT = "root@example.com";
const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;
let root: string;

beforeEach(async () => {
  srv = new TestServer({ aliasScopeCap: 2, admins: [ROOT], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login("alice@example.com");
  bob = await srv.login(B);
  root = await srv.login(ROOT);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(async () => {
  await closeSessions();
  await srv.stop();
});

const names = (ref: string) => (srv.app.db.query(`SELECT name FROM aliases WHERE scope_ref = ? ORDER BY name`).all(ref) as { name: string }[]).map((r) => r.name);
const deleted = () => (srv.app.db.query(`SELECT actor, target, detail FROM access_log WHERE action = 'alias.deleted' ORDER BY id`).all() as { actor: string; target: string; detail: string | null }[])
  .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
const subs = (address: string) => srv.app.db.query(`SELECT * FROM subscriptions WHERE handle = ?`).all(address);
const CAPPED = /already has 2 names, the server's cap of 2/;

test("a team at its cap refuses a new name by bind and by writes_as; an existing name still binds", async () => {
  for (const n of ["a", "b"]) {
    const s = srv.appSession(bob, `eng/${n}`);
    await s.connect();
    await s.unbind(`eng/${n}`);
  }
  await expect(srv.appSession(bob, "eng/c").connect()).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/team "eng" already has 2 names.*grayboard team delete-alias eng <name>/) });
  // The refused bind leaves its binding event.
  expect(srv.app.db.query(`SELECT event FROM binding_events WHERE name = 'eng/c'`).all()).toEqual([{ event: "refused" }]);
  await expect(srv.appSession(bob, "eng/c", { push: false }).connect()).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(CAPPED) });
  expect(names("eng")).toEqual(["a", "b"]);
  // A name that exists binds, and is written as, at the cap.
  expect((await srv.appSession(bob, "eng/a").connect()).bind?.alias).toBe("eng/a");
  await srv.appSession(bob, "eng/b", { push: false }).connect();
});

test("a user at the cap is refused a new identity over HTTP; the Slack human is not counted", async () => {
  expect((await srv.api(bob, "POST", "/api/identities", { name: "one" })).status).toBe(201);
  // A human row (as a Slack link makes) neither counts nor is capped.
  await seed(srv.app.repo, tx => srv.app.repo.aliases.create(tx, { scope_kind: "person", scope_ref: B, name: "human" }, B));
  expect((await srv.api(bob, "POST", "/api/identities", { name: "two" })).status).toBe(201);
  const r = await srv.api(bob, "POST", "/api/identities", { name: "three" });
  expect(r).toMatchObject({ status: 400, body: { message: expect.stringMatching(/your scope already has 2 names.*grayboard identity rm <name>/) } });
  // Deleting one frees the slot.
  expect((await srv.api(bob, "DELETE", "/api/identities/one")).status).toBe(200);
  expect((await srv.api(bob, "POST", "/api/identities", { name: "three" })).status).toBe(201);
});

test("a team owner or an admin deletes an unused team name, freeing a slot; a member, a held name and an unknown name are refused", async () => {
  const held = srv.appSession(bob, "eng/a");
  await held.connect();
  const b = srv.appSession(bob, "eng/b");
  await b.connect();
  await b.unbind("eng/b");

  expect(await srv.api(bob, "POST", "/api/teams/eng/delete-alias", { name: "b" })).toMatchObject({ status: 403 });
  const carol = await srv.login("carol@example.com");
  expect(await srv.api(carol, "POST", "/api/teams/eng/delete-alias", { name: "b" })).toMatchObject({ status: 404 });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "human" })).toMatchObject({ status: 400, body: { message: expect.stringContaining("reserved") } });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "x/y" })).toMatchObject({ status: 400, body: { message: "invalid name" } });
  // A tools-only session writing as the name holds it too.
  const writer = srv.appSession(bob, "eng/b", { push: false });
  await writer.connect();
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "b" })).toMatchObject({ status: 409, body: { code: "alias_held" } });
  writer.close();
  await seed(srv.app.repo, tx => srv.app.repo.sessionEnd.end(tx, writer.id, { why: "exit", now: Date.now() }));
  expect(subs("eng/b").length).toBeGreaterThan(0);
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "a" })).toMatchObject({ status: 409, body: { code: "alias_held", message: expect.stringContaining(held.id) } });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "zzz" })).toMatchObject({ status: 404 });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "b" })).toEqual({ status: 200, body: { ok: true, deleted: "eng/b" } });
  expect(names("eng")).toEqual(["a"]);
  expect(subs("eng/b")).toEqual([]);

  // The freed slot takes a new name; an admin outside the team deletes it.
  const c = srv.appSession(bob, "eng/c");
  await c.connect();
  await c.unbind("eng/c");
  expect((await srv.api(root, "POST", "/api/teams/eng/delete-alias", { name: "c" })).status).toBe(200);
  expect(deleted()).toEqual([
    { actor: "alice@example.com", target: "eng/b", detail: { team: "eng" } },
    { actor: ROOT, target: "eng/c", detail: { team: "eng", as_admin: true } },
  ]);
});

// #870: the hosted MCP bind tool, where a refused bind's binding row is deferred past the hosted transaction's rollback.
test("over hosted MCP, a new team name at the cap is refused and its refused binding event survives", async () => {
  for (const n of ["a", "b"]) {
    const s = srv.appSession(bob, `eng/${n}`);
    await s.connect();
    await s.unbind(`eng/${n}`);
  }
  const s = await srv.hosted(B, null);
  await expect(s.call("bind", { name: "eng/c", create: true })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(CAPPED) });
  expect(srv.app.db.query(`SELECT event FROM binding_events WHERE name = 'eng/c'`).all()).toEqual([{ event: "refused" }]);
  expect(names("eng")).toEqual(["a", "b"]);
  // An existing name still binds over the same tool.
  expect(await s.call("bind", { name: "eng/a" })).toMatchObject({ name: "eng/a" });
});

// #870: `grayboard team delete-alias` reaches the route and prints its result or the server's refusal.
test("grayboard team delete-alias deletes an unused team name; a member is refused", async () => {
  const b = srv.appSession(bob, "eng/b");
  await b.connect();
  await b.unbind("eng/b");
  const creds = (email: string, token: string) => {
    const path = join(mkdtempSync(join(srv.dir, "gb-creds-")), "credentials");
    writeFileSync(path, JSON.stringify({ session_token: token, server: srv.base, user_email: email }));
    return cleanEnv({ GRAYBOARD_CREDENTIALS: path });
  };
  const refused = await runCli(["team", "delete-alias", "eng", "b"], { env: creds(B, bob) });
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("forbidden");
  expect(names("eng")).toEqual(["b"]);
  const ok = await runCli(["--json", "team", "delete-alias", "eng", "b"], { env: creds("alice@example.com", alice) });
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.out)).toEqual({ ok: true, deleted: "eng/b" });
  expect(names("eng")).toEqual([]);
}, 20_000);

// #807 P1c-13: the HTTP routes that read or write aliases inside a write body (identity add and delete, a team's
// delete-alias, a claim call's address check, a team create's or join's follows, a member removal's unfollows) do so
// on that body's Tx; the GET routes on the pool.
test("#807 P1c-13: HTTP alias reads and writes inside a write body run on its Tx", async () => {
  const repo = srv.app.repo;
  const checks: { route: string; op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  let route = "";
  const spies = (["find", "countForScope", "listForScope", "create", "remove"] as const).map(name => {
    const original = repo.aliases[name].bind(repo.aliases) as (...a: unknown[]) => unknown;
    return spyOn(repo.aliases, name).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push({ route, op: name, inTxn: srv.app.db.inTransaction, handle: r === repo.read ? "pool" : "tx" });
      return original(r, ...rest);
    }) as never);
  });
  const step = async (name: string, f: () => Promise<{ status: number }>, status: number) => { route = name; expect((await f()).status).toBe(status); };
  try {
    const b = srv.appSession(bob, "eng/gone");
    await b.connect();
    await b.unbind("eng/gone");
    await step("identity.create", () => srv.api(bob, "POST", "/api/identities", { name: "one" }), 201);
    await step("claim.call", () => srv.api(bob, "POST", "/api/claims/call", { as: "one", tool: "claim_take", args: { key: "k" } }), 200);
    await step("identity.delete", () => srv.api(bob, "DELETE", "/api/identities/one"), 200);
    await step("team.delete_alias", () => srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "gone" }), 200);
    await step("team.add", () => srv.api(alice, "POST", "/api/teams/eng/add", { email: ROOT }), 200);
    await step("team.leave", () => srv.api(root, "POST", "/api/teams/eng/leave"), 200);
    await step("identity.list", () => srv.api(bob, "GET", "/api/identities"), 200);
    await step("whoami", () => srv.api(bob, "GET", "/api/whoami"), 200);
    await step("team.create", () => srv.api(alice, "POST", "/api/teams", { name: "ops" }), 201);
    await step("team.remove", () => srv.api(alice, "POST", "/api/teams/eng/remove", { email: B }), 200);
    const ops = (r: string) => checks.filter(c => c.route === r).map(c => `${c.op}:${c.handle}`);
    expect(ops("identity.create")).toEqual(["find:tx", "countForScope:tx", "create:tx"]);
    expect(ops("claim.call")).toContain("find:tx");
    expect(ops("identity.delete")).toEqual(["find:tx", "remove:tx"]);
    expect(ops("team.delete_alias")).toEqual(["find:tx", "remove:tx"]);
    expect(ops("team.add")).toContain("listForScope:tx");
    expect(ops("team.leave")).toContain("listForScope:tx");
    expect(ops("identity.list")).toEqual(["listForScope:pool"]);
    expect(ops("whoami")).toEqual(["listForScope:pool"]);
    expect(ops("team.create")).toContain("listForScope:tx");
    expect(ops("team.remove")).toContain("listForScope:tx");
    expect(checks.filter(c => c.route && c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { for (const spy of spies) spy.mockRestore(); }
});
