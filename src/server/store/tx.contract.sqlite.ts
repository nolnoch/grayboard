// The SQLite store as a transaction-contract backend (tx.contract.ts), for tx.test.ts and queue.test.ts. Its `put` and
// `rows` run synchronously, so a body that only calls them is a synchronous body and its post runs now.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import { queueFor } from "./queue.ts";
import type { TxBackend, TxStore } from "./tx.contract.ts";
import { sqliteOf, type Tx } from "./tx.ts";

export const sqliteBackend: TxBackend = {
  postRunsNow: { idle: true, holder: true },
  async open(): Promise<TxStore> {
    const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    await repo.write(tx => { sqliteOf(tx).run("CREATE TABLE t (v TEXT)"); });
    // Repo.write's overloads tell a synchronous body from an async one at compile time; the contract's bodies are
    // either, by backend.
    const write = repo.write as <T, R>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => R) => Promise<Awaited<R>>;
    return {
      write: (fn, committed) => write(fn, committed),
      post: (fn, committed, what) => repo.post(fn, committed, what),
      read: repo.read,
      queue: queueFor(db),
      put: (tx, v) => { sqliteOf(tx).run("INSERT INTO t (v) VALUES (?)", [v]); },
      rows: r => sqliteOf(r).query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all().map(x => x.v),
      inTransaction: () => db.inTransaction,
      drain: () => repo.write(() => {}),
      close: () => repo.close(),
    };
  },
};
