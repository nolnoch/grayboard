// A test fixture's writes through the server's write queue (#807 P1b-4f, docs/future/postgres-server.md D4). A server
// write runs inside a queued body, as a request's does (hosted `run`, an HTTP handler's `repo.write`), so a fixture
// that writes rows straight through the Repo, core's board/claim functions or an application handler wraps them here:
// `await seed(repo, tx => …)`, fn given the transaction's Tx (#807 P1c) on a Repo. An idle queue runs fn at once, inside the call, as the one transaction it was; a busy
// one (a timer's sweep, a request still in flight) makes it wait its turn rather than interleave with the holder.
// fn is synchronous, its throw the rejection, or (on a Repo) async, such as an application operation (#807 P1c-3). `on`: the server's Repo, or its connection when a test holds only that
// (core functions on `store.db`). A synchronous hook's write uses seedSync.
import type { Database } from "bun:sqlite";
import type { Repo, Sync } from "../../src/server/db.ts";
import { queueFor } from "../../src/server/store/queue.ts";
import type { Tx } from "../../src/server/store/tx.ts";

export function seed<T>(on: Pick<Repo, "write">, fn: (tx: Tx) => Promise<T>): Promise<Awaited<T>>;
export function seed<T>(on: Pick<Repo, "write">, fn: (tx: Tx) => Sync<T>): Promise<Awaited<T>>;
export function seed<T>(on: Database, fn: () => Sync<T>): Promise<Awaited<T>>;
export function seed<T>(on: Pick<Repo, "write"> | Database, fn: (tx: Tx) => T): Promise<Awaited<T>> {
  if ("write" in on) return on.write(fn as (tx: Tx) => Sync<T>) as Promise<Awaited<T>>;
  const db = on;
  if (db.inTransaction) return Promise.reject(new Error("seed() inside an open transaction"));
  return queueFor(db).run(() => ({ value: db.transaction(fn as () => T).immediate() as T })).then(box => box.value) as Promise<Awaited<T>>;
}

// seed() for a write a synchronous hook makes (a test's stand-in for a production function, called outside any queued
// body), which can't await: the Repo's post, which runs fn now on an idle queue. It throws when the post didn't run
// now (another body holds the queue), rather than letting the write land after the hook has returned.
export function seedSync(on: Pick<Repo, "post">, fn: (tx: Tx) => void): void {
  if (!on.post(fn, undefined, "seedSync")) throw new Error("seedSync: the write queue is held, so the write didn't run now");
}
