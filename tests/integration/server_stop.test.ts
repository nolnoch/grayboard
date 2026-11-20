// startServer().stop() lifecycle: the server's stop owns the database it
// opened — the issue asked which side does, and this pins the decision.
import { expect, spyOn, test } from "bun:test";

import { verifySessionToken } from "../../src/server/auth.ts";
import { TestServer, testSqlite } from "../support/server.ts";
import { seed } from "../support/seed.ts";
import { drained, row } from "../support/repo_sql.ts";

testSqlite("stop() closes the database it opened", async () => {
  const srv = await TestServer.open();
  expect(srv.app.db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
  await srv.stop();
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("stop() is idempotent: repeated stops share completion without a double close", async () => {
  const srv = await TestServer.open();
  const first = srv.app.stop();
  expect(srv.app.stop()).toBe(first);
  await first;
  await srv.stop();
});

testSqlite("stop() cancels the nightly retention timer instead of leaving it on a closed db", async () => {
  // First run due 400 ms out, so the nightly timer is still pending when
  // stop() lands. Removing stopRetention?.() from stop() lets it fire on the
  // closed db: runRetention logs "[grayboard] retention failed: ..." and the
  // sweep afterwards rejects (an unhandled error bun test fails on).
  const srv = await TestServer.open({}, { background: true, retentionFirstDelayMs: 400 });
  await srv.stop();
  const err = spyOn(console, "error");
  try {
    await Bun.sleep(500);
    expect(err.mock.calls.flat().join(" ")).not.toMatch(/retention failed|closed/i);
  } finally {
    err.mockRestore();
  }
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

testSqlite("stop() cancels a session's deferred last-used touch instead of crashing on the closed db", async () => {
  const srv = await TestServer.open();
  const token = await srv.login("alice@example.com");
  // Schedules the touch; stopped in the same turn, so it is still pending.
  expect(await verifySessionToken(token, srv.app.repo, srv.app.touches, 0)).toMatchObject({ user_email: "alice@example.com" });
  await srv.stop();
  // The pending immediate would fire here and throw "Database has closed"
  // unhandled (the CI failure on PR #197). A settle gives it the chance.
  await Bun.sleep(20);
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("a session's deferred last-used touch lands when the server keeps running", async () => {
  const srv = await TestServer.open();
  const token = await srv.login("alice@example.com");
  const authed = await verifySessionToken(token, srv.app.repo, srv.app.touches, 0);
  expect(authed).not.toBeNull();
  // Pin a known-past stamp after scheduling; the deferred touch overwrites it
  // with the fire-time now. (A before/after pair around the fire collides:
  // the immediate runs within the same millisecond as the snapshot.)
  await seed(srv.app.repo, tx => srv.app.repo.sessions.touch(tx, authed!.session_id, 1));
  await Bun.sleep(10);
  await drained(srv);
  const after = (await row<{ last_used_at: number }>(srv, "SELECT last_used_at FROM sessions WHERE id = ?", authed!.session_id))!.last_used_at;
  expect(after).toBeGreaterThan(1_000_000);
  await srv.stop();
});

test("stopping one server leaves another live server's pending touch alone", async () => {
  // The touch queue is per-server: under the module-global set this PR
  // replaced, b.stop() here cancelled a's pending immediate.
  const a = await TestServer.open();
  const b = await TestServer.open();
  const tokenA = await a.login("alice@example.com");
  const authedA = (await verifySessionToken(tokenA, a.app.repo, a.app.touches, 0))!;
  // Pin a known-past stamp after scheduling; the deferred touch overwrites it
  // with the fire-time now (the immediate cannot run mid-sync-block).
  await seed(a.app.repo, tx => a.app.repo.sessions.touch(tx, authedA.session_id, 1));
  await b.stop();
  await Bun.sleep(10);
  await drained(a);
  const after = (await row<{ last_used_at: number }>(a, "SELECT last_used_at FROM sessions WHERE id = ?", authedA.session_id))!.last_used_at;
  expect(after).toBeGreaterThan(1_000_000);
  await a.stop();
});
