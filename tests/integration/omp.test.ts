// End-to-end with the real omp coding agent: the hosted scenarios in
// tests/support/omp.ts, on the bundle the CLI embeds (server mode, #280), and
// the local adapter (#523).
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompHostedCarryScenario, ompHostedLoadSmoke, ompHostedManyChildrenScenario, ompHostedNestedScenario, ompHostedRefreshLogoutScenario, ompHostedScenario, ompHostedStaticScenario, ompHostedTaskScenario, ompLocalAcpClientGrayboardScenario, ompLocalAcpScenario, ompLocalCarryScenario, ompLocalHandshakeFailScenario, ompLocalInitFailScenario, ompLocalPinScenario, ompLocalRefusalScenario, ompLocalResumeScenario, ompLocalRestartAbortScenario, ompLocalStopsReadingScenario, ompLocalSwitchExhaustScenario, ompLocalTaskScenario } from "../support/omp.ts";
import { installLocal, startLocalOmp } from "../support/omp.ts";
import { localAdapterExcludedScenario } from "../support/local_adapter_exclusions.ts";
import { closeSessions } from "../support/mcp.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-omp-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("omp hosted load smoke: the embedded bundle loads under omp signed in; its host import resolves to omp's agent dir, session_start sees omp's session id, the MCP client connects, the delivery lock is taken; no grayboard process runs and quit leaves nothing leased", () => ompHostedLoadSmoke(dir), 60_000);

test("omp hosted: signed out it says how to sign in; /grayboard login walks the consent page; bind takes the lease; a DM wakes main once; attachments go out with dm_send and come in with attachment_get; quit releases", () => ompHostedScenario(dir), 120_000);

test("omp hosted task run: two subagents' calls are attributed to children registered under main; a peer's DM mid-run reaches main only; both children end when their runs do", () => ompHostedTaskScenario(dir), 120_000);

test("omp hosted nested task run: a subagent's own subagent registers under main with its parent as via; its parent registers at its own first call; each write is its own child's; each ends with its run (#439)", () => ompHostedNestedScenario(dir), 120_000);

test("omp hosted /fork, /new and /resume in one runtime: each replaces the session; the name carries to the fork and the new session, and the resumed first session rebinds it; the outgoing session ends each time", () => ompHostedCarryScenario(dir), 120_000);

test("omp hosted: 130 sequential subagents stay under the 128-child cap; each registers at its first call and ends with its run", () => ompHostedManyChildrenScenario(dir), 900_000);

test("omp hosted static (#1243): a launcher's run token binds the service's BUS_IDENTITY name and receives; a subagent registers as a child under the svc_ root, writes as its name and ends with its run (#1303); status names the static run; login and logout refuse; a revoked credential ends the run with no sign-in offer, browser or token request", () => ompHostedStaticScenario(dir), 120_000);

test("omp hosted: two processes on one agent dir share one refresh; /grayboard logout in one pauses both", () => ompHostedRefreshLogoutScenario(dir), 120_000);

test("omp local task run: each subagent's DM goes as main's name with its child ID as via, its bind is refused, and it's audited as main's child, which ends with main; a peer's DM while two subagents run reaches main once and no subagent (#523, #526)", () => ompLocalTaskScenario(dir), 120_000);

test("omp local: an enabled MCP server omp would run beside the adapter's grayboard (named grayboard in a repo's .omp/mcp.json, stdio or HTTP, or under another name running `grayboard mcp`, directly or behind `sh -c`) makes the adapter refuse: a notice (saying a .omp/mcp.json pin survives disabling), no tools, no grayboard process (#523)", () => ompLocalRefusalScenario(dir), 120_000);

test("omp local: a repo's disabled .omp/mcp.json grayboard entry pins the name an omp session with no BUS_IDENTITY suggests and binds (#523)", () => ompLocalPinScenario(dir), 120_000);

test("omp local: a push-started bind refreshes instructions; a killed child restarts with its names; /new retains the child but rotates the bus root under its actual conversation ID; a local:// attachment resolves (#523, #552, #195)", () => ompLocalCarryScenario(dir), 120_000);

test("omp local: /new, /fork and /resume rotate actual conversation roots without restarting the child; selected ordered holds and empty snapshots beat outgoing carry; crash restart uses the selected ID (#195)", () => ompLocalResumeScenario(dir), 120_000);

test("omp local: a tool call waiting out a restart's 5 s backoff ends at its abort, not at the backoff's end, and the bind it carried never runs (#559)", () => ompLocalRestartAbortScenario(dir), 60_000);
test("omp local: a grayboard process that never answers initialize is killed at the deadline and restarted; after the last restart a call fails with the deadline reason (#559)", () => ompLocalInitFailScenario(dir, "deadline"), 90_000);
test("omp local: a grayboard process that answers initialize with an error is restarted at once; after the last restart a call fails with that error (#1142)", () => ompLocalInitFailScenario(dir, "refused"), 90_000);
for (const phase of ["start", "switch"] as const) {
  test(`omp local: a grayboard process whose ${phase} handshake is answered with an error is restarted at once, and the replacement serves the selected session; nothing fails the turn or the switch (#1142, #1145)`, () => ompLocalHandshakeFailScenario(dir, phase), 90_000);
}
test("omp local: every new_session switch handshake refused counts toward the restart budget, so the fourth gives up and says so (#1148)", () => ompLocalSwitchExhaustScenario(dir), 90_000);
test("omp local: a grayboard that stops reading while it holds the name is killed on EPIPE before the replacement starts, which takes the name back; no stale process remains (#580)", () => ompLocalStopsReadingScenario(dir), 120_000);
test("omp local: one that also ignores SIGTERM is SIGKILLed, logged, and gone before the replacement starts (#604)", () => ompLocalStopsReadingScenario(dir, { ignoreSigterm: true }), 120_000);
for (const kind of ["keyed", "human", "runner"] as const) {
  test(`omp excluded local ${kind}: tools and /new retain excluded provenance (#195 audit 2)`, () =>
    localAdapterExcludedScenario(dir, kind, "mcp__grayboard_", (port, procs, identity, env) => {
      installLocal(dir, port);
      return startLocalOmp(dir, dir, procs, identity, env);
    }), 90_000);
}

test("omp local, ACP: of two top-level sessions in one omp process, the first runs grayboard and the second is refused; while both live, no subagent of either gets grayboard tools, so none acts as the first session's names (#523, #470)", () => ompLocalAcpScenario(dir), 120_000);
test("omp local, ACP: a tools-only (BUS_PUSH=off) grayboard among the client's declared mcpServers is reported once and not refused: by its tools under another name, by its process when named grayboard, whose tools omp drops; the adapter's own tools are never reported; started first, it leaves the adapter's child its name (#1140, #1228)", () => ompLocalAcpClientGrayboardScenario(dir), 120_000);
// Fails today: a push-on grayboard the client declares, started first, takes
// omp-local and the adapter's child runs unbound. When #1381 is fixed this
// passes, so test.failing goes red: promote it to a plain test.
test.failing("omp local, ACP: a push-on grayboard among the client's declared mcpServers, started first, leaves the adapter's child its name (#1381)", () => ompLocalAcpClientGrayboardScenario(dir, { push: true }), 120_000);
