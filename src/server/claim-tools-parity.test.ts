// The server's claim steps (#807 P3 B5b3b) give core's answers: sweepClaims leaves the rows core sweepChanges leaves
// (claims, claim events and watches, posts, outbox) and wakes the same handles, over the post parity fixture plus
// lapsed claims reaching every branch of the sweep: an announced lapse with a watcher, each of holderUser's fallbacks
// (an ID, a held alias, an unheld person alias, an unheld team alias, a recorded user), a holder who lost the board, an
// archived board, a regular claim on a queue board, no board, and queue posts with a lane left, none left, and none
// left whose `[unclaimed]` reply the holder can no longer write.
import { beforeEach, expect, test } from "bun:test";
import { claimQueuePost, post, subscribe } from "../core/boards.ts";
import { logEvent, sweepChanges } from "../core/claims.ts";
import { boardAccess } from "./access.ts";
import { sweepClaims } from "./claims.ts";
import type { Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { B, D, diverging, E, ENDED_ID, inBody as inBodyOn, openPostParity, outcome, outcomeAsync, team, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { seed } from "../../tests/support/seed.ts";

let repo: Repo;
let T1 = 0;
let QPOST = 0, ENGQ = 0, LOST = 0, TAILQ = 0;

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
    lapsed("ticket:attic", `${W}/be`, "attic");
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
    // A lane dan held on engq though he was never in eng, bob's turn already spent: no lane, and dan can't reply there.
    subscribe(core, `${B}/qa`, "engq", "push");
    LOST = post(core, `${W}/be`, "engq", "more eng work").post.id;
    for (const [key, h] of [[`queue:engq:${LOST}`, `${B}/be`], [`queue:engq:${LOST}`, `${B}/qa`]] as const) logEvent(core, "take", h, { key }, 1);
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:engq:${LOST}`);
    claimQueuePost(core, "engq", LOST, `${D}/be`, 1);
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:engq:${LOST}`, `${W}/be`);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:engq:${LOST}`);
    // Every lane on q but wade's viewer tail has had its turn: a viewer is never a lane, so the post gets [unclaimed].
    TAILQ = post(core, `${E}/be`, "q", `@${D}/be tail work`, null, { strictIds: true }).post.id;
    for (const h of [`${B}/be`, `${B}/qa`, "eng/deploy"]) logEvent(core, "take", h, { key: `queue:q:${TAILQ}` }, 1);
    core.prepare(`UPDATE claims SET expires_at = 2 WHERE key = ?`).run(`queue:q:${TAILQ}`);
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
  expect(body("[expired] ticket:attic")).toBeDefined();
  expect(body("[expired] ticket:q")).toBeDefined();
  for (const quiet of ["ticket:lost", "ticket:none", "ticket:live"]) expect(posts).not.toContain(`[expired] ${quiet}`);
  expect(JSON.stringify(want.rows.claim_watches)).not.toContain("ticket:lost");
  expect(JSON.stringify(want.rows.claims)).toContain("ticket:live");
  expect(JSON.stringify(want.rows.claims)).toContain(`"note":"queue post (redelivered)"`);
  expect(body(`[unclaimed] queue:engq:${ENGQ}`)!.body).toContain(`@${W}/be`);
  expect(posts).not.toContain(`[unclaimed] queue:engq:${LOST}`);
  // A refused [unclaimed] reply still takes its watches, and the queue board's cc takes no claim.
  const watches = JSON.stringify(want.rows.claim_watches);
  for (const gone of [`queue:engq:${ENGQ}`, `queue:engq:${LOST}`, "ticket:q"]) expect(watches).not.toContain(`"${gone}"`);
  expect(body("[expired] ticket:q")!.body).toContain(`@${B}/be`);
  expect(body("[expired] ticket:watched")!.body).toContain(ENDED_ID);
  expect(body(`[unclaimed] queue:q:${TAILQ}`)).toBeDefined();
  expect(want.out.value.wake.length).toBeGreaterThan(0);
});
