import { spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function hostedPause<T>(point: string, start: () => Promise<T>, overlap: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gb-hosted-pause-")), file = join(dir, "release");
  const oldPoint = process.env.BUS_TEST_PAUSE, oldFile = process.env.BUS_TEST_PAUSE_FILE;
  let hit!: () => void;
  const reached = new Promise<void>(resolve => { hit = resolve; });
  const log = spyOn(console, "error").mockImplementation((message: unknown) => {
    if (message === `[grayboard] test pause hit: ${point}`) hit();
  });
  process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = file;
  const operation = start();
  void operation.catch(() => {});
  try {
    await Promise.race([reached, operation.then(() => { throw new Error("operation missed pause"); })]);
    await overlap();
    writeFileSync(file, "release");
    return await operation;
  } finally {
    writeFileSync(file, "release"); await operation.catch(() => {});
    if (oldPoint === undefined) delete process.env.BUS_TEST_PAUSE; else process.env.BUS_TEST_PAUSE = oldPoint;
    if (oldFile === undefined) delete process.env.BUS_TEST_PAUSE_FILE; else process.env.BUS_TEST_PAUSE_FILE = oldFile;
    log.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
}
