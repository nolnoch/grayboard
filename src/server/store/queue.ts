import { AsyncLocalStorage } from "node:async_hooks";
import { queueBody, queueStarted, queueWaiting, queueWorldStop, type QueueSite } from "../metrics.ts";

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
// The site the calling code runs under (a body's, inside one), undefined outside every `atSite`. For tests that hold
// one site's bodies.
export function currentSite(): QueueSite | undefined { return sites.getStore(); }

// `keys`: a keyed body's, undefined for an exclusive one. `enter`: the queuing task's context, for a body that waits
// (AsyncLocalStorage.snapshot); one that starts at once already runs in it. `at`: performance.now() at run(), the
// start of its wait; `began`, at its start. The rest is a waiter's place in the scheduler's indexes: `seq` its arrival
// order, `prev`/`next` its neighbours in the arrival list, `heap` its slot in the ready heap (-1 when not in it).
type Waiter = {
  fn: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void;
  keys: ReadonlySet<string> | undefined; at: number; began: number; site: QueueSite; enter?: <R>(fn: () => R) => R;
  seq: number; prev?: Waiter; next?: Waiter; heap: number;
};

// A FIFO that only ever loses its head: an array and a read index, compacted once half of it is spent.
class Fifo {
  private items: Waiter[] = [];
  private h = 0;
  get size(): number { return this.items.length - this.h; }
  push(w: Waiter): void { this.items.push(w); }
  peek(): Waiter | undefined { return this.items[this.h]; }
  shift(): void {
    this.h++;
    if (this.h >= 32 && this.h * 2 >= this.items.length) { this.items = this.items.slice(this.h); this.h = 0; }
  }
}

// The Postgres store's write pool size and scheduler cap when nothing sets one (GRAYBOARD_DATABASE_WRITERS, config.ts;
// makePgTransactions, makePgRepo). Tests reach the production W through these defaults (#1520 L4); W = 1, the single
// queue, is passed explicitly as the A/B control.
export const DEFAULT_DATABASE_WRITERS = 4;

export class WriteQueue {
  private running = 0;
  private exclusive = false;
  private readonly keys = new Set<string>();
  // The waiters, indexed so that deciding what starts next never walks them (#1520 L3): the arrival list (`first` is
  // the oldest waiter), the exclusive waiters in arrival order, each key's waiters in arrival order (an entry exists
  // only while a waiter has that key), and the ready heap: keyed waiters at the head of every one of their keys' FIFOs
  // with none of their keys running, by arrival. Such a waiter stays ready until it starts: a key it has can start
  // running only through a body that heads that key's FIFO, and that is the waiter itself.
  private first: Waiter | undefined;
  private last: Waiter | undefined;
  private waitingCount = 0;
  private readonly exclusives = new Fifo();
  private readonly byKey = new Map<string, Fifo>();
  private readonly ready: Waiter[] = [];
  private seq = 0;
  // Exclusive bodies waiting or running, and since when that count has been above zero: the world-stop clock.
  private stopping = 0;
  private stopSince = 0;
  // Scheduler steps taken: one per start decision, per key looked at, per heap level moved. A test seam, so a backlog's
  // drain can be shown linear in its length without a clock.
  steps = 0;
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

  // Bodies waiting to start.
  get waiting(): number { return this.waitingCount; }

  // Nothing runs and nothing waits: what a test asserts once its bodies are done, so a leaked slot fails by name
  // (#1520 L2) rather than as a later hang.
  get idle(): boolean { return this.running === 0 && this.waitingCount === 0; }
  // Waiters queued under `site` (atSite): a test's positive "enqueued, not started" signal for one caller's body
  // among others a timer queues. A walk of the arrival list, so not for a hot path.
  waitingAt(site: QueueSite): number {
    let n = 0;
    for (let w = this.first; w; w = w.next) if (w.site === site) n++;
    return n;
  }

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
      const w: Waiter = { fn, resolve: resolve as (value: unknown) => void, reject, keys, at: performance.now(), began: 0, site: sites.getStore() ?? "other", seq: this.seq++, heap: -1 };
      if (keys === undefined && this.stopping++ === 0) this.stopSince = w.at;
      if (!this.pumping && this.free(w) && !this.behind(w)) {
        this.pumping = true;
        try { this.launch(w); } finally { this.pumping = false; }
        if (this.waitingCount) this.pump();
        return;
      }
      w.enter = AsyncLocalStorage.snapshot();
      queueWaiting(this.waitingCount);
      this.add(w);
      this.pump();
    });
  }

  // No running body conflicts with w, and a slot is free.
  private free(w: Waiter): boolean {
    if (this.running >= this.cap) return false;
    if (w.keys === undefined) return this.running === 0;
    if (this.exclusive) return false;
    for (const k of w.keys) { this.steps++; if (this.keys.has(k)) return false; }
    return true;
  }

  // Whether a waiter conflicts with w, which arrives now (so behind every waiter): any waiter does for an exclusive
  // body; for a keyed one, a waiting exclusive body or a waiter with one of its keys.
  private behind(w: Waiter): boolean {
    if (this.waitingCount === 0) return false;
    if (w.keys === undefined || this.exclusives.size > 0) return true;
    for (const k of w.keys) { this.steps++; if (this.byKey.has(k)) return true; }
    return false;
  }

  // Starts waiters until none may start. Synchronous bodies drain in this loop, so a backlog of N costs one stack frame,
  // not N (#925); a body that holds its slot past its return stays running and the loop goes on to the next.
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try { while (this.startNext()); } finally { this.pumping = false; }
  }

  // Starts the oldest waiter that may start now: no running body conflicts with it, and no waiter ahead of it does.
  // An exclusive waiter can start only as the oldest waiter, and every waiter behind one conflicts with it; so with an
  // exclusive oldest waiter that is the only candidate, and otherwise the candidate is the oldest ready keyed waiter,
  // provided it arrived before the first exclusive waiter. O(log N) in the waiters, O(1) for an exclusive head.
  private startNext(): boolean {
    this.steps++;
    if (this.running >= this.cap) return false;
    const head = this.first;
    if (head === undefined) return false;
    if (head.keys === undefined) {
      if (this.running > 0) return false;
      this.take(head);
      this.launch(head);
      return true;
    }
    if (this.exclusive) return false;
    const w = this.ready[0];
    if (w === undefined) return false;
    const ex = this.exclusives.peek();
    if (ex !== undefined && ex.seq < w.seq) return false;
    this.heapPop();
    this.take(w);
    this.launch(w);
    return true;
  }

  // Indexes a waiter that can't start now.
  private add(w: Waiter): void {
    w.prev = this.last;
    if (this.last) this.last.next = w; else this.first = w;
    this.last = w;
    this.waitingCount++;
    if (w.keys === undefined) { this.exclusives.push(w); return; }
    for (const k of w.keys) {
      this.steps++;
      let f = this.byKey.get(k);
      if (!f) this.byKey.set(k, f = new Fifo());
      f.push(w);
    }
    if (this.isReady(w)) this.heapPush(w);
  }

  // Unindexes a waiter that starts: it heads every FIFO it is in.
  private take(w: Waiter): void {
    if (w.prev) w.prev.next = w.next; else this.first = w.next;
    if (w.next) w.next.prev = w.prev; else this.last = w.prev;
    w.prev = w.next = undefined;
    this.waitingCount--;
    if (w.keys === undefined) { this.exclusives.shift(); return; }
    for (const k of w.keys) {
      this.steps++;
      const f = this.byKey.get(k)!;
      f.shift();
      if (f.size === 0) this.byKey.delete(k);
    }
  }

  // A keyed waiter heads each of its keys' FIFOs and none of its keys runs.
  private isReady(w: Waiter): boolean {
    for (const k of w.keys!) {
      this.steps++;
      if (this.byKey.get(k)?.peek() !== w || this.keys.has(k)) return false;
    }
    return true;
  }

  private heapPush(w: Waiter): void {
    const h = this.ready;
    let i = h.length;
    h.push(w);
    while (i > 0) {
      this.steps++;
      const p = (i - 1) >> 1;
      if (h[p]!.seq <= w.seq) break;
      h[i] = h[p]!; h[i]!.heap = i;
      i = p;
    }
    h[i] = w; w.heap = i;
  }

  private heapPop(): void {
    const h = this.ready, top = h[0]!, end = h.pop()!;
    top.heap = -1;
    if (end === top) return;
    let i = 0;
    for (;;) {
      this.steps++;
      const l = 2 * i + 1, r = l + 1;
      let m = i, mSeq = end.seq;
      if (l < h.length && h[l]!.seq < mSeq) { m = l; mSeq = h[l]!.seq; }
      if (r < h.length && h[r]!.seq < mSeq) m = r;
      if (m === i) break;
      h[i] = h[m]!; h[i]!.heap = i;
      i = m;
    }
    h[i] = end; end.heap = i;
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

  // Frees w's slot and keys. A freed key may make the waiter at the head of its FIFO ready.
  private release(w: Waiter, token: Token): void {
    token.live = false;
    this.running--;
    const end = performance.now();
    if (w.keys === undefined) {
      this.exclusive = false;
      // Credited at every exclusive release, not only when the count falls to zero: a saturated queue always has an
      // exclusive waiter, and a clock read only at zero would read nothing.
      queueWorldStop((end - this.stopSince) / 1000);
      this.stopSince = end;
      this.stopping--;
    } else {
      for (const k of w.keys) this.keys.delete(k);
      for (const k of w.keys) {
        this.steps++;
        const next = this.byKey.get(k)?.peek();
        if (next !== undefined && next.heap < 0 && this.isReady(next)) this.heapPush(next);
      }
    }
    queueBody(w.site, w.enter !== undefined, w.keys !== undefined, (w.began - w.at) / 1000, (end - w.began) / 1000);
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
