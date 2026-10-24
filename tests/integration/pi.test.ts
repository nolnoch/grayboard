// End-to-end with the real pi coding agent: the scenario in tests/support/pi.ts,
// on this checkout. binaries.e2e.ts runs it on a release's compiled binary.
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions } from "../support/mcp.ts";
import { piMissingBinaryScenario, piReenabledScenario, piScenario, piStdinClosedScenario, piUnboundScenario } from "../support/pi.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-pi-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("pi: a DM wakes the session, which replies with dm_send; a digest rides along as context", () => piScenario(dir), 90_000);
test("pi unbound: reads work, writes are refused; bind through the extension's tool binds the session's one grayboard", () => piUnboundScenario(dir), 90_000);
test("pi: an enabled grayboard MCP entry makes the extension register nothing and say why", () => piReenabledScenario(dir), 60_000);
test("pi: no grayboard at the entry's command fails the extension load with the reason", () => piMissingBinaryScenario(dir), 60_000);
test("pi: a grayboard that stops reading makes the next write fail with EPIPE, which pi survives and reports", () => piStdinClosedScenario(dir), 60_000);
