// #216: a v1.x release took BUS_IDENTITY literally, so a bus can hold a
// mixed-case handle (`Gray`) that v2's lowercase names can't bind. This tree's
// open moves its rows to `gray`: a DM the release queued for `Gray` reaches
// the session that binds `gray`.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busRows } from "../support/local_bus.ts";
import { closeSessions, localSession, stopSession } from "../support/mcp.ts";
import { releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";

// The last 1.x release: identities were case-sensitive until v2.0.0 (#181).
const FROM = "v1.10.0";
let rel: ReleaseBinaries;
const dirs: string[] = [];

beforeAll(async () => {
  rel = await releaseBinaries(FROM);
}, 120_000);

afterEach(async () => {
  await closeSessions();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test(`a DM ${FROM} queued for a mixed-case handle reaches its lowercase name`, async () => {
  const bus = mkdtempSync(join(tmpdir(), "grayboard-case-"));
  dirs.push(bus);
  const gray = await localSession(bus, "Gray", { bin: rel.cli });
  await stopSession(gray.c);
  const be = await localSession(bus, "be", { bin: rel.cli });
  await be.call("dm_send", { to: "Gray", body: "for you" });
  await stopSession(be.c);
  expect(busRows<{ name: string }>(bus, `SELECT name FROM handles WHERE name = 'Gray'`)).toHaveLength(1);

  const next = await localSession(bus, "gray");
  expect((await next.call("whoami")).primary).toBe("gray");
  const inbox = await next.call("dm_inbox");
  expect(inbox.unanswered.map((m: { from: string; body: string }) => [m.from, m.body])).toEqual([["be", "for you"]]);
  expect(busRows(bus, `SELECT name FROM handles WHERE name = 'Gray'`)).toEqual([]);
  expect(busRows<{ target: string }>(bus, `SELECT target FROM audit_log WHERE action = 'alias.case_moved'`)).toEqual([{ target: "gray" }]);
}, 60_000);
