// The server's board_post (#807 P3 B5b2): core post's gate, checks, targeting plan and result over the store's rows on
// the caller's Tx, judged by the async BoardAccess on that same Tx. Every rule is core's (postGateRule, postPreChecks,
// planPostTargets, orderLanes, boardPostResult), so local and the server answer alike and only the reads differ.
import {
  mentionTokens, needsRotation, orderLanes, planPostTargets, postBranch, postGateRule, postPreChecks, postWakes, seenScopeOf,
  type Board, type PostGate, type PostTargetFacts,
} from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { attachmentIds } from "../core/attachments.ts";
import { boardPostResult, optNum, str, type BoardPostResult, type ToolContext } from "../core/tools.ts";
import { scopeKey, type AliasScopeOf, type BoardAccess } from "./access.ts";
import { readableBoard } from "./board_reads.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

/**
 * core postGate on `r`: the board `actor` may post on, and what its gate decided. Throws core's refusals in core's
 * order. The server has no announce board, and nothing a caller reaches posts with allowArchived.
 */
export async function postGateOn(
  repo: Repo, access: BoardAccess, r: Read, actor: string, boardInput: string, parentId: number | null,
): Promise<{ board: Board; gate: PostGate }> {
  const board = await readableBoard(repo, access, r, actor, boardInput);
  // Read before the rule needs them: reads have no effects, and the rule still throws in core's order.
  const parent = parentId === null ? undefined : await repo.boards.post(r, parentId);
  const human = await repo.aliases.isHuman(r, actor);
  return { board, gate: postGateRule(board, parentId, false, null, () => parent, () => human) };
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
  const isViewer = await viewerCheck(repo, tx);

  const now = Date.now();
  const p = await repo.boards.insertPost(tx, {
    board: b.name, author: actor, body, parentId, now, expiresAt: null,
    authorId: ctx.session ?? null, via: ctx.via ?? null, authorUser: ctx.user ?? null,
  });
  const { send } = files;
  const attachments = send && files.ids.length
    ? await repo.boards.bindAttachments(tx, files.ids, { addresses: ctx.addresses ?? [actor], principal: send.principal }, p.id, send.limits)
    : [];
  const addresses = ctx.addresses ?? [actor];
  const own = [...new Set([...addresses, ...(await repo.boards.authorAddresses(tx, actor, ctx.session ?? null))])];
  const viewer = ctx.session ?? actor;
  const branch = postBranch(b, parentId, gate.announcement);
  const tokens = mentionTokens(body);
  const facts: PostTargetFacts = {
    board: b, handle: actor, parentId, strict: true, gate, own, ackAddresses: addresses, isViewer,
    isHuman: prefetched([], new Set(), "isHuman"), sees: prefetched([], new Set(), "sees"),
    mentions: { handles: [], unresolved: [] },
  };
  if (branch === "queue") {
    facts.mentions = await access.resolveMentions(tx, tokens, actor, b, true, viewer);
    const seen = await seenAmong(repo, access, tx, viewer, facts.mentions.handles);
    facts.seenMentioned = facts.mentions.handles.filter((h) => seen.has(h));
    facts.isHuman = prefetched(facts.seenMentioned, await repo.aliases.humansAmong(tx, facts.seenMentioned), "isHuman");
    if (needsRotation(facts.seenMentioned)) {
      const rows = await repo.boards.laneRows(tx, b.name, own);
      const sees = rows.length ? await access.canSeeMany(tx, rows, b) : new Set<string>();
      facts.lanes = orderLanes(rows, isViewer, (h) => sees.has(h), ctx.online);
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
    facts.mentions = await access.resolveMentions(tx, tokens, actor, b, true, viewer);
  }
  const plan = planPostTargets(facts);
  if (plan.claim) await repo.boards.claimQueuePost(tx, b.name, p.id, plan.claim.lane, now, { note: plan.claim.note, push: plan.claim.push });
  if (plan.ack) await repo.claims.ackQueue(tx, plan.ack.addresses, plan.ack.key, now);
  await repo.boards.insertOutbox(tx, p.id, plan.targets);

  const out = { ...postWakes(plan.targets), unresolved: plan.unresolved };
  const asked = [...out.wake, ...out.deferred, ...tokens];
  const seen = await seenAmong(repo, access, tx, viewer, asked);
  const known = new Set(asked);
  const result = boardPostResult(attachments.length ? { ...p, attachments } : p, out, body, isViewer, (hs) =>
    hs.filter((h) => {
      if (!known.has(h)) throw new Error(`board_post: whether ${h} is seen wasn't prefetched`);
      return seen.has(h);
    }));
  return { result, wake: out.wake };
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
