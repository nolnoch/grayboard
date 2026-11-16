// Security audit F-10 (#805): a hosted session's pushed DM, post or digest
// that another signed-in user's session wrote carries other_user, judged by
// the user the server recorded at write time, never by the address (a team
// alias or an ID names no user). The user's own sessions and own human are
// never marked; another user's human is.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { board, direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { seed } from "../support/seed.ts";

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

const marked = (e: DeliveryEvent) =>
  e.kind === "direct" ? e.message.other_user : e.item.kind === "push" ? e.item.post.other_user : e.item.latest.other_user;
const dm = (body: string) => direct((m) => m.body === body);
const pushed = (body: string) => board((i) => i.kind === "push" && i.post.body === body);

async function human(email: string) {
  const user = srv.app.repo.users.findByEmail(email)!;
  return (await srv.app.application.attachHuman({ user_id: user.id, user_email: email, session_id: 0 }, { deliver() {}, closed() {} })).session;
}

test("a DM from another user's session is marked; one from the same user's is not", async () => {
  const abe = await srv.hosted(A, "be");
  const aqa = await srv.hosted(A, "qa");
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "from bob" });
  await aqa.call("dm_send", { to: "be", body: "from alice" });
  expect(marked((await abe.next(dm("from bob"))).event)).toBe(true);
  expect(marked((await abe.next(dm("from alice"))).event)).toBeUndefined();
});

test("a team alias's post is marked by the member who wrote it, not by the alias", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  const deploy = await srv.connected(bob, "eng/deploy");
  const ops = await srv.connected(alice, "eng/ops");
  await deploy.call("board_post", { board: "e2e", body: `@${A}/be by bob` });
  await ops.call("board_post", { board: "e2e", body: `@${A}/be by alice` });
  expect(marked((await abe.next(pushed(`@${A}/be by bob`))).event)).toBe(true);
  expect(marked((await abe.next(pushed(`@${A}/be by alice`))).event)).toBeUndefined();
});

test("the user's own human is not marked; another user's human is", async () => {
  const abe = await srv.hosted(A, "be");
  const own = await human(A);
  const other = await human(B);
  // In a queued body each, as the Slack bridge sends.
  await seed(srv.app.repo, tx => srv.app.application.send(tx, own, `${A}/be`, "own human"));
  await seed(srv.app.repo, tx => srv.app.application.send(tx, other, `${A}/be`, "bob's human"));
  expect(marked((await abe.next(dm("own human"))).event)).toBeUndefined();
  expect(marked((await abe.next(dm("bob's human"))).event)).toBe(true);
  srv.app.application.close(own);
  srv.app.application.close(other);
});

test("a digest is marked by its latest post's writer", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  await abe.call("board_subscribe", { board: "e2e", mode: "digest" });
  const bfe = await srv.hosted(B, "fe");
  const aqa = await srv.hosted(A, "qa");
  const digest = (body: string) => board((i) => i.kind === "digest" && i.latest.body === body);
  await bfe.call("board_post", { board: "e2e", body: "bob's news" });
  expect(marked((await abe.next(digest("bob's news"))).event)).toBe(true);
  // One digest until the reader catches up.
  await abe.call("board_read", { board: "e2e" });
  await aqa.call("board_post", { board: "e2e", body: "alice's news" });
  expect(marked((await abe.next(digest("alice's news"))).event)).toBeUndefined();
});

// A claim's announcement is a post too: marked by its writer, whether a hosted
// session took it or `grayboard claim` (POST /api/claims/call) did.
test("a claim announcement is marked by the user who took it, over MCP or the CLI route", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  await abe.call("board_subscribe", { board: "e2e", mode: "push" });
  const bfe = await srv.hosted(B, "fe");
  const announced = (key: string) => board((i) => i.kind === "push" && i.post.body.includes(key));
  await bfe.call("claim_take", { key: "ticket:ENG-1", board: "e2e" });
  expect(marked((await abe.next(announced("ticket:ENG-1"))).event)).toBe(true);
  const cli = await srv.api(bob, "POST", "/api/claims/call", { as: "fe", tool: "claim_take", args: { key: "ticket:ENG-2", board: "e2e" } });
  expect(cli.status).toBe(200);
  expect(marked((await abe.next(announced("ticket:ENG-2"))).event)).toBe(true);
  await abe.call("claim_take", { key: "ticket:ENG-3", board: "e2e" });
  const aqa = await srv.hosted(A, "qa");
  await aqa.call("board_subscribe", { board: "e2e", mode: "push" });
  await abe.call("claim_release", { key: "ticket:ENG-3" });
  expect(marked((await aqa.next(announced("ticket:ENG-3"))).event)).toBeUndefined();
});
