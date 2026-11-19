// #1255: a session bound to `eng/x` acts as eng on every scoped board, not only a service's. Its ID, as the fallback
// author or as `as: <ID>`, is judged as its session's primary (seerOn), so it can't reach its binder's other teams'
// boards (principle 8; the access.ts header's promise). An org board stays open. A team's names stay the user's to see
// (#348, alias_visibility.test.ts), so they aren't asserted here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boardAccess } from "../../src/server/access.ts";
import { HostedSession, HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const B = "bob@example.com";
let srv: TestServer;
let sessions: HostedSession[] = [];
let bob: string;

beforeEach(async () => {
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  bob = await srv.login(B);
  for (const team of ["eng", "qa"]) expect((await srv.api(bob, "POST", "/api/teams", { name: team })).status).toBe(201);
});
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
  await srv.stop();
});

const hosted = async (name: string) => {
  const s = await srv.hosted(B, name);
  sessions.push(s);
  return s;
};
const idHolding = (address: string) => (srv.app.db.query("SELECT id FROM alias_holds WHERE address = ?").get(address) as { id: string }).id;
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
  return { ops, build, id: idHolding("eng/build") };
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
    expect(srv.app.db.query("SELECT count(*) AS n FROM posts WHERE board = 'qa-room'").get()).toEqual({ n: 1 });
    expect(srv.app.db.query("SELECT count(*) AS n FROM subscriptions WHERE board = 'qa-room' AND handle = ?").get(id)).toEqual({ n: 0 });
    // An org board is everyone's: the ID posts there as before.
    expect(await build.call("board_post", { board: "lobby", body: "hi", as: id })).toBeDefined();
    // The access rule itself, and the control: a person-scoped session of bob's (its ID is bob) still sees qa's board.
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    const room = (await srv.app.repo.boards.get(read, "qa-room"))!;
    expect(await access.canSee(read, id, room)).toBe(false);
    expect([...(await access.visibleTo(read, id, [room]))]).toEqual([]);
    const fe = await hosted("fe");
    const feId = idHolding(`${B}/fe`);
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
    expect(srv.app.db.query("SELECT count(*) AS n FROM claims WHERE key LIKE 'ticket:QA-%'").get()).toEqual({ n: 0 });
  });
});
