// The per-user limit (#210): the server refuses a bind over the bucket before
// touching the database, and the Slack bridge is exempt. The WSS hello that
// shared this bucket is gone (#282), so a bind is the only thing that spends
// it; the names (helloLimit, hello.rate_limited) stay until the filed rename.
import { afterEach, expect, test } from "bun:test";

import { FakeSlack } from "./fake_slack.ts";
import { refusal } from "../support/app_session.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com";
const cleanup: (() => void)[] = [];

afterEach(async () => {
  await closeSessions();
  for (const f of cleanup.splice(0)) f();
});

function serve(o: ConstructorParameters<typeof TestServer>[0]): TestServer {
  const srv = new TestServer(o);
  cleanup.push(() => srv.stop());
  return srv;
}

const count = (srv: TestServer, sql: string, ...args: string[]) => (srv.app.db.query(sql).get(...args) as { n: number }).n;


test("a bind over the user's bucket is refused with a wait, writes nothing about the name, and passes after the wait", async () => {
  // Each bind takes a token (#284: binds create aliases).
  const srv = serve({ helloLimit: { burst: 3, perSec: 4 } });
  const alice = await srv.login(A);
  const bob = await srv.login("bob@example.com");
  const a = srv.appSession(alice, null);
  await a.connect();
  await a.bind("be");
  await a.bind("ops");
  await a.bind("qa");

  // A bind that would create its name and log a refusal.
  const r = await refusal(a.bind("fe"));
  expect(r.code).toBe("rate_limited");
  expect(r.extra.retry_after_ms).toBeGreaterThan(0);
  expect(r.extra.retry_after_ms).toBeLessThanOrEqual(250);
  expect(r.message).toMatch(/too many binds for this user; retry in \ds/);
  expect(count(srv, `SELECT COUNT(*) AS n FROM binding_events WHERE name = ?`, `${A}/fe`)).toBe(0);
  expect(count(srv, `SELECT COUNT(*) AS n FROM aliases WHERE address = ?`, `${A}/fe`)).toBe(0);

  // Another user's bucket is their own.
  await srv.appSession(bob, "be").connect();

  // A second refusal in the same run is audited once.
  expect((await refusal(a.bind("fe"))).code).toBe("rate_limited");
  expect(count(srv, `SELECT COUNT(*) AS n FROM access_log WHERE action = 'hello.rate_limited' AND actor = ?`, A)).toBe(1);
  // The start row names the session that tripped it and the wait it was given.
  const start = JSON.parse((srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'hello.rate_limited'`).get() as { detail: string }).detail);
  expect(start).toMatchObject({ session_id: a.id });
  expect(start.retry_after_ms).toBe(r.extra.retry_after_ms);

  // The run ends only once the bucket is full again (3 tokens at 4/s: 750ms
  // from empty). The wait is the bucket's own clock, not a race; polling with
  // binds would keep it from filling.
  const fullAt = Date.now() + 800;
  await until(() => Date.now() >= fullAt);
  expect((await a.bind("fe")).alias).toBe(`${A}/fe`);
  expect(count(srv, `SELECT COUNT(*) AS n FROM access_log WHERE action = 'hello.rate_limit_ended'`)).toBe(1);
  expect(JSON.parse((srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'hello.rate_limit_ended'`).get() as { detail: string }).detail).refused).toBeGreaterThanOrEqual(2);
});

test("the heartbeat's sweep ends a run nobody binds after, and drops the refilled bucket (#247)", async () => {
  // The limiter on a clock the test moves; the sweep is what the 30s heartbeat runs.
  const clock = { t: Date.now() };
  const srv = new TestServer({ helloLimit: { burst: 2, perSec: 0.1 } }, { now: () => clock.t });
  cleanup.push(() => srv.stop());
  const a = srv.appSession(await srv.login(A), null);
  await a.connect();
  await a.bind("be");
  await a.bind("ops");
  expect((await refusal(a.bind("fe"))).code).toBe("rate_limited");
  expect((await refusal(a.bind("fe"))).code).toBe("rate_limited");
  const ended = () => srv.app.db.query(`SELECT actor, detail FROM access_log WHERE action = 'hello.rate_limit_ended'`).all() as { actor: string; detail: string }[];
  // Not yet full (one token back of two): the run goes on and the bucket stays.
  clock.t += 10_000;
  srv.app.sweepLimits();
  expect(ended()).toEqual([]);
  expect(srv.app.application.limiterSizes().bind).toBe(1);
  // Full again: one sweep writes the end and drops the bucket, and a second writes nothing more.
  clock.t += 10_000;
  srv.app.sweepLimits();
  expect(ended().map((r) => [r.actor, JSON.parse(r.detail)])).toEqual([[A, { refused: 2 }]]);
  expect(srv.app.application.limiterSizes().bind).toBe(0);
  srv.app.sweepLimits();
  expect(ended()).toHaveLength(1);
});

test("the Slack bridge's human connection is exempt", async () => {
  const slack = new FakeSlack({ channel: "D0ALICE", owner: "U0ALICE", channelType: "im" });
  cleanup.push(() => slack.stop());
  const srv = serve({ helloLimit: { burst: 1, perSec: 0.01 }, slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: slack.api } });
  await srv.app.slackReady;
  const alice = await srv.login(A);
  const a = srv.appSession(alice, null);
  await a.connect();
  await a.bind("be");
  expect((await refusal(a.bind("fe"))).code).toBe("rate_limited");

  const r = await srv.api(alice, "POST", "/api/slack/link");
  slack.emails.set("U0ALICE", A);
  slack.say(`link ${r.body.code}`);
  await until(() => count(srv, `SELECT COUNT(*) AS n FROM binding_events WHERE name = ? AND event = 'bound'`, `${A}/human`) === 1);
});

test("a bind spends the user's bucket and the next is refused, writing no alias", async () => {
  const srv = serve({ helloLimit: { burst: 2, perSec: 0.01 } });
  const alice = await srv.login(A);
  const a = srv.appSession(alice, null);
  await a.connect();
  await a.bind("be");
  await a.bind("fe");
  const bind = await refusal(a.bind("ops"));
  expect(bind).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/too many binds for this user; retry in \d+s/) });
  expect(bind.extra.retry_after_ms).toBeGreaterThan(0);
  expect(count(srv, `SELECT COUNT(*) AS n FROM aliases WHERE address = ?`, `${A}/ops`)).toBe(0);
});
