// Kernel-released exclusive locks. A lock is a `node:sqlite` connection on the
// lock file holding `BEGIN EXCLUSIVE`: SQLite takes a POSIX fcntl (Windows
// LockFileEx) lock, which the kernel drops when the holder dies, so there is no
// pid file, no age and no takeover. A stopped holder keeps every waiter out
// until it resumes or dies. Neither Node nor Bun has flock.
//
// Erasable syntax only: the lock tests run this file directly under Node's
// type stripping.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class LockTimeout extends Error {
  readonly path: string;
  constructor(path: string) { super(`Timed out waiting for the lock ${path}`); this.path = path; }
}
export interface Lock { readonly path: string; release(): void }

const SQLITE_BUSY = 5;
// One connection per lock file per process: a second in-process caller waits
// like any other process instead of opening its own connection.
const held = new Set<string>();

export function tryAcquire(path: string): Lock | undefined {
  const file = resolve(path);
  if (held.has(file)) return undefined;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  held.add(file);
  let released = false;
  return {
    path: file,
    release() {
      if (released) return;
      released = true;
      try { db.exec("ROLLBACK"); } finally { db.close(); held.delete(file); }
    },
  };
}

// Polls tryAcquire every 100 ms until `deadlineMs` passes (LockTimeout) or
// `signal` aborts.
export async function acquire(path: string, options: { deadlineMs: number; signal?: AbortSignal }): Promise<Lock> {
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const lock = tryAcquire(path);
    if (lock) return lock;
    const left = deadline - Date.now();
    if (left <= 0) throw new LockTimeout(resolve(path));
    await sleep(Math.min(100, left), undefined, options.signal ? { signal: options.signal } : undefined);
  }
}
