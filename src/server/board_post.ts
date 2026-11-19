// The server's board_post (#807 P3 B5b2): core post's gate, checks, targeting plan and result over the store's rows on
// the caller's Tx, judged by the async BoardAccess on that same Tx. Every rule is core's (postGateRule, postPreChecks,
// planPostTargets, orderLanes, boardPostResult), so local and the server answer alike and only the reads differ.
import {
  mentionTokens, needsRotation, orderLanes, planPostTargets, postBranch, postGateRule, postPreChecks, postWakes, seenScopeOf,
  type Board, type PostGate, type PostTargetFacts,
} from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { attachmentIds, type FileSend } from "../core/attachments.ts";
import { boardPostResult, optNum, str, type BoardPostResult, type ToolContext } from "../core/tools.ts";
import { scopeKey, type AliasScopeOf, type BoardAccess } from "./access.ts";
import { readableBoard } from "./board_reads.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";
import type { Post } from "../shared/notifications.ts";

/**
 * core postGate on `r`: the board `actor` may post on, and what its gate decided. Throws core's refusals in core's
 * order. The server has no announce board; only the system's posts ending a claim pass `allowArchived`.
 */
export async function postGateOn(
  repo: Repo, access: BoardAccess, r: Read, actor: string, boardInput: string, parentId: number | null, allowArchived = false,
): Promise<{ board: Board; gate: PostGate }> {
  const board = await readableBoard(repo, access, r, actor, boardInput);
  // Read before the rule needs them: reads have no effects, and the rule still throws in core's order.
  const parent = parentId === null ? undefined : await repo.boards.post(r, parentId);
  const human = await repo.aliases.isHuman(r, actor);
  return { board, gate: postGateRule(board, parentId, allowArchived, null, () => parent, () => human) };
}

/**
 * core's board_post arm for `actor` on a board its gate (postGateOn, same transaction) passed: the post written on
 * `tx`, its targets planned by core and written, and the answer as core shapes it. Refusals are core's, in core's
 * order: the gate's, the body's, the attachments' (after the insert), then a strict mention's.
 */
export async function serverPost(
  repo: Repo, access: BoardAccess, tx: Tx, actor: string, b: Board, gate: PostGate, args: Record<string, unknown>, ctx: ToolContext,
): Promise<{ result: BoardPostResult; wake: string[] }> {
  if (args.attachments !== undefined) throw new CoreError("attachments must be read by the session's grayboard MCP process; this one can't");
  str(args, "board");
  const body = str(args, "body");
  const parentId = optNum(args, "parent_id") ?? null;
  const files = { ids: attachmentIds(args.attachment_ids), send: ctx.files };
  postPreChecks(b.name, body, gate.announcement, { online: ctx.online, attachments: files });
  const w = await writePost(repo, access, tx, actor, b, gate, {
    body, parentId, strict: true, addresses: ctx.addresses, session: ctx.session, via: ctx.via, user: ctx.user, online: ctx.online, files,
  });
  const { out, isViewer, tokens } = w;
  const asked = [...out.wake, ...out.deferred, ...tokens];
  const seen = await seenAmong(repo, access, tx, ctx.session ?? actor, asked);
  const known = new Set(asked);
  const result = boardPostResult(w.post, out, body, isViewer, (hs) =>
    hs.filter((h) => {
      if (!known.has(h)) throw new Error(`board_post: whether ${h} is seen wasn't prefetched`);
      return seen.has(h);
    }));
  return { result, wake: out.wake };
}

/** What writePost writes as: the post's body and parent, and its writer's facts. `strict` (an author's own words) refuses
 * an unknown or ended `@id:` mention and bare names core refuses, and lets a single mention claim a queue post; `addresses` is the poster's address set, `[actor]` when absent (a claim
 * announcement); `online` orders a rotation's live lanes first; `files` binds uploads (board_post only). */
type PostWrite = {
  body: string; parentId: number | null; strict: boolean; addresses?: string[];
  session?: string; via?: string; user?: string; online?: (h: string) => boolean; files?: { ids: number[]; send?: FileSend };
};

/**
 * core post's write on `tx`, for a board its gate (postGateOn) passed and whose pre-checks ran: the post row, its
 * attachments, its targets planned by core and written, a queue claim or ack. Core's order throughout.
 */
async function writePost(
  repo: Repo, access: BoardAccess, tx: Tx, actor: string, b: Board, gate: PostGate, w: PostWrite,
): Promise<{ post: Post; out: { wake: string[]; deferred: string[]; unresolved: string[] }; isViewer: (h: string) => boolean; tokens: string[] }> {
  const { body, parentId, strict } = w;
  const isViewer = await viewerCheck(repo, tx);

  const now = Date.now();
  const p = await repo.boards.insertPost(tx, {
    board: b.name, author: actor, body, parentId, now, expiresAt: null,
    authorId: w.session ?? null, via: w.via ?? null, authorUser: w.user ?? null,
  });
  const addresses = w.addresses ?? [actor];
  const send = w.files?.send;
  const attachments = send && w.files!.ids.length
    ? await repo.boards.bindAttachments(tx, w.files!.ids, { addresses, principal: send.principal }, p.id, send.limits)
    : [];
  const own = [...new Set([...addresses, ...(await repo.boards.authorAddresses(tx, actor, w.session ?? null))])];
  const viewer = w.session ?? actor;
  const branch = postBranch(b, parentId, gate.announcement);
  const tokens = mentionTokens(body);
  const facts: PostTargetFacts = {
    board: b, handle: actor, parentId, strict, gate, own, ackAddresses: addresses, isViewer,
    isHuman: prefetched([], new Set(), "isHuman"), sees: prefetched([], new Set(), "sees"), mayLane: prefetched([], new Set(), "mayLane"),
    mentions: { handles: [], unresolved: [] },
  };
  if (branch === "queue") {
    facts.mentions = await access.resolveMentions(tx, tokens, actor, b, strict, viewer);
    const seen = await seenAmong(repo, access, tx, viewer, facts.mentions.handles);
    facts.seenMentioned = facts.mentions.handles.filter((h) => seen.has(h));
    facts.isHuman = prefetched(facts.seenMentioned, await repo.aliases.humansAmong(tx, facts.seenMentioned), "isHuman");
    // A claim by name asks the lane rule too (#270 D5).
    facts.mayLane = prefetched(facts.seenMentioned, await access.lanesAmong(tx, facts.seenMentioned, b), "mayLane");
    // Whether the poster may be a lane matters only when every visible name may not be one (needsRotation).
    facts.lanesOnly = strict && facts.seenMentioned.length > 0 && !facts.seenMentioned.some(facts.mayLane)
      && (await access.lanesAmong(tx, own, b)).size === 0;
    if (needsRotation(facts.seenMentioned, facts.mayLane, facts.lanesOnly)) {
      const rows = await repo.boards.laneRows(tx, b.name, own);
      const sees = rows.length ? await access.canSeeMany(tx, rows, b) : new Set<string>();
      const lanes = rows.length ? await access.lanesAmong(tx, rows, b) : new Set<string>();
      facts.lanes = orderLanes(rows, isViewer, (h) => sees.has(h), (h) => lanes.has(h), w.online);
    }
  } else if (branch === "announcement") {
    throw new Error("board_post: the server has no announce board");
  } else {
    facts.subs = await repo.boards.subscribers(tx, b.name);
    const judged = facts.subs.map((s) => s.handle);
    if (branch === "thread") {
      facts.thread = await repo.boards.threadFacts(tx, parentId!);
      const { authors } = facts.thread;
      judged.push(...authors);
      facts.reaches = prefetched(authors, authors.length ? await access.mayReachMany(tx, actor, authors) : new Set(), "reaches");
      facts.isHuman = prefetched(authors, await repo.aliases.humansAmong(tx, authors), "isHuman");
    }
    facts.sees = prefetched(judged, judged.length ? await access.canSeeMany(tx, judged, b) : new Set(), "sees");
    facts.mentions = await access.resolveMentions(tx, tokens, actor, b, strict, viewer);
  }
  const plan = planPostTargets(facts);
  if (plan.claim) await repo.boards.claimQueuePost(tx, b.name, p.id, plan.claim.lane, now, { note: plan.claim.note, push: plan.claim.push });
  if (plan.ack) await repo.claims.ackQueue(tx, plan.ack.addresses, plan.ack.key, now);
  await repo.boards.insertOutbox(tx, p.id, plan.targets);
  return { post: attachments.length ? { ...p, attachments } : p, out: { ...postWakes(plan.targets), unresolved: plan.unresolved }, isViewer, tokens };
}

/**
 * core post as the system writes it for a claim (announce, requeue's `[unclaimed]`): the gate on `tx` (allowArchived for
 * a post ending a claim), core's pre-checks with no files or live sessions, and the write with mentions non-strict, so
 * a watcher's ended `@id:` goes unresolved rather than refusing. Throws the gate's and the pre-checks' refusals.
 * `postId` is the post written, for an invocation row to name (#1261).
 */
export async function systemPost(
  repo: Repo, access: BoardAccess, tx: Tx, actor: string, board: string, body: string, parentId: number | null,
  o: { allowArchived: boolean; session?: string; via?: string; user?: string; addresses?: string[] },
): Promise<{ wake: string[]; boards: string[]; postId: number }> {
  const { board: b, gate } = await postGateOn(repo, access, tx, actor, board, parentId, o.allowArchived);
  postPreChecks(b.name, body, gate.announcement, {});
  const { post, out } = await writePost(repo, access, tx, actor, b, gate, {
    body, parentId, strict: false, addresses: o.addresses, session: o.session, via: o.via, user: o.user,
  });
  return { wake: out.wake, boards: [post.board], postId: post.id };
}

// core viewers on `r`.
async function viewerCheck(repo: Repo, r: Read): Promise<(h: string) => boolean> {
  const ids = await repo.bindings.viewerIds(r);
  return (h) => ids.has(h);
}

// A predicate answered from a set read up front for `known`; a handle outside it is a bug, so it throws rather than
// answer either way (as who's prefetched lookups do, boards.ts).
function prefetched(known: Iterable<string>, yes: Set<string>, what: string): (h: string) => boolean {
  const k = new Set(known);
  return (h) => {
    if (!k.has(h)) throw new Error(`board_post: ${what} of ${h} wasn't prefetched`);
    return yes.has(h);
  };
}

/**
 * core seenHandles as a set: of `handles`, those whose existence `viewer` (a session ID or handle) may see, a team's
 * aliases only inside the team (#348, #871), read and judged on `r` with one decision per distinct scope.
 */
export async function seenAmong(repo: Repo, access: BoardAccess, r: Read, viewer: string, handles: string[]): Promise<Set<string>> {
  const hs = [...new Set(handles)];
  if (!hs.length) return new Set();
  const rows = await repo.aliases.scopesOf(r, hs);
  const scopeOf = new Map(hs.map((h) => [h, seenScopeOf(rows.get(h), h)]));
  const scopes = [...new Map([...scopeOf.values()].flatMap((s): [string, AliasScopeOf][] => (s ? [[scopeKey(s), s]] : []))).values()];
  const sees = scopes.length ? await access.seesAliasScopes(r, viewer, scopes) : new Map<string, boolean>();
  return new Set(hs.filter((h) => {
    const s = scopeOf.get(h);
    return !s || sees.get(scopeKey(s)) === true;
  }));
}
