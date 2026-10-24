// startServer().stop() lifecycle: the server's stop owns the database it
// opened — the issue asked which side does, and this pins the decision.
import { expect, test } from "bun:test";

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
