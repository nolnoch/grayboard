// End-to-end with the real omp coding agent: the hosted scenarios in
// tests/support/omp.ts, on the bundle the CLI embeds (server mode, #280), and
// the local adapter (#523).
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompHostedCarryScenario, ompHostedLoadSmoke, ompHostedManyChildrenScenario, ompHostedRefreshLogoutScenario, ompHostedScenario, ompHostedTaskScenario, ompLocalAcpScenario, ompLocalCarryScenario, ompLocalPinScenario, ompLocalRefusalScenario, ompLocalTaskScenario } from "../support/omp.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-omp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("omp hosted load smoke: the embedded bundle loads under omp signed in; its host import resolves to omp's agent dir, session_start sees omp's session id, the MCP client connects, the delivery lock is taken; no grayboard process runs and quit leaves nothing leased", () => ompHostedLoadSmoke(dir), 60_000);

test("omp hosted: signed out it says how to sign in; /grayboard login walks the consent page; bind takes the lease; a DM wakes main once; attachments go out with dm_send and come in with attachment_get; quit releases", () => ompHostedScenario(dir), 120_000);

test("omp hosted task run: two subagents' calls are attributed to children registered under main; a peer's DM mid-run reaches main only; both children end when their runs do", () => ompHostedTaskScenario(dir), 120_000);

test("omp hosted /fork, /new and /resume in one runtime: each replaces the session; the name carries to the fork and the new session, and the resumed first session rebinds it; the outgoing session ends each time", () => ompHostedCarryScenario(dir), 120_000);

test("omp hosted: 130 sequential subagents stay under the 128-child cap; each registers at its first call and ends with its run", () => ompHostedManyChildrenScenario(dir), 900_000);

test("omp hosted: two processes on one agent dir share one refresh; /grayboard logout in one pauses both", () => ompHostedRefreshLogoutScenario(dir), 120_000);

test("omp local task run: each subagent's DM goes as main's name with its child ID as via, its bind is refused, and it's audited as main's child, which ends with main; a peer's DM while two subagents run reaches main once and no subagent (#523, #526)", () => ompLocalTaskScenario(dir), 120_000);

test("omp local: an enabled MCP server omp would run beside the adapter's grayboard (named grayboard in a repo's .omp/mcp.json, stdio or HTTP, or under another name running `grayboard mcp`, directly or behind `sh -c`) makes the adapter refuse: a notice (saying a .omp/mcp.json pin survives disabling), no tools, no grayboard process (#523)", () => ompLocalRefusalScenario(dir), 120_000);

test("omp local: a repo's disabled .omp/mcp.json grayboard entry pins the name an omp session with no BUS_IDENTITY suggests and binds (#523)", () => ompLocalPinScenario(dir), 120_000);

test("omp local: a push-started bind reaches the next request's instructions without a user prompt; a killed grayboard process restarts and takes its names back; /new keeps the process and names, injecting instructions in a push-started turn; a local:// attachment resolves and the user entry's ${VAR} expands (#523, #552)", () => ompLocalCarryScenario(dir), 120_000);

test("omp local, ACP: of two top-level sessions in one omp process, the first runs grayboard and the second is refused; while both live, no subagent of either gets grayboard tools, so none acts as the first session's names (#523, #470)", () => ompLocalAcpScenario(dir), 120_000);
