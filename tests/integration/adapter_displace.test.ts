// #1381: an adapter's grayboard child (BUS_ADAPTER_OWNER, BUS_HARNESS_SESSION)
// is its harness session's delivery owner, so a name a sibling grayboard under
// the same harness pid holds (one the harness's MCP config starts beside it,
// whose pushes the harness drops) is taken from that sibling, whichever started
// first, and the sibling stops consuming the name's mail. Holders that aren't
// such a sibling keep the name.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { busRows, pauseEnv, releasePause } from "../support/local_bus.ts";
import { closeSessions, localSession, siblingSession, type Push, type Session } from "../support/mcp.ts";
import { SIBLINGS } from "../support/harness.ts";
import { until } from "../support/until.ts";
import { SIBLING_WAIT_MS } from "../../src/local/binding.ts";

let dir: string;
let sock: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-displace-")));
  sock = join(dir, "sib.sock");
});
afterEach(async () => {
  for (const point of ["mcp:before-register", "drain:before-delivered", "drain:before-board-delivered", "bind:before-poke", "mcp:before-record", "drain:before-board-push", "drain:in-mark"]) writeFileSync(join(dir, `go-${point}`), "");
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = "displace-test-owner";
// A session started paused, awaited only after expects that may throw: on a
// failure afterEach releases the pause and closes it, and its rejection then
// ("Connection closed") must not land on the next test. Awaiting it still throws.
const paused = (p: Promise<Session>): Promise<Session> => {
  p.catch(() => {});
  return p;
};
const rows = <T>(sql: string, ...args: (string | number)[]): T[] => busRows<T>(dir, sql, ...args);
const holder = (name: string) => rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = ?`, name)[0]?.id ?? null;
const holds = (id: string) => rows<{ address: string }>(`SELECT address FROM alias_holds WHERE id = ?`, id).map((r) => r.address);
const displaced = () => rows<{ actor: string; target: string; detail: string }>(`SELECT actor, target, detail FROM audit_log WHERE action = 'alias.displaced' ORDER BY rowid`)
  .map((r): Record<string, unknown> => ({ actor: r.actor, target: r.target, ...JSON.parse(r.detail) as Record<string, unknown> }));
const who = async (s: Session) => z.object({ id: z.string(), aliases: z.array(z.string()) }).passthrough().parse(await s.call("whoami"));
const EmptySchema = z.object({}).passthrough();
const ready = (s: Session) => s.c.request({ method: "grayboard/session/ready", params: { owner: OWNER, epoch: 0 } }, EmptySchema);
const receipt = (s: Session, p: Push) => s.c.request({ method: "grayboard/delivery", params: { owner: OWNER, token: p.meta.grayboard_delivery, accepted: true } }, EmptySchema);
const adapterEnv = (conversation: string, identity: string | null = "omp-local") => ({ BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: conversation, BUS_IDENTITY: identity });
// A tool result's every text block: notices follow the result's own.
const texts = async (s: Session, name: string) => ((await s.c.callTool({ name, arguments: {} })).content as { text: string }[]).map((c) => c.text).join("\n");

test("client first (forced: the adapter's child pauses before it registers): the adapter's child takes the name from its sibling, audited; the sibling holds nothing, is told, and a DM to the name reaches only the adapter's child", async () => {
  // The adapter's child is the harness's own child, paused; its sibling, the
  // client's plain push grayboard, starts and takes omp-local meanwhile.
  const adapterP = paused(localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "mcp:before-register"), BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } }));
  const client = await siblingSession(sock, { BUS_ADAPTER_OWNER: null, BUS_HARNESS_SESSION: null, BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  const clientId = (await who(client)).id;
  expect(holder("omp-local")).toBe(clientId);
  releasePause(dir, "mcp:before-register");
  const adapter = await adapterP;
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  expect(holds(clientId)).toEqual([]);
  const [harnessPid] = rows<{ harness_pid: number }>(`SELECT harness_pid FROM bindings WHERE session_id = ?`, adapterId).map((r) => r.harness_pid);
  expect(rows<{ harness_pid: number }>(`SELECT harness_pid FROM bindings WHERE session_id = ?`, clientId)[0]!.harness_pid).toBe(harnessPid!);
  expect(displaced()).toEqual([{ actor: adapterId, target: clientId, name: "omp-local", harness_pid: harnessPid, pid: expect.any(Number) }]);
  expect(rows<{ event: string; detail: string | null }>(`SELECT event, detail FROM binding_events WHERE session_id = ? AND name = 'omp-local' ORDER BY id`, clientId))
    .toEqual([{ event: "bound", detail: null }, { event: "released", detail: `displaced by ${adapterId}` }]);
  // The sibling's next result says so, and it acts as its ID.
  expect(await texts(client, "whoami")).toContain(`"omp-local" was taken by ${adapterId}`);
  expect((await who(client)).aliases).toEqual([]);

  const peer = await localSession(dir, "peer");
  await peer.call("dm_send", { to: "omp-local", body: "for the owner" });
  await until(() => adapter.pushes.some((p) => p.content.includes("for the owner")), 10_000, "the adapter's child pushes the DM");
  await receipt(adapter, adapter.pushes.find((p) => p.content.includes("for the owner"))!);
  await until(() => rows<{ delivered_at: number | null }>(`SELECT delivered_at FROM messages WHERE body = 'for the owner'`)[0]!.delivered_at !== null, 10_000, "the DM delivered");
  expect(client.pushes.filter((p) => p.content.includes("for the owner"))).toEqual([]);
}, 30_000);

test("a DM the sibling was pushing when the name was taken stays unread for the adapter's child, which delivers it", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "drain:before-delivered") } });
  const clientId = (await who(client)).id;
  const peer = await localSession(dir, "peer");
  await peer.call("dm_send", { to: "omp-local", body: "mid-drain" });
  // The sibling pushed it (into the harness's void) and stops before marking it delivered.
  await until(() => client.pushes.some((p) => p.content.includes("mid-drain")), 10_000, "the sibling pushes the DM");
  await until(() => client.stderr().includes("test pause hit: drain:before-delivered"), 10_000, "the sibling's drain pauses");
  const adapter = await siblingSession(sock, { ...adapterEnv("conv-1"), BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  await until(() => adapter.pushes.some((p) => p.content.includes("mid-drain")), 10_000, "the adapter's child pushes the DM");
  releasePause(dir, "drain:before-delivered");
  await until(() => client.stderr().includes(`session ${clientId} lost "omp-local"`), 10_000, "the sibling drops the name");
  expect(rows<{ delivered_at: number | null }>(`SELECT delivered_at FROM messages WHERE body = 'mid-drain'`)[0]!.delivered_at).toBeNull();
  await receipt(adapter, adapter.pushes.find((p) => p.content.includes("mid-drain"))!);
  await until(() => rows<{ delivered_at: number | null }>(`SELECT delivered_at FROM messages WHERE body = 'mid-drain'`)[0]!.delivered_at !== null, 10_000, "the adapter's child delivers it");
}, 30_000);

test("a board push the sibling was making when the name was taken stays pending for the adapter's child, which pushes it", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "drain:before-board-delivered") } });
  const clientId = (await who(client)).id;
  const peer = await localSession(dir, "peer");
  await peer.call("board_create", { name: "e2e", purpose: "test" });
  await peer.call("board_post", { board: "e2e", body: "@omp-local board mid-drain" });
  await until(() => client.pushes.some((p) => p.content.includes("board mid-drain")), 10_000, "the sibling pushes the post");
  await until(() => client.stderr().includes("test pause hit: drain:before-board-delivered"), 10_000, "the sibling's drain pauses");
  // Not ready yet: its delivery waits until the sibling has finished.
  const adapter = await siblingSession(sock, { ...adapterEnv("conv-1"), BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  expect(holder("omp-local")).not.toBe(clientId);
  releasePause(dir, "drain:before-board-delivered");
  await until(() => client.stderr().includes(`session ${clientId} lost "omp-local"`), 10_000, "the sibling drops the name");
  await ready(adapter);
  await until(() => adapter.pushes.some((p) => p.content.includes("board mid-drain")), 10_000, "the adapter's child pushes the post");
  await receipt(adapter, adapter.pushes.find((p) => p.content.includes("board mid-drain"))!);
}, 30_000);

test("a sibling that acquires and listens between the adapter's child's holder read and its socket probe is displaced, and the child holds the name: the live socket is the displaced holder's, never a refusal beside a committed displacement", async () => {
  // The adapter's child reads no holder, then pauses before the probe.
  const adapterP = paused(localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "bind:before-poke"), BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } }));
  // Its registration runs synchronously into the pause (no await between).
  await until(() => {
    try {
      return rows<{ id: string }>(`SELECT id FROM ids WHERE harness_session = 'conv-1'`).length === 1;
    } catch {
      return false; // the file and its tables don't exist yet
    }
  }, 10_000, "the adapter's child registers");
  const client = await siblingSession(sock, { BUS_ADAPTER_OWNER: null, BUS_HARNESS_SESSION: null, BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  const clientId = (await who(client)).id;
  expect(holder("omp-local")).toBe(clientId);
  await until(() => existsSync(join(dir, "sock.omp-local")), 10_000, "the sibling listens on the name");
  releasePause(dir, "bind:before-poke");
  const adapter = await adapterP;
  expect(adapter.stderr()).toContain("test pause hit: bind:before-poke");
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  expect((await who(adapter)).aliases).toEqual(["omp-local"]);
  expect(holds(clientId)).toEqual([]);
  expect(displaced()).toEqual([expect.objectContaining({ actor: adapterId, target: clientId, name: "omp-local" })]);
  expect(rows(`SELECT 1 FROM binding_events WHERE session_id = ? AND event = 'refused'`, adapterId)).toEqual([]);
}, 30_000);

test("adapter first: its sibling's BUS_IDENTITY finds the name held and starts unbound; nothing is displaced", async () => {
  const adapter = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } });
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  const client = await siblingSession(sock, { BUS_ADAPTER_OWNER: null, BUS_HARNESS_SESSION: null });
  expect((await who(client)).aliases).toEqual([]);
  expect(holder("omp-local")).toBe(adapterId);
  expect(displaced()).toEqual([]);
}, 30_000);

test("the adapter's child restoring from the name record its sibling wrote takes the name at once, without the predecessor wait", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock } });
  const clientId = (await who(client)).id;
  // No BUS_IDENTITY: the name comes from the record under the shared harness pid.
  const adapter = await siblingSession(sock, adapterEnv("conv-1", null));
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  // From its registration to its bind, measured in its own rows: the
  // predecessor wait would put SIBLING_WAIT_MS between them.
  const registered = rows<{ started_at: number }>(`SELECT started_at FROM bindings WHERE session_id = ?`, adapterId)[0]!.started_at;
  const bound = rows<{ at: number }>(`SELECT at FROM binding_events WHERE session_id = ? AND name = 'omp-local' AND event = 'bound'`, adapterId)[0]!.at;
  expect(bound - registered).toBeLessThan(SIBLING_WAIT_MS);
  expect(displaced()).toEqual([expect.objectContaining({ actor: adapterId, target: clientId, name: "omp-local" })]);
}, 30_000);

test("an unrelated live session (another harness) keeps the name: the adapter's child starts unbound, told who holds it", async () => {
  const other = await localSession(dir, "omp-local");
  const otherId = (await who(other)).id;
  const adapter = await localSession(dir, "omp-local", { extra: { BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } });
  await ready(adapter);
  expect((await who(adapter)).aliases).toEqual([]);
  expect(holder("omp-local")).toBe(otherId);
  expect(displaced()).toEqual([]);
}, 30_000);

test("a sibling with a harness session of its own keeps the name: it is a predecessor, waited for, not displaced", async () => {
  const first = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, BUS_HARNESS_SESSION: "conv-0" } });
  const firstId = (await who(first)).id;
  const adapter = await siblingSession(sock, adapterEnv("conv-1"));
  await ready(adapter);
  expect((await who(adapter)).aliases).toEqual([]);
  expect(holder("omp-local")).toBe(firstId);
  expect(displaced()).toEqual([]);
}, 30_000);

test("bind: the adapter's child binding a name its sibling holds takes it the same way", async () => {
  const adapter = await localSession(dir, undefined, { extra: { [SIBLINGS]: sock, BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } });
  await ready(adapter);
  const client = await siblingSession(sock, { BUS_ADAPTER_OWNER: null, BUS_HARNESS_SESSION: null });
  const clientId = (await who(client)).id;
  await client.call("bind", { name: "task-x", create: true });
  expect(holder("task-x")).toBe(clientId);
  await adapter.call("bind", { name: "task-x" });
  const adapterId = (await who(adapter)).id;
  expect(holder("task-x")).toBe(adapterId);
  expect(displaced()).toEqual([expect.objectContaining({ actor: adapterId, target: clientId, name: "task-x" })]);
}, 30_000);

// #1403: a harness launched from a Claude Code shell (omp, pi) passes
// CLAUDECODE and CLAUDE_CODE_SESSION_ID on to the grayboard it starts. That
// session id is Claude Code's, not this harness's: the sibling records none,
// so the adapter's child still takes the name from it.
const inheritedClaude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-shell-session" };
const harnessSession = (id: string) => rows<{ harness_session: string | null }>(`SELECT harness_session FROM ids WHERE id = ?`, id)[0]!.harness_session;

test("a sibling that inherited Claude Code's env from the shell that launched its harness records no harness session and is displaced", async () => {
  const adapterP = paused(localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "mcp:before-register"), BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } }));
  const client = await siblingSession(sock, { BUS_ADAPTER_OWNER: null, BUS_HARNESS_SESSION: null, BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null, ...inheritedClaude });
  const clientId = (await who(client)).id;
  expect(holder("omp-local")).toBe(clientId);
  expect(harnessSession(clientId)).toBeNull();
  releasePause(dir, "mcp:before-register");
  const adapter = await adapterP;
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  expect(holds(clientId)).toEqual([]);
  expect(displaced()).toEqual([expect.objectContaining({ actor: adapterId, target: clientId, name: "omp-local" })]);
}, 30_000);

test("a grayboard whose harness is Claude Code (a stand-in named claude) still records CLAUDE_CODE_SESSION_ID; BUS_HARNESS_SESSION still wins", async () => {
  // Stand-in for Claude Code, as local.test.ts's: bun under the name
  // `claude`, running grayboard mcp as its child on inherited stdio.
  const fake = join(dir, "claude");
  symlinkSync(process.execPath, fake);
  const host = join(dir, "host.ts");
  writeFileSync(host, `const cmd = process.argv.slice(process.argv.indexOf("::") + 1);
Bun.spawn([process.execPath, ...cmd], { stdio: ["inherit", "inherit", "inherit"] }).exited.then((c) => process.exit(c ?? 0));`);
  const flags = ["--dangerously-load-development-channels", "server:grayboard", "::"];
  const cc = await localSession(dir, "cc", { extra: { ...inheritedClaude, CLAUDE_CODE_ENTRYPOINT: "cli" }, via: [fake, host, ...flags] });
  expect(harnessSession((await who(cc)).id)).toBe("claude-shell-session");
  const explicit = await localSession(dir, "cc2", { extra: { ...inheritedClaude, CLAUDE_CODE_ENTRYPOINT: "cli", BUS_HARNESS_SESSION: "explicit" }, via: [fake, host, ...flags] });
  expect(harnessSession((await who(explicit)).id)).toBe("explicit");
}, 30_000);

// #1404: the name record is keyed by harness pid, so the adapter's child and
// a sibling it displaced share one. The sibling leaves it to the child while
// the child lives: neither its stale start-time write nor a later bind
// overwrites the child's record.
const record = (harnessPid: number) => JSON.parse(readFileSync(join(dir, `bind.${harnessPid}`), "utf8")) as { names: string[]; session_id: string };
const ended = (id: string) => rows<{ ended_at: number | null }>(`SELECT ended_at FROM ids WHERE id = ?`, id)[0]?.ended_at != null;

test("a sibling displaced between its start-time acquire and its name record write (forced) leaves the adapter's child's record", async () => {
  const clientP = paused(localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "mcp:before-record") } }));
  await until(() => {
    try {
      return holder("omp-local") !== null;
    } catch {
      return false; // the file and its tables don't exist yet
    }
  }, 10_000, "the sibling takes the name and pauses before its record write");
  const adapter = await siblingSession(sock, { ...adapterEnv("conv-1"), BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  const harnessPid = rows<{ harness_pid: number }>(`SELECT harness_pid FROM bindings WHERE session_id = ?`, adapterId)[0]!.harness_pid;
  expect(record(harnessPid)).toMatchObject({ names: ["omp-local"], session_id: adapterId });
  releasePause(dir, "mcp:before-record");
  const client = await clientP;
  expect(client.stderr()).toContain("test pause hit: mcp:before-record");
  expect((await who(client)).aliases).toEqual([]);
  expect(record(harnessPid)).toMatchObject({ names: ["omp-local"], session_id: adapterId });
}, 30_000);

test("a later bind on the displaced sibling leaves the adapter's child's record; once the child has ended, the sibling's binds write it again", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock } });
  const clientId = (await who(client)).id;
  const adapter = await siblingSession(sock, adapterEnv("conv-1"));
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
  expect(record(client.harnessPid)).toMatchObject({ names: ["omp-local"], session_id: adapterId });
  await client.call("bind", { name: "task-y", create: true });
  expect(holder("task-y")).toBe(clientId);
  expect(record(client.harnessPid)).toMatchObject({ names: ["omp-local"], session_id: adapterId });
  await adapter.c.close();
  await until(() => ended(adapterId), 10_000, "the adapter's child ends");
  await client.call("bind", { name: "task-z", create: true });
  expect(record(client.harnessPid)).toMatchObject({ names: ["task-y", "task-z"], session_id: clientId });
}, 30_000);

test("a board item the sibling read before its name was taken (forced) isn't pushed by it: its pre-push hold check leaves the item to the adapter's child", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "drain:before-board-push") } });
  const clientId = (await who(client)).id;
  const peer = await localSession(dir, "peer");
  await peer.call("board_create", { name: "e2e", purpose: "test" });
  await peer.call("board_post", { board: "e2e", body: "@omp-local pre-push" });
  await until(() => client.stderr().includes("test pause hit: drain:before-board-push"), 10_000, "the sibling's drain reads the post and pauses");
  const adapter = await siblingSession(sock, { ...adapterEnv("conv-1"), BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  expect(holder("omp-local")).not.toBe(clientId);
  releasePause(dir, "drain:before-board-push");
  await until(() => client.stderr().includes(`session ${clientId} lost "omp-local"`), 10_000, "the sibling drops the name");
  await ready(adapter);
  await until(() => adapter.pushes.some((p) => p.content.includes("pre-push")), 10_000, "the adapter's child pushes the post");
  // A notification the sibling wrote precedes this call's result on its stdout.
  await who(client);
  expect(client.pushes.filter((p) => p.content.includes("pre-push"))).toEqual([]);
}, 30_000);

test("a drain paused between its hold check and its mark (forced) holds the write lock, so no displacement commits between; the DM is delivered once, by the sibling", async () => {
  const client = await localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "drain:in-mark") } });
  const clientId = (await who(client)).id;
  const peer = await localSession(dir, "peer");
  await peer.call("dm_send", { to: "omp-local", body: "in-mark" });
  await until(() => client.stderr().includes("test pause hit: drain:in-mark"), 10_000, "the sibling's drain pauses between check and mark");
  // Any other writer, the adapter's child's acquire among them, is held off.
  const probe = new Database(join(dir, "bus.db"));
  try {
    probe.exec("PRAGMA busy_timeout = 0");
    expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
  } finally {
    probe.close();
  }
  expect(holder("omp-local")).toBe(clientId);
  releasePause(dir, "drain:in-mark");
  await until(() => rows<{ delivered_at: number | null }>(`SELECT delivered_at FROM messages WHERE body = 'in-mark'`)[0]!.delivered_at !== null, 10_000, "the sibling marks the DM delivered");
  const adapter = await siblingSession(sock, { ...adapterEnv("conv-1"), BUS_TEST_PAUSE: null, BUS_TEST_PAUSE_FILE: null });
  await ready(adapter);
  expect(holder("omp-local")).toBe((await who(adapter)).id);
  // A later DM reaches the adapter's child; the marked one, drained first if it were unread, never does.
  await peer.call("dm_send", { to: "omp-local", body: "after-mark" });
  await until(() => adapter.pushes.some((p) => p.content.includes("after-mark")), 10_000, "the adapter's child pushes the later DM");
  expect(adapter.pushes.filter((p) => p.content.includes("in-mark"))).toEqual([]);
  expect(client.pushes.filter((p) => p.content.includes("in-mark"))).toHaveLength(1);
}, 30_000);

// #1401: a holder's recorded harness pid can be a dead harness's, reused by
// the adapter's child's harness while the holder (an orphan that hasn't shut
// down) outlived it. Forced by rewriting the holder's recorded harness pid to
// the new harness's: the holder isn't that harness's child, so it keeps the
// name, and a session under that harness doesn't yield its record to it.
const recordHarnessPid = (id: string, harnessPid: number): void => {
  const db = new Database(join(dir, "bus.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare(`UPDATE bindings SET harness_pid = ? WHERE session_id = ?`).run(harnessPid, id);
  } finally {
    db.close();
  }
};

test("a holder whose recorded harness pid was reused by the adapter's child's harness (forced) keeps the name: it isn't that harness's child", async () => {
  // The harness the adapter's child will run under, with an unbound session of its own.
  const anchor = await localSession(dir, undefined, { extra: { [SIBLINGS]: sock } });
  const other = await localSession(dir, "omp-local");
  const otherId = (await who(other)).id;
  recordHarnessPid(otherId, anchor.harnessPid);
  const adapter = await siblingSession(sock, adapterEnv("conv-1"));
  await ready(adapter);
  expect((await who(adapter)).aliases).toEqual([]);
  expect(holder("omp-local")).toBe(otherId);
  expect(displaced()).toEqual([]);
}, 30_000);

test("a session doesn't yield its name record to an adapter's child whose recorded harness pid is its harness's but which isn't that harness's child (forced)", async () => {
  const orphan = await localSession(dir, undefined, { extra: { BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } });
  await ready(orphan);
  const orphanId = (await who(orphan)).id;
  const client = await localSession(dir, undefined);
  recordHarnessPid(orphanId, client.harnessPid);
  await client.call("bind", { name: "task-r", create: true });
  expect(record(client.harnessPid)).toMatchObject({ names: ["task-r"], session_id: (await who(client)).id });
}, 30_000);

// #1457: an adapter's child that exits bound leaves its names in the record
// it shares with a sibling under the same harness pid. The sibling, restarted
// before it binds again, doesn't restore them as its own restart, nor inherit
// the child's status; its own record still restores.
const status = (id: string) => rows<{ status: string | null }>(`SELECT status FROM ids WHERE id = ?`, id)[0]!.status;

test("a sibling restarting after the adapter's child exited bound doesn't restore the child's names from their shared record", async () => {
  const client = await localSession(dir, undefined, { extra: { [SIBLINGS]: sock } });
  const adapter = await siblingSession(sock, adapterEnv("conv-1"));
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  await adapter.call("peer_status", { text: "adapter's task" });
  expect(record(client.harnessPid)).toMatchObject({ names: ["omp-local"], session_id: adapterId });
  await adapter.c.close();
  await until(() => ended(adapterId), 10_000, "the adapter's child ends");
  const restarted = await client.restart("reconnect");
  const me = await who(restarted);
  expect(me.aliases).toEqual([]);
  expect(holder("omp-local")).toBeNull();
  expect(status(me.id)).toBeNull();
  expect(rows(`SELECT 1 FROM binding_events WHERE session_id = ?`, me.id)).toEqual([]);
}, 30_000);

test("a sibling whose own record it is still restores its names, verified, with its status, after an adapter's child came and went", async () => {
  const client = await localSession(dir, undefined, { extra: { [SIBLINGS]: sock } });
  const clientId = (await who(client)).id;
  const adapter = await siblingSession(sock, adapterEnv("conv-1"));
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  await adapter.c.close();
  await until(() => ended(adapterId), 10_000, "the adapter's child ends");
  await client.call("bind", { name: "task-s", create: true });
  await client.call("peer_status", { text: "sibling's task" });
  expect(record(client.harnessPid)).toMatchObject({ names: ["task-s"], session_id: clientId });
  const restarted = await client.restart("reconnect");
  const me = await who(restarted);
  expect(me.aliases).toEqual(["task-s"]);
  expect(status(me.id)).toBe("sibling's task");
}, 30_000);
