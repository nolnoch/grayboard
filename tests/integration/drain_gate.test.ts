// A session's direct-message drain awaits its cursor reads (#807 P3 A6a), so a
// send can commit to the session while the drain is still reading. The live
// message waits in the session's drain gate and arrives after the ones the
// drain read: every message once, in id order.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DirectEvent } from "../support/events.ts";
import { direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const BOB = "bob@example.com/bob";
let srv: TestServer;
beforeEach(() => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(async () => {
  await srv.stop();
});

test("a message committed mid-drain arrives after the drained ones, once each, in id order", async () => {
  const alice = await srv.connected(await srv.login("alice@example.com"), "alice");
  const bobToken = await srv.login("bob@example.com");
  const first = await srv.connected(bobToken, "bob");
  first.close();
  const m1 = (await alice.send(BOB, "one")).message_id;
  const m2 = (await alice.send(BOB, "two")).message_id;

  // Hold bob's next direct cursor read open: the drain has started (its gate is up) and not yet read.
  const cursors = srv.app.repo.cursors;
  const get = cursors.get;
  let armed = true, entered = false;
  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  cursors.get = async (r, address, type, ref) => {
    if (armed && address.includes("bob") && type === "direct") {
      armed = false;
      entered = true;
      await released;
    }
    return get.call(cursors, r, address, type, ref);
  };
  try {
    const connecting = srv.connected(bobToken, "bob", { key: first.key });
    await until(() => entered);
    const m3 = (await alice.send(BOB, "three")).message_id;
    release();
    const bob = await connecting;
    expect(m3).toBeGreaterThan(m2);
    await until(() => bob.events.filter(direct()).length >= 3);
    await bob.none(direct(m => ![m1, m2, m3].includes(m.id)));
    const ids = bob.events.filter(direct()).map(e => (e as DirectEvent).message.id);
    expect(ids).toEqual([m1, m2, m3]);
  } finally {
    cursors.get = get;
    release();
  }
});
