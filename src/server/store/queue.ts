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
// logical task across awaits, and into timers, listeners and promises the task starts), so `mine` is true for the
// holding body and any task it started while holding, until it releases, and false for every other task. A timer
// the body starts can therefore open a transaction while the body is suspended: the guard doesn't catch that. The
// store is a token per body, not the queue: an async afterCommit effect a body started carries the context on
// past the body's release, and must not pass for a later holder.
const holder = new AsyncLocalStorage<object>();

type Waiter = { fn: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

export class WriteQueue {
  private busy = false;
  private current: object = {};
  private readonly waiters: Waiter[] = [];

  run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w = { fn, resolve, reject } as Waiter;
      if (this.busy) { this.waiters.push(w); return; }
      this.busy = true;
      if (!this.start(w)) this.release();
    });
  }

  // Whether a body holds the queue: true for the whole of a body's run, sync or async.
  get held(): boolean { return this.busy; }

  // Whether the calling code is the holding body or a task it started while holding (its afterCommit flush, its
  // committed callback, a timer or un-awaited promise it began).
  get mine(): boolean { return this.busy && holder.getStore() === this.current; }

  // Throws when another task holds the queue: a transaction opened now would interleave with the holder's (D4).
  // The server's connection runs it before every top-level transaction (guardTopLevel in core/sqlite.ts).
  assertFree(): void {
    if (this.busy && !this.mine) throw new Error("top-level transaction while another body holds the write queue: route it through write() (docs/future/postgres-server.md D4)");
  }

  // Runs one body. True when it returned a thenable (any `then`, not only a Promise): it holds the queue until that
  // settles, and its settling releases it. False when it finished synchronously, returning or throwing.
  private start(w: Waiter): boolean {
    const token = this.current = {};
    let out: unknown;
    try { out = holder.run(token, w.fn); }
    catch (error) { w.reject(error); return false; }
    if (!isThenable(out)) { w.resolve(out); return false; }
    Promise.resolve(out).finally(() => this.release()).then(w.resolve, w.reject);
    return true;
  }

  // Hands the queue on. Synchronous bodies drain in this loop, so a backlog of N costs one stack frame, not N (#925);
  // it stops at a body that holds the queue past its return.
  private release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (!next) { this.busy = false; return; }
      if (this.start(next)) return;
    }
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
