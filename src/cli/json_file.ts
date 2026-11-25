// Atomic JSON config writes for the CLI (#439).
import { accessSync, closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, renameSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

/** The file a write to `path` lands in: its symlinks followed, a dangling one's target included. */
function writeTarget(path: string): string {
  let target = path;
  for (let hops = 0; hops < 40; hops++) {
    try { if (!lstatSync(target).isSymbolicLink()) return target; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw e;
    }
    target = resolve(dirname(target), readlinkSync(target));
  }
  throw new Error(`Can't write ${path}: too many levels of symbolic links`);
}

/**
 * Replace a JSON config file (a harness's, Claude Code's settings, a
 * project's .mcp.json) atomically (#439): a temp file beside it,
 * synced, then renamed over it, so a crash leaves the old file or the new
 * one, never a truncated one. A symlinked config, dangling or not, is
 * written at its target, keeping the link. An existing file keeps its mode
 * and, where this user may set them, its owner and group; one this user
 * can't write is refused, as an in-place write would be. A hard-linked
 * config is split from its other links.
 */
export function writeJsonFile(path: string, value: object): void {
  const target = writeTarget(path);
  let old: Stats | undefined;
  try { old = statSync(target); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (old) accessSync(target, constants.W_OK);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.grayboard-${process.pid}-${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", old ? old.mode & 0o7777 : 0o666);
  try {
    try {
      if (old) {
        try { fchownSync(fd, old.uid, old.gid); } catch {} // only root may give a file away
        fchmodSync(fd, old.mode & 0o7777); // after chown, which clears setuid bits; the umask may have narrowed it
      }
      writeSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, target);
  } catch (e) { rmSync(temp, { force: true }); throw e; }
}
