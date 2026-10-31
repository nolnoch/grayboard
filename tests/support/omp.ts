// The omp scenarios (#280): the real omp coding agent (the pinned
// devDependency, a Bun program) in RPC mode against a scripted fake model,
// with the hosted extension exactly as the binary embeds it
// (adapterBundle("omp")), set up as `grayboard setup --server` leaves it:
// <agentDir>/extensions/grayboard.js, <agentDir>/grayboard/config.json {url}
// and no grayboard MCP entry. omp speaks pi's RPC protocol, so the Pi class
// and the hosted helpers come from tests/support/pi.ts.
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { hostTools, snapshotTools } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { adapterBundle } from "../../src/cli/adapters.ts" with { type: "macro" };
import { sha256Hex } from "../../src/shared/hash.ts";
import { cleanEnv } from "./env.ts";
import { messageText, startFakeModel, taskFanout, type ChatRequest, type FakeModel, type Rule } from "./fake_model.ts";
import { browse, hostedServer, seedGrant, type HostedServer } from "./hosted_oauth.ts";
import { answerPeer, hostedPeer, hostedRow, leased, PEER, Pi, pingPong, requestTools, resultText, scripted, statusOf, stopAll, systemText, toolResultNamed, type Peer } from "./pi.ts";
import { grayboardDescendants } from "./procs.ts";
import { ROOT } from "./paths.ts";
import { until } from "./until.ts";

type OmpPackage = { version: string; bin: { omp: string } };
const OMP_PKG = join(ROOT, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
const OMP: OmpPackage = JSON.parse(readFileSync(OMP_PKG, "utf8"));
const OMP_CLI = join(dirname(OMP_PKG), OMP.bin.omp);
const OMP_ARGS = ["--mode", "rpc", "--provider", "fake", "--model", "fake-1", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files", "--no-title"];

const BUNDLE = adapterBundle("omp");
const OMP_CLIENT = "grayboard-omp";
export const PREFIX = "mcp__grayboard_";
const LOGIN_NOTICE = "grayboard: Signed out of grayboard in omp; run /grayboard login";
const GRAYBOARD_TOOLS = hostTools(snapshotTools()).map((t) => PREFIX + t.name).sort();

const agentDirOf = (dir: string) => join(dir, "omp-agent");
const stateDirOf = (dir: string) => join(agentDirOf(dir), "grayboard");

// Written once per scenario, before any omp starts. models.yml and config.yml
// take JSON (YAML's superset). tools.xdev off exposes the grayboard tools
// top-level, as the scripts call them, instead of behind omp's xd:// devices;
// either way omp runs the extension's registered tool. `settings` adds to
// config.yml.
function installHosted(dir: string, srv: HostedServer, modelPort: number, settings: Record<string, unknown>): void {
  const agentDir = agentDirOf(dir), bin = join(dir, "bin");
  for (const d of [join(agentDir, "extensions"), stateDirOf(dir), bin, join(dir, "home")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentDir, "extensions", "grayboard.js"), BUNDLE);
  writeFileSync(join(stateDirOf(dir), "config.json"), JSON.stringify({ url: srv.resource }));
  writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
    providers: { fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] } },
  }));
  writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ tools: { xdev: false }, ...settings }));
  for (const opener of ["open", "xdg-open"]) writeFileSync(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function startHostedOmp(dir: string, procs: ChildProcess[], { persist = false, session }: { persist?: boolean; session?: string } = {}): Pi {
  const proc = spawn(process.execPath, [OMP_CLI, ...OMP_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--resume", session] : [])], {
    cwd: dir,
    env: cleanEnv({
      HOME: join(dir, "home"), GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"), PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: agentDirOf(dir),
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

const ompRow = (srv: HostedServer, raw: string) => hostedRow(srv, OMP_CLIENT, raw);
const leasedAs = (srv: HostedServer, raw: string, name: string) => leased(srv, OMP_CLIENT, raw, name);
const toolResult = (omp: Pi, tool: string, nth = 0) => toolResultNamed(omp, PREFIX + tool, nth);
// The server's session id for omp's session `raw`.
const serverId = (srv: HostedServer, raw: string): string | undefined => srv.app.db.query<{ session_id: string }, [string, string]>(
  "SELECT session_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(OMP_CLIENT, raw)?.session_id;
// omp finished its run: settled (nothing streaming, queued or pending).
const idle = (omp: Pi, ms = 30_000) => until(async () => (await omp.command({ type: "get_state" })).isSettled === true, ms, "omp settled");

// The hosted audit rows of `action`, oldest first.
type Audit = { target: string; detail: Record<string, unknown> };
const audits = (srv: HostedServer, action: string): Audit[] => srv.app.db.query<{ target: string; detail: string }, [string]>(
  "SELECT target, detail FROM access_log WHERE action = ? ORDER BY id").all(action).map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }));
// The server sessions registered as children of `root` right now.
const liveChildren = (srv: HostedServer, root: string): string[] => srv.app.db.query<{ session_id: string }, [string]>(
  "SELECT session_id FROM hosted_sessions WHERE root_session_id = ?").all(root).map((r) => r.session_id);
// A model request made by a task subagent (taskFanout's child prompt).
const fromChild = (req: ChatRequest): boolean => /\bfake-child-\d+\b/.test(messageText(req.messages.find((m) => m.role === "user") ?? { role: "user", content: "" }));

type Hosted = { srv: HostedServer; model: FakeModel; peer: Peer; start(o?: { persist?: boolean; session?: string }): Pi };

// A failure names omp's version.
async function named(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) e.message = `omp ${OMP.version}: ${e.message}`;
    throw e;
  }
}

function withHosted(dir: string, rules: Rule[], run: (h: Hosted) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const srv = hostedServer();
    const model = startFakeModel([answerPeer(PREFIX), ...rules]);
    let peer: Peer | undefined;
    try {
      peer = await hostedPeer(srv, dir);
      installHosted(dir, srv, model.port, settings);
      await run({ srv, model, peer, start: (o) => startHostedOmp(dir, procs, o) });
      expect(model.unhandled).toEqual([]);
      expect(peer.reports).toEqual([]);
    } finally {
      await stopAll(procs);
      await peer?.close();
      model.stop();
      await srv.stop();
    }
  });
}

// The spec's load smoke for omp: the bundle the CLI's macro emits, loaded by
// the pinned omp under Bun with an isolated HOME and a seeded grant. Its
// value import of @oh-my-pi/pi-coding-agent resolved to the host (getAgentDir
// named the isolated agentDir: the grant was read there, no login notice).
// The status's session line carries omp's own id (session_start ran); the
// root's unbound Controller line needs the MCP client's whoami round trip;
// the delivery lock file exists (node:sqlite under Bun took it). No grayboard
// process runs, and quitting leaves nothing leased.
export function ompHostedLoadSmoke(dir: string): Promise<void> {
  return withHosted(dir, [], async ({ srv, start }) => {
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
    expect(ompRow(srv, sessionId)?.name).toBeNull();
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
  return withHosted(dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-task", create: true } }]),
    scripted("send report", [{ tool: `${PREFIX}dm_send`, args: { to: PEER, body: "report attached", attachments: [join(dir, "report.txt")] } }]),
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
    const bound = await toolResult(omp, "bind");
    expect(bound.isError).toBeFalsy();
    expect(resultText(bound)).toStartWith('Bound to "omp-task"');
    await until(() => leasedAs(srv, sessionId, "omp-task"), 15_000, "omp-task holds the lease");
    const first = model.requests[0]!.body;
    expect(requestTools(first).filter((n) => n.startsWith(PREFIX)).sort()).toEqual(GRAYBOARD_TOOLS);
    expect(systemText(first)).toContain("no bus name yet");
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await idle(omp);

    // A DM wakes the session once: one copy, one turn, one reply; the
    // receipt moves omp-task's cursor past it.
    const asked = model.requests.length;
    const ping = await pingPong(srv, peer, "omp-task");
    await until(() => srv.app.repo.cursors.directFor("alice@example.com/omp-task") >= ping, 15_000, "the receipt advances the cursor");
    await idle(omp);
    const woken = model.requests[asked]!.body;
    expect(messageText(woken.messages.at(-1)!)).toContain(`<channel source="grayboard" message_id="${ping}" from="${PEER}"`);
    // omp runs before_agent_start only for a user prompt, so a wake keeps the
    // last prompt's system prompt (here still unbound); the bind result in
    // context says that note no longer applies, as with local omp's static
    // MCP instructions.
    expect(systemText(woken)).toBe(systemText(model.requests[asked - 1]!.body));
    expect(woken.messages.some((m) => messageText(m).includes("the instructions' note that this session has no bus name no longer applies"))).toBe(true);
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
    const saved = await toolResult(omp, "attachment_get");
    expect(saved.isError).toBeFalsy();
    const got = JSON.parse(resultText(saved)) as { path: string };
    expect(got.path).toBe(join(dir, "saved", new URL(srv.resource).host.replace(/[^A-Za-z0-9.-]/g, "_"), `${fileId}-notes.txt`));
    expect(readFileSync(got.path, "utf8")).toBe(notes);
    await idle(omp);
    expect(grayboardDescendants(omp.pid)).toEqual([]);

    // Quitting releases the lease and ends the session.
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !ompRow(srv, sessionId), 10_000, "released on quit");
  });
}

// A task run with two subagents, each held open (a bash gate) after its
// dm_send: each send is attributed to a child registered under main's
// session, a peer's DM during the run reaches main only, and both children
// are ended once their runs finish (omp keeps a finished subagent live for
// its idle TTL, so this is the agent_end release, not shutdown).
export function ompHostedTaskScenario(dir: string): Promise<void> {
  const gate = join(dir, "go");
  return withHosted(dir, [
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
    await until(() => leasedAs(srv, sessionId, "omp-task"), 30_000, "omp-task holds the lease");
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
    for (const w of writes) expect(w.detail).toMatchObject({ session: w.target, root, name: "omp-task" });
    expect(srv.app.db.query<{ body: string; sender: string }, []>("SELECT body, sender FROM messages WHERE body LIKE 'child %' ORDER BY body").all())
      .toEqual([0, 1].map((i) => ({ body: `child ${i}`, sender: "alice@example.com/omp-task" })));
    expect(liveChildren(srv, root).sort()).toEqual([...children].sort());

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
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !ompRow(srv, sessionId), 10_000, "released on quit");
  });
}

// 130 subagents one at a time (task.maxConcurrency 1), more than the root's
// 128-child cap: each registers at its first call and is ended when its run
// does, so every call succeeds and the root never holds more than one child.
export function ompHostedManyChildrenScenario(dir: string): Promise<void> {
  const n = 130;
  return withHosted(dir, [
    scripted("bind", [{ tool: `${PREFIX}bind`, args: { name: "omp-many", create: true } }]),
    ...taskFanout(n, /^fan out$/, (i) => [{ tool: `${PREFIX}peer_status`, args: { text: `child ${i}` } }]),
  ], async ({ srv, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    await omp.command({ type: "prompt", message: "bind" });
    await until(() => leasedAs(srv, sessionId, "omp-many"), 30_000, "omp-many holds the lease");
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
  }, { task: { maxConcurrency: 1 } });
}

// Two omp processes on one agentDir start with an expired access token: one
// refresh serves both. Then /grayboard logout in one revokes the grant and
// pauses both.
export function ompHostedRefreshLogoutScenario(dir: string): Promise<void> {
  return withHosted(dir, [
    scripted("bind a", [{ tool: `${PREFIX}bind`, args: { name: "omp-a", create: true } }]),
    scripted("bind b", [{ tool: `${PREFIX}bind`, args: { name: "omp-b", create: true } }]),
    scripted("check", [{ tool: `${PREFIX}whoami`, args: {} }]),
  ], async ({ srv, start }) => {
    const seeded = await seedGrant(srv, stateDirOf(dir), OMP_CLIENT, "alice@example.com", -60_000);
    const refreshTokens = () => srv.app.db.query<{ n: number; spent: number }, [string]>(
      "SELECT count(*) AS n, count(spent_at) AS spent FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh'").get(seeded.grantId)!;
    expect(refreshTokens()).toEqual({ n: 1, spent: 0 });

    const a = start(), b = start();
    const [sa, sb] = await Promise.all([a.command({ type: "get_state" }, 30_000), b.command({ type: "get_state" }, 30_000)]);
    expect(sa.sessionId).not.toBe(sb.sessionId);
    // Both reached the server on the one rotation.
    await until(() => ompRow(srv, sa.sessionId) && ompRow(srv, sb.sessionId), 20_000, "both sessions on the server");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });

    await a.command({ type: "prompt", message: "bind a" });
    await b.command({ type: "prompt", message: "bind b" });
    await until(() => ompRow(srv, sa.sessionId)?.name === "omp-a" && ompRow(srv, sb.sessionId)?.name === "omp-b" && srv.app.mcp.activeLeases === 2, 30_000, "both leased");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });
    await Promise.all([idle(a), idle(b)]);

    // Logout in a: the grant is revoked, so the server drops both leases,
    // and both processes pause with the login notice.
    const seenA = a.notices().length, seenB = b.notices().length;
    await a.command({ type: "prompt", message: "/grayboard logout" });
    await until(() => a.notices().slice(seenA).includes("grayboard: signed out; every omp session on this server pauses until run /grayboard login"), 10_000, "the logout notice");
    await until(() => srv.app.mcp.activeLeases === 0, 15_000, "both leases dropped");
    expect(srv.app.db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM oauth_grants WHERE id = ?").get(seeded.grantId)!.revoked_at).not.toBeNull();
    await until(() => b.notices().slice(seenB).includes(LOGIN_NOTICE), 15_000, "the login notice in the other process");
    for (const omp of [a, b]) {
      const status = await statusOf(omp);
      expect(status).toContain("\nsign-in: signed out (logged_out); run /grayboard login\n");
      expect(status).toMatch(/: paused, /);
    }
    // The other process's next tool call says to sign in.
    await b.command({ type: "prompt", message: "check" });
    const checked = await toolResult(b, "whoami");
    expect(checked.isError).toBe(true);
    expect(resultText(checked)).toBe("error: Signed out of grayboard in omp; run /grayboard login");
    await Promise.all([a.quit(), b.quit()]);
  });
}
