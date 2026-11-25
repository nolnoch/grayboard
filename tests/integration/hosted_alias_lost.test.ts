// #453: a hosted root that loses a hold server-side (an access revocation,
// revokeAliases) is told once, as the plugin tells a WSS session on its
// alias_lost frame: the root's next native whoami (an `alias_lost` field and
// the notice) or tool result (the notice, after a refusal too) carries it.
// The subscriber's whoami (the Controller's) is reported its own copy until
// its next delivery_open, so the Controller learns of the loss whichever
// reads first and a lost response loses nothing; a hold both took is
// deleted, and so is one bound again. A child's calls neither see nor take it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { bindingOf } from "../../adapters/hosted-core/src/model.ts";
import { accessAudits } from "../support/audit.ts";
import { HOSTED_CLIENT, type HostedSession } from "../support/hosted_session.ts";
import { seed } from "../support/seed.ts";
import { TestServer } from "../support/server.ts";
import { drained, row as sqlRow, rows } from "../support/repo_sql.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const REASON = `${B} isn't a member of team eng`;
let srv: TestServer;
let alice: string;

beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
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
const audits = (action: string) => accessAudits(srv, action);
const notified = () => audits("hosted.alias_lost_notified");
const LOST = [{ alias: "eng/build", reason: REASON }];
const rootId = async (s: HostedSession) => (await sqlRow<{ session_id: string }>(srv, "SELECT session_id FROM hosted_sessions WHERE source_session_id = ?", s.sessionId))!.session_id;
const pending = async () => { await drained(srv); return (await sqlRow<{ n: number }>(srv, "SELECT count(*) AS n FROM hosted_alias_lost"))!.n; };

test("the Controller's whoami reports alias_lost until its delivery_open; the native whoami carries it and the notice once; audited, then deleted", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();

  // The Controller's whoami (hosted-core's own Wire and validation) is reported its copy, unaudited, until it
  // opens delivery: a whoami whose response was lost costs nothing.
  expect(bindingOf(await b.subscriber.call("whoami"))).toMatchObject({ held: [`${B}/fe`], alias_lost: LOST });
  expect(await b.subscriber.call("whoami")).toMatchObject({ alias_lost: LOST });
  expect(await notified()).toEqual([]);

  const told = await b.callRaw("whoami");
  expect(json(told)).toMatchObject({ held: [`${B}/fe`], primary: `${B}/fe`, alias_lost: LOST });
  expect(texts(told).slice(1)).toEqual([lostNotice(`It still sends as "fe".`)]);
  expect(told._meta).toMatchObject({ "io.github.nolnoch.grayboard/alias_lost": true });

  const again = await b.callRaw("whoami");
  expect(texts(again)).toHaveLength(1);
  expect(json(again)).not.toHaveProperty("alias_lost");
  expect(again._meta?.["io.github.nolnoch.grayboard/alias_lost"]).toBeUndefined();
  expect(texts(await b.callRaw("board_list"))).toHaveLength(1);
  expect(await pending()).toBe(1);

  await b.subscriber.call("delivery_open");
  expect(await b.subscriber.call("whoami")).not.toHaveProperty("alias_lost");
  expect(await pending()).toBe(0);

  const row = (await srv.app.repo.hosted.get(srv.app.repo.read, await rootId(b)))!;
  const detail = { aliases: ["eng/build"], ownership: row.ownership_id, client_id: HOSTED_CLIENT };
  expect(await notified()).toMatchObject([{ actor: B, target: row.session_id, detail }]);
  expect(await audits("hosted.alias_lost_seen")).toMatchObject([{ actor: B, target: row.session_id, detail }]);
});

test("a delivery_open takes only the losses a Controller's whoami reported", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();

  // No whoami reported it: the Controller hasn't applied it, so the open leaves it pending.
  await b.subscriber.call("delivery_open");
  expect(await audits("hosted.alias_lost_seen")).toEqual([]);
  expect(await b.subscriber.call("whoami")).toMatchObject({ alias_lost: LOST });
});

test("a lost hold bound again is no longer lost: neither reader is told it", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);

  await b.bind("eng/build");
  expect(await pending()).toBe(0);
  expect(await b.subscriber.call("whoami")).not.toHaveProperty("alias_lost");
  expect(texts(await b.callRaw("whoami"))).toHaveLength(1);
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
  expect(await notified()).toHaveLength(1);

  // The agent's call beat the Controller's reopen; the Controller still learns the shrunken set was a loss.
  expect(await b.subscriber.call("whoami")).toMatchObject({ held: [`${B}/fe`], alias_lost: LOST });
  await b.subscriber.call("delivery_open");
  expect(await pending()).toBe(0);
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
  expect(await notified()).toHaveLength(1);
  expect(await b.subscriber.call("whoami")).toMatchObject({ held: [], unbound: true, alias_lost: LOST });
  // An unbound root opens no delivery, so the Controller keeps being reported it until a bind and an open.
  expect(await pending()).toBe(1);
  await b.bind("fe");
  expect(await pending()).toBe(0);
});

test("a root that lost a hold can't send or post as it; its other name still writes (#408)", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "eng/build");
  await b.bind("fe");
  await revoke();

  for (const [tool, args] of [["dm_send", { to: `${A}/be`, body: "as lost" }], ["board_post", { board: "e2e", body: "as lost" }]] as const) {
    const refused = await b.callRaw(tool, { ...args, as: "eng/build" });
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toContain(`"eng/build" isn't one of this session's addresses`);
  }
  await drained(srv);
  expect(await sqlRow(srv, "SELECT count(*) AS n FROM messages WHERE body = 'as lost'")).toEqual({ n: 0 });
  expect(await sqlRow(srv, "SELECT count(*) AS n FROM posts WHERE body = 'as lost'")).toEqual({ n: 0 });
  await b.call("dm_send", { to: `${A}/be`, body: "as fe" });
  expect(await rows(srv, "SELECT sender FROM messages WHERE body = 'as fe'")).toEqual([{ sender: `${B}/fe` }]);
  await a.close();
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
  expect(await notified()).toEqual([]);

  expect(texts(await b.callRaw("board_list")).slice(1)).toEqual([lostNotice(`It still sends as "fe".`)]);
});

test("a hold lost again before both readers took it is restated: the new reason, and both readers are told afresh", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();
  // The agent took it and the Controller was reported it; neither has finished with it (no delivery_open yet).
  expect(texts(await b.callRaw("whoami")).slice(1)).toEqual([lostNotice(`It still sends as "fe".`)]);
  expect(await b.subscriber.call("whoami")).toMatchObject({ alias_lost: LOST });

  // A second loss of the same alias (lose's ON CONFLICT path) replaces the row and clears both readers' marks.
  const again = "eng/build was revoked again";
  const root = await rootId(b);
  await seed(srv.app.repo, tx => srv.app.repo.hosted.lose(tx, root, { alias: "eng/build", reason: again, primary: false }, Date.now()));
  expect(await pending()).toBe(1);
  // The open now takes nothing: the restated row's report was cleared, so the Controller must see it again first.
  await b.subscriber.call("delivery_open");
  expect(await pending()).toBe(1);
  expect(texts(await b.callRaw("whoami")).slice(1)).toEqual([`This session lost its bus name "eng/build": ${again}. It still sends as "fe".`]);
  expect(await b.subscriber.call("whoami")).toMatchObject({ alias_lost: [{ alias: "eng/build", reason: again }] });
  await b.subscriber.call("delivery_open");
  expect(await pending()).toBe(0);
});

test("an ownership's end deletes its unread losses (the hosted_sessions cascade)", async () => {
  const b = await srv.hosted(B, "fe");
  await b.bind("eng/build");
  await revoke();
  expect(await pending()).toBe(1);

  await b.end();
  expect(await pending()).toBe(0);
});
