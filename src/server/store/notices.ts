// The hosted change notices (#399, #807 P3 A7g1, C11a), written once for both stores: db.ts's SQLite Repo and
// pg_repo.ts's Postgres one compose their hosted, oauth and identity groups through it. Each changed row tells the
// observers after its transaction commits; a rollback drops the notice with the change. `null`: any row may have changed
// (a grant or a user), so observers check every one.
//
// An observer with `read` gets each named row's facts too, read on the committing transaction's root Tx in a
// beforeCommit hook (#807 P3 A7g1): the row's state as it commits, not as it was when the op ran. `pending` and `facts`
// are per observer, not per transaction, because the write queue runs one body at a time and holds itself from the hook
// through COMMIT to the notices' flush: no other transaction's marks or notices land in between. A mark deletes its
// id's facts first, so a notice never sees an earlier transaction's; a notice without facts (a synchronous body's Tx,
// which refuses the hook, or a failed read) is the observer's to handle.
//
// Backend-neutral: it imports nothing at runtime but tx_base.ts. The backend says where a notice waits for the commit
// (`defer`): SQLite on its connection's commit frames (core/sqlite.ts afterCommit), Postgres on the Tx it's given.
import { isThenable, type Tx } from "./tx_base.ts";

type Observer = {
  fn: (changed: string | null, facts?: unknown) => void;
  read?: (tx: Tx, id: string) => Promise<unknown>;
  pending: Set<string>;
  facts: Map<string, unknown>;
};

export type Notices = {
  // Tells the observers after `tx`'s transaction commits that `id` (or, null, any row) changed.
  changed(tx: Tx, id: string | null): void;
  // `fn`, telling the observers `null` once it has fulfilled.
  change<A extends [Tx, ...unknown[]], R>(fn: (...args: A) => R): (...args: A) => R;
  // `fn`, reading the row `id` names's facts before its commit and telling the observers once it has fulfilled.
  marks<A extends [Tx, ...unknown[]], R>(fn: (...args: A) => R, id: (...args: A) => string): (...args: A) => R;
  // RepoHosted.subscribe (db.ts).
  subscribe<F>(fn: (changed: string | null, facts?: F) => void, read?: (tx: Tx, id: string) => Promise<F>): () => void;
};

export function makeNotices(defer: (tx: Tx, effect: () => void) => void): Notices {
  const observers = new Set<Observer>();
  const changed = (tx: Tx, id: string | null) => defer(tx, () => {
    for (const o of observers) {
      try { o.fn(id, id === null ? undefined : o.facts.get(id)); } catch (error) { console.error("hosted invalidation failed", error); }
    }
  });
  // Queues `id`'s facts read on `tx`'s transaction. Each read runs in its own savepoint and a failure is logged and
  // leaves no facts, so a failed read never fails the commit (on Postgres an unsavepointed failure would abort it).
  const readFacts = (tx: Tx, id: string) => {
    for (const o of observers) {
      const read = o.read;
      if (!read) continue;
      o.facts.delete(id);
      o.pending.add(id);
      try {
        tx.beforeCommit(o, async root => {
          const ids = [...o.pending];
          o.pending.clear();
          for (const each of ids) {
            try { o.facts.set(each, await root.savepoint(t => read(t, each))); }
            catch (error) { console.error("hosted facts read failed", error); }
          }
          // After this transaction's notices (registered before the hook ran): the facts served their flush.
          try { root.afterCommit(() => { for (const each of ids) o.facts.delete(each); }); }
          catch (error) { console.error("hosted facts clear failed", error); }
        });
      } catch { o.pending.delete(id); /* a synchronous body's Tx refuses the hook: its notices carry no facts */ }
    }
  };
  // An async op's notice waits for it to fulfil (#807 P3 A6c): one that rejects changed nothing, as a sync throw didn't.
  const then = <R>(value: R, notify: () => void): R => {
    if (!isThenable(value)) { notify(); return value; }
    return Promise.resolve(value).then(v => { notify(); return v; }) as R;
  };
  return {
    changed,
    change: fn => (...args) => then(fn(...args), () => changed(args[0], null)),
    marks: (fn, id) => (...args) => then(fn(...args), () => { const at = id(...args); readFacts(args[0], at); changed(args[0], at); }),
    subscribe(fn, read) {
      const o: Observer = { fn: fn as Observer["fn"], read, pending: new Set(), facts: new Map() };
      observers.add(o);
      return () => { observers.delete(o); };
    },
  };
}
