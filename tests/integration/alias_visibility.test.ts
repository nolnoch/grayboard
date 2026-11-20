// #348: a team's alias names reach only the team and its members, as its
// boards and roster do. To anyone else the team reads as missing: no
// peer_list row (global or a board's roster), no `match` or offline-count
// probe, no name suggestion in a refused DM, and mail or a delegation to its
// exact handle is refused as for a name nobody has (#1014), except a reply in
// a DM thread with it. People's names stay the open directory (vision.md
// principle 9).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { WhoResult } from "../../src/core/boards.ts";
import type { AppSession } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { txSpy } from "../support/repo_sql.ts";

const ADMIN = "dana@example.com";
let srv: TestServer;
let alice: string;
let bob: string;
let carol: string;

beforeEach(async () => {
  srv = await TestServer.open({ admins: [ADMIN], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
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

  // Its exact handle reads as one nobody has, too (#1014); a member's mail lands.
  const exact = await refused(outsider, "eng/build");
  const none = await refused(outsider, "eng/nosuch");
  expect(exact).toEqual({ code: "not_found", message: none.message.replace(`"eng/nosuch"`, `"eng/build"`) });
  await member.send("eng/build", "from a member");
  await build.next(direct((m) => m.body === "from a member"));
});

test("mail and delegation to a team alias's exact handle read as a name nobody has outside the team, live or offline; a DM thread with it stays answerable (#1014)", async () => {
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  const old = srv.appSession(bob, "eng/old", { bind: { create: true } });
  await old.connect();
  old.close();

  const answer = async (fn: () => Promise<unknown>, name: string) => {
    try { await fn(); } catch (e) { return JSON.stringify({ code: (e as any).code, message: (e as Error).message }).replaceAll(name, "NAME"); }
    throw new Error(`call naming ${name} landed`);
  };
  const absent = await answer(() => outsider.send("eng/nosuch", "hi"), "eng/nosuch");
  expect(absent).toContain("not_found");
  expect(await answer(() => outsider.send("eng/build", "hi"), "eng/build")).toBe(absent);
  expect(await answer(() => outsider.send("eng/old", "hi"), "eng/old")).toBe(absent);
  // A scope nobody has answers alike, so a team's existence doesn't show either.
  expect(await answer(() => outsider.send("nosuchteam/x", "hi"), "nosuchteam/x")).toBe(absent);

  // delegate's explicit `to`, before any grant is judged.
  const delegated = async (to: string) => answer(() => outsider.delegate({ persona: "a researcher", task: "t", to }), to);
  expect(await delegated("eng/build")).toBe(await delegated("eng/nosuch"));

  // A DM thread with the team alias is answerable by parent_id; a fresh message to it still isn't.
  const first = await build.send(`carol@example.com/qa`, "from the team");
  await outsider.next(direct((m) => m.body === "from the team"));
  const reply = await outsider.send("eng/build", "reply", { parent_id: first.message_id });
  expect(reply.message_id).toBeGreaterThan(0);
  await build.next(direct((m) => m.body === "reply"));
  expect(await answer(() => outsider.send("eng/build", "fresh"), "eng/build")).toBe(absent);
  // A parent_id from the outsider's thread with someone else, or one it isn't party to, doesn't open it.
  const member = srv.appSession(alice, "fe");
  await member.connect();
  const other = await outsider.send("alice@example.com/fe", "elsewhere");
  expect(await answer(() => outsider.send("eng/build", "via another thread", { parent_id: other.message_id }), "eng/build")).toBe(absent);
  const notMine = await member.send("eng/build", "members only");
  expect(await answer(() => outsider.send("eng/build", "via a thread not mine", { parent_id: notMine.message_id }), "eng/build")).toBe(absent);
});

test("a post's bare @name suggests only names the poster may see, and its result names only recipients it may see", async () => {
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();
  await outsider.call("board_create", { name: "general", purpose: "open" });
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  await build.call("board_subscribe", { board: "general", mode: "push" });
  const member = srv.appSession(alice, "fe");
  await member.connect();

  // A member is refused with the full handle; to the outsider the team's name is as absent as a missing one.
  await expect(member.call("board_post", { board: "general", body: "@build hi" })).rejects.toThrow("name it in full: eng/build");
  const hidden = await outsider.call<{ notified: string[]; unresolved?: string[] }>("board_post", { board: "general", body: "@build hi" });
  const absent = await outsider.call<{ notified: string[]; unresolved?: string[] }>("board_post", { board: "general", body: "@nosuch hi" });
  expect(hidden.unresolved).toEqual(["build"]);
  expect(absent.unresolved).toEqual(["nosuch"]);

  // The subscriber is still woken; only the poster's view of who was is cut.
  expect(hidden.notified).not.toContain("eng/build");
  await build.next(board((i) => i.kind === "push" && i.post.body === "@build hi"));
  const shown = await member.call<{ notified: string[] }>("board_post", { board: "general", body: "for the team" });
  expect(shown.notified).toContain("eng/build");
});

test("suggestions follow the session's user, not the team address it acts as", async () => {
  expect((await srv.api(bob, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  const run = srv.appSession(bob, "ops/run", { bind: { create: true } });
  await run.connect();
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();
  await outsider.call("board_create", { name: "general", purpose: "open" });
  // Bob's session acting as eng/build sees ops/run in peer_list, so a bare "run" names it too.
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  expect(await handles(build)).toContain("ops/run");
  await expect(build.send("run", "hi")).rejects.toMatchObject({ message: expect.stringContaining("name it in full: ops/run") });
  await expect(build.call("board_post", { board: "general", body: "@run hi" })).rejects.toThrow("name it in full: ops/run");
});

// #1020: to a non-member, a team that exists refuses exactly as one that
// doesn't, in each team-scoped refusal: board_create, bind (app and hosted,
// the reserved human name too), an app writes_as and an HTTP `as`.
test("a team-scoped refusal reads the same to a non-member whether or not the team exists", async () => {
  // The refusal for eng, and for nosuch with its name put back as eng.
  const both = async (refused: (team: string) => Promise<unknown>) => {
    const one = async (team: string) => {
      const e = await refused(team);
      return JSON.stringify(e).replaceAll(team, "TEAM");
    };
    const [real, missing] = [await one("eng"), await one("nosuch")];
    expect(real).toBe(missing);
    return JSON.parse(real) as Record<string, unknown>;
  };
  const err = (p: Promise<unknown>) => p.then(() => ({ ok: true }), (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();

  expect(await both((t) => err(outsider.call("board_create", { name: "plans", purpose: "p", team: t })))).toEqual({ code: "bad_request", message: 'no such team "TEAM"' });
  expect(await both((t) => err(outsider.bind(`${t}/x`)))).toEqual({ code: "not_found", message: '"TEAM/x": no team or service is named "TEAM"' });
  expect(await both((t) => err(outsider.bind(`${t}/human`)))).toMatchObject({ code: "forbidden" });
  expect(await both((t) => err(srv.appSession(carol, `${t}/x`, { push: false }).connect()))).toMatchObject({ code: "not_found" });
  const hosted = await srv.hosted("carol@example.com", null);
  expect(await both((t) => err(hosted.call("bind", { name: `${t}/x`, create: true })))).toMatchObject({ code: "not_found" });
  const http = await both((t) => srv.api(carol, "POST", "/api/claims/call", { as: `${t}/x`, tool: "claim_take", args: { key: "k" } }));
  expect(http).toMatchObject({ status: 403, body: { code: "forbidden", message: `you can't act as "TEAM/x": no principal owns its scope` } });
});

// #807 P1c-14b: the reply check reads the parent on the send body's Tx, not the pool.
test("a reply to a team alias reads its parent on the send body's Tx (#807 P1c-14b)", async () => {
  const outsider = srv.appSession(carol, "qa");
  await outsider.connect();
  const build = srv.appSession(bob, "eng/build", { bind: { create: true } });
  await build.connect();
  const first = await build.send("carol@example.com/qa", "from the team");
  await outsider.next(direct((m) => m.body === "from the team"));
  const repo = srv.app.repo;
  const checks: string[] = [];
  const tx = txSpy(srv);
  const original = repo.messages.getById.bind(repo.messages);
  const spy = spyOn(repo.messages, "getById").mockImplementation((r, id) => {
    if (new Error().stack?.includes("replyingTo")) checks.push(`${r === repo.read ? "pool" : "tx"}:${tx.open}`);
    return original(r, id);
  });
  try {
    expect((await outsider.send("eng/build", "reply", { parent_id: first.message_id })).message_id).toBeGreaterThan(0);
  } finally { spy.mockRestore(); tx.restore(); }
  expect(checks).toEqual(["tx:true"]);
});
