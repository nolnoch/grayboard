// The server's claim tools and steps (#807 P3 B5b3b, B5b3c): core's claim_take, claim_release, claim_watch, sweep and
// queue requeue over the store's rows on the caller's Tx, judged by the async BoardAccess on that same Tx. Every rule and text is core's (expiredText, unclaimedText,
// orderLanes, requeuePick, holderUserRule), so local and the server announce alike and only the reads differ.
import { orderLanes, REDELIVERED_NOTE, requeuePick } from "../core/boards.ts";
import {
  alreadyReleasedText, checkMove, isQueueKey, checkRelease, checkTake, claimText, expiredText, heldAnswer, notWatching, releasable, releasedByRule,
  releasedText, releaseRefusal, releaseText, renewAnnounces, takeDecision, unclaimedText, updateText, validKey, watching, watchNoBoard,
  watchNoClaim, watchOwn, type Claim, type ClaimChanges, type ClaimCtx, type ClaimResult, type ClaimRow, type TakeOpts,
} from "../core/claims.ts";
import { CoreError } from "../core/errors.ts";
import { claimTakeArgs, optBool, optStr, str, type ToolContext, type ToolOutcome } from "../core/tools.ts";
import type { BoardAccess } from "./access.ts";
import { seenAmong, systemPost } from "./board_post.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

/**
 * The caller's hook for an announcement its own claim call wrote: a take's claim, a renewal's update or a release,
 * post `postId`, posted as `as` on `board` within `sp`. On a service's board that post is an invocation (#270 D6, #1259), which only the caller can
 * record, since it knows who asked. A lapse, a requeue's reply and a session end's release are the system's: no hook.
 */
export type Announced = (sp: Tx, as: string, board: string, postId: number) => Promise<void>;
type ServerClaimCtx = ClaimCtx & { announced?: Announced };

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
  const lanes = rows.length ? await access.lanesAmong(tx, rows, f.board) : new Set<string>();
  const lane = requeuePick(orderLanes(rows, (h) => viewers.has(h), (h) => sees.has(h), (h) => lanes.has(h)), f.held);
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

/** core callBoardTool's claim arms on `tx`: the same arguments read in the same order, the same answers. */
export async function callClaimTool(
  repo: Repo, access: BoardAccess, tx: Tx, actor: string, tool: "claim_take" | "claim_release" | "claim_watch", a: Record<string, unknown>,
  ctx: ToolContext & { announced?: Announced },
): Promise<ToolOutcome> {
  const who: ServerClaimCtx = { addresses: ctx.addresses, session: ctx.session, via: ctx.via, user: ctx.user, announced: ctx.announced };
  switch (tool) {
    case "claim_take": {
      const { key, ...take } = claimTakeArgs(a);
      const { wake, boards, ...result } = await serverClaim(repo, access, tx, actor, key, { ...take, ...who });
      return { result, wake, boards };
    }
    case "claim_release": {
      const key = str(a, "key");
      const { wake, boards, releasedAt } = await serverRelease(repo, access, tx, actor, key, optStr(a, "note"), who);
      return { result: releasedAt === undefined ? releasedText(key) : alreadyReleasedText(releasedAt), wake, boards };
    }
    case "claim_watch":
      return { result: await serverWatch(repo, access, tx, actor, str(a, "key"), optBool(a, "off"), ctx.addresses, ctx.session ?? actor), wake: [] };
  }
}

/** Whether `seer` may not see that `holder` exists (core holderHidden). */
async function holderHidden(repo: Repo, access: BoardAccess, r: Read, seer: string, holder: string): Promise<boolean> {
  return !(await seenAmong(repo, access, r, seer, [holder])).has(holder);
}

/**
 * core claim on `tx`, in a savepoint as core's own transaction was: a refusal after a write (a renewal moving onto an
 * archived board, a [claim] its board's gate refuses) rolls back the take and its sweep even when the caller answers
 * the refusal and commits (HTTP's claimCall does).
 */
export async function serverClaim(
  repo: Repo, access: BoardAccess, tx: Tx, handle: string, keyInput: string, opts: TakeOpts & ServerClaimCtx = {},
): Promise<ClaimResult> {
  const { key, board } = checkTake(keyInput, opts);
  const addresses = opts.addresses ?? [handle];
  return tx.savepoint(async (sp): Promise<ClaimResult> => {
    // A board that doesn't exist, or that `handle` can't see, refuses as a post to it would (#81).
    if (board && !(await boardVisible(repo, access, sp, handle, board))) throw new CoreError(`no such board #${board}; see board_list`);
    const now = Date.now();
    // Announce a lapsed claim before anyone takes it over.
    const lapsed = await sweepClaims(repo, access, sp, now);
    const held = async (cur: Claim): Promise<ClaimResult> => {
      await repo.claims.logEvent(sp, "refused", handle, { key, note: opts.note, board }, now, cur.holder);
      const boardHidden = !!cur.board && !(await boardVisible(repo, access, sp, handle, cur.board));
      return { ...heldAnswer(cur, await holderHidden(repo, access, sp, opts.session ?? handle, cur.holder), boardHidden), ...lapsed };
    };
    const cur = await repo.claims.get(sp, key);
    const d = takeDecision(cur, addresses, handle, now, opts);
    if (d.held) return held(cur!);
    const row = await repo.claims.take(sp, { key, as: d.as, note: opts.note ?? null, board, now, expires: d.expires, user: opts.user ?? null });
    if (!row) return held((await repo.claims.get(sp, key))!);
    checkMove(d.renewed, row, cur, !!(row.board && (await repo.boards.get(sp, row.board))?.archived_at));
    await repo.claims.logEvent(sp, d.renewed ? "renew" : "take", d.as, row, now);
    const say = (text: string, ending: boolean) => systemPost(repo, access, sp, d.as, row.board!, text, null, {
      allowArchived: ending, session: opts.session, via: opts.via, user: opts.user,
    });
    let changed: ClaimChanges = { wake: [], boards: [] };
    if (!d.renewed) {
      if (row.board) {
        const said = await say(claimText(key, row.note), false);
        await opts.announced?.(sp, d.as, row.board, said.postId);
        changed = said;
      }
    } else if (renewAnnounces(opts.note, cur) && row.board && (await boardVisible(repo, access, sp, d.as, row.board))) {
      const said = await say(updateText(key, opts.note!, await repo.claims.watchers(sp, key)), true);
      await opts.announced?.(sp, d.as, row.board, said.postId);
      changed = said;
    }
    return {
      ok: true, claim: row, renewed: d.renewed,
      wake: [...new Set([...lapsed.wake, ...changed.wake])],
      boards: [...new Set([...lapsed.boards, ...changed.boards])],
    };
  });
}

/** core release on `tx`, in a savepoint as core's own transaction was (serverClaim says why). */
export async function serverRelease(
  repo: Repo, access: BoardAccess, tx: Tx, handle: string, keyInput: string, note?: string, ctx: ServerClaimCtx = {},
): Promise<ClaimChanges & { releasedAt?: number }> {
  const key = checkRelease(keyInput, note);
  const addresses = ctx.addresses ?? [handle];
  return tx.savepoint(async (sp) => {
    const now = Date.now();
    const refuse = async (cur: ClaimRow | undefined) => {
      const releasedAt = releasedByRule(await repo.claims.recentEvents(sp, key), key, addresses);
      if (releasedAt !== undefined) return { wake: [], boards: [], releasedAt };
      // A queue post's claim on a board the caller can't see answers as no claim: its key names the board (#270 D5).
      if (cur && isQueueKey(key) && !(cur.board && (await boardVisible(repo, access, sp, handle, cur.board)))) throw releaseRefusal(key, undefined, now, false);
      const live = !!cur && cur.expires_at > now;
      throw releaseRefusal(key, cur, now, live && (await holderHidden(repo, access, sp, ctx.session ?? handle, cur!.holder)));
    };
    const cur = await repo.claims.get(sp, key);
    if (!releasable(cur, addresses, now)) return refuse(cur);
    const gone = await repo.claims.release(sp, key, cur!.holder, now);
    if (!gone) return refuse(await repo.claims.get(sp, key));
    const as = gone.holder;
    await repo.claims.logEvent(sp, "release", as, { ...gone, note: note ?? null }, now);
    // A declined queue post goes to the next lane with the original post, unannounced (#192 review).
    if (key.startsWith("queue:")) return requeue(repo, access, sp, gone, now, ctx);
    const cc = await repo.claims.takeWatchers(sp, key);
    // A holder who lost the board releases quietly; its watchers go too, since they're told through the board.
    if (!gone.board || !(await boardVisible(repo, access, sp, as, gone.board))) return { wake: [], boards: [] };
    // A release with no signed-in caller posts as the claimant's user (#855).
    const { postId, ...changed } = await systemPost(repo, access, sp, as, gone.board, releaseText(key, note, cc), null, {
      allowArchived: true, session: ctx.session, via: ctx.via, user: ctx.user ?? (await repo.claims.holderUser(sp, gone)),
    });
    await ctx.announced?.(sp, as, gone.board, postId);
    return changed;
  });
}

/** core watch on `tx`: its checks in order, then the watch. */
export async function serverWatch(
  repo: Repo, access: BoardAccess, tx: Tx, handle: string, keyInput: string, off = false, addresses: string[] = [handle], seer: string = handle,
): Promise<string> {
  const key = validKey(keyInput);
  if (off) {
    await repo.claims.unwatch(tx, key, handle);
    return notWatching(key);
  }
  const cur = await repo.claims.liveForWatch(tx, key, Date.now());
  // A queue post's claim on a board the caller can't see answers as no claim: its key names the board (#270 D5).
  if (!cur || (isQueueKey(key) && !(cur.board && (await boardVisible(repo, access, tx, handle, cur.board))))) throw watchNoClaim(key);
  if (addresses.includes(cur.holder)) throw watchOwn(key);
  if (!cur.board || !(await boardVisible(repo, access, tx, handle, cur.board))) {
    throw watchNoBoard(key, (await holderHidden(repo, access, tx, seer, cur.holder)) ? null : cur.holder);
  }
  await repo.claims.addWatch(tx, key, handle);
  return watching(key, cur.board);
}
