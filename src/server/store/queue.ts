import { AsyncLocalStorage } from "node:async_hooks";
import { queueBody, queueStarted, queueWaiting, type QueueSite } from "../metrics.ts";

// The server's write scheduler (docs/future/postgres-server.md D4): every top-level write transaction runs through
// it, so in-memory state a transaction reads changes only inside a scheduled transaction or its afterCommit, as it did
// when a synchronous transaction blocked the event loop.
//
// A body is exclusive (run) or keyed (runKeyed, #1510). An exclusive body conflicts with every other body; a keyed one
// only with exclusive bodies and with keyed bodies that share one of its keys. A body starts when fewer than `cap`
// bodies run, none of them conflicts with it, and no body that arrived before it and still waits does: conflicting
// bodies keep arrival order, so an exclusive body is never starved by keyed ones arriving behind it, and same-key
// bodies stay FIFO. With only exclusive bodies (SQLite always; Postgres until a caller is keyed) this is the one FIFO
// queue it always was, at any cap.
//
// A body that may start when it arrives runs synchronously, inside run(), so a synchronous body is exactly the
// transaction it was before the queue existed: nothing interleaves before its commit, and its afterCommit effects flush
// before the next body starts. A body that returns a thenable holds its slot until it settles.
//
// Each body runs under a token of its own (AsyncLocalStorage: a thread-local that follows the logical task across
// awaits, and into timers, listeners and promises the task starts), so `mine` is true for that body and any task it
// started while running, until it releases, and false for every other task, another running body's included. A timer
// the body starts can therefore open a transaction while the body is suspended: the guard doesn't catch that. The store
// is a token per body, not the scheduler: an async afterCommit effect a body started carries the context on past the
// body's release, and must not pass for a later body.
//
// A body that waits runs in the context of the task that queued it, as one that starts at once does (#1408): the
// scheduler takes a snapshot of every AsyncLocalStorage at run() and starts the waiter inside it, with its own token set
// on top. Without that, a waiter started from a release inherits the releasing body's context (another request's
// hosted exchange, its auth pin, its request origin) and judges its work as that request's.
type Token = { readonly q: WriteQueue; live: boolean };
const holder = new AsyncLocalStorage<Token>();

// The site a body is counted under in the queue's metrics (metrics.ts): the innermost `atSite` around the run() call,
// else `other`. A literal from code, so the label set stays fixed. A body runs inside its enqueuer's context, so a write
// it starts without a site of its own counts under the body's.
const sites = new AsyncLocalStorage<QueueSite>();
export function atSite<T>(site: QueueSite, fn: () => T): T { return sites.run(site, fn); }

// `keys`: a keyed body's, undefined for an exclusive one. `enter`: the queuing task's context, for a body that waits
// (AsyncLocalStorage.snapshot); one that starts at once already runs in it. `at`: performance.now() at run(), the
// start of its wait; `began`, at its start.
type Waiter = {
  fn: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void;
  keys: ReadonlySet<string> | undefined; at: number; began: number; site: QueueSite; enter?: <R>(fn: () => R) => R;
};

export class WriteQueue {
  private running = 0;
  private exclusive = false;
  private readonly keys = new Set<string>();
  private readonly waiters: Waiter[] = [];
  // A start loop is on the stack: a body that arrives from a synchronous body it starts waits for the loop to reach it.
  private pumping = false;

  // `cap`: at most this many bodies run at once (the Postgres store's write pool size, W). 1 is the single queue.
  constructor(readonly cap = 1) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`write scheduler cap must be a whole number from 1, not ${cap}`);
  }

  // An exclusive body.
  run<T>(fn: () => T | PromiseLike<T>): Promise<T> { return this.enqueue(undefined, fn); }

  // A keyed body: it overlaps running bodies that are keyed and share none of `keys` (at least one, each a non-empty
  // string; by convention `root:<session id>`).
  runKeyed<T>(keys: readonly string[], fn: () => T | PromiseLike<T>): Promise<T> {
    if (!Array.isArray(keys) || keys.length === 0 || keys.some(k => typeof k !== "string" || k === "")) {
      return Promise.reject(new Error("runKeyed needs at least one key, each a non-empty string"));
    }
    return this.enqueue(new Set(keys), fn);
  }

  // Whether any body runs: true for the whole of a body's run, sync or async.
  get held(): boolean { return this.running > 0; }

  // Whether the calling code is a running body or a task it started while running (its afterCommit flush, its
  // committed callback, a timer or un-awaited promise it began).
  get mine(): boolean { return this.token !== undefined; }

  // The calling body's token while it runs (what `mine` tests), else undefined: an identity a store keys the body's own
  // state on (store/pg/tx.ts's open transaction), so two bodies running at once each see their own.
  get token(): object | undefined {
    const t = holder.getStore();
    return t !== undefined && t.q === this && t.live ? t : undefined;
  }

  // Throws unless the caller is a running body (#807 P1b-4e): a write or top-level transaction from any other task
  // would interleave with a body's (D4), and one on an idle queue would let the next body's interleave with it. The
  // server's SQLite connection runs it before every top-level transaction and every write (ownWriter in core/sqlite.ts).
  assertMine(): void {
    if (this.mine) return;
    if (this.held) throw new Error("write or top-level transaction while another body holds the write queue: route it through write() (docs/future/postgres-server.md D4)");
    throw new Error("write outside the write queue: route it through write() (docs/future/postgres-server.md D4)");
  }

  private enqueue<T>(keys: ReadonlySet<string> | undefined, fn: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = { fn, resolve: resolve as (value: unknown) => void, reject, keys, at: performance.now(), began: 0, site: sites.getStore() ?? "other" };
      if (!this.pumping && this.free(w) && !this.behind(w, this.waiters.length)) {
        this.pumping = true;
        try { this.launch(w); } finally { this.pumping = false; }
        if (this.waiters.length) this.pump();
        return;
      }
      w.enter = AsyncLocalStorage.snapshot();
      queueWaiting(this.waiters.length);
      this.waiters.push(w);
      this.pump();
    });
  }

  // No running body conflicts with w, and a slot is free.
  private free(w: Waiter): boolean {
    if (this.running >= this.cap) return false;
    if (w.keys === undefined) return this.running === 0;
    if (this.exclusive) return false;
    for (const k of w.keys) if (this.keys.has(k)) return false;
    return true;
  }

  // Whether one of the first `n` waiters conflicts with w.
  private behind(w: Waiter, n: number): boolean {
    if (n === 0) return false;
    if (w.keys === undefined) return true;
    for (let i = 0; i < n; i++) {
      const e = this.waiters[i]!;
      if (e.keys === undefined) return true;
      for (const k of w.keys) if (e.keys.has(k)) return true;
    }
    return false;
  }

  // Starts waiters until none may start. Synchronous bodies drain in this loop, so a backlog of N costs one stack frame,
  // not N (#925); a body that holds its slot past its return stays running and the loop goes on to the next.
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try { while (this.startNext()); } finally { this.pumping = false; }
  }

  // Starts the first waiter that may start now: none that runs and none ahead of it in the queue conflicts with it. One
  // pass, gathering the keys of keyed waiters that stay; it stops at the first exclusive waiter that can't start, since
  // every waiter behind it conflicts with it. With an exclusive head on an idle scheduler this is O(1).
  private startNext(): boolean {
    if (this.running >= this.cap) return false;
    let blocked: Set<string> | undefined;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      const ahead = w.keys === undefined ? i > 0 : blocked !== undefined && [...w.keys].some(k => blocked!.has(k));
      if (!ahead && this.free(w)) {
        if (i === 0) this.waiters.shift(); else this.waiters.splice(i, 1);
        this.launch(w);
        return true;
      }
      if (w.keys === undefined) return false;
      blocked ??= new Set();
      for (const k of w.keys) blocked.add(k);
    }
    return false;
  }

  // Runs one body under a fresh token. A body that returned a thenable (any callable `then`, not only a Promise) holds
  // its slot until that settles, and its settling releases it and starts what may follow. One that finished
  // synchronously, returning or throwing, is released here. `then` is read once and called here, inside the body's
  // context and try: a lazy thenable's work runs as the body, and a throwing `then` getter rejects this caller rather
  // than escaping with the slot held. Timed into the queue's metrics: a waiter's start is a clock read, a body that
  // starts at once uses run()'s; the release is one more.
  private launch(w: Waiter): void {
    const token: Token = { q: this, live: true };
    this.running++;
    if (w.keys === undefined) this.exclusive = true; else for (const k of w.keys) this.keys.add(k);
    w.began = w.enter ? performance.now() : w.at;
    queueStarted();
    let held: Promise<unknown> | undefined, out: unknown;
    const body = () => holder.run(token, () => {
      out = w.fn();
      const then = out !== null && (typeof out === "object" || typeof out === "function") ? (out as { then?: unknown }).then : undefined;
      if (typeof then === "function") held = new Promise((resolve, reject) => then.call(out, resolve, reject));
    });
    try {
      if (w.enter) w.enter(body); else body();
    } catch (error) { this.release(w, token); w.reject(error); return; }
    if (!held) { this.release(w, token); w.resolve(out); return; }
    held.finally(() => { this.release(w, token); this.pump(); }).then(w.resolve, w.reject);
  }

  private release(w: Waiter, token: Token): void {
    token.live = false;
    this.running--;
    if (w.keys === undefined) this.exclusive = false; else for (const k of w.keys) this.keys.delete(k);
    queueBody(w.site, w.enter !== undefined, w.keys !== undefined, (w.began - w.at) / 1000, (performance.now() - w.began) / 1000);
  }
}

// One scheduler per SQLite connection, keyed on the handle (opaque here, so this file stays off bun:sqlite): the Repo
// and the hosted store open their transactions on the same connection. One connection runs one body at a time, so the
// cap is 1 and every body is exclusive (db.ts's writeKeyed forwards to write). The Postgres store makes its own
// (store/pg/tx.ts), capped at its write pool's size.
const queues = new WeakMap<object, WriteQueue>();
export function queueFor(db: object): WriteQueue {
  let q = queues.get(db);
  if (!q) queues.set(db, q = new WriteQueue());
  return q;
}
