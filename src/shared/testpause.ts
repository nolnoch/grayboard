// A test seam for interleavings a test must force, not hope for (#182):
// BUS_TEST_PAUSE=<point> blocks this process at `point` until the file
// BUS_TEST_PAUSE_FILE exists, and says on stderr that the pause was hit, so a
// test can assert the overlap happened. Synchronous, because some points sit
// inside a SQLite transaction. Inert unless both are set.
import { existsSync } from "node:fs";

export function testPause(point: string, env = process.env): void {
  const file = env.BUS_TEST_PAUSE_FILE;
  if (env.BUS_TEST_PAUSE !== point || !file) return;
  console.error(`[grayboard] test pause hit: ${point}`);
  while (!existsSync(file)) Bun.sleepSync(10);
  console.error(`[grayboard] test pause released: ${point}`);
}
