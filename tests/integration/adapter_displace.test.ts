// #1381: an adapter's grayboard child (BUS_ADAPTER_OWNER, BUS_HARNESS_SESSION)
// is its harness session's delivery owner, so a name a sibling grayboard under
// the same harness pid holds (one the harness's MCP config starts beside it,
// whose pushes the harness drops) is taken from that sibling, whichever started
// first, and the sibling stops consuming the name's mail. Holders that aren't
// such a sibling keep the name.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { busRows, pauseEnv, releasePause } from "../support/local_bus.ts";
import { closeSessions, localSession, siblingSession, type Push, type Session } from "../support/mcp.ts";
import { SIBLINGS } from "../support/harness.ts";
import { until } from "../support/until.ts";

let dir: string;
let sock: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-displace-")));
  sock = join(dir, "sib.sock");
});
afterEach(async () => {
  for (const point of ["mcp:before-register", "drain:before-delivered"]) writeFileSync(join(dir, `go-${point}`), "");
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = "displace-test-owner";
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
  const adapterP = localSession(dir, "omp-local", { extra: { [SIBLINGS]: sock, ...pauseEnv(dir, "mcp:before-register"), BUS_ADAPTER_OWNER: OWNER, BUS_HARNESS_SESSION: "conv-1" } });
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
  const t0 = Date.now();
  // No BUS_IDENTITY: the name comes from the record under the shared harness pid.
  const adapter = await siblingSession(sock, adapterEnv("conv-1", null));
  expect(Date.now() - t0).toBeLessThan(4000);
  await ready(adapter);
  const adapterId = (await who(adapter)).id;
  expect(holder("omp-local")).toBe(adapterId);
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
