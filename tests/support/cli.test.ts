import { expect, test } from "bun:test";
import { runCli } from "./cli.ts";

test("a timed-out run is killed with its children, which would otherwise hold its pipes", async () => {
  const start = Date.now();
  await expect(runCli(["-c", "sleep 30 & wait"], { bin: "/bin/bash", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 500 })).rejects.toThrow("killed after 500 ms");
  expect(Date.now() - start).toBeLessThan(3_000);
});
