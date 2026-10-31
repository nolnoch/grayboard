// End-to-end with the real omp coding agent: the hosted scenarios in
// tests/support/omp.ts, on the bundle the CLI embeds (server mode, #280).
import { afterEach, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompHostedLoadSmoke } from "../support/omp.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-omp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("omp hosted load smoke: the embedded bundle loads under omp signed in; its host import resolves to omp's agent dir, session_start sees omp's session id, the MCP client connects, the delivery lock is taken; no grayboard process runs and quit leaves nothing leased", () => ompHostedLoadSmoke(dir), 60_000);
