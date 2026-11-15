// Processes that open one database at the same moment (a session and the
// Slack bridge starting together, several sessions after an upgrade) all
// succeed, on a new file and on one from before a guarded ALTER (#170).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/bridge/store.ts";
import { openLocalDb } from "../../src/local/open.ts";
import { openDatabase } from "../../src/server/db.ts";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";
import { until } from "../support/until.ts";

const CHILD = join(ROOT, "tests", "support", "open_db.ts");
const CHILDREN = 4;
const TRIALS = 5;
type Kind = "local" | "bridge" | "server";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-concurrent-open-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// CHILDREN processes open `path` at once; every one must succeed.
async function openTogether(kind: Kind, path: string, trial: number): Promise<void> {
  const go = join(dir, `go-${trial}`);
  const procs = Array.from({ length: CHILDREN }, () =>
    Bun.spawn([process.execPath, CHILD, kind, path, go], { env: cleanEnv(), stdout: "ignore", stderr: "pipe" }),
  );
  const ready = (p: (typeof procs)[number]) => existsSync(`${go}.ready-${p.pid}`);
  // Longer than the child's own 10 s go-file deadline; a child that dies first, or a timeout,
  // fails with every child's stderr rather than only the condition (#178).
  try {
    await until(() => {
      const dead = procs.find((p) => p.exitCode !== null && !ready(p));
      if (dead) throw new Error(`child ${dead.pid} exited ${dead.exitCode} before writing its ready file`);
      return procs.every(ready) || undefined;
    }, 15_000, `${kind} trial ${trial}: every child's ready file`);
  } catch (e) {
    for (const p of procs) p.kill();
    const errs = await Promise.all(procs.map(async (p) => `child ${p.pid} stderr:\n${await new Response(p.stderr).text()}`));
    throw new Error(`${(e as Error).message}\n${errs.join("\n")}`);
  }
  writeFileSync(go, "");
  const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
  const failed = results.filter((r) => r.code !== 0);
  expect(failed.map((r) => r.err.split("\n").find((l) => /^(\w*Error|error)\b/.test(l)) ?? r.err), `${kind} trial ${trial}`).toEqual([]);
}

// A database as a release before a guarded ALTER wrote it: HEAD's schema
// less the columns those ALTERs add.
const dropped: Record<Kind, [string, string][]> = {
  local: [["messages", "pending"], ["posts", "expires_at"], ["outbox", "wake"], ["handles", "status"]],
  bridge: [["outbox", "progress"]],
  server: [["messages", "pending"], ["posts", "expires_at"], ["outbox", "wake"]],
};
const create: Record<Kind, (path: string) => void> = {
  local: (p) => openLocalDb(p).db.close(),
  bridge: (p) => new Store(p).db.close(),
  server: (p) => openDatabase(p, { blobDir: join(dir, "blobs") }).db.close(),
};
function oldDb(kind: Kind, path: string): void {
  create[kind](path);
  const db = new Database(path);
  for (const [table, col] of dropped[kind]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  db.close();
}

for (const kind of ["local", "bridge", "server"] as const) {
  test(`${kind}: ${CHILDREN} processes open a new database at once`, async () => {
    for (let t = 0; t < TRIALS; t++) await openTogether(kind, join(dir, `new-${t}.db`), t);
  }, 60_000);

  test(`${kind}: ${CHILDREN} processes open a database from before a guarded ALTER at once`, async () => {
    for (let t = 0; t < TRIALS; t++) {
      const path = join(dir, `old-${t}.db`);
      oldDb(kind, path);
      await openTogether(kind, path, t);
      const db = new Database(path, { readonly: true });
      for (const [table, col] of dropped[kind]) {
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        expect(cols, `${kind} ${table}`).toContain(col);
      }
      db.close();
    }
  }, 60_000);
}
