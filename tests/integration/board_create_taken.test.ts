// #1257 (A): board names are one global key, so board_create with a hidden board's name must refuse. The refusal is
// the one a visible open board's name gets: it says the name is taken and nothing else (not its scope, kind or
// whether it's archived). Accepted in docs/server-access.md.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HostedSession, HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

let srv: TestServer;
let sessions: HostedSession[] = [];

beforeEach(() => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
  await srv.stop();
});

const hosted = async (email: string, name: string) => {
  const s = await srv.hosted(email, name);
  sessions.push(s);
  return s;
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then((v) => new Error(`not refused: ${JSON.stringify(v)}`), (x: unknown) => x);
  if (!(e instanceof HostedToolError)) throw e;
  return e.message;
};

test("board_create on a hidden board's name answers as a visible open board's does, archived or not", async () => {
  const bob = await srv.login("bob@example.com");
  await srv.login("alice@example.com");
  expect((await srv.api(bob, "POST", "/api/teams", { name: "qa" })).status).toBe(201);
  const ops = await hosted("bob@example.com", "qa/ops");
  await ops.call("board_create", { name: "qa-room", purpose: "qa only", team: "qa" });
  await ops.call("board_create", { name: "qa-attic", purpose: "qa only", team: "qa" });
  await ops.call("board_archive", { board: "qa-attic", archived: true });
  await ops.call("board_create", { name: "lobby", purpose: "org-open" });

  const fe = await hosted("alice@example.com", "fe");
  const create = (name: string) => refusal(fe.call("board_create", { name, purpose: "mine" }));
  const open = await create("lobby");
  expect(open).toBe("board #lobby already exists");
  for (const hidden of ["qa-room", "qa-attic"]) expect(await create(hidden), hidden).toBe(open.replace("lobby", hidden));
  // The control: a member who can see the archived board is told how to reopen it.
  const own = await refusal(ops.call("board_create", { name: "qa-attic", purpose: "again" }));
  expect(own).toContain("already exists, archived");
});

test("a creator removed from the board's team gets no repeat answer for it: the repeat path checks sight too", async () => {
  const bob = await srv.login("bob@example.com");
  await srv.login("alice@example.com");
  expect((await srv.api(bob, "POST", "/api/teams", { name: "qa" })).status).toBe(201);
  expect((await srv.api(bob, "POST", "/api/teams/qa/add", { email: "alice@example.com" })).status).toBe(200);
  const fe = await hosted("alice@example.com", "fe");
  const args = { name: "qa-room", purpose: "qa only", team: "qa" };
  await fe.call("board_create", args);
  expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: "alice@example.com" })).status).toBe(200);
  // The same create again: answered as a create alice can't make, never with the board's row (createdNote).
  const again = await refusal(fe.call("board_create", args));
  expect(again).not.toContain("qa only");
  expect(again).toBe('no such team "qa"');
});

test("team create on a hidden board's name says only that the name is taken", async () => {
  const bob = await srv.login("bob@example.com");
  const alice = await srv.login("alice@example.com");
  expect((await srv.api(bob, "POST", "/api/teams", { name: "qa" })).status).toBe(201);
  const ops = await hosted("bob@example.com", "qa/ops");
  await ops.call("board_create", { name: "qa-room", purpose: "qa only", team: "qa" });
  expect(await srv.api(alice, "POST", "/api/teams", { name: "qa-room" })).toEqual({ status: 409, body: { code: "conflict", message: 'a board named "#qa-room" already exists' } });
});

// #1280: team create on a taken name answers the same whatever holds it, so it doesn't tell a private team (or a
// service) from any other holder.
test("team create on a taken name says only that it's taken, a private team's included", async () => {
  const bob = await srv.login("bob@example.com");
  const alice = await srv.login("alice@example.com");
  expect((await srv.api(bob, "POST", "/api/teams", { name: "qa" })).status).toBe(201);
  const taken = (name: string) => ({ status: 409, body: { code: "conflict", message: `the name "${name}" belongs to another user, team or service` } });
  // A non-member can't see qa (its member routes answer 404), and gets the same answer a member does.
  expect((await srv.api(alice, "GET", "/api/teams/qa/members")).status).toBe(404);
  expect(await srv.api(alice, "POST", "/api/teams", { name: "qa" })).toEqual(taken("qa"));
  expect(await srv.api(bob, "POST", "/api/teams", { name: "qa" })).toEqual(taken("qa"));
});
