import { Database, SQLiteError } from "bun:sqlite";

const BUSY_TIMEOUT_MS = 5000;

type CommitEffect = () => void | Promise<void>;
const effects = new WeakMap<Database, CommitEffect[][]>();

function flush(effect: CommitEffect): void {
  try { void Promise.resolve(effect()).catch(error => console.error("postcommit effect failed", error)); }
  catch (error) { console.error("postcommit effect failed", error); }
}

// A connection's writer (the server's write queue, #807 D4). Core stays off the server's queue: the server registers
// it on its own connection; local mode registers none. `holds`: whether the calling task is the writer, so the open
// transaction, if any, is its own (an async body's stays open across its awaits while other tasks run). `check`:
// throws unless it is, before a top-level transaction or a write opens.
export type Writer = { holds(): boolean; check(): void };
const writers = new WeakMap<Database, Writer>();
export function ownWriter(db: Database, writer: Writer): void { writers.set(db, writer); }

// Whether the caller is inside the connection's open transaction: one is open and, on a connection with a writer,
// the caller holds it. Another task, while the holder awaits, is outside it: it reads committed state on the reader
// and its post-commit effects run now.
export function ownsTx(db: Database): boolean {
  return db.inTransaction && (writers.get(db)?.holds() ?? true);
}

// Called after each outermost commit on the connection, before its effects (#996: the server's committed auth
// generation). One per connection; it must not throw.
const commitHooks = new WeakMap<Database, () => void>();
export function onCommit(db: Database, hook: () => void): void { commitHooks.set(db, hook); }

export function afterCommit(db: Database, effect: CommitEffect): void {
  if (!ownsTx(db)) { flush(effect); return; }
  const frame = effects.get(db)?.at(-1);
  // Raw BEGIN/COMMIT is not a supported effect-bearing transaction boundary.
  if (!frame) throw new Error("postcommit effect requires db.transaction");
  frame.push(effect);
}

// A top-level boundary's checks: the writer's, then that no transaction is open (one opened by raw BEGIN, or by a
// task the writer check passed for: a holder's suspended body).
function topLevel(db: Database): void {
  writers.get(db)?.check();
  if (db.inTransaction) throw new Error("transaction requires a tracked outer boundary");
}

function trackCommits(db: Database): void {
  const frames: CommitEffect[][] = [];
  effects.set(db, frames);
  const transaction = db.transaction.bind(db);
  db.transaction = <A extends any[], T>(fn: (...args: A) => T) => {
    const native = transaction(fn);
    const wrap = (invoke: (...args: A) => T) => (...args: A): T => {
      if (!(frames.length && ownsTx(db))) topLevel(db);
      const frame: CommitEffect[] = [];
      frames.push(frame);
      let value: T;
      try { value = invoke(...args); }
      catch (error) { frames.pop(); throw error; }
      frames.pop();
      // A released savepoint is not durable until its outer transaction commits.
      const parent = frames.at(-1);
      if (parent) parent.push(...frame);
      else { commitHooks.get(db)?.(); for (const effect of frame) flush(effect); }
      return value;
    };
    return Object.assign(wrap(native), {
      deferred: wrap(native.deferred), immediate: wrap(native.immediate), exclusive: wrap(native.exclusive),
    });
  };
}

// A top-level IMMEDIATE transaction whose body awaits (#807 P1b-4e): db.transaction can't hold one open across an
// await, so the boundary is explicit. Its post-commit effects collect as db.transaction's do (nested atomic bodies
// are savepoints inside it) and run after commit() succeeds; rollback() drops them. Each settles it once.
export type Boundary = { commit(): void; rollback(): void };
export function openBoundary(db: Database): Boundary {
  const frames = effects.get(db);
  if (!frames) throw new Error("openBoundary: the connection doesn't track commits (openSqlite)");
  topLevel(db);
  db.run("BEGIN IMMEDIATE");
  const frame: CommitEffect[] = [];
  frames.push(frame);
  let open = true;
  const pop = () => { open = false; const i = frames.lastIndexOf(frame); if (i >= 0) frames.splice(i, 1); };
  return {
    commit() {
      if (!open) throw new Error("boundary already settled");
      try { db.run("COMMIT"); } catch (error) {
        pop();
        if (db.inTransaction) db.run("ROLLBACK");
        throw error;
      }
      pop();
      commitHooks.get(db)?.();
      for (const effect of frame) flush(effect);
    },
    rollback() {
      if (!open) return;
      pop();
      if (db.inTransaction) db.run("ROLLBACK");
    },
  };
}

// Compiled statements per connection that `db.query` keeps, least recently used evicted. Bun's default
// of 20 thrashed: the tree has ~250 prepare sites, and recompiling a statement on every call was ~15%
// of server CPU at 1000 sessions (#912). The cap is Bun's static, read on every `query` call. The cast
// is for older `@types/bun` (opencode-v2 pins one) that don't declare the static.
export const STATEMENT_CACHE_SIZE = 512;
(Database as unknown as { MAX_QUERY_CACHE_SIZE: number }).MAX_QUERY_CACHE_SIZE = STATEMENT_CACHE_SIZE;

// `db.prepare(sql)` returns the connection's cached statement for `sql` (Bun's `db.query`), so call
// sites keep writing `prepare`. Sharing one statement between call sites is safe here because every
// use runs to completion synchronously (`all`/`get`/`run`) and none sets per-statement modes
// (`as`, `safeIntegers`, `iterate`, `finalize`). `prepare(sql, params)` binds, so it stays uncached.
// `db.run(sql, ...params)` compiles natively per call too, so with bindings it runs the cached statement,
// unless `sql` has a second statement: a statement compiles only its first, where `db.run` runs them all.
// (A `;` inside a string literal also takes the uncached path, which is only slower.) Without bindings
// `db.run` is `exec`: schema scripts, run once.
const multiStatement = /;\s*\S/;
function cacheStatements(db: Database): void {
  const prepare = db.prepare.bind(db), run = db.run.bind(db);
  db.prepare = ((sql: string, params?: unknown) => params === undefined ? db.query(sql) : prepare(sql, params as never)) as Database["prepare"];
  db.run = ((sql: string, ...params: unknown[]) =>
    params.length && !multiStatement.test(sql) ? db.query(sql).run(...(params as never[])) : run(sql, ...(params as never[]))) as Database["run"];
}

// The server's read-only second connection (#807 P1b-3, docs/future/postgres-server.md). After this, a
// statement `db.query`/`db.prepare` returns picks its connection on each call, not when it was made: the
// writer inside a transaction (a body reads its own uncommitted writes), the reader outside one. So a
// statement hoisted at construction follows the transaction state of each use. Some SQL always runs on
// the writer: writes (an autocommit write is its own transaction there; a write the pattern misses reaches
// the read-only reader and throws SQLITE_READONLY, never a silent misroute) and connection-local SQL:
// `temp.` objects (the auth generation counter), pragmas (data_version is per connection) and transaction
// control. A connection with a writer (ownWriter) refuses a write from any other task, and routes reads by whether the
// caller is inside the open transaction, not whether one is open: another task, while an async body awaits, reads
// committed state.
const writes = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i, ddl = /^\s*(CREATE|DROP|ALTER)\b/i;
const writerOnly = /\btemp\.|^\s*(PRAGMA|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
type Routed = Pick<ReturnType<Database["query"]>, "get" | "all" | "run" | "values">;
export function routeReads(db: Database, reader: Database): void {
  // Looked up per call, not bound once: a spy on Database.prototype.query (tests count SQL) sees routed calls.
  const proto = Object.getPrototypeOf(db) as Database;
  const onWriter = (sql: string) => proto.query.call(db, sql), onReader = (sql: string) => reader.query(sql);
  // Routers by SQL, least recently used evicted at the statement cache's cap: dynamic SQL (IN lists) varies.
  const routers = new Map<string, Routed>();
  db.query = ((sql: string) => {
    let r = routers.get(sql);
    if (r) { routers.delete(sql); routers.set(sql, r); return r; }
    if (writes.test(sql) && !ddl.test(sql)) {
      // A write runs only as the writer (D4): the check precedes each use, not the statement's making.
      const w = onWriter(sql), check = () => writers.get(db)?.check();
      r = {
        get: (...a: never[]) => { check(); return w.get(...a); }, all: (...a: never[]) => { check(); return w.all(...a); },
        run: (...a: never[]) => { check(); return w.run(...a); }, values: (...a: never[]) => { check(); return w.values(...a); },
      } as Routed;
    } else if (writerOnly.test(sql) || writes.test(sql)) r = onWriter(sql);
    else {
      const pick = () => (ownsTx(db) ? onWriter : onReader)(sql);
      r = {
        get: (...a: never[]) => pick().get(...a), all: (...a: never[]) => pick().all(...a),
        run: (...a: never[]) => pick().run(...a), values: (...a: never[]) => pick().values(...a),
      } as Routed;
    }
    routers.set(sql, r);
    if (routers.size > STATEMENT_CACHE_SIZE) routers.delete(routers.keys().next().value!);
    return r;
  }) as Database["query"];
  // db.run without bindings is exec and never reaches db.query: its writes are checked here, and db.exec's (Bun's
  // prototype exec is its native run, past both instance overrides). Schema SQL is exempt (startup's, and a test's DDL).
  const run = db.run.bind(db);
  db.run = ((sql: string, ...params: unknown[]) => {
    if (writes.test(sql) && !ddl.test(sql)) writers.get(db)?.check();
    return run(sql, ...(params as never[]));
  }) as Database["run"];
  db.exec = db.run;
  const close = db.close.bind(db);
  // Reader first: only the last connection to close checkpoints the WAL into the file, and a read-only one can't.
  db.close = ((throwOnError?: boolean) => { try { reader.close(); } finally { close(throwOnError); } }) as Database["close"];
}

// Opens the read-only second connection on a file a writer already opened (WAL set, schema made).
export function openReader(path: string): Database {
  const reader = new Database(path, { readonly: true });
  reader.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return reader;
}

// SQLITE_BUSY and its extended codes (_RECOVERY, _SNAPSHOT, _TIMEOUT): Bun's
// `code` names the extended code, the primary code is errno's low byte.
const isBusy = (e: unknown) => e instanceof SQLiteError && (e.errno & 0xff) === 5;

// `PRAGMA journal_mode = WAL` doesn't throw when it can't switch: it returns
// the mode the file stayed in (#178). Rollback-journal mode still works, but
// readers then block a writer, so an open that asked for WAL and didn't get it
// says so. An in-memory or temporary database reports `memory` or `delete`
// and has no other process to share with.
export function journalModeWarning(path: string, pragmas: string, actual: string | undefined): string | undefined {
  const wanted = /journal_mode\s*=\s*(\w+)/i.exec(pragmas)?.[1]?.toLowerCase();
  if (!wanted || path === "" || path === ":memory:") return undefined;
  if (actual?.toLowerCase() === wanted) return undefined;
  return `${path} is in journal_mode ${actual ?? "unknown"}, not ${wanted}: SQLite couldn't switch it (a filesystem without shared-memory locking, such as a network mount, can't use WAL)`;
}

// Opens a SQLite file that other processes may be opening at the same moment
// (a session and the Slack bridge starting together, sessions after an
// upgrade), creating or upgrading its schema (#170):
// - busy_timeout comes first, so statements wait out another opener's lock;
// - `pragmas` run outside any transaction, where journal_mode and
//   foreign_keys must (inside one they're refused or silently ignored), and
//   are retried on SQLITE_BUSY: switching a new file to WAL needs an
//   exclusive lock, and when two openers each hold a shared one SQLite skips
//   the busy handler (it would deadlock) and fails at once;
// - `schema` runs in one BEGIN IMMEDIATE transaction, so a guarded ALTER's
//   column check and the ALTER itself are atomic across processes: a second
//   opener waits, then sees the column.
// Each step can wait up to the busy timeout, so a contended open can take
// about twice it. A failure names the file, the step and the wait; an open
// that needed retries says so on stderr.
export function openSqlite(path: string, pragmas: string, schema: (db: Database) => void): Database {
  const db = new Database(path);
  trackCommits(db);
  cacheStatements(db);
  const start = Date.now();
  let retries = 0;
  let step = "pragmas";
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    for (;;) {
      try {
        db.exec(pragmas);
        break;
      } catch (e) {
        if (!isBusy(e) || Date.now() - start > BUSY_TIMEOUT_MS) throw e;
        retries++;
        // Jittered, so two openers that collided don't collide again.
        Bun.sleepSync(5 + Math.random() * 20);
      }
    }
    const warning = journalModeWarning(path, pragmas, db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode);
    if (warning) console.error(`[grayboard] ${warning}`);
    step = "schema";
    db.transaction(() => schema(db)).immediate();
  } catch (e) {
    db.close();
    throw new Error(`opening ${path} (${step}, after ${retries} busy retries, ${Date.now() - start} ms): ${(e as Error).message}`, { cause: e });
  }
  if (retries) console.error(`[grayboard] opened ${path} after ${retries} busy retries (${Date.now() - start} ms)`);
  return db;
}

// Free pages returned to the filesystem per retention run: 64 MiB at the default
// 4 KiB page, so one run is bounded; a larger backlog drains over later runs (#137).
export const RECLAIM_PAGES_PER_RUN = 16_384;

export type Reclaimed = { reclaimed: number; remaining: number; incremental: boolean };

// Returns up to `maxPages` (> 0) free pages to the filesystem with
// `PRAGMA incremental_vacuum`. auto_vacuum=INCREMENTAL is set only when a file
// is created, before its first page write; a file created without it
// reclaims nothing until a one-time VACUUM converts it. Both modes (#137, #148).
export function reclaimFreePages(db: Database, maxPages: number): Reclaimed {
  // incremental_vacuum(0) would mean every free page: never unbounded.
  const pages = Math.floor(maxPages);
  if (!(pages > 0)) throw new RangeError(`reclaimFreePages needs a positive page count, not ${maxPages}`);
  const free = () => db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
  const incremental = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()!.auto_vacuum === 2;
  const before = free();
  if (incremental && before > 0) db.run(`PRAGMA incremental_vacuum(${pages})`);
  const remaining = free();
  return { reclaimed: before - remaining, remaining, incremental };
}

// A retention run's log of what `reclaimFreePages` did: the pages reclaimed,
// and, while a file that can't reclaim has free pages, the fix (`guide`, the
// doc section that gives it).
export function logReclaimed(r: Reclaimed, guide: string): void {
  if (r.reclaimed) console.error(`[grayboard] retention: reclaimed ${r.reclaimed} free database pages (${r.remaining} left)`);
  if (!r.incremental && r.remaining) {
    console.error(`[grayboard] retention: the database has ${r.remaining} free pages it can't reclaim (auto_vacuum is not INCREMENTAL); a one-time VACUUM converts it (${guide})`);
  }
}
