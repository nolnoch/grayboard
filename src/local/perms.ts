// Local mode's files hold every DM, post and attachment on the machine, so
// only their owner may read them (#82): the bus directory 0700, the database
// and its -wal/-shm 0600. Local mode is one trusted user per machine; this
// keeps other accounts on a shared host out.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// The default bus directory's name (~/.claude-bus).
export const BUS_DIR_NAME = ".claude-bus";

// Clears group and other bits from `path`, if it has any. A file another
// account owns can't be changed: say so rather than fail the open.
function tighten(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (!(mode & 0o077)) return;
  try { chmodSync(path, mode & 0o700); }
  catch (e) { console.error(`[grayboard] ${path} is readable by other users (mode ${mode.toString(8)}) and couldn't be tightened: ${(e as Error).message}`); }
}

/**
 * Creates `dir` (and any missing parents) 0700. An existing directory is
 * tightened only when it's named for the bus: BUS_DB_PATH and BUS_SOCK_DIR
 * may name a directory the user shares with other things, such as $HOME.
 */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (basename(dir) === BUS_DIR_NAME) tighten(dir);
}

/**
 * Before SQLite opens `path`: creates it empty (a valid empty database) 0600
 * if it's missing, and tightens it and any -wal/-shm. SQLite gives a new -wal
 * and -shm the database file's mode, so they follow it.
 */
export function privateDbFiles(path: string): void {
  try { writeFileSync(path, "", { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) tighten(f);
}
