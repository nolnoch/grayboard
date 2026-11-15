// The server's one write queue (docs/future/postgres-server.md D4): every top-level write transaction runs
// through it, so in-memory state a transaction reads changes only inside a queued transaction or its
// afterCommit, as it did when a synchronous transaction blocked the event loop.
//
// FIFO. An idle queue runs a body synchronously, inside run(), so a synchronous body is exactly the
// transaction it was before the queue existed: nothing interleaves before its commit, and its afterCommit
// effects flush before the next body starts. A body that returns a promise holds the queue until it settles.
export class WriteQueue {
  private busy = false;
  private readonly waiters: (() => void)[] = [];

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.busy) return this.start(fn);
    return new Promise<T>((resolve, reject) => { this.waiters.push(() => { this.start(fn).then(resolve, reject); }); });
  }

  // Whether a body holds the queue: true for the whole of a body's run, sync or async.
  get held(): boolean { return this.busy; }

  private start<T>(fn: () => T | Promise<T>): Promise<T> {
    this.busy = true;
    let out: T | Promise<T>;
    try { out = fn(); }
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
