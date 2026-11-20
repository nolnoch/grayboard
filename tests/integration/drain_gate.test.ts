// A session's direct-message drain awaits its cursor reads (#807 P3 A6a), so a
// send can commit to the session while the drain is still running. The live
// message waits in the session's drain gate and arrives after the ones the
// drain read: every message once, in id order. Two windows: a send that
// commits before the drain's read (the drain sends it; the gate keeps the
// live push from doubling it) and one that commits after the read (only the
// gate's flush delivers it).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSession } from "../support/app_session.ts";
import type { DirectEvent } from "../support/events.ts";
import { direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const BOB = "bob@example.com/bob";
let srv: TestServer;
beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(async () => {
  await srv.stop();
});

// alice, and two messages waiting for bob, whose first session has gone; bob reconnects on its key.
async function offline() {
  const alice = await srv.connected(await srv.login("alice@example.com"), "alice");
  const bobToken = await srv.login("bob@example.com");
  const first = await srv.connected(bobToken, "bob");
  first.close();
  const m1 = (await alice.send(BOB, "one")).message_id;
  const m2 = (await alice.send(BOB, "two")).message_id;
  const reconnect = () => {
    const p = srv.connected(bobToken, "bob", { key: first.key });
    p.catch(() => {}); // awaited below; a rejection while the test waits on its hold isn't unhandled
    return p;
  };
  return { alice, m1, m2, reconnect };
}

async function receivedInOrder(bob: AppSession, ids: number[]) {
  await until(() => bob.events.filter(direct()).length >= ids.length);
  await bob.none(direct(m => !ids.includes(m.id)));
  expect(bob.events.filter(direct()).map(e => (e as DirectEvent).message.id)).toEqual(ids);
}

test("a message committed before the drain's read arrives after the drained ones, once", async () => {
  const { alice, m1, m2, reconnect } = await offline();
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
    const connecting = reconnect();
    await until(() => entered);
    const m3 = (await alice.send(BOB, "three")).message_id;
    release();
    expect(m3).toBeGreaterThan(m2);
    await receivedInOrder(await connecting, [m1, m2, m3]);
  } finally {
    cursors.get = get;
    release();
  }
});

// Holds the server at testPause `point` while `during` runs, then releases it and awaits what `start` started.
async function pausedAt<T>(point: string, start: () => Promise<T>, during: () => Promise<void>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gb-drain-"));
  const go = join(dir, "go");
  const log = console.error;
  let hit = false;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes(`test pause hit: ${point}`)) hit = true;
    else if (!String(args[0]).includes("test pause released")) log(...args);
  };
  process.env.BUS_TEST_PAUSE = point;
  process.env.BUS_TEST_PAUSE_FILE = go;
  try {
    const started = start();
    await until(() => hit);
    await during();
    writeFileSync(go, "");
    return await started;
  } finally {
    delete process.env.BUS_TEST_PAUSE;
    delete process.env.BUS_TEST_PAUSE_FILE;
    console.error = log;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a message committed after the drain's read arrives through the gate's flush, after the drained ones", async () => {
  const { alice, m1, m2, reconnect } = await offline();
  let m3 = 0;
  // The drain has read m1 and m2 only; m3 commits now, so only the gate's flush can deliver it.
  const connecting = await pausedAt("server:drain:after-read", reconnect, async () => { m3 = (await alice.send(BOB, "three")).message_id; });
  await receivedInOrder(connecting, [m1, m2, m3]);
});

// #1090: the bind's commit made bob deliverable; its caller's replay hasn't started. A send committed in that gap
// waits in the gate the bind raised, not pushed live and then read again by the drain (m3, m1, m2, m3).
test("a message committed between the bind's commit and its replay arrives once, after the drained ones", async () => {
  const { alice, m1, m2, reconnect } = await offline();
  let m3 = 0;
  const connecting = await pausedAt("server:replay:start", reconnect, async () => { m3 = (await alice.send(BOB, "three")).message_id; });
  expect(m3).toBeGreaterThan(m2);
  await receivedInOrder(connecting, [m1, m2, m3]);
});
