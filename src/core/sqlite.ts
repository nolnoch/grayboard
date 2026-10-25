import { Database, SQLiteError } from "bun:sqlite";

const BUSY_TIMEOUT_MS = 5000;

type CommitEffect = () => void | Promise<void>;
const effects = new WeakMap<Database, CommitEffect[][]>();

function flush(effect: CommitEffect): void {
  try { void Promise.resolve(effect()).catch(error => console.error("postcommit effect failed", error)); }
  catch (error) { console.error("postcommit effect failed", error); }
}

export function afterCommit(db: Database, effect: CommitEffect): void {
  const frame = effects.get(db)?.at(-1);
  if (frame) frame.push(effect);
  else {
    // Raw BEGIN/COMMIT is not a supported effect-bearing transaction boundary.
    if (db.inTransaction) throw new Error("postcommit effect requires db.transaction");
    flush(effect);
  }
}

function trackCommits(db: Database): void {
  const frames: CommitEffect[][] = [];
  effects.set(db, frames);
  const transaction = db.transaction.bind(db);
  db.transaction = <A extends any[], T>(fn: (...args: A) => T) => {
    const native = transaction(fn);
    const wrap = (invoke: (...args: A) => T) => (...args: A): T => {
      if (!frames.length && db.inTransaction) throw new Error("transaction requires a tracked outer boundary");
      const frame: CommitEffect[] = [];
      frames.push(frame);
      let value: T;
      try { value = invoke(...args); }
      catch (error) { frames.pop(); throw error; }
      frames.pop();
      // A released savepoint is not durable until its outer transaction commits.
      const parent = frames.at(-1);
      if (parent) parent.push(...frame);
      else for (const effect of frame) flush(effect);
      return value;
    };
    return Object.assign(wrap(native), {
      deferred: wrap(native.deferred), immediate: wrap(native.immediate), exclusive: wrap(native.exclusive),
    });
  };
}

// SQLITE_BUSY and its extended codes (_RECOVERY, _SNAPSHOT, _TIMEOUT): Bun's
// `code` names the extended code, the primary code is errno's low byte.
const isBusy = (e: unknown) => e instanceof SQLiteError && (e.errno & 0xff) === 5;

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
    step = "schema";
    db.transaction(() => schema(db)).immediate();
  } catch (e) {
    db.close();
    throw new Error(`opening ${path} (${step}, after ${retries} busy retries, ${Date.now() - start} ms): ${(e as Error).message}`, { cause: e });
  }
  if (retries) console.error(`[grayboard] opened ${path} after ${retries} busy retries (${Date.now() - start} ms)`);
  return db;
}
