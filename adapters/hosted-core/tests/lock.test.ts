// #430 lock: a dead holder frees the lock within one poll, a stopped holder
// keeps every waiter out until it resumes, and Node and Bun processes
// exclude each other on one lock file.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, LockTimeout, tryAcquire } from "../src/lock.ts";

const HOLDER = join(import.meta.dir, "fixtures/lock-holder.ts");
let dir: string;
const children: Bun.Subprocess<"pipe", "pipe", "inherit">[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gb-lock-")); });
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGCONT"); child.kill("SIGKILL"); await child.exited; }
  rmSync(dir, { recursive: true, force: true });
});

// A child running the holder fixture, with its stdout as a line queue.
function spawn(runtime: "node" | "bun", path: string, mode: "hold" | "wait") {
  const child = Bun.spawn([runtime === "node" ? "node" : process.execPath, HOLDER, path, mode], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  children.push(child);
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffer = "";
  return {
    child,
    async line(): Promise<string> {
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); return line; }
        const { value, done } = await reader.read();
        if (done) throw new Error(`lock holder exited before a line (${buffer})`);
        buffer += decoder.decode(value);
      }
    },
  };
}

test.each(["node", "bun"] as const)("a SIGKILLed %s holder lets a waiter in within 200 ms", async runtime => {
  const path = join(dir, "kill.lock");
  const holder = spawn(runtime, path, "hold");
  expect(await holder.line()).toBe("held");
  expect(tryAcquire(path)).toBeUndefined();
  const waiting = acquire(path, { deadlineMs: 10_000 });
  const killed = performance.now();
  holder.child.kill("SIGKILL");
  const lock = await waiting;
  expect(performance.now() - killed).toBeLessThan(200);
  lock.release();
});

test("a SIGSTOPped holder keeps every waiter out for 40 s, then resumes and proceeds", async () => {
  const path = join(dir, "stop.lock");
  const holder = spawn("node", path, "hold");
  expect(await holder.line()).toBe("held");
  holder.child.kill("SIGSTOP");
  const started = performance.now();
  await expect(acquire(path, { deadlineMs: 40_000 })).rejects.toBeInstanceOf(LockTimeout);
  expect(performance.now() - started).toBeGreaterThanOrEqual(40_000);
  holder.child.kill("SIGCONT");
  holder.child.stdin.write("release\n"); holder.child.stdin.flush();
  expect(await holder.line()).toBe("released");
  const lock = await acquire(path, { deadlineMs: 5_000 });
  lock.release();
}, 60_000);

test.each(["node", "bun"] as const)("a %s waiter is excluded while this Bun process holds, and acquires on release", async runtime => {
  const path = join(dir, "contend.lock");
  const lock = tryAcquire(path)!;
  expect(lock).toBeDefined();
  const waiter = spawn(runtime, path, "wait");
  expect(await waiter.line()).toBe("busy");
  lock.release();
  expect(await waiter.line()).toBe("acquired");
  expect(await waiter.child.exited).toBe(0);
});

test("one connection per lock file per process; release is idempotent; abort stops a wait", async () => {
  const path = join(dir, "self.lock");
  const lock = tryAcquire(path)!;
  expect(tryAcquire(path)).toBeUndefined();
  const abort = new AbortController();
  const waiting = acquire(path, { deadlineMs: 10_000, signal: abort.signal });
  abort.abort();
  await expect(waiting).rejects.toThrow();
  lock.release(); lock.release();
  const again = tryAcquire(path);
  expect(again).toBeDefined();
  again!.release();
});
