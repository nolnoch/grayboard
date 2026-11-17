// A session's board drain awaits its pending reads (#807 P3 B5a1, H1), so a receipt and a new post can commit to the
// session while a drain is between its read and its sends. One drain runs per session: a wake meanwhile asks it for
// another run, and a receipt that commits meanwhile names an item the running drain may have read before it, which
// the drain skips. Every push arrives once, in id order, and an acknowledged one isn't sent again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Pending, Post } from "../../src/shared/notifications.ts";
import { board, type BoardEvent } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com";
let srv: TestServer;
beforeEach(() => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(async () => {
  await srv.stop();
});

const postOf = (item: Pending): Post => {
  if (item.kind !== "push") throw new Error(`expected a push, got a ${item.kind}`);
  return item.post;
};

async function heldDrain(receiptFirst: boolean) {
  const alice = await srv.login(A);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBeLessThan(300);
  const a = await srv.hosted(A, "be");
  const s = await srv.connected(alice, "sim");
  const pushes = () => s.events.filter(board()).map(e => postOf((e as BoardEvent).item).id);

  await a.call("board_post", { board: "eng", body: "@sim one" });
  await until(() => pushes().length === 1, 5000, "p1 was pushed");
  const p1 = pushes()[0]!;

  // Hold sim's next pending-push read open after it returns: the drain it belongs to has read, and not yet sent.
  const boards = srv.app.repo.boards;
  const read = boards.pendingPushes;
  let armed = true, held = false;
  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  boards.pendingPushes = async (r, handle) => {
    const rows = await read.call(boards, r, handle);
    if (armed && handle.includes("sim")) {
      armed = false;
      held = true;
      await released;
    }
    return rows;
  };
  try {
    // The drain this post wakes reads p1 (sent, not yet acknowledged) and p2, then holds.
    await a.call("board_post", { board: "eng", body: "@sim two" });
    await until(() => held, 5000, "a board drain held after its read");
    // p1's receipt commits after that read: the held drain must not send p1 again. A post committed while the drain
    // holds: its wake asks the running drain for another run rather than starting its own, so the receipt, before or
    // after it, reaches the held drain's skip set.
    const receipt = () => s.boardAck([{ kind: "push", post_id: p1 }]);
    const post = () => a.call("board_post", { board: "eng", body: "@sim three" });
    if (receiptFirst) { await receipt(); await post(); } else { await post(); await receipt(); }
    release();
    await until(() => pushes().length >= 3, 5000, "p2 and p3 were pushed");
    const quiet = Date.now() + 300;
    await until(() => { expect(pushes()).toHaveLength(3); return Date.now() >= quiet; }, 2000, "no push after the third");
    const ids = pushes();
    expect(ids[0]).toBe(p1);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
  } finally {
    boards.pendingPushes = read;
    release();
  }
}

test("a receipt then a post committed while a board drain is held after its read: each push once, in id order", () => heldDrain(true));
test("a post then a receipt committed while a board drain is held after its read: each push once, in id order", () => heldDrain(false));
