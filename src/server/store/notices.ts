// The hosted change notices (#399, #807 P3 A7g1, C11a), written once for both stores: db.ts's SQLite Repo and
// pg_repo.ts's Postgres one compose their hosted, oauth and identity groups through it. Each changed row tells the
// observers after its transaction commits; a rollback drops the notice with the change. `null`: any row may have changed
// (a grant or a user), so observers check every one.
//
// An observer with `read` gets each named row's facts too, read on the committing transaction's root Tx in a
// beforeCommit hook (#807 P3 A7g1): the row's state as it commits, not as it was when the op ran. The ids waiting for a
// read and the facts read are per observer and per transaction (keyed on transactionOf, #1510): keyed write bodies
// overlap on Postgres, and a hook that drained another transaction's pending ids would read that row on its own
// transaction (the other's uncommitted state invisible to it) and hand the other's notice stale facts. A notice without
// facts (a synchronous body's Tx, which refuses the hook, or a failed read) is the observer's to handle.
//
// Backend-neutral: it imports nothing at runtime but tx_base.ts. The backend says where a notice waits for the commit
// (`defer`): SQLite on its connection's commit frames (core/sqlite.ts afterCommit), Postgres on the Tx it's given. And
// whether a transaction may queue one at all (`refuse`, #1510): Postgres refuses a keyed body's (store/pg/tx.ts
// refuseKeyed, docs/future/postgres-server.md D4), since a notice's listeners run in the committing body's context
// while other keyed bodies run. A wrapped op is refused before it runs, so its statements are never sent. `refuse` gets
// the op's name (undefined for a bare `changed`), the refusal's text and the row the notice names (null: any): a reviewed
// keyed caller may opt in to one op's notices for its own root's row (store/pg/tx.ts refuseKeyedNotice, #1510 chunk 4's
// renew).
import { isThenable, transactionOf, type Tx } from "./tx_base.ts";

type Observer = {
  fn: (changed: string | null, facts?: unknown) => void;
  read?: (tx: Tx, id: string) => Promise<unknown>;
};
// One observer's reads in one transaction: the ids marked and not yet read, and the facts read for its notices.
type Reads = { pending: Set<string>; facts: Map<string, unknown> };

export type Notices = {
  // Tells the observers after `tx`'s transaction commits that `id` (or, null, any row) changed.
  changed(tx: Tx, id: string | null): void;
  // `fn`, telling the observers `null` once it has fulfilled. `op`: its name in a refusal.
  change<A extends [Tx, ...unknown[]], R>(fn: (...args: A) => R, op?: string): (...args: A) => R;
  // `fn`, reading the row `id` names's facts before its commit and telling the observers once it has fulfilled.
  marks<A extends [Tx, ...unknown[]], R>(fn: (...args: A) => R, id: (...args: A) => string, op?: string): (...args: A) => R;
  // RepoHosted.subscribe (db.ts).
  subscribe<F>(fn: (changed: string | null, facts?: F) => void, read?: (tx: Tx, id: string) => Promise<F>): () => void;
};

export function makeNotices(defer: (tx: Tx, effect: () => void) => void, refuse: (tx: Tx, op: string | undefined, label: string, id: string | null) => void = () => {}): Notices {
  const observers = new Set<Observer>();
  // Per transaction, per observer; dropped with the transaction's root Tx. The facts read are cleared after its notices flush.
  const byTxn = new WeakMap<object, Map<Observer, Reads>>();
  const readsOf = (txn: object, o: Observer): Reads => {
    let m = byTxn.get(txn);
    if (!m) byTxn.set(txn, m = new Map());
    let r = m.get(o);
    if (!r) m.set(o, r = { pending: new Set(), facts: new Map() });
    return r;
  };
  // Queues the notice; a wrapped op's was refused or allowed by name before it ran.
  const notify = (tx: Tx, id: string | null) => {
    const txn = transactionOf(tx);
    defer(tx, () => {
      const reads = txn && byTxn.get(txn);
      for (const o of observers) {
        try { o.fn(id, id === null ? undefined : reads?.get(o)?.facts.get(id)); } catch (error) { console.error("hosted invalidation failed", error); }
      }
    });
  };
  // Queues `id`'s facts read on `tx`'s transaction. Each read runs in its own savepoint and a failure is logged and
  // leaves no facts, so a failed read never fails the commit (on Postgres an unsavepointed failure would abort it).
  const readFacts = (tx: Tx, id: string) => {
    const txn = transactionOf(tx);
    if (!txn) return;
    for (const o of observers) {
      const read = o.read;
      if (!read) continue;
      const r = readsOf(txn, o);
      r.facts.delete(id);
      r.pending.add(id);
      try {
        tx.beforeCommit(o, async root => {
          const ids = [...r.pending];
          r.pending.clear();
          for (const each of ids) {
            try { r.facts.set(each, await root.savepoint(t => read(t, each))); }
            catch (error) { console.error("hosted facts read failed", error); }
          }
          // After this transaction's notices (registered before the hook ran): the facts served their flush.
          try { root.afterCommit(() => { for (const each of ids) r.facts.delete(each); }); }
          catch (error) { console.error("hosted facts clear failed", error); }
        });
      } catch { r.pending.delete(id); /* a synchronous body's Tx refuses the hook: its notices carry no facts */ }
    }
  };
  // An async op's notice waits for it to fulfil (#807 P3 A6c): one that rejects changed nothing, as a sync throw didn't.
  const then = <R>(value: R, notify: () => void): R => {
    if (!isThenable(value)) { notify(); return value; }
    return Promise.resolve(value).then(v => { notify(); return v; }) as R;
  };
  return {
    changed(tx, id) { refuse(tx, undefined, "a hosted change notice", id); notify(tx, id); },
    change: (fn, op) => (...args) => {
      refuse(args[0], op, `${op ?? (fn.name || "a write")} (it queues a change notice)`, null);
      return then(fn(...args), () => notify(args[0], null));
    },
    marks: (fn, id, op) => (...args) => {
      refuse(args[0], op, `${op ?? (fn.name || "a write")} (it queues a change notice)`, id(...args));
      return then(fn(...args), () => { const at = id(...args); readFacts(args[0], at); notify(args[0], at); });
    },
    subscribe(fn, read) {
      const o: Observer = { fn: fn as Observer["fn"], read };
      observers.add(o);
      return () => { observers.delete(o); };
    },
  };
}
