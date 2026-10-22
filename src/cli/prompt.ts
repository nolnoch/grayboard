import { readSync } from "node:fs";

// Prints q and reads one line from the terminal.
// Blocking reads from fd 0: Bun's stream stdin fails with EINVAL (kqueue) on macOS when stdin is /dev/tty, as in install.sh.
export function question(q: string): string {
  process.stdout.write(q);
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n = 0;
    try { n = readSync(0, buf, 0, 1, null); } catch (e) {
      // A non-blocking fd 0 would otherwise spin a core while the user types.
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") { Bun.sleepSync(20); continue; }
      throw e;
    }
    if (n === 0) throw new Error("stdin closed before an answer was read");
    // Decode the whole line at once so multi-byte UTF-8 characters survive.
    if (buf[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(buf[0]!);
  }
}
