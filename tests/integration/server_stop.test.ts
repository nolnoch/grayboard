// startServer().stop() lifecycle: the server's stop owns the database it
// opened — the issue asked which side does, and this pins the decision.
import { expect, spyOn, test } from "bun:test";

import { verifySessionToken } from "../../src/server/auth.ts";
import { TestServer } from "../support/server.ts";

test("stop() closes the database it opened", async () => {
  const srv = new TestServer();
  expect(srv.app.db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
  await srv.stop();
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("stop() is idempotent: repeated stops share completion without a double close", async () => {
  const srv = new TestServer();
  const first = srv.app.stop();
  expect(srv.app.stop()).toBe(first);
  await first;
  await srv.stop();
});

test("stop() cancels the nightly retention timer instead of leaving it on a closed db", async () => {
  // First run due 400 ms out, so the nightly timer is still pending when
  // stop() lands. Removing stopRetention?.() from stop() lets it fire on the
  // closed db: runRetention logs "[grayboard] retention failed: ..." and the
  // sweep afterwards rejects (an unhandled error bun test fails on).
  const srv = new TestServer({}, { background: true, retentionFirstDelayMs: 400 });
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

test("stop() cancels a session's deferred last-used touch instead of crashing on the closed db", async () => {
  const srv = new TestServer();
  const token = await srv.login("alice@example.com");
  // Schedules the touch; stopped in the same turn, so it is still pending.
  expect(verifySessionToken(token, srv.app.repo, srv.app.touches)).toMatchObject({ user_email: "alice@example.com" });
  await srv.stop();
  // The pending immediate would fire here and throw "Database has closed"
  // unhandled (the CI failure on PR #197). A settle gives it the chance.
  await Bun.sleep(20);
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("a session's deferred last-used touch lands when the server keeps running", async () => {
  const srv = new TestServer();
  const token = await srv.login("alice@example.com");
  const authed = verifySessionToken(token, srv.app.repo, srv.app.touches);
  expect(authed).not.toBeNull();
  // Pin a known-past stamp after scheduling; the deferred touch overwrites it
  // with the fire-time now. (A before/after pair around the fire collides:
  // the immediate runs within the same millisecond as the snapshot.)
  srv.app.repo.sessions.touch(authed!.session_id, 1);
  await Bun.sleep(10);
  const after = (srv.app.db.query("SELECT last_used_at FROM sessions WHERE id = ?").get(authed!.session_id) as { last_used_at: number }).last_used_at;
  expect(after).toBeGreaterThan(1_000_000);
  await srv.stop();
});

test("stopping one server leaves another live server's pending touch alone", async () => {
  // The touch queue is per-server: under the module-global set this PR
  // replaced, b.stop() here cancelled a's pending immediate.
  const a = new TestServer();
  const b = new TestServer();
  const tokenA = await a.login("alice@example.com");
  const authedA = verifySessionToken(tokenA, a.app.repo, a.app.touches)!;
  // Pin a known-past stamp after scheduling; the deferred touch overwrites it
  // with the fire-time now (the immediate cannot run mid-sync-block).
  a.app.repo.sessions.touch(authedA.session_id, 1);
  await b.stop();
  await Bun.sleep(10);
  const after = (a.app.db.query("SELECT last_used_at FROM sessions WHERE id = ?").get(authedA.session_id) as { last_used_at: number }).last_used_at;
  expect(after).toBeGreaterThan(1_000_000);
  await a.stop();
});
