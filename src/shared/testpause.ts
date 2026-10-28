// A test seam for interleavings a test must force, not hope for (#182):
// BUS_TEST_PAUSE=<point> blocks this process at `point` until the file
// BUS_TEST_PAUSE_FILE exists, and says on stderr that the pause was hit, so a
// test can assert the overlap happened. Synchronous, because some points sit
// inside a SQLite transaction. Inert unless both are set. A test that fails
// before releasing the pause deletes its dir: the process exits then, or it
// would wait forever, never reading its closed stdin.
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export async function testPauseAsync(point: string, env = process.env): Promise<void> {
  const file = env.BUS_TEST_PAUSE_FILE;
  if (env.BUS_TEST_PAUSE !== point || !file) return;
  console.error(`[grayboard] test pause hit: ${point}`);
  while (!existsSync(file)) {
    if (!existsSync(dirname(file))) throw new Error(`test pause abandoned: ${point}`);
    await Bun.sleep(10);
  }
  console.error(`[grayboard] test pause released: ${point}`);
}

export function testPause(point: string, env = process.env): void {
  const file = env.BUS_TEST_PAUSE_FILE;
  if (env.BUS_TEST_PAUSE !== point || !file) return;
  console.error(`[grayboard] test pause hit: ${point}`);
  while (!existsSync(file)) {
    if (!existsSync(dirname(file))) {
      console.error(`[grayboard] test pause abandoned: ${point}`);
      process.exit(1);
    }
    Bun.sleepSync(10);
  }
  console.error(`[grayboard] test pause released: ${point}`);
}
