// A test fixture's writes through the server's write queue (#807 P1b-4f, docs/future/postgres-server.md D4). A server
// write runs inside a queued body, as a request's does (hosted `run`, an HTTP handler's `repo.write`), so a fixture
// that writes rows straight through the Repo, core's board/claim functions or an application handler wraps them here:
// `await seed(repo, () => …)`. An idle queue runs fn at once, inside the call, as the one transaction it was; a busy
// one (a timer's sweep, a request still in flight) makes it wait its turn rather than interleave with the holder.
// fn is synchronous, its throw the rejection. `on`: the server's Repo, or its connection when a test holds only that
// (core functions on `store.db`). Startup writes in production use `repo.writeNow`; nothing in a test does.
import type { Database } from "bun:sqlite";
import type { Repo, Sync } from "../../src/server/db.ts";
import { queueFor } from "../../src/server/store/queue.ts";

export function seed<T>(on: Pick<Repo, "write"> | Database, fn: () => Sync<T>): Promise<Awaited<T>> {
  if ("write" in on) return on.write(fn) as Promise<Awaited<T>>;
  const db = on;
  if (db.inTransaction) return Promise.reject(new Error("seed() inside an open transaction"));
  return queueFor(db).run(() => ({ value: db.transaction(fn).immediate() as T })).then(box => box.value) as Promise<Awaited<T>>;
}
