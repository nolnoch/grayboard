// The backend-neutral half of the store's transaction handles (#807 D2, docs/future/postgres-server.md). The handle
// types, the liveness rules, the beforeCommit bookkeeping and the savepoint template live here once, so the SQLite
// store (tx.ts) and the Postgres store (pg/) give callers the same contract and `isTx`/`afterCommitOf` work on either.
// A backend supplies only its statements: how a savepoint frame opens, commits and rolls back, and where an
// afterCommit effect waits for the outermost commit.
//
// It imports nothing at runtime: a module under pg/ may import it, and pg/isolation.test.ts refuses any path from
// there to bun:sqlite (tx.ts reaches it through core/sqlite.ts).

declare const readBrand: unique symbol;
declare const txBrand: unique symbol;

export interface Read { readonly [readBrand]: true }

export interface Tx extends Read {
  readonly [txBrand]: true;
  // Runs after the outermost COMMIT resolves, in registration order; never on rollback (of the transaction, or of a
  // savepoint the effect was registered in). Its synchronous part runs before the write queue's next body (D4).
  // A savepoint its body didn't await (a D4 violation) is dropped with its effects when the transaction ends, though
  // the writes it sent before then commit (on Postgres, any it sent before COMMIT, which follows them on the connection).
  afterCommit(effect: () => void | Promise<void>): void;
  // A nested transaction: fn's writes and effects roll back alone when it throws or rejects. Awaitable on every
  // store, so callers are written once for Postgres. Only an async write() body's Tx has it: a synchronous body
  // (a post from the queue's holder, SQLite only) can't await one, so its Tx refuses.
  savepoint<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
  // A hook run after the outermost body fulfils and before its COMMIT, on that transaction's root Tx, with the queue
  // still held (#807 P3 A7g): reads there see the transaction's final state, its commit lands right after them, and
  // no other body runs between. Once per `key` per transaction, in registration order; a hook may register another,
  // which runs before COMMIT too. Registered in a savepoint, it's dropped when that savepoint rolls back (as an
  // afterCommit effect is) unless the key was already registered outside it. A rejection rolls the transaction back
  // and rejects the write with it. Postgres runs the same hooks before its COMMIT on the transaction's connection.
  // Only a write() body's Tx has it: a synchronous body's (a post from the queue's holder) commits as it returns, so
  // it refuses.
  beforeCommit(key: object, hook: (tx: Tx) => Promise<void>): void;
}

// A transaction's handle for a body; the caller closes it when the transaction settles.
export type RootTx = Tx & { close(): void; readonly hasBeforeCommit: boolean; runBeforeCommit(): Promise<void> };

type Effect = () => void | Promise<void>;

// An effect's synchronous part now, its error or rejection logged: what an afterCommit effect gets at the commit, and
// what afterCommitOf gives one outside any body.
export function flushEffect(effect: Effect): void {
  try { void Promise.resolve(effect()).catch((error) => console.error("postcommit effect failed", error)); }
  catch (error) { console.error("postcommit effect failed", error); }
}

// One open savepoint on the backend's connection. Each settles it once. commit() releases it, and throws (having
// rolled it back) when it can't: an inner frame still open, its transaction gone, a failed RELEASE. A backend whose
// statements are synchronous returns void, and the savepoint settles in the same turn as its body: SQLite's commit
// timing doesn't move. Postgres returns a promise, and must have sent its statement before it returns it (a Bun
// query is lazy until awaited, and an await sends it a microtask later, after anything already queued).
export type SavepointFrame = { commit(): void | Promise<void>; rollback(): void | Promise<void> };

export const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

// A store's read handle outside any transaction.
export abstract class BaseRead {}

// While a savepoint is open its Tx is the only live one: the parent's statements and effects would land inside the
// savepoint (and roll back with it), and a second savepoint beside it would release out of order. Both throw.
export abstract class BaseTx extends BaseRead {
  // `nests`: false for a synchronous body's Tx, whose savepoint and beforeCommit refuse. `root`: the transaction's
  // outermost Tx, which holds the beforeCommit hooks; a savepoint's Tx points at its parent's.
  constructor(readonly nests = true, root?: BaseTx) { super(); this.#root = root ?? this; }
  #live = true;
  #child: BaseTx | undefined;
  readonly #root: BaseTx;
  // On the root: the hooks by key, pending or run. On a savepoint's Tx: the keys it added, dropped if it rolls back.
  readonly #hooks = new Map<object, ((tx: Tx) => Promise<void>) | undefined>();
  readonly #added: object[] = [];

  // Opens a savepoint inside this Tx's transaction and the inner Tx that writes in it, sharing `root`. The frame
  // opens first: a refusal there leaves no child behind.
  protected abstract openSavepoint(root: BaseTx): { frame: SavepointFrame; tx: BaseTx };
  // Holds an effect for the outermost commit (a savepoint's frame keeps it until its RELEASE, D2).
  protected abstract deferEffect(effect: Effect): void;
  // Called as a savepoint's Tx settles, after its hook keys moved: `kept` only once its RELEASE succeeded. A backend
  // that keeps effects per Tx moves `inner`'s to this one here, or drops them; SQLite's live in core's frames.
  protected settled(_inner: BaseTx, _kept: boolean): void {}
  // The open savepoint's Tx, if any: a backend whose frame must check or end its descendants walks these.
  protected get openChild(): BaseTx | undefined { return this.#child; }

  // Closes its open savepoint's Tx too: a body that returned without awaiting one leaves nothing live behind it.
  close(): void { this.#live = false; this.#child?.close(); }
  get live(): boolean { return this.#live; }
  assertLive(): void {
    if (!this.#live) throw new Error("Tx used after its transaction settled: a body awaits only its own statements (#807 D4)");
    if (this.#child) throw new Error("Tx used while its savepoint is open: use the savepoint's Tx");
  }
  afterCommit(effect: Effect): void {
    this.assertLive();
    this.deferEffect(effect);
  }
  // fn is called synchronously and its result awaited, as before the split; only the frame's settle awaits
  // conditionally, so a synchronous backend's RELEASE or ROLLBACK TO lands in the same turn as fn's settle. The inner
  // Tx closes as fn settles, and this Tx stays blocked until the frame has: a task fn started and didn't await (D4)
  // can't write, register or open a savepoint on either while an async RELEASE or ROLLBACK TO is in flight.
  async savepoint<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    this.assertLive();
    if (!this.nests) throw new Error("savepoint in a synchronous write body: only an async write() body can await one");
    const { frame, tx: inner } = this.openSavepoint(this.#root);
    this.#child = inner;
    let value: T;
    try {
      value = await fn(inner as unknown as Tx);
    } catch (error) {
      inner.close();
      try {
        const r = frame.rollback();
        if (isThenable(r)) await r;
      } finally { this.#settle(inner, false); }
      throw error;
    }
    inner.close();
    try {
      const r = frame.commit();
      if (isThenable(r)) await r;
    } catch (error) { this.#settle(inner, false); throw error; }
    this.#settle(inner, true);
    return value;
  }
  // A settled savepoint's hook keys follow its frame (#1182 audit): kept, they move to this Tx (and so drop with an
  // enclosing rollback) only once its RELEASE succeeded; dropped, they leave the root. Keys a still-open descendant
  // (one the body didn't await, D4) registered drop either way, as its afterCommit effects do.
  #settle(inner: BaseTx, kept: boolean): void {
    const open: object[] = [];
    for (let t = inner.#child; t; t = t.#child) open.push(...t.#added);
    inner.close();
    this.#child = undefined;
    const hooks = this.#root.#hooks;
    for (const key of open) hooks.delete(key);
    if (!kept) for (const key of inner.#added) hooks.delete(key);
    else if (this !== this.#root) this.#added.push(...inner.#added);
    this.settled(inner, kept);
  }
  beforeCommit(key: object, hook: (tx: Tx) => Promise<void>): void {
    this.assertLive();
    if (!this.nests) throw new Error("beforeCommit in a synchronous write body: it commits as it returns");
    const hooks = this.#root.#hooks;
    if (hooks.has(key)) return;
    hooks.set(key, hook);
    if (this !== this.#root) this.#added.push(key);
  }
  get hasBeforeCommit(): boolean { return [...this.#hooks.values()].some(h => h !== undefined); }
  // The root's pending hooks, each once, until none is left: one a hook registers runs in the same pass. A savepoint
  // the body didn't await (D4) is dead from here, as at the transaction's end: its Tx (and any open inside it) closes,
  // so it registers nothing more, and the keys it added drop, as its afterCommit effects do. The root stays blocked
  // while that frame is open: a hook's statement could otherwise land inside the savepoint and roll back with it.
  async runBeforeCommit(): Promise<void> {
    for (let t = this.#child; t; t = t.#child) {
      t.#live = false;
      for (const key of t.#added) this.#hooks.delete(key);
    }
    for (;;) {
      const next = [...this.#hooks].find(([, h]) => h !== undefined);
      if (!next) return;
      const [key, hook] = next;
      this.#hooks.set(key, undefined);
      await hook!(this as unknown as Tx);
    }
  }
}

// Whether a handle is a transaction's: a function reached both inside a body and outside one writes on a `Tx` and
// posts its own write for a `Read` (writeAudit). A settled `Tx` still answers true; writing on it throws (D4).
export function isTx(h: Read): h is Tx { return h instanceof BaseTx; }

// An effect after the caller's commit: a `Tx`'s `afterCommit` (a settled one throws), or now for a `Read` (outside any
// body, nothing is pending). Lets a function reached both inside a body and outside one schedule its effect on the
// handle it holds. The refusal keeps the SQLite store's wording, which every store's handle check shares.
export function afterCommitOf(h: Read, effect: Effect): void {
  if (h instanceof BaseTx) { h.afterCommit(effect); return; }
  if (!(h instanceof BaseRead)) throw new Error("not a SQLite store handle");
  flushEffect(effect);
}
