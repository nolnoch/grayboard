// The server's board tools (#807 P3 B5b1b1) give core's answers: serverBoardActor picks core boardActor's actor, and
// callBoardTool's board_list, peer_list and peer_status return core callBoardTool's result or refusal and leave its
// rows, over the shared parity fixture extended with live sessions, boards, subscriptions and statuses, for callers
// bound and unbound, a cross-user writer and a read-only viewer.
import { beforeEach, expect, test } from "bun:test";
import { boardActor, holdAlias, idAddress } from "../core/bindings.ts";
import { createBoard, post, registerId, setStatus, setSubscription, subscribe, touchAlias, type CoreDb, type UnboundPeer } from "../core/boards.ts";
import type { Principal } from "../core/resolver.ts";
import { callBoardTool as coreCallBoardTool, type ToolContext } from "../core/tools.ts";
import { boardAccess, principalCanSee } from "./access.ts";
import { callBoardTool, serverBoardActor } from "./boards.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";
import { B, D, E, ENDED_ID, openBoardParity, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

const BOB_ID = idAddress("c".repeat(64)), EVE_ID = idAddress("d".repeat(64)), TAIL_ID = idAddress("e".repeat(64));
// An unbound hosted session of dan's (an addressless reader), and a tools-only writer of dan's acting as bob's be.
const DAN_UNBOUND = idAddress("9".repeat(64)), DAN_WRITER = idAddress("8".repeat(64));
const GONE_ID = idAddress("7".repeat(64));
// Mid-minute, so a status age reads the same however many milliseconds apart the two sides run.
const T0 = Date.now() - 10.5 * 60_000;

let repo: Repo;
let db: CoreDb;

beforeEach(async () => {
  ({ repo, db } = await openBoardParity());
  await seed(repo, async tx => {
    const core = repo.coreOn(tx);
    registerId(core, { id: BOB_ID, principal: B, launcher: false, harness: "pi", model: "m1" });
    registerId(core, { id: EVE_ID, principal: E, launcher: true, harness: "claude-code", effort: "high", cwd: "/home/eve/work/ops" });
    registerId(core, { id: TAIL_ID, principal: W, launcher: false, viewer: true });
    registerId(core, { id: DAN_UNBOUND, principal: D, launcher: false, harness: "opencode" });
    registerId(core, { id: DAN_WRITER, principal: D, launcher: false, writesAs: `${B}/be` });
    const holds: [string, string][] = [[`${W}/be`, WADE_ID], ["eng/deploy", WADE_ID], [`${B}/be`, BOB_ID], [`${B}/qa`, BOB_ID], [`${E}/be`, EVE_ID], ["ops/deploy", EVE_ID]];
    for (const [address, id] of holds) { holdAlias(core, address, id, T0); touchAlias(core, address, T0); }
    // dan's be has had a session and is gone.
    touchAlias(core, `${D}/be`, T0 - 3_600_000);
    setStatus(core, `${W}/be`, "wiring the port", T0);
    setStatus(core, `${E}/be`, "on call", T0);
    setStatus(core, DAN_UNBOUND, "reading", T0);
    core.prepare(`UPDATE aliases SET queue_off = 1, task = 'qa sweep' WHERE address = ?`).run(`${B}/qa`);
    core.prepare(`UPDATE aliases SET task = 'deploys', owner = 'wade' WHERE address = 'eng/deploy'`).run();
    createBoard(core, `${W}/be`, "general", "everyone");
    createBoard(core, `${W}/be`, "eng", "eng work", "team:eng");
    createBoard(core, `${E}/be`, "ops", "ops work", "team:ops");
    // wade's two names both read general, be two posts behind and deploy one, so board_list's pick follows address order.
    setSubscription(core, `${W}/be`, "general", "digest");
    subscribe(core, `${B}/be`, "eng", "digest");
    subscribe(core, `${B}/qa`, "general", "push");
    subscribe(core, `${W}/be`, "ops", "digest");
    subscribe(core, BOB_ID, "eng", "push");
    subscribe(core, DAN_UNBOUND, "general", "digest");
    // Subscriptions left by sight since lost (a team left): judged on every read, never shown.
    setSubscription(core, `${D}/be`, "eng", "digest");
    setSubscription(core, "eng/deploy", "ops", "digest");
    post(core, `${E}/be`, "ops", "pager");
    post(core, `${B}/be`, "general", "hello");
    subscribe(core, "eng/deploy", "general", "digest");
    post(core, `${B}/be`, "general", "again");
    post(core, `${W}/be`, "eng", "plan");
  });
});

const ONLINE = new Set([`${W}/be`, "eng/deploy", `${E}/be`, "ops/deploy", WADE_ID]);
const UNBOUND: UnboundPeer[] = [{ session_id: DAN_UNBOUND, unbound: true, online: true }, { session_id: GONE_ID, unbound: true, online: true }];

type Caller = { label: string; addresses: string[]; session?: string; principal?: Principal };
const CALLERS: Caller[] = [
  { label: "wade", addresses: [`${W}/be`, "eng/deploy"], session: WADE_ID },
  { label: "wade, deploy first", addresses: ["eng/deploy", `${W}/be`], session: WADE_ID },
  { label: "bob", addresses: [`${B}/be`, `${B}/qa`], session: BOB_ID },
  { label: "eve", addresses: [`${E}/be`, "ops/deploy"], session: EVE_ID },
  { label: "dan, sessionless", addresses: [`${D}/be`] },
  { label: "dan writing as bob", addresses: [`${B}/be`], session: DAN_WRITER },
  { label: "dan unbound", addresses: [DAN_UNBOUND], principal: { kind: "user", name: D } },
  { label: "wade's tail", addresses: [TAIL_ID] },
  { label: "bob's ended", addresses: [ENDED_ID] },
  // An unbound reader whose ID has no row: only its principal sees a board, so the principal must be what judges.
  { label: "wade unbound, no row", addresses: [idAddress("6".repeat(64))], principal: { kind: "user", name: W } },
];

const ownScope = (c: Caller) => c.principal?.name ?? (c.addresses[0]!.includes("@") ? c.addresses[0]!.split("/")[0]! : W);
const session = (c: Caller) => ({ addresses: c.addresses, asAddresses: c.addresses, ownScope: ownScope(c) });
const coreCtx = (c: Caller): ToolContext => ({
  online: h => ONLINE.has(h),
  addresses: c.addresses,
  unbound: UNBOUND,
  ...(c.session ? { session: c.session } : {}),
  ...(c.principal ? { reader: b => principalCanSee(repo, c.principal!, b) } : {}),
});
const serverCtx = (c: Caller) => ({ ...coreCtx(c), ...(c.principal ? { principal: c.principal } : {}) });

const outcome = <T>(f: () => T): { value: T } | { error: string } => {
  try { return { value: f() }; } catch (e) { return { error: (e as Error).message }; }
};
const outcomeAsync = async <T>(f: () => Promise<T>): Promise<{ value: T } | { error: string }> => {
  try { return { value: await f() }; } catch (e) { return { error: (e as Error).message }; }
};

// The rows a board tool may write, timestamps reduced to whether the call moved them.
const state = (tx: Read) => {
  const c = repo.coreOn(tx);
  return {
    ids: c.prepare(`SELECT id, status, status_at > ? AS restamped FROM ids ORDER BY id`).all(T0),
    aliases: c.prepare(`SELECT address, queue_off, last_seen > ? AS touched FROM aliases ORDER BY address`).all(T0),
  };
};
class Rollback { constructor(readonly value: unknown) {} }
// A body's answer and the rows it left, rolled back.
async function inBody(f: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  try { await repo.write(async tx => { throw new Rollback({ out: await f(tx), rows: state(tx) }); }); }
  catch (e) { if (e instanceof Rollback) return e.value; throw e; }
  throw new Error("unreachable");
}

const ACTOR_TOOLS = ["board_read", "board_subscribe", "board_post", "board_list", "peer_list", "peer_status", "claim_take"];
const ACTOR_ARGS = (c: Caller): Record<string, unknown>[] => [
  {}, { board: "general" }, { board: "#ENG" }, { board: "ops" }, { board: "nope" }, { board: "!!" }, { board: 7 },
  { as: c.addresses.at(-1) }, { as: "nobody" }, { as: "deploy" }, { board: "eng", as: c.addresses[0] },
];
const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ["board_list", {}],
  ["peer_list", {}], ["peer_list", { include_offline: true }], ["peer_list", { board: "general" }], ["peer_list", { board: "eng" }],
  ["peer_list", { board: "ops", include_offline: true }], ["peer_list", { board: "nope" }], ["peer_list", { match: { scope: W } }],
  ["peer_list", { match: { scope: "eng" }, include_offline: true }], ["peer_list", { match: { harness: "pi" } }], ["peer_list", { match: { task: "deploys" } }],
  ["peer_list", { board: "general", match: { harness: "opencode" } }], ["peer_list", { match: { bogus: "x" } }], ["peer_list", { match: "x" }],
  ["peer_status", { text: "hello" }], ["peer_status", { text: "" }], ["peer_status", { text: "two\nlines", queue: "off" }], ["peer_status", { text: "x", queue: "on" }],
  ["peer_status", { queue: "maybe" }], ["peer_status", { text: "x".repeat(1000) }], ["peer_status", {}],
];

const diverging = (rs: [string, unknown, unknown][]) => rs.filter(([, s, a]) => JSON.stringify(s) !== JSON.stringify(a)).map(([l, s, a]) => ({ l, s, a }));

test("serverBoardActor picks core boardActor's actor, on the read handle and inside a body", async () => {
  const access = boardAccess(repo);
  const rows = async (r: Read): Promise<[string, unknown, unknown][]> => {
    const out: [string, unknown, unknown][] = [];
    for (const c of CALLERS) for (const tool of ACTOR_TOOLS) for (const args of ACTOR_ARGS(c)) {
      out.push([`${c.label} ${tool} ${JSON.stringify(args)}`, outcome(() => boardActor(repo.coreOn(r), tool, args, session(c))), await outcomeAsync(() => serverBoardActor(repo, access, r, tool, args, session(c)))]);
    }
    return out;
  };
  const outside = await rows(repo.read);
  expect(diverging(outside)).toEqual([]);
  expect(diverging(await repo.write(tx => rows(tx)))).toEqual([]);
  // The fixture reaches each branch: a refused `as`, a pick past the primary, and the primary for a board none sees.
  expect(outside.some(([, s]) => JSON.stringify(s).includes("error"))).toBe(true);
  expect(outside.some(([l, s]) => l.startsWith("bob board_read {\"board\":\"general\"}") && JSON.stringify(s) === JSON.stringify({ value: `${B}/qa` }))).toBe(true);
  expect(outside.some(([l, s]) => l === "wade, deploy first board_read {\"board\":\"ops\"}" && JSON.stringify(s) === JSON.stringify({ value: `${W}/be` }))).toBe(true);
  expect(outside.some(([l, s]) => l.startsWith("dan, sessionless board_read {\"board\":\"#ENG\"}") && JSON.stringify(s) === JSON.stringify({ value: `${D}/be` }))).toBe(true);
}, 60_000);

test("callBoardTool's board_list, peer_list and peer_status give core's answers and leave its rows", async () => {
  const access = boardAccess(repo);
  const out: [string, unknown, unknown][] = [];
  for (const c of CALLERS) for (const [tool, args] of TOOL_CALLS) {
    const actor = boardActor(repo.coreOn(repo.read), tool, args, session(c));
    const want = await inBody(async tx => outcome(() => coreCallBoardTool(repo.coreOn(tx), actor, tool, args, coreCtx(c))));
    const got = await inBody(tx => outcomeAsync(() => callBoardTool(repo, access, tx, actor, tool, args, serverCtx(c))));
    out.push([`${c.label} ${tool} ${JSON.stringify(args)}`, want, got]);
  }
  expect(diverging(out)).toEqual([]);
  // The fixture reaches what the port decides: a hidden team alias, session facts cut and shown, the unbound
  // sessions, an offline count, a status and an opt-out set, and refusals.
  const answer = (pred: (l: string) => boolean) => out.filter(([l]) => pred(l)).map(([, s]) => JSON.stringify((s as { out: unknown }).out)).join("\n");
  const rowsAfter = (l: string) => JSON.stringify((out.find(([x]) => x === l)![1] as { rows: unknown }).rows);
  const text = answer;
  const danList = text(l => l === "dan, sessionless peer_list {}");
  expect(danList).not.toContain("\"handle\":\"eng/deploy\"");
  expect(text(l => l === "wade peer_list {}")).toContain("\"handle\":\"eng/deploy\"");
  expect(danList).toContain(`${E}/be`);
  expect(danList).not.toContain("on call");
  expect(text(l => l === "wade peer_list {}")).toContain("on call");
  expect(text(l => l === "dan writing as bob peer_list {}")).not.toContain("\"handle\":\"eng/deploy\"");
  expect(text(l => l === "bob peer_list {}")).toContain("\"handle\":\"eng/deploy\"");
  expect(text(l => l === "dan unbound peer_list {}")).toContain("unbound_sessions");
  expect(text(l => l === "wade peer_list {}")).toContain("offline_hidden");
  expect(text(l => l === "dan, sessionless peer_list {\"board\":\"eng\"}")).toContain("no such board");
  expect(text(l => l === "wade peer_list {\"board\":\"eng\"}")).not.toContain(`"handle":"${D}/be"`);
  expect(text(l => l === "wade board_list {}")).toContain(`"name":"general","purpose":"everyone"`);
  expect(text(l => l === "wade unbound, no row peer_list {\"board\":\"eng\"}")).toContain("\"peers\"");
  expect(text(l => l === "wade's tail peer_list {}")).not.toContain("\"you\"");
  expect(text(l => l.startsWith("dan unbound board_list"))).toContain("general");
  expect(text(l => l.startsWith("dan unbound board_list"))).not.toContain("\"eng\"");
  expect(rowsAfter("bob peer_status {\"text\":\"two\\nlines\",\"queue\":\"off\"}")).toContain(`{"address":"${B}/be","queue_off":1,"touched":1}`);
  expect(rowsAfter("wade peer_status {\"text\":\"hello\"}")).toContain("\"status\":\"hello\",\"restamped\":1");
  for (const refused of ["no live session holds", "match has no key", "must be an object", "must be at most", "queue must be", "queue opt-out is a name's", "no such board"]) {
    expect(answer(() => true)).toContain(refused);
  }
}, 60_000);
