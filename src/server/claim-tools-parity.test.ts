// The server's claim steps (#807 P3 B5b3b) give core's answers: sweepClaims leaves the rows core sweepChanges leaves
// (claims, claim events and watches, posts, outbox) and wakes the same handles, over the post parity fixture plus
// lapsed claims reaching every branch of the sweep: an announced lapse with a watcher, each of holderUser's fallbacks
// (an ID, a held alias, an unheld person alias, an unheld team alias, a recorded user), a holder who lost the board, an
// archived board, a regular claim on a queue board, no board, and queue posts with a lane left, none left, and none
// left whose `[unclaimed]` reply the holder can no longer write, or writes for its user (#1296), or its author writes
// for a holder that can't (#1175).
import { beforeEach, expect, spyOn, test } from "bun:test";
import { claimQueuePost, createBoard, post, subscribe } from "../core/boards.ts";
import { boardActor } from "../core/bindings.ts";
import { logEvent, sweepChanges } from "../core/claims.ts";
import { CoreError } from "../core/errors.ts";
import { callBoardTool as coreCallBoardTool, type ToolContext } from "../core/tools.ts";
import { boardAccess } from "./access.ts";
import { writeAudit } from "./audit.ts";
import { callClaimTool, sweepClaims } from "./claims.ts";
import { endSessionServer } from "./session_end.ts";
import type { Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { B, BOB_ID, CHILD_ID, D, DAN_WRITER, diverging, E, ENDED_ID, ENG_ID, EVE_ID, inBody as inBodyOn, ONLINE, openPostParity, outcome, outcomeAsync, TAIL_ID, team, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

let repo: Repo;
let T1 = 0;
let QPOST = 0, ENGQ = 0, LOST = 0, IDLEQ = 0, HUMANQ = 0, HELDQ = 0, TAILQ = 0, ENGQ2 = 0, QLIVE = 0, OPSQ = 0, OPSQ_QUIET = 0, OPSQ_LIVE = 0;

beforeEach(async () => {
  const f = await openPostParity();
  ({ repo, QPOST } = f);
  await seed(repo, async tx => {
    await repo.aliases.create(tx, team("eng", "idle"), W);
    const core = repo.coreOn(tx);
    const lapsed = (key: string, holder: string, board: string | null, user: string | null = null) =>
      core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user) VALUES (?, ?, 'n', ?, 1, 2, ?)`).run(key, holder, board, user);
    lapsed("ticket:watched", `${W}/be`, "general");
    // An ended ID watching too: the announcement's mentions are non-strict, so it goes unresolved, never refusing.
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?), (?, ?), (?, ?)`).run("ticket:watched", `${E}/be`, "ticket:watched", `${B}/be`, "ticket:watched", ENDED_ID);
    lapsed("ticket:id", WADE_ID, "general");
    lapsed("ticket:person", `${D}/be`, "general");
    lapsed("ticket:team", "eng/idle", "eng");
    lapsed("ticket:user", `${B}/be`, "eng", B);
    // dan never was in eng: he lapses quietly, and his watcher's watch goes all the same.
    lapsed("ticket:lost", `${D}/be`, "eng");
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:lost", `${W}/be`);
    // #1286: wade's session bound to eng/build can't see ops, but wade can: the lapse is posted for him, cc'ing eve,
    // who sees ops, and dan, who doesn't and so gets nothing. eng/idle, held by nobody, names no user: quiet.
    lapsed("ticket:confined", ENG_ID, "ops", W);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?), (?, ?)`).run("ticket:confined", `${E}/be`, "ticket:confined", `${D}/be`);
    lapsed("ticket:team-lost", "eng/idle", "ops");
    lapsed("ticket:attic-lapsed", `${W}/be`, "attic");
    lapsed("ticket:q", `${E}/be`, "q");
    // A single watcher cc'd on a queue board: a non-strict mention claims no queue post.
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:q", `${B}/be`);
    lapsed("ticket:none", `${E}/be`, null);
    core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES ('ticket:live', ?, 'n', 'general', 1, ?)`).run(`${W}/be`, Date.now() + 3_600_000);
    // bob's held queue claim lapses with lanes left: the post goes on.
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:q:${QPOST}`);
    // engq's only lane is bob's be: his lapse leaves no lane, so the post gets an [unclaimed] reply.
    ENGQ = post(core, `${W}/be`, "engq", "eng work").post.id;
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${ENGQ}`);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:engq:${ENGQ}`, `${W}/be`);
    // A lane dan held on engq though he was never in eng, bob's turn already spent: no lane, and dan can't reply there,
    // so its author does (#1175).
    subscribe(core, `${B}/qa`, "engq", "push");
    LOST = post(core, `${W}/be`, "engq", "more eng work").post.id;
    for (const [key, h] of [[`queue:engq:${LOST}`, `${B}/be`], [`queue:engq:${LOST}`, `${B}/qa`]] as const) logEvent(core, "take", h, { key }, 1);
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:engq:${LOST}`);
    claimQueuePost(core, "engq", LOST, `${D}/be`, 1);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:engq:${LOST}`, `${W}/be`);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${LOST}`);
    // #1175: eng/idle, a team alias nobody holds, held an engq post at its lapse, bob's lanes' turns spent: it sees
    // engq, so it writes the [unclaimed] reply itself, naming no user.
    IDLEQ = post(core, `${W}/be`, "engq", "idle eng work").post.id;
    for (const h of [`${B}/be`, `${B}/qa`]) logEvent(core, "take", h, { key: `queue:engq:${IDLEQ}` }, 1);
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:engq:${IDLEQ}`);
    claimQueuePost(core, "engq", IDLEQ, "eng/idle", 1);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${IDLEQ}`);
    // #1175: system text never bears the human mark. bob's human's post that dan, who can't reply on engq, held last
    // ends quietly; a claim bob's human held (from before humans left the lanes) is replied to by the post's author.
    const spent = (author: string, body: string, holder: string) => {
      const id = post(core, author, "engq", body).post.id;
      for (const h of [`${B}/be`, `${B}/qa`]) logEvent(core, "take", h, { key: `queue:engq:${id}` }, 1);
      core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:engq:${id}`);
      claimQueuePost(core, "engq", id, holder, 1);
      core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${id}`);
      return id;
    };
    HUMANQ = spent(`${B}/human`, "human's eng work", `${D}/be`);
    HELDQ = spent(`${W}/be`, "work a human held", `${B}/human`);
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
    // #1286: a live claim of the eng-bound session's on ops, taken by wade's user, eve watching.
    core.prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user) VALUES ('ticket:confined-live', ?, 'n', 'ops', 1, ?, ?)`).run(ENG_ID, Date.now() + 3_600_000, W);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run("ticket:confined-live", `${E}/be`);
    // bob released ticket:gone a moment ago: a repeat release answers "already released".
    logEvent(core, "release", `${B}/be`, { key: "ticket:gone", board: "general" }, Date.now() - 1000);
    // A live engq post bob holds and is its only lane: his decline leaves none, so it gets an [unclaimed] reply. bob's
    // qa watches it: a decline as bob leaves his whole address set out of the reply (#1175).
    ENGQ2 = post(core, `${W}/be`, "engq", "more eng").post.id;
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:engq:${ENGQ2}`, `${B}/qa`);
    // A live q post bob holds by mention: his decline leaves lanes, so it goes on, redelivered.
    QLIVE = post(core, `${E}/be`, "q", `@${B}/be live work`, null, { strictIds: true }).post.id;
    // #1296: ops's queue board, eve's posts, no lane but the eng-bound session's ID, which can't see ops though wade
    // can. Its lapse's [unclaimed] reply is posted for wade, cc'ing eve, who sees ops, and dan, who doesn't. A lapse of
    // eng/idle's, held by nobody, names no user: its author, eve, writes it (#1175). A live one the eng-bound session declines.
    createBoard(core, `${E}/be`, "opsq", "ops work", "team:ops", { kind: "queue" });
    const opsq = (body: string, holder: string) => {
      const id = post(core, `${E}/be`, "opsq", body).post.id;
      claimQueuePost(core, "opsq", id, holder, Date.now());
      return id;
    };
    OPSQ = opsq("ops work", ENG_ID);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:opsq:${OPSQ}`);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?), (?, ?)`).run(`queue:opsq:${OPSQ}`, `${E}/be`, `queue:opsq:${OPSQ}`, `${D}/be`);
    OPSQ_QUIET = opsq("more ops work", "eng/idle");
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:opsq:${OPSQ_QUIET}`);
    OPSQ_LIVE = opsq("live ops work", ENG_ID);
    // eve sees ops; dan doesn't, so a reply may cc him but never tells him (#1306).
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?), (?, ?)`).run(`queue:opsq:${OPSQ_LIVE}`, `${E}/be`, `queue:opsq:${OPSQ_LIVE}`, `${D}/be`);
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
  expect(body("[expired] ticket:watched")!.body).toEndWith(` cc @${B}/be @${E}/be @${ENDED_ID}`);
  expect(body("[expired] ticket:watched")!.author_user).toBe(W);
  expect(body("[expired] ticket:id")!.author_user).toBe(W);
  expect(body("[expired] ticket:person")!.author_user).toBe(D);
  expect(body("[expired] ticket:team")!.author_user).toBeNull();
  expect(body("[expired] ticket:user")!.author_user).toBe(B);
  expect(body("[expired] ticket:attic-lapsed")).toBeDefined();
  expect(body("[expired] ticket:q")).toBeDefined();
  for (const quiet of ["ticket:lost", "ticket:none", "ticket:live", "ticket:team-lost"]) expect(posts).not.toContain(`[expired] ${quiet}`);
  // #1286: posted for the claimant's user, though its holder can't see ops; only the watcher who sees ops is told.
  const confined = (want.rows.posts as { id: number; body: string; author: string; author_user: string | null; author_id: string | null }[]).find(p => p.body.startsWith("[expired] ticket:confined"))!;
  expect(confined).toMatchObject({ author: ENG_ID, author_user: W, author_id: null });
  expect(confined.body).toEndWith(` cc @${D}/be @${E}/be`);
  const told = (want.rows.outbox as { post_id: number; handle: string }[]).filter(o => o.post_id === confined.id).map(o => o.handle);
  expect(told).toEqual([`${E}/be`]);
  expect(JSON.stringify(want.rows.claim_watches)).not.toContain("ticket:lost");
  expect(JSON.stringify(want.rows.claims)).toContain("ticket:live");
  expect(JSON.stringify(want.rows.claims)).toContain(`"note":"queue post (redelivered)"`);
  expect(body(`[unclaimed] queue:engq:${ENGQ}`)!.body).toContain(`@${W}/be`);
  // #1175: dan, its last lane, can't reply on engq: the post's author, wade's be, writes it into its own thread as its
  // post's writer, and is neither handed nor woken by it (it's also the cc'd watcher).
  type Row = { id: number; body: string; author: string; author_user: string | null; author_id: string | null; parent_id: number | null };
  type Out = { post_id: number; handle: string };
  const reply = (start: string) => (want.rows.posts as Row[]).find(p => p.body.startsWith(start))!;
  const handed = (id: number) => (want.rows.outbox as Out[]).filter(o => o.post_id === id).map(o => o.handle);
  const lost = reply(`[unclaimed] queue:engq:${LOST}:`);
  expect(lost).toMatchObject({ author: `${W}/be`, author_user: null, author_id: null, parent_id: LOST });
  expect(lost.body).toEndWith(` cc @${W}/be`);
  expect(handed(lost.id)).not.toContain(`${W}/be`);
  expect(reply(`[unclaimed] queue:engq:${IDLEQ}:`)).toMatchObject({ author: "eng/idle", author_user: null, author_id: null, parent_id: IDLEQ });
  expect(posts).not.toContain(`[unclaimed] queue:engq:${HUMANQ}`);
  expect(reply(`[unclaimed] queue:engq:${HELDQ}:`)).toMatchObject({ author: `${W}/be`, parent_id: HELDQ });
  // A refused [unclaimed] reply still takes its watches, and the queue board's cc takes no claim.
  const watches = JSON.stringify(want.rows.claim_watches);
  for (const gone of [`queue:engq:${ENGQ}`, `queue:engq:${LOST}`, "ticket:q"]) expect(watches).not.toContain(`"${gone}"`);
  expect(body("[expired] ticket:q")!.body).toContain(`@${B}/be`);
  expect(body("[expired] ticket:watched")!.body).toContain(ENDED_ID);
  expect(body(`[unclaimed] queue:q:${TAILQ}`)).toBeDefined();
  // #1296: the [unclaimed] reply of a holder who lost ops is posted for its user; only the watcher who sees ops is
  // told. One whose holder names no user falls to its author, its watches gone all the same.
  const unclaimed = (want.rows.posts as { id: number; body: string; author: string; author_user: string | null; author_id: string | null; parent_id: number | null }[]).find(p => p.body.startsWith(`[unclaimed] queue:opsq:${OPSQ}:`))!;
  expect(unclaimed).toMatchObject({ author: ENG_ID, author_user: W, author_id: null, parent_id: OPSQ });
  expect(unclaimed.body).toEndWith(` cc @${D}/be @${E}/be`);
  expect((want.rows.outbox as { post_id: number; handle: string }[]).filter(o => o.post_id === unclaimed.id).map(o => o.handle)).toEqual([`${E}/be`]);
  // #1175: eng/idle, held by nobody, names no user to post for: the post's author, eve, writes it, uncc'd.
  const quiet = reply(`[unclaimed] queue:opsq:${OPSQ_QUIET}:`);
  expect(quiet).toMatchObject({ author: `${E}/be`, author_user: null, author_id: null, parent_id: OPSQ_QUIET });
  expect(handed(quiet.id)).not.toContain(`${E}/be`);
  expect(watches).not.toContain(`queue:opsq:${OPSQ}"`);
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
  { label: "wade's eng-bound", addresses: ["eng/build", ENG_ID], user: W, session: ENG_ID },
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
  ["claim_release", { key: "ticket:confined-live", note: "secret" }], ["claim_release", { key: `queue:opsq:${OPSQ_LIVE}`, note: "secret" }],
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
  // #1175: a sessionless decline's reply leaves out the caller's whole address set: bob's qa, which watches the post,
  // is cc'd but handed nothing.
  const http = call("bob over http", "claim_release", { key: `queue:engq:${ENGQ2}` }).rows;
  const httpReply = (http.posts as { id: number; body: string }[]).find(p => p.body.startsWith(`[unclaimed] queue:engq:${ENGQ2}:`))!;
  expect((http.outbox as { post_id: number; handle: string }[]).filter(o => o.post_id === httpReply.id).map(o => o.handle)).toEqual([`${W}/be`]);
  // #1286: the eng-bound session's release of its claim on ops is posted for wade, without its note or its session,
  // and answers as a quiet one.
  const confined = call("wade's eng-bound", "claim_release", { key: "ticket:confined-live", note: "secret" });
  const rel = (confined.rows.posts as { body: string; author_user: string | null; author_id: string | null }[]).find(p => p.body.startsWith("[release] ticket:confined-live"));
  expect(rel).toMatchObject({ body: `[release] ticket:confined-live cc @${E}/be`, author_user: W, author_id: null });
  expect(confined.out.value!.result).toBe("released ticket:confined-live");
  // #1296: its decline of an ops queue post leaves no lane: the [unclaimed] reply is posted for wade, without its
  // session or note, and answers as any decline.
  const declined = call("wade's eng-bound", "claim_release", { key: `queue:opsq:${OPSQ_LIVE}`, note: "secret" });
  const reply = (declined.rows.posts as { body: string; author_user: string | null; author_id: string | null; parent_id: number | null }[]).find(p => p.body.startsWith(`[unclaimed] queue:opsq:${OPSQ_LIVE}:`));
  expect(reply).toMatchObject({ author_user: W, author_id: null, parent_id: OPSQ_LIVE });
  expect(reply!.body).toEndWith(` cc @${D}/be @${E}/be`);
  expect(JSON.stringify(declined.rows.posts)).not.toContain("secret");
  expect(declined.out.value!.result).toBe(`released queue:opsq:${OPSQ_LIVE}`);
  // Watches: on, off, own, no board, a hidden board, absent.
  expect(text("bob", "claim_watch", { key: "ticket:live" })).toContain("watching");
  expect(text("wade", "claim_watch", { key: "ticket:live" })).toContain("error");
  expect(text("wade", "claim_watch", { key: "ticket:nob" })).toContain("error");
  expect(text("eve", "claim_watch", { key: "ticket:eng" })).not.toContain("eng/deploy");
  expect(text("wade", "claim_watch", { key: "ticket:absent" })).toContain("error");
  expect(JSON.stringify(call("bob", "claim_watch", { key: "ticket:live" }).rows.claim_watches)).toContain(`"handle":"${B}/be"`);
});

// #1286: a release posted for the claimant's user is the system's post, not the caller's: its invocation hook doesn't
// run, while the holder's own release on a board it sees still runs it.
test("a release posted for the claimant's user runs no caller hook; a holder's own does", async () => {
  const access = boardAccess(repo);
  const hooked: string[] = [];
  const announced = async (_sp: Tx, as: string, board: string) => { hooked.push(`${as} ${board}`); };
  const engBound: ToolContext = { user: W, addresses: ["eng/build", ENG_ID], session: ENG_ID };
  const out = await inBody(async tx => {
    const r = await callClaimTool(repo, access, tx, "eng/build", "claim_release", { key: "ticket:confined-live", note: "secret" }, { ...engBound, announced });
    await callClaimTool(repo, access, tx, `${W}/be`, "claim_release", { key: "ticket:live" }, { ...wade, announced });
    return r.result;
  }) as { out: unknown; rows: { posts: { body: string }[] } };
  expect(out.out).toBe("released ticket:confined-live");
  expect(out.rows.posts.map(p => p.body)).toContain(`[release] ticket:confined-live cc @${E}/be`);
  expect(hooked).toEqual([`${W}/be general`]);
});

// #1306: the server's ID end is core's endSession, whose release passes the ended session as ctx into core requeue.
// Its [unclaimed] reply to the ops queue post is the one the port's decline posts: for wade, with no session, no note,
// cc'ing dan, who can't see ops, but telling only eve, who can.
test("a session end's requeue of a confined holder's queue post replies as the port's decline does", async () => {
  const access = boardAccess(repo);
  type Reply = { id: number; body: string; author: string; author_user: string | null; author_id: string | null; parent_id: number | null };
  type R = { rows: { posts: Reply[]; outbox: { post_id: number; handle: string }[]; claims: { key: string }[] } };
  const reply = (r: R) => {
    const p = r.rows.posts.find(x => x.body.startsWith(`[unclaimed] queue:opsq:${OPSQ_LIVE}:`));
    if (!p) throw new Error(`no [unclaimed] reply to ${OPSQ_LIVE}`);
    const { id, ...rest } = p;
    return { ...rest, told: r.rows.outbox.filter(o => o.post_id === id).map(o => o.handle) };
  };
  const ended = await inBody(tx => endSessionServer(repo, access, tx, ENG_ID, { why: "test", now: Date.now(), audit: async (a, actor, target, detail) => writeAudit(repo, tx, a, actor, target, detail) })) as R;
  const engBound: ToolContext = { user: W, addresses: ["eng/build", ENG_ID], session: ENG_ID };
  const declined = await inBody(tx => callClaimTool(repo, access, tx, "eng/build", "claim_release", { key: `queue:opsq:${OPSQ_LIVE}` }, engBound)) as R;
  expect(ended.rows.claims.map(c => c.key)).not.toContain(`queue:opsq:${OPSQ_LIVE}`);
  expect(reply(ended)).toEqual(reply(declined));
  expect(reply(ended)).toMatchObject({ author: ENG_ID, author_user: W, author_id: null, parent_id: OPSQ_LIVE, told: [`${E}/be`] });
  expect(reply(ended).body).toEndWith(` cc @${D}/be @${E}/be`);
  expect(JSON.stringify(ended.rows.posts)).not.toContain("session ended");
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
  // The fault fires on the [claim] post only, so the sweep's posts, the upsert and the take event all ran before it.
  const real = repo.boards.insertOutbox.bind(repo.boards);
  const seen: string[] = [];
  let heldAtFault = false;
  const spy = spyOn(repo.boards, "insertOutbox").mockImplementation((async (tx: Tx, postId: number, targets: never) => {
    const body = (await repo.boards.post(tx, postId))?.body ?? "";
    seen.push(body);
    if (body.startsWith("[claim]")) {
      heldAtFault = !!(await repo.claims.get(tx, "ticket:new"));
      throw new Error("outbox down");
    }
    return real(tx, postId, targets);
  }) as never);
  try {
    await expect(repo.write(tx => callClaimTool(repo, access, tx, `${W}/be`, "claim_take", { key: "ticket:new", board: "general" }, wade))).rejects.toThrow("outbox down");
  } finally { spy.mockRestore(); }
  expect(seen.at(-1)).toStartWith("[claim]");
  expect(seen.length).toBeGreaterThan(1);
  expect(heldAtFault).toBe(true);
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

// #807 P3 C5a F1: a lapsed claim whose key holds a NUL (written before keys refused it) doesn't lock out every take on
// the server: the take's sweep and the expiry timer's announce it with U+FFFD, as core does.
test("a lapsed NUL-key claim: an unrelated take and the timer's sweep announce it with U+FFFD, as core does", async () => {
  const access = boardAccess(repo);
  await seed(repo, async tx => {
    repo.coreOn(tx).prepare(`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, ?, 'general', 1, 2)`).run("ticket:a\0b", `${W}/be`, "n\0te");
  });
  const args = { key: "ticket:unrelated" };
  const want = await inBody(async tx => outcome(() => coreCallBoardTool(repo.coreOn(tx), `${W}/be`, "claim_take", args, wade))) as { out: { value?: unknown }; rows: { posts: { body: string }[] } };
  const got = await inBody(tx => outcomeAsync(() => callClaimTool(repo, access, tx, `${W}/be`, "claim_take", args, wade))) as typeof want;
  expect(diverging([["take", want, got]])).toEqual([]);
  expect(got.out.value).toBeDefined();
  const expired = "[expired] ticket:a�b: not released by";
  expect(got.rows.posts.some(p => p.body.startsWith(expired))).toBe(true);
  const now = Date.now();
  const swept = await inBody(tx => outcomeAsync(() => sweepClaims(repo, access, tx, now))) as typeof want;
  expect(swept.out.value).toBeDefined();
  expect(swept.rows.posts.some(p => p.body.startsWith(expired))).toBe(true);
  // The key and note themselves refuse at the take, before any sweep.
  for (const [a, text] of [[{ key: "ticket:a\0b" }, "claim key contains a NUL character"], [{ key: "k", note: "a\0b" }, "claim note contains a NUL character"]] as const) {
    await expect(repo.write(tx => callClaimTool(repo, access, tx, `${W}/be`, "claim_take", a, wade))).rejects.toThrow(text);
  }
});
