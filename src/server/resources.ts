import { randomBytes } from "node:crypto";
import { BOARD_NAME_RE, type SnapshotOptions } from "../core/boards.ts";
import { ApplicationError, type Application, type ApplicationSession } from "./application.ts";

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
  isAuthorized(session: ApplicationSession): boolean;
};
type Watch = {
  id: string;
  session: ApplicationSession;
  board: string;
  hooks: ResourceHooks;
  unsubscribe?: () => void;
};
function notify(callback?: () => void | Promise<void>) {
  try { void Promise.resolve(callback?.()).catch(() => {}); } catch {}
}

export function createResources(application: Application, options: ResourceOptions) {
  const watches = new Map<string, Watch>();
  let stopped = false;
  function finish(watch: Watch) {
    if (!watches.delete(watch.id)) return;
    try { watch.unsubscribe?.(); } finally { notify(watch.hooks.closed); }
  }
  function finishQuietly(watch: Watch) {
    try { finish(watch); } catch {}
  }
  function authorized(session: ApplicationSession): boolean {
    try {
      if (stopped || !options.isAuthorized(session)) return false;
      application.revalidateSession(session);
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "unauthenticated") return false;
      throw error;
    }
  }
  function requireSession(session: ApplicationSession) {
    if (authorized(session)) return;
    for (const watch of [...watches.values()]) if (watch.session === session) finishQuietly(watch);
    throw new ApplicationError("unauthenticated", "resource session is closed or unauthorized");
  }
  function live(watch: Watch): boolean {
    if (!watches.has(watch.id)) return false;
    // Background faults close the watch without failing a committed mutation.
    try {
      if (authorized(watch.session) && application.canReceiveBoard(watch.session, watch.board)) return true;
    } catch {}
    finishQuietly(watch);
    return false;
  }
  const service = {
    list(session: ApplicationSession, after?: string) {
      requireSession(session);
      const page = application.boardCatalog(session, after);
      return { resources: page.boards.map(board => ({ uri: boardResourceUri(board.name), board })), next_after: page.next_after };
    },
    read(session: ApplicationSession, uri: string, options: SnapshotOptions = {}) {
      requireSession(session);
      const board = parseBoardResourceUri(uri);
      return { uri: boardResourceUri(board), ...application.boardSnapshot(session, board, options) };
    },
    watch(session: ApplicationSession, uri: string, hooks: ResourceHooks): string {
      requireSession(session);
      const board = parseBoardResourceUri(uri);
      if (watches.size >= 1024 || [...watches.values()].filter(w => w.session === session).length >= 32) {
        throw new ApplicationError("bad_request", "resource watch capacity reached");
      }
      const watch: Watch = { id: randomBytes(32).toString("base64url"), session, board, hooks };
      watches.set(watch.id, watch);
      try {
        watch.unsubscribe = application.observeBoard(session, board, {
          changed: () => { if (live(watch)) notify(() => hooks.changed()); },
          closed: () => finishQuietly(watch),
        });
      } catch (error) { watches.delete(watch.id); throw error; }
      return watch.id;
    },
    unwatch(session: ApplicationSession, id: string): void {
      requireSession(session);
      const watch = watches.get(id);
      if (!watch) return;
      if (watch.session !== session) throw new ApplicationError("not_found", "resource watch not found");
      finish(watch);
    },
    // Auth/team administration outside application.call must trigger this hook.
    revalidate(): void { for (const watch of [...watches.values()]) live(watch); },
    close(): void {
      stopped = true;
      clearInterval(timer);
      for (const watch of [...watches.values()]) finishQuietly(watch);
    },
  };
  const timer = setInterval(() => service.revalidate(), 1000);
  timer.unref();
  return service;
}
export type Resources = ReturnType<typeof createResources>;
