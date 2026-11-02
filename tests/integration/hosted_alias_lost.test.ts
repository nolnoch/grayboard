// #453: a hosted root that loses a hold server-side (an access revocation,
// revokeAliases) is told once, as the plugin tells a WSS session on its
// alias_lost frame: the root's next native whoami (an `alias_lost` field and
// the notice) or tool result (the notice, after a refusal too) carries it.
// The subscriber's whoami (the Controller's) takes its own copy, so the
// Controller learns of the loss whichever reads first; a hold both took is
// deleted. A child's calls neither see nor take it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { bindingOf } from "../../adapters/hosted-core/src/model.ts";
import type { HostedSession } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const REASON = `${B} isn't a member of team eng`;
let srv: TestServer;
let alice: string;

beforeEach(async () => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(() => srv.stop());

const revoke = async () => expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
const texts = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : c.type));
const json = (r: CallToolResult) => JSON.parse(texts(r)[0]!);
const lostNotice = (tail: string) => `This session lost its bus name "eng/build": ${REASON}. ${tail}`;
const notified = () => srv.app.db.query<{ actor: string; target: string; detail: string }, []>("SELECT actor, target, detail FROM access_log WHERE action = 'hosted.alias_lost_notified' ORDER BY id").all()
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
const rootId = (s: HostedSession) => srv.app.db.query<{ session_id: string }, [string]>("SELECT session_id FROM hosted_sessions WHERE source_session_id = ?").get(s.sessionId)!.session_id;
const pending = () => srv.app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM hosted_alias_lost").get()!.n;

test("the Controller's whoami reports alias_lost once; the native whoami then carries it and the notice once; audited, then deleted", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();

  // The Controller's whoami (hosted-core's own Wire and validation) takes its copy: once, unaudited, the agent's left.
  expect(bindingOf(await b.subscriber.call("whoami"))).toMatchObject({ held: [`${B}/fe`], alias_lost: [{ alias: "eng/build", reason: REASON }] });
  expect(await b.subscriber.call("whoami")).not.toHaveProperty("alias_lost");
  expect(notified()).toEqual([]);
  expect(pending()).toBe(1);

  const told = await b.callRaw("whoami");
  expect(json(told)).toMatchObject({ held: [`${B}/fe`], primary: `${B}/fe`, alias_lost: [{ alias: "eng/build", reason: REASON }] });
  expect(texts(told).slice(1)).toEqual([lostNotice(`It still sends as "fe".`)]);

  const again = await b.callRaw("whoami");
  expect(texts(again)).toHaveLength(1);
  expect(json(again)).not.toHaveProperty("alias_lost");
  expect(texts(await b.callRaw("board_list"))).toHaveLength(1);
  expect(pending()).toBe(0);

  const row = srv.app.repo.hosted.get(rootId(b))!;
  expect(notified()).toEqual([{ actor: B, target: row.session_id, detail: { aliases: ["eng/build"], ownership: row.ownership_id, client_id: "grayboard-pi" } }]);
});

test("the next tool result carries the notice once, naming the new primary when the lost hold was it; the Controller's whoami still reports the loss after", async () => {
  const b = await srv.hosted(B, "eng/build");
  await b.bind("fe");
  await revoke();

  const told = await b.callRaw("board_list");
  expect(told.isError).toBeUndefined();
  expect(texts(told).slice(1)).toEqual([lostNotice(`It sends as "fe" now.`)]);
  expect(texts(await b.callRaw("board_list"))).toHaveLength(1);
  const who = await b.callRaw("whoami");
  expect(texts(who)).toHaveLength(1);
  expect(json(who)).toMatchObject({ held: [`${B}/fe`], primary: `${B}/fe` });
  expect(json(who)).not.toHaveProperty("alias_lost");
  expect(notified()).toHaveLength(1);

  // The agent's call beat the Controller's reopen; the Controller still learns the shrunken set was a loss.
  expect(await b.subscriber.call("whoami")).toMatchObject({ held: [`${B}/fe`], alias_lost: [{ alias: "eng/build", reason: REASON }] });
  expect(pending()).toBe(0);
});

test("a root that lost its only hold is told on its next call, though the write is refused as unbound", async () => {
  const b = await srv.hosted(B, "eng/build");
  await revoke();

  const refused = await b.callRaw("dm_send", { to: `${A}/be`, body: "hi" });
  expect(refused.isError).toBe(true);
  expect(texts(refused)).toEqual([expect.stringMatching(/^error: unbound/), lostNotice("It has no bus name now, so it only reads: bind(name) to take another.")]);
  const who = await b.callRaw("whoami");
  expect(texts(who)).toHaveLength(1);
  expect(json(who)).toMatchObject({ held: [], primary: null, unbound: true });
  expect(json(who)).not.toHaveProperty("alias_lost");
  expect(notified()).toHaveLength(1);
  expect(await b.subscriber.call("whoami")).toMatchObject({ held: [], unbound: true, alias_lost: [{ alias: "eng/build", reason: REASON }] });
  expect(pending()).toBe(0);
});

test("a child's whoami and tool results neither carry nor take its root's notice", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await b.subscriber.call("session_register", { child: "child-run" });
  const child = await srv.hosted(B, null, { sessionId: "child-run", delivery: false });
  await revoke();

  const who = await child.callRaw("whoami");
  expect(texts(who)).toHaveLength(1);
  expect(json(who)).toMatchObject({ held: [`${B}/fe`], child: true });
  expect(json(who)).not.toHaveProperty("alias_lost");
  expect(texts(await child.callRaw("board_list"))).toHaveLength(1);
  expect(notified()).toEqual([]);

  expect(texts(await b.callRaw("board_list")).slice(1)).toEqual([lostNotice(`It still sends as "fe".`)]);
});
