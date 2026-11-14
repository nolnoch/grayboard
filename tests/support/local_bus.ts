// Helpers for tests that drive a local bus under a temp `dir` (#336): read
// its database, start a CLI against it, and drive a testPause point
// (src/shared/testpause.ts) its processes stop at.
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { localEnv } from "./env.ts";
import { CLI } from "./paths.ts";

/** Rows from the local bus at `dir`, opened read-only for the one query. */
export function busRows<T>(dir: string, sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

/** A `grayboard` CLI child against the bus at `dir`, its stderr collected as it runs. */
export function spawnCli(dir: string, args: string[], extra: Record<string, string>) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: localEnv(dir, undefined, extra), stdout: "pipe", stderr: "pipe" });
  let err = "";
  (async () => {
    for await (const chunk of p.stderr) err += new TextDecoder().decode(chunk);
  })();
  return { p, stderr: () => err };
}

/** The env that stops a child at testPause `point` until releasePause. */
export const pauseEnv = (dir: string, point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(dir, `go-${point}`) });
export const releasePause = (dir: string, point: string) => writeFileSync(join(dir, `go-${point}`), "");
