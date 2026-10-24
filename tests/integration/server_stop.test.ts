// startServer().stop() lifecycle: the server's stop owns the database it
// opened — the issue asked which side does, and this pins the decision.
import { expect, test } from "bun:test";

import { verifySessionToken } from "../../src/server/auth.ts";
import { TestServer } from "../support/server.ts";

test("stop() closes the database it opened", () => {
  const srv = new TestServer();
  expect(srv.app.db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
  srv.stop();
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("stop() is idempotent: a second stop is a no-op, not a double close", () => {
  const srv = new TestServer();
  srv.stop();
  expect(() => srv.stop()).not.toThrow();
});

test("stop() cancels the nightly retention timer instead of leaving it on a closed db", async () => {
  const srv = new TestServer({}, { background: true });
  srv.stop();
  // With the timer stopped nothing touches the closed db; a pending timer
  // would reject asynchronously. A short settle lets any such rejection surface.
  await Bun.sleep(50);
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("stop() cancels a session's deferred last-used touch instead of crashing on the closed db", async () => {
  const srv = new TestServer();
  const token = await srv.login("alice@example.com");
  // Schedules the touch; stopped in the same turn, so it is still pending.
  expect(verifySessionToken(token, srv.app.repo)).toMatchObject({ user_email: "alice@example.com" });
  srv.stop();
  // The pending immediate would fire here and throw "Database has closed"
  // unhandled (the CI failure on PR #197). A settle gives it the chance.
  await Bun.sleep(20);
  expect(() => srv.app.db.query("SELECT 1 AS one").get()).toThrow(/closed/i);
});

test("a session's deferred last-used touch lands when the server keeps running", async () => {
  const srv = new TestServer();
  const token = await srv.login("alice@example.com");
  const authed = verifySessionToken(token, srv.app.repo);
  expect(authed).not.toBeNull();
  // Pin a known-past stamp after scheduling; the deferred touch overwrites it
  // with the fire-time now. (A before/after pair around the fire collides:
  // the immediate runs within the same millisecond as the snapshot.)
  srv.app.repo.sessions.touch(authed!.session_id, 1);
  await Bun.sleep(10);
  const after = (srv.app.db.query("SELECT last_used_at FROM sessions WHERE id = ?").get(authed!.session_id) as { last_used_at: number }).last_used_at;
  expect(after).toBeGreaterThan(1_000_000);
  srv.stop();
});
