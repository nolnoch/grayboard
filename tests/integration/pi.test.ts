// End-to-end with the real pi coding agent: the scenario in tests/support/pi.ts,
// on this checkout. binaries.e2e.ts runs it on a release's compiled binary.
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions } from "../support/mcp.ts";
import { piDelegationScenario, piMissingBinaryScenario, piReenabledScenario, piScenario, piStdinClosedScenario, piUnboundScenario } from "../support/pi.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-pi-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("pi: a DM wakes the session, which replies with dm_send; a digest rides along as context", () => piScenario(dir), 90_000);
test("pi unbound: reads work, writes are refused; bind and rebind through the extension's tool bind the session's one grayboard", () => piUnboundScenario(dir), 90_000);
test("pi: an enabled grayboard MCP entry makes the extension register nothing and say why", () => piReenabledScenario(dir), 60_000);
test("pi: no grayboard at the entry's command fails the extension load with the reason", () => piMissingBinaryScenario(dir), 60_000);
test("pi: a grayboard that stops reading makes the next write fail with EPIPE, which pi survives and reports", () => piStdinClosedScenario(dir), 60_000);
// Skipped: pi-subagents' tools silently don't register in the isolated
// agent-dir fixture (the extension loads and registers cleanly — instrumented
// — but the tools never reach the model's declared list), while they register
// in the live agent dir even in RPC mode. The investigation with the full
// evidence chain and the falsified hypotheses: #263. The scenario runs the
// moment that's solved; until then the translated native call is covered by
// the drift/unit tests (adapters/pi/delegation.test.ts).
test.skip("pi delegation: a delegate request translates to the native subagent call, a real child runs, the result returns in the thread (#243, blocked by #263)", () => piDelegationScenario(dir), 240_000);
