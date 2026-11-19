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
