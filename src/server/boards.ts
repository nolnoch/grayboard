// The server's board tools (#807 P3 B5b1b): the store's rows on the caller's Tx, judged by the async BoardAccess on
// that same Tx, then core's own rule over them (src/core/tools.ts, boards.ts, bindings.ts), so local and the server
// share each rule and refusal text and only the reads differ. A tool not yet ported runs core over coreOn(tx).
import { actorChoice } from "../core/bindings.ts";
import {
  assembleWho, boardsFromViews, finishWho, noStatusText, parseMatch, pickView, statusText, unboundFrom,
  type Board, type BoardSummary, type WhoRow,
} from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import type { Principal } from "../core/resolver.ts";
import { callBoardTool as coreCallBoardTool, optBool, optStr, peerStatusArgs, type ToolContext, type ToolOutcome } from "../core/tools.ts";
import { scopeKey, type AliasScopeOf, type BoardAccess } from "./access.ts";
import { readableBoard } from "./board_reads.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

// core's ToolContext (its `reader` a sync predicate the tools still on core take), plus `principal`: an addressless
// caller's user (an unbound hosted session, #410), whose sight judges board_list, peer_list and the boards it reads.
export type ServerToolContext = ToolContext & { principal?: Principal };

/**
 * core's boardActor over the store: `as`, else the first of `addresses` a board use acts as (#284 S3, S14), else the
 * primary. Rows and their visibility are read on `r`.
 */
export async function serverBoardActor(
  repo: Repo,
  access: BoardAccess,
  r: Read,
  tool: string,
  args: Record<string, unknown>,
  s: { addresses: string[]; asAddresses: string[]; ownScope: string | null },
): Promise<string> {
  const c = actorChoice(tool, args, s);
  if ("actor" in c) return c.actor;
  const views = await repo.boards.views(r, s.addresses, c.board);
  if (!views.length) return c.primary;
  const seen = await access.canSeeMany(r, s.addresses, views[0]!.row);
  return pickView(views.filter((v) => seen.has(v.handle)), c.use)?.handle ?? c.primary;
}

/** core's callBoardTool for `actor` (already resolved by serverBoardActor), on the body's Tx. */
export async function callBoardTool(
  repo: Repo,
  access: BoardAccess,
  tx: Tx,
  actor: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: ServerToolContext,
): Promise<ToolOutcome> {
  const a = args ?? {};
  if (a.as !== undefined) throw new Error(`${tool}: "as" must be resolved by serverBoardActor before callBoardTool`);
  switch (tool) {
    case "board_list":
      return { result: await listBoards(repo, access, tx, ctx.principal ?? [actor, ...(ctx.addresses ?? []).filter((h) => h !== actor)]), wake: [] };

    case "peer_status": {
      const { text, queue } = peerStatusArgs(a, actor);
      const t = statusText(text);
      if (!(await repo.bindings.setStatus(tx, actor, t, Date.now()))) throw new CoreError(noStatusText(actor));
      if (queue !== undefined) await repo.bindings.setQueueParticipation(tx, actor, queue === "on");
      return { result: "ok", wake: [] };
    }

    case "peer_list": {
      if (!ctx.online) throw new CoreError("peer_list isn't available in this mode");
      const board = optStr(a, "board");
      const result = await who(repo, access, tx, actor, { board, include_offline: optBool(a, "include_offline"), match: parseMatch(a.match) }, ctx);
      return { result, wake: [] };
    }
  }
  const { principal: _, ...coreCtx } = ctx;
  return coreCallBoardTool(repo.coreOn(tx), actor, tool, a, coreCtx);
}

// core's listBoards: each open board's row is the view of the address a read without `as` acts as (S14); a principal
// (an addressless reader) sees rows with no mode and nothing unread.
async function listBoards(repo: Repo, access: BoardAccess, r: Read, viewer: string[] | Principal): Promise<BoardSummary[]> {
  if (!Array.isArray(viewer)) {
    const rows = await repo.boards.openSummaries(r);
    const seen = await access.visibleTo(r, viewer, rows);
    return rows.filter((b) => seen.has(b.name));
  }
  const views = await repo.boards.views(r, viewer, null);
  const judged = [];
  for (const h of viewer) {
    const mine = views.filter((v) => v.handle === h);
    const seen = await access.visibleTo(r, h, mine.map((v) => v.row));
    judged.push(...mine.filter((v) => seen.has(v.row.name)));
  }
  return boardsFromViews(judged);
}

// core's who over the store. Every scope assembleWho may ask about (each row's alias scope, and each row's
// principal as a person scope, null included) is decided up front in one batch per check, for the caller's session
// (`ctx.session`, else the actor); a lookup outside that set is a bug, so it throws rather than answer either way.
async function who(
  repo: Repo,
  access: BoardAccess,
  tx: Tx,
  actor: string,
  opts: { board?: string; include_offline?: boolean; match?: ReturnType<typeof parseMatch> },
  ctx: ServerToolContext,
) {
  let rows: WhoRow[];
  if (opts.board !== undefined) {
    const b: Board = await readableBoard(repo, access, tx, ctx.principal ?? actor, opts.board);
    const all = await repo.boards.roster(tx, b.name);
    const seen = all.length ? await access.canSeeMany(tx, [...new Set(all.map((r) => r.handle))], b) : new Set<string>();
    rows = all.filter((r) => seen.has(r.handle));
  } else {
    rows = await repo.boards.roster(tx, null);
  }
  const viewer = ctx.session ?? actor;
  const scopes = new Map<string, AliasScopeOf>();
  for (const r of rows) {
    if (r.scope_kind !== null) scopes.set(scopeKey({ scope_kind: r.scope_kind, scope_ref: r.scope_ref }), { scope_kind: r.scope_kind, scope_ref: r.scope_ref });
    const person: AliasScopeOf = { scope_kind: "person", scope_ref: r.principal };
    scopes.set(scopeKey(person), person);
  }
  const list = [...scopes.values()];
  const names = list.length ? await access.seesAliasScopes(tx, viewer, list) : new Map<string, boolean>();
  const metas = list.length ? await access.seesAliasMetaScopes(tx, viewer, list) : new Map<string, boolean>();
  const lookup = (m: Map<string, boolean>, what: string) => (scope: AliasScopeOf): boolean => {
    const v = m.get(scopeKey(scope));
    if (v === undefined) throw new Error(`peer_list: ${what} of ${scopeKey(scope)} wasn't prefetched`);
    return v;
  };
  const viewers = await repo.bindings.viewerIds(tx);
  const unbound = opts.board === undefined ? (ctx.unbound ?? []) : [];
  const facts = unbound.length ? await repo.bindings.idFacts(tx, unbound.map((u) => u.session_id)) : new Map();
  const peers = assembleWho(rows, opts.match, {
    isViewer: (h) => viewers.has(h),
    seesName: lookup(names, "seesAlias"),
    seesMeta: lookup(metas, "seesAliasMeta"),
    online: ctx.online!,
    own: new Set(ctx.addresses ?? [actor]),
    now: Date.now(),
  });
  // A board's roster lists its unbound subscribers by ID among its peers.
  return finishWho(peers, unboundFrom(unbound, (id) => facts.get(id), opts.match), viewers.has(actor) ? undefined : actor, opts.include_offline);
}
