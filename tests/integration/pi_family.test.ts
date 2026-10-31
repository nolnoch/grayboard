// The hosted pi-family extension (#279) in-process: createGrayboard driven
// through a recording Harness against a real server whose public URL is its
// listen address, signed in with a grant seeded for the built-in pi client.
// Covers a root's bind and push delivery, name carry across /new and /fork,
// reload detach and quit release, the child rule (runner marker, the
// in-process registry, fork-is-root), child registration and end under the
// server's child cap, the delivery-lock loser, and the unattributed runner
// child.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createGrayboard, type Grayboard, type Level, type Marker, type SessionInfo } from "../../adapters/pi-family/extension.ts";
import { ToolProxy, type NativeTool } from "../../adapters/hosted-core/src/proxy.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { GRAYBOARD_SESSION_META } from "../../src/server/oauth-config.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { hostedServer, seedGrant, type HostedServer } from "../support/hosted_oauth.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
const EMAIL = "alice@example.com";
const HELD = "another pi process holds delivery for this session";

let srv: HostedServer, agentDir: string, user: number;
const instances: Instance[] = [];

beforeEach(async () => {
  srv = hostedServer();
  agentDir = realpathSync(mkdtempSync(join(tmpdir(), "gb-pi-family-")));
  const stateDir = join(agentDir, "grayboard");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ url: srv.resource }));
  user = (await seedGrant(srv, stateDir, CLIENT, EMAIL)).authed.user_id;
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map(i => i.ext.shutdown("quit")));
  await srv.stop();
  rmSync(agentDir, { recursive: true, force: true });
});

// One extension runtime (one pi session) with a Harness that records what the
// extension registers, delivers and notifies.
type Instance = {
  ext: Grayboard;
  deliveries: { content: string; wake: boolean }[];
  notices: { message: string; level: Level }[];
  tools(): NativeTool[];
  call(tool: string, args?: Record<string, unknown>): Promise<CallToolResult>;
};
function instance(marker: Marker = { child: false }): Instance {
  let tools: NativeTool[] = [];
  let run: ((tool: string, args: Record<string, unknown>) => Promise<CallToolResult>) | undefined;
  const self: Instance = {
    deliveries: [], notices: [],
    ext: createGrayboard({
      name: "pi", clientId: CLIENT, version: "1.0.0", agentDir,
      marker: () => marker,
      register: (list, call) => { tools = list; run = call; },
      deliver: (content, wake) => { self.deliveries.push({ content, wake }); },
      notify: (message, level) => { self.notices.push({ message, level }); },
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
  "SELECT name, root_session_id, ownership_id, lease_deadline FROM hosted_sessions WHERE session_id = ?").get(hostedId(raw));

// The root's line in /grayboard status says it is subscribed under `name`.
const active = (i: Instance, id: string, name: string, ms = 5_000) =>
  until(async () => (await i.ext.status()).includes(`  ${id} (${name}): active,`), ms, `${id} active as ${name}`);

async function root(id: string, name: string, extra: Partial<SessionInfo> = {}, create = true) {
  const i = instance();
  await i.ext.start({ id, reason: "startup", ...extra });
  const bound = await i.call("bind", { name, create });
  expect(bound.isError).toBeUndefined();
  await active(i, id, name);
  return i;
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
  expect((await beta.call("dm_send", { to: "alpha", body: "hello from beta" })).isError).toBeUndefined();
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
});

test("/new carries the outgoing root's name; a carry refused because another live session holds the name leaves the new session unbound and says so once", async () => {
  const sender = await root("carry-sender", "sender");
  const first = await root("carry-1", "carrier");
  await first.ext.shutdown("new");
  // The outgoing session released its ownership.
  expect(row("carry-1")).toBeNull();

  const second = instance();
  await second.ext.start({ id: "carry-2", reason: "new" });
  expect(row("carry-2")).toMatchObject({ name: "carrier", root_session_id: null });
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
  const { token } = issueOAuth(srv.app.repo, srv.resource, EMAIL, ["grayboard:delivery", "grayboard:tools"], Date.now(), CLIENT);
  const elsewhere = new ToolProxy({
    wire: { url: srv.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" }, delivery: { mode: "poll", source: "grayboard" } },
    harness: "pi", loginAction: "run /grayboard login", auth: { token: async () => token }, report: () => {},
  });
  try { expect((await elsewhere.call("bind", { name: "carrier", create: false }, "carry-thief")).isError).toBeUndefined(); }
  finally { await elsewhere.close(); }
  const third = instance();
  await third.ext.start({ id: "carry-3", reason: "new" });
  expect(row("carry-3")?.name ?? null).toBeNull();
  const result = await third.call("whoami");
  expect(texts(result)).toHaveLength(2);
  expect(texts(result)[0]).toMatch(/^grayboard: this session couldn't take the name carrier it carried over \(.*identity_in_use.*\); it is unbound$/);
  expect(payload(result)).toMatchObject({ unbound: true });
  expect(texts(await third.call("whoami"))).toHaveLength(1);
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
  expect(payload(result)).toMatchObject({ name: "twin" });
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
  expect(payload(result)).toMatchObject({ name: "stale-twin" });
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
    await until(async () => (await i.ext.status()).includes(`  ${id} (${id}): paused, `), 5_000, `${id} paused`);
    const status = await i.ext.status();
    expect(status).toContain("sign-in: signed out (logged_out); run /grayboard login");
    expect(status).toContain(`  ${id} (${id}): paused, signed out; run /grayboard login`);
    expect(status).not.toContain("/grayboard resume");
  }
  // The session that logged out already said so; its watch adds nothing.
  expect(a.notices).toEqual([{ level: "info", message: "grayboard: signed out; every pi session on this server pauses until run /grayboard login" }]);
  expect(b.notices).toHaveLength(1);
  const call = await b.call("whoami");
  expect(call.isError).toBe(true);
  expect(texts(call).join("\n")).toContain("run /grayboard login");
  // /grayboard resume can't help while signed out, and says why.
  await b.ext.command("resume");
  expect(b.notices.at(-1)).toEqual({ level: "warning", message: signedOut });
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
