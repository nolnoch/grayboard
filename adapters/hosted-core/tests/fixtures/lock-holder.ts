// A lock holder for tests/lock.test.ts, run under Node or Bun:
// `<runtime> lock-holder.ts <path> hold|wait`. `hold` acquires, prints "held",
// and releases on a "release" line on stdin ("released"). `wait` prints "busy"
// if the lock is taken, then acquires and prints "acquired".
import { acquire, tryAcquire } from "../../src/lock.ts";

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("usage: lock-holder.ts <path> hold|wait");
if (mode === "wait") {
  const now = tryAcquire(path);
  if (now) { now.release(); process.stdout.write("free\n"); }
  else process.stdout.write("busy\n");
  const lock = await acquire(path, { deadlineMs: 30_000 });
  process.stdout.write("acquired\n");
  lock.release();
} else {
  const lock = await acquire(path, { deadlineMs: 30_000 });
  process.stdout.write("held\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (!chunk.includes("release")) return;
    lock.release();
    process.stdout.write("released\n");
    process.exit(0);
  });
}
