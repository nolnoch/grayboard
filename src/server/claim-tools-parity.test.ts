// The server's claim steps (#807 P3 B5b3b) give core's answers: sweepClaims leaves the rows core sweepChanges leaves
// (claims, claim events and watches, posts, outbox) and wakes the same handles, over the post parity fixture plus
// lapsed claims reaching every branch of the sweep: an announced lapse with a watcher, each of holderUser's fallbacks
// (an ID, a held alias, an unheld person alias, an unheld team alias, a recorded user), a holder who lost the board, an
// archived board, a regular claim on a queue board, no board, and queue posts with a lane left, none left, and none
// left whose `[unclaimed]` reply the holder can no longer write.
import { beforeEach, expect, spyOn, test } from "bun:test";
import { claimQueuePost, post, subscribe } from "../core/boards.ts";
import { boardActor } from "../core/bindings.ts";
import { logEvent, sweepChanges } from "../core/claims.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool as coreCallBoardTool, type ToolContext } from "../core/tools.ts";
import { boardAccess } from "./access.ts";
import { callClaimTool, sweepClaims } from "./claims.ts";
import type { Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { B, BOB_ID, CHILD_ID, D, DAN_WRITER, diverging, E, ENDED_ID, EVE_ID, inBody as inBodyOn, ONLINE, openPostParity, outcome, outcomeAsync, TAIL_ID, team, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

let repo: Repo;
let T1 = 0;
let QPOST = 0, ENGQ = 0, LOST = 0, TAILQ = 0, ENGQ2 = 0, QLIVE = 0;

beforeEach(async () => {
  const f = await openPostParity();
  ({ repo, QPOST } = f);
  await seed(repo, async tx => {
    await repo.aliases.create(tx, team("eng", "idle"), W);
    const core = repo.coreOn(tx);
    const lapsed = (key: string, holder: string, board: string | null, user: string | null = null) =>
      core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user) VALUES (?, ?, 'n', ?, 1, 2, ?)`).run(key, holder, board, user);
    lapsed("ticket:watched", `${W}/be`, "general");
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?), (?, ?)`).run("ticket:watched", `${E}/be`, "ticket:watched", `${B}/be`);
    lapsed("ticket:id", WADE_ID, "general");
    lapsed("ticket:person", `${D}/be`, "general");
    lapsed("ticket:team", "eng/idle", "eng");
    lapsed("ticket:user", `${B}/be`, "eng", B);
    // dan never was in eng: he lapses quietly, and his watcher's watch goes all the same.
    lapsed("ticket:lost", `${D}/be`, "eng");
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:lost", `${W}/be`);
    lapsed("ticket:attic-lapsed", `${W}/be`, "attic");
    lapsed("ticket:q", `${E}/be`, "q");
    lapsed("ticket:none", `${E}/be`, null);
    core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES ('ticket:live', ?, 'n', 'general', 1, ?)`).run(`${W}/be`, Date.now() + 3_600_000);
    // bob's held queue claim lapses with lanes left: the post goes on.
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:q:${QPOST}`);
    // engq's only lane is bob's be: his lapse leaves no lane, so the post gets an [unclaimed] reply.
    ENGQ = post(core, `${W}/be`, "engq", "eng work").post.id;
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${ENGQ}`);
    // A lane dan held on engq though he was never in eng, bob's turn already spent: no lane, and dan can't reply there.
    subscribe(core, `${B}/qa`, "engq", "push");
    LOST = post(core, `${W}/be`, "engq", "more eng work").post.id;
    for (const [key, h] of [[`queue:engq:${LOST}`, `${B}/be`], [`queue:engq:${LOST}`, `${B}/qa`]] as const) logEvent(core, "take", h, { key }, 1);
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:engq:${LOST}`);
    claimQueuePost(core, "engq", LOST, `${D}/be`, 1);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${LOST}`);
    // Every lane on q but wade's viewer tail has had its turn: a viewer is never a lane, so the post gets [unclaimed].
    TAILQ = post(core, `${E}/be`, "q", `@${D}/be tail work`, null, { strictIds: true }).post.id;
    for (const h of [`${B}/be`, `${B}/qa`, "eng/deploy"]) logEvent(core, "take", h, { key: `queue:q:${TAILQ}` }, 1);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:q:${TAILQ}`);
    // B5b3c's tool calls: live claims a take finds held, a release ends and a watch follows. ticket:live has a watcher.
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:live", `${E}/be`);
    const live = (key: string, holder: string, board: string | null) =>
      core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, 'n', ?, 1, ?)`).run(key, holder, board, Date.now() + 3_600_000);
    // eng/deploy holds on eng: hidden from eve and dan, who can't see eng.
    live("ticket:eng", "eng/deploy", "eng");
    live("ticket:attic", `${W}/be`, "attic");
    live("ticket:onq", `${B}/be`, "q");
    live("ticket:nob", `${B}/be`, null);
    // bob released ticket:gone a moment ago: a repeat release answers "already released".
    logEvent(core, "release", `${B}/be`, { key: "ticket:gone", board: "general" }, Date.now() - 1000);
    // A live engq post bob holds and is its only lane: his decline leaves none, so it gets an [unclaimed] reply.
    ENGQ2 = post(core, `${W}/be`, "engq", "more eng").post.id;
    // A live q post bob holds by mention: his decline leaves lanes, so it goes on, redelivered.
    QLIVE = post(core, `${E}/be`, "q", `@${B}/be live work`, null, { strictIds: true }).post.id;
  });
  T1 = Date.now();
  while (Date.now() <= T1) { /* the next millisecond */ }
});

const inBody = (f: (tx: Tx) => Promise<unknown>) => inBodyOn(repo, T1, f);

test("sweepClaims gives core sweepChanges' wakes and boards and leaves its rows", async () => {
  const access = boardAccess(repo);
  const now = Date.now();
  const want = await inBody(async tx => outcome(() => sweepChanges(repo.coreOn(tx), now))) as { out: { value: { wake: string[]; boards: string[] } }; rows: Record<string, unknown[]> };
  const got = await inBody(tx => outcomeAsync(() => sweepClaims(repo, access, tx, now)));
  expect(diverging([["sweep", want, got]])).toEqual([]);

  // The fixture reaches each branch.
  const posts = JSON.stringify(want.rows.posts);
  const body = (start: string) => (want.rows.posts as { body: string; author_user: string | null }[]).find(p => p.body.startsWith(start));
  expect(body("[expired] ticket:watched")!.body).toEndWith(` cc @${B}/be @${E}/be`);
  expect(body("[expired] ticket:watched")!.author_user).toBe(W);
  expect(body("[expired] ticket:id")!.author_user).toBe(W);
  expect(body("[expired] ticket:person")!.author_user).toBe(D);
  expect(body("[expired] ticket:team")!.author_user).toBeNull();
  expect(body("[expired] ticket:user")!.author_user).toBe(B);
  expect(body("[expired] ticket:attic-lapsed")).toBeDefined();
  expect(body("[expired] ticket:q")).toBeDefined();
  for (const quiet of ["ticket:lost", "ticket:none", "ticket:live"]) expect(posts).not.toContain(`[expired] ${quiet}`);
  expect(JSON.stringify(want.rows.claim_watches)).not.toContain("ticket:lost");
  expect(JSON.stringify(want.rows.claims)).toContain("ticket:live");
  expect(JSON.stringify(want.rows.claims)).toContain(`"note":"queue post (redelivered)"`);
  expect(body(`[unclaimed] queue:engq:${ENGQ}`)).toBeDefined();
  expect(posts).not.toContain(`[unclaimed] queue:engq:${LOST}`);
  expect(body(`[unclaimed] queue:q:${TAILQ}`)).toBeDefined();
  expect(want.out.value.wake.length).toBeGreaterThan(0);
});

// #807 P3 B5b3c: claim_take, claim_release and claim_watch on the port answer as core's arms and leave their rows, for
// each caller (bound, sessionless, a cross-user writer, a viewer, an ended ID, a human, a child, and HTTP's claim call,
// which passes no session), over the sweep fixture above: every take sweeps the lapsed rows too.
type Caller = { label: string; addresses: string[]; user: string; session?: string; human?: boolean; via?: string };
const CALLERS: Caller[] = [
  { label: "wade", addresses: [`${W}/be`, "eng/deploy"], user: W, session: WADE_ID },
  { label: "wade, deploy first", addresses: ["eng/deploy", `${W}/be`], user: W, session: WADE_ID },
  { label: "bob", addresses: [`${B}/be`, `${B}/qa`], user: B, session: BOB_ID },
  { label: "eve", addresses: [`${E}/be`, "ops/deploy"], user: E, session: EVE_ID },
  { label: "dan, sessionless", addresses: [`${D}/be`], user: D },
  { label: "dan writing as bob", addresses: [`${B}/be`], user: D, session: DAN_WRITER },
  { label: "wade's tail", addresses: [TAIL_ID], user: W, session: TAIL_ID },
  { label: "bob's ended", addresses: [ENDED_ID], user: B },
  { label: "wade via slack", addresses: [`${W}/be`], user: W, session: WADE_ID, human: true },
  { label: "wade's child", addresses: [`${W}/be`, "eng/deploy"], user: W, session: CHILD_ID, via: CHILD_ID },
  { label: "wade over http", addresses: [`${W}/be`, "eng/deploy"], user: W },
  { label: "bob over http", addresses: [`${B}/be`, `${B}/qa`], user: B },
  { label: "eve over http", addresses: [`${E}/be`], user: E },
];

type Call = [tool: "claim_take" | "claim_release" | "claim_watch", args: Record<string, unknown>];
const CALLS = (): Call[] => [
  ["claim_take", { key: "ticket:new" }], ["claim_take", { key: "ticket:new", board: "general" }], ["claim_take", { key: "ticket:new", board: "eng" }],
  ["claim_take", { key: "ticket:new", board: "attic" }], ["claim_take", { key: "ticket:new", board: "q" }], ["claim_take", { key: "ticket:new", board: "nope" }],
  ["claim_take", { key: "ticket:live" }], ["claim_take", { key: "ticket:eng" }], ["claim_take", { key: "ticket:live", note: "n" }],
  ["claim_take", { key: "ticket:live", note: "new plan" }], ["claim_take", { key: "ticket:live", ttl_minutes: 1 }], ["claim_take", { key: "ticket:live", board: "attic" }],
  ["claim_take", { key: "ticket:attic", note: "still" }], ["claim_take", { key: "ticket:onq", note: "moving" }], ["claim_take", { key: "ticket:watched" }],
  ["claim_take", { key: "queue:x" }], ["claim_take", { key: "k", ttl_minutes: -1 }], ["claim_take", { key: "k", until: "never" }],
  ["claim_take", { key: "k", ttl_minutes: 5, until: "2030-01-01T00:00:00Z" }], ["claim_take", { key: "" }], ["claim_take", { key: 7 }], ["claim_take", { key: "k", board: 3 }],
  ["claim_release", { key: "ticket:live" }], ["claim_release", { key: "ticket:live", note: "done" }], ["claim_release", { key: "ticket:eng" }],
  ["claim_release", { key: "ticket:attic" }], ["claim_release", { key: "ticket:onq" }], ["claim_release", { key: "ticket:nob" }],
  ["claim_release", { key: "ticket:gone" }], ["claim_release", { key: "ticket:watched" }], ["claim_release", { key: "ticket:absent" }],
  ["claim_release", { key: `queue:q:${QPOST}` }], ["claim_release", { key: `queue:q:${QLIVE}` }], ["claim_release", { key: `queue:engq:${ENGQ2}` }], ["claim_release", { key: `queue:engq:${ENGQ2}`, note: "can't" }],
  ["claim_watch", { key: "ticket:live" }], ["claim_watch", { key: "ticket:live", off: true }], ["claim_watch", { key: "ticket:eng" }],
  ["claim_watch", { key: "ticket:nob" }], ["claim_watch", { key: "ticket:absent" }], ["claim_watch", { key: "ticket:watched" }], ["claim_watch", { key: "ticket:onq" }],
  ["claim_watch", { key: "" }],
];

const ctxOf = (c: Caller): ToolContext => ({
  online: h => ONLINE.has(h),
  user: c.user,
  addresses: c.addresses,
  ...(c.session ? { session: c.session } : {}),
  ...(c.human ? { human: true } : {}),
  ...(c.via ? { via: c.via } : {}),
});
const session = (c: Caller) => ({ addresses: c.addresses, asAddresses: c.addresses, ownScope: c.user });

test("claim_take, claim_release and claim_watch give core's answers and leave its rows, for every caller and call", async () => {
  const access = boardAccess(repo);
  const out: [string, unknown, unknown][] = [];
  for (const c of CALLERS) for (const [tool, args] of CALLS()) {
    let actor: string;
    try { actor = boardActor(repo.coreOn(repo.read), tool, args, session(c)); } catch { continue; }
    const want = await inBody(async tx => outcome(() => coreCallBoardTool(repo.coreOn(tx), actor, tool, args, ctxOf(c))));
    const got = await inBody(tx => outcomeAsync(() => callClaimTool(repo, access, tx, actor, tool, args, ctxOf(c))));
    out.push([`${c.label} ${tool} ${JSON.stringify(args)}`, want, got]);
  }
  expect(diverging(out)).toEqual([]);

  // The fixture reaches each branch the port decides.
  type R = { out: { value?: { result: unknown; wake: string[] }; error?: string }; rows: Record<string, unknown[]> };
  const call = (label: string, tool: string, args: Record<string, unknown>) => {
    const r = out.find(([x]) => x === `${label} ${tool} ${JSON.stringify(args)}`)?.[1] as R | undefined;
    if (!r) throw new Error(`no call ${label} ${tool} ${JSON.stringify(args)}`);
    return r;
  };
  // The caller's answer or refusal alone: a take's wake carries its sweep's handles too.
  const text = (label: string, tool: string, args: Record<string, unknown>) => {
    const o = call(label, tool, args).out;
    return JSON.stringify(o.value ? o.value.result : o);
  };
  // Takes: a free key announces on its board; one on a board the caller can't see, or an archived one, refuses.
  expect(JSON.stringify(call("wade", "claim_take", { key: "ticket:new", board: "general" }).rows.posts)).toContain("[claim] ticket:new");
  expect(text("eve", "claim_take", { key: "ticket:new", board: "eng" })).toContain("no such board #eng");
  expect(text("wade", "claim_take", { key: "ticket:new", board: "attic" })).toContain("error");
  // Held: the holder named when visible, hidden when not.
  expect(text("bob", "claim_take", { key: "ticket:live" })).toContain(`${W}/be`);
  expect(text("eve", "claim_take", { key: "ticket:eng" })).not.toContain("eng/deploy");
  expect(text("bob", "claim_take", { key: "ticket:eng" })).toContain("eng/deploy");
  // Renewals: a new note ccs the watcher; moving onto an archived board refuses.
  expect(JSON.stringify(call("wade", "claim_take", { key: "ticket:live", note: "new plan" }).rows.posts)).toContain(`@${E}/be`);
  expect(text("wade", "claim_take", { key: "ticket:live", board: "attic" })).toContain("error");
  // Every take sweeps: the lapsed rows announce under any caller's take.
  expect(JSON.stringify(call("dan, sessionless", "claim_take", { key: "ticket:new" }).rows.posts)).toContain("[expired] ticket:watched");
  // Releases: own, other's (visible and hidden), a repeat, a lapse, and queue declines with a lane left and none.
  expect(text("wade", "claim_release", { key: "ticket:live" })).toContain("released");
  expect(text("bob", "claim_release", { key: "ticket:live" })).toContain("error");
  expect(text("eve", "claim_release", { key: "ticket:eng" })).not.toContain("eng/deploy");
  expect(text("bob", "claim_release", { key: "ticket:gone" })).toContain("already released");
  expect(JSON.stringify(call("bob", "claim_release", { key: `queue:q:${QLIVE}` }).rows.claims)).toContain(`"note":"queue post (redelivered)"`);
  expect(JSON.stringify(call("bob", "claim_release", { key: `queue:engq:${ENGQ2}` }).rows.posts)).toContain(`[unclaimed] queue:engq:${ENGQ2}`);
  // Watches: on, off, own, no board, a hidden board, absent.
  expect(text("bob", "claim_watch", { key: "ticket:live" })).toContain("watching");
  expect(text("wade", "claim_watch", { key: "ticket:live" })).toContain("error");
  expect(text("wade", "claim_watch", { key: "ticket:nob" })).toContain("error");
  expect(text("eve", "claim_watch", { key: "ticket:eng" })).not.toContain("eng/deploy");
  expect(text("wade", "claim_watch", { key: "ticket:absent" })).toContain("error");
  expect(JSON.stringify(call("bob", "claim_watch", { key: "ticket:live" }).rows.claim_watches)).toContain(`"handle":"${B}/be"`);
});

// #807 P3 B5b3c rollback: a take or a decline that throws after its writes leaves none of them, its sweep's included;
// and a refusal after a write is rolled back by the tool's own savepoint even when the caller catches it and commits,
// as HTTP's claim call does (it answers a CoreError inside the body).
const claimRows = () => ({
  claims: repo.coreOn(repo.read).prepare(`SELECT key, holder, board, note FROM claims ORDER BY key`).all(),
  events: repo.coreOn(repo.read).prepare(`SELECT key, event, handle FROM claim_events ORDER BY id`).all(),
  posts: repo.coreOn(repo.read).prepare(`SELECT body FROM posts ORDER BY id`).all(),
  watches: repo.coreOn(repo.read).prepare(`SELECT key, handle FROM claim_watches ORDER BY key, handle`).all(),
});
const wade: ToolContext = { user: W, addresses: [`${W}/be`, "eng/deploy"], session: WADE_ID };
const bob: ToolContext = { user: B, addresses: [`${B}/be`, `${B}/qa`], session: BOB_ID };

test("a take whose [claim] post fails leaves no claim, no event and none of its sweep", async () => {
  const access = boardAccess(repo);
  const before = claimRows();
  const spy = spyOn(repo.boards, "insertOutbox").mockImplementation((() => { throw new Error("outbox down"); }) as never);
  try {
    await expect(repo.write(tx => callClaimTool(repo, access, tx, `${W}/be`, "claim_take", { key: "ticket:new", board: "general" }, wade))).rejects.toThrow("outbox down");
  } finally { spy.mockRestore(); }
  expect(claimRows()).toEqual(before);
  // The lapsed rows are still there for the next sweep to announce.
  expect(JSON.stringify(before.claims)).toContain("ticket:watched");
});

test("a decline whose redelivery fails leaves the claim held and no release event", async () => {
  const access = boardAccess(repo);
  const before = claimRows();
  const spy = spyOn(repo.boards, "claimQueuePost").mockImplementation((() => { throw new Error("queue down"); }) as never);
  try {
    await expect(repo.write(tx => callClaimTool(repo, access, tx, `${B}/be`, "claim_release", { key: `queue:q:${QLIVE}` }, bob))).rejects.toThrow("queue down");
  } finally { spy.mockRestore(); }
  expect(claimRows()).toEqual(before);
  expect(JSON.stringify(before.claims)).toContain(`"key":"queue:q:${QLIVE}","holder":"${B}/be"`);
});

test("a refusal after a write, caught in a body that commits, leaves nothing of the call (the tool's savepoint)", async () => {
  const access = boardAccess(repo);
  const before = claimRows();
  // A renewal moving ticket:live onto the archived attic: the upsert and the sweep ran before checkMove refuses.
  const answer = await repo.write(async tx => {
    try { await callClaimTool(repo, access, tx, `${W}/be`, "claim_take", { key: "ticket:live", board: "attic" }, wade); return "taken"; }
    catch (e) { if (e instanceof CoreError) return e.message; throw e; }
  });
  expect(answer).toContain("attic");
  expect(claimRows()).toEqual(before);
});
