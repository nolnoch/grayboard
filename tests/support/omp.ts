// The omp scenarios (#280): the real omp coding agent (the pinned
// devDependency, a Bun program) in RPC mode against a scripted fake model,
// with the hosted extension exactly as the binary embeds it
// (adapterBundle("omp")), set up as `grayboard setup --server` leaves it:
// <agentDir>/extensions/grayboard.js, <agentDir>/grayboard/config.json {url}
// and no grayboard MCP entry. omp speaks pi's RPC protocol, so the Pi class
// and the hosted helpers come from tests/support/pi.ts; the hosted scenarios
// omp shares with pi live in tests/support/hosted_harness.ts.
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { hostTools, snapshotTools } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { adapterBundle } from "../../src/cli/adapters.ts" with { type: "macro" };
import { sha256Hex } from "../../src/shared/hash.ts";
import { cleanEnv, localEnv } from "./env.ts";
import { messageText, onChannelDm, startFakeModel, taskFanout, type ChatRequest, type FakeModel } from "./fake_model.ts";
import { browse, seedGrant, type HostedServer } from "./hosted_oauth.ts";
import { factsOf, hostedRow, leased, PEER, Pi, pingPong, requestTools, resultText, scripted, statusOf, stopAll, systemText, toolResultNamed } from "./pi.ts";
import { localSession, stopSession, type Session } from "./mcp.ts";
import { accessAudits } from "./audit.ts";
import { grayboardChildPids, grayboardDescendants, processDescendants, sigkill, STOP_READING } from "./procs.ts";
import { CLI, REFUSING_MCP, ROOT } from "./paths.ts";
import { until } from "./until.ts";
import { hostedCarryScenario, hostedRefreshLogoutScenario, hostedStaticScenario, loginNotice, named, withHosted, type HostedHarness } from "./hosted_harness.ts";

type OmpPackage = { version: string; bin: { omp: string } };
const OMP_PKG = join(ROOT, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
const OMP: OmpPackage = JSON.parse(readFileSync(OMP_PKG, "utf8"));
const OMP_CLI = join(dirname(OMP_PKG), OMP.bin.omp);
const OMP_ARGS = ["--mode", "rpc", "--provider", "fake", "--model", "fake-1", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files", "--no-title"];

const BUNDLE = adapterBundle("omp");
const LOCAL_BUNDLE = adapterBundle("omp", "local");
const OMP_CLIENT = "grayboard-omp";
export const PREFIX = "mcp__grayboard_";
const LOGIN_NOTICE = loginNotice("omp");
const GRAYBOARD_TOOLS = hostTools(snapshotTools()).map((t) => PREFIX + t.name).sort();

const agentDirOf = (dir: string) => join(dir, "omp-agent");
const stateDirOf = (dir: string) => join(agentDirOf(dir), "grayboard");

// omp creates <agentDir>/agent.db without a transaction, so two omp processes
// opening a fresh agentDir at once can both run CREATE TABLE settings and one
// dies ("table settings already exists"). True once the first has created it.
function ompDbReady(dir: string): boolean {
  const path = join(agentDirOf(dir), "agent.db");
  if (!existsSync(path)) return false;
  try {
    using db = new Database(path, { readonly: true });
    return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() != null;
  } catch {
    return false;
  }
}

// Written once per scenario, before any omp starts. models.yml and config.yml
// take JSON (YAML's superset). tools.xdev off exposes the grayboard tools
// top-level, as the scripts call them, instead of behind omp's xd:// devices;
// either way omp runs the extension's registered tool. `settings` adds to
// config.yml; `reasoning` lets the fake model take a thinking level.
function installHosted(dir: string, srv: HostedServer, modelPort: number, settings: Record<string, unknown>, reasoning = false): void {
  const agentDir = agentDirOf(dir), bin = join(dir, "bin");
  for (const d of [join(agentDir, "extensions"), stateDirOf(dir), bin, join(dir, "home")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentDir, "extensions", "grayboard.js"), BUNDLE);
  writeFileSync(join(stateDirOf(dir), "config.json"), JSON.stringify({ url: srv.resource }));
  writeConfig(agentDir, modelPort, settings, reasoning);
  for (const opener of ["open", "xdg-open"]) writeFileSync(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

// The fake model as omp's only provider, and config.yml with `settings`.
// A reasoning model changes omp's requests, so only a scenario that sets a thinking level asks for one.
function writeConfig(agentDir: string, modelPort: number, settings: Record<string, unknown>, reasoning = false): void {
  writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
    providers: { fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1", ...(reasoning ? { reasoning: true } : {}) }] } },
  }));
  writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ tools: { xdev: false }, ...settings }));
}

function startHostedOmp(dir: string, procs: ChildProcess[], { persist = false, session, env = {} }: { persist?: boolean; session?: string; env?: Record<string, string> } = {}): Pi {
  const proc = spawn(process.execPath, [OMP_CLI, ...OMP_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--resume", session] : [])], {
    cwd: dir,
    env: cleanEnv({
      HOME: join(dir, "home"), GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"), PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: agentDirOf(dir), ...env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

// The server's session id for omp's session `raw`.
const serverId = (srv: HostedServer, raw: string): string | undefined => srv.app.db.query<{ session_id: string }, [string, string]>(
  "SELECT session_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(OMP_CLIENT, raw)?.session_id;
// omp finished its run: settled (nothing streaming, queued or pending).
const idle = (omp: Pi, ms = 30_000) => until(async () => (await omp.command({ type: "get_state" })).isSettled === true, ms, "omp settled");

// The hosted audit rows of `action`, oldest first.
const audits = (srv: HostedServer, action: string) => accessAudits(srv.app.db, action);
// The server sessions registered as children of `root` right now.
const liveChildren = (srv: HostedServer, root: string): string[] => srv.app.db.query<{ session_id: string }, [string]>(
  "SELECT session_id FROM hosted_sessions WHERE root_session_id = ?").all(root).map((r) => r.session_id);
// A model request made by a task subagent (taskFanout's child prompt).
const childOf = (req: ChatRequest): string | undefined => /\bfake-child-\d+\b/.exec(messageText(req.messages.find((m) => m.role === "user") ?? { role: "user", content: "" }))?.[0];
const fromChild = (req: ChatRequest): boolean => childOf(req) !== undefined;
// The non-tool text of a request: the system prompt and any message omp
// injected (a custom message reaches the model as developer or user).
const promptOf = (req: ChatRequest): string => req.messages.filter((m) => m.role !== "tool").map(messageText).join("\n");
// The request that carried DM `ping` holds `name`'s instructions once and not
// the unbound ones: a turn a push started gets them refreshed or injected (#441).
function expectInstructed(model: FakeModel, ping: number, name: string): void {
  const req = model.requests.find((r) => r.body.messages.some((m) => messageText(m).includes(`<channel source="grayboard" message_id="${ping}"`)));
  expect(req).toBeDefined();
  expect(promptOf(req!.body).split(`You are "alice@example.com/${name}" on grayboard.`)).toHaveLength(2);
  expect(promptOf(req!.body)).not.toContain("no bus name yet");
}

// omp in the shared hosted scenarios (tests/support/hosted_harness.ts).
// `settings` adds to config.yml; `reasoning` lets the fake model take a thinking level.
function ompHarness(settings: Record<string, unknown> = {}, reasoning = false): HostedHarness {
  return {
    name: "omp", version: OMP.version, client: OMP_CLIENT, prefix: PREFIX,
    stateDir: stateDirOf, install: (dir, srv, modelPort) => installHosted(dir, srv, modelPort, settings, reasoning), start: startHostedOmp, idle,
    stateTimeout: 30_000,
    onServerTimeout: 20_000,
    // /fork of the current session: the fork's file also holds the records it copied from the session it left (#504).
    fork: async (omp) => {
      expect((await omp.command({ type: "fork" })).cancelled).toBe(false);
    },
    forkCopiesRecords: true,
    // A turn a push started carries the bound name's instructions (#441).
    delivered: expectInstructed,
    // omp creates agent.db without a transaction (ompDbReady): b starts once a has created it.
    beforeSecondStart: (dir) => until(() => ompDbReady(dir), 30_000, "omp agent.db created"),
    // The logout notice lands after the prompt command returns.
    logoutNoticeLags: true,
    // A root whose subscription closed first sits in `retrying` until its next reopen meets the sign-out (#606).
    pauseLags: true,
  };
}
const OMP_HARNESS = ompHarness();

// The spec's load smoke for omp: the bundle the CLI's macro emits, loaded by
// the pinned omp under Bun with an isolated HOME and a seeded grant. Its
// value import of @oh-my-pi/pi-coding-agent resolved to the host (getAgentDir
// named the isolated agentDir: the grant was read there, no login notice).
// The status's session line carries omp's own id (session_start ran); the
// root's unbound Controller line needs the MCP client's whoami round trip;
// the delivery lock file exists (node:sqlite under Bun took it). No grayboard
// process runs, and quitting leaves nothing leased.
export function ompHostedLoadSmoke(dir: string): Promise<void> {
  return withHosted(OMP_HARNESS, dir, [], async ({ srv, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    const controller = `\n  ${sessionId}: unbound, Root approved, unbound; bind(name) to take one`;
    const status = await until(async () => {
      const s = await statusOf(omp);
      return s.includes(controller) ? s : undefined;
    }, 20_000, "the root's Controller line");
    expect(status).toContain(`\nsign-in: signed in\nsession: ${sessionId} (root)\n`);
    expect(status).not.toContain("\ndelivery: ");
    expect(omp.stderr).not.toContain("Failed to load extension");
    expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
    expect(omp.notices()).not.toContain(LOGIN_NOTICE);
    expect(existsSync(deliveryPath(stateDirOf(dir), srv.resource, OMP_CLIENT, sessionId))).toBe(true);
    expect(hostedRow(srv, OMP_CLIENT, sessionId)?.name).toBeNull();
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0, 10_000, "nothing leased after quit");
  });
}

// Signed out at start, the extension says how to sign in; /grayboard login
// walks the server's real consent page; bind through the model's tool call
// takes the delivery lease; a peer's DM arrives as a new turn once; a local
// file goes out with dm_send and a peer's file comes in with attachment_get.
// No grayboard process runs.
export function ompHostedScenario(dir: string): Promise<void> {
  const report = "quarterly report\n", notes = "peer notes\n";
  return withHosted(ompHarness({}, true), dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-task", create: true } }]),
    scripted("send report", [{ tool: `${PREFIX}dm_send`, args: { to: PEER, body: "report attached", attachments: [join(dir, "report.txt")] } }]),
    scripted("whoami", [{ tool: `${PREFIX}whoami`, args: {} }]),
  ], async ({ srv, model, peer, start }) => {
    writeFileSync(join(dir, "report.txt"), report);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);

    await until(() => omp.notices().includes(LOGIN_NOTICE), 20_000, "the login notice");
    expect(omp.stderr).not.toContain("Failed to load extension");
    expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
    expect(await statusOf(omp)).toContain(`grayboard: server: ${srv.resource}\nsign-in: signed out (never signed in); run /grayboard login\nsession: ${sessionId} (root)`);

    // /grayboard login prints the sign-in URL (the no-op `open` "opened" it);
    // the browser approves on the server's consent page.
    const login = omp.command({ type: "prompt", message: "/grayboard login" }, 60_000);
    const url = await until(() => omp.notices().map((n) => /^grayboard: sign in at (\S+)$/.exec(n)?.[1]).find(Boolean), 15_000, "sign-in URL");
    expect(url).toStartWith(`${srv.issuer}/`);
    expect(await browse(srv.issuer, url, "omp")).toContain("Signed in to grayboard");
    await login;
    await until(() => omp.notices().includes("grayboard: signed in"), 15_000, "signed in");
    expect(omp.notices().filter((n) => n.includes("couldn't open a browser"))).toEqual([]);
    expect(await statusOf(omp)).toContain("\nsign-in: signed in\n");

    // The model binds through mcp__grayboard_bind, which takes the lease.
    await omp.command({ type: "prompt", message: "bind" });
    const bound = await toolResultNamed(omp, `${PREFIX}bind`);
    expect(bound.isError).toBeFalsy();
    expect(resultText(bound)).toStartWith('Bound to "omp-task"');
    await until(() => leased(srv, OMP_CLIENT, sessionId, "omp-task"), 15_000, "omp-task holds the lease");
    // Its requests report omp's model and thinking level; `inherit` is none (#364).
    const { thinkingLevel } = await omp.command({ type: "get_state" }, 30_000);
    expect(factsOf(srv, OMP_CLIENT, sessionId)).toEqual({ model: "fake/fake-1", effort: thinkingLevel && thinkingLevel !== "inherit" ? thinkingLevel : null });
    await idle(omp);
    // A level, then `inherit`: the next call clears the server's effort (#563 item 1).
    for (const [level, effort] of [["high", "high"], ["inherit", null]] as const) {
      await omp.command({ type: "set_thinking_level", level });
      expect((await omp.command({ type: "get_state" })).thinkingLevel ?? null).toBe(effort);
      await omp.command({ type: "prompt", message: "whoami" });
      await until(() => factsOf(srv, OMP_CLIENT, sessionId)?.effort === effort, 15_000, `the server's effort ${effort}`);
      await idle(omp);
    }
    const first = model.requests[0]!.body;
    expect(requestTools(first).filter((n) => n.startsWith(PREFIX)).sort()).toEqual(GRAYBOARD_TOOLS);
    expect(systemText(first)).toContain("no bus name yet");
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await idle(omp);

    // A DM wakes the session once: one copy, one turn, one reply; the
    // receipt moves omp-task's cursor past it.
    const asked = model.requests.length;
    const ping = await pingPong(srv, peer, "omp-task");
    await until(async () => (await srv.app.repo.cursors.directFor(srv.app.repo.read, "alice@example.com/omp-task")) >= ping, 15_000, "the receipt advances the cursor");
    await idle(omp);
    const woken = model.requests[asked]!.body;
    expect(messageText(woken.messages.at(-1)!)).toContain(`<channel source="grayboard" message_id="${ping}" from="${PEER}"`);
    // omp runs before_agent_start only for a user prompt; the entry rewrites
    // the stale (unbound) instructions in the wake's request (#441).
    expect(systemText(woken)).toContain('You are "alice@example.com/omp-task" on grayboard.');
    expect(systemText(woken)).not.toContain("no bus name yet");
    expect((await omp.messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${ping}\\"`))).toHaveLength(1);
    expect(srv.app.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM messages WHERE parent_id = ?").get(ping)!.n).toBe(1);

    // The next user prompt carries the server's instructions for omp-task.
    // dm_send with a local file uploads it with the message; the peer gets it intact.
    const prompted = model.requests.length;
    await omp.command({ type: "prompt", message: "send report" });
    const next = systemText((await until(() => model.requests[prompted], 15_000, "the send report request")).body);
    expect(next).toContain('You are "alice@example.com/omp-task" on grayboard.');
    expect(next).not.toContain("no bus name yet");
    const sent = await until(() => srv.app.db.query<{ id: number }, []>("SELECT id FROM messages WHERE body = 'report attached' AND sender = 'alice@example.com/omp-task'").get(), 30_000, "the report DM");
    const files = srv.app.db.query<{ id: number; filename: string; sha256: string }, [number]>("SELECT id, filename, sha256 FROM attachments WHERE message_id = ?").all(sent.id);
    expect(files).toEqual([{ id: expect.any(Number), filename: "report.txt", sha256: sha256Hex(new TextEncoder().encode(report)) }]);
    expect(readFileSync((await peer.call("attachment_get", { id: files[0]!.id })).path, "utf8")).toBe(report);
    await idle(omp);

    // A peer's file arrives with its DM; the model's attachment_get saves it
    // under GRAYBOARD_ATTACHMENTS_DIR, this bus's folder.
    writeFileSync(join(peer.dir, "notes.txt"), notes);
    const withFile = (await peer.call("dm_send", { to: "alice@example.com/omp-task", body: "notes attached", attachments: [join(peer.dir, "notes.txt")] })).message_id;
    const fileId = srv.app.db.query<{ id: number }, [number]>("SELECT id FROM attachments WHERE message_id = ?").get(withFile)!.id;
    const saved = await toolResultNamed(omp, `${PREFIX}attachment_get`);
    expect(saved.isError).toBeFalsy();
    const got = JSON.parse(resultText(saved)) as { path: string };
    expect(got.path).toBe(join(dir, "saved", new URL(srv.resource).host.replace(/[^A-Za-z0-9.-]/g, "_"), `${fileId}-notes.txt`));
    expect(readFileSync(got.path, "utf8")).toBe(notes);
    await idle(omp);
    expect(grayboardDescendants(omp.pid)).toEqual([]);

    // Quitting releases the lease and ends the session.
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !hostedRow(srv, OMP_CLIENT, sessionId), 10_000, "released on quit");
  });
}

// A task run with two subagents, each held open (a bash gate) after its
// dm_send: each send is attributed to a child registered under main's
// session, a peer's DM during the run reaches main only, and both children
// are ended once their runs finish (omp keeps a finished subagent live for
// its idle TTL, so this is the agent_end release, not shutdown).
export function ompHostedTaskScenario(dir: string): Promise<void> {
  const gate = join(dir, "go");
  return withHosted(OMP_HARNESS, dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-task", create: true } }]),
    ...taskFanout(2, /^fan out$/, (i) => [
      { tool: `${PREFIX}dm_send`, args: { to: PEER, body: `child ${i}` } },
      { tool: "bash", args: { command: `while [ ! -f ${gate} ]; do sleep 0.1; done` } },
    ]),
  ], async ({ srv, model, peer, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    await omp.command({ type: "prompt", message: "bind" });
    await until(() => leased(srv, OMP_CLIENT, sessionId, "omp-task"), 30_000, "omp-task holds the lease");
    await idle(omp);
    const root = serverId(srv, sessionId)!;

    // Both children send while held open; each send is the child's own write,
    // under main's root and name, from a child registered with no intermediates.
    await omp.command({ type: "prompt", message: "fan out" });
    const writes = await until(() => {
      const w = audits(srv, "hosted.write").filter((a) => a.detail.tool === "dm_send");
      return w.length === 2 ? w : undefined;
    }, 60_000, "both children's sends");
    const registered = audits(srv, "hosted.child_registered");
    expect(registered.map((r) => r.target)).toEqual([root, root]);
    expect(registered.map((r) => r.detail.via)).toEqual([[], []]);
    const children = registered.map((r) => r.detail.child as string);
    expect(new Set(children).size).toBe(2);
    expect(children).not.toContain(root);
    expect(new Set(registered.map((r) => r.detail.source_session_id)).size).toBe(2);
    expect(registered.map((r) => r.detail.source_session_id)).not.toContain(sessionId);
    expect(writes.map((w) => w.target).sort()).toEqual([...children].sort());
    for (const w of writes) expect(w.detail).toMatchObject({ session: w.target, root, held: ["alice@example.com/omp-task"] });
    expect(srv.app.db.query<{ body: string; sender: string }, []>("SELECT body, sender FROM messages WHERE body LIKE 'child %' ORDER BY body").all())
      .toEqual([0, 1].map((i) => ({ body: `child ${i}`, sender: "alice@example.com/omp-task" })));
    expect(liveChildren(srv, root).sort()).toEqual([...children].sort());
    // A subagent's requests carry no grayboard instructions.
    const childRequests = model.requests.filter((r) => fromChild(r.body));
    expect(childRequests.length).toBeGreaterThan(0);
    for (const r of childRequests) {
      expect(promptOf(r.body)).not.toContain("on grayboard.");
      expect(promptOf(r.body)).not.toContain("no bus name yet");
    }

    // A peer's DM mid-run reaches main once and no subagent.
    const ping = await pingPong(srv, peer, "omp-task");
    const carrying = model.requests.filter((r) => r.body.messages.some((m) => messageText(m).includes(`<channel source="grayboard" message_id="${ping}"`)));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.filter((r) => fromChild(r.body))).toEqual([]);
    expect((await omp.messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${ping}\\"`))).toHaveLength(1);

    // Released, both runs end: each child is ended, while omp still holds them live.
    writeFileSync(gate, "");
    await until(() => audits(srv, "hosted.child_released").length === 2, 30_000, "both children released");
    expect(audits(srv, "hosted.child_released").map((r) => [r.target, r.detail.child]).sort()).toEqual(children.map((c) => [root, c]).sort());
    expect(liveChildren(srv, root)).toEqual([]);
    await idle(omp);
    // The children's requests after the ping (their runs' last steps) don't carry it either (#526).
    const late = model.requests.filter((r) => fromChild(r.body)).slice(childRequests.length);
    expect(late.length).toBeGreaterThan(0);
    expect(model.requests.filter((r) => fromChild(r.body) && r.body.messages.some((m) => messageText(m).includes(`message_id="${ping}"`)))).toEqual([]);
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !hostedRow(srv, OMP_CLIENT, sessionId), 10_000, "released on quit");
  });
}

// #439 item 3: a nested task run. main's subagent (fake-child-0) runs its own
// task (fake-child-1), blocking on it: omp detaches each task as a background
// job by default ("Spawned agent"), and async.enabled off makes the task call
// wait, the nesting this scenario is about. A child registers at its first
// grayboard call: the grandchild sends and holds open (a bash gate) while
// fake-child-0 waits unregistered, under main's root with fake-child-0's
// session as `via`; released, the grandchild's run ends it, then fake-child-0
// sends, registering under the same root with no intermediates, and ends with
// its run. Each write is its own child's.
export function ompHostedNestedScenario(dir: string): Promise<void> {
  const gate = join(dir, "go");
  const nested = { tool: "task", args: { context: "nested", tasks: [{ name: "FakeChild1", task: "You are fake-child-1.", solutionSpace: "scripted" }] } };
  return withHosted(ompHarness({ async: { enabled: false } }), dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-nest", create: true } }]),
    ...taskFanout(1, /^nest$/, (i) => i === 0
      ? [nested, { tool: `${PREFIX}dm_send`, args: { to: PEER, body: "middle" } }]
      : [{ tool: `${PREFIX}dm_send`, args: { to: PEER, body: "inner" } }, { tool: "bash", args: { command: `while [ ! -f ${gate} ]; do sleep 0.1; done` } }]),
  ], async ({ srv, model, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    await omp.command({ type: "prompt", message: "bind" });
    await until(() => leased(srv, OMP_CLIENT, sessionId, "omp-nest"), 30_000, "omp-nest holds the lease");
    await idle(omp);
    const root = serverId(srv, sessionId)!;

    await omp.command({ type: "prompt", message: "nest" });
    const registered = () => audits(srv, "hosted.child_registered");
    const sends = () => audits(srv, "hosted.write").filter((a) => a.detail.tool === "dm_send");
    const [inner] = await until(() => registered().length === 1 && sends().length === 1 ? registered() : undefined, 60_000, "the grandchild's registration and send");
    expect(inner!.target).toBe(root);
    expect(inner!.detail.via).toHaveLength(1);
    const parentSession = (inner!.detail.via as string[])[0];
    expect([sessionId, inner!.detail.source_session_id]).not.toContain(parentSession);
    const grandchild = inner!.detail.child as string;
    expect(sends()[0]!.target).toBe(grandchild);
    expect(liveChildren(srv, root)).toEqual([grandchild]);

    // Released, the grandchild's run ends it; fake-child-0 then sends as itself.
    writeFileSync(gate, "");
    const [, middle] = await until(() => registered().length === 2 ? registered() : undefined, 30_000, "fake-child-0's registration");
    expect(middle!.target).toBe(root);
    expect(middle!.detail).toMatchObject({ source_session_id: parentSession, via: [] });
    const child = middle!.detail.child as string;
    expect(child).not.toBe(grandchild);
    const writes = await until(() => sends().length === 2 ? sends() : undefined, 30_000, "fake-child-0's send");
    expect(writes.map((w) => w.target)).toEqual([grandchild, child]);
    for (const w of writes) expect(w.detail).toMatchObject({ session: w.target, root, held: ["alice@example.com/omp-nest"] });
    // The task call blocked: fake-child-0's next request carries the grandchild's
    // final answer as the task's result, and no request saw a background spawn.
    const results = model.requests.filter((r) => childOf(r.body) === "fake-child-0").flatMap((r) => r.body.messages.filter((m) => m.role === "tool").map(messageText));
    expect(results.some((t) => t.includes("fake-child-1 done"))).toBe(true);
    expect(model.requests.filter((r) => r.body.messages.some((m) => messageText(m).includes("Spawned agent")))).toEqual([]);
    expect(srv.app.db.query<{ body: string; sender: string }, []>("SELECT body, sender FROM messages WHERE body IN ('inner', 'middle') ORDER BY id").all())
      .toEqual([{ body: "inner", sender: "alice@example.com/omp-nest" }, { body: "middle", sender: "alice@example.com/omp-nest" }]);

    await until(() => audits(srv, "hosted.child_released").length === 2, 30_000, "both children released");
    // Each end is sent after its run's last step without being awaited, so the
    // two may land in either order.
    expect(audits(srv, "hosted.child_released").map((r) => [r.target, r.detail.child]).sort()).toEqual([[root, grandchild], [root, child]].sort());
    expect(liveChildren(srv, root)).toEqual([]);
    await idle(omp);
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !hostedRow(srv, OMP_CLIENT, sessionId), 10_000, "released on quit");
  });
}

// Local mode, as `grayboard setup` leaves omp: the adapter
// (adapterBundle("omp", "local")) at <agentDir>/extensions/grayboard.ts and the
// disabled grayboard entry in <agentDir>/mcp.json it reads its command from;
// omp's own MCP client runs no grayboard (#523). The entry's BUS_DB_PATH is a
// `${VAR}` placeholder the adapter expands as omp's loader does: unexpanded,
// grayboard would open another bus and every row a scenario reads would be missing.
// `wrap`: a command the entry runs grayboard behind (its args get grayboard's command appended).
export function installLocal(dir: string, modelPort: number, wrap: string[] = []): void {
  const agentDir = agentDirOf(dir);
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "grayboard.ts"), LOCAL_BUNDLE);
  const [command, ...prefix] = [...wrap, process.execPath];
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { grayboard: { command, args: [...prefix, CLI, "mcp", "--mode", "local"], env: { BUS_PUSH: "off", BUS_DB_PATH: "${OMP_TEST_BUS}" }, enabled: false } },
  }));
  writeConfig(agentDir, modelPort, {});
}

// `identity`: the BUS_IDENTITY it runs with; null runs without one.
export function startLocalOmp(dir: string, cwd: string, procs: ChildProcess[], identity: string | null = "omp-local", extra: Record<string, string> = {}, { persist = false, session }: { persist?: boolean; session?: string } = {}): Pi {
  const proc = spawn(process.execPath, [OMP_CLI, ...OMP_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--resume", session] : [])], {
    cwd, env: localEnv(dir, identity ?? undefined, { PI_CODING_AGENT_DIR: agentDirOf(dir), OMP_TEST_BUS: join(dir, "bus.db"), ...extra }), stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

function localRows<T>(dir: string, sql: string, ...args: string[]): T[] {
  using db = new Database(join(dir, "bus.db"), { readonly: true });
  return db.query<T, string[]>(sql).all(...args);
}

// /resume restores its own ordered holds; /new and /fork only seed absent
// snapshots, and a remembered [] stays unbound under the retained child.
export function ompLocalResumeScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("bind", [
        { tool: PREFIX + "bind", args: { name: "omp-one", create: true } },
        { tool: PREFIX + "bind", args: { name: "omp-two", create: true } },
      ]),
      scripted("empty", [
        { tool: PREFIX + "unbind", args: { name: "omp-one" } },
        { tool: PREFIX + "unbind", args: { name: "omp-two" } },
      ]),
      scripted("change", [
        { tool: PREFIX + "bind", args: { name: "omp-three", create: true } },
        { tool: PREFIX + "unbind", args: { name: "omp-one" } },
      ]),
      scripted("who", [{ tool: PREFIX + "whoami", args: {} }]),
    ]);
    try {
      installLocal(dir, model.port);
      const omp = startLocalOmp(dir, dir, procs, null, {}, { persist: true });
      const original = await omp.command({ type: "get_state" }, 30_000);
      await omp.command({ type: "prompt", message: "bind" });
      await idle(omp);
      const [child] = grayboardChildPids(omp.pid);
      expect(child).toBeDefined();
      const inspect = async (aliases: string[], expectedChild = child) => {
        const nth = (await omp.messages()).filter(m => m.role === "toolResult" && m.toolName === PREFIX + "whoami").length;
        await omp.command({ type: "prompt", message: "who" });
        const result = await toolResultNamed(omp, `${PREFIX}whoami`, nth);
        expect(!!result.isError).toBe(false);
        await idle(omp);
        const who = JSON.parse(resultText(result));
        expect(who.aliases).toEqual(aliases);
        const state = await omp.command({ type: "get_state" });
        expect(localRows<{ harness_session: string }>(dir, "SELECT harness_session FROM ids WHERE id = ?", who.id)[0]?.harness_session).toBe(state.sessionId);
        expect(grayboardChildPids(omp.pid)).toEqual([expectedChild!]);
        return who.id as string;
      };
      const firstRoot = await inspect(["omp-one", "omp-two"]);
      await omp.command({ type: "new_session" });
      const empty = await omp.command({ type: "get_state" });
      expect(empty.sessionId).not.toBe(original.sessionId);
      expect(await inspect(["omp-one", "omp-two"])).not.toBe(firstRoot);
      expect(localRows<{ ended_at: number | null }>(dir, "SELECT ended_at FROM ids WHERE id = ?", firstRoot)[0]?.ended_at).not.toBeNull();
      await omp.command({ type: "prompt", message: "empty" });
      await idle(omp);
      await inspect([]);
      await omp.command({ type: "switch_session", sessionPath: original.sessionFile });
      await inspect(["omp-one", "omp-two"]);
      expect((await omp.command({ type: "fork" })).cancelled).toBe(false);
      const fork = await omp.command({ type: "get_state" });
      expect([original.sessionId, empty.sessionId]).not.toContain(fork.sessionId);
      await inspect(["omp-one", "omp-two"]);
      await omp.command({ type: "prompt", message: "change" });
      await idle(omp);
      await inspect(["omp-two", "omp-three"]);
      await omp.command({ type: "switch_session", sessionPath: original.sessionFile });
      await inspect(["omp-one", "omp-two"]);
      await omp.command({ type: "switch_session", sessionPath: empty.sessionFile });
      await inspect([]);
      // A crash after switching restarts under the selected, not startup, ID.
      await sigkill(child!);
      const replacement = await until(() => grayboardChildPids(omp.pid).find(pid => pid !== child), 15_000, "grayboard restarted under the selected conversation");
      await inspect([], replacement);
      expect(model.unhandled).toEqual([]);
      expect(omp.events.filter(e => e.type === "extension_error")).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A local task run (#523, #526). omp runs task subagents in-process, each
// with its own copy of the adapter, which sends its calls to main's one
// grayboard process naming the subagent's omp session. Each subagent's DM is
// stored and pushed as main's name with its child ID as via, its bind is
// refused, and each is audited once as a child of main's session, which ends
// them when it ends. A peer's DM during the run, and another after it, each
// reach main once and no subagent. A repo .mcp.json's enabled grayboard entry
// is shadowed by the disabled user entry, so omp doesn't run it and the
// adapter serves.
export function ompLocalTaskScenario(dir: string): Promise<void> {
  const gate = join(dir, "go");
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      ...taskFanout(2, /^fan out$/, (i) => [
        { tool: `${PREFIX}dm_send`, args: { to: "peer", body: `child ${i}` } },
        { tool: `${PREFIX}bind`, args: { name: `omp-sub-${i}`, create: true } },
        { tool: "bash", args: { command: `while [ ! -f ${gate} ]; do sleep 0.1; done` } },
      ]),
      onChannelDm("peer", (id) => ({ tool: `${PREFIX}dm_send`, args: { to: "peer", body: "pong", parent_id: id } })),
    ]);
    let peer: Session | undefined;
    try {
      installLocal(dir, model.port);
      // No grayboard runs at this command: were the entry not shadowed, omp would try it.
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { command: join(dir, "missing", "grayboard"), args: ["mcp"] } } }));
      peer = await localSession(dir, "peer");
      const omp = startLocalOmp(dir, dir, procs);
      const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
      await until(async () => (await peer!.call("peer_list")).peers.some((x: { handle: string }) => x.handle === "omp-local"), 30_000, "omp-local online");
      const root = localRows<{ id: string }>(dir, "SELECT id FROM alias_holds WHERE address = 'omp-local'")[0]!.id;
      // One grayboard process, the adapter's, and no refusal.
      expect(grayboardDescendants(omp.pid)).toHaveLength(1);
      expect(omp.notices().filter((n) => n.startsWith("grayboard:"))).toEqual([]);

      // Both subagents send and try to bind before the gate holds them.
      await omp.command({ type: "prompt", message: "fan out" });
      const refused = `error: child_session: this session acts under its root ${root}; bind and unbind are the root's. Call them from the root session.`;
      const sawRefusal = (r: ChatRequest) => r.messages.some((m) => m.role === "tool" && messageText(m).includes(refused));
      await until(() => new Set(model.requests.filter((r) => fromChild(r.body) && sawRefusal(r.body)).map((r) => childOf(r.body))).size === 2, 60_000, "both subagents' binds refused");
      expect(localRows(dir, "SELECT address FROM alias_holds WHERE address LIKE 'omp-sub-%'")).toEqual([]);

      // Each subagent is its own child of main's session, seen once.
      const seen = localRows<{ actor: string; target: string; detail: string }>(dir, "SELECT actor, target, detail FROM audit_log WHERE action = 'id.child_seen' ORDER BY rowid")
        .map((r) => ({ ...r, detail: JSON.parse(r.detail) as { child: string; root: string; raw: string } }));
      const children = seen.map((s) => s.detail.child);
      expect(seen.map((s) => [s.actor, s.target, s.detail.root])).toEqual(children.map((c) => [root, c, root]));
      expect(new Set(children).size).toBe(2);
      // Named by its own omp session, not main's.
      expect(new Set(seen.map((s) => s.detail.raw)).size).toBe(2);
      expect(seen.map((s) => s.detail.raw)).not.toContain(sessionId);

      // Each DM went as main's name, stored with the child's ID as sender_id and via, and shown as via.
      await until(() => peer!.pushes.filter((p) => /^child \d$/.test(p.content)).length === 2, 30_000, "both subagents' DMs at peer");
      const dms = localRows<{ body: string; sender: string; sender_id: string; via: string | null }>(dir, "SELECT body, sender, sender_id, via FROM messages WHERE body LIKE 'child %' ORDER BY body");
      expect(dms.map((m) => [m.body, m.sender])).toEqual([["child 0", "omp-local"], ["child 1", "omp-local"]]);
      for (const m of dms) expect(m.via).toBe(m.sender_id);
      expect(dms.map((m) => m.sender_id).sort()).toEqual([...children].sort());
      for (const m of dms) expect(peer.pushes.find((p) => p.content === m.body)!.meta).toMatchObject({ from: "omp-local", via: m.via });
      const history = (await peer.call("dm_history", { peer: "omp-local" })) as { body: string; via?: string | null }[];
      expect(history.filter((m) => m.body.startsWith("child ")).map((m) => [m.body, m.via]).sort()).toEqual(dms.map((m) => [m.body, m.via]));

      // Only main's requests carry grayboard's instructions.
      const instructed = (r: ChatRequest) => promptOf(r).split(`You are identity "omp-local" on the grayboard bus`).length - 1;
      expect(model.requests.filter((r) => !fromChild(r.body)).map((r) => instructed(r.body))).toEqual(model.requests.filter((r) => !fromChild(r.body)).map(() => 1));
      expect(model.requests.filter((r) => fromChild(r.body)).map((r) => instructed(r.body))).toEqual(model.requests.filter((r) => fromChild(r.body)).map(() => 0));

      // The first ping lands while both subagents are held at the gate; the
      // gate opens without waiting for it, so it lands mid-run or after.
      const pings: number[] = [];
      const pongs = () => peer!.pushes.filter((x) => x.content.includes("pong")).length;
      pings.push((await peer.call("dm_send", { to: "omp-local", body: "ping" })).message_id);
      writeFileSync(gate, "");
      await until(() => pongs() === 1, 60_000, "first pong at peer");
      await idle(omp);
      // The second lands with both subagents finished and still live (omp
      // keeps them for their idle TTL): a push must not wake one (#470).
      pings.push((await peer.call("dm_send", { to: "omp-local", body: "ping" })).message_id);
      await until(() => pongs() === 2, 60_000, "second pong at peer");
      await idle(omp);

      for (const ping of pings) {
        const carries = (r: ChatRequest) => r.messages.some((m) => messageText(m).includes(`message_id="${ping}"`));
        expect(model.requests.filter((r) => fromChild(r.body) && carries(r.body)).map((r) => childOf(r.body))).toEqual([]);
        expect(model.requests.filter((r) => !fromChild(r.body) && carries(r.body)).length).toBeGreaterThan(0);
        expect((await omp.messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${ping}\\"`))).toHaveLength(1);
        expect((await peer.call("dm_thread", { thread: ping })).map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([["peer", "ping"], ["omp-local", "pong"]]);
      }
      expect(model.unhandled).toEqual([]);
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      await omp.quit();
      // Quitting ends main's session, and its children with it.
      await until(() => localRows<{ ended_at: number | null }>(dir, "SELECT ended_at FROM ids WHERE id IN (?, ?, ?)", root, ...children).every((r) => r.ended_at !== null), 10_000, "main's session and its children ended");
    } finally {
      await stopAll(procs);
      if (peer) await stopSession(peer.c);
      model.stop();
    }
  });
}

// An enabled MCP server omp would run beside the adapter's grayboard is
// refused, as omp's loader resolves its config: one named grayboard, whatever
// it runs (a repo's .omp/mcp.json entry outranks the disabled user entry), or
// one under another name whose command, past a launcher, runs `grayboard mcp`.
// Either way the adapter says why, registers no tools and starts no grayboard
// process. No grayboard runs at any of these commands, so omp's own client
// starts none either.
export function ompLocalRefusalScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    try {
      installLocal(dir, model.port);
      const command = join(dir, "missing", "grayboard");
      const byName = `is named "grayboard", the name this extension serves its tools under`;
      const byCommand = "runs `grayboard mcp`";
      // Only the repo's .omp/mcp.json grayboard entry's pin is read under omp, so only its notice says the pin survives disabling.
      const cases = [
        { repo: "same-name", file: [".omp", "mcp.json"], name: "grayboard", server: { command, args: ["mcp", "--mode", "local"], env: { BUS_IDENTITY: "fe" } }, why: byName, keeps: ` (disabled, its BUS_IDENTITY "fe" still pins this session's name)` },
        // Refused by its name alone: an HTTP server runs no command (a closed port: omp connects to nothing).
        { repo: "same-name-http", file: [".omp", "mcp.json"], name: "grayboard", server: { type: "http", url: "http://127.0.0.1:9/mcp" }, why: byName, keeps: "" },
        { repo: "other-name", file: [".mcp.json"], name: "bus", server: { command, args: ["mcp", "--mode", "local"], env: { BUS_IDENTITY: "fe" } }, why: byCommand, keeps: "" },
        // Behind a shell's -c line.
        { repo: "other-name-shell", file: [".mcp.json"], name: "bus", server: { command: "sh", args: ["-c", `${command} mcp`] }, why: byCommand, keeps: "" },
      ];
      for (const c of cases) {
        const cwd = join(dir, c.repo);
        mkdirSync(join(cwd, ...c.file.slice(0, -1)), { recursive: true });
        writeFileSync(join(cwd, ...c.file), JSON.stringify({ mcpServers: { [c.name]: c.server } }));
        const omp = startLocalOmp(dir, cwd, procs);
        await omp.command({ type: "get_state" }, 30_000);
        const notice = await until(() => omp.notices().find((n) => n.startsWith("grayboard:")), 30_000, `the ${c.repo} refusal`);
        expect(notice).toMatch(new RegExp(`^grayboard: the "${c.name}" MCP server in \\S*/${RegExp.escape(c.file.join("/"))} is enabled and ${RegExp.escape(c.why)}, so omp would run it beside this extension's grayboard\\. Set "enabled": false on it${RegExp.escape(c.keeps)} or remove it`));
        const before = model.requests.length;
        await omp.command({ type: "prompt", message: "hello" });
        await idle(omp);
        const req = model.requests[before]!.body;
        expect(requestTools(req).filter((n) => n.startsWith(PREFIX))).toEqual([]);
        expect(promptOf(req)).not.toContain("grayboard bus");
        expect(grayboardDescendants(omp.pid)).toEqual([]);
        expect(omp.notices().filter((n) => n.startsWith("grayboard:"))).toEqual([notice]);
        expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
        await omp.quit();
      }
      expect(model.unhandled).toEqual([]);
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A repo's disabled .omp/mcp.json grayboard entry still names its omp
// sessions (#523): the adapter runs grayboard with BUS_HARNESS=omp, so a
// session with no BUS_IDENTITY suggests the entry's pin, not the directory
// name, and binds it. No grayboard runs at the entry's command: omp's client
// doesn't run a disabled entry.
export function ompLocalPinScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "fe", create: true } }])]);
    try {
      installLocal(dir, model.port);
      const cwd = join(dir, "repo");
      mkdirSync(join(cwd, ".omp"), { recursive: true });
      writeFileSync(join(cwd, ".omp", "mcp.json"), JSON.stringify({
        mcpServers: { grayboard: { command: join(dir, "missing", "grayboard"), args: ["mcp"], enabled: false, env: { BUS_IDENTITY: "fe" } } },
      }));
      const omp = startLocalOmp(dir, cwd, procs, null);
      await omp.command({ type: "get_state" }, 30_000);
      const before = model.requests.length;
      await omp.command({ type: "prompt", message: "bind" });
      await idle(omp);
      const first = promptOf(model.requests[before]!.body);
      expect(first).toContain("This session has no bus name yet");
      expect(first).toContain("Candidates (free now): fe (this checkout's default: ");
      expect(first).not.toContain("repo (this checkout's default: ");
      expect(localRows<{ address: string }>(dir, "SELECT address FROM alias_holds").map((r) => r.address)).toEqual(["fe"]);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}bind`))).not.toContain("error");
      expect(grayboardDescendants(omp.pid)).toHaveLength(1);
      expect(omp.notices().filter((n) => n.startsWith("grayboard:"))).toEqual([]);
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      expect(model.unhandled).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A local omp session keeps its grayboard and its name (#523). A push-started
// bind changes the next request's instructions without a new user prompt (#552).
// A grayboard process that dies is restarted, as omp's MCP manager restarted
// a stdio server, and binds the names back. /new keeps the process, rotates
// its bus root under the actual conversation ID, and carries names only when
// the selected conversation has no snapshot. A push-started turn receives
// refreshed instructions even after omp rebuilds its prompt. A local:// URL
// reaches grayboard as its underlying file path.
export function ompLocalCarryScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    // omp keeps a --no-session run's local:// files under its temp dir; grayboard may attach from there.
    const tmp = join(dir, "tmp");
    mkdirSync(tmp, { recursive: true });
    const model = startFakeModel([
      scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-carry", create: true } }]),
      scripted("attach", [
        { tool: "write", args: { path: "local://note.md", content: "note body\n" } },
        { tool: `${PREFIX}dm_send`, args: { to: "peer", body: "note attached", attachments: ["local://note.md"] } },
      ]),
      scripted("who", [{ tool: `${PREFIX}whoami`, args: {} }]),
      onChannelDm("peer", (id, text) => text.includes("bind from push")
        ? { tool: `${PREFIX}bind`, args: { name: "omp-push", create: true } }
        : { tool: `${PREFIX}dm_send`, args: { to: "peer", body: "pong", parent_id: id } }),
    ]);
    let peer: Session | undefined;
    try {
      installLocal(dir, model.port);
      peer = await localSession(dir, "peer");
      const omp = startLocalOmp(dir, dir, procs, null, { TMPDIR: tmp, BUS_ATTACH_ROOTS: tmp });
      const initial = await omp.command({ type: "get_state" }, 30_000);
      const holder = () => localRows<{ id: string }>(dir, "SELECT id FROM alias_holds WHERE address = 'omp-carry'")[0]?.id;
      await omp.command({ type: "prompt", message: "bind" });
      await idle(omp);
      const first = holder()!;
      expect(first).toBeDefined();
      expect(localRows<{ harness_session: string }>(dir, "SELECT harness_session FROM ids WHERE id = ?", first)[0]?.harness_session).toBe(initial.sessionId);

      await omp.command({ type: "prompt", message: "attach" });
      await idle(omp);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}dm_send`))).not.toContain("error");
      const note = localRows<{ filename: string; size: number }>(dir, "SELECT a.filename, a.size FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.body = 'note attached'");
      expect(note).toEqual([{ filename: "note.md", size: "note body\n".length }]);

      // No new user prompt: this DM starts a turn that binds another name.
      // The request after bind must already carry its updated instructions (#552).
      const pushedBind = (await peer.call("dm_send", { to: "omp-carry", body: "bind from push" })).message_id as number;
      const afterBind = await until(() => model.requests.find((r) =>
        r.body.messages.some((m) => messageText(m).includes(`message_id="${pushedBind}"`)) &&
        r.body.messages.some((m) => m.role === "tool" && messageText(m).includes("omp-push"))), 30_000, "the request after the push-started bind");
      expect(systemText(afterBind.body)).toContain("omp-push");
      expect(systemText(afterBind.body).split(`You are identity "omp-carry" on the grayboard bus`)).toHaveLength(2);
      await idle(omp);

      // The grayboard process dies: the adapter starts another, which takes the name back.
      const [dead] = grayboardChildPids(omp.pid);
      await sigkill(dead!);
      await until(() => grayboardChildPids(omp.pid).some((p) => p !== dead), 15_000, "a new grayboard process");
      // One read per poll, and the id it saw: a second read can race the takeover (#466).
      const restarted = await until(() => { const h = holder(); return h !== undefined && h !== first ? h : undefined; }, 15_000, "omp-carry held by the restarted session");
      await omp.command({ type: "prompt", message: "who" });
      await idle(omp);
      const who = resultText(await toolResultNamed(omp, `${PREFIX}whoami`));
      expect(who).not.toContain("error");
      expect(who).toContain("omp-carry");

      // /new retains the process, not its old bus root; a push-started turn carries the refreshed instructions.
      const [live] = grayboardChildPids(omp.pid);
      await omp.command({ type: "new_session" });
      const fresh = await omp.command({ type: "get_state" });
      expect(fresh.sessionId).not.toBe(initial.sessionId);
      const ping = (await peer.call("dm_send", { to: "omp-carry", body: "ping" })).message_id as number;
      await until(() => peer!.pushes.some((p) => p.content === "pong"), 60_000, "pong at peer");
      await idle(omp);
      expect(grayboardChildPids(omp.pid)).toEqual([live!]);
      expect(holder()).not.toBe(restarted);
      expect(localRows<{ harness_session: string }>(dir, "SELECT harness_session FROM ids WHERE id = ?", holder()!)[0]?.harness_session).toBe(fresh.sessionId);
      expect(localRows<{ ended_at: number | null }>(dir, "SELECT ended_at FROM ids WHERE id = ?", restarted)[0]?.ended_at).not.toBeNull();
      const instructions = `You are identity "omp-carry" on the grayboard bus`;
      const carrying = model.requests.filter((r) => r.body.messages.some((m) => messageText(m).includes(`message_id="${ping}"`)));
      expect(carrying.length).toBeGreaterThan(0);
      for (const r of carrying) {
        expect(promptOf(r.body).split(instructions).length - 1).toBe(1);
        expect(r.body.messages.some((m) => m.role !== "system" && messageText(m).includes(instructions))).toBe(true);
      }
      expect(omp.notices().filter((n) => n.startsWith("grayboard:"))).toEqual([]);
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      expect(model.unhandled).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      if (peer) await stopSession(peer.c);
      model.stop();
    }
  });
}

// A grayboard process that never answers initialize ("deadline") is killed
// at the deadline (#559), and one that answers it with an error ("refused")
// at once (#1142); either restarts as an exit does, and after the last
// restart a tool call fails with the reason instead of hanging.
export function ompLocalInitFailScenario(dir: string, how: "deadline" | "refused"): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([scripted("who", [{ tool: `${PREFIX}whoami`, args: {} }])]);
    try {
      let env: Record<string, string> = {};
      if (how === "deadline") {
        installLocal(dir, model.port);
        // Every child, restarts included, blocks before it answers initialize.
        mkdirSync(join(dir, "pause"), { recursive: true });
        env = { BUS_TEST_PAUSE: "mcp:before-connect", BUS_TEST_PAUSE_FILE: join(dir, "pause", "go"), BUS_TEST_INIT_DEADLINE_MS: "1000" };
      } else {
        installLocal(dir, model.port, [process.execPath, REFUSING_MCP]);
      }
      const reason = how === "deadline" ? "grayboard process didn't initialize within 1 s" : "grayboard process failed to initialize: grayboard: refused for test";
      const omp = startLocalOmp(dir, dir, procs, null, env);
      await omp.command({ type: "get_state" }, 60_000);
      const notice = await until(() => omp.notices().find((n) => n.includes("after 3 restarts; restart omp to reconnect")), 60_000, "restart exhaustion notice");
      expect(notice).toContain(reason);
      await omp.command({ type: "prompt", message: "who" });
      await idle(omp);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}whoami`))).toContain(reason);
      await until(() => grayboardChildPids(omp.pid).length === 0, 5_000, "no grayboard process left");
      // With no process left, the turn's hooks fail as after an exit's give-up, with the same reason.
      expect(new Set(omp.events.filter((e) => e.type === "extension_error").map((e) => e.error))).toEqual(new Set([reason]));
      expect(model.unhandled).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A `grayboard/session` handshake answered with an error, at the process's
// start (#1142) or at `new_session` (#1145), restarts it at once; the
// replacement serves the selected session, and nothing fails the turn or the
// switch. Only that one request is refused; the rest reach the real grayboard.
export function ompLocalHandshakeFailScenario(dir: string, phase: "start" | "switch"): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([scripted("who", [{ tool: `${PREFIX}whoami`, args: {} }])]);
    try {
      const counter = join(dir, "session-calls");
      const n = phase === "start" ? 1 : 2;
      installLocal(dir, model.port, [process.execPath, REFUSING_MCP, "--session", counter, String(n)]);
      const omp = startLocalOmp(dir, dir, procs, null);
      await omp.command({ type: "get_state" }, 60_000);
      const who = async () => {
        const nth = (await omp.messages()).filter(m => m.role === "toolResult" && m.toolName === PREFIX + "whoami").length;
        await omp.command({ type: "prompt", message: "who" });
        const result = await toolResultNamed(omp, `${PREFIX}whoami`, nth);
        await idle(omp);
        expect(resultText(result)).not.toContain("refused for test");
        expect(!!result.isError).toBe(false);
        const id = JSON.parse(resultText(result)).id as string;
        const state = await omp.command({ type: "get_state" });
        expect(localRows<{ harness_session: string }>(dir, "SELECT harness_session FROM ids WHERE id = ?", id)[0]?.harness_session).toBe(state.sessionId);
      };
      let first: number | undefined;
      if (phase === "switch") {
        await who();
        [first] = grayboardChildPids(omp.pid);
        await omp.command({ type: "new_session" });
      }
      await until(() => existsSync(counter) && readFileSync(counter, "utf8") === String(n + 1), 30_000, "the replacement's handshake");
      await who();
      const live = grayboardChildPids(omp.pid);
      expect(live).toHaveLength(1);
      if (first !== undefined) expect(live).not.toContain(first);
      expect(readFileSync(counter, "utf8")).toBe(String(n + 1));
      expect(omp.notices().filter((t) => t.startsWith("grayboard"))).toEqual([]);
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      expect(model.unhandled).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// Each new_session's switch handshake refused: omp counts every one toward
// the restart budget (a child younger than STABLE_MS keeps the count), so
// the fourth gives up and says so (#1148).
export function ompLocalSwitchExhaustScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    try {
      const counter = join(dir, "session-calls");
      installLocal(dir, model.port, [process.execPath, REFUSING_MCP, "--session", counter, "2,4,6,8"]);
      const omp = startLocalOmp(dir, dir, procs, null);
      await omp.command({ type: "get_state" }, 60_000);
      await until(() => existsSync(counter) && readFileSync(counter, "utf8") === "1", 30_000, "the start handshake");
      for (let i = 0; i < 3; i++) {
        await omp.command({ type: "new_session" }, 30_000);
        // The refused switch (2i+2) and the replacement's start handshake (2i+3), after 0, 1 and 5 s.
        await until(() => readFileSync(counter, "utf8") === String(2 * i + 3), 30_000, `restart ${i + 1}'s handshake`);
      }
      await omp.command({ type: "new_session" }, 30_000);
      await until(() => omp.notices().some((t) => t.includes("restart omp to reconnect")), 15_000, "the give-up notice");
      expect(omp.notices().filter((t) => t.startsWith("grayboard"))).toEqual([
        "grayboard process failed its session switch: grayboard: refused for test after 3 restarts; restart omp to reconnect",
      ]);
      const restarts = ompLog(dir).split("\n").filter((l) => l.includes("failed its session switch") && l.includes("restarting it"));
      expect(restarts.map((l) => l.match(/restarting it \((\d) of 3\)/)?.[1])).toEqual(["1", "2", "3"]);
      expect(readFileSync(counter, "utf8")).toBe("8");
      await until(() => grayboardChildPids(omp.pid).length === 0, 5_000, "no grayboard process left");
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      await omp.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A tool call waiting out a restart's backoff ends at its abort (#559), as
// pi's does, rather than holding the turn until the grayboard process is
// back, and it never runs there: the bind it carried takes no name.
export function ompLocalRestartAbortScenario(dir: string): Promise<void> {
  // The turn's hooks wait for a live process before each request, so the
  // third exit lands while the model's reply with the bind is held.
  const released = Promise.withResolvers<void>();
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("late bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-late", create: true } }]),
    ], { hold: () => released.promise });
    try {
      installLocal(dir, model.port);
      const omp = startLocalOmp(dir, dir, procs, null);
      await omp.command({ type: "get_state" }, 30_000);
      await until(() => grayboardChildPids(omp.pid).length === 1, 15_000, "the grayboard process");
      // Restarts after 0 and 1 s; the third exit backs off 5 s.
      for (let attempt = 0; attempt < 2; attempt++) {
        const [dead] = grayboardChildPids(omp.pid);
        await sigkill(dead!);
        await until(() => grayboardChildPids(omp.pid).some((p) => p !== dead), 15_000, `restart ${attempt + 1}`);
      }
      await omp.command({ type: "prompt", message: "late bind" });
      await until(() => model.requests.length === 1, 15_000, "the turn's request at the model");
      const [dead] = grayboardChildPids(omp.pid);
      await sigkill(dead!);
      await until(() => grayboardChildPids(omp.pid).length === 0, 5_000, "the third exit reaped");
      released.resolve();
      await until(() => omp.events.some((e) => e.type === "tool_execution_start" && e.toolName === `${PREFIX}bind`), 5_000, "the bind waiting on the backoff");
      const aborted = Date.now();
      await omp.command({ type: "abort" });
      await until(() => omp.events.some((e) => e.type === "tool_execution_end" && e.toolName === `${PREFIX}bind`), 2_000, "the bind ended at its abort");
      expect(Date.now() - aborted).toBeLessThan(2_000);
      await idle(omp, 2_000);
      // The backoff runs out and the process is back. A regression guard: the
      // aborted bind never runs (the old adapter only ended it late, at the
      // backoff's end; its send already refused an aborted call).
      await until(() => grayboardChildPids(omp.pid).length === 1, 15_000, "the restarted grayboard process");
      await Bun.sleep(2_000);
      expect(localRows<{ id: string }>(dir, "SELECT id FROM alias_holds WHERE address = 'omp-late'")).toEqual([]);
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      expect(model.unhandled).toEqual([]);
      await omp.quit();
    } finally {
      released.resolve();
      await stopAll(procs);
      model.stop();
    }
  });
}

// A grayboard that stops reading while it still runs and holds the name
// (tests/support/stops_reading.ts): the adapter's next write fails with EPIPE,
// and it kills that process before the replacement starts, so the replacement
// takes the name back and no stale delivery owner remains (#580).
export function ompLocalStopsReadingScenario(dir: string, opts: { ignoreSigterm?: boolean } = {}): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-580", create: true } }]),
      scripted("stop", [{ tool: `${PREFIX}dm_send`, args: { to: "peer", body: STOP_READING } }]),
      // Bun accepts a small write to a closed pipe; a large one raises EPIPE.
      scripted("big", [{ tool: `${PREFIX}dm_send`, args: { to: "peer", body: "x".repeat(128_000) } }]),
      scripted("who", [{ tool: `${PREFIX}whoami`, args: {} }]),
    ]);
    let peer: Session | undefined;
    // Every relay and grayboard pid seen, SIGKILLed at the end: on a regression
    // the stale pair outlives omp, which only stops the child it still owns.
    const seen = new Set<number>();
    const grayboards = (pid: number) => {
      const pids = processDescendants(pid).filter((p) => p.command.includes(CLI)).map((p) => p.pid);
      for (const p of pids) seen.add(p);
      return pids;
    };
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      installLocal(dir, model.port, [process.execPath, join(ROOT, "tests/support/stops_reading.ts")]);
      peer = await localSession(dir, "peer");
      const omp = startLocalOmp(dir, dir, procs, null, { BUS_TEST_STOP_READING: join(dir, "stopped"), BUS_TEST_STOP_READING_ON: STOP_READING, ...(opts.ignoreSigterm ? { BUS_TEST_IGNORE_SIGTERM: "1" } : {}) });
      await omp.command({ type: "get_state" }, 30_000);
      const holder = () => localRows<{ id: string }>(dir, "SELECT id FROM alias_holds WHERE address = 'omp-580'")[0]?.id;
      await omp.command({ type: "prompt", message: "bind" });
      await idle(omp);
      const first = holder()!;
      expect(first).toBeDefined();

      await omp.command({ type: "prompt", message: "stop" });
      await idle(omp);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}dm_send`))).not.toContain("error");
      // The relay and the one grayboard behind it.
      const stale = grayboards(omp.pid);
      expect(stale).toHaveLength(2);

      await omp.command({ type: "prompt", message: "big" });
      await idle(omp);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}dm_send`, 1))).toContain("grayboard process stopped reading");
      await until(() => !stale.some(alive), 10_000, "the process that stopped reading killed");
      await until(() => { const h = holder(); return h !== undefined && h !== first ? h : undefined; }, 15_000, "omp-580 held by the replacement");
      const replacement = grayboards(omp.pid);
      expect(replacement).toHaveLength(2);
      if (opts.ignoreSigterm) {
        // Only the SIGKILL ended the relay, and the replacement waited for it.
        const sigterm = Number(readFileSync(join(dir, "stopped.sigterm"), "utf8"));
        const started = Number(readFileSync(join(dir, "stopped.started"), "utf8"));
        expect(started - sigterm).toBeGreaterThanOrEqual(1_400);
        await until(() => ompLog(dir).includes("sent SIGKILL"), 5_000, "the SIGKILL reported");
      }
      expect(localRows<{ ended_at: number | null }>(dir, "SELECT ended_at FROM ids WHERE id = ?", first)[0]?.ended_at).not.toBeNull();

      await omp.command({ type: "prompt", message: "who" });
      await idle(omp);
      expect(resultText(await toolResultNamed(omp, `${PREFIX}whoami`))).toContain("omp-580");
      expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
      expect(model.unhandled).toEqual([]);
      await omp.quit();
      await until(() => !replacement.some(alive), 5_000, "the replacement ended with omp");
    } finally {
      for (const p of seen) { if (alive(p)) try { process.kill(p, "SIGKILL"); } catch {} }
      await stopAll(procs);
      if (peer) await stopSession(peer.c);
      model.stop();
    }
  });
}

// A minimal ACP client over omp's stdio (`--mode acp`): requests, and the
// agent's permission requests answered with its first allow option. omp's
// ACP mode logs an extension's notice rather than sending it (ompLog).
function startAcpOmp(dir: string, procs: ChildProcess[]) {
  const args = OMP_ARGS.map((a) => (a === "rpc" ? "acp" : a));
  const proc = spawn(process.execPath, [OMP_CLI, ...args], {
    cwd: dir, env: localEnv(dir, "omp-local", { PI_CODING_AGENT_DIR: agentDirOf(dir), OMP_TEST_BUS: join(dir, "bus.db") }), stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  proc.stderr!.resume();
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  let next = 1;
  const send = (msg: object) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  let buf = "";
  proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method?: string; params?: { options?: { optionId: string; kind: string }[] }; result?: unknown; error?: { message: string } };
      buf = buf.slice(nl + 1);
      if (msg.method === "session/request_permission") {
        const allow = msg.params!.options!.find((o) => o.kind.startsWith("allow"))!;
        send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
      } else if (msg.method !== undefined && msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: `the test client doesn't serve ${msg.method}` } });
      } else if (msg.method === undefined && msg.id !== undefined) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`acp: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  });
  const call = <T>(method: string, params: object): Promise<T> => {
    const id = next++;
    const waiter = Promise.withResolvers<unknown>();
    pending.set(id, waiter);
    send({ id, method, params });
    return waiter.promise as Promise<T>;
  };
  return { proc, call };
}

// What omp logged under the scratch HOME (pi.logger, and ACP's notices).
function ompLog(dir: string): string {
  const logs = join(dir, "home", ".omp", "logs");
  return existsSync(logs) ? readdirSync(logs).map((f) => readFileSync(join(logs, f), "utf8")).join("") : "";
}

// omp's ACP mode runs several top-level sessions in one process, each with
// its own runtime and agent id. The first session runs grayboard; the second
// is refused, and so is its subagent, which would otherwise act as the first
// session's names (#470). The first session's subagent, found through its
// chain of parentIds, serves the tools as a child session. An enabled
// .mcp.json server that runs grayboard in the session's directory doesn't
// refuse it: ACP sessions load no on-disk MCP config (#559).
export function ompLocalAcpScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const send = (i: number) => [{ tool: `${PREFIX}dm_send`, args: { to: "peer", body: `from subagent ${i}` } }];
    const model = startFakeModel([...taskFanout(1, /^fan out a$/, send), ...taskFanout(1, /^fan out b$/, send, 1)]);
    let peer: Session | undefined;
    try {
      installLocal(dir, model.port);
      peer = await localSession(dir, "peer");
      // A "grayboard" that only leaves a marker: were omp to start it in ACP,
      // skipping the check would let a second grayboard through.
      const ran = join(dir, "bus-ran");
      mkdirSync(join(dir, "fake"), { recursive: true });
      writeFileSync(join(dir, "fake", "grayboard"), `#!/bin/sh\ntouch '${ran}'\n`);
      chmodSync(join(dir, "fake", "grayboard"), 0o755);
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { bus: { command: join(dir, "fake", "grayboard"), args: ["mcp", "--mode", "local"] } } }));
      const acp = startAcpOmp(dir, procs);
      await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId: first } = await acp.call<{ sessionId: string }>("session/new", { cwd: dir, mcpServers: [] });
      await until(() => localRows(dir, "SELECT 1 FROM alias_holds WHERE address = 'omp-local'").length === 1, 30_000, "the first session holds omp-local");
      const { sessionId: second } = await acp.call<{ sessionId: string }>("session/new", { cwd: dir, mcpServers: [] });
      await until(() => ompLog(dir).includes("grayboard: another top-level session in this omp process runs grayboard"), 30_000, "the second session's refusal");
      expect(grayboardDescendants(acp.proc.pid!)).toHaveLength(1);

      const served: Record<string, boolean[]> = {};
      for (const [sessionId, prompt] of [[second, "fan out a"], [first, "fan out b"]] as const) {
        const before = model.requests.length;
        // ACP runs task subagents as background jobs: the prompt ends before they do.
        await acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
        const children = () => model.requests.slice(before).filter((r) => fromChild(r.body));
        // The subagent's call, then its closing turn.
        await until(() => children().length >= 2, 60_000, `the subagent's run after "${prompt}"`);
        served[prompt] = [...new Set(children().map((r) => requestTools(r.body).includes(`${PREFIX}dm_send`)))];
      }
      expect(served).toEqual({ "fan out a": [false], "fan out b": [true] });
      await until(() => ompLog(dir).includes(`"grayboard: this subagent's top-level session doesn't run grayboard`), 10_000, "the second session's subagent's notice");
      // Only the first session's subagent wrote: as the first session's name, via its child session.
      const dms = localRows<{ body: string; sender: string; sender_id: string; via: string | null }>(dir, "SELECT body, sender, sender_id, via FROM messages WHERE body LIKE 'from subagent %'");
      expect(dms.map((m) => [m.body, m.sender])).toEqual([["from subagent 1", "omp-local"]]);
      expect(dms[0]!.via).toBe(dms[0]!.sender_id);
      const seen = localRows<{ target: string }>(dir, "SELECT target FROM audit_log WHERE action = 'id.child_seen'");
      expect(seen.map((s) => s.target)).toEqual([dms[0]!.sender_id]);
      expect(existsSync(ran)).toBe(false);
      expect(model.unhandled).toEqual([]);
    } finally {
      await stopAll(procs);
      if (peer) await stopSession(peer.c);
      model.stop();
    }
  });
}

// A grayboard among an ACP client's declared mcpServers, which omp applies
// after session_start's check, is reported once and not refused (#1140): by
// its tools under another name ("Grayboard" takes some of the adapter's tool
// names), and by its process when named exactly grayboard, whose tools omp's
// dedup drops. A server without grayboard's tools, and the adapter's own
// tools, aren't reported, nor is a grayboard a harness under omp starts.
export function ompLocalAcpClientGrayboardScenario(dir: string): Promise<void> {
  return named(OMP_HARNESS, async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([scripted("hi", [{ text: "hello" }]), scripted("again", [{ text: "hello again" }])]);
    try {
      installLocal(dir, model.port);
      // A stdio MCP server serving the tool names given as its arguments;
      // with --harness first, it also starts a grayboard of its own on another
      // bus, as a harness the agent launched would (pi's adapter child).
      const fake = join(dir, "fake_mcp.ts");
      writeFileSync(fake, `
const names = process.argv.slice(2);
if (names[0] === "--harness") {
  names.shift();
  const env = { ...process.env, BUS_DB_PATH: ${JSON.stringify(join(dir, "harness.db"))} };
  delete env.BUS_IDENTITY;
  Bun.spawn([process.execPath, ${JSON.stringify(CLI)}, "mcp", "--mode", "local"], { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
}
let buf = "";
process.stdin.setEncoding("utf8").on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (m.id === undefined) continue;
    const result = m.method === "initialize" ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : m.method === "tools/list" ? { tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`);
      const server = (name: string, tools: string[]) => ({ name, command: process.execPath, args: [fake, ...tools], env: [] });
      // The client's grayboard inherits omp's env, BUS_IDENTITY too, and
      // contends for the name: only the adapter's child has a harness session.
      const holds = (name: string) => {
        try {
          return existsSync(join(dir, "bus.db")) && localRows(dir, "SELECT 1 FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ? AND i.harness_session IS NOT NULL", name).length === 1;
        } catch {
          return false; // the file exists before its tables do
        }
      };
      const acp = startAcpOmp(dir, procs);
      await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await acp.call<{ sessionId: string }>("session/new", { cwd: dir, mcpServers: [
        // A copied entry: the same command as the adapter's.
        { name: "grayboard", command: process.execPath, args: [CLI, "mcp", "--mode", "local"], env: [] },
        server("Grayboard", ["bind", "claim_take", "dm_inbox", "whoami"]),
        server("bus2", ["bind", "claim_take", "dm_inbox"]),
        server("other", ["bind", "search"]),
        server("harness", ["--harness", "search"]),
      ] });
      await until(() => holds("omp-local"), 30_000, "the adapter's grayboard holds omp-local");
      await until(() => grayboardDescendants(acp.proc.pid!).length === 3, 30_000, "the client's grayboard and the harness's run beside the adapter's");
      for (const text of ["hi", "again"]) await acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      // The adapter's own log lines; ACP also mirrors each notice at debug.
      const notices = () => ompLog(dir).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { level: string; message: string })
        .filter((l) => l.level === "error" && l.message.startsWith("grayboard: ")).map((l) => l.message);
      const proc = (m: string) => m.startsWith("grayboard: process ");
      // ps runs after the prompt starts.
      await until(() => notices().some(proc), 10_000, "the client's grayboard process is reported");
      const said = (server: string) => notices().filter((m) => m.startsWith(`grayboard: the MCP server "${server}"`));
      expect(said("Grayboard")).toHaveLength(1);
      expect(said("Grayboard")[0]).toContain("took this adapter's tool names");
      expect(said("bus2")).toHaveLength(1);
      expect(said("bus2")[0]).not.toContain("took this adapter's tool names");
      const procs1 = notices().filter(proc);
      expect(procs1).toHaveLength(1);
      expect(procs1[0]).toContain(`${CLI} mcp)`);
      // Nothing else: not "grayboard" by its tools (dropped), not "other". Here
      // "Grayboard" takes the signature tools from the adapter's own, so the
      // pin and carry scenarios, which allow no notice, guard their exclusion.
      expect(notices()).toHaveLength(3);
      // Not refused: both processes still run, and the adapter's keeps its name.
      expect(grayboardDescendants(acp.proc.pid!)).toHaveLength(3);
      expect(holds("omp-local")).toBe(true);
      expect(model.unhandled).toEqual([]);
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// omp keeps one extension runtime across /fork, /new and /resume
// (session_switch), so the entry replaces its session each time.
export const ompHostedCarryScenario = (dir: string): Promise<void> => hostedCarryScenario(OMP_HARNESS, dir);

// 130 subagents one at a time (task.maxConcurrency 1), more than the root's
// 128-child cap: each registers at its first call and is ended when its run
// does, so every call succeeds and the root never holds more than one child.
export function ompHostedManyChildrenScenario(dir: string): Promise<void> {
  const n = 130;
  return withHosted(ompHarness({ task: { maxConcurrency: 1 } }), dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-many", create: true } }]),
    ...taskFanout(n, /^fan out$/, (i) => [{ tool: `${PREFIX}peer_status`, args: { text: `child ${i}` } }]),
  ], async ({ srv, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    await omp.command({ type: "prompt", message: "bind" });
    await until(() => leased(srv, OMP_CLIENT, sessionId, "omp-many"), 30_000, "omp-many holds the lease");
    await idle(omp);
    const root = serverId(srv, sessionId)!;

    let most = 0;
    await omp.command({ type: "prompt", message: "fan out" });
    await until(() => {
      most = Math.max(most, liveChildren(srv, root).length);
      return audits(srv, "hosted.child_released").length === n;
    }, 600_000, `${n} children released`);
    const writes = audits(srv, "hosted.write").filter((a) => a.detail.tool === "peer_status");
    expect(writes).toHaveLength(n);
    const registered = audits(srv, "hosted.child_registered");
    expect(registered).toHaveLength(n);
    expect(new Set(registered.map((r) => r.detail.child)).size).toBe(n);
    expect(registered.every((r) => r.target === root)).toBe(true);
    expect(most).toBeLessThanOrEqual(1);
    expect(liveChildren(srv, root)).toEqual([]);
    await idle(omp, 60_000);
    await omp.quit();
  });
}

export const ompHostedRefreshLogoutScenario = (dir: string): Promise<void> => hostedRefreshLogoutScenario(OMP_HARNESS, dir);
export const ompHostedStaticScenario = (dir: string): Promise<void> => hostedStaticScenario(OMP_HARNESS, dir);
