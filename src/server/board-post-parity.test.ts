// The server's board_post (#807 P3 B5b2b) gives core's answers: postGateOn then serverPost, as handleBoardPost runs
// them, return core callBoardTool's board_post result or refusal and leave its rows (posts, outbox, claims, claim
// events and watches, subscriptions, attachment bindings), over the shared parity fixture extended with live sessions,
// a muted thread, a thread a human wrote in, a queue board with lanes (a viewer's and an opted-out one among them), a held queue claim and one since deleted,
// and uploads, for callers bound and unbound, a cross-user writer, humans and a child session.
import { beforeEach, expect, test } from "bun:test";
import { attachmentIds } from "../core/attachments.ts";
import { boardActor } from "../core/bindings.ts";
import type { CoreDb } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool as coreCallBoardTool, type ToolContext } from "../core/tools.ts";
import { boardAccess, type BoardAccess } from "./access.ts";
import { postGateOn, serverPost } from "./board_post.ts";
import type { Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { B, BOB_ID, CHILD_ID, D, DAN_WRITER, diverging, E, ENDED_ID, EVE_ID, inBody as inBodyOn, ONLINE, openPostParity, outcome, outcomeAsync, TAIL_ID, UNKNOWN_ID, W, WADE_ID } from "../../tests/support/board_parity.ts";

let repo: Repo;
let db: CoreDb;
let T1 = 0;
let ROOT = 0, REPLY = 0, PLAN = 0, ATTIC = 0, QPOST = 0, QLATE = 0, UP_W = 0, UP_W2 = 0, UP_B = 0;

beforeEach(async () => {
  ({ repo, db, T1, ROOT, REPLY, PLAN, ATTIC, QPOST, QLATE, UP_W, UP_W2, UP_B } = await openPostParity());
});



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
  { board: "q", body: "work item" }, { board: "q", body: "@qa take this" }, { board: "q", body: `@${E}/be take this` }, { board: "q", body: "@be @deploy both" }, { board: "q", body: `@${B}/be @${E}/be both` }, { board: "q", body: `@${B}/human take` },
  { board: "q", body: `@${TAIL_ID} you?` }, { board: "q", body: "done", parent_id: QPOST }, { board: "q", body: "late", parent_id: QLATE }, { board: "q", body: `@${UNKNOWN_ID} x` },
  { board: "general", body: "@eng/deploy hi" }, { board: "q", body: "@eng/deploy take" },
  { board: "q", body: `@${E}/be mine` }, { board: "q", body: `@${E}/be @nobody mine` },
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

const inBody = (f: (tx: Tx) => Promise<unknown>) => inBodyOn(repo, T1, f);


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
  // bob's human is neither parent nor root author of bob's reply: only the human mark wakes it (eve may not reach it).
  expect(call("bob", { board: "general", body: "reply", parent_id: ROOT }).out.value!.wake).toContain(`${B}/human`);
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
  // A human named on a queue board is woken but holds no claim (#219: only an agent takes a mention claim).
  const human = call("wade", { board: "q", body: `@${B}/human take` });
  expect(human.out.value!.wake).toEqual([`${B}/human`]);
  expect(JSON.stringify(human.rows.claims)).not.toContain(`queue:q:${human.out.value!.result.post_id}`);
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
  // #1185: a queue post naming only the poster's own address (or it and a name nobody has) rotates to a lane.
  for (const [label, body] of [["eve", `@${E}/be mine`], ["eve", `@${E}/be @nobody mine`], ["wade", "@eng/deploy take"]] as const) {
    const self = call(label, { board: "q", body });
    const id = self.out.value!.result.post_id;
    const held = (self.rows.claims as { key: string; holder: string; note: string }[]).find(c => c.key === `queue:q:${id}`);
    expect(held?.note).toBe("queue post");
    expect(self.out.value!.wake).toEqual([held!.holder]);
  }
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
