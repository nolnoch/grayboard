// #1169: a held test pause whose parent died (SIGKILL, which runs no cleanup) is abandoned, so a paused
// process can't spin forever after the test that held it is gone.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "../../tests/support/until.ts";

const pause = join(import.meta.dir, "testpause.ts");

test("a held pause is abandoned when its parent process is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-pause-"));
  try {
    const pidFile = join(dir, "child.pid");
    // The child loads testpause (which captures its parent then), records its pid, then holds at a sync pause no one
    // releases; its parent waits on it.
    const child = `const { testPause } = await import(${JSON.stringify(pause)}); await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); testPause("p");`;
    const parentScript = `const c = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { env: { ...process.env, BUS_TEST_PAUSE: "p", BUS_TEST_PAUSE_FILE: ${JSON.stringify(join(dir, "release"))} }, stderr: "inherit" }); await c.exited;`;
    const parent = Bun.spawn([process.execPath, "-e", parentScript], { stderr: "pipe" });
    await until(async () => await Bun.file(pidFile).exists(), 12_000, "the child holds its pause");
    const pid = Number(await Bun.file(pidFile).text());
    parent.kill("SIGKILL");
    await parent.exited;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until(() => !alive(), 12_000, "the orphaned child abandons its pause and exits");
    expect(await new Response(parent.stderr).text()).toContain("test pause abandoned: p");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
