// #284 S9: team membership is checked for the life of a hold, not only at
// bind. A user who leaves a team, or is removed, stops acting as its aliases:
// a holder keeps its ID, a tools-only connection writing as one ends, and
// revalidate() is the backstop for a membership changed behind the server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import type { Any } from "../support/ws_client.ts";

const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  srv = new TestServer();
  alice = await srv.login("alice@example.com");
  bob = await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(async () => {
  await closeSessions();
  srv.stop();
});

const rows = (sql: string, ...args: string[]) => srv.app.db.query(sql).all(...args);
const holder = (address: string) => rows(`SELECT id FROM alias_holds WHERE address = ?`, address).map((r: any) => r.id);
const lastEvent = (address: string) => rows(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`, address)[0];
const revoked = () => rows(`SELECT actor, target, detail FROM access_log WHERE action = 'alias.revoked' ORDER BY id`).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
const REASON = `${B} isn't a member of team eng`;

test("a removed member's sessions lose the team's aliases: a holder keeps its ID, a tools-only writer ends, a grace hold is dropped", async () => {
  const build = srv.client(bob, "eng/build");
  expect((await build.connect()).bind_ok.alias).toBe("eng/build");
  const writer = srv.client(bob, "eng/build", { push: false });
  expect(await writer.connect()).toMatchObject({ type: "hello_ok" });
  const deploy = srv.client(bob, "eng/deploy");
  await deploy.connect();
  deploy.close();
  await until(() => rows(`SELECT 1 FROM access_log WHERE action = 'id.detached' AND target = ?`, deploy.id).length > 0);
  // bob's own alias is untouched.
  const own = srv.client(bob, "be");
  await own.connect();

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);

  expect(await build.next((m: Any) => m.type === "alias_lost")).toEqual({ type: "alias_lost", alias: "eng/build", reason: REASON });
  expect(holder("eng/build")).toEqual([]);
  expect(lastEvent("eng/build")).toEqual({ session_id: build.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder("eng/deploy")).toEqual([]);
  expect(lastEvent("eng/deploy")).toEqual({ session_id: deploy.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder(`${B}/be`)).toEqual([own.id]);
  await own.none((m: Any) => m.type === "alias_lost");

  // The holder is live and acts as its ID now.
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, build.id)).toEqual([{ ended_at: null }]);
  const sent = await build.request({ type: "send", recipient: `${B}/be`, body: "still here" });
  expect(sent).toMatchObject({ type: "send_ok" });
  expect(rows(`SELECT sender FROM messages WHERE id = ?`, String(sent.message_id))).toEqual([{ sender: build.id }]);
  expect((await build.bind("eng/build")).code).toBe("forbidden");

  // The tools-only writer had nothing else to be: refused, closed, ended.
  expect(await writer.next((m: Any) => m.type === "error")).toMatchObject({ code: "forbidden", message: `this connection wrote as "eng/build", and ${REASON}` });
  expect(rows(`SELECT ended_at IS NOT NULL AS ended FROM ids WHERE id = ?`, writer.id)).toEqual([{ ended: 1 }]);
  expect((await srv.client(bob, "eng/build", { push: false }).connect()).code).toBe("forbidden");

  const audited = revoked();
  expect(audited).toHaveLength(3);
  expect(audited).toEqual(expect.arrayContaining([
    { actor: B, target: "eng/build", detail: { session: build.id, reason: REASON } },
    { actor: B, target: "eng/build", detail: { session: writer.id, writes_as: true, reason: REASON } },
    { actor: B, target: "eng/deploy", detail: { session: deploy.id, reason: REASON } },
  ]));
  // A member can take the freed alias.
  expect((await srv.client(alice, "eng/build").connect()).bind_ok.alias).toBe("eng/build");
});

test("leaving a team releases its aliases from the leaver's sessions; revalidate catches a membership changed behind the server", async () => {
  const build = srv.client(bob, "eng/build");
  await build.connect();
  expect((await srv.api(bob, "POST", "/api/teams/eng/leave")).status).toBe(200);
  expect(await build.next((m: Any) => m.type === "alias_lost")).toMatchObject({ alias: "eng/build" });

  // Rejoin, rebind, then lose the membership without the HTTP route.
  await srv.api(alice, "POST", "/api/teams/eng/add", { email: B });
  expect((await build.bind("eng/build")).type).toBe("bind_ok");
  const team = srv.app.repo.teams.findByName("eng")!;
  srv.app.repo.teams.removeMember(team.id, srv.app.repo.users.findByEmail(B)!.id);
  await build.none((m: Any) => m.type === "alias_lost");
  srv.app.revalidate();
  expect(await build.next((m: Any) => m.type === "alias_lost")).toEqual({ type: "alias_lost", alias: "eng/build", reason: REASON });
  // A member's hold survives the backstop.
  const kept = srv.client(alice, "eng/build");
  await kept.connect();
  srv.app.revalidate();
  expect(holder("eng/build")).toEqual([kept.id]);
});

test("the plugin drops a lost team alias and says so in the next tool result", async () => {
  const s = await srv.session(bob, "eng/build");
  expect((await s.call("peer_list", {})).you).toBe("eng/build");
  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  await until(() => s.stderr().includes(`lost "eng/build"`));
  const r = await s.c.callTool({ name: "peer_list", arguments: {} });
  const id = JSON.parse((r.content as { text: string }[])[0]!.text).you;
  expect(id).toMatch(/^id:[0-9a-z]{13}$/);
  expect((r.content as { text: string }[]).slice(1).map((c) => c.text)).toContain(
    `This session lost its bus name "eng/build": ${REASON}. It acts as its ID (${id}) now: bind(name) to take another.`,
  );
  expect((r.structuredContent as { name: string | null }).name).toBeNull();
}, 20_000);
