// End-to-end with the real omp coding agent: the hosted scenarios in
// tests/support/omp.ts, on the bundle the CLI embeds (server mode, #280).
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompHostedLoadSmoke, ompHostedManyChildrenScenario, ompHostedRefreshLogoutScenario, ompHostedScenario, ompHostedTaskScenario } from "../support/omp.ts";

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

test("omp hosted: 130 sequential subagents stay under the 128-child cap; each registers at its first call and ends with its run", () => ompHostedManyChildrenScenario(dir), 900_000);

test("omp hosted: two processes on one agent dir share one refresh; /grayboard logout in one pauses both", () => ompHostedRefreshLogoutScenario(dir), 120_000);
