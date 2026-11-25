import { randomBytes } from "node:crypto";
import { DEFAULT_HOSTED_CAPS, type HostedCaps } from "./config.ts";
import { BOARD_NAME_RE, type SnapshotOptions } from "../core/boards.ts";
import { ApplicationError, type Application, type ApplicationSession } from "./application.ts";
import { CoreError } from "../core/errors.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";
import { countRefusal } from "./metrics.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import type { Read } from "./store/tx.ts";

export function boardResourceUri(board: string): string {
  if (!BOARD_NAME_RE.test(board) || board.trim() !== board) throw new ApplicationError("bad_request", "invalid board resource name");
  return `grayboard://boards/${encodeURIComponent(board)}`;
}
export function parseBoardResourceUri(uri: string): string {
  // Board names use only unreserved characters; escapes would be noncanonical aliases.
  const match = /^grayboard:\/\/boards\/([a-z0-9_-]{1,32})$/.exec(uri);
  if (!match || match[0] !== uri) throw new ApplicationError("not_found", "board resource not found");
  return match[1]!;
}
export type ResourceHooks = {
  changed(): void | Promise<void>;
  closed?(): void | Promise<void>;
};
export type ResourceOptions = {
  // Trusted boundary rechecks the session's grant/scopes; never derive a principal here.
  // `r`: the body's Tx when the check runs inside one (`list`, `read` inside hosted `run`); else the pool.
  isAuthorized(session: ApplicationSession, r?: Read): boolean | Promise<boolean>;
  // The check's part that reads no token, synchronous: the session still has a live principal of its own user. A
  // `watch` whose caller already checked the token runs only this (#807 P3 A7d2c).
  isCurrent(session: ApplicationSession): boolean;
  caps?: HostedCaps["watches"];
};
type Watch = {
  id: string;
  session: ApplicationSession;
  board: string;
  hooks: ResourceHooks;
  unsubscribe?: () => void;
};
function notify(operation: "resources.changed" | "resources.closed", callback?: () => void | Promise<void>) {
  try { void Promise.resolve(callback?.()).catch(e => hostedFailure(operation, e)); } catch (e) { hostedFailure(operation, e); }
}

export function createResources(application: Application, options: ResourceOptions) {
  const caps = options.caps ?? DEFAULT_HOSTED_CAPS.watches;
  const watches = new Map<string, Watch>();
  // Each session's watches, so a session's close and its capacity check don't scan every watch (#805).
  const bySession = new Map<ApplicationSession, Set<Watch>>();
  let stopped = false;
  function drop(watch: Watch): boolean {
    if (!watches.delete(watch.id)) return false;
    const own = bySession.get(watch.session);
    own?.delete(watch);
    if (own && !own.size) bySession.delete(watch.session);
    return true;
  }
  function finish(watch: Watch) {
    if (!drop(watch)) return;
    try { watch.unsubscribe?.(); } finally { notify("resources.closed", watch.hooks.closed); }
  }
  function finishQuietly(watch: Watch) {
    try { finish(watch); } catch (e) { hostedFailure("resources.finish", e); }
  }
  const unauthenticated = (error: unknown) => error instanceof ApplicationError && error.code === "unauthenticated";
  // The checks that read nothing: not stopped, the session current and its binding (revalidateNow; its user is
  // `authorized`'s, or the checked watch's caller's, #807 P3 A7u1).
  function current(session: ApplicationSession, allowUnbound = false): boolean {
    try {
      if (stopped || !options.isCurrent(session)) return false;
      application.revalidateNow(session, allowUnbound);
      return true;
    } catch (error) {
      if (unauthenticated(error)) return false;
      throw error;
    }
  }
  // The token check and the session's user check, then `current` after their awaits: a stop or a session change that
  // landed meanwhile refuses (#807 P3 A7d2c, A7u1). A failed read rejects, never authorizes.
  async function authorized(session: ApplicationSession, allowUnbound = false, r?: Read): Promise<boolean> {
    try {
      if (stopped || !await options.isAuthorized(session, r)) return false;
      if (stopped || !options.isCurrent(session)) return false;
      await application.revalidateSession(session, allowUnbound, r);
    } catch (error) {
      if (unauthenticated(error)) return false;
      throw error;
    }
    return current(session, allowUnbound);
  }
  function refuse(session: ApplicationSession): never {
    for (const watch of [...bySession.get(session) ?? []]) finishQuietly(watch);
    throw new ApplicationError("unauthenticated", "resource session is closed or unauthorized");
  }
  async function requireSession(session: ApplicationSession, allowUnbound = false, r?: Read) {
    if (!await authorized(session, allowUnbound, r)) refuse(session);
  }
  // Runs from a board change (the watch's `changed`, as the background pass "resource watch check"), so a server's stop()
  // waits for its reads before it closes the store (#1504, #1506). revalidate() runs it too, untracked: only tests call
  // that. A watch finished while the check awaited stays finished, and gets no notification (#807 P3 A7d2c).
  async function live(watch: Watch): Promise<boolean> {
    if (!watches.has(watch.id)) return false;
    // Background faults close the watch without failing a committed mutation.
    try {
      const ok = await authorized(watch.session);
      await testPauseAsync("resources:live:checked");
      // The board read is the last await: the session and the watch are judged with none since (#807 P3 B5a2).
      const visible = ok && watches.has(watch.id) && (await application.boardsVisible(application.repo.read, watch.session, [watch.board])).get(watch.board);
      if (visible && watches.has(watch.id) && current(watch.session)) return true;
    } catch (e) { hostedFailure("resources.authorize", e); }
    finishQuietly(watch);
    return false;
  }
  const service = {
    get activeWatchCount() { return watches.size; },
    async list(r: Read, session: ApplicationSession, after?: string) {
      await requireSession(session, true, r);
      const page = await application.boardCatalog(r, session, after);
      return { resources: page.boards.map(board => ({ uri: boardResourceUri(board.name), board })), next_after: page.next_after };
    },
    async read(r: Read, session: ApplicationSession, uri: string, options: SnapshotOptions = {}) {
      await requireSession(session, true, r);
      const board = parseBoardResourceUri(uri);
      return { uri: boardResourceUri(board), ...await application.boardSnapshot(r, session, board, options) };
    },
    // Synchronous, for a caller that has just checked the session's token, with no await since, and read the board's
    // visibility for it before the hosted row (mcp's makeLive and its legacy control, after `authorize`): `visible` is that read's answer
    // (`Checked.boards`, #807 P3 B5a2), and only `current` runs here. A caller with no answer passes false: the
    // watch is refused, never left unchecked (#807 P3 A7d2c).
    watch(session: ApplicationSession, uri: string, hooks: ResourceHooks, visible: boolean): string {
      if (!current(session)) refuse(session);
      const board = parseBoardResourceUri(uri);
      // As a content read refuses a board it can't see: as missing, so its existence doesn't leak.
      if (visible !== true) throw new CoreError(`no such board #${board}; see board_list`);
      if (watches.size >= caps.global || (bySession.get(session)?.size ?? 0) >= caps.perSession) {
        countRefusal("resource_watch");
        throw new ApplicationError("bad_request", "resource watch capacity reached");
      }
      const watch: Watch = { id: randomBytes(32).toString("base64url"), session, board, hooks };
      watches.set(watch.id, watch);
      let own = bySession.get(session);
      if (!own) bySession.set(session, own = new Set());
      own.add(watch);
      try {
        watch.unsubscribe = application.observeBoard(session, board, {
          // Called from a commit's afterCommit, which doesn't wait for it: the check and its hint are background work
          // a server's stop() tracks, bounds by its drain deadline, and skips once stopping (#1506).
          changed: () => application.runBackground("resource watch check", async halted => {
            if (await live(watch) && watches.has(watch.id) && !stopped && !halted()) notify("resources.changed", () => hooks.changed());
          }),
          closed: () => finishQuietly(watch),
        });
      } catch (error) { drop(watch); throw error; }
      return watch.id;
    },
    async unwatch(session: ApplicationSession, id: string): Promise<void> {
      await requireSession(session);
      const watch = watches.get(id);
      if (!watch) return;
      if (watch.session !== session) throw new ApplicationError("not_found", "resource watch not found");
      finish(watch);
    },
    // Closes every watch whose session or board access no longer holds. No timer runs it: every watch belongs to a
    // hosted MCP live (mcp.ts addWatch), whose stream timer rechecks the same token and board access each second and
    // stops the live, which ends its session and with it the watch (#807 P3 A7d2c).
    async revalidate(): Promise<void> { await Promise.all([...watches.values()].map(live)); },
    // A check already running is the server's background work: its stop() waits for it (#1506).
    close(): void {
      stopped = true;
      for (const watch of [...watches.values()]) finishQuietly(watch);
    },
  };
  return service;
}
export type Resources = ReturnType<typeof createResources>;
