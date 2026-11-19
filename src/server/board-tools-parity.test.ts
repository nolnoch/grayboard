// The server's board tools (#807 P3 B5b1b1) give core's answers: serverBoardActor picks core boardActor's actor, and
// callBoardTool's board_list, peer_list and peer_status return core callBoardTool's result or refusal and leave its
// rows, over the shared parity fixture extended with live sessions, boards, subscriptions and statuses, for callers
// bound and unbound, a cross-user writer and a read-only viewer.
import { beforeEach, expect, test } from "bun:test";
import { boardActor, holdAlias, idAddress } from "../core/bindings.ts";
import { archiveBoard, createBoard, markHuman, post, registerId, setStatus, setSubscription, subscribe, touchAlias, type CoreDb, type UnboundPeer } from "../core/boards.ts";
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
let T0 = 0;

let repo: Repo;
let db: CoreDb;

beforeEach(async () => {
  ({ repo, db } = await openBoardParity());
  T0 = Date.now() - 10.5 * 60_000;
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
    // An archived board: off board_list on every path, still picked by a read of it (#635).
    createBoard(core, `${W}/be`, "attic", "old");
    subscribe(core, `${B}/qa`, "attic", "digest");
    post(core, `${W}/be`, "attic", "last");
    archiveBoard(core, `${W}/be`, "attic", true);
    // B5b1b2: a board of bob's for his human to archive, a thread with a reply, a mention's pending push, and claims
    // whose boards and holders some callers may not see (a team alias, and a deleted team name, #871).
    createBoard(core, `${B}/be`, "bobs", "bob's");
    markHuman(core, `${B}/human`, true);
    ROOT = post(core, `${B}/be`, "general", "thread root").post.id;
    REPLY = post(core, `${E}/be`, "general", "a reply", ROOT).post.id;
    post(core, `${W}/be`, "general", "@qa look");
    PLAN = post(core, `${W}/be`, "eng", "eng follow-up").post.id;
    const claim = core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [key, holder, note, board] of [
      ["ticket:1", "eng/deploy", "deploying", "eng"], ["ticket:2", `${E}/be`, "paging", "ops"], ["x:3", `${B}/be`, null, null],
      ["ticket:4", "eng/ghost", "gone", "general"], ["ticket:5", `${W}/be`, "old", "attic"], ["ticket:6", `${D}/be`, "lapsed", "general"],
    ] as const) claim.run(key, holder, note, board, T0, key === "ticket:6" ? T0 : T0 + 86_400_000);
  });
  // Every seeded time is at or before T1 and every call's after it, so a time a call wrote reads as "now".
  T1 = Date.now();
  while (Date.now() <= T1) { /* the next millisecond */ }
});
let ROOT = 0, REPLY = 0, PLAN = 0;
let T1 = 0;

const ONLINE = new Set([`${W}/be`, "eng/deploy", `${E}/be`, "ops/deploy", WADE_ID]);
const UNBOUND: UnboundPeer[] = [{ session_id: DAN_UNBOUND, unbound: true, online: true }, { session_id: GONE_ID, unbound: true, online: true }];

type Caller = { label: string; addresses: string[]; session?: string; principal?: Principal; human?: boolean; via?: string };
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
  ...(c.human ? { human: true } : {}),
  ...(c.via ? { via: c.via } : {}),
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
  {}, { board: "general" }, { board: "attic" }, { board: "#ENG" }, { board: "ops" }, { board: "nope" }, { board: "!!" }, { board: 7 },
  { as: c.addresses.at(-1) }, { as: "nobody" }, { as: "deploy" }, { board: "eng", as: c.addresses[0] },
];
const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ["board_list", {}],
  ["peer_list", {}], ["peer_list", { include_offline: true }], ["peer_list", { board: "general" }], ["peer_list", { board: "eng" }],
  ["peer_list", { board: "ops", include_offline: true }], ["peer_list", { board: "nope" }], ["peer_list", { match: { scope: W } }],
  ["peer_list", { match: { scope: "eng" }, include_offline: true }], ["peer_list", { match: { harness: "pi" } }], ["peer_list", { match: { task: "deploys" } }],
  ["peer_list", { board: "general", match: { harness: "opencode" } }], ["peer_list", { match: { bogus: "x" } }], ["peer_list", { match: "x" }], ["peer_list", { board: 7, include_offline: "yes" }], ["peer_list", { include_offline: "yes", match: 3 }], ["peer_list", { board: "attic" }],
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
  for (const c of ["wade", "dan unbound", "wade unbound, no row"]) expect(text(l => l === `${c} board_list {}`)).not.toContain("attic");
  expect(rowsAfter("bob peer_status {\"text\":\"two\\nlines\",\"queue\":\"off\"}")).toContain(`{"address":"${B}/be","queue_off":1,"touched":1}`);
  expect(rowsAfter("wade peer_status {\"text\":\"hello\"}")).toContain("\"status\":\"hello\",\"restamped\":1");
  for (const refused of ["no live session holds", "match has no key", "must be an object", "must be at most", "queue must be", "queue opt-out is a name's", "no such board"]) {
    expect(answer(() => true)).toContain(refused);
  }
}, 60_000);

// B5b1b2's callers beyond CALLERS: the Slack bridge's human (exempt from #254's answers, archiving as its user), a
// handle marked human, and a child session (#523), whose board_read peeks.
const WRITE_CALLERS: Caller[] = [
  ...CALLERS,
  { label: "wade via slack", addresses: [`${W}/be`], session: WADE_ID, human: true },
  { label: "bob's human", addresses: [`${B}/human`] },
  { label: "wade's child", addresses: [`${W}/be`, "eng/deploy"], session: WADE_ID, via: idAddress("5".repeat(64)) },
];
const WRITE_CALLS = (): [string, Record<string, unknown>][] => [
  ["board_create", { name: "new", purpose: " fresh " }], ["board_create", { name: "general", purpose: "everyone" }], ["board_create", { name: "General", purpose: " everyone " }],
  ["board_create", { name: "general", purpose: "different" }], ["board_create", { name: "attic", purpose: "old" }], ["board_create", { name: "eng", purpose: "eng work", team: "ENG" }],
  ["board_create", { name: "t2", purpose: "x", team: "eng" }], ["board_create", { name: "t3", purpose: "x", team: "nope" }], ["board_create", { name: "q", purpose: "x", kind: "queue" }],
  ["board_create", { name: "q", purpose: "x", kind: "bogus" }], ["board_create", { name: "!!", purpose: "x" }], ["board_create", { name: "n", purpose: " " }],
  ["board_create", { name: "n", purpose: "x".repeat(501) }], ["board_create", { name: 7, purpose: "x" }], ["board_create", { name: "n" }], ["board_create", { name: "n", purpose: 3, kind: 4 }],
  ["board_archive", { board: "general" }], ["board_archive", { board: "general", archived: false }], ["board_archive", { board: "attic" }], ["board_archive", { board: "#Attic", archived: false }],
  ["board_archive", { board: "bobs" }], ["board_archive", { board: "eng" }], ["board_archive", { board: "ops" }], ["board_archive", { board: "nope" }],
  ["board_archive", { board: "general", archived: "yes" }], ["board_archive", {}],
  ["board_subscribe", { board: "general", mode: "push" }], ["board_subscribe", { board: "general", mode: "off" }], ["board_subscribe", { board: "#ENG", mode: "quiet" }],
  ["board_subscribe", { board: "general", mode: "bogus" }], ["board_subscribe", { board: "nope", mode: "push" }], ["board_subscribe", { board: "attic", mode: "digest" }],
  ["board_subscribe", { board: "general", mode: "off", thread: REPLY }], ["board_subscribe", { board: "#General", mode: "push", thread: ROOT }], ["board_subscribe", { board: "general", mode: "digest", thread: ROOT }],
  ["board_subscribe", { board: "general", mode: "off", thread: PLAN }], ["board_subscribe", { board: "general", mode: "off", thread: 999 }], ["board_subscribe", { board: "nope", mode: "off", thread: PLAN }],
  ["board_subscribe", { board: "general", mode: "off", thread: "x" }], ["board_subscribe", { board: "general" }],
  ["board_read", { board: "general" }], ["board_read", { board: "general", limit: 1 }], ["board_read", { board: "general", before_id: REPLY }], ["board_read", { board: "general", thread: REPLY }],
  ["board_read", { board: "attic" }], ["board_read", { board: "eng" }], ["board_read", { board: "ops" }], ["board_read", { board: "nope" }], ["board_read", { board: "general", limit: "x" }],
  ["board_read", { board: "#ENG", limit: 500 }], ["board_read", { board: "eng", thread: ROOT }],
  ["claim_list", {}], ["claim_list", { prefix: "ticket:" }], ["claim_list", { prefix: "%" }], ["claim_list", { prefix: 3 }],
];

// The rows B5b1b2's tools write, timestamps reduced to whether the call set them.
const boardState = (tx: Read) => {
  const c = repo.coreOn(tx);
  return {
    boards: c.prepare(`SELECT name, purpose, scope, created_by, kind, created_at > ? AS fresh, archived_at > ? AS archived_now, archived_at IS NOT NULL AS archived, archived_by FROM boards ORDER BY name`).all(T1, T1),
    subscriptions: c.prepare(`SELECT board, handle, mode, cursor, notified_id FROM subscriptions ORDER BY board, handle`).all(),
    mutes: c.prepare(`SELECT handle, root_id FROM thread_mutes ORDER BY handle, root_id`).all(),
    outbox: c.prepare(`SELECT handle, post_id, delivered_at IS NOT NULL AS delivered FROM outbox ORDER BY handle, post_id`).all(),
  };
};
async function inBodyBoards(f: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  try { await repo.write(async tx => { throw new Rollback({ out: await f(tx), rows: boardState(tx) }); }); }
  catch (e) { if (e instanceof Rollback) return e.value; throw e; }
  throw new Error("unreachable");
}
// A board this test's call made carries its own clock: compared as "now".
const settled = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => ((k === "created_at" || k === "archived_at") && typeof x === "number" && x > T1 ? "now" : x)));

test("callBoardTool's board_create, board_archive, board_subscribe, board_read and claim_list give core's answers and leave its rows", async () => {
  const access = boardAccess(repo);
  const out: [string, unknown, unknown][] = [];
  for (const c of WRITE_CALLERS) for (const [tool, args] of WRITE_CALLS()) {
    const actor = boardActor(repo.coreOn(repo.read), tool, args, session(c));
    const want = await inBodyBoards(async tx => outcome(() => coreCallBoardTool(repo.coreOn(tx), actor, tool, args, coreCtx(c))));
    const got = await inBodyBoards(tx => outcomeAsync(() => callBoardTool(repo, access, tx, actor, tool, args, serverCtx(c))));
    out.push([`${c.label} ${tool} ${JSON.stringify(args)}`, settled(want), settled(got)]);
  }
  expect(diverging(out)).toEqual([]);
  // The fixture reaches each branch the port decides.
  const text = (l: string) => JSON.stringify((out.find(([x]) => x === l)![1] as { out: unknown }).out);
  const rows = (l: string) => JSON.stringify((out.find(([x]) => x === l)![1] as { rows: unknown }).rows);
  const all = out.map(([, s]) => JSON.stringify(s)).join("\n");
  expect(text(`wade board_create {"name":"general","purpose":"everyone"}`)).toContain("you created #general at");
  expect(text(`wade via slack board_create {"name":"general","purpose":"everyone"}`)).toContain("already exists");
  expect(text(`wade board_create {"name":"eng","purpose":"eng work","team":"ENG"}`)).toContain("you created #eng at");
  expect(text(`wade board_create {"name":"attic","purpose":"old"}`)).toContain("already exists, archived");
  expect(text(`dan, sessionless board_create {"name":"attic","purpose":"old"}`)).toContain("already exists, archived");
  expect(text(`dan, sessionless board_create {"name":"t2","purpose":"x","team":"eng"}`)).toContain("error");
  expect(rows(`wade board_create {"name":"new","purpose":" fresh "}`)).toContain(`{"board":"new","handle":"${W}/be","mode":"push"`);
  expect(text(`wade board_archive {"board":"general"}`)).toContain(`"archived_at":"now","archived_by":"${W}/be"`);
  expect(text(`wade board_archive {"board":"attic"}`)).toContain("was already archived at");
  expect(text(`wade board_archive {"board":"general","archived":false}`)).toContain("isn't archived");
  expect(rows(`wade board_archive {"board":"#Attic","archived":false}`)).toContain(`{"name":"attic","purpose":"old","scope":null,"created_by":"${W}/be","kind":"broadcast","fresh":0,"archived_now":null,"archived":0,"archived_by":null}`);
  expect(text(`bob's human board_archive {"board":"bobs"}`)).toContain(`"archived_by":"${B}/human"`);
  expect(text(`bob's human board_archive {"board":"general"}`)).toContain(`its user (${W}`);
  expect(text(`wade via slack board_archive {"board":"general"}`)).toContain("\"archived_at\":\"now\"");
  expect(text(`bob board_archive {"board":"eng"}`)).toContain("belongs to the bus itself");
  expect(rows(`wade board_subscribe {"board":"general","mode":"off","thread":${REPLY}}`)).toContain(`{"handle":"${W}/be","root_id":${ROOT}}`);
  expect(text(`wade board_subscribe {"board":"#General","mode":"push","thread":${ROOT}}`)).toContain(`#general thread ${ROOT} unmuted`);
  expect(text(`wade board_subscribe {"board":"general","mode":"off","thread":${PLAN}}`)).toContain("is not a post on #general");
  expect(text(`wade board_subscribe {"board":"#ENG","mode":"quiet"}`)).toContain("ok: #eng → quiet");
  expect(text(`bob board_read {"board":"general"}`)).toContain("@qa look");
  expect(rows(`bob board_read {"board":"general"}`)).toContain(`{"handle":"${B}/qa","post_id":`);
  expect(rows(`bob board_read {"board":"general"}`)).not.toMatch(new RegExp(`"handle":"${B}/qa","post_id":\\d+,"delivered":0`));
  expect(rows(`bob claim_list {}`)).toMatch(new RegExp(`"handle":"${B}/qa","post_id":\\d+,"delivered":0`));
  expect(rows(`wade's child board_read {"board":"general"}`)).toEqual(rows(`wade's child claim_list {}`));
  expect(text(`wade board_read {"board":"eng"}`)).toContain("active_claims");
  expect(text(`wade board_read {"board":"general"}`)).toContain(`"holder":"eng/ghost"`);
  expect(text(`dan, sessionless board_read {"board":"general"}`)).toContain(`"key":"ticket:4","holder":null,"note":null`);
  expect(text(`dan, sessionless claim_list {}`)).toContain(`"key":"ticket:1","holder":null,"note":null,"board":null`);
  expect(text(`dan unbound claim_list {}`)).toContain(`"key":"ticket:2","holder":"${E}/be","note":null,"board":null`); // #1257: a hidden board's note stays there
  expect(text(`wade claim_list {}`)).toContain(`"key":"ticket:2","holder":"${E}/be","note":"paging","board":"ops"`);
  expect(text(`wade claim_list {}`)).not.toContain("ticket:6");
  expect(text(`wade claim_list {"prefix":"%"}`)).toBe(JSON.stringify({ value: { result: [], wake: [] } }));
  for (const refused of ["purpose is required", "purpose must be at most", "kind must be", "name must be a string", "purpose must be a string", "archived must be a boolean", "board must be a string", "mode must be push", "with thread, mode is", "thread must be a number", "mode must be a string", "limit must be a number", "prefix must be a string", "no such board", "can archive or reopen it"]) {
    expect(all).toContain(refused);
  }
}, 120_000);

// What SQLite can't reach: on Postgres a concurrent first create commits between board_create's read and its insert
// (C1), and the repo's subscription write needn't check the mode itself. A repo whose first read of a board misses
// stands in for the first; one whose setSubscription records instead of checking, for the second.
test("board_create answers a create that lost the insert to its own repeat as the repeat; board_subscribe checks the mode itself", async () => {
  const access = boardAccess(repo);
  const wade = CALLERS[0]!;
  const lost = (): Repo => {
    let missed = false;
    return { ...repo, boards: { ...repo.boards, get: async (r, name) => (missed ? repo.boards.get(r, name) : ((missed = true), undefined)) } };
  };
  const create = (purpose: string) => inBodyBoards(tx => outcomeAsync(() => callBoardTool(lost(), access, tx, `${W}/be`, "board_create", { name: "general", purpose }, serverCtx(wade))));
  expect(JSON.stringify(await create("everyone"))).toContain("you created #general at");
  expect(JSON.stringify(await create("different"))).toContain("already exists");
  const writes: string[] = [];
  const recording: Repo = { ...repo, boards: { ...repo.boards, setSubscription: async (_tx, _h, _b, mode) => void writes.push(mode) } };
  const sub = await inBodyBoards(tx => outcomeAsync(() => callBoardTool(recording, access, tx, `${W}/be`, "board_subscribe", { board: "general", mode: "bogus" }, serverCtx(wade))));
  expect(JSON.stringify(sub)).toContain("mode must be push");
  expect(writes).toEqual([]);
});

// A body that fails after board_create or board_archive leaves nothing: the insert, its subscription and the archive
// stamp roll back with it.
test("board_create and board_archive roll back with a body that throws after them", async () => {
  const access = boardAccess(repo);
  const wade = serverCtx(CALLERS[0]!);
  const failing = (tool: string, args: Record<string, unknown>) =>
    repo.write(async tx => { await callBoardTool(repo, access, tx, `${W}/be`, tool, args, wade); throw new Error("later step failed"); });
  await expect(failing("board_create", { name: "doomed", purpose: "x" })).rejects.toThrow("later step failed");
  expect(await repo.boards.get(repo.read, "doomed")).toBeUndefined();
  expect(repo.coreOn(repo.read).prepare(`SELECT count(*) AS n FROM subscriptions WHERE board = 'doomed'`).get()).toEqual({ n: 0 });
  await expect(failing("board_archive", { board: "general" })).rejects.toThrow("later step failed");
  expect((await repo.boards.get(repo.read, "general"))!.archived_at ?? null).toBeNull();
  await expect(failing("board_archive", { board: "attic", archived: false })).rejects.toThrow("later step failed");
  expect((await repo.boards.get(repo.read, "attic"))!.archived_at).toBeGreaterThan(0);
});

// A1, which SQLite can't reach: board_archive's conditional update finds the board already changed by a concurrent
// write. A stubbed setArchived stands in: one whose "concurrent" archive commits first, one whose third write flips the
// board back before the re-read (the update is tried again), and one that never takes (refused after a bounded retry).
test("board_archive answers a lost conditional update as the repeat it now is, retrying a flipped-back board a bounded number of times", async () => {
  const access = boardAccess(repo);
  const wade = serverCtx(CALLERS[0]!);
  const stubbed = (setArchived: Repo["boards"]["setArchived"]): Repo => ({ ...repo, boards: { ...repo.boards, setArchived } });
  const archive = (r: Repo) => inBodyBoards(tx => outcomeAsync(() => callBoardTool(r, access, tx, `${W}/be`, "board_archive", { board: "general" }, wade)));
  // Eve's archive commits between wade's read and wade's update.
  let calls = 0;
  const lost = await archive(stubbed(async (tx, name, _by, now) => { calls++; await repo.boards.setArchived(tx, name, `${E}/be`, now); return null; }));
  expect(calls).toBe(1);
  expect(JSON.stringify(lost)).toContain(`was already archived at`);
  expect(JSON.stringify(lost)).toContain(`by ${E}/be`);
  expect((lost as { out: { value: Record<string, unknown> } }).out.value.boards).toBeUndefined();
  // The first update loses to a write since undone; the second takes.
  calls = 0;
  const retried = await archive(stubbed(async (tx, name, by, now) => (++calls === 1 ? null : repo.boards.setArchived(tx, name, by, now))));
  expect(calls).toBe(2);
  expect((retried as { out: { value: Record<string, unknown> } }).out.value).toMatchObject({ boards: ["general"], result: { archived_by: `${W}/be` } });
  // Never takes: refused, nothing written.
  calls = 0;
  const stuck = await archive(stubbed(async () => { calls++; return null; }));
  expect(calls).toBe(3);
  expect(JSON.stringify(stuck)).toContain("kept changing while it was archived; try again");
  expect(JSON.stringify((stuck as { rows: unknown }).rows)).toContain(`"name":"general","purpose":"everyone","scope":null,"created_by":"${W}/be","kind":"broadcast","fresh":0,"archived_now":null,"archived":0`);
});
