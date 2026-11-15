// #347: a scope holds at most the server's aliasScopeCap names, checked on
// every create path a client reaches (bind, a tools-only writes_as, HTTP's
// identity add); an existing name binds at any count; a team owner or an
// admin deletes a team's unused name to free a slot.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";

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
const CAPPED = /already has 2 names, the server's cap of 2/;

test("a team at its cap refuses a new name by bind and by writes_as; an existing name still binds", async () => {
  for (const n of ["a", "b"]) {
    const s = srv.appSession(bob, `eng/${n}`);
    await s.connect();
    await s.unbind(`eng/${n}`);
  }
  await expect(srv.appSession(bob, "eng/c").connect()).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/team "eng" already has 2 names.*grayboard team delete-alias eng <name>/) });
  await expect(srv.appSession(bob, "eng/c", { push: false }).connect()).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(CAPPED) });
  expect(names("eng")).toEqual(["a", "b"]);
  // The refused bind leaves its binding event.
  expect(srv.app.db.query(`SELECT event FROM binding_events WHERE name = 'eng/c' ORDER BY id DESC LIMIT 1`).get()).toEqual({ event: "refused" });
  // A name that exists binds at the cap.
  expect((await srv.appSession(bob, "eng/a").connect()).bind?.alias).toBe("eng/a");
});

test("a user at the cap is refused a new identity over HTTP; the Slack human is not counted", async () => {
  expect((await srv.api(bob, "POST", "/api/identities", { name: "one" })).status).toBe(201);
  // A human row (as a Slack link makes) neither counts nor is capped.
  srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: B, name: "human" }, B);
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
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "a" })).toMatchObject({ status: 409, body: { code: "alias_held", message: expect.stringContaining(held.id) } });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "zzz" })).toMatchObject({ status: 404 });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "b" })).toEqual({ status: 200, body: { ok: true, deleted: "eng/b" } });
  expect(names("eng")).toEqual(["a"]);

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
