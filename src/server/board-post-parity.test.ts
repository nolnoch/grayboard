// The server's board_post (#807 P3 B5b2b) gives core's answers: postGateOn then serverPost, as handleBoardPost runs
// them, return core callBoardTool's board_post result or refusal and leave its rows (posts, outbox, claims, claim
// events and watches, subscriptions, attachment bindings), over the shared parity fixture extended with live sessions,
// a muted thread, a queue board with lanes (a viewer's and an opted-out one among them), held and lapsed queue claims,
// and uploads, for callers bound and unbound, a cross-user writer, humans and a child session.
import { beforeEach, expect, test } from "bun:test";
import { attachmentIds, insertUpload } from "../core/attachments.ts";
import { boardActor, holdAlias, idAddress } from "../core/bindings.ts";
import { archiveBoard, createBoard, markHuman, muteThread, post, registerId, setSubscription, subscribe, touchAlias, type CoreDb } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool as coreCallBoardTool, type ToolContext } from "../core/tools.ts";
import { boardAccess, principalCanSee, type BoardAccess } from "./access.ts";
import { postGateOn, serverPost } from "./board_post.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";
import { B, D, E, ENDED_ID, openBoardParity, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

const BOB_ID = idAddress("c".repeat(64)), EVE_ID = idAddress("d".repeat(64)), TAIL_ID = idAddress("e".repeat(64));
const DAN_WRITER = idAddress("8".repeat(64)), CHILD_ID = idAddress("5".repeat(64)), UNKNOWN_ID = idAddress("f".repeat(64));

let repo: Repo;
let db: CoreDb;
let T1 = 0;
let ROOT = 0, REPLY = 0, PLAN = 0, ATTIC = 0, QPOST = 0, QLATE = 0, UP_W = 0, UP_W2 = 0, UP_B = 0;

beforeEach(async () => {
  ({ repo, db } = await openBoardParity());
  const T0 = Date.now() - 600_000;
  await seed(repo, async tx => {
    const core = repo.coreOn(tx);
    registerId(core, { id: BOB_ID, principal: B, launcher: false });
    registerId(core, { id: EVE_ID, principal: E, launcher: false });
    registerId(core, { id: TAIL_ID, principal: W, launcher: false, viewer: true });
    registerId(core, { id: DAN_WRITER, principal: D, launcher: false, writesAs: `${B}/be` });
    registerId(core, { id: CHILD_ID, principal: W, launcher: false, rootId: WADE_ID });
    const holds: [string, string][] = [[`${W}/be`, WADE_ID], ["eng/deploy", WADE_ID], [`${B}/be`, BOB_ID], [`${B}/qa`, BOB_ID], [`${E}/be`, EVE_ID], ["ops/deploy", EVE_ID]];
    for (const [address, id] of holds) { holdAlias(core, address, id, T0); touchAlias(core, address, T0); }
    touchAlias(core, `${D}/be`, T0);
    core.prepare(`UPDATE aliases SET queue_off = 1 WHERE address = ?`).run(`${B}/qa`);
    markHuman(core, `${B}/human`, true);
    createBoard(core, `${W}/be`, "general", "everyone");
    createBoard(core, `${W}/be`, "eng", "eng work", "team:eng");
    createBoard(core, `${E}/be`, "ops", "ops work", "team:ops");
    subscribe(core, `${B}/qa`, "general", "push");
    subscribe(core, `${E}/be`, "general", "digest");
    subscribe(core, `${D}/be`, "general", "push");
    subscribe(core, TAIL_ID, "general", "push");
    subscribe(core, `${B}/be`, "eng", "push");
    // A subscription left by sight since lost (dan was never in eng): judged on the post, never pushed.
    setSubscription(core, `${D}/be`, "eng", "push");
    subscribe(core, `${W}/be`, "ops", "digest");
    // A thread wade wrote in and muted: a reply reaches its other authors but not him, short of a mention.
    ROOT = post(core, `${B}/be`, "general", "thread root").post.id;
    REPLY = post(core, `${E}/be`, "general", "a reply", ROOT).post.id;
    post(core, `${W}/be`, "general", "me too", ROOT);
    muteThread(core, `${W}/be`, "general", ROOT, true);
    PLAN = post(core, `${W}/be`, "eng", "eng plan").post.id;
    createBoard(core, `${W}/be`, "attic", "old");
    ATTIC = post(core, `${W}/be`, "attic", "last").post.id;
    archiveBoard(core, `${W}/be`, "attic", true);
    // A queue board: wade made it; bob's be and qa (opted out), eve, deploy, dan and wade's viewer tail are lanes.
    createBoard(core, `${W}/be`, "q", "work", null, { kind: "queue" });
    for (const lane of [`${B}/be`, `${B}/qa`, `${E}/be`, "eng/deploy", `${D}/be`, TAIL_ID]) subscribe(core, lane, "q", "push");
    // A team queue board, so a mention of a non-member is judged on a queue too.
    createBoard(core, `${W}/be`, "engq", "eng work", "team:eng", { kind: "queue" });
    subscribe(core, `${B}/be`, "engq", "push");
    // eve hands a post to bob's be (a mention claim he holds) and another whose claim has since gone, then rotates one
    // to the live, never-woken eng/deploy: a later rotation prefers the lanes never woken.
    // An author's own words (strictIds), as a board_post is: only those hand a mention a claim (#219).
    QPOST = post(core, `${E}/be`, "q", `@${B}/be please`, null, { strictIds: true }).post.id;
    QLATE = post(core, `${E}/be`, "q", `@${B}/be also`, null, { strictIds: true }).post.id;
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:q:${QLATE}`);
    post(core, `${E}/be`, "q", "deploy it", null, { strictIds: true, online: h => ONLINE.has(h) });
    // A claim watcher on bob's held key: an ack ends the claim, and the watch with it.
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:q:${QPOST}`, `${E}/be`);
    const up = (uploader: string, principal: string, name: string) =>
      insertUpload(core, { sha256: name.padEnd(64, "0"), filename: `${name}.txt`, type: "text/plain", size: 10, uploader, quota: { principal, unsent: 1e9, stored: 1e9 }, now: T0 }).row.id;
    UP_W = up(`${W}/be`, W, "a");
    UP_W2 = up("eng/deploy", W, "b");
    UP_B = up(`${B}/be`, B, "c");
  });
  T1 = Date.now();
  while (Date.now() <= T1) { /* the next millisecond */ }
});

const ONLINE = new Set([`${W}/be`, "eng/deploy", `${E}/be`, "ops/deploy", `${B}/be`, WADE_ID]);

type Caller = { label: string; addresses: string[]; user: string; session?: string; human?: boolean; via?: string };
const CALLERS: Caller[] = [
  { label: "wade", addresses: [`${W}/be`, "eng/deploy"], user: W, session: WADE_ID },
  { label: "wade, deploy first", addresses: ["eng/deploy", `${W}/be`], user: W, session: WADE_ID },
  { label: "bob", addresses: [`${B}/be`, `${B}/qa`], user: B, session: BOB_ID },
  { label: "bob as qa", addresses: [`${B}/qa`, `${B}/be`], user: B, session: BOB_ID },
  { label: "eve", addresses: [`${E}/be`, "ops/deploy"], user: E, session: EVE_ID },
  { label: "dan, sessionless", addresses: [`${D}/be`], user: D },
  { label: "dan writing as bob", addresses: [`${B}/be`], user: D, session: DAN_WRITER },
  { label: "wade's tail", addresses: [TAIL_ID], user: W, session: TAIL_ID },
  { label: "bob's ended", addresses: [ENDED_ID], user: B },
  { label: "wade via slack", addresses: [`${W}/be`], user: W, session: WADE_ID, human: true },
  { label: "bob's human", addresses: [`${B}/human`], user: B },
  { label: "wade's child", addresses: [`${W}/be`, "eng/deploy"], user: W, session: CHILD_ID, via: CHILD_ID },
];

const CALLS = (): Record<string, unknown>[] => [
  { board: "general", body: "hello" }, { board: "#General", body: "case" }, { board: "general", body: "" }, { board: "general", body: "   " },
  { board: "general", body: "x".repeat(40_000) }, { board: "nope", body: "x" }, { board: 7, body: "x" }, { board: "general", body: 3 }, { board: "general" },
  { board: "general", body: "reply", parent_id: ROOT }, { board: "general", body: "deeper", parent_id: REPLY }, { board: "general", body: `@be look`, parent_id: REPLY }, { board: "general", body: `@${W}/be look`, parent_id: ROOT },
  { board: "general", body: "elsewhere", parent_id: PLAN }, { board: "general", body: "gone", parent_id: 999_999 }, { board: "general", body: "x", parent_id: "x" },
  { board: "general", body: "@qa look" }, { board: "general", body: "@be hi" }, { board: "general", body: "@deploy hi" }, { board: "general", body: `@${B}/qa @${D}/be both` },
  { board: "general", body: `@${ENDED_ID} hi` }, { board: "general", body: `@${UNKNOWN_ID} hi` }, { board: "general", body: `@${WADE_ID} hi` }, { board: "general", body: `@${CHILD_ID} hi` },
  { board: "general", body: "@human hi" }, { board: "general", body: "@nobody hi" },
  { board: "eng", body: "plan b" }, { board: "eng", body: `@${D}/be you?` }, { board: "eng", body: "@deploy go" }, { board: "ops", body: "@deploy page" },
  { board: "attic", body: "revive" }, { board: "attic", body: "late reply", parent_id: ATTIC },
  { board: "q", body: "work item" }, { board: "q", body: "@qa take this" }, { board: "q", body: `@${E}/be take this` }, { board: "q", body: "@be @deploy both" }, { board: "q", body: `@${B}/be @${E}/be both` },
  { board: "q", body: `@${TAIL_ID} you?` }, { board: "q", body: "done", parent_id: QPOST }, { board: "q", body: "late", parent_id: QLATE }, { board: "q", body: `@${UNKNOWN_ID} x` },
  { board: "general", body: "@eng/deploy hi" }, { board: "q", body: "@eng/deploy take" },
  { board: "engq", body: `@${D}/be you?` }, { board: "engq", body: "work" },
  { board: "general", body: "file", attachment_ids: [UP_W] }, { board: "general", body: "files", attachment_ids: [UP_W, UP_W2] }, { board: "general", body: "theirs", attachment_ids: [UP_B] },
  { board: "general", body: `file @${UNKNOWN_ID}`, attachment_ids: [UP_W] }, { board: "general", body: "bad", attachment_ids: "x" }, { board: "general", body: "path", attachments: ["/etc/passwd"] },
  { board: "q", body: "queued file", attachment_ids: [UP_W] },
];

const ctxOf = (c: Caller): ToolContext => ({
  online: h => ONLINE.has(h),
  files: { limits: repo.attachmentLimits, principal: c.user },
  user: c.user,
  addresses: c.addresses,
  ...(c.session ? { session: c.session } : {}),
  ...(c.human ? { human: true } : {}),
  ...(c.via ? { via: c.via } : {}),
});
const session = (c: Caller) => ({ addresses: c.addresses, asAddresses: c.addresses, ownScope: c.user });

// handleBoardPost's path less the dedup receipt: its argument checks, the gate on the Tx, the post in a savepoint.
async function portPost(access: BoardAccess, tx: Tx, actor: string, args: Record<string, unknown>, ctx: ToolContext) {
  if (typeof args.board !== "string") throw new CoreError("board must be a string");
  if (typeof args.body !== "string") throw new CoreError("body must be a string");
  attachmentIds(args.attachment_ids);
  const parentId = args.parent_id ?? null;
  if (parentId !== null && typeof parentId !== "number") throw new CoreError("parent_id must be a number");
  const { board, gate } = await postGateOn(repo, access, tx, actor, args.board, parentId);
  // writeOnce's savepoint: a refusal after the insert rolls the post back, as core's nested transaction does.
  return tx.savepoint(sp => serverPost(repo, access, sp, actor, board, gate, args, ctx));
}

const outcome = <T>(f: () => T): { value: T } | { error: string; code?: string } => {
  try { return { value: f() }; } catch (e) { return refused(e); }
};
const outcomeAsync = async <T>(f: () => Promise<T>): Promise<{ value: T } | { error: string; code?: string }> => {
  try { return { value: await f() }; } catch (e) { return refused(e); }
};
// A refusal's text and class: core's CoreError or an Undeliverable's code must survive the port.
const refused = (e: unknown) => {
  const err = e as Error & { code?: string };
  return { error: `${err.constructor.name}: ${err.message}`, ...(err.code ? { code: err.code } : {}) };
};

// The rows board_post writes, every time a call set reduced to "now".
const rows = (tx: Read) => {
  const c = repo.coreOn(tx);
  return {
    posts: c.prepare(`SELECT * FROM posts ORDER BY id`).all(),
    outbox: c.prepare(`SELECT * FROM outbox ORDER BY handle, post_id`).all(),
    claims: c.prepare(`SELECT * FROM claims ORDER BY key`).all(),
    claim_events: c.prepare(`SELECT * FROM claim_events ORDER BY id`).all(),
    claim_watches: c.prepare(`SELECT * FROM claim_watches ORDER BY key, handle`).all(),
    subscriptions: c.prepare(`SELECT board, handle, mode, cursor, notified_id FROM subscriptions ORDER BY board, handle`).all(),
    attachments: c.prepare(`SELECT id, post_id, message_id FROM attachments ORDER BY id`).all(),
  };
};
const TIMES = new Set(["created_at", "acquired_at", "expires_at", "at", "delivered_at"]);
const settled = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (TIMES.has(k) && typeof x === "number" && x > T1 ? (k === "expires_at" ? "later" : "now") : x)));

class Rollback { constructor(readonly value: unknown) {} }
async function inBody(f: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  try { await repo.write(async tx => { throw new Rollback({ out: await f(tx), rows: rows(tx) }); }); }
  catch (e) { if (e instanceof Rollback) return settled(e.value); throw e; }
  throw new Error("unreachable");
}
// Each diverging call with only the parts that differ: its answer, or the tables whose rows differ.
const diverging = (rs: [string, unknown, unknown][]) => rs.filter(([, s, a]) => JSON.stringify(s) !== JSON.stringify(a)).map(([l, s, a]) => {
  const [w, g] = [s, a] as { out: unknown; rows: Record<string, unknown> }[];
  const d: Record<string, unknown> = { l };
  if (JSON.stringify(w!.out) !== JSON.stringify(g!.out)) Object.assign(d, { core: w!.out, port: g!.out });
  for (const t of Object.keys(w!.rows)) {
    const [cw, cg] = [w!.rows[t] as unknown[], g!.rows[t] as unknown[]];
    const differs = (x: unknown[], y: unknown[]) => x.filter((r, i) => JSON.stringify(r) !== JSON.stringify(y[i]));
    if (JSON.stringify(cw) !== JSON.stringify(cg)) d[t] = { core: differs(cw, cg), port: differs(cg, cw) };
  }
  return d;
});

test("board_post gives core's answers and leaves its rows, for every caller and call", async () => {
  const access = boardAccess(repo);
  const out: [string, unknown, unknown][] = [];
  for (const c of CALLERS) for (const args of CALLS()) {
    // The actor handleCall picks; one it refuses never reaches board_post.
    let actor: string;
    try { actor = boardActor(repo.coreOn(repo.read), "board_post", args, session(c)); } catch { continue; }
    const want = await inBody(async tx => outcome(() => {
      const r = coreCallBoardTool(repo.coreOn(tx), actor, "board_post", args, ctxOf(c));
      return { result: r.result, wake: r.wake };
    }));
    const got = await inBody(tx => outcomeAsync(() => portPost(access, tx, actor, args, ctxOf(c))));
    out.push([`${c.label} ${JSON.stringify(args)}`, want, got]);
  }
  expect(diverging(out)).toEqual([]);

  // The fixture reaches each branch the port decides.
  const at = (l: string) => out.find(([x]) => x === l)?.[1] as { out: { value?: { result: Record<string, unknown>; wake: string[] }; error?: string; code?: string }; rows: Record<string, unknown[]> };
  const call = (label: string, args: Record<string, unknown>) => {
    const r = at(`${label} ${JSON.stringify(args)}`);
    if (!r) throw new Error(`no call ${label} ${JSON.stringify(args)}`);
    return r;
  };
  const text = (label: string, args: Record<string, unknown>) => JSON.stringify(call(label, args).out);
  const rowsOf = (label: string, args: Record<string, unknown>) => JSON.stringify(call(label, args).rows);
  const all = out.map(([, s]) => JSON.stringify(s)).join("\n");
  // Thread wake: the muted author is skipped, the others notified; a mention reaches the muted one anyway.
  const reply = call("eve", { board: "general", body: "reply", parent_id: ROOT }).out.value!;
  expect(reply.wake).toContain(`${B}/be`);
  expect(reply.wake).not.toContain(`${W}/be`);
  expect(call("eve", { board: "general", body: `@${W}/be look`, parent_id: ROOT }).out.value!.wake).toContain(`${W}/be`);
  // Queue rotation: one lane, never the poster, the viewer tail or the opted-out qa; the claim and its take event.
  const rot = call("wade", { board: "q", body: "work item" });
  // eve: live and never woken; eng/deploy is wade's own, bob's be woken already, qa opted out, the tail a viewer.
  expect(rot.out.value!.wake).toEqual([`${E}/be`]);
  expect(JSON.stringify(rot.rows.claim_events)).toContain(`"event":"take"`);
  // A mention claim on a queue board; two mentions reach both and claim nothing.
  expect(rowsOf("wade", { board: "q", body: `@${E}/be take this` })).toContain(`"holder":"${E}/be"`);
  const two = call("wade", { board: "q", body: `@${B}/be @${E}/be both` });
  expect(two.out.value!.wake.sort()).toEqual([`${B}/be`, `${E}/be`]);
  expect(JSON.stringify(two.rows.claims)).not.toContain(`queue:q:${two.out.value!.result.post_id}`);
  // bob's reply acks his claim and its watch goes; the lapsed one has nothing to ack.
  const ack = call("bob", { board: "q", body: "done", parent_id: QPOST }).rows;
  expect(JSON.stringify(ack.claims)).not.toContain(`queue:q:${QPOST}`);
  expect(ack.claim_watches).toEqual([]);
  expect(JSON.stringify(ack.claim_events)).toContain(`"key":"queue:q:${QPOST}","handle":"${B}/be","event":"release"`);
  // Strict @id: refusals keep their code.
  expect(call("wade", { board: "general", body: `@${UNKNOWN_ID} hi` }).out.code).toBe("not_found");
  expect(call("wade", { board: "general", body: `@${ENDED_ID} hi` }).out.code).toBe("id_ended");
  expect(call("wade", { board: "general", body: `@${CHILD_ID} hi` }).out.code).toBe("child_session");
  // A team alias dan may not see is woken but reads to him as unresolved (#871); on a queue board it's no claim, so a lane rotates.
  const hidden = call("dan, sessionless", { board: "general", body: "@eng/deploy hi" }).out.value!;
  expect(hidden.wake).toContain("eng/deploy");
  expect(hidden.result.notified).not.toContain("eng/deploy");
  expect(hidden.result.unresolved).toEqual(["eng/deploy"]);
  const hiddenQ = call("dan, sessionless", { board: "q", body: "@eng/deploy take" });
  expect(JSON.stringify(hiddenQ.rows.claims)).not.toContain(`"holder":"eng/deploy","note":"queue post (mentioned)"`);
  // A team board's non-member is unresolved, on a queue board too.
  expect(text("wade", { board: "eng", body: `@${D}/be you?` })).toContain("unresolved");
  expect(text("wade", { board: "engq", body: `@${D}/be you?` })).toContain("unresolved");
  // Attachments bind; another's upload refuses and leaves no post; a strict refusal after the bind unbinds it.
  expect(rowsOf("wade", { board: "general", body: "file", attachment_ids: [UP_W] })).toMatch(new RegExp(`"id":${UP_W},"post_id":\\d+`));
  expect(text("wade", { board: "general", body: "theirs", attachment_ids: [UP_B] })).toContain("isn't an unsent upload of yours");
  expect(rowsOf("wade", { board: "general", body: `file @${UNKNOWN_ID}`, attachment_ids: [UP_W] })).toContain(`"id":${UP_W},"post_id":null`);
  // A child's post carries via, and reaches none of its root's addresses.
  const child = call("wade's child", { board: "general", body: "reply", parent_id: ROOT });
  expect(JSON.stringify(child.rows.posts)).toContain(`"via":"${CHILD_ID}"`);
  // The archived board's top-level refusal and its allowed reply.
  expect(text("wade", { board: "attic", body: "revive" })).toContain("archived");
  expect(text("wade", { board: "attic", body: "late reply", parent_id: ATTIC })).toContain("post_id");
  for (const refusal of ["no such board", "is not a post on #general", "body must be a string", "board must be a string", "parent_id must be a number", "attachments must be read", "isn't in your scope"]) {
    expect(all).toContain(refusal);
  }
}, 180_000);
