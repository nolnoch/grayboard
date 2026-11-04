// End-to-end with the real pi coding agent: the scenarios in tests/support/pi.ts,
// on this checkout. binaries.e2e.ts runs the local ones on a release's
// compiled binary. The hosted ones run the bundle the CLI embeds (server mode),
// starting with the spec's load smoke.
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions } from "../support/mcp.ts";
import { localAdapterExcludedScenario } from "../support/local_adapter_exclusions.ts";
import { startPi } from "../support/pi.ts";
import {
  piHostedCarryScenario, piHostedLoadSmoke, piHostedRefreshLogoutScenario, piHostedScenario, piHostedTwiceScenario,
  piLocalCarryScenario, piLocalRestartScenario, piLocalRestartShutdownScenario, piMissingBinaryScenario, piReenabledScenario, piRunnerScenario, piScenario, piStdinClosedScenario, piLocalStopsReadingScenario, piUnboundScenario,
} from "../support/pi.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-pi-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("pi: a DM wakes the session, which replies with dm_send; a digest rides along as context", () => piScenario(dir), 90_000);
test("pi unbound: the session acts as its ID; two binds and an unbind through the extension's tools move the session's one grayboard onto its second name", () => piUnboundScenario(dir), 90_000);
test("pi local: a killed grayboard restarts with its bound name; calls wait through all three backoffs, delivery resumes, another exit gives up, and /new resets the count (#559)", () => piLocalRestartScenario(dir), 90_000);
test("pi local: /new during a pending 5 s restart cancels the outgoing timer without a tool call and leaves only the new child's name hold (#559)", () => piLocalRestartShutdownScenario(dir), 60_000);
test("pi local: /new aborts a tool awaiting the pending restart instead of waiting out the backoff (#559)", () => piLocalRestartShutdownScenario(dir, true), 60_000);
test("pi local: /new and /fork use actual minted IDs; /resume restores the selected ordered holds rather than outgoing carry, including a remembered empty snapshot (#195)", () => piLocalCarryScenario(dir), 120_000);
for (const kind of ["keyed", "human", "runner"] as const) {
  test(`pi excluded local ${kind}: tools and /new retain excluded provenance (#195 audit 2)`, () =>
    localAdapterExcludedScenario(dir, kind, "mcp__grayboard__", (port, procs, identity, env) =>
      startPi(dir, port, procs, { identity, entry: { env: { BUS_PUSH: "off", ...env } } })), 90_000);
}
test("pi detached runner (#523 step 5): with no live parent it is its own session; with one it acts as the parent's child, writing as the parent's name with via, until a bind promotes it to its own session that receives, or the parent exits while it runs on", () => piRunnerScenario(dir), 180_000);
test("pi: an enabled grayboard MCP entry makes the extension register nothing and say why", () => piReenabledScenario(dir), 60_000);
test("pi: no grayboard at the entry's command fails the extension load with the reason", () => piMissingBinaryScenario(dir), 60_000);
test("pi: a grayboard that stops reading makes the next write fail with EPIPE, which pi survives and reports", () => piStdinClosedScenario(dir), 60_000);
test("pi local: a grayboard that stops reading while it holds the name is killed on EPIPE and gone before the replacement starts, which takes the name back; no stale process remains (#599)", () => piLocalStopsReadingScenario(dir), 120_000);
test("pi hosted load smoke: the embedded bundle loads under Node signed in; session_start sees pi's session id, the MCP client connects, the node:sqlite delivery lock is taken; no grayboard process runs and quit leaves nothing leased", () => piHostedLoadSmoke(dir), 60_000);
test("pi hosted: signed out it says how to sign in; /grayboard login walks the consent page; bind takes the lease; a DM is one turn whose receipt moves the cursor; files go out with dm_send and come in with attachment_get; no grayboard process runs", () => piHostedScenario(dir), 120_000);
test("pi hosted: /fork is a new root with its own lease that carries the name, /new carries it, /resume of the first session rebinds its remembered name", () => piHostedCarryScenario(dir), 120_000);
test("pi hosted: two processes with an expired token refresh it once; /grayboard logout in one pauses both", () => piHostedRefreshLogoutScenario(dir), 120_000);
test("pi hosted: the same session opened twice leaves one lease holder; the second takes over when the first quits", () => piHostedTwiceScenario(dir), 120_000);
