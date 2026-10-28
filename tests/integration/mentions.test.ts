// #284 S13 over real WebSockets: @scope/name is exact, a bare @name is the
// author's own scope's first and then the board's one roster match, an
// ambiguous bare name refuses the post with the candidates, and @id: names
// the session whatever it's bound to.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { TestServer } from "../support/server.ts";
import type { Any, WsClient } from "../support/ws_client.ts";

const A = "alice@example.com";
const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  srv = new TestServer();
  alice = await srv.login(A);
  bob = await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(() => srv.stop());

const mentioned = (body: string) => (m: Any) => m.type === "board_push" && m.item.reason === "mention" && m.item.post.body === body;

async function connect(token: string, identity: string | null): Promise<WsClient> {
  const c = srv.client(token, identity);
  expect((await c.connect()).type).toBe("hello_ok");
  return c;
}

test("@scope/name is exact; a bare name is the author's own scope's first, else the board's one match", async () => {
  const abe = await connect(alice, "be");
  const aqa = await connect(alice, "qa");
  const bqa = await connect(bob, "qa");
  const deploy = await connect(bob, "eng/deploy");
  expect((await abe.call("board_create", { name: "e2e", purpose: "fixtures" })).type).toBe("call_ok");

  // Exact: another person's alias, and a team's.
  let body = `@${B}/qa @eng/deploy exact`;
  expect((await abe.call("board_post", { board: "e2e", body })).result.notified.sort()).toEqual([B + "/qa", "eng/deploy"]);
  await bqa.next(mentioned(body));
  await deploy.next(mentioned(body));
  await aqa.none(mentioned(body));

  // The email-local-part shorthand is gone: bob/qa names principal bob.
  body = "@bob/qa shorthand";
  expect((await abe.call("board_post", { board: "e2e", body })).result.unresolved).toEqual(["bob/qa"]);
  await bqa.none(mentioned(body));

  // Bare: alice's own qa, not bob's.
  body = "@qa own scope";
  expect((await abe.call("board_post", { board: "e2e", body })).result.notified).toEqual([`${A}/qa`]);
  await aqa.next(mentioned(body));
  await bqa.none(mentioned(body));

  // Bare with no own match: the one alias of that name on the roster.
  body = "@deploy roster";
  expect((await abe.call("board_post", { board: "e2e", body })).result.notified).toEqual(["eng/deploy"]);
  await deploy.next(mentioned(body));
});

test("an ambiguous bare name refuses the post with its candidates; an @id: reaches the session", async () => {
  const aqa = await connect(alice, "qa");
  const bqa = await connect(bob, "qa");
  const deploy = await connect(bob, "eng/deploy");
  const unbound = await connect(alice, null);
  expect((await deploy.call("board_create", { name: "e2e", purpose: "fixtures" })).type).toBe("call_ok");

  // eng has no qa of its own, and two people's are on the roster.
  expect(await deploy.call("board_post", { board: "e2e", body: "@qa which" })).toMatchObject({
    type: "error",
    code: "bad_request",
    message: `@qa matches ${A}/qa, ${B}/qa; name one`,
  });
  expect((await deploy.call("board_read", { board: "e2e" })).result.posts).toEqual([]);
  await aqa.none((m) => m.type === "board_push");
  await bqa.none((m) => m.type === "board_push");

  const body = `@${unbound.id.toUpperCase()} by id`;
  expect((await deploy.call("board_post", { board: "e2e", body })).result.notified).toEqual([unbound.id]);
  await unbound.next(mentioned(body));
});
