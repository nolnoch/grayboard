// #1255: a session bound to `eng/x` acts as eng on every scoped board, not only a service's. Its ID, as the fallback
// author or as `as: <ID>`, is judged as its session's primary (seerOn), so it can't reach its binder's other teams'
// boards (principle 8; the access.ts header's promise). An org board stays open. A team's names stay the user's to see
// (#348, alias_visibility.test.ts), so they aren't asserted here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boardAccess } from "../../src/server/access.ts";
import { board } from "../support/events.ts";
import { HostedSession, HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";
import { endId } from "../support/end_id.ts";
import { exec, row, rows as sqlRows } from "../support/repo_sql.ts";

const B = "bob@example.com", F = "frank@example.com", D = "dan@example.com";
let srv: TestServer;
let sessions: HostedSession[] = [];
let bob: string;

beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  bob = await srv.login(B);
  for (const team of ["eng", "qa"]) expect((await srv.api(bob, "POST", "/api/teams", { name: team })).status).toBe(201);
});
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
  await srv.stop();
});

const hosted = async (name: string | null, email = B) => {
  const s = await srv.hosted(email, name);
  sessions.push(s);
  return s;
};
const idHolding = async (address: string) => (await row(srv, "SELECT id FROM alias_holds WHERE address = ?", address) as { id: string }).id;
const refusal = async (p: Promise<unknown>): Promise<HostedToolError> => {
  const e = await p.then((v) => new Error(`not refused: ${JSON.stringify(v)}`), (x: unknown) => x);
  if (!(e instanceof HostedToolError)) throw e;
  return e;
};
const unnamed = (e: { message: string }, name: string) => e.message.replaceAll(name, "NAME");

// bob is in eng and qa. qa/ops makes qa's board and posts there; eng/build holds only eng's name.
async function cast() {
  const ops = await hosted("qa/ops");
  await ops.call("board_create", { name: "qa-room", purpose: "qa only", team: "qa" });
  await ops.call("board_post", { board: "qa-room", body: "qa secret" });
  await ops.call("board_create", { name: "lobby", purpose: "org-open" });
  const build = await hosted("eng/build");
  return { ops, build, id: (await idHolding("eng/build")) };
}

describe("an ID is judged as its session's primary on every scoped board (#1255)", () => {
  test("over MCP: not listed, read, posted on or subscribed to, as the ID or by fallback; an org board stays open", async () => {
    const { build, id } = await cast();
    const missing = async (tool: string, args: Record<string, unknown>) => {
      const hidden = unnamed(await refusal(build.call(tool, { ...args, board: "qa-room" })), "qa-room");
      expect(hidden, tool).toBe(unnamed(await refusal(build.call(tool, { ...args, board: "no-such-thing" })), "no-such-thing"));
    };
    expect((await build.call<{ name: string }[]>("board_list", {})).map((b) => b.name)).not.toContain("qa-room");
    await missing("board_read", {});
    await missing("board_post", { body: "x" });
    await missing("board_post", { body: "x", as: id });
    await missing("board_subscribe", { mode: "push", as: id });
    await missing("claim_take", { key: "ticket:QA-1", as: id });
    expect(await row(srv, "SELECT count(*) AS n FROM posts WHERE board = 'qa-room'")).toEqual({ n: 1 });
    expect(await row(srv, "SELECT count(*) AS n FROM subscriptions WHERE board = 'qa-room' AND handle = ?", id)).toEqual({ n: 0 });
    // An org board is everyone's: the ID posts there as before.
    expect(await build.call("board_post", { board: "lobby", body: "hi", as: id })).toBeDefined();
    // The access rule itself, and the control: a person-scoped session of bob's (its ID is bob) still sees qa's board.
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    const room = (await srv.app.repo.boards.get(read, "qa-room"))!;
    expect(await access.canSee(read, id, room)).toBe(false);
    expect([...(await access.visibleTo(read, id, [room]))]).toEqual([]);
    const fe = await hosted("fe");
    const feId = await idHolding(`${B}/fe`);
    expect(await access.canSee(read, feId, room)).toBe(true);
    expect((await fe.call<{ name: string }[]>("board_list", {})).map((b) => b.name)).toContain("qa-room");
  });

  test("peer_list shows qa's name to it (#348) but not its labels or status, which can name qa's board", async () => {
    const { ops, build } = await cast();
    await ops.call("bind", { name: "qa/ops", meta: { task: "qa task", source_board: "qa-room", description: "qa desc" } });
    await ops.call("peer_status", { text: "qa status" });
    const listed = JSON.stringify(await build.call("peer_list", { include_offline: true }));
    expect(listed).toContain("qa/ops");
    for (const leak of ["qa-room", "qa task", "qa desc", "qa status"]) expect(listed, leak).not.toContain(leak);
    // An eng sibling's labels and status stay visible to it: a team principal acts in its own team's scope.
    const b2 = await hosted("eng/b2");
    await b2.call("bind", { name: "eng/b2", meta: { task: "eng task", description: "eng desc" } });
    await b2.call("peer_status", { text: "eng status" });
    const eng = JSON.stringify(await build.call("peer_list", { include_offline: true }));
    for (const label of ["eng task", "eng desc", "eng status"]) expect(eng, label).toContain(label);
    // The control: a person-scoped session of bob's sees them.
    const fe = await hosted("fe");
    const all = JSON.stringify(await fe.call("peer_list", { include_offline: true }));
    for (const label of ["qa-room", "qa task", "qa status"]) expect(all, label).toContain(label);
  });

  test("a session reads back the labels on its own non-primary hold (#1277)", async () => {
    const { ops } = await cast();
    await ops.call("bind", { name: "eng/side", create: true, meta: { task: "side task", description: "side desc" } });
    const own = (await ops.call<{ peers: { handle: string; self?: boolean; task?: string; description?: string }[] }>("peer_list", { include_offline: true }))
      .peers.find((p) => p.handle === "eng/side");
    expect(own).toMatchObject({ self: true, task: "side task", description: "side desc" });
    // A match on the label finds the row too.
    const matched = await ops.call<{ peers: { handle: string }[] }>("peer_list", { include_offline: true, match: { task: "side task" } });
    expect(matched.peers.map((p) => p.handle)).toEqual(["eng/side"]);
    // The control: only its own rows pass. Its primary is qa/ops, so another session's eng name still shows it no labels
    // or status (#1255).
    const b2 = await hosted("eng/b2");
    await b2.call("bind", { name: "eng/b2", meta: { task: "eng task" } });
    await b2.call("peer_status", { text: "eng status" });
    const listed = JSON.stringify(await ops.call("peer_list", { include_offline: true }));
    expect(listed).toContain("eng/b2");
    for (const leak of ["eng task", "eng status"]) expect(listed, leak).not.toContain(leak);
  });

  test("a claim on qa's board shows its ID neither the board nor the note in a held answer (#1273 L1)", async () => {
    const { ops, build, id } = await cast();
    await ops.call("claim_take", { key: "ticket:QA-2", board: "qa-room", note: "qa note" });
    type View = { key: string; board: string | null; note: string | null };
    // claim_list takes no `as`: its viewer is the bound eng/build alias, the bound-actor control.
    const row = (await build.call<View[]>("claim_list", { prefix: "ticket:QA-2" })).find((c) => c.key === "ticket:QA-2");
    expect(row).toMatchObject({ board: null, note: null });
    for (const as of [undefined, id]) {
      const held = await build.call<{ ok: boolean; note: string | null }>("claim_take", { key: "ticket:QA-2", ...(as ? { as } : {}) });
      expect(held, String(as)).toMatchObject({ ok: false, note: null });
    }
    // The control: a person-scoped session of bob's sees qa's board, so its view names both.
    const fe = await hosted("fe");
    expect((await fe.call<View[]>("claim_list", { prefix: "ticket:QA-2" })).find((c) => c.key === "ticket:QA-2")).toMatchObject({ board: "qa-room", note: "qa note" });
  });

  test("over HTTP: /api/claims/call as the ID is refused qa's board like a missing one", async () => {
    const { id } = await cast();
    const call = (board: string) => srv.api(bob, "POST", "/api/claims/call", { as: id, tool: "claim_take", args: { key: `ticket:QA-${board}`, board } });
    const hidden = await call("qa-room"), none = await call("no-such-thing");
    expect(hidden.status).toBe(400);
    expect(unnamed({ message: JSON.stringify(hidden.body) }, "qa-room")).toBe(unnamed({ message: JSON.stringify(none.body) }, "no-such-thing"));
    expect(await row(srv, "SELECT count(*) AS n FROM claims WHERE key LIKE 'ticket:QA-%'")).toEqual({ n: 0 });
  });
});

// #1286: a claim taken on qa's board as a session's ID while its primary was a person name, the primary since moved
// to eng/h (the fe name released): its ID now acts as eng there (#1255), but
// the claimant's user still sees qa's board, so the claim's end is posted for that user, in fixed text, cc'ing the
// watchers who can see the board. The holder's own words never reach it, and its own answer and deliveries are a
// quiet end's.
describe("a confined holder's claim end is announced for its user (#1286)", () => {
  // `email`'s session bound to fe takes `key` on qa-room as its ID, qa/ops (bob's) watches it, and the session binds
  // eng/h and releases fe, so eng/h is its primary.
  async function confined(key: string, email = B, cast_?: Awaited<ReturnType<typeof cast>>) {
    const { ops } = cast_ ?? (await cast());
    const eng = `eng/h-${email === B ? "b" : "f"}`;
    if (email !== B) {
      await srv.login(email);
      for (const team of ["eng", "qa"]) expect((await srv.api(bob, "POST", `/api/teams/${team}/add`, { email })).status).toBe(200);
    }
    const h = await hosted("fe", email);
    const id = await idHolding(`${email}/fe`);
    expect(await h.call("claim_take", { key, board: "qa-room", note: "qa note", as: id })).toMatchObject({ ok: true });
    expect(await ops.call("claim_watch", { key })).toBeDefined();
    await h.bind(eng);
    await h.call("unbind", { name: "fe" });
    await h.reopen();
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    const room = (await srv.app.repo.boards.get(read, "qa-room"))!;
    expect(await access.canSee(read, await idHolding(eng), room)).toBe(false);
    return { ops, h, id };
  }
  const mentioned = (key: string, start: string) => board((i) => i.kind === "push" && i.reason === "mention" && i.post.board === "qa-room" && i.post.body.startsWith(`${start} ${key}`));
  // Any delivery of `key`'s end post: a push of it, or a digest whose latest post it is.
  const ended = (key: string) => board((i) => /^\[(release|expired)\] /.test((i.kind === "push" ? i.post : i.latest).body) && (i.kind === "push" ? i.post : i.latest).body.includes(key));
  const posts = async (key: string) => await sqlRows(srv, "SELECT body, author, author_user, author_id FROM posts WHERE board = 'qa-room' AND body LIKE ?", `%${key}%`);

  test("an explicit release: the watcher is told without the holder's note; the holder's answer and inbox are a quiet release's", async () => {
    const c = await cast();
    const { ops, h, id } = await confined("ticket:QA-R", B, c);
    const answer = await h.call("claim_release", { key: "ticket:QA-R", note: "eng secret" });
    const got = await ops.next(mentioned("ticket:QA-R", "[release]"));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(got.event.item.post.body).toBe("[release] ticket:QA-R cc @qa/ops");
    expect(await posts("ticket:QA-R")).toEqual([
      { body: "[claim] ticket:QA-R — qa note", author: id, author_user: B, author_id: id },
      { body: "[release] ticket:QA-R cc @qa/ops", author: id, author_user: B, author_id: null },
    ]);
    expect(JSON.stringify(await sqlRows(srv, "SELECT body FROM posts"))).not.toContain("eng secret");
    // The control: frank's user lost qa too, so his release is quiet. Both holders answer alike and are told nothing.
    const quiet = await confined("ticket:QA-Q", F, c);
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: F })).status).toBe(200);
    const quietAnswer = await quiet.h.call("claim_release", { key: "ticket:QA-Q", note: "eng secret" });
    expect(await posts("ticket:QA-Q")).toHaveLength(1);
    expect([answer, quietAnswer]).toEqual(["released ticket:QA-R", "released ticket:QA-Q"]);
    await quiet.ops.none(ended("ticket:QA-Q"));
    await h.none(ended("ticket:QA-R"));
    await quiet.h.none(ended("ticket:QA-Q"));
  });

  test("a session end's release is posted for the user, without its note; a watcher who lost the board gets nothing", async () => {
    const { ops, id } = await confined("ticket:QA-E");
    // dan watched while in qa, then left it: the end post's mention of him resolves to nothing.
    await srv.login(D);
    expect((await srv.api(bob, "POST", "/api/teams/qa/add", { email: D })).status).toBe(200);
    const dan = await hosted("w", D);
    expect(await dan.call("claim_watch", { key: "ticket:QA-E" })).toBeDefined();
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: D })).status).toBe(200);
    // A hosted root's own session_end leaves its ID unended (the hosted store's); the server's ID end (a startup
    // leftover's, a revoked tools-only session's, a released child's) is server/session_end.ts's, run here as they run it.
    // Its release has no signed-in caller (no ctx.user).
    await srv.app.repo.write(tx => endId(srv.app.repo, tx, id, "test"));
    expect(await row(srv, "SELECT count(*) AS n FROM claims WHERE key = 'ticket:QA-E'")).toEqual({ n: 0 });
    const got = await ops.next(mentioned("ticket:QA-E", "[release]"));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(got.event.item.post.body).toBe(`[release] ticket:QA-E cc @${D}/w @qa/ops`);
    expect(await posts("ticket:QA-E")).toContainEqual({ body: `[release] ticket:QA-E cc @${D}/w @qa/ops`, author: expect.any(String), author_user: B, author_id: null });
    await dan.none(ended("ticket:QA-E"));
  });

  test("a lapse is posted for the user; one whose user lost the board too lapses quietly", async () => {
    const c = await cast();
    const { ops } = await confined("ticket:QA-L", B, c);
    const quiet = await confined("ticket:QA-LQ", F, c);
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: F })).status).toBe(200);
    await exec(srv, "UPDATE claims SET expires_at = ? WHERE key IN ('ticket:QA-L', 'ticket:QA-LQ')", Date.now() - 1);
    // A take sweeps the lapsed claims first.
    await ops.call("claim_take", { key: "ticket:sweep" });
    const got = await ops.next(mentioned("ticket:QA-L:", "[expired]"));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(got.event.item.post).toMatchObject({ body: expect.stringMatching(/ cc @qa\/ops$/) });
    expect(await posts("ticket:QA-L:")).toHaveLength(1);
    expect(await row(srv, "SELECT count(*) AS n FROM claims WHERE key LIKE 'ticket:QA-L%'")).toEqual({ n: 0 });
    expect(await posts("ticket:QA-LQ")).toHaveLength(1);
    await quiet.ops.none(board((i) => i.kind === "push" && i.post.body.startsWith("[expired] ticket:QA-LQ")));
  });
});

// #1296: a queue post on qa's queue board, claimed for a session's ID by mention (#219) while its primary was a
// person name, the primary since moved to eng/h: with no lane left, its claim's end is an `[unclaimed]` reply posted
// for the claimant's user, who still sees qa's board, cc'ing the watcher. The holder's decline note never reaches it,
// and its own answer and deliveries are a quiet end's. When the user lost qa too, the post's author writes the reply
// (#1175): the watcher is told, and the author, whose own post it answers, is never woken by it.
describe("a confined holder's queue claim ends in an [unclaimed] reply for its user (#1296)", () => {
  async function confinedQueue(email = B, cast_?: Awaited<ReturnType<typeof cast>>) {
    const { ops } = cast_ ?? (await cast());
    const tag = email === B ? "b" : "f";
    if (email !== B) {
      await srv.login(email);
      for (const team of ["eng", "qa"]) expect((await srv.api(bob, "POST", `/api/teams/${team}/add`, { email })).status).toBe(200);
    }
    // bob comes first, so his call makes the queue board.
    if (email === B) await ops.call("board_create", { name: "qa-q", purpose: "qa queue", team: "qa", kind: "queue" });
    const h = await hosted("fe", email);
    const id = await idHolding(`${email}/fe`);
    const { post_id: postId } = await ops.call<{ post_id: number }>("board_post", { board: "qa-q", body: `@${id} qa work ${tag}` });
    const key = `queue:qa-q:${postId}`;
    const claim = await row(srv, "SELECT holder, holder_user FROM claims WHERE key = ?", key);
    expect(claim).toEqual({ holder: id, holder_user: email });
    // qa/w-<tag> watches; it sees qa's board and is no lane.
    const w = await hosted(`qa/w-${tag}`);
    expect(await w.call("claim_watch", { key })).toBeDefined();
    await h.bind(`eng/h-${tag}`);
    await h.call("unbind", { name: "fe" });
    await h.reopen();
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    expect(await access.canSee(read, id, (await srv.app.repo.boards.get(read, "qa-q"))!)).toBe(false);
    return { ops, w, h, id, postId, key };
  }
  const replies = async (postId: number) => await sqlRows(srv, "SELECT body, author, author_user, author_id FROM posts WHERE parent_id = ?", postId);
  const unclaimed = (key: string) => board((i) => (i.kind === "push" ? i.post : i.latest).body.startsWith(`[unclaimed] ${key}:`));
  // #1175: the reply the post's author, qa/ops, writes when neither the holder nor its user can; its watcher is told,
  // its author isn't.
  const authored = async (c: Awaited<ReturnType<typeof cast>>, q: Awaited<ReturnType<typeof confinedQueue>>) => {
    await q.w.next(board((i) => i.kind === "push" && i.reason === "mention" && i.post.body.startsWith(`[unclaimed] ${q.key}:`)));
    expect(await replies(q.postId)).toEqual([{ body: expect.stringMatching(/ cc @qa\/w-f$/), author: "qa/ops", author_user: B, author_id: (await idHolding("qa/ops")) }]);
    await c.ops.none(unclaimed(q.key));
  };

  test("a decline: the watcher is told without the holder's note; the holder's answer and inbox are a quiet decline's", async () => {
    const c = await cast();
    const { w, h, id, postId, key } = await confinedQueue(B, c);
    const answer = await h.call("claim_release", { key, note: "eng secret" });
    const got = await w.next(board((i) => i.kind === "push" && i.reason === "mention" && i.post.body.startsWith(`[unclaimed] ${key}:`)));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(got.event.item.post.body).toEndWith(" cc @qa/w-b");
    expect(await replies(postId)).toEqual([{ body: expect.stringMatching(/^\[unclaimed\] /), author: id, author_user: B, author_id: null }]);
    expect(JSON.stringify(await sqlRows(srv, "SELECT body FROM posts"))).not.toContain("eng secret");
    // frank's user lost qa too, so the post's author writes his decline's reply, without his note. Both holders answer
    // alike and are told nothing.
    const quiet = await confinedQueue(F, c);
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: F })).status).toBe(200);
    const quietAnswer = await quiet.h.call("claim_release", { key: quiet.key, note: "eng secret" });
    await authored(c, quiet);
    expect(JSON.stringify(await sqlRows(srv, "SELECT body FROM posts"))).not.toContain("eng secret");
    expect([answer, quietAnswer]).toEqual([`released ${key}`, `released ${quiet.key}`]);
    await h.none(unclaimed(key));
    await quiet.h.none(unclaimed(quiet.key));
  });

  test("a lapse is replied to for the user; one whose user lost the board too is replied to by the post's author", async () => {
    const c = await cast();
    const { w, id, postId, key } = await confinedQueue(B, c);
    const quiet = await confinedQueue(F, c);
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: F })).status).toBe(200);
    await exec(srv, "UPDATE claims SET expires_at = ? WHERE key IN (?, ?)", Date.now() - 1, key, quiet.key);
    // A take sweeps the lapsed claims first.
    await c.ops.call("claim_take", { key: "ticket:sweep" });
    const got = await w.next(board((i) => i.kind === "push" && i.reason === "mention" && i.post.body.startsWith(`[unclaimed] ${key}:`)));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(await replies(postId)).toEqual([{ body: expect.stringMatching(/ cc @qa\/w-b$/), author: id, author_user: B, author_id: null }]);
    expect(await row(srv, "SELECT count(*) AS n FROM claims WHERE key IN (?, ?)", key, quiet.key)).toEqual({ n: 0 });
    await authored(c, quiet);
  });

  // #1306: session end releases through core release with the ended session's ctx (src/core/session_end.ts), which
  // reaches core requeue: the reply is still the user's, without the session or the end's note.
  test("a session end's requeue is replied to for the user; one whose user lost the board too is replied to by the post's author", async () => {
    const c = await cast();
    const { w, id, postId, key } = await confinedQueue(B, c);
    const quiet = await confinedQueue(F, c);
    expect((await srv.api(bob, "POST", "/api/teams/qa/remove", { email: F })).status).toBe(200);
    // As the #1286 session-end case runs it: the server's ID end, with no signed-in caller.
    for (const ended of [id, quiet.id]) await srv.app.repo.write(tx => endId(srv.app.repo, tx, ended, "test"));
    expect(await row(srv, "SELECT count(*) AS n FROM claims WHERE key IN (?, ?)", key, quiet.key)).toEqual({ n: 0 });
    const got = await w.next(board((i) => i.kind === "push" && i.reason === "mention" && i.post.body.startsWith(`[unclaimed] ${key}:`)));
    if (got.event.kind !== "board" || got.event.item.kind !== "push") throw new Error("not a push");
    expect(got.event.item.post.body).toEndWith(" cc @qa/w-b");
    expect(await replies(postId)).toEqual([{ body: expect.stringMatching(/ cc @qa\/w-b$/), author: id, author_user: B, author_id: null }]);
    expect(JSON.stringify(await replies(postId))).not.toContain("session ended");
    await authored(c, quiet);
    expect(JSON.stringify(await replies(quiet.postId))).not.toContain("session ended");
  });
});
