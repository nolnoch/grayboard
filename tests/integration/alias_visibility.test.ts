// #348: a team's alias names reach only the team and its members, as its
// boards and roster do. To anyone else the team reads as missing: no
// peer_list row (global or a board's roster), no `match` or offline-count
// probe, no name suggestion in a refused DM. People's names stay the open
// directory, and mail to a team alias by its exact handle stays open
// (vision.md principle 9; msg.wake keeps it from waking anyone).
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WhoResult } from "../../src/core/boards.ts";
import type { AppSession } from "../support/app_session.ts";
import { direct } from "../support/events.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";

const ADMIN = "dana@example.com";
let srv: TestServer;
let alice: string;
let bob: string;
let carol: string;

beforeEach(async () => {
  srv = new TestServer({ admins: [ADMIN], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login("alice@example.com");
  bob = await srv.login("bob@example.com");
  carol = await srv.login("carol@example.com");
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
});
afterEach(async () => {
  await closeSessions();
  await srv.stop();
});

const handles = async (c: AppSession, args: Record<string, unknown> = {}) =>
  (await c.call<WhoResult>("peer_list", args)).peers.map((p) => p.handle).sort();

test("peer_list lists a team's aliases to its members only: global, include_offline, match and the offline count", async () => {
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  // An offline team alias: its session closed, its hold kept.
  const old = srv.appSession(bob, "eng/old", { bind: { create: true } });
  await old.connect();
  old.close();
  const member = srv.appSession(alice, "fe");
  await member.connect();
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();

  expect(await handles(member, { include_offline: true })).toEqual(expect.arrayContaining(["eng/build", "eng/old"]));
  expect(await handles(member, { match: { scope: "eng" } })).toEqual(["eng/build"]);
  const memberView = await member.call<WhoResult>("peer_list", {});
  expect(memberView.offline_hidden).toBeGreaterThanOrEqual(1);

  // The outsider sees people, never the team's names.
  const all = await handles(outsider, { include_offline: true });
  expect(all).toEqual(expect.arrayContaining(["alice@example.com/fe"]));
  expect(all.filter((h) => h.startsWith("eng/"))).toEqual([]);
  expect(await handles(outsider, { match: { scope: "eng" } })).toEqual([]);
  expect(await handles(outsider, { match: { id: build.id } })).toEqual([]);
  // eng/old is offline: counted for the member, not for the outsider.
  const outsiderView = await outsider.call<WhoResult>("peer_list", {});
  expect(outsiderView.offline_hidden ?? 0).toBe((memberView.offline_hidden ?? 0) - 1);

  // An admin outside the team sees no more than any non-member: admin is a server role, not a directory grant.
  const admin = srv.appSession(await srv.login(ADMIN), "ops");
  await admin.connect();
  expect((await handles(admin, { include_offline: true })).filter((h) => h.startsWith("eng/"))).toEqual([]);

  // The holder always sees its own row.
  expect(await handles(build)).toContain("eng/build");
});

test("a board's roster hides a subscribed team alias from a non-member", async () => {
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();
  await outsider.call("board_create", { name: "general", purpose: "open" });
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  await build.call("board_subscribe", { board: "general", mode: "push" });
  const member = srv.appSession(alice, "fe");
  await member.connect();
  await member.call("board_subscribe", { board: "general", mode: "push" });

  expect(await handles(member, { board: "general" })).toEqual(expect.arrayContaining(["eng/build", "alice@example.com/fe"]));
  const roster = await handles(outsider, { board: "general" });
  expect(roster).toContain("alice@example.com/fe");
  expect(roster).not.toContain("eng/build");
});

test("a refused bare name suggests only full handles the sender may see; hidden reads as absent", async () => {
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  const member = srv.appSession(alice, "fe");
  await member.connect();
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();

  await expect(member.send("build", "hi")).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("name it in full: eng/build") });
  const refused = async (c: AppSession, to: string) => {
    try { await c.send(to, "hi"); } catch (e) { return { code: (e as any).code, message: (e as Error).message }; }
    throw new Error(`send to ${to} landed`);
  };
  // Hidden and nonexistent answer alike, name aside.
  const hidden = await refused(outsider, "build");
  const absent = await refused(outsider, "nosuch");
  expect(hidden).toEqual({ code: absent.code, message: absent.message.replace(`"nosuch"`, `"build"`) });
  expect(hidden.message).not.toContain("eng/");
  // history's peer resolves the same way.
  const histRefused = async (peer: string) => {
    try { await outsider.history({ peer }); } catch (e) { return (e as Error).message; }
    throw new Error(`history of ${peer} answered`);
  };
  expect(await histRefused("build")).toBe((await histRefused("nosuch")).replace(`"nosuch"`, `"build"`));
  // A person's alias of the same name is still suggested to anyone.
  const bobBuild = srv.appSession(bob, "build");
  await bobBuild.connect();
  const named = await refused(outsider, "build");
  expect(named.message).toContain("bob@example.com/build");
  expect(named.message).not.toContain("eng/build");

  // Mail by exact handle stays open (principle 9): it lands, and msg.wake keeps it unwoken.
  const sent = await outsider.send("eng/build", "by name");
  expect(sent.message_id).toBeGreaterThan(0);
  await build.next(direct((m) => m.body === "by name"));
});
