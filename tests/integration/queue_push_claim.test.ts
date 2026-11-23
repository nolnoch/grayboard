// #1640: a queue post's push to the lane holding it names the claim key (`queue:<board>:<post id>`), the key a
// decline releases, so the lane needn't look it up; a push of another post carries none (a non-holder's push of the
// same post: the store contract, src/server/store/boards.contract.ts). Hosted, so it runs on the server's store
// (SQLite, and Postgres under GRAYBOARD_TEST_BACKEND=pg), and the channel render carries it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { board } from "../support/events.ts";
import { drained, rows } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";
import { boardNotification, type Pending } from "../../src/shared/notifications.ts";

const A = "alice@example.com";
const B = "bob@example.com";
let srv: TestServer;

beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  await srv.login(A);
  await srv.login(B);
});
afterEach(() => srv.stop());

const pushed = (body: string) => board((i) => i.kind === "push" && i.post.body === body);
const itemOf = (got: { event: unknown }) => (got.event as { item: Pending }).item;

test("a queue push names its claim key to the lane holding it, and to the next lane after a decline", async () => {
  const lane = await srv.hosted(A, "lane");
  await lane.call("board_create", { name: "jobs", purpose: "work", kind: "queue" });
  await lane.call("board_subscribe", { board: "jobs", mode: "push" });
  const next = await srv.hosted(A, "next");
  await next.call("board_subscribe", { board: "jobs", mode: "push" });
  const bfe = await srv.hosted(B, "fe");
  const { post_id: id } = await bfe.call<{ post_id: number }>("board_post", { board: "jobs", body: "a job" });
  const key = `queue:jobs:${id}`;

  // One lane holds it; its push carries the key and the channel render shows it.
  await drained(srv);
  const [{ holder }] = await rows<{ holder: string }>(srv, "SELECT holder FROM claims WHERE key = ?", key);
  const [held, other] = holder === `${A}/lane` ? [lane, next] : [next, lane];
  const got = itemOf(await held.next(pushed("a job"), 5000));
  expect(got).toMatchObject({ claim: key });
  expect(boardNotification(got).meta.claim).toBe(key);

  // It declines; the other lane is handed it, and its push names the same key.
  await held.call("claim_release", { key, note: "pass" });
  const second = await other.next(pushed("a job"), 5000);
  expect(itemOf(second)).toMatchObject({ claim: key });
});

test("a thread reply's push to the poster carries no key", async () => {
  const lane = await srv.hosted(A, "lane");
  await lane.call("board_create", { name: "jobs", purpose: "work", kind: "queue" });
  await lane.call("board_subscribe", { board: "jobs", mode: "push" });
  const bfe = await srv.hosted(B, "fe");
  const { post_id: id } = await bfe.call<{ post_id: number }>("board_post", { board: "jobs", body: "a job" });
  expect(itemOf(await lane.next(pushed("a job"), 5000))).toMatchObject({ claim: `queue:jobs:${id}` });

  // The lane's reply pushes to the poster (thread), who holds no claim on it.
  await lane.call("board_post", { board: "jobs", body: "on it", parent_id: id });
  const reply = itemOf(await bfe.next(pushed("on it"), 5000));
  expect(reply).not.toHaveProperty("claim");
  expect(boardNotification(reply).meta).not.toHaveProperty("claim");
});
