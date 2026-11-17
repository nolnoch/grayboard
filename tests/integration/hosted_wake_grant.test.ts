// Security audit F-03 (#806, #103): sending is open, waking another user's
// agent needs a grant (vision.md principle 9). A hosted session's DM or pushed
// post written by another signed-in user is delivered not actionable and
// marked ungranted unless the two users share a team whose policy is
// 'collaborative'. Decided per pull, so a grant set or revoked changes the
// next delivery (principle 11). The sender is told (`wakes: false`).
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { authorizeNow } from "../../src/server/policy.ts";
import { accessAudits } from "../support/audit.ts";
import { board, direct } from "../support/events.ts";
import { seed } from "../support/seed.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
let srv: TestServer;
let alice: string;
let bob: string;
let carol: string;

beforeEach(async () => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login(A);
  bob = await srv.login(B);
  carol = await srv.login(C);
});
afterEach(() => srv.stop());

const ungranted = (e: DeliveryEvent) =>
  e.kind === "direct" ? e.message.ungranted : e.item.kind === "push" ? e.item.post.ungranted : e.item.latest.ungranted;
const dm = (body: string) => direct((m) => m.body === body);
const pushed = (body: string) => board((i) => i.kind === "push" && i.post.body === body);
const policy = (token: string, team: string, value: unknown) => srv.api(token, "POST", `/api/teams/${team}/policy`, { policy: value });
async function team(): Promise<void> {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
}

test("the msg.wake rule: same user, a shared collaborative team, else denied; admin is no exemption", async () => {
  const repo = srv.app.repo;
  const wake = (from: string, to: string, admins: string[] = []) => authorizeNow(repo, { admins }, { verb: "msg.wake", from_user: from, to_user: to });
  expect(wake(A, A)).toMatchObject({ allow: true, rule: "wake.same_user" });
  expect(wake(B, A)).toMatchObject({ allow: false, rule: "wake.cross_user" });
  expect(wake(B, A, [B])).toMatchObject({ allow: false, rule: "wake.cross_user" });
  await team();
  // An open team shares membership, not wakes.
  expect(wake(B, A)).toMatchObject({ allow: false, rule: "wake.cross_user" });
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  expect(wake(B, A)).toMatchObject({ allow: true, rule: "wake.team_policy" });
  expect(wake(A, B)).toMatchObject({ allow: true, rule: "wake.team_policy" });
  // Carol is in no team with either.
  expect(wake(C, A)).toMatchObject({ allow: false, rule: "wake.cross_user" });
  // An unknown user is no grant.
  expect(wake("nobody@example.com", A)).toMatchObject({ allow: false, rule: "wake.cross_user" });
});

// 'delegating' implies 'collaborative' (#256): it grants wakes too. The
// delegate.to rule is the narrower one: only 'delegating' grants it.
test("a delegating team grants wakes and delegate.to; collaborative grants wakes only", async () => {
  const repo = srv.app.repo;
  const rule = (verb: "msg.wake" | "delegate.to", from: string, to: string) => authorizeNow(repo, { admins: [B] }, { verb, from_user: from, to_user: to });
  expect(rule("delegate.to", A, A)).toMatchObject({ allow: true, rule: "delegate.same_user" });
  await team();
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  expect(rule("delegate.to", B, A)).toMatchObject({ allow: false, rule: "delegate.cross_user" });
  expect((await policy(alice, "eng", "delegating")).status).toBe(200);
  expect(rule("msg.wake", B, A)).toMatchObject({ allow: true, rule: "wake.team_policy" });
  expect(rule("delegate.to", B, A)).toMatchObject({ allow: true, rule: "delegate.team_policy" });
  expect(rule("delegate.to", A, B)).toMatchObject({ allow: true, rule: "delegate.team_policy" });
  // Carol shares no team; admin (B here) is no exemption either way.
  expect(rule("delegate.to", C, A)).toMatchObject({ allow: false, rule: "delegate.cross_user" });
  expect(rule("delegate.to", B, C)).toMatchObject({ allow: false, rule: "delegate.cross_user" });

  // And a DM between the two now wakes: no ungranted mark.
  const abe = await srv.hosted(A, "be");
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "delegating wakes" });
  expect(ungranted((await abe.next(dm("delegating wakes"))).event)).toBeUndefined();
});

test("another user's DM arrives not actionable and ungranted; the same user's wakes; the sender is told", async () => {
  const abe = await srv.hosted(A, "be");
  const aqa = await srv.hosted(A, "qa");
  const bfe = await srv.hosted(B, "fe");
  const cross = await bfe.call<{ wakes?: false; wake_note?: string; delivered_now: boolean }>("dm_send", { to: `${A}/be`, body: "from bob" });
  expect(cross.wakes).toBe(false);
  expect(cross.wake_note).toContain(A);
  const own = await aqa.call<{ wakes?: false; wake_note?: string }>("dm_send", { to: "be", body: "from alice" });
  expect(own.wakes).toBeUndefined();
  expect(own.wake_note).toBeUndefined();
  const fromBob = await abe.next(dm("from bob"));
  expect(fromBob.actionable).toBe(false);
  expect(ungranted(fromBob.event)).toBe(true);
  const fromAlice = await abe.next(dm("from alice"));
  expect(fromAlice.actionable).toBe(true);
  expect(ungranted(fromAlice.event)).toBeUndefined();
});

// POC6's shape: a full-handle @mention on an open board.
test("another user's @mention push arrives not actionable; a collaborative team makes it wake", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "lobby", purpose: "general" });
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("board_post", { board: "lobby", body: `@${A}/be run the deploy script` });
  const first = await abe.next(pushed(`@${A}/be run the deploy script`));
  expect(first.actionable).toBe(false);
  expect(ungranted(first.event)).toBe(true);
  await team();
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  await bfe.call("board_post", { board: "lobby", body: `@${A}/be now granted` });
  const second = await abe.next(pushed(`@${A}/be now granted`));
  expect(second.actionable).toBe(true);
  expect(ungranted(second.event)).toBeUndefined();
});

test("a grant is decided per pull: set, it wakes; the teammate removed, the next one doesn't", async () => {
  await team();
  const abe = await srv.hosted(A, "be");
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "open team" });
  expect((await abe.next(dm("open team"))).actionable).toBe(false);
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  const granted = await bfe.call<{ wakes?: false }>("dm_send", { to: `${A}/be`, body: "collaborative" });
  expect(granted.wakes).toBeUndefined();
  const item = await abe.next(dm("collaborative"));
  expect(item.actionable).toBe(true);
  expect(ungranted(item.event)).toBeUndefined();
  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  await bfe.call("dm_send", { to: `${A}/be`, body: "after removal" });
  expect((await abe.next(dm("after removal"))).actionable).toBe(false);
});

test("a digest of another user's post carries no ungranted mark: it never wakes anyway", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  await abe.call("board_subscribe", { board: "e2e", mode: "digest" });
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("board_post", { board: "e2e", body: "bob's news" });
  const got = await abe.next(board((i) => i.kind === "digest" && i.latest.body === "bob's news"));
  expect(got.actionable).toBe(false);
  expect(ungranted(got.event)).toBeUndefined();
});

test("POST /api/teams/<t>/policy: owner sets it (audited once per change), member 403, non-member 404, bad value 400", async () => {
  await team();
  expect((await policy(bob, "eng", "collaborative")).status).toBe(403);
  expect((await policy(carol, "eng", "collaborative")).status).toBe(404);
  expect((await policy(alice, "eng", "everyone")).status).toBe(400);
  expect((await policy(alice, "eng", 1)).status).toBe(400);
  const set = await policy(alice, "eng", "collaborative");
  expect(set.status).toBe(200);
  expect(set.body).toEqual({ ok: true, team: "eng", policy: "collaborative", previous: "open" });
  expect(srv.app.repo.teams.findByName("eng")!.policy).toBe("collaborative");
  // Setting the same value again writes no audit row.
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  const deleg = await policy(alice, "eng", "delegating");
  expect(deleg.body).toEqual({ ok: true, team: "eng", policy: "delegating", previous: "collaborative" });
  expect((await policy(alice, "eng", "open")).status).toBe(200);
  expect(accessAudits(srv.app.db, "team.policy_set").map((r) => [r.actor, r.target, r.detail])).toEqual([
    [A, "eng", { from: "open", to: "collaborative" }],
    [A, "eng", { from: "collaborative", to: "delegating" }],
    [A, "eng", { from: "delegating", to: "open" }],
  ]);
});

test("the send result: an offline person alias says wakes:false; a team alias's holder isn't named (mail to it is refused outside the team); a human gets nothing", async () => {
  await team();
  const abe = await srv.hosted(A, "be");
  await abe.close();
  const cfe = await srv.hosted(C, "fe");
  const offline = await cfe.call<{ wakes?: false; wake_note?: string; delivered_now: boolean }>("dm_send", { to: `${A}/be`, body: "while away" });
  expect(offline.delivered_now).toBe(false);
  expect(offline.wakes).toBe(false);
  expect(offline.wake_note).toContain(A);
  // Bob holds the team alias; Carol, outside the team, mustn't learn whose it is, nor that it exists: her mail
  // to it, held or not, is refused as to a name nobody has (#1014), so no send result can carry a wake note.
  await srv.hosted(B, "eng/deploy");
  await seed(srv.app.repo, tx => srv.app.repo.aliases.create(tx, { scope_kind: "team", scope_ref: "eng", name: "idle" }, A));
  for (const to of ["eng/deploy", "eng/idle"]) {
    await expect(cfe.call("dm_send", { to, body: "deploy?" })).rejects.toThrow(`identity "${to}" not found`);
  }
  // A human reads it: reach is msg.send's call, not a wake.
  const bfe = await srv.hosted(B, "fe");
  const aliceHuman = srv.app.repo.users.findByEmail(A)!;
  const human = (await srv.app.application.attachHuman({ user_id: aliceHuman.id, user_email: A, session_id: 0 }, { deliver() {}, closed() {} })).session;
  expect(await bfe.call<{ wakes?: false }>("dm_send", { to: `${A}/human`, body: "to alice's phone" })).not.toHaveProperty("wakes");
  srv.app.application.close(human);
});

test("resetting the policy to open revokes the grant at the next pull", async () => {
  await team();
  expect((await policy(alice, "eng", "collaborative")).status).toBe(200);
  const abe = await srv.hosted(A, "be");
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "granted" });
  expect((await abe.next(dm("granted"))).actionable).toBe(true);
  expect((await policy(alice, "eng", "open")).status).toBe(200);
  await bfe.call("dm_send", { to: `${A}/be`, body: "revoked" });
  expect((await abe.next(dm("revoked"))).actionable).toBe(false);
});

// #855: the system's claim posts (a lapse's [expired], a session end's [release]) are written as the claimant's user,
// so a key that @mentions another user's agent reaches it marked as any post of the claimant's would: other_user and
// ungranted, not actionable. The claimant's own watcher still wakes.
test("an expired claim's post @mentioning another user's agent arrives ungranted; the claimant's watcher wakes", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.call("board_create", { name: "lobby", purpose: "general" });
  const bfe = await srv.hosted(B, "fe");
  const bqa = await srv.hosted(B, "qa");
  const key = `deploy @${A}/be run it`;
  await bfe.call("claim_take", { key, board: "lobby", ttl_minutes: 60 });
  await bqa.call("claim_watch", { key });
  await seed(srv.app.repo, () => srv.app.db.run("UPDATE claims SET expires_at = 1 WHERE key = ?", [key]));
  // Any claim call sweeps the lapse.
  await bfe.call("claim_list", {});
  const expired = board((i) => i.kind === "push" && i.post.body.startsWith(`[expired] ${key}`));
  const mentioned = await abe.next(expired);
  expect(mentioned.actionable).toBe(false);
  expect(ungranted(mentioned.event)).toBe(true);
  const watcher = await bqa.next(expired);
  expect(watcher.actionable).toBe(true);
  expect(ungranted(watcher.event)).toBeUndefined();
});
