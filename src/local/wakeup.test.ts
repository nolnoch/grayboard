import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanEnv } from "../../tests/support/env.ts";
import { until } from "../../tests/support/until.ts";
import { poke } from "./wakeup.ts";

const WAKEUP = resolve(import.meta.dir, "wakeup.ts");
// A listener in its own process, as a peer's is: it prints a line per wake.
const LISTENER = `
  import { listenForWakeup } from ${JSON.stringify(WAKEUP)};
  listenForWakeup("peer", () => { console.log("wake"); });
  setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const procs: Bun.Subprocess[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function listener(): Promise<{ dir: string; proc: Bun.Subprocess<"ignore", "pipe", "inherit"> }> {
  const dir = mkdtempSync(join(tmpdir(), "gbt-wakeup-"));
  dirs.push(dir);
  const proc = Bun.spawn([process.execPath, "-e", LISTENER], { env: cleanEnv({ BUS_SOCK_DIR: dir }), stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  procs.push(proc);
  await until(() => existsSync(join(dir, "sock.peer")), 10_000, "the listener's socket");
  return { dir, proc };
}

// #620: the listener ends each connection as it opens. When that beats this
// process's event loop to the connect, Bun rejects it with ECONNRESET, though
// the wake has run. Counted as a failure, it retried, and after the ladder
// reported a live peer as offline. A retry is a second wake, so one wake per
// poke proves none of them was miscounted, far more reliably than waiting for
// a whole ladder to lose.
test("#620: a live listener is reached by every poke, with one wake each", async () => {
  const { dir, proc } = await listener();
  let wakes = 0;
  void (async () => {
    for await (const chunk of proc.stdout) wakes += new TextDecoder().decode(chunk).split("\n").length - 1;
  })();
  const POKES = 200;
  for (let i = 0; i < POKES; i++) {
    expect(await poke("peer", dir)).toBe(true);
    // Spacing, not a wait for anything: with it the old code failed 8 of 8 runs, without it far less surely.
    await Bun.sleep(5);
  }
  await until(() => wakes >= POKES, 10_000, `${POKES} wakes, with ${wakes} so far`);
  expect(wakes).toBe(POKES);
});

test("#620: a stale socket file reads as offline, and a missing one", async () => {
  const { dir, proc } = await listener();
  expect(await poke("peer", dir)).toBe(true);
  proc.kill("SIGKILL");
  await proc.exited;
  expect(existsSync(join(dir, "sock.peer"))).toBe(true);
  expect(await poke("peer", dir)).toBe(false);
  expect(await poke("nobody", dir)).toBe(false);
});
