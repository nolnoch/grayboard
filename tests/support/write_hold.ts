// A test's hold on the server's write queue, on either backend (#807 P3 C11d): what `queueFor(srv.app.db).run(() => new
// Promise(r => release = r))` was on SQLite. The hold is a write body (repo.write) that waits on `release()`, so every
// write and post queued behind it waits its turn (store/queue.ts, docs/future/postgres-server.md D4). `started` is
// true once the body runs (at once on an idle queue; after the holder before it otherwise). `done` settles once the
// hold's (empty) transaction has committed.
import type { Tx } from "../../src/server/store/tx.ts";
import { repoOf, type RepoLike } from "./repo_sql.ts";

export type WriteHold = { readonly started: boolean; release(): void; done: Promise<void> };

export function holdWrites(on: RepoLike, onStart?: () => void): WriteHold {
  let release!: () => void, started = false;
  const gate = new Promise<void>((r) => { release = r; });
  const done = repoOf(on).write(async (_tx: Tx) => {
    started = true;
    onStart?.();
    await gate;
  });
  return { get started() { return started; }, release, done };
}
