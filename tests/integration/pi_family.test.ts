// The hosted pi-family extension (#279) in-process: createGrayboard driven
// through a recording Harness against a real server whose public URL is its
// listen address, signed in with a grant seeded for the built-in pi client.
// Covers a root's bind and push delivery, name carry across /new and /fork,
// reload detach and quit release, the child rule (runner marker, the
// in-process registry, fork-is-root), child registration and end under the
// server's child cap, the delivery-lock loser, and the unattributed runner
// child; and what the #436 audit found: a non-canonical config, restarts
// after a sign-in elsewhere, a refused rebind or carry, the Controller's own
// pauses and binds, sign-in and sign-out failures, the bind's place, a reload
// before a receipt, an item reaching a root mid-/new, and a child shut down
// mid-registration. For omp (#280): an idle child re-registering under the
// root its marker names now, an idle end behind a running call, and rootOf.
// The process's sign-in (#581): a signed-out call's offer in each role, a
// subagent taking its root's mode, /grayboard login joining a pending flow,
// an outcome kept across a session switch, and status's last sign-in line.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { SessionFacts } from "../../adapters/hosted-core/src/port.ts";
import { createGrayboard, LOGIN_ACTION, type DeliveryEntry, type Grayboard, type Marker, type SessionInfo } from "../../adapters/pi-family/extension.ts";
import { rootOf, type Agent } from "../../adapters/pi-family/omp-ancestry.ts";
import type { Level } from "../../adapters/hosted-core/src/client.ts";
import type { SignInState } from "../../adapters/hosted-core/src/offer.ts";
import { Controller } from "../../adapters/hosted-core/src/controller.ts";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { ToolProxy, type NativeTool } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath, FileStorage, sessionPath, writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { describeLocation } from "../../src/shared/identity.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { browse, hostedServer, seedGrant, type HostedServer } from "../support/hosted_oauth.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
const EMAIL = "alice@example.com";
const SCOPES = ["grayboard:delivery", "grayboard:tools"];
const HELD = "another pi process holds delivery for this session";

let srv: HostedServer, agentDir: string, stateDir: string, user: number, stopped: boolean;
const instances: Instance[] = [];
const PATH = process.env.PATH;

// The extension's per-harness globalThis slot (extension.ts `shared`): each
// test starts with none, so no sign-in record, mode or voice leaks between tests.
const SLOT = Symbol.for("io.github.nolnoch.grayboard/pi-sessions");
const slots = globalThis as unknown as Record<symbol, { signins: SignInState } | undefined>;
const signins = () => slots[SLOT]?.signins ?? {};

beforeEach(async () => {
  srv = hostedServer();
  stopped = false;
  delete slots[SLOT];
  agentDir = realpathSync(mkdtempSync(join(tmpdir(), "gb-pi-family-")));
  stateDir = join(agentDir, "grayboard");
  mkdirSync(stateDir, { recursive: true });
  // The system browser's opener (`open`, `xdg-open`) records the URL instead.
  const bin = join(agentDir, "bin");
  mkdirSync(bin);
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(join(agentDir, "opened"))}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${PATH}`;
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ url: srv.resource }));
  user = (await seedGrant(srv, stateDir, CLIENT, EMAIL)).authed.user_id;
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map(i => i.ext.shutdown("quit")));
  // A flow only a subagent or a switched-away root left: its loopback listener goes.
  signins().flow?.abort.abort();
  await signins().flow?.done;
  delete slots[SLOT];
  process.env.PATH = PATH;
  if (!stopped) await srv.stop();
  rmSync(agentDir, { recursive: true, force: true });
});

// One extension runtime (one pi session) with a Harness that records what the
// extension registers, delivers, notifies and records in the session.
type Instance = {
  ext: Grayboard;
  deliveries: { content: string; wake: boolean }[];
  notices: { message: string; level: Level }[];
  records: DeliveryEntry[];
  tools(): NativeTool[];
  call(tool: string, args?: Record<string, unknown>): Promise<CallToolResult>;
};
// `marker`, a function, is read live (omp's entry: the root as it is now).
// `facts`: the harness's current model and effort (#364), read live.
// `interactive`: the harness's mode outlives a browser round trip (tui, rpc).
function instance(marker: Marker | (() => Marker) = { child: false }, onDeliver?: () => void, facts?: (sessionID: string) => SessionFacts | undefined, interactive = false): Instance {
  let tools: NativeTool[] = [];
  let run: ((tool: string, args: Record<string, unknown>) => Promise<CallToolResult>) | undefined;
  const self: Instance = {
    deliveries: [], notices: [], records: [],
    ext: createGrayboard({
      name: "pi", clientId: CLIENT, version: "1.0.0", agentDir,
      marker: typeof marker === "function" ? marker : () => marker,
      register: (list, call) => { tools = list; run = call; },
      deliver: (content, wake) => { self.deliveries.push({ content, wake }); onDeliver?.(); },
      notify: (message, level) => { self.notices.push({ message, level }); },
      record: data => { self.records.push(data); },
      // Headless by default: a signed-out call fails at once instead of offering a sign-in (#499).
      interactive: () => interactive,
      ...(facts ? { facts } : {}),
    }),
    tools: () => tools,
    call: (tool, args = {}) => run!(tool, args),
  };
  instances.push(self);
  return self;
}

const texts = (result: CallToolResult) => result.content.flatMap(block => block.type === "text" ? [block.text] : []);
// The server's own result: structuredContent, else its (last) text as JSON.
const payload = (result: CallToolResult) => result.structuredContent ?? JSON.parse(texts(result).at(-1)!);

type Row = { name: string | null; root_session_id: string | null; ownership_id: number; lease_deadline: number | null };
const hostedId = (raw: string) => hostedSessionId(user, CLIENT, raw);
const row = (raw: string) => srv.app.db.query<Row, [string]>(
  "SELECT (SELECT substr(address, instr(address, '/') + 1) FROM alias_holds WHERE id = session_id ORDER BY bound_at, address LIMIT 1) AS name, root_session_id, ownership_id, lease_deadline FROM hosted_sessions WHERE session_id = ?").get(hostedId(raw));

// The root's line in /grayboard status says it is subscribed under `name`.
const active = (i: Instance, id: string, name: string, ms = 5_000) =>
  until(async () => (await i.ext.status()).includes(`  ${id} (${EMAIL}/${name}): active,`), ms, `${id} active as ${name}`);

async function root(id: string, name: string, extra: Partial<SessionInfo> = {}, create = true) {
  const i = instance();
  await i.ext.start({ id, reason: "startup", ...extra });
  const bound = await i.call("bind", { name, create });
  expect(bound.isError).toBeUndefined();
  await active(i, id, name);
  return i;
}

// Another pi process on this agentDir (none of this process's extension
// state): a sign-in writes a new epoch and grant to the shared store, a
// sign-out revokes and logs the store out.
const storeLogin = () => new Login({ resource: srv.resource, clientId: CLIENT, stateDir, harness: "test", loginAction: "log in", present: () => {}, notify: () => {}, diagnostic: () => {} });
async function loginElsewhere(epoch: string) {
  const issued = issueOAuth(srv.app.repo, srv.resource, EMAIL, SCOPES, Date.now(), CLIENT);
  await writeJsonAtomic(storeLogin().path, { version: 1, resource: srv.resource, clientId: CLIENT, epoch, issuer: srv.issuer, scope: SCOPES.join(" "),
    access: issued.token, accessExpiresAt: Date.now() + 3_600_000, refresh: issued.refreshToken });
}
const logoutElsewhere = () => storeLogin().logout();
// A session in another pi process, with its own grant and connection.
function elsewhere(): ToolProxy {
  const { token } = issueOAuth(srv.app.repo, srv.resource, EMAIL, SCOPES, Date.now(), CLIENT);
  return new ToolProxy({
    wire: { url: srv.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" }, delivery: { mode: "poll", source: "grayboard" } },
    harness: "pi", loginAction: "run /grayboard login", auth: { token: async () => token }, report: () => {},
  });
}
// The root's Controller recorded something at or after `since` (its
// diagnostics, persisted in the session's state file).
const recordedSince = async (id: string, since: number) => {
  const records = await new FileStorage(sessionPath(stateDir, srv.resource, CLIENT, id)).get("diagnostics:v1");
  return Array.isArray(records) && records.some(r => r.sessionID === id && r.time >= since);
};
// Holds the in-process server at test pause `point` until the returned
// release runs; `hit` resolves once a request reaches it.
function pauseAt(point: string) {
  const file = join(agentDir, `release-${point.replaceAll(":", "-")}`);
  const spy = spyOn(console, "error");
  process.env.BUS_TEST_PAUSE = point;
  process.env.BUS_TEST_PAUSE_FILE = file;
  return {
    hit: until(() => spy.mock.calls.some(c => String(c[0]).includes(`test pause hit: ${point}`)), 10_000, `pause ${point}`),
    release: () => {
      writeFileSync(file, "");
      delete process.env.BUS_TEST_PAUSE;
      delete process.env.BUS_TEST_PAUSE_FILE;
      spy.mockRestore();
    },
  };
}

test("a root binds through its bind tool; a DM arrives once as a waking <channel>, marked human only from the user's own human", async () => {
  const alpha = instance();
  // The snapshot's tools are registered before the session starts.
  expect(alpha.tools().map(t => t.name)).toContain("bind");
  await alpha.ext.start({ id: "root-alpha", reason: "startup" });
  const bound = await alpha.call("bind", { name: "alpha", create: true });
  expect(bound.isError).toBeUndefined();
  expect(texts(bound)[0]).toStartWith(`Bound to "alpha"`);
  expect(row("root-alpha")).toMatchObject({ name: "alpha", root_session_id: null });
  await active(alpha, "root-alpha", "alpha");
  expect(row("root-alpha")!.lease_deadline).not.toBeNull();

  const beta = await root("root-beta", "beta");
  const sent = await beta.call("dm_send", { to: "alpha", body: "hello from beta" });
  expect(sent.isError).toBeUndefined();
  await until(() => alpha.deliveries.length > 0);
  const [dm] = alpha.deliveries;
  expect(dm!.wake).toBe(true);
  expect(dm!.content).toStartWith(`<channel source="grayboard" `);
  expect(dm!.content).toContain(` from="${EMAIL}/beta"`);
  expect(dm!.content).toEndWith(`>\nhello from beta\n</channel>`);
  expect(dm!.content).not.toContain(`human="true"`);

  // The Slack bridge's in-process human for this user.
  const human = await srv.app.application.attachHuman({ user_id: user, user_email: EMAIL, session_id: 0 }, { deliver() {}, probe: async () => true, closed() {} });
  srv.app.application.send(human.session, `${EMAIL}/alpha`, "hello from slack");
  await until(() => alpha.deliveries.length > 1);
  // The first was receipted: the next read admitted only the new item.
  expect(alpha.deliveries).toHaveLength(2);
  expect(alpha.deliveries[1]!.wake).toBe(true);
  expect(alpha.deliveries[1]!.content).toContain(` from="${EMAIL}/human"`);
  expect(alpha.deliveries[1]!.content).toContain(` human="true"`);
  expect(beta.deliveries).toEqual([]);
  // Each admission is recorded under the root, then its receipt; never a body.
  const first = `direct:${payload(sent).message_id}`;
  await until(() => alpha.records.filter(r => r.event === "receipted").flatMap(r => r.itemIds).length === 2, 10_000, "both receipts recorded");
  const admitted = alpha.records.filter(r => r.event === "admitted");
  expect(admitted).toHaveLength(2);
  expect(admitted[0]).toMatchObject({ root: "root-alpha", itemId: first, wake: true });
  expect(alpha.records.every(r => r.root === "root-alpha")).toBe(true);
  expect(alpha.records.findIndex(r => r.event === "receipted" && r.itemIds.includes(first))).toBeGreaterThan(alpha.records.indexOf(admitted[0]!));
  expect(JSON.stringify(alpha.records)).not.toContain("hello from");
});

// The harness's model and effort ride its session's requests (#364): peer_list shows the latest, and a switch mid-session
// moves them on the next call. A child of this root, its own pi process, sends its own harness's facts, never the root's.
// The harness is asked for its own session only; a provider that throws is said once and sends none.
test("a root's model and effort show in peer_list and follow a switch; its child reports its own (#364)", async () => {
  const facts: SessionFacts = { model: "anthropic/claude-opus-5-5", effort: "high" };
  const asked = new Set<string>();
  let broken = false;
  const lead = instance(undefined, undefined, id => { asked.add(id); if (broken) throw new Error("runtime gone"); return { ...facts }; });
  await lead.ext.start({ id: "facts-root", reason: "startup" });
  expect((await lead.call("bind", { name: "lead", create: true })).isError).toBeUndefined();
  type Peers = { peers: Array<{ handle: string; model?: string | null; effort?: string | null }> };
  const peers = async (i: Instance) => (payload(await i.call("peer_list", { include_offline: true })) as Peers).peers;
  expect(await peers(lead)).toContainEqual(expect.objectContaining({ handle: `${EMAIL}/lead`, model: "anthropic/claude-opus-5-5", effort: "high" }));
  facts.model = "openai/gpt-6";
  facts.effort = "low";
  expect(await peers(lead)).toContainEqual(expect.objectContaining({ handle: `${EMAIL}/lead`, model: "openai/gpt-6", effort: "low" }));
  const child = instance({ child: true, root: "facts-root" }, undefined, () => ({ model: "anthropic/claude-haiku-5-5" }));
  await child.ext.start({ id: "facts-child", reason: "startup" });
  await child.call("whoami");
  expect(srv.app.db.query<{ model: string | null }, [string]>("SELECT model FROM ids WHERE id = ?").get(hostedId("facts-child"))?.model).toBe("anthropic/claude-haiku-5-5");
  expect(await peers(lead)).toContainEqual(expect.objectContaining({ handle: `${EMAIL}/lead`, model: "openai/gpt-6" }));
  expect([...asked]).toEqual(["facts-root"]);
  broken = true;
  await lead.call("whoami");
  await lead.call("whoami");
  const warned = lead.notices.filter(n => n.message.includes("model and effort"));
  expect(warned).toEqual([{ message: "grayboard: couldn't read session facts-root's model and effort; the server gets none: runtime gone", level: "warning" }]);
  broken = false;
  expect(await peers(lead)).toContainEqual(expect.objectContaining({ handle: `${EMAIL}/lead`, model: "openai/gpt-6", effort: "low" }));
});

test("an explicit BUS_IDENTITY binds at a new root's start (#443), created if new (precedence: hosted_core_root.test.ts)", async () => {
  const saved = process.env.BUS_IDENTITY;
  process.env.BUS_IDENTITY = "Pi-Conf";
  try {
    const i = instance();
    await i.ext.start({ id: "conf-root", reason: "startup" });
    await active(i, "conf-root", "pi-conf");
    expect(row("conf-root")).toMatchObject({ name: "pi-conf" });
    expect(i.notices.filter(n => n.level !== "info")).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.BUS_IDENTITY; else process.env.BUS_IDENTITY = saved;
  }
});

test("a BUS_IDENTITY the naming rule refuses is said, and the extension still loads and starts unbound (#543 audit 1)", async () => {
  const saved = process.env.BUS_IDENTITY;
  process.env.BUS_IDENTITY = "no spaces";
  try {
    const i = instance();
    await i.ext.start({ id: "conf-bad-root", reason: "startup" });
    expect(i.notices).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining('BUS_IDENTITY is ignored: invalid identity name "no spaces"') }));
    await until(() => row("conf-bad-root") !== undefined, 10_000, "the root's session row");
    expect(row("conf-bad-root")?.name ?? null).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.BUS_IDENTITY; else process.env.BUS_IDENTITY = saved;
  }
});

test("/new carries the outgoing root's name, bound with this checkout as its place; a carry refused because another live session holds the name leaves the new session unbound, says so once, and /grayboard resume takes it once the name is free", async () => {
  const sender = await root("carry-sender", "sender");
  const first = await root("carry-1", "carrier");
  await first.ext.shutdown("new");
  // The outgoing session released its ownership.
  expect(row("carry-1")).toBeNull();

  const second = instance();
  await second.ext.start({ id: "carry-2", reason: "new" });
  expect(row("carry-2")).toMatchObject({ name: "carrier", root_session_id: null });
  // The Controller's bind says where, as server mode's `grayboard mcp` did.
  expect(srv.app.db.query<{ place: string | null }, [string]>("SELECT place FROM hosted_sessions WHERE session_id = ?").get(hostedId("carry-2"))).toEqual({ place: describeLocation(process.cwd()) });
  await active(second, "carry-2", "carrier");
  await sender.call("dm_send", { to: "carrier", body: "to the carried name" });
  await until(() => second.deliveries.length === 1);
  expect(second.deliveries[0]!.content).toContain("to the carried name");
  expect(first.deliveries).toEqual([]);
  // No notice for a carry that took.
  expect(texts(await second.call("whoami"))).toHaveLength(1);

  await second.ext.shutdown("new");
  // Between the two sessions a session in another pi process (its own grant
  // and connection, none of this process's extension state) takes the name.
  const thief = elsewhere();
  try { expect((await thief.call("bind", { name: "carrier", create: false }, "carry-thief")).isError).toBeUndefined(); }
  finally { await thief.close(); }
  const third = instance();
  await third.ext.start({ id: "carry-3", reason: "new" });
  expect(row("carry-3")?.name ?? null).toBeNull();
  const result = await third.call("whoami");
  expect(texts(result)).toHaveLength(2);
  expect(texts(result)[0]).toMatch(/^grayboard: this session couldn't take the name \S+\/carrier it carried over \(.*alias_held.*\); it is unbound$/);
  expect(payload(result)).toMatchObject({ unbound: true });
  expect(texts(await third.call("whoami"))).toHaveLength(1);

  // The session keeps the carried name, so the resume its notice names takes
  // it once the holder lets go.
  srv.app.mcp.sessions.release(hostedId("carry-thief"), "expired");
  await third.ext.command("resume");
  await active(third, "carry-3", "carrier");
  expect(row("carry-3")).toMatchObject({ name: "carrier" });
});

test("reload detaches, keeping the lease the reloaded instance resumes; quit releases, and a later resume rebinds the remembered name", async () => {
  const sender = await root("reload-sender", "sender");
  const before = await root("reload-1", "reloader");
  const leased = row("reload-1")!;
  expect(leased.lease_deadline).not.toBeNull();
  await before.ext.shutdown("reload");
  expect(row("reload-1")).toMatchObject({ name: "reloader", ownership_id: leased.ownership_id });
  expect(row("reload-1")!.lease_deadline).not.toBeNull();

  const after = instance();
  await after.ext.start({ id: "reload-1", reason: "reload" });
  await active(after, "reload-1", "reloader");
  // The same ownership: the lease was resumed, not replaced.
  expect(row("reload-1")).toMatchObject({ name: "reloader", ownership_id: leased.ownership_id });
  await sender.call("dm_send", { to: "reloader", body: "after reload" });
  await until(() => after.deliveries.length === 1);
  expect(after.deliveries[0]!.content).toContain("after reload");
  expect(before.deliveries).toEqual([]);

  await after.ext.shutdown("quit");
  expect(row("reload-1")).toBeNull();
  const resumed = instance();
  await resumed.ext.start({ id: "reload-1", reason: "resume" });
  await active(resumed, "reload-1", "reloader");
  expect(row("reload-1")!.ownership_id).not.toBe(leased.ownership_id);
});

test("a marked child registers under its root before its first call, writes as the root's name, and ends on shutdown", async () => {
  const parent = await root("parent-1", "parent");
  const other = await root("other-1", "other");
  const child = instance({ child: true, root: "parent-1" });
  await child.ext.start({ id: "child-1", reason: "startup" });
  expect(await child.ext.status()).toContain("session: child-1 (subagent of parent-1)");
  expect(row("child-1")).toBeNull();

  const sent = await child.call("dm_send", { to: "other", body: "from the child" });
  expect(sent.isError).toBeUndefined();
  expect(row("child-1")).toMatchObject({ name: null, root_session_id: hostedId("parent-1") });
  await until(() => other.deliveries.length === 1);
  expect(other.deliveries[0]!.content).toContain(` from="${EMAIL}/parent"`);
  expect(other.deliveries[0]!.content).toContain("from the child");
  expect(child.notices).toEqual([]);

  await child.ext.shutdown("quit");
  expect(row("child-1")).toBeNull();
  // The root keeps its name and delivery.
  expect(row("parent-1")).toMatchObject({ name: "parent" });
  await active(parent, "parent-1", "parent");
});

test("a child whose root's ownership lapsed and was rebound registers again on its next call instead of failing unbound; other refusals don't re-register", async () => {
  const registrations = () => srv.app.db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM access_log WHERE action = 'hosted.child_registered' AND json_extract(detail, '$.child') = ?").get(hostedId("lapse-child"))!.n;
  const parent = await root("lapse-root", "lapser");
  const other = await root("lapse-other", "other");
  const child = instance({ child: true, root: "lapse-root" });
  await child.ext.start({ id: "lapse-child", reason: "startup" });
  expect((await child.call("dm_send", { to: "other", body: "before the lapse" })).isError).toBeUndefined();
  // A refusal that isn't about attribution comes back as is.
  const refused = await child.call("claim_release", { key: "never-taken" });
  expect(refused.isError).toBe(true);
  expect(registrations()).toBe(1);
  const before = row("lapse-root")!.ownership_id;

  // The root's lease lapses (a suspended laptop); the server ends its
  // ownership and every child registered under it.
  srv.app.mcp.sessions.release(hostedId("lapse-root"), "expired");
  expect(row("lapse-child")).toBeNull();
  // The root's Controller rebinds its name under a new ownership.
  await until(() => { const r = row("lapse-root"); return r?.name === "lapser" && r.ownership_id !== before; });
  await active(parent, "lapse-root", "lapser");

  const sent = await child.call("dm_send", { to: "other", body: "after the lapse" });
  expect(sent.isError).toBeUndefined();
  expect(registrations()).toBe(2);
  expect(row("lapse-child")).toMatchObject({ root_session_id: hostedId("lapse-root") });
  await until(() => other.deliveries.some(d => d.content.includes("after the lapse")));
  expect(other.deliveries.at(-1)!.content).toContain(` from="${EMAIL}/lapser"`);
  // Sent once: the refused attempt ran nothing.
  expect(srv.app.db.query("SELECT count(*) AS n FROM messages WHERE body = 'after the lapse'").get()).toEqual({ n: 1 });
});

test("a session whose parent file is a live root's is that root's child, and so is its own child; a fork started after its source shut down is a root and carries the name", async () => {
  const file = join(agentDir, "sessions", "source.jsonl");
  const source = await root("source-1", "forker", { file });

  const nested = instance();
  await nested.ext.start({ id: "nested-1", reason: "startup", file: join(agentDir, "sessions", "nested.jsonl"), parentFile: file });
  expect(await nested.ext.status()).toContain("session: nested-1 (subagent of source-1)");
  expect((await nested.call("whoami")).isError).toBeUndefined();
  expect(row("nested-1")).toMatchObject({ root_session_id: hostedId("source-1") });
  // A grandchild registers directly under the top root.
  const grandchild = instance();
  await grandchild.ext.start({ id: "grandchild-1", reason: "startup", parentFile: join(agentDir, "sessions", "nested.jsonl") });
  expect((await grandchild.call("whoami")).isError).toBeUndefined();
  expect(row("grandchild-1")).toMatchObject({ root_session_id: hostedId("source-1") });
  await grandchild.ext.shutdown("quit");
  await nested.ext.shutdown("quit");
  expect([row("nested-1"), row("grandchild-1")]).toEqual([null, null]);

  // pi shuts the source down before the fork starts.
  await source.ext.shutdown("fork");
  const fork = instance();
  await fork.ext.start({ id: "fork-1", reason: "fork", file: join(agentDir, "sessions", "fork.jsonl"), parentFile: file });
  expect(await fork.ext.status()).toContain("session: fork-1 (root)");
  await active(fork, "fork-1", "forker");
  expect(row("fork-1")).toMatchObject({ name: "forker", root_session_id: null });
});

// pi's RPC mode emits session_start twice for a /new or /fork's session
// (pi 1.4.0: AgentSessionRuntime.newSession rebinds the extensions, then the
// new_session command rebinds them again).
test("a second session_start for the same session is ignored: one root takes the carried name, and its shutdown releases it and carries it on", async () => {
  const first = await root("dup-1", "dupper");
  await first.ext.shutdown("new");
  const second = instance();
  await second.ext.start({ id: "dup-2", reason: "new" });
  await second.ext.start({ id: "dup-2", reason: "new" });
  await active(second, "dup-2", "dupper");
  expect(await second.ext.status()).not.toContain("holds delivery");
  await second.ext.shutdown("new");
  expect(row("dup-2")).toBeNull();
  const third = instance();
  await third.ext.start({ id: "dup-3", reason: "new" });
  await active(third, "dup-3", "dupper");
  await third.ext.shutdown("quit");
});

test("130 sequential children under one root each register and end, so the root never reaches the server's 128-child cap", async () => {
  await root("cap-root", "capped");
  for (let n = 0; n < 130; n++) {
    const child = instance({ child: true, root: "cap-root" });
    await child.ext.start({ id: `cap-child-${n}`, reason: "startup" });
    const result = await child.call("whoami");
    expect(result.isError).toBeUndefined();
    expect(row(`cap-child-${n}`)).toMatchObject({ root_session_id: hostedId("cap-root") });
    await child.ext.shutdown("quit");
  }
  expect(srv.app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM hosted_sessions WHERE root_session_id = ?").get(hostedId("cap-root"))).toEqual({ n: 0 });
}, 120_000);

test("the same session opened twice: the second runs tools-only, says so in its first tool result and in status, and takes delivery when the first quits", async () => {
  const sender = await root("twice-sender", "sender");
  const first = await root("twice", "twin");
  const second = instance();
  await second.ext.start({ id: "twice", reason: "resume" });
  expect(await second.ext.status()).toContain(`delivery: ${HELD}`);
  const result = await second.call("whoami");
  expect(texts(result)[0]).toBe(`grayboard: ${HELD}`);
  expect(payload(result)).toMatchObject({ primary: `${EMAIL}/twin` });
  expect(texts(await second.call("whoami"))).toHaveLength(1);

  // Only the holder admits.
  await sender.call("dm_send", { to: "twin", body: "to the holder" });
  await until(() => first.deliveries.length === 1);

  await first.ext.shutdown("quit");
  // The loser retries the lock every 5 s.
  await active(second, "twice", "twin", 15_000);
  expect(await second.ext.status()).not.toContain(HELD);
  await sender.call("dm_send", { to: "twin", body: "to the new holder" });
  await until(() => second.deliveries.some(d => d.content.includes("to the new holder")));
  expect(second.deliveries.every(d => !d.content.includes("to the holder\n"))).toBe(true);
  expect(first.deliveries).toHaveLength(1);
}, 30_000);

test("a lock loser that takes delivery before its first call shows no stale held notice", async () => {
  const first = await root("stale", "stale-twin");
  const second = instance();
  await second.ext.start({ id: "stale", reason: "resume" });
  expect(await second.ext.status()).toContain(`delivery: ${HELD}`);
  await first.ext.shutdown("quit");
  await active(second, "stale", "stale-twin", 15_000);
  const result = await second.call("whoami");
  expect(texts(result)).toHaveLength(1);
  expect(payload(result)).toMatchObject({ primary: `${EMAIL}/stale-twin` });
}, 30_000);

test("a logout in one session pauses every session on the agentDir: each other session says once that it's signed out, and status names the login, not resume", async () => {
  const a = await root("logout-a", "logout-a");
  const b = await root("logout-b", "logout-b");
  await a.ext.command("logout");
  const signedOut = "grayboard: Signed out of grayboard in pi; run /grayboard login";
  // Each session's watch reads the grant store's epoch every 2 s.
  await until(() => b.notices.length > 0);
  expect(b.notices).toEqual([{ level: "warning", message: signedOut }]);
  for (const [i, id] of [[a, "logout-a"], [b, "logout-b"]] as const) {
    await until(async () => (await i.ext.status()).includes(`  ${id} (${EMAIL}/${id}): paused, `), 5_000, `${id} paused`);
    const status = await i.ext.status();
    expect(status).toContain("sign-in: signed out (logged_out); run /grayboard login");
    expect(status).toContain(`  ${id} (${EMAIL}/${id}): paused, signed out; run /grayboard login`);
    expect(status).not.toContain("/grayboard resume");
  }
  // The session that logged out already said so; its watch adds nothing.
  expect(a.notices).toEqual([{ level: "info", message: "grayboard: signed out; every pi session on this server pauses until run /grayboard login" }]);
  expect(b.notices).toHaveLength(1);
  const call = await b.call("whoami");
  expect(call.isError).toBe(true);
  expect(texts(call).join("\n")).toContain("run /grayboard login");
  // /grayboard resume can't help while signed out, and says why, once, though the sign-out was already said.
  await b.ext.command("resume");
  expect(b.notices).toEqual([{ level: "warning", message: signedOut }, { level: "warning", message: signedOut }]);
});

test("a runner child with no parent session works as an unregistered session, warns once, and ends its session on quit", async () => {
  const loose = instance({ child: true });
  await loose.ext.start({ id: "loose-1", reason: "startup" });
  expect(loose.notices).toEqual([{ level: "warning", message: "grayboard: this pi subagent has no parent session, so its calls go out as an unregistered session" }]);
  expect(await loose.ext.status()).toContain("session: loose-1 (unattributed subagent)");
  expect(payload(await loose.call("whoami"))).toMatchObject({ unbound: true });
  const bound = await loose.call("bind", { name: "loner", create: true });
  expect(bound.isError).toBeUndefined();
  // Its own root on the server, without a lease: no Controller runs for it.
  expect(row("loose-1")).toEqual({ name: "loner", root_session_id: null, ownership_id: expect.any(Number), lease_deadline: null });
  expect(loose.notices).toHaveLength(1);

  await loose.ext.shutdown("quit");
  // The name is free at once, not after the server's idle timeout.
  expect(row("loose-1")).toBeNull();
  await root("loner-next", "loner", {}, false);
});

test("a config.json URL the extension would refuse leaves it loading: start warns, and every tool call and status name the fix", async () => {
  const rule = `${join(stateDir, "config.json")} names a server URL that isn't canonical HTTPS (or HTTP loopback) without credentials, query or fragment; run \`grayboard setup --server <url>\` with one that is`;
  for (const url of ["http://10.0.0.5:8080/mcp", "https://grayboard.example/mcp?team=1"]) {
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ url }));
    const i = instance();
    await i.ext.start({ id: `noncanonical-${instances.length}`, reason: "startup" });
    expect(i.notices).toEqual([{ level: "warning", message: `grayboard: ${rule}` }]);
    const result = await i.call("whoami");
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual([`error: ${rule}`]);
    expect(await i.ext.status()).toBe(rule);
  }
});

test("a sign-in in another pi process restarts this root: one active through a re-login keeps delivering, and one a sign-out paused comes back running", async () => {
  const sender = await root("relogin-sender", "sender");
  const a = await root("relogin-a", "racer");
  const since = Date.now();
  await loginElsewhere("relogin-1");
  // The Controller moved on from the old grant: a pause, or the restart's own records.
  await until(() => recordedSince("relogin-a", since), 10_000, "a record after the re-login");
  await active(a, "relogin-a", "racer", 10_000);
  await sender.call("dm_send", { to: "racer", body: "after the re-login" });
  await until(() => a.deliveries.some(d => d.content.includes("after the re-login")), 10_000, "a DM after the re-login");

  await logoutElsewhere();
  await until(async () => (await a.ext.status()).includes(`  relogin-a (${EMAIL}/racer): paused, `), 10_000, "paused by the sign-out");
  await loginElsewhere("relogin-2");
  // Running again, unbound: a new sign-in never inherits the old grant's name.
  await until(async () => (await a.ext.status()).includes("  relogin-a: unbound, "), 10_000, "restarted after the sign-in");
  expect((await a.call("bind", { name: "racer", create: false })).isError).toBeUndefined();
  await active(a, "relogin-a", "racer");
}, 60_000);

test("/new after a sign-in that dropped the root's name carries nothing: a remembered name counts only under the sign-in it was bound with", async () => {
  const a = await root("stale-a", "stalename");
  await logoutElsewhere();
  await until(async () => (await a.ext.status()).includes(`  stale-a (${EMAIL}/stalename): paused, `), 10_000, "paused by the sign-out");
  // The lease lapsed meanwhile, so the name is free to take.
  srv.app.mcp.sessions.release(hostedId("stale-a"), "expired");
  await loginElsewhere("stale-relogin");
  await until(async () => (await a.ext.status()).includes("  stale-a: unbound, "), 10_000, "restarted unbound");
  await a.ext.shutdown("new");
  const b = instance();
  await b.ext.start({ id: "stale-b", reason: "new" });
  expect(row("stale-b")?.name ?? null).toBeNull();
  const result = await b.call("whoami");
  expect(texts(result)).toHaveLength(1);
  expect(payload(result)).toMatchObject({ unbound: true });
  expect(b.notices).toEqual([]);
}, 60_000);

test("a resume whose rebind is refused says so at once and in the next tool result; once the name is free, /grayboard resume rebinds it and the instructions follow", async () => {
  const first = await root("rebind-s", "rebinder");
  await first.ext.shutdown("quit");
  const thief = elsewhere();
  try { expect((await thief.call("bind", { name: "rebinder", create: false }, "rebind-thief")).isError).toBeUndefined(); }
  finally { await thief.close(); }

  const again = instance();
  await again.ext.start({ id: "rebind-s", reason: "resume" });
  const refused = /^grayboard: this session couldn't take back its name \S+\/rebinder \(Operation refused \(alias_held\).*\); it is unbound$/;
  expect(again.notices).toEqual([{ level: "warning", message: expect.stringMatching(refused) }]);
  const result = await again.call("whoami");
  expect(texts(result)[0]).toMatch(refused);
  expect(payload(result)).toMatchObject({ unbound: true });
  expect(await again.ext.instructions()).toStartWith("This session has no bus name yet.");

  // The Controller's own bind drops the cached unbound instructions.
  srv.app.mcp.sessions.release(hostedId("rebind-thief"), "expired");
  await again.ext.command("resume");
  await active(again, "rebind-s", "rebinder");
  expect(await again.ext.instructions()).toStartWith(`You are "${EMAIL}/rebinder" on grayboard.`);
});

// #523: a child is told it acts as its root's name as a subagent, not given its root's delivery lines.
test("a child's system-prompt instructions are its registered session's, even fetched before its first call", async () => {
  await root("prompt-root", "prompter");
  const child = instance({ child: true, root: "prompt-root" });
  await child.ext.start({ id: "prompt-child", reason: "startup" });
  expect(await child.ext.instructions()).toStartWith(`You are a subagent acting as "${EMAIL}/prompter" on grayboard; what you write shows your ID ${hostedId("prompt-child")} as via.`);
  expect(row("prompt-child")).toMatchObject({ root_session_id: hostedId("prompt-root") });
  expect((await child.call("whoami")).isError).toBeUndefined();
});

test("a pause the Controller's run loop reaches on its own is said at once and in the next tool result", async () => {
  const a = await root("sink-a", "sinker");
  // The same session bound to another name outside this extension: the run
  // loop won't deliver under a binding it didn't make.
  const other = elsewhere();
  try { expect((await other.call("bind", { name: "switched", create: true }, "sink-a")).isError).toBeUndefined(); }
  finally { await other.close(); }
  const paused = "grayboard: delivery paused: Operation failed; run /grayboard resume";
  await until(() => a.notices.length > 0, 10_000, "a notice");
  expect(a.notices).toEqual([{ level: "warning", message: paused }]);
  expect(texts(await a.call("whoami"))[0]).toBe(paused);
});

test("with the server down, /grayboard logout signs out but warns that its revoke is queued, and a failed /grayboard login names login, not resume", async () => {
  const a = await root("down-a", "downer");
  await srv.stop();
  stopped = true;
  await a.ext.command("logout");
  expect(a.notices.at(-1)).toEqual({ level: "warning", message: expect.stringMatching(/^grayboard: Signed out; revoking the grant failed and stays queued for the next login \(.+\); every pi session on this server pauses until run \/grayboard login$/) });
  await a.ext.command("login");
  expect(a.notices.at(-1)).toEqual({ level: "error", message: expect.stringMatching(/^grayboard: sign-in failed: .+; run \/grayboard login to try again$/) });
  expect(a.notices.some(n => n.message.includes("/grayboard resume"))).toBe(false);
  expect(await a.ext.status()).toMatch(/\nlast sign-in: command at \d{4}-\d\d-\d\dT\S+Z: failed: .+/);
}, 30_000);

test("a /reload between an item's admission and its receipt doesn't deliver it twice: admission is idempotent per item across the reload", async () => {
  const sender = await root("dup-sender", "sender");
  let reloaded: Promise<Instance> | undefined;
  // Reloads inside the first delivery, before its receipt goes out.
  const before: Instance = instance(undefined, () => {
    reloaded ??= (async () => {
      await before.ext.shutdown("reload");
      const after = instance();
      await after.ext.start({ id: "dup-1", reason: "reload" });
      return after;
    })();
  });
  await before.ext.start({ id: "dup-1", reason: "startup" });
  expect((await before.call("bind", { name: "duper", create: true })).isError).toBeUndefined();
  await active(before, "dup-1", "duper");
  const first = `direct:${payload(await sender.call("dm_send", { to: "duper", body: "first" })).message_id}`;
  const after = await until(() => reloaded, 10_000, "the reload");
  await active(after, "dup-1", "duper");
  // Items admit in order: once the second arrives, the first was read again and skipped.
  await sender.call("dm_send", { to: "duper", body: "second" });
  await until(() => after.deliveries.some(d => d.content.includes("second")), 10_000, "the second DM");
  expect(before.deliveries.map(d => d.content.includes("first"))).toEqual([true]);
  expect(after.deliveries.filter(d => d.content.includes("first"))).toEqual([]);
  // The re-read after the reload admits nothing new, so records no second admission.
  expect(before.records.filter(r => r.event === "admitted").map(r => r.itemId)).toEqual([first]);
  expect(after.records.filter(r => r.event === "admitted" && r.itemId === first)).toEqual([]);
});

test("a child shut down while its registration is in flight still ends it, so it never counts toward the root's child cap", async () => {
  await root("midreg-root", "midreg");
  const child = instance({ child: true, root: "midreg-root" });
  await child.ext.start({ id: "midreg-child", reason: "startup" });
  const pause = pauseAt("hosted:register:before-txn");
  const call = child.call("whoami").catch(error => error);
  let down: Promise<void>;
  try {
    await pause.hit;
    down = child.ext.shutdown("quit");
  } finally { pause.release(); }
  await down;
  await call;
  expect(row("midreg-child")).toBeNull();
});

test("an item sent while a root's /new reads the carried name stays for the new session: the run loop stopped before the read, so the outgoing one neither delivers nor receipts it", async () => {
  const sender = await root("closing-sender", "sender");
  const first = await root("closing-1", "closer");
  const carried = Controller.prototype.carried;
  const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  // Holds the outgoing session's carry read, which the Controller makes in its
  // queue after stopping the root's run loop (#444): no admit can land in it.
  let running: boolean | undefined;
  const spy = spyOn(Controller.prototype, "carried").mockImplementation(async function (this: Controller, id: string) {
    if (id === "closing-1") {
      // The root's run loop task is private; read only to prove it ended before the read.
      const roots: unknown = Reflect.get(this, "roots");
      running = roots instanceof Map ? !!roots.get(id)?.task : undefined;
      entered();
      await gate;
    }
    return carried.call(this, id);
  });
  let down: Promise<void> | undefined;
  try {
    down = first.ext.shutdown("new");
    await reached;
    expect(running).toBe(false);
    await sender.call("dm_send", { to: "closer", body: "sent while closing" });
  } finally {
    open();
    await down;
    spy.mockRestore();
  }
  expect(first.deliveries).toEqual([]);
  const second = instance();
  await second.ext.start({ id: "closing-2", reason: "new" });
  await active(second, "closing-2", "closer");
  await until(() => second.deliveries.some(d => d.content.includes("sent while closing")), 10_000, "the DM in the new session");
});

// omp (#280): a subagent idle after its run (agent_end) ends its child row;
// revived after its main session's /new, it registers under the new root.
test("an idle child ends its registration, and its next call registers it under the root its marker names then", async () => {
  await root("first-root", "first");
  let marker: Marker = { child: true, root: "first-root" };
  const child = instance(() => marker);
  await child.ext.start({ id: "moving-child", reason: "startup" });
  expect((await child.call("whoami")).isError).toBeUndefined();
  expect(row("moving-child")).toMatchObject({ root_session_id: hostedId("first-root") });

  await child.ext.idle();
  expect(row("moving-child")).toBeNull();

  await root("second-root", "second");
  marker = { child: true, root: "second-root" };
  expect(await child.ext.status()).toContain("session: moving-child (subagent of second-root)");
  expect((await child.call("whoami")).isError).toBeUndefined();
  expect(row("moving-child")).toMatchObject({ root_session_id: hostedId("second-root") });
});

// omp may start a subagent's next run before the last one's agent_end
// reaches the extension: the end waits for the calls already running. The
// call's request is held on its way out; ended before it reaches the server,
// the child would be unregistered and the send refused as unbound. The hold
// lasts until another request naming the child goes out (an end that didn't
// wait) or, at most, a second: the end that waits sends nothing until the
// call lands, so only the bound can end the hold, and no event marks
// "nothing was sent".
test("an idle end waits for a call already running, which completes under its registration", async () => {
  await root("busy-root", "busy");
  const other = await root("busy-other", "other");
  const child = instance({ child: true, root: "busy-root" });
  await child.ext.start({ id: "busy-child", reason: "startup" });
  expect((await child.call("whoami")).isError).toBeUndefined();

  const real = globalThis.fetch;
  let held: (() => void) | undefined, hit: () => void, early = false;
  const holding = new Promise<void>(resolve => { hit = resolve; });
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (!held && body.includes("sent across the idle")) {
      await new Promise<void>(resolve => { held = resolve; hit(); });
    } else if (held && body.includes("busy-child")) {
      early = true;
      held();
    }
    return real(input, init);
  }) as typeof fetch);
  try {
    const running = child.call("dm_send", { to: "other", body: "sent across the idle" });
    await holding;
    const idling = child.ext.idle();
    await until(() => early, 1_000, "an early end").catch(() => {});
    expect(early, "the end went out while the call was held").toBe(false);
    held!();
    const sent = await running;
    expect(sent.isError, texts(sent).join("\n")).toBeUndefined();
    await idling;
  } finally { spy.mockRestore(); }
  expect(row("busy-child")).toBeNull();
  await until(() => other.deliveries.some(d => d.content.includes("sent across the idle")), 10_000, "the DM");
});

test("rootOf walks parentIds to a main session, naming the subagents between outermost first", () => {
  const agents = new Map<string, Agent>([
    ["Main", { raw: "S0", main: true }],
    ["0-Task", { raw: "S1", main: false, parent: "Main" }],
    ["0-Task.0-Explore", { raw: "S2", main: false, parent: "0-Task" }],
    ["Loop-a", { raw: "La", main: false, parent: "Loop-b" }],
    ["Loop-b", { raw: "Lb", main: false, parent: "Loop-a" }],
  ]);
  expect(rootOf(agents, "Main")).toEqual({ root: "S0", via: [] });
  expect(rootOf(agents, "0-Task")).toEqual({ root: "S0", via: ["S1"] });
  expect(rootOf(agents, "0-Task.0-Explore")).toEqual({ root: "S0", via: ["S1", "S2"] });
  expect(rootOf(agents, "gone")).toBeUndefined();
  expect(rootOf(agents, undefined)).toBeUndefined();
  expect(rootOf(agents, "Loop-a")).toBeUndefined();
  // The main session's /new overwrites its entry; its subagents' chains reach the new root.
  agents.set("Main", { raw: "S0-new", main: true });
  expect(rootOf(agents, "0-Task.0-Explore")).toEqual({ root: "S0-new", via: ["S1", "S2"] });
});

// #444: the drift between the pi/omp and Claude Code copies of the hosted
// session shell, each resolved once in hosted-core's client.ts and root.ts.

test("a tool call that throws (an unknown tool's JSON-RPC error) comes back as an error result with the retry and the server's message", async () => {
  const a = await root("throw-a", "thrower");
  const result = await a.call("no_such_tool");
  expect(result.isError).toBe(true);
  expect(texts(result)).toEqual([expect.stringMatching(/^error: Operation failed; call the tool again \(.+no_such_tool.*\)$/)]);
});

test("a lease release that fails at shutdown is said once: the server down, then quit", async () => {
  const a = await root("downquit-a", "downquit");
  await srv.stop();
  stopped = true;
  const before = a.notices.length;
  await a.ext.shutdown("quit");
  expect(a.notices.slice(before)).toEqual([{ level: "warning", message: expect.stringMatching(/^grayboard: delivery degraded: session_end failed \(server_unreachable\)/) }]);
});

test("a lease release that fails at shutdown is said once: a logout elsewhere, then quit", async () => {
  const a = await root("outquit-a", "outquit");
  await logoutElsewhere();
  await until(async () => (await a.ext.status()).includes(`  outquit-a (${EMAIL}/outquit): paused, `), 10_000, "paused by the sign-out");
  await until(() => a.notices.length > 0, 10_000, "the sign-out said");
  const before = a.notices.length;
  await a.ext.shutdown("quit");
  expect(a.notices.slice(before)).toEqual([{ level: "warning", message: expect.stringMatching(/^grayboard: delivery degraded: session_end failed/) }]);
});

test("a sign-in elsewhere while a root's start is in flight waits for that start: resume is never entered beside it", async () => {
  const resume = Controller.prototype.resume, watch = Login.prototype.watch;
  let entered = 0;
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const resumeSpy = spyOn(Controller.prototype, "resume").mockImplementation(async function (this: Controller, id: string) {
    entered++;
    await gate;
    return resume.call(this, id);
  });
  // The session's own watch is the first one made (the Controller's comes with its first resume).
  const changed: (() => void)[] = [];
  const watchSpy = spyOn(Login.prototype, "watch").mockImplementation(function (this: Login, fn: () => void, ms?: number) {
    changed.push(fn);
    return watch.call(this, fn, ms);
  });
  const token = spyOn(Login.prototype, "token");
  try {
    const a = instance();
    const started = a.ext.start({ id: "overlap-1", reason: "startup" });
    await until(() => entered === 1, 10_000, "the start's resume");
    await loginElsewhere("overlap-relogin");
    const calls = token.mock.calls.length;
    changed[0]!();
    await until(() => token.mock.calls.length > calls, 10_000, "the credential change's token read");
    // A second resume would follow within a few file reads; none comes while the first is held.
    await until(() => entered > 1, 2_000).catch(() => {});
    expect(entered).toBe(1);
    open();
    await started;
  } finally {
    open();
    resumeSpy.mockRestore();
    watchSpy.mockRestore();
    token.mockRestore();
  }
});

test("a delivery lock that can't be opened (not BUSY) is said; the root runs tools-only without a held claim, and /grayboard resume retries it", async () => {
  const path = deliveryPath(stateDir, srv.resource, CLIENT, "lockfail-1");
  mkdirSync(path, { recursive: true });
  const a = instance();
  await a.ext.start({ id: "lockfail-1", reason: "startup" });
  expect(a.notices).toEqual([{ level: "error", message: expect.stringMatching(/^grayboard: couldn't take delivery: /) }]);
  const status = await a.ext.status();
  expect(status).toContain("delivery: couldn't take delivery: ");
  expect(status).not.toContain(HELD);
  const bound = await a.call("bind", { name: "lockfail", create: true });
  expect(bound.isError).toBeUndefined();
  expect(texts(bound).join("\n")).not.toContain(HELD);
  rmSync(path, { recursive: true });
  await a.ext.command("resume");
  await active(a, "lockfail-1", "lockfail");
});

test("a root whose delivery lock can't be opened ends the session its calls bound on quit", async () => {
  mkdirSync(deliveryPath(stateDir, srv.resource, CLIENT, "lockquit-1"), { recursive: true });
  const a = instance();
  await a.ext.start({ id: "lockquit-1", reason: "startup" });
  expect((await a.call("bind", { name: "lockquit", create: true })).isError).toBeUndefined();
  expect(row("lockquit-1")).toMatchObject({ name: "lockquit" });
  await a.ext.shutdown("quit");
  expect(row("lockquit-1")).toBeNull();
});

test("/grayboard resume on a root in lock error says so when another process now holds delivery", async () => {
  const path = deliveryPath(stateDir, srv.resource, CLIENT, "lockheld-1");
  mkdirSync(path, { recursive: true });
  const a = instance();
  await a.ext.start({ id: "lockheld-1", reason: "startup" });
  rmSync(path, { recursive: true });
  await root("lockheld-1", "lockheld");
  a.notices.length = 0;
  await a.ext.command("resume");
  expect(a.notices).toEqual([{ level: "warning", message: `grayboard: ${HELD}` }]);
  expect(await a.ext.status()).not.toContain("couldn't take delivery");
});

test("a held root or a child shut down before its first connect finishes doesn't say it couldn't reach the server", async () => {
  await root("earlyquit-1", "earlyquit");
  const held = instance();
  await held.ext.start({ id: "earlyquit-1", reason: "startup" });
  await held.ext.shutdown("new");
  const child = instance({ child: true, root: "earlyquit-1" });
  await child.ext.start({ id: "earlyquit-child", reason: "startup" });
  await child.ext.shutdown("quit");
  expect([...held.notices, ...child.notices].filter(n => n.message.includes("couldn't reach the server"))).toEqual([]);
});

test("a quit while a reloaded root's start is in flight still releases the lease the reload kept", async () => {
  const before = await root("inflight-1", "inflight");
  await before.ext.shutdown("reload");
  expect(row("inflight-1")!.lease_deadline).not.toBeNull();
  const resume = Controller.prototype.resume;
  const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const spy = spyOn(Controller.prototype, "resume").mockImplementation(async function (this: Controller, id: string) {
    if (id === "inflight-1") { entered(); await gate; }
    return resume.call(this, id);
  });
  try {
    const after = instance();
    const started = after.ext.start({ id: "inflight-1", reason: "reload" });
    await reached;
    const down = after.ext.shutdown("quit");
    open();
    await down;
    await started;
  } finally {
    open();
    spy.mockRestore();
  }
  expect(row("inflight-1")).toBeNull();
});

test("a tools-only root (delivery held elsewhere) refuses bind and unbind: the holder owns the binding", async () => {
  await root("held-bind", "holder");
  const second = instance();
  await second.ext.start({ id: "held-bind", reason: "resume" });
  for (const [tool, args] of [["bind", { name: "intruder", create: true }], ["unbind", {}]] as const) {
    const refused = await second.call(tool, args);
    expect(refused.isError).toBe(true);
    expect(texts(refused).at(-1)).toBe(`error: ${HELD}; bind and unbind work from the process that holds delivery`);
  }
  expect(row("held-bind")).toMatchObject({ name: "holder" });
});

test("an unreadable session state file before the first start is said, each failure once", async () => {
  const path = sessionPath(stateDir, srv.resource, CLIENT, "corrupt-1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json");
  const a = instance();
  await a.ext.start({ id: "corrupt-1", reason: "startup" });
  await until(() => a.notices.length > 0, 10_000, "a notice");
  await a.ext.shutdown("quit");
  // The restore couldn't read the file; the save of its own record couldn't
  // either (FileStorage.set reads before it writes); the start's storage read
  // failed on it too. Each is said once, whatever the epoch.
  expect(a.notices.map(n => `${n.level} ${n.message}`).sort()).toEqual([
    "error grayboard: couldn't start delivery: JSON Parse error: Unexpected identifier \"not\"",
    "warning grayboard: delivery degraded: Diagnostic persistence unavailable; approval is unchanged",
    "warning grayboard: delivery degraded: Diagnostic restore unavailable; approval is unchanged",
  ]);
});

// ---- sign-in (#581) ----

const STARTED = "grayboard: sign-in started: ask the user to open the link pi shows (/grayboard login shows it again), then call a grayboard tool again";
const SIGNED_IN = { level: "info", message: "grayboard: signed in" };
// The URLs the fake system browser was asked to open.
const opened = () => existsSync(join(agentDir, "opened")) ? readFileSync(join(agentDir, "opened"), "utf8").split("\n").filter(Boolean) : [];
// The sign-in URL said on `i`'s notice line (the user's, never the model's).
const linkSaid = (i: Instance) => until(() => i.notices.map(n => /^grayboard: sign in at (\S+)$/.exec(n.message)?.[1]).find(Boolean), 10_000, "the sign-in link on the notice line");
const LAST = (origin: string, outcome: string) => new RegExp(`\\nlast sign-in: ${origin} at \\d{4}-\\d\\d-\\d\\dT\\S+Z: ${outcome}(\\n|$)`);
// A signed-out call's result: the started note first, and the link nowhere in it.
function offered(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(texts(result)[0]).toBe(STARTED);
  expect(texts(result).join("\n")).not.toContain(srv.issuer);
}

test("an unattributed subagent's signed-out call offers a sign-in: the link only on the notice line, no browser, and opening it signs the session in", async () => {
  await logoutElsewhere();
  const a = instance({ child: true }, undefined, undefined, true);
  await a.ext.start({ id: "offer-loose", reason: "startup" });
  offered(await a.call("whoami"));
  const url = await linkSaid(a);
  expect(url).toStartWith(`${srv.issuer}/`);
  // An offer's flow never opens a window: a model's call did it.
  expect(opened()).toEqual([]);
  expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
  await until(() => a.notices.some(n => n.message === SIGNED_IN.message), 10_000, "signed in said");
  expect((await a.call("whoami")).isError).toBeUndefined();
  expect(await a.ext.status()).toMatch(LAST("offer", "signed in"));
}, 30_000);

test("a headless (print-mode) root's signed-out call makes no offer: it names the login and starts no flow", async () => {
  await logoutElsewhere();
  const a = instance();
  await a.ext.start({ id: "offer-print", reason: "startup" });
  const result = await a.call("whoami");
  expect(result.isError).toBe(true);
  expect(texts(result).join("\n")).toContain(LOGIN_ACTION);
  expect(texts(result).join("\n")).not.toContain("sign-in started");
  expect(signins().flow).toBeUndefined();
  expect(a.notices.some(n => n.message.startsWith("grayboard: sign in at "))).toBe(false);
});

test("an in-process subagent (omp's task) takes its root's mode for an offer; its parked runtime's quit leaves the flow running, and the root says the outcome", async () => {
  await logoutElsewhere();
  const r = instance({ child: false }, undefined, undefined, true);
  await r.ext.start({ id: "mode-root", reason: "startup" });
  // omp starts a task subagent without a mode, so its own reads print.
  const c = instance({ child: true, root: "mode-root" });
  await c.ext.start({ id: "mode-child", reason: "startup" });
  offered(await c.call("whoami"));
  // The link speaks through the current root's line.
  const url = await linkSaid(r);
  expect(c.notices.some(n => n.message.startsWith("grayboard: sign in at "))).toBe(false);
  // omp quits a subagent's runtime when it parks: the user's sign-in goes on.
  await c.ext.shutdown("quit");
  expect(signins().flow?.abort.signal.aborted).toBe(false);
  expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
  await until(() => r.notices.some(n => n.message === SIGNED_IN.message), 10_000, "signed in said by the root");
  await until(async () => (await r.ext.status()).includes("  mode-root: unbound, "), 10_000, "the root restarted signed in");
  expect(await r.ext.status()).toMatch(LAST("offer", "signed in"));
}, 30_000);

test("/grayboard login joins an offer's pending flow: one flow, its link said again and opened in the browser, its outcome said once", async () => {
  await logoutElsewhere();
  const a = instance({ child: false }, undefined, undefined, true);
  await a.ext.start({ id: "join-root", reason: "startup" });
  offered(await a.call("whoami"));
  const url = await linkSaid(a);
  const flow = signins().flow;
  expect(opened()).toEqual([]);
  const login = a.ext.command("login");
  await until(() => opened().length === 1, 10_000, "the browser opened");
  expect(opened()).toEqual([url]);
  expect(signins().flow).toBe(flow);
  expect(a.notices.filter(n => n.message === `grayboard: sign in at ${url}`)).toHaveLength(2);
  expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
  await login;
  expect(a.notices.filter(n => n.message === SIGNED_IN.message)).toHaveLength(1);
  // The joined flow is the offer's: status names its origin.
  expect(await a.ext.status()).toMatch(LAST("offer", "signed in"));
  await until(async () => (await a.ext.status()).includes("  join-root: unbound, "), 10_000, "restarted signed in");
}, 30_000);

test("a flow that ends while no root runtime is current (a session switch's gap) keeps its outcome, and the next root says it once and starts signed in", async () => {
  await logoutElsewhere();
  const a = instance({ child: false }, undefined, undefined, true);
  await a.ext.start({ id: "gap-a", reason: "startup" });
  offered(await a.call("whoami"));
  const url = await linkSaid(a);
  // The switch: the outgoing root finished, the next hasn't begun.
  await a.ext.shutdown("new");
  expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
  const last = await until(() => signins().last, 10_000, "the flow's end recorded");
  expect(last).toMatchObject({ origin: "offer", outcome: "signed in" });
  expect(last.said).toBeUndefined();
  expect(a.notices.some(n => n.message === SIGNED_IN.message)).toBe(false);
  const b = instance({ child: false }, undefined, undefined, true);
  await b.ext.start({ id: "gap-b", reason: "new" });
  expect(b.notices.filter(n => n.message === SIGNED_IN.message)).toHaveLength(1);
  expect(signins().last?.said).toBe(true);
  await until(async () => (await b.ext.status()).includes("  gap-b: unbound, "), 10_000, "the next root running signed in");
}, 30_000);

test("a /grayboard login pending across a session switch leaves an outcome that ends in the gap to the next root, which says it once", async () => {
  await logoutElsewhere();
  const a = instance({ child: false }, undefined, undefined, true);
  await a.ext.start({ id: "gapcmd-a", reason: "startup" });
  const login = a.ext.command("login");
  const url = await linkSaid(a);
  await a.ext.shutdown("new");
  expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
  await login;
  expect(signins().last).toMatchObject({ origin: "command", outcome: "signed in" });
  expect(signins().last?.said).toBeUndefined();
  const b = instance({ child: false }, undefined, undefined, true);
  await b.ext.start({ id: "gapcmd-b", reason: "new" });
  expect(b.notices.filter(n => n.message === SIGNED_IN.message)).toHaveLength(1);
  expect(await b.ext.status()).toMatch(LAST("command", "signed in"));
}, 30_000);
