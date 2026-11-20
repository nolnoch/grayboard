// #871 (follow-up to #348): a team's alias names reach only the team and its members, so to anyone else a claim a
// team alias holds reads as held by nobody named (claim_list, claim_take's refusal, claim_release's and claim_watch's
// errors, HTTP /api/claims), its note withheld with it; and a board_post @mention of a team alias the poster may not
// see comes back in `unresolved`, in its place, as a name nobody has would. Delivery is unchanged. A person's names
// stay the open directory.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
let srv: TestServer;
let alice: string;
let carol: string;

beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  await srv.login(B);
  carol = await srv.login(C);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(() => srv.stop());

type Listed = { key: string; holder: string | null; note: string | null };
const row = (rows: Listed[], key: string) => rows.find((r) => r.key === key);

test("a team alias's claim reads as held by nobody named outside the team; a person's holder stays listed", async () => {
  const build = await srv.hosted(B, null);
  await build.call("bind", { name: "eng/build", create: true });
  await build.call("claim_take", { key: "ticket:ENG-1", note: "eng's secret plan" });
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("claim_take", { key: "ticket:ENG-2", note: "bob's" });
  const cqa = await srv.hosted(C, "qa");
  const ahost = await srv.hosted(A, "be");

  // claim_list: hidden to carol, shown to alice (a member); bob's person alias shown to both.
  expect(row(await cqa.call<Listed[]>("claim_list", {}), "ticket:ENG-1")).toMatchObject({ holder: null, note: null });
  expect(row(await cqa.call<Listed[]>("claim_list", {}), "ticket:ENG-2")).toMatchObject({ holder: `${B}/fe`, note: "bob's" });
  expect(row(await ahost.call<Listed[]>("claim_list", {}), "ticket:ENG-1")).toMatchObject({ holder: "eng/build", note: "eng's secret plan" });

  // claim_take's refusal.
  expect(await cqa.call("claim_take", { key: "ticket:ENG-1" })).toMatchObject({ ok: false, held_by: null, note: null });
  expect(await ahost.call("claim_take", { key: "ticket:ENG-1" })).toMatchObject({ ok: false, held_by: "eng/build", note: "eng's secret plan" });

  // claim_release's and claim_watch's errors name no hidden holder.
  const released = await cqa.call("claim_release", { key: "ticket:ENG-1" }).catch((e: unknown) => e as Error);
  expect(released).toBeInstanceOf(HostedToolError);
  expect((released as Error).message).toContain(`"ticket:ENG-1" is held by someone else`);
  expect((released as Error).message).not.toContain("eng/build");
  const watched = await cqa.call("claim_watch", { key: "ticket:ENG-1" }).catch((e: unknown) => e as Error);
  expect((watched as Error).message).toContain("ask its holder");
  expect((watched as Error).message).not.toContain("eng/build");
  const memberWatch = await ahost.call("claim_watch", { key: "ticket:ENG-1" }).catch((e: unknown) => e as Error);
  expect((memberWatch as Error).message).toContain("ask eng/build");

  // HTTP /api/claims, as `grayboard claims` reads it.
  const listed = async (token: string) => (await srv.api(token, "GET", "/api/claims")).body as Listed[];
  expect(row(await listed(carol), "ticket:ENG-1")).toMatchObject({ holder: null, note: null });
  expect(row(await listed(carol), "ticket:ENG-2")).toMatchObject({ holder: `${B}/fe` });
  expect(row(await listed(alice), "ticket:ENG-1")).toMatchObject({ holder: "eng/build", note: "eng's secret plan" });
});

test("a non-member's @mention of a team alias reads as one that matched nobody, in its place; a member's resolves", async () => {
  const build = await srv.hosted(B, null);
  await build.call("bind", { name: "eng/build", create: true });
  const ahost = await srv.hosted(A, "be");
  await ahost.call("board_create", { name: "lobby", purpose: "general" });
  const cqa = await srv.hosted(C, "qa");
  const result = async (name: string) => {
    const { post_id: _id, ...r } = await cqa.call<{ post_id: number }>("board_post", { board: "lobby", body: `@nobody1 @${name} @nobody2 hello` });
    return r;
  };
  // The whole result, with the name swapped, is the same for an alias carol can't see and one nobody has.
  const real = JSON.stringify(await result("eng/build")).replaceAll("eng/build", "NAME");
  const none = JSON.stringify(await result("eng/nope")).replaceAll("eng/nope", "NAME");
  expect(real).toBe(none);
  expect(JSON.parse(real).unresolved).toEqual(["nobody1", "NAME", "nobody2"]);
  const member = await ahost.call<{ unresolved?: string[] }>("board_post", { board: "lobby", body: "@nobody1 @eng/build hello" });
  expect(member.unresolved).toEqual(["nobody1"]);
});

test("board_read's active_claims withholds a holder the reader may not see, with its note", async () => {
  const build = await srv.hosted(B, null);
  await build.call("bind", { name: "eng/build", create: true });
  const ahost = await srv.hosted(A, "be");
  await ahost.call("board_create", { name: "lobby", purpose: "general" });
  await build.call("claim_take", { key: "ticket:ENG-3", note: "eng's secret plan", board: "lobby" });
  const cqa = await srv.hosted(C, "qa");
  type Read = { active_claims?: Listed[] };
  expect(row((await cqa.call<Read>("board_read", { board: "lobby" })).active_claims ?? [], "ticket:ENG-3")).toMatchObject({ holder: null, note: null });
  expect(row((await ahost.call<Read>("board_read", { board: "lobby" })).active_claims ?? [], "ticket:ENG-3")).toMatchObject({ holder: "eng/build", note: "eng's secret plan" });
});

test("on a queue board, a non-member's @mention of a team alias still routes to a lane, as one that matched nobody", async () => {
  const build = await srv.hosted(B, null);
  await build.call("bind", { name: "eng/build", create: true });
  const lane = await srv.hosted(A, "lane");
  await lane.call("board_create", { name: "work", purpose: "a queue", kind: "queue" });
  const cqa = await srv.hosted(C, "qa");
  const outcome = async (name: string) => {
    const { post_id: id, ...r } = await cqa.call<{ post_id: number }>("board_post", { board: "work", body: `@${name} go` });
    const queued = srv.app.db.prepare("SELECT holder FROM claims WHERE key = ?").all(`queue:work:${id}`);
    return JSON.stringify({ r, queued }).replaceAll(name, "NAME");
  };
  const real = await outcome("eng/build");
  expect(real).toBe(await outcome("eng/nope"));
  expect(JSON.parse(real).queued).toEqual([{ holder: `${A}/lane` }]);
});

test("a deleted team name's claim stays hidden outside the team", async () => {
  const build = await srv.hosted(B, null);
  await build.call("bind", { name: "eng/build", create: true });
  await build.call("claim_take", { key: "ticket:ENG-4", note: "eng's secret plan", ttl_minutes: 60 });
  await build.call("unbind", { name: "eng/build" });
  expect(await srv.api(alice, "POST", "/api/teams/eng/delete-alias", { name: "build" })).toMatchObject({ status: 200 });
  const cqa = await srv.hosted(C, "qa");
  expect(row(await cqa.call<Listed[]>("claim_list", {}), "ticket:ENG-4")).toMatchObject({ holder: null, note: null });
  expect(row((await srv.api(carol, "GET", "/api/claims")).body as Listed[], "ticket:ENG-4")).toMatchObject({ holder: null, note: null });
  const ahost = await srv.hosted(A, "be");
  expect(row(await ahost.call<Listed[]>("claim_list", {}), "ticket:ENG-4")).toMatchObject({ holder: "eng/build" });
});
