// #825 (#806 read-time authority, vision.md principle 10): the pull-free
// reads mark what another signed-in user wrote as the lease's pull does:
// other_user always, ungranted when no msg.wake grant covers the writer.
// dm_inbox, dm_thread, dm_history, board_read and a board resource read each
// carry the marks, so a poll session or one after /clear loses none. Decided per call, so a grant
// set or revoked changes the next read (principle 11). The reader's own
// user's items are never marked.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
let srv: TestServer;
let alice: string;

beforeEach(async () => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(() => srv.stop());

type Marked = { id?: number; body: string; other_user?: true; ungranted?: true };
const policy = (value: string) => srv.api(alice, "POST", "/api/teams/eng/policy", { policy: value });
const marks = (items: Marked[], body: string): Marks => {
  const m = items.find((i) => i.body === body);
  if (!m) throw new Error(`no item "${body}" in ${JSON.stringify(items)}`);
  return { other_user: m.other_user, ungranted: m.ungranted };
};
type Marks = { other_user?: true; ungranted?: true };
const OTHER: Marks = { other_user: true, ungranted: true };
const GRANTED: Marks = { other_user: true, ungranted: undefined };
const OWN: Marks = { other_user: undefined, ungranted: undefined };

test("dm_inbox, dm_thread and dm_history mark another user's DM, drop ungranted under a grant and restore it on revoke", async () => {
  const abe = await srv.hosted(A, "be");
  const aqa = await srv.hosted(A, "qa");
  const bfe = await srv.hosted(B, "fe");
  const sent = await bfe.call<{ message_id: number }>("dm_send", { to: `${A}/be`, body: "from bob" });
  await aqa.call("dm_send", { to: "be", body: "from alice" });

  const reads = async () => {
    const inbox = (await abe.call<{ unanswered: Marked[] }>("dm_inbox", {})).unanswered;
    const thread = await abe.call<Marked[]>("dm_thread", { thread: sent.message_id });
    const history = await abe.call<Marked[]>("dm_history", {});
    return { inbox, thread, history };
  };
  let r = await reads();
  for (const items of [r.inbox, r.thread, r.history]) expect(marks(items, "from bob")).toEqual(OTHER);
  for (const items of [r.inbox, r.history]) expect(marks(items, "from alice")).toEqual(OWN);

  // A collaborative team is a grant: still another person's, no longer ungranted.
  expect((await policy("collaborative")).status).toBe(200);
  r = await reads();
  for (const items of [r.inbox, r.thread, r.history]) expect(marks(items, "from bob")).toEqual(GRANTED);

  // Revoked: the next read marks it ungranted again.
  expect((await policy("open")).status).toBe(200);
  r = await reads();
  for (const items of [r.inbox, r.thread, r.history]) expect(marks(items, "from bob")).toEqual(OTHER);

  // The reader's own reply in the thread is never marked.
  await abe.call("dm_send", { to: `${B}/fe`, body: "reply", parent_id: sent.message_id });
  expect(marks(await abe.call<Marked[]>("dm_thread", { thread: sent.message_id }), "reply")).toEqual(OWN);
});

test("board_read marks another user's post, follows the grant, and leaves the reader's user's posts unmarked", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  const bfe = await srv.hosted(B, "fe");
  const aqa = await srv.hosted(A, "qa");
  await bfe.call("board_post", { board: "e2e", body: "bob's post" });
  await aqa.call("board_post", { board: "e2e", body: "alice's post" });

  const read = async () => (await abe.call<{ posts: Marked[] }>("board_read", { board: "e2e" })).posts;
  let posts = await read();
  expect(marks(posts, "bob's post")).toEqual(OTHER);
  expect(marks(posts, "alice's post")).toEqual(OWN);

  expect((await policy("collaborative")).status).toBe(200);
  posts = await read();
  expect(marks(posts, "bob's post")).toEqual(GRANTED);

  expect((await policy("open")).status).toBe(200);
  expect(marks(await read(), "bob's post")).toEqual(OTHER);

  // A board resource read (a native client's snapshot) is a read too.
  const reader = await srv.connected(alice, "ops");
  const snap = async () => (await srv.app.application.boardSnapshot(srv.app.repo.read, reader.session, "e2e")).posts as Marked[];
  expect(marks(await snap(), "bob's post")).toEqual(OTHER);
  expect(marks(await snap(), "alice's post")).toEqual(OWN);
  expect((await policy("collaborative")).status).toBe(200);
  expect(marks(await snap(), "bob's post")).toEqual(GRANTED);
});

// #807 P1c-14b: another user's DMs make dm_history look up which are delegations; that read runs on the history body's Tx.
test("dm_history's delegation lookup for another user's DMs reads on its body's Tx (#807 P1c-14b)", async () => {
  const repo = srv.app.repo;
  const checks: string[] = [];
  const original = repo.messages.delegationIds.bind(repo.messages);
  const spy = spyOn(repo.messages, "delegationIds").mockImplementation((r, ids) => {
    checks.push(`${r === repo.read ? "pool" : "tx"}:${srv.app.db.inTransaction}`);
    return original(r, ids);
  });
  try {
    const abe = await srv.hosted(A, "be");
    const bfe = await srv.hosted(B, "fe");
    await bfe.call("dm_send", { to: `${A}/be`, body: "from bob" });
    expect(marks(await abe.call<Marked[]>("dm_history", {}), "from bob")).toEqual(OTHER);
  } finally { spy.mockRestore(); }
  expect(checks).toContain("tx:true");
  expect(checks.filter((c) => c !== "tx:true")).toEqual([]);
});
