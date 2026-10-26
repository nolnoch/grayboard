// The per-user hello limit (#210): the server refuses a hello over the
// bucket before touching the database, the Slack bridge is exempt, and the
// client waits a refusal out instead of failing or hammering.
import { afterEach, expect, test } from "bun:test";

import { FakeSlack } from "./fake_slack.ts";
import { mintSessionKey } from "../../src/core/bindings.ts";
import { GrayboardClient } from "../../src/plugin/client.ts";
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

test("a hello over the user's bucket is refused with a wait, writes nothing about the name, and passes after the wait", async () => {
  // A hello and a bind each take a token (#284: binds create aliases).
  const srv = serve({ helloLimit: { burst: 3, perSec: 4 } });
  const alice = await srv.login(A);
  const bob = await srv.login("bob@example.com");
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  expect((await srv.client(alice, "be").connect()).type).toBe("hello_ok");

  // A session that would bind, create its name and log a refusal.
  const r = await srv.client(alice, "fe", { hello: { create: false } }).connect();
  expect(r).toMatchObject({ type: "error", req_id: "h", code: "rate_limited" });
  expect(r.retry_after_ms).toBeGreaterThan(0);
  expect(r.retry_after_ms).toBeLessThanOrEqual(250);
  expect(r.message).toMatch(/too many connections for this user; retry in \ds/);
  expect(count(srv, `SELECT COUNT(*) AS n FROM binding_events WHERE name = ?`, `${A}/fe`)).toBe(0);
  expect(count(srv, `SELECT COUNT(*) AS n FROM aliases WHERE address = ?`, `${A}/fe`)).toBe(0);

  // Another user's bucket is their own.
  expect((await srv.client(bob, "be").connect()).type).toBe("hello_ok");

  // A second refusal in the same run is audited once.
  expect((await srv.client(alice, null).connect()).code).toBe("rate_limited");
  expect(count(srv, `SELECT COUNT(*) AS n FROM access_log WHERE action = 'hello.rate_limited' AND actor = ?`, A)).toBe(1);
  // The start row names the hello that tripped it and the wait it was given.
  const start = JSON.parse((srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'hello.rate_limited'`).get() as { detail: string }).detail);
  expect(start).toMatchObject({ session_id: expect.stringMatching(/^id:/), place: null });
  expect(start.retry_after_ms).toBe(r.retry_after_ms);

  // The run ends only once the bucket is full again (3 tokens at 4/s: 750ms
  // from empty). The wait is the bucket's own clock, not a race; polling with
  // hellos would keep it from filling.
  const fullAt = Date.now() + 800;
  await until(() => Date.now() >= fullAt);
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  expect(count(srv, `SELECT COUNT(*) AS n FROM access_log WHERE action = 'hello.rate_limit_ended'`)).toBe(1);
  expect(JSON.parse((srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'hello.rate_limit_ended'`).get() as { detail: string }).detail).refused).toBeGreaterThanOrEqual(2);
  expect((await srv.client(alice, "fe").connect()).bind_ok.alias).toBe(`${A}/fe`);
});

test("the Slack bridge's human connection is exempt", async () => {
  const slack = new FakeSlack({ channel: "D0ALICE", owner: "U0ALICE", channelType: "im" });
  cleanup.push(() => slack.stop());
  const srv = serve({ helloLimit: { burst: 1, perSec: 0.01 }, slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: slack.api } });
  await srv.app.slackReady;
  const alice = await srv.login(A);
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  expect((await srv.client(alice, null).connect()).code).toBe("rate_limited");

  const r = await srv.api(alice, "POST", "/api/slack/link");
  slack.say(`link ${r.body.code}`);
  await until(() => count(srv, `SELECT COUNT(*) AS n FROM binding_events WHERE name = ? AND event = 'bound'`, `${A}/human`) === 1);
});

test("a session started while its user is rate-limited waits and binds", async () => {
  const srv = serve({ helloLimit: { burst: 1, perSec: 1 } });
  const alice = await srv.login(A);
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  const s = await srv.session(alice, "fe");
  expect(s.c.getInstructions()).toContain(`identity "fe"`);
  expect(s.stderr()).toMatch(/connection as session id:\w+ rate limited \(too many connections for this user; retry in 1s\); reconnecting in \d+ms/);
}, 15_000);

test("a limited session outwaits HELLO_MS and binds", async () => {
  const srv = serve({ helloLimit: { burst: 1, perSec: 0.5 } });
  const alice = await srv.login(A);
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  // The wait (2s) is four times HELLO_MS: without the extension this fails.
  const s = await srv.session(alice, "fe", { BUS_TEST_HELLO_MS: "500" });
  expect(s.c.getInstructions()).toContain(`identity "fe"`);
}, 15_000);

test("a limited session gives up at the startup cap and says it's the limit", async () => {
  const srv = serve({ helloLimit: { burst: 1, perSec: 0.1 } });
  const alice = await srv.login(A);
  expect((await srv.client(alice, null).connect()).type).toBe("hello_ok");
  await expect(srv.session(alice, "fe", { BUS_TEST_HELLO_MS: "300", BUS_TEST_HELLO_LIMITED_MS: "1000" })).rejects.toThrow(/rate-limiting this user's connections/);
}, 15_000);

// A stand-in server: answers each hello with `reply(n)` for the nth
// connection, and records when each connection and whoami check came.
function stub(reply: (n: number) => Record<string, unknown>) {
  const opens: number[] = [];
  const whoami: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/api/whoami") {
        whoami.push(Date.now());
        return Response.json({});
      }
      if (server.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open: () => void opens.push(Date.now()),
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.type !== "hello") return;
        const r = reply(opens.length);
        ws.send(JSON.stringify({ req_id: m.req_id, ...r }));
        if (r.type === "error") ws.close();
      },
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://localhost:${server.port}`, opens, whoami };
}

function client(url: string): GrayboardClient {
  const c = new GrayboardClient(url, () => "t", mintSessionKey(), async () => {}, async () => {});
  cleanup.push(() => c.close());
  c.connect();
  return c;
}

const HELLO_OK = { type: "hello_ok", id: "id:aaaaaaaaaaaaa", user_email: A, teams: [] };

test("the client waits the server's retry_after_ms and reports why while it waits", async () => {
  const s = stub((n) => (n === 1 ? { type: "error", code: "rate_limited", message: "slow down", retry_after_ms: 300 } : HELLO_OK));
  const c = client(s.url);
  await until(() => c.rateLimited()?.message === "slow down");
  await c.ready();
  expect(c.rateLimited()).toBeNull();
  expect(s.opens.length).toBe(2);
  // Jittered up from the server's wait, never under it.
  expect(s.opens[1]! - s.opens[0]!).toBeGreaterThanOrEqual(300);
  // Under the 1s backoff: the server's wait was used, not the backoff.
  expect(s.opens[1]! - s.opens[0]!).toBeLessThan(950);
  // One token check per connect, none for the limit itself.
  expect(s.whoami.length).toBe(2);
});

test("an open the server closes before hello_ok doesn't reset the backoff", async () => {
  const s = stub(() => ({ type: "error", code: "internal", message: "hello failed" }));
  client(s.url);
  await until(() => s.opens.length >= 3, 6000);
  // 1s, then 2s: an open that never got hello_ok kept the doubled backoff.
  expect(s.opens[2]! - s.opens[1]!).toBeGreaterThanOrEqual(1900);
}, 10_000);
