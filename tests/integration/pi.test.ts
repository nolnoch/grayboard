// End-to-end with the real pi coding agent: the scenario in tests/support/pi.ts,
// on this checkout. binaries.e2e.ts runs it on a release's compiled binary.
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions } from "../support/mcp.ts";
import { piScenario } from "../support/pi.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-pi-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("pi: a DM wakes the session, which replies with dm_send; a digest rides along as context", () => piScenario(dir), 90_000);
