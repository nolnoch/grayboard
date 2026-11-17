// #216: a v1.x release took BUS_IDENTITY literally, so a bus can hold a
// mixed-case handle (`Gray`) that v2's lowercase names can't bind. This tree's
// open moves its rows to `gray`, merging them into a `gray` a v2 release
// already made: DMs queued for `Gray` reach the session that binds `gray`.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busRows } from "../support/local_bus.ts";
import { closeSessions, localSession, stopSession } from "../support/mcp.ts";
import { until } from "../support/until.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";

// The last 1.x release: identities were case-sensitive until v2.0.0 (#181).
const FROM = "v1.10.0";
let rel: ReleaseBinaries;
// The latest release: a v2 one, which normalizes `Gray` to `gray` at bind.
let v2: ReleaseBinaries;
const dirs: string[] = [];

beforeAll(async () => {
  rel = await releaseBinaries(FROM);
  v2 = await releaseBinaries(await latestRelease());
}, 240_000);

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

test(`${FROM}'s Gray, then a v2 release's gray, then this tree started as Gray: one mailbox`, async () => {
  const bus = mkdtempSync(join(tmpdir(), "grayboard-case-"));
  dirs.push(bus);
  await stopSession((await localSession(bus, "Gray", { bin: rel.cli })).c);
  const be = await localSession(bus, "be", { bin: rel.cli });
  await be.call("dm_send", { to: "Gray", body: "from 1.x" });
  await stopSession(be.c);
  // The v2 release binds `gray` beside the stranded `Gray` and is handed a DM
  // of its own, which moves `gray`'s cursor past the 1.x DM; a DM to `Gray`
  // still lands under the exact name (#272).
  const mid = await localSession(bus, "Gray", { bin: v2.cli });
  expect((await mid.call("whoami")).primary).toBe("gray");
  const be2 = await localSession(bus, "be", { bin: v2.cli });
  await be2.call("dm_send", { to: "gray", body: "to gray" });
  await until(() => mid.pushes.find((p) => p.content === "to gray"));
  await until(() => busRows(bus, `SELECT 1 FROM cursors WHERE reader = 'gray' AND last_seen_id >= 2`).length > 0);
  await stopSession(mid.c);
  await be2.call("dm_send", { to: "Gray", body: "from 2.x" });
  await stopSession(be2.c);
  expect(busRows(bus, `SELECT recipient FROM messages ORDER BY id`)).toEqual([{ recipient: "Gray" }, { recipient: "gray" }, { recipient: "Gray" }]);

  // Both DMs `Gray` never got are pushed; the one `gray` had is not again.
  const next = await localSession(bus, "Gray");
  expect((await next.call("whoami")).primary).toBe("gray");
  await until(() => next.pushes.filter((p) => p.meta.from === "be").length >= 2);
  expect(next.pushes.filter((p) => p.meta.from === "be").map((p) => p.content).sort()).toEqual(["from 1.x", "from 2.x"]);
  const inbox = await next.call("dm_inbox");
  expect(inbox.unanswered.map((m: { body: string }) => m.body).sort()).toEqual(["from 1.x", "from 2.x", "to gray"]);
  expect(busRows(bus, `SELECT address FROM aliases WHERE lower(address) = 'gray'`)).toEqual([{ address: "gray" }]);
  expect(busRows<{ detail: string }>(bus, `SELECT detail FROM audit_log WHERE action = 'alias.case_moved'`).map((r) => JSON.parse(r.detail))).toEqual([{ from: "Gray", merged: true }]);
}, 60_000);
