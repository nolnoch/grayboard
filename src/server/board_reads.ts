// The server's board reads (#807 P3 B5a1): the store's rows on the caller's handle, judged by the async BoardAccess
// on that same handle, then core's own rule over them (catalogWalk, pushItems/digestItems), so local and the server
// share one rule and only the reads differ.
import { catalogWalk, digestItems, normalizeBoard, pushItems, wantsDigests, type Board, type BoardSnapshot, type Catalog, type PendingRef, type SnapshotOptions } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import type { Principal } from "../core/resolver.ts";
import type { Pending } from "../shared/notifications.ts";
import type { BoardAccess } from "./access.ts";
import type { Repo } from "./db.ts";
import type { Read } from "./store/tx.ts";

// Who a read is judged for: an address, the addresses of a session (any one seeing a board will do), or a principal
// (an unbound session's user, #410).
export type BoardViewer = string | string[] | Principal;

// Of `names`, the boards that exist and `viewer` may see, read and judged on `r`.
export async function visibleBoards(repo: Repo, access: BoardAccess, r: Read, viewer: BoardViewer, names: Iterable<string>): Promise<Map<string, Board>> {
  const rows: Board[] = [];
  for (const name of new Set(names)) {
    const b = await repo.boards.get(r, name);
    if (b) rows.push(b);
  }
  return keep(rows, await seen(access, r, viewer, rows));
}

async function seen(access: BoardAccess, r: Read, viewer: BoardViewer, boards: Board[]): Promise<Set<string>> {
  if (!boards.length) return new Set();
  if (!Array.isArray(viewer)) return access.visibleTo(r, viewer, boards);
  const out = new Set<string>();
  for (const a of viewer) for (const name of await access.visibleTo(r, a, boards.filter((b) => !out.has(b.name)))) out.add(name);
  return out;
}

const keep = (boards: Board[], names: Set<string>) => new Map(boards.filter((b) => names.has(b.name)).map((b) => [b.name, b]));

// core's visibleBoard: the board named `input` if `viewer` may see it; one that's missing or hidden reads as missing,
// so its existence doesn't leak.
export async function readableBoard(repo: Repo, access: BoardAccess, r: Read, viewer: BoardViewer, input: string): Promise<Board> {
  const name = normalizeBoard(input);
  const b = (await visibleBoards(repo, access, r, viewer, [name])).get(name);
  if (!b) throw new CoreError(`no such board #${name}; see board_list`);
  return b;
}

// core's snapshot: the visibility refusal first, then the page's option checks and rows.
export async function boardSnapshot(repo: Repo, access: BoardAccess, r: Read, viewer: BoardViewer, input: string, opts: SnapshotOptions = {}): Promise<BoardSnapshot> {
  const board = await readableBoard(repo, access, r, viewer, input);
  return { board, ...(await repo.boards.snapshotPage(r, board.name, opts)) };
}

// core's boardCatalog: every board `viewer` may see, a page at a time in name order.
export function boardCatalog(repo: Repo, access: BoardAccess, r: Read, viewer: string | Principal, after?: string): Promise<Catalog> {
  return catalogWalk(after, (cursor) => repo.boards.catalogPage(r, cursor), async (rows) => {
    const names = await access.visibleTo(r, viewer, rows);
    return rows.filter((b) => names.has(b.name));
  });
}

// core's pendingFor for one address: its pushes on boards it sees, and with a waking push (or `all`) its due digests.
// A push it can no longer see goes to `lost` to be acknowledged; the caller says how (#807 D4: on its Tx in a body,
// queued outside one). The digest read runs only when it would be used, as core's does (#900).
export async function pendingOf(repo: Repo, access: BoardAccess, r: Read, address: string, all: boolean, lost: (ref: PendingRef) => Promise<void>): Promise<Pending[]> {
  const pushes = await repo.boards.pendingPushes(r, address);
  const seenPush = await visibleBoards(repo, access, r, address, pushes.map((p) => p.post.board));
  const { items, lost: gone } = pushItems(pushes, (board) => seenPush.has(board));
  for (const ref of gone) await lost(ref);
  if (!wantsDigests(items, all)) return [];
  const digests = await repo.boards.pendingDigests(r, address);
  const seenDigest = await visibleBoards(repo, access, r, address, digests.map((d) => d.board));
  return [...items, ...digestItems(digests, (board) => seenDigest.has(board))];
}
