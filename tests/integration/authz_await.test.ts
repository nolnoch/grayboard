// The application's policy decisions are awaited (#807 P3 A7f2). A session's close and a revalidate's terminate
// change the registry at once, outside the write queue, so state read before a decision's await is read again
// after it; core's synchronous `reach` gets a decision precomputed before core runs; and a page's writer marks
// make one decision per writer.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { refusal } from "../support/app_session.ts";
import { direct } from "../support/events.ts";
import { hostedPause } from "../support/hosted-pause.ts";
import { drained, row, rows } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";

let srv: TestServer;
beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, delegateLimit: { burst: 100, perSec: 100 } });
});
afterEach(async () => { await srv.stop(); });

const userId = async (email: string) => (await row<{ id: number }>(srv, "SELECT id FROM users WHERE email = ?", email))!.id;
const decisions = async (rule: string) => {
  await drained(srv);
  return (await rows<{ detail: string }>(srv, "SELECT detail FROM access_log WHERE action = 'authz.decision' ORDER BY id"))
    .map((r) => JSON.parse(r.detail) as Record<string, unknown>)
    .filter((d) => d.rule === rule);
};
const holds = async (address: string) => { await drained(srv); return rows(srv, "SELECT address FROM alias_holds WHERE address = ?", address); };
const messages = async () => { await drained(srv); return (await row<{ n: number }>(srv, "SELECT COUNT(*) AS n FROM messages"))!.n; };

test("H-A: a recipient that closes while the wake decision awaits gets the queued answer, not delivered_now", async () => {
  const [alice, bob] = await Promise.all([srv.login(A), srv.login(B)]);
  const bfe = await srv.connected(bob, "fe");
  const abe = await srv.connected(alice, "be");
  const res = await hostedPause("send:wake:decided", () => abe.send(`${B}/fe`, "while closing"), async () => { bfe.close(); });
  expect(res.delivered_now).toBe(false);
  expect(res.undelivered_from_you).toBe(1);
  expect(res.note).toBeDefined();
  // Still bob's person alias: the wake decision about bob stands.
  expect(res.wakes).toBe(false);
});

test("H-A: a team alias's holder that closes while the wake decision awaits takes its wake note with it", async () => {
  const [alice, bob] = await Promise.all([srv.login(A), srv.login(B)]);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
  const bfe = await srv.connected(bob, "eng/fe");
  const abe = await srv.connected(alice, "eng/be");
  // Held, the open team's holder is another user's agent that won't wake.
  expect((await abe.send("eng/fe", "held")).wakes).toBe(false);
  const res = await hostedPause("send:wake:decided", () => abe.send("eng/fe", "while closing"), async () => { bfe.close(); });
  expect(res.delivered_now).toBe(false);
  // Unheld, a team alias names no user: no note about the holder that left.
  expect(res.wakes).toBeUndefined();
  expect(res.wake_note).toBeUndefined();
});

for (const point of ["bind:target:decided", "bind:alias:created"]) {
  test(`H-B: a session terminated while its bind awaits (${point}) is refused and holds nothing`, async () => {
    const bob = await srv.login(B);
    const s = await srv.connected(bob, null);
    const bobId = await userId(B);
    const err = await hostedPause(point, () => refusal(s.bind("fe")), async () => { srv.app.application.disconnectUser(bobId); });
    expect(err.code).toBe("unauthenticated");
    expect(await holds(`${B}/fe`)).toEqual([]);
  });
}

test("a malformed delegate naming another user's launcher writes no decision row: core refuses before it asks reach", async () => {
  const [alice, bob] = await Promise.all([srv.login(A), srv.login(B)]);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
  await srv.connected(bob, "eng/launcher", { launcher: true });
  const sim = await srv.connected(alice, "eng/sim");
  expect((await refusal(sim.delegate({ persona: "p", task: "", to: "eng/launcher" }))).code).toBe("bad_request");
  expect(await decisions("delegate.cross_user")).toEqual([]);
  // The same call well-formed asks reach, which denies and writes its row.
  await refusal(sim.delegate({ persona: "p", task: "t", to: "eng/launcher" }));
  expect(await decisions("delegate.cross_user")).toEqual([expect.objectContaining({ verb: "delegate.to", allow: false, from_user: A, to_user: B })]);
});

test("a page of one writer's messages makes one wake decision", async () => {
  const [alice, bob] = await Promise.all([srv.login(A), srv.login(B)]);
  const abe = await srv.connected(alice, "be");
  const bfe = await srv.connected(bob, "fe");
  for (const body of ["one", "two", "three"]) await bfe.send(`${A}/be`, body);
  for (let i = 0; i < 3; i++) await abe.next(direct());
  const spy = spyOn(srv.app.repo.teams, "shareCollaborative");
  try {
    const page = await abe.history({ peer: `${B}/fe` });
    expect(page.length).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

// `valid`'s user read awaits (#807 P3 A7u1): a session closed meanwhile is refused after it, before the operation
// writes anything.
test("a session closed while its bind's user read awaits is refused and holds nothing", async () => {
  const bob = await srv.login(B);
  const s = await srv.connected(bob, null);
  const err = await hostedPause("valid:user:read", () => refusal(s.bind("fe")), async () => { s.close(); });
  expect(err.code).toBe("unauthenticated");
  expect(err.message).toBe("session is closed");
  expect(await holds(`${B}/fe`)).toEqual([]);
  expect(await rows(srv, "SELECT event FROM binding_events WHERE name = ? AND event = 'bound'", `${B}/fe`)).toEqual([]);
});

test("a session closed while its send's user read awaits is refused and writes no message", async () => {
  const [alice, bob] = await Promise.all([srv.login(A), srv.login(B)]);
  await srv.connected(bob, "fe");
  const abe = await srv.connected(alice, "be");
  const before = await messages();
  const err = await hostedPause("valid:user:read", () => refusal(abe.send(`${B}/fe`, "while closing")), async () => { abe.close(); });
  expect(err.code).toBe("unauthenticated");
  expect(err.message).toBe("session is closed");
  expect(await messages()).toBe(before);
});
