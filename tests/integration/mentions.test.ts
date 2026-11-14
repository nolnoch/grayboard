// #284 S13: @scope/name is exact, a bare @name is the author's own scope's
// first and then the board's one roster match, an ambiguous bare name
// refuses the post with the candidates, and @id: names the session whatever
// it's bound to. Person-scope names are hosted MCP sessions (#282); a team
// alias and a session bound to a second name are application sessions, as
// hosted can't hold a team alias yet.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReadResult } from "../../src/core/boards.ts";
import type { BoardPostResult } from "../../src/core/tools.ts";
import { board } from "../support/events.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  bob = await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(() => srv.stop());

const mentioned = (body: string) => board((i) => i.kind === "push" && i.reason === "mention" && i.post.body === body);

// Application sessions (srv.connected): a hosted session holds one
// person-scope name, so it can't hold the team alias eng/deploy (#451).

// hosted twin: #451 (deploy, a team alias)
test("@scope/name is exact; a bare name is only ever the author's own scope's (F-08)", async () => {
  const abe = await srv.hosted(A, "be");
  const aqa = await srv.hosted(A, "qa");
  const bqa = await srv.hosted(B, "qa");
  const deploy = await srv.connected(bob, "eng/deploy");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });

  // Exact: another person's alias, and a team's.
  let body = `@${B}/qa @eng/deploy exact`;
  expect((await abe.call<BoardPostResult>("board_post", { board: "e2e", body })).notified.sort()).toEqual([B + "/qa", "eng/deploy"]);
  await bqa.next(mentioned(body));
  await deploy.next(mentioned(body));
  await aqa.none(mentioned(body));

  // The email-local-part shorthand is gone: bob/qa names principal bob.
  body = "@bob/qa shorthand";
  expect((await abe.call<BoardPostResult>("board_post", { board: "e2e", body })).unresolved).toEqual(["bob/qa"]);
  await bqa.none(mentioned(body));

  // Bare: alice's own qa, not bob's.
  body = "@qa own scope";
  expect((await abe.call<BoardPostResult>("board_post", { board: "e2e", body })).notified).toEqual([`${A}/qa`]);
  await aqa.next(mentioned(body));
  await bqa.none(mentioned(body));

  // Bare with no own match: refused naming the one on the roster, which isn't woken.
  body = "@deploy roster";
  await expect(abe.call("board_post", { board: "e2e", body })).rejects.toMatchObject({
    message: "@deploy isn't in your scope; name it in full: eng/deploy",
  });
  await deploy.none(mentioned(body));
});

// hosted twin: #451 (deploy, a team alias)
test("a bare name only other scopes have refuses the post with its candidates; an @id: reaches the session", async () => {
  const aqa = await srv.hosted(A, "qa");
  const bqa = await srv.hosted(B, "qa");
  const deploy = await srv.connected(bob, "eng/deploy");
  // A session with no name holds no lease and receives nothing (#229), so the
  // session an @id: names is one bound to a name of its own.
  const bound = await srv.connected(alice, "sim");
  await deploy.call("board_create", { name: "e2e", purpose: "fixtures" });

  // eng has no qa of its own, and two people's are on the roster.
  await expect(deploy.call("board_post", { board: "e2e", body: "@qa which" })).rejects.toMatchObject({
    code: "bad_request",
    message: `@qa isn't in your scope; name it in full: ${A}/qa, ${B}/qa`,
  });
  expect((await deploy.call<ReadResult>("board_read", { board: "e2e" })).posts).toEqual([]);
  await aqa.none(board());
  await bqa.none(board());

  const body = `@${bound.id.toUpperCase()} by id`;
  expect((await deploy.call<BoardPostResult>("board_post", { board: "e2e", body })).notified).toEqual([bound.id]);
  await bound.next(mentioned(body));
});
