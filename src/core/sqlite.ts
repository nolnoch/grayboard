import { Database, SQLiteError } from "bun:sqlite";

const BUSY_TIMEOUT_MS = 5000;

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
export function openSqlite(path: string, pragmas: string, schema: (db: Database) => void): Database {
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (;;) {
      try {
        db.exec(pragmas);
        break;
      } catch (e) {
        if (!(e instanceof SQLiteError && e.code === "SQLITE_BUSY") || Date.now() > deadline) throw e;
        // Jittered, so two openers that collided don't collide again.
        Bun.sleepSync(5 + Math.random() * 20);
      }
    }
    db.transaction(() => schema(db)).immediate();
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
