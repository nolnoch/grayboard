import { expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";

test("probe deadline and reconnect backoff use separate clocks, not server arrival gaps", async () => {
  const result = await runCli([join(ROOT, "tests/support/reconnect_clock.ts")], {
    bin: process.execPath,
    env: cleanEnv(),
    timeoutMs: 4000,
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({
    correct: { deadlines: [200, 200], delays: [1000], fetches: 2, arrivalGap: 1199 },
    detected: ["missing-abort", "immediate-retry"],
  });
});
