// The server's board tools (#807 P3 B5b1b): the store's rows on the caller's Tx, judged by the async BoardAccess on
// that same Tx, then core's own rule over them (src/core/tools.ts, boards.ts, bindings.ts), so local and the server
// share each rule and refusal text and only the reads differ. A tool not yet ported runs core over coreOn(tx).
import { actorChoice } from "../core/bindings.ts";
import {
  archiveGate, archiveRefusalText, archiveRepeat, assembleWho, boardExistsText, boardsFromViews, checkSubMode, createArgs, createdNote, createRepeats,
  finishWho, normalizeBoard, noStatusText, parseMatch, pickView, seenScopeOf, statusText, threadNotOnBoard, unboundFrom,
  type Board, type BoardSummary, type WhoRow,
} from "../core/boards.ts";
import { claimView, type ClaimView } from "../core/claims.ts";
import { CoreError } from "../core/errors.ts";
import type { Principal } from "../core/resolver.ts";
import {
  callBoardTool as coreCallBoardTool, muteText, optBool, optNum, optStr, peerStatusArgs, str, subscribeArgs, subscribedText,
  type ToolContext, type ToolOutcome,
} from "../core/tools.ts";
import { scopeKey, type AliasScopeOf, type BoardAccess } from "./access.ts";
import { readableBoard, visibleBoards } from "./board_reads.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

// core's ToolContext (its `reader` unset on the server), plus `principal`: an addressless
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
    case "board_create": {
      const team = optStr(a, "team");
      const scope = team ? `team:${team.toLowerCase()}` : null;
      const kind = optStr(a, "kind");
      const name = normalizeBoard(str(a, "name"));
      // A repeat whose first answer was lost (#254), answered from state; never for the Slack bridge's human.
      const repeat = async (mine: Board | undefined) =>
        !ctx.human && createRepeats(mine, actor, scope, kind, () => str(a, "purpose")) && (await access.canSee(tx, actor, mine!));
      const mine = ctx.human ? undefined : await repo.boards.get(tx, name);
      if (await repeat(mine)) return { result: createdNote(mine!), wake: [] };
      // core createBoard.
      const c = createArgs(str(a, "name"), str(a, "purpose"), kind);
      const denied = await access.checkCreate(tx, actor, scope);
      if (denied) throw new CoreError(denied);
      const b = await repo.boards.create(tx, { name: c.board, purpose: c.purpose, scope, kind: c.kind, createdBy: actor, now: Date.now() });
      if (!b) {
        // Taken. On Postgres a concurrent first create of this repeat commits between the read above and the insert,
        // which waits for it: answered as the repeat it is (C1). On SQLite the read above already saw it.
        const old = await repo.boards.get(tx, c.board);
        if (await repeat(old)) return { result: createdNote(old!), wake: [] };
        throw new CoreError(boardExistsText(c.board, !!old?.archived_at && (await access.canSee(tx, actor, old))));
      }
      // core subscribe's visibility check on the new row: a refusal rolls the insert back with the body.
      if (!(await access.canSee(tx, actor, b))) throw new CoreError(`no such board #${b.name}; see board_list`);
      await repo.boards.setSubscription(tx, actor, b.name, "push");
      return { result: b, wake: [], boards: [b.name] };
    }

    case "board_archive": {
      const input = str(a, "board");
      const archived = optBool(a, "archived") ?? true;
      // core archiveBoard; the server has no announce board.
      const b = await readableBoard(repo, access, tx, actor, input);
      archiveGate(b, null);
      const human = (ctx.human || (await repo.aliases.isHuman(tx, actor))) && (await access.sameUser(tx, actor, b.created_by));
      if (!human && !(ctx.addresses ?? [actor]).includes(b.created_by)) {
        throw new CoreError(archiveRefusalText(b, await access.ownerOf(tx, b.created_by)));
      }
      const note = archiveRepeat(b, archived);
      if (note) return { result: { ...b, note }, wake: [] };
      // A concurrent archive or reopen committed first (A1, Postgres): answered as the repeat this now is. A third
      // write may flip it back before the re-read, so the update is tried again, a bounded number of times.
      for (let tries = 0; tries < 3; tries++) {
        const after = await repo.boards.setArchived(tx, b.name, archived ? actor : null, Date.now());
        if (after) return { result: after, wake: [], boards: [b.name] };
        const now = (await repo.boards.get(tx, b.name))!;
        const repeat = archiveRepeat(now, archived);
        if (repeat) return { result: { ...now, note: repeat }, wake: [] };
      }
      throw new CoreError(`#${b.name} kept changing while it was ${archived ? "archived" : "reopened"}; try again`);
    }

    case "board_read": {
      const input = str(a, "board");
      const opts = { limit: optNum(a, "limit"), before_id: optNum(a, "before_id"), thread: optNum(a, "thread") };
      const viewer = ctx.principal ?? actor;
      const b = await readableBoard(repo, access, tx, viewer, input);
      // A principal has no cursor, and a child's read (via) peeks: its root's read state stays as it was (#523).
      const r = await repo.boards.read(tx, b.name, ctx.principal || ctx.via !== undefined ? null : actor, opts);
      // Claims announced here stay in front of anyone reading the board.
      const held = (await claimViews(repo, access, tx, undefined, viewer, ctx.session ?? actor)).filter((c) => c.board === r.board);
      return { result: held.length ? { ...r, active_claims: held } : r, wake: [] };
    }

    case "board_subscribe": {
      const s = subscribeArgs(a);
      const b = await readableBoard(repo, access, tx, actor, s.board);
      if (s.thread !== undefined) {
        const p = await repo.boards.post(tx, s.thread);
        if (!p || p.board !== b.name) throw new CoreError(threadNotOnBoard(s.thread, b.name));
        const root = await repo.boards.threadRoot(tx, s.thread);
        await repo.boards.mute(tx, actor, root, s.mode === "off");
        return { result: muteText(s.board, root, s.mode === "off"), wake: [] };
      }
      if (s.mode !== "off") checkSubMode(s.mode);
      await repo.boards.setSubscription(tx, actor, b.name, s.mode);
      return { result: subscribedText(s.board, s.mode), wake: [] };
    }

    case "claim_list":
      return { result: await claimViews(repo, access, tx, optStr(a, "prefix"), ctx.principal ?? actor, ctx.session ?? actor), wake: [] };

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

// core's listClaims for a reader: live claims by key, each board named only when `viewer` sees it, each holder and note
// only when `seer` (a session ID or handle) may see the holder exists (#348, #871).
async function claimViews(repo: Repo, access: BoardAccess, r: Read, prefix: string | undefined, viewer: string | Principal, seer: string): Promise<ClaimView[]> {
  const rows = await repo.claims.list(r, prefix);
  if (!rows.length) return [];
  const boards = await visibleBoards(repo, access, r, viewer, rows.flatMap((c) => (c.board ? [c.board] : [])));
  const holders = [...new Set(rows.map((c) => c.holder))];
  const aliasRows = await repo.aliases.scopesOf(r, holders);
  const scopeOf = new Map(holders.map((h) => [h, seenScopeOf(aliasRows.get(h), h)]));
  const scopes = [...new Map([...scopeOf.values()].flatMap((s) => (s ? [[scopeKey(s), s] as const] : []))).values()];
  const sees = scopes.length ? await access.seesAliasScopes(r, seer, scopes) : new Map<string, boolean>();
  return rows.map((c) => {
    const scope = scopeOf.get(c.holder);
    return claimView(c, !c.board || boards.has(c.board), !scope || sees.get(scopeKey(scope)) === true);
  });
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
