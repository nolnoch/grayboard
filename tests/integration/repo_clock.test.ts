// The server stamps claim events and board-side rows with its Repo clock (#1390), the one a test injects through
// startServer's `now`, never Date.now(): one time source per transaction. The clock here runs ten days behind wall
// time, so a stamp read from the wall clock differs from every value the test expects. Runs on either backend
// (GRAYBOARD_TEST_BACKEND).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CoreError } from "../../src/core/errors.ts";
import type { AppSession } from "../support/app_session.ts";
import { TestServer } from "../support/server.ts";
import { drained, rows as sqlRows } from "../support/repo_sql.ts";
import { until } from "../support/until.ts";
import { endId } from "../support/end_id.ts";
import { seed } from "../support/seed.ts";

const A = "alice@example.com";
let clock: number;
let srv: TestServer;
let alice: string;

beforeEach(async () => {
  clock = Date.now() - 10 * 24 * 3_600_000;
  srv = await TestServer.open({}, { now: () => clock });
  alice = await srv.login(A);
});

afterEach(async () => {
  await srv.stop();
});

async function rows<T>(sql: string, ...args: (string | number)[]): Promise<T[]> {
  await drained(srv);
  return sqlRows<T>(srv, sql, ...args);
}
type Event = { key: string; event: string; at: number };
const events = (key: string) => rows<Event>(`SELECT key, event, at FROM claim_events WHERE key = ? ORDER BY id`, key);
const tick = (ms = 60_000) => { clock += ms; return clock; };

async function workBoard(s: AppSession): Promise<void> {
  await s.call("board_create", { name: "work", purpose: "tests" });
}

test("claim take, renew, refusal, release and a take's lapse sweep stamp the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  const fe = await srv.connected(alice, "fe");
  const t1 = clock;
  await be.call("claim_take", { key: "ticket:ENG-1", note: "first", ttl_minutes: 60 });
  const t2 = tick();
  await be.call("claim_take", { key: "ticket:ENG-1", note: "renewed", ttl_minutes: 60 });
  const t3 = tick();
  expect(await fe.call("claim_take", { key: "ticket:ENG-1" })).toMatchObject({ ok: false });
  const t4 = tick();
  await be.call("claim_release", { key: "ticket:ENG-1" });
  expect(await events("ticket:ENG-1")).toEqual([
    { key: "ticket:ENG-1", event: "take", at: t1 },
    { key: "ticket:ENG-1", event: "renew", at: t2 },
    { key: "ticket:ENG-1", event: "refused", at: t3 },
    { key: "ticket:ENG-1", event: "release", at: t4 },
  ]);
  // The claim's own row: acquired and expiring on the Repo clock.
  const t5 = tick();
  await be.call("claim_take", { key: "ticket:ENG-2", ttl_minutes: 1 });
  expect(await rows(`SELECT acquired_at, expires_at FROM claims WHERE key = ?`, "ticket:ENG-2")).toEqual([{ acquired_at: t5, expires_at: t5 + 60_000 }]);
  // Lapsed at the Repo clock, it's swept by the next take, its expire event stamped with that take's clock.
  const t6 = tick(120_000);
  await fe.call("claim_take", { key: "ticket:ENG-3" });
  expect(await events("ticket:ENG-2")).toEqual([
    { key: "ticket:ENG-2", event: "take", at: t5 },
    { key: "ticket:ENG-2", event: "expire", at: t6 },
  ]);
});

test("claim_watch judges a claim live at the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  const fe = await srv.connected(alice, "fe");
  await workBoard(be);
  await fe.call("board_subscribe", { board: "work", mode: "push" });
  // Live at the Repo clock, lapsed by wall time ten days on.
  await be.call("claim_take", { key: "ticket:ENG-4", board: "work", ttl_minutes: 60 });
  expect(await fe.call("claim_watch", { key: "ticket:ENG-4" })).toContain("#work");
});

test("the claim expiry timer sweeps at the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  await workBoard(be);
  // A board claim arms the timer for its expiry, 60 ms on the Repo clock; the clock then jumps past it. The timer's
  // delay is measured on that clock too: on the wall clock, ten days ahead, it would be 0 and the timer would fire,
  // sweep nothing and re-arm in a loop until the jump. Its timeouts are told apart by their callback's text.
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  const spied = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (String(fn).includes("claim expiry timer failed")) delays.push(ms ?? 0);
    return real(fn, ms, ...rest);
  }) as typeof setTimeout);
  const t1 = clock;
  try {
    await be.call("claim_take", { key: "ticket:ENG-5", board: "work", ttl_minutes: 0.001 });
    await until(() => delays.length > 0, 10_000, "the expiry timer's arm");
  } finally { spied.mockRestore(); }
  expect(delays).toEqual([60]);
  const t2 = tick(300_000);
  await until(async () => (await events("ticket:ENG-5")).length === 2, 10_000, "the timer's expire event");
  expect(await events("ticket:ENG-5")).toEqual([
    { key: "ticket:ENG-5", event: "take", at: t1 },
    { key: "ticket:ENG-5", event: "expire", at: t2 },
  ]);
});

test("a session end releases its ID's claims at the Repo clock", async () => {
  const s = await srv.connected(alice, "be");
  const id = s.id;
  const t1 = clock;
  await s.call("claim_take", { key: "ticket:ENG-6", as: id, ttl_minutes: 60 });
  // A restart ends the IDs it finds unended (application.ts endIds), stamping the end with the hub's clock.
  const t2 = tick();
  srv = await srv.restart({}, { now: () => clock });
  await srv.app.ready;
  await until(async () => (await events("ticket:ENG-6")).length === 2, 10_000, "the end's release event");
  expect(await events("ticket:ENG-6")).toEqual([
    { key: "ticket:ENG-6", event: "take", at: t1 },
    { key: "ticket:ENG-6", event: "release", at: t2 },
  ]);
});

// claim_list, and an unbind's `left`, judge claims live at the Repo clock: ten days behind wall time, these are live.
test("claim_list and unbind's left list claims live at the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  await be.bind("fe", { create: true });
  await be.call("claim_take", { key: "ticket:ENG-10", as: "fe", ttl_minutes: 60 });
  const listed = await be.call<{ key: string }[] | { claims: { key: string }[] }>("claim_list", { prefix: "ticket:" });
  expect((Array.isArray(listed) ? listed : listed.claims).map((c) => c.key)).toEqual(["ticket:ENG-10"]);
  expect(await be.unbind("fe")).toMatchObject({ released: true, left: ["ticket:ENG-10"] });
});

// The end reads its clock once (application.ts endIdsIn) and stamps every row of the end with that reading, its claim
// releases and its closing sweep among them, even when the Repo clock has moved on.
test("a session end stamps its releases and its sweep with the end's own clock reading", async () => {
  const s = await srv.connected(alice, "be");
  const t1 = clock;
  await s.call("claim_take", { key: "ticket:ENG-7", as: s.id, ttl_minutes: 60 });
  await s.call("claim_take", { key: "ticket:ENG-8", ttl_minutes: 1 });
  s.close();
  // ENG-8 (the alias's) lapses only at the end's later reading: the end's sweep expires it at that reading.
  const at = t1 + 120_000;
  await seed(srv.app.repo, tx => endId(srv.app.repo, tx, s.id, "exit", "team", at));
  // Released through the ordinary release (its note), not the end's fallback for a release that refused.
  expect(await rows(`SELECT event, note, at FROM claim_events WHERE key = ? ORDER BY id`, "ticket:ENG-7")).toEqual([
    { event: "take", note: null, at: t1 },
    { event: "release", note: "session ended", at },
  ]);
  expect(await events("ticket:ENG-8")).toEqual([
    { key: "ticket:ENG-8", event: "take", at: t1 },
    { key: "ticket:ENG-8", event: "expire", at },
  ]);
});

// A release the end can't make the ordinary way (a CoreError, forced here on its event row) still frees the claim, and
// the fallback's row carries the end's reading too.
test("a session end's fallback release stamps the end's own clock reading", async () => {
  const s = await srv.connected(alice, "be");
  await s.call("claim_take", { key: "ticket:ENG-11", as: s.id, ttl_minutes: 60 });
  s.close();
  const repo = srv.app.repo;
  const stub: typeof repo = { ...repo, claims: { ...repo.claims, logEvent: (tx, event, handle, c, at, heldBy) => {
    if (event === "release" && c.note === "session ended") throw new CoreError("forced");
    return repo.claims.logEvent(tx, event, handle, c, at, heldBy);
  } } };
  const at = clock + 120_000;
  await seed(repo, tx => endId(stub, tx, s.id, "exit", "team", at));
  expect(await rows(`SELECT event, note, at FROM claim_events WHERE key = ? AND event = 'release'`, "ticket:ENG-11")).toEqual([
    { event: "release", note: "session ended; announce failed: forced", at },
  ]);
  expect(await rows(`SELECT key FROM claims WHERE key = ?`, "ticket:ENG-11")).toEqual([]);
});

// A stop time is judged against the Repo clock, before the take as in it.
test("claim_take's until is checked against the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  const until = new Date(clock + 3_600_000).toISOString();
  expect(await be.call("claim_take", { key: "ticket:ENG-9", until })).toMatchObject({ ok: true, claim: { expires_at: clock + 3_600_000 } });
});

test("board create, archive, a post and peer_status stamp the Repo clock", async () => {
  const be = await srv.connected(alice, "be");
  const t1 = clock;
  await workBoard(be);
  const t2 = tick();
  await be.call("board_post", { board: "work", body: "hello" });
  const t3 = tick();
  await be.call("board_archive", { board: "work" });
  expect(await rows(`SELECT created_at, archived_at FROM boards WHERE name = ?`, "work")).toEqual([{ created_at: t1, archived_at: t3 }]);
  expect(await rows(`SELECT created_at FROM posts WHERE board = ? AND body = ?`, "work", "hello")).toEqual([{ created_at: t2 }]);
  // peer_status stamps the status on the Repo clock, and peer_list ages it on the same clock.
  tick();
  await be.call("peer_status", { text: "busy" });
  tick(3 * 3_600_000);
  const peers = (await be.call<{ peers: { handle: string; status?: string; status_age?: string }[] }>("peer_list", {})).peers;
  expect(peers.find((p) => p.handle === `${A}/be`)).toMatchObject({ status: "busy", status_age: "3h" });
});
