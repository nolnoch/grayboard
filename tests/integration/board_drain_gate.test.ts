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
beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
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
    // The drain ends once its last run finds nothing it hasn't sent; every wake above asked it for a run before
    // that, so nothing can arrive after it (#1214 item 6: no quiet window).
    await until(() => pushes().length >= 3 && s.session.boardDrain === null, 5000, "p2 and p3 were pushed and the drain ended");
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

// A drain run whose read fails doesn't end the drain: a wake that asked it for another run meanwhile still gets one,
// so the post that woke it, and the one the failed run had read, arrive without waiting for a later wake.
test("a board drain whose read fails still runs the rerun a post asked for meanwhile", async () => {
  const alice = await srv.login(A);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBeLessThan(300);
  const a = await srv.hosted(A, "be");
  const s = await srv.connected(alice, "sim");
  const pushes = () => s.events.filter(board()).map(e => postOf((e as BoardEvent).item).id);
  await a.call("board_post", { board: "eng", body: "@sim one" });
  await until(() => pushes().length === 1, 5000, "p1 was pushed");

  const boards = srv.app.repo.boards;
  const read = boards.pendingPushes;
  let armed = true, held = false;
  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  boards.pendingPushes = async (r, handle) => {
    if (armed && handle.includes("sim")) {
      armed = false;
      held = true;
      await released;
      throw new Error("injected read failure");
    }
    return read.call(boards, r, handle);
  };
  const errors = console.error;
  console.error = () => {};
  try {
    await a.call("board_post", { board: "eng", body: "@sim two" });
    await until(() => held, 5000, "a board drain held in its read");
    await a.call("board_post", { board: "eng", body: "@sim three" });
    release();
    await until(() => pushes().length >= 3, 5000, "p2 and p3 were pushed after the failed run");
    expect(new Set(pushes()).size).toBe(3);
  } finally {
    boards.pendingPushes = read;
    console.error = errors;
    release();
  }
});

// Holds sim's next pending-push read after it returns (#1214): the drain it belongs to has read, and not yet sent.
function holdSimRead() {
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
  return { held: () => held, release, restore: () => { boards.pendingPushes = read; release(); } };
}

async function eng() {
  const alice = await srv.login(A);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBeLessThan(300);
  const a = await srv.hosted(A, "be");
  const s = await srv.connected(alice, "sim");
  return { alice, a, s, pushes: () => s.events.filter(board()).map(e => postOf((e as BoardEvent).item).id) };
}

// drainBoardsOnce's re-check after its read (#1214 item 1): a session closed while the read awaits is sent nothing
// the read found.
test("a session closed while its board drain's read awaits is sent nothing that read found", async () => {
  const { a, s, pushes } = await eng();
  const hold = holdSimRead();
  try {
    await a.call("board_post", { board: "eng", body: "@sim one" });
    await until(hold.held, 5000, "sim's board drain held after its read");
    const drain = s.session.boardDrain!.done;
    s.close();
    expect(s.session.active).toBe(false);
    hold.release();
    await drain;
    expect(pushes()).toEqual([]);
  } finally { hold.restore(); }
});

// The same re-check for an address: one unbound while the read awaits gets none of the items read for it.
test("an alias unbound while its board drain's read awaits is sent nothing that read found for it", async () => {
  const { a, s, pushes } = await eng();
  const hold = holdSimRead();
  try {
    await a.call("board_post", { board: "eng", body: "@sim one" });
    await until(hold.held, 5000, "sim's board drain held after its read");
    const drain = s.session.boardDrain!.done;
    await s.unbind("sim");
    expect(s.session.addresses.some(x => x.includes("sim"))).toBe(false);
    expect(s.session.active).toBe(true);
    hold.release();
    await drain;
    expect(pushes()).toEqual([]);
  } finally { hold.restore(); }
});

// A replay asking a running drain for an `all` run (#1214 item 2, `running.all ||= all`): the rerun it waits for
// carries the digests a plain wake's run leaves for a waking push.
test("a replay while a board drain runs gets its all run: a pending digest arrives before the replay answers", async () => {
  const { a, s } = await eng();
  await a.call("board_create", { name: "news", purpose: "tests" });
  await s.call("board_subscribe", { board: "news", mode: "digest" });
  await a.call("board_post", { board: "news", body: "headline" });
  const digests = () => s.events.filter(board(i => i.kind === "digest" && i.board === "news"));
  expect(digests()).toEqual([]);
  const hold = holdSimRead();
  try {
    // A plain wake's drain: not `all`, and with no waking push its runs leave the digest.
    srv.app.application.wake(s.session.addresses);
    await until(hold.held, 5000, "sim's board drain held after its read");
    const replay = srv.app.application.replay(s.session);
    await until(() => s.session.boardDrain?.rerun === true, 5000, "the replay asked the running drain for another run");
    hold.release();
    await replay;
    expect(digests()).toHaveLength(1);
  } finally { hold.restore(); }
});
