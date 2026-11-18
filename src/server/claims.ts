// The server's claim steps (#807 P3 B5b3b): core's sweep and queue requeue over the store's rows on the caller's Tx,
// judged by the async BoardAccess on that same Tx. Every rule and text is core's (expiredText, unclaimedText,
// orderLanes, requeuePick, holderUserRule), so local and the server announce alike and only the reads differ.
import { orderLanes, REDELIVERED_NOTE, requeuePick } from "../core/boards.ts";
import { expiredText, unclaimedText, type ClaimChanges, type ClaimCtx, type ClaimRow } from "../core/claims.ts";
import { CoreError } from "../core/errors.ts";
import type { BoardAccess } from "./access.ts";
import { systemPost } from "./board_post.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

/**
 * core sweepChanges on `tx`: delete the claims lapsed at `now` and, per claim in lapse order, log its expiry, then
 * requeue a queue post's claim or announce the lapse on the claim's board, its watchers cc'd. The delete makes each
 * lapse announce once, however many sweep. A holder who lost the board lapses quietly; its watches go all the same.
 */
export async function sweepClaims(repo: Repo, access: BoardAccess, tx: Tx, now: number): Promise<ClaimChanges> {
  const wake = new Set<string>();
  const boards = new Set<string>();
  for (const c of await repo.claims.expire(tx, now)) {
    await repo.claims.logEvent(tx, "expire", c.holder, c, now);
    let changed: ClaimChanges;
    if (c.key.startsWith("queue:")) {
      changed = await requeue(repo, access, tx, c, now);
    } else {
      const cc = await repo.claims.takeWatchers(tx, c.key);
      if (!c.board || !(await boardVisible(repo, access, tx, c.holder, c.board))) continue;
      changed = await systemPost(repo, access, tx, c.holder, c.board, expiredText(c.key, c.holder, cc), null, {
        allowArchived: true, user: await repo.claims.holderUser(tx, c),
      });
    }
    for (const h of changed.wake) wake.add(h);
    for (const b of changed.boards) boards.add(b);
  }
  return { wake: [...wake], boards: [...boards] };
}

/**
 * core requeue on `tx`: a queue post's claim ended (a lapse, or a decline in `ctx`'s name). Its watches go; the post goes
 * to the next lane that hasn't held it, presence-blind; with none left, an `[unclaimed]` reply in its thread, which a
 * holder who lost the board can't write: then nothing, the reply's savepoint rolled back and the rest kept.
 */
export async function requeue(repo: Repo, access: BoardAccess, tx: Tx, c: ClaimRow, now: number, ctx: ClaimCtx = {}): Promise<ClaimChanges> {
  const cc = await repo.claims.takeWatchers(tx, c.key);
  const f = await repo.boards.redeliveryFacts(tx, c.key, c.holder);
  if (!f) return { wake: [], boards: [] };
  const rows = await repo.boards.laneRows(tx, f.board.name, f.poster);
  const viewers = await repo.bindings.viewerIds(tx);
  const sees = rows.length ? await access.canSeeMany(tx, rows, f.board) : new Set<string>();
  const lane = requeuePick(orderLanes(rows, (h) => viewers.has(h), (h) => sees.has(h)), f.held);
  if (lane) {
    await repo.boards.claimQueuePost(tx, f.board.name, f.postId, lane, now, { note: REDELIVERED_NOTE, push: true });
    return { wake: [lane], boards: [] };
  }
  const user = ctx.user ?? (await repo.claims.holderUser(tx, c));
  try {
    return await tx.savepoint((sp) => systemPost(repo, access, sp, c.holder, f.board.name, unclaimedText(c.key, f.takers, cc), f.postId, {
      allowArchived: true, session: ctx.session, via: ctx.via, addresses: ctx.addresses, user,
    }));
  } catch (e) {
    if (e instanceof CoreError) return { wake: [], boards: [] };
    throw e;
  }
}

/** core canSeeBoard on `r`: the board exists and `handle` may see it. */
async function boardVisible(repo: Repo, access: BoardAccess, r: Read, handle: string, name: string): Promise<boolean> {
  const b = await repo.boards.get(r, name);
  return !!b && (await access.canSee(r, handle, b));
}
