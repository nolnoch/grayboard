import { AsyncLocalStorage } from "node:async_hooks";

// The server's one write queue (docs/future/postgres-server.md D4): every top-level write transaction runs
// through it, so in-memory state a transaction reads changes only inside a queued transaction or its
// afterCommit, as it did when a synchronous transaction blocked the event loop.
//
// FIFO. An idle queue runs a body synchronously, inside run(), so a synchronous body is exactly the
// transaction it was before the queue existed: nothing interleaves before its commit, and its afterCommit
// effects flush before the next body starts. A body that returns a promise holds the queue until it settles.
//
// The holder is tracked through its async continuations (AsyncLocalStorage: a thread-local that follows the
// logical task across awaits), so `mine` is true for the holding body's own code, sync or after an await, and
// false for any other task that runs while the body is suspended. The store is a token per body, not the queue:
// an async afterCommit effect a body started carries the context on past the body's release, and must not pass
// for a later holder.
const holder = new AsyncLocalStorage<object>();

export class WriteQueue {
  private busy = false;
  private current: object = {};
  private readonly waiters: (() => void)[] = [];

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.busy) return this.start(fn);
    return new Promise<T>((resolve, reject) => { this.waiters.push(() => { this.start(fn).then(resolve, reject); }); });
  }

  // Whether a body holds the queue: true for the whole of a body's run, sync or async.
  get held(): boolean { return this.busy; }

  // Whether the calling code is the holding body, or runs inside it (its afterCommit flush, its committed callback).
  get mine(): boolean { return this.busy && holder.getStore() === this.current; }

  // Throws when another task holds the queue: a transaction opened now would interleave with the holder's (D4).
  // The server's connection runs it before every top-level transaction (guardTopLevel in core/sqlite.ts).
  assertFree(): void {
    if (this.busy && !this.mine) throw new Error("top-level transaction while another body holds the write queue: route it through write() (docs/future/postgres-server.md D4)");
  }

  private start<T>(fn: () => T | Promise<T>): Promise<T> {
    this.busy = true;
    const token = this.current = {};
    let out: T | Promise<T>;
    try { out = holder.run(token, fn); }
    catch (error) { this.release(); return Promise.reject(error); }
    if (out instanceof Promise) return out.finally(() => this.release());
    this.release();
    return Promise.resolve(out);
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.busy = false;
  }
}

// One queue per database connection, keyed on the handle (opaque here, so this file stays off bun:sqlite):
// the Repo and the hosted store open their transactions on the same connection.
const queues = new WeakMap<object, WriteQueue>();
export function queueFor(db: object): WriteQueue {
  let q = queues.get(db);
  if (!q) queues.set(db, q = new WriteQueue());
  return q;
}
