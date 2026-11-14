// The Claude Code plugin's stdio server (#281) as Claude Code runs it: a
// process named `claude` (bun under another name) with the launch flags on
// its command line runs `bun plugins/claude-code/src/main.ts` on inherited
// stdio, with the environment Claude Code gives a plugin's server. A scripted
// MCP client plays Claude Code (server/discover → -32601 → initialize, URL
// elicitation answered through the server's real consent page) against a
// hosted server whose public URL is its listen address.
//
// Covers: tools/list before login; bind, one channel push per DM and its
// receipt; attachments both ways; two processes on one data dir refreshing
// once; a second process on the same session id running tools-only until the
// first exits; -p (no lease, no listener, no sign-in prompt); sign-in by URL
// elicitation, single-flight within and across processes, re-offered after a
// decline; the link shown by the post-tool-use hook and never in a result
// (#500), with a result before the flow has a link naming the next call; the
// pre-2026-07-28 protocol; release on EOF with a lease, session_end without.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CancelledNotificationSchema, ElicitationCompleteNotificationSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Controller } from "../../adapters/hosted-core/src/controller.ts";
import { Diagnostics } from "../../adapters/hosted-core/src/diagnostics.ts";
import { tryAcquire } from "../../adapters/hosted-core/src/lock.ts";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { ToolProxy } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { putSignIn, sessionDir, SIGN_IN } from "../../src/shared/claude_agents.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { CLIENT_ID, createPlugin, LOGIN_ELSEWHERE, SOURCE } from "../../plugins/claude-code/src/plugin.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { browse, hostedServer, seedGrant, type HostedServer } from "../support/hosted_oauth.ts";
import { closeSessions, mcpSession, stopSession, type ClientShape, type Session } from "../support/mcp.ts";
import { until } from "../support/until.ts";
import { descendants } from "../support/claude_code.ts";

const ENTRY = resolve(import.meta.dir, "../../plugins/claude-code/src/main.ts");
const EMAIL = "alice@example.com";
const FLAG = ["--dangerously-load-development-channels", "plugin:grayboard@grayboard"];
const HELD = "another Claude Code process holds delivery for this session";

let srv: HostedServer, dir: string, data: string, fake: string, host: string, stopped: boolean;

beforeEach(() => {
  srv = hostedServer();
  stopped = false;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-claude-plugin-")));
  // HOME without .claude.json or managed settings: the channel policy passes.
  mkdirSync(join(dir, "home"));
  data = join(dir, "data");
  mkdirSync(join(dir, "work"));
  fake = join(dir, "claude");
  symlinkSync(process.execPath, fake);
  host = join(dir, "host.ts");
  writeFileSync(host, `const cmd = process.argv.slice(process.argv.indexOf("::") + 1);
Bun.spawn([process.execPath, ...cmd], { stdio: ["inherit", "inherit", "inherit"] }).exited.then((c) => process.exit(c ?? 0));`);
});
afterEach(async () => {
  await closeSessions();
  if (!stopped) await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

const user = () => srv.app.db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(EMAIL)!.id;
type Row = { name: string | null; lease_deadline: number | null; ownership_id: number };
const row = (id: string) => srv.app.db.query<Row, [string]>(
  "SELECT (SELECT substr(address, instr(address, '/') + 1) FROM alias_holds WHERE id = session_id ORDER BY bound_at, address LIMIT 1) AS name, lease_deadline, ownership_id FROM hosted_sessions WHERE session_id = ?").get(hostedSessionId(user(), CLIENT_ID, id));
const ownership = (ownershipId: number) => srv.app.db.query<{ ended_at: number | null; end_reason: string | null }, [number]>(
  "SELECT ended_at, end_reason FROM hosted_ownerships WHERE id = ?").get(ownershipId)!;
const leaseClosed = (id: string) => srv.app.db.query<{ n: number }, [string]>(
  "SELECT count(*) AS n FROM access_log WHERE action = 'hosted.lease_closed' AND target = ?").get(hostedSessionId(user(), CLIENT_ID, id))!.n;

type Elicit = { url: string; message: string };
// completed: elicitation ids the plugin completed; withdrawn: ids whose request it
// cancelled (notifications/cancelled), recorded by request id (#713).
// aborted: ids whose handler the SDK's own cancel handler aborted, as Claude Code's does.
type Plugin = Session & { elicits: Elicit[]; completed: string[]; withdrawn: string[]; aborted: string[] };

// One Claude Code session's plugin server. `flags` are Claude Code's own;
// `answer` answers each URL elicitation (default: accept and complete the
// sign-in in the browser); `elicit: false` leaves the capability out.
async function plugin(id: string, o: {
  flags?: string[]; answer?: (e: Elicit) => Promise<ElicitResult["action"]>; elicit?: boolean; before?: ClientShape["before"]; env?: Record<string, string>;
} = {}): Promise<Plugin> {
  const elicits: Elicit[] = [], completed: string[] = [], withdrawn: string[] = [], aborted: string[] = [];
  const ids = new Map<string | number, string>(); // JSON-RPC request id → elicitation id
  const answer = o.answer ?? (async (e) => { void browse(srv.issuer, e.url, "Claude Code"); return "accept"; });
  const s = await mcpSession({
    env: {
      PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: id, CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PROJECT_DIR: join(dir, "work"), GRAYBOARD_SERVER_URL: srv.resource, ...o.env,
    },
    cwd: join(dir, "work"),
    via: [fake, host, ...(o.flags ?? FLAG), "::"],
    entry: ENTRY,
    client: {
      capabilities: o.elicit === false ? {} : { elicitation: { url: {} } },
      before: o.before,
      setup: (c: Client) => {
        if (o.elicit === false) return;
        c.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
          const p = req.params as { mode?: string; url: string; message: string; elicitationId: string };
          expect(p.mode).toBe("url");
          ids.set(extra.requestId, p.elicitationId);
          extra.signal.addEventListener("abort", () => aborted.push(p.elicitationId), { once: true });
          const e = { url: p.url, message: p.message };
          elicits.push(e);
          return { action: await answer(e) };
        });
        // Recorded by request id, not through the handler's abort signal: the
        // SDK's own cancel handler (Claude Code 2.1.316 bundles the same) skips
        // request id 0, which is the plugin's first prompt (#713).
        const builtin = (c as unknown as { _notificationHandlers: Map<string, (n: unknown) => Promise<void>> })._notificationHandlers.get("notifications/cancelled")!;
        c.setNotificationHandler(CancelledNotificationSchema, async (n) => {
          const id = n.params.requestId === undefined ? undefined : ids.get(n.params.requestId);
          if (id) withdrawn.push(id);
          await builtin(n);
        });
        c.setNotificationHandler(ElicitationCompleteNotificationSchema, async (n) => { completed.push(n.params.elicitationId); });
      },
    },
  });
  return Object.assign(s, { elicits, completed, withdrawn, aborted });
}

// A tool result's text blocks, error or not.
const texts = async (s: Session, name: string, args: Record<string, unknown> = {}) => {
  const r = await s.c.callTool({ name, arguments: args });
  return { error: r.isError === true, texts: (r.content as { type: string; text: string }[]).filter(b => b.type === "text").map(b => b.text) };
};
const signedIn = (s: Session) => until(async () => !(await texts(s, "whoami")).error, 15_000, "the plugin to sign in");

test("a flagged interactive session: discover is refused, the handshake stays below 2026-07-28, tools list, bind holds the lease, a DM arrives as one channel push and its receipt moves the cursor", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  let discovered: unknown;
  const alpha = await plugin("sess-alpha", {
    before: async (exchange) => { discovered = await exchange({ jsonrpc: "2.0", id: "discover", method: "server/discover", params: {} }); },
  });
  expect(discovered).toMatchObject({ id: "discover", error: { code: -32601 } });
  expect(alpha.protocol()).toBe("2025-11-25");
  expect(alpha.c.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
  expect(alpha.c.getInstructions()).not.toContain("Warning:");
  const { tools } = await alpha.c.listTools();
  expect(tools.map(t => t.name)).toContain("bind");

  const bound = await texts(alpha, "bind", { name: "alpha", create: true });
  expect(bound.error).toBe(false);
  expect(bound.texts[0]).toStartWith(`Bound to "alpha"`);
  await until(() => row("sess-alpha")?.lease_deadline != null, 10_000, "alpha's lease");
  expect(row("sess-alpha")!.name).toBe("alpha");
  expect(existsSync(deliveryPath(data, srv.resource, CLIENT_ID, "sess-alpha"))).toBe(true);

  const beta = await plugin("sess-beta");
  expect((await texts(beta, "bind", { name: "beta", create: true })).error).toBe(false);
  expect((await texts(beta, "dm_send", { to: "alpha", body: "hello from beta" })).error).toBe(false);
  await until(() => alpha.pushes.length > 0, 10_000, "the DM's channel push");
  const message = srv.app.db.query<{ id: number }, []>("SELECT id FROM messages WHERE body = 'hello from beta'").get()!;
  expect(alpha.pushes[0]!.content).toBe("hello from beta");
  expect(alpha.pushes[0]!.meta).toMatchObject({ from: `${EMAIL}/beta`, message_id: String(message.id) });
  await until(() => srv.app.db.query<{ last_seen_id: number }, [string]>(
    "SELECT last_seen_id FROM mailbox_cursors WHERE stream_type = 'direct' AND address = ?").get(`${EMAIL}/alpha`)?.last_seen_id === message.id,
  10_000, "the receipt to advance alpha's cursor");
  await Bun.sleep(500);
  expect(alpha.pushes).toHaveLength(1);
  expect(beta.pushes).toEqual([]);
  // The source Claude Code shows is the plugin's server name.
  expect(SOURCE).toBe("plugin:grayboard:grayboard");
}, 40_000);

// ---- subagents as child sessions (#551) ----

const HOOK = resolve(import.meta.dir, "../../plugins/claude-code/dist/hook.js");
// The process the plugin's server runs under: Claude Code's stand-in, the hooks' CLAUDE_PID.
const claudePid = (s: Session) => descendants(s.harnessPid).find(([, cmd]) => cmd.includes(host))![0];
// The committed hook bundle as Claude Code runs it, on one event's input.
const runHook = (s: Session, event: string, input: Record<string, unknown>) => {
  const r = Bun.spawnSync([process.execPath, HOOK, event, "--data", data], {
    stdin: new TextEncoder().encode(JSON.stringify(input)), env: { PATH: process.env.PATH!, CLAUDE_PID: String(claudePid(s)) }, stdout: "pipe", stderr: "pipe",
  });
  expect({ exit: r.exitCode, err: r.stderr.toString() }).toEqual({ exit: 0, err: "" });
  // Only post-tool-use ever prints, and only the sign-in link (#500).
  if (event !== "post-tool-use") expect(r.stdout.toString()).toBe("");
  return r.stdout.toString();
};
// What the hook after a grayboard call shows the user: the live sign-in link's line, or nothing (#500).
const shown = (s: Session) => {
  const out = runHook(s, "post-tool-use", { hook_event_name: "PostToolUseFailure", tool_name: "mcp__plugin_grayboard_grayboard__whoami", tool_use_id: `toolu_01Shown${++uses}` });
  return out ? (JSON.parse(out) as { systemMessage: string }).systemMessage : undefined;
};
// The sign-in link file the plugin's server wrote for this session (#500).
const linkFile = (s: Session) => existsSync(join(sessionDir(data, claudePid(s)), SIGN_IN));
// A sign-in result's note: it names where the link is, never the link (#500).
const STARTED = "grayboard: sign-in started: ask the user to open the sign-in link Claude Code shows under this call (or approve its sign-in prompt), then call a grayboard tool again";
let uses = 0;
// One model call as Claude Code makes it: PreToolUse's record (an `agent` for a subagent's), then the call with its tool_use_id.
const modelCall = async (s: Session, name: string, args: Record<string, unknown>, o: { agent?: string; hook?: boolean; effort?: string } = {}) => {
  const id = `toolu_01Test${++uses}`;
  if (o.hook !== false) runHook(s, "pre-tool-use", { hook_event_name: "PreToolUse", tool_name: `mcp__plugin_grayboard_grayboard__${name}`, tool_use_id: id, ...(o.agent ? { agent_id: o.agent } : {}), ...(o.effort ? { effort: { level: o.effort } } : {}) });
  const r = await s.c.callTool({ name, arguments: args, _meta: { "claudecode/toolUseId": id } });
  return { error: r.isError === true, texts: (r.content as { type: string; text: string }[]).filter(b => b.type === "text").map(b => b.text), structured: r.structuredContent as Record<string, unknown> | undefined };
};
const childRow = (sessionID: string, agent: string) => srv.app.db.query<{ root_session_id: string | null }, [string]>(
  "SELECT root_session_id FROM hosted_sessions WHERE session_id = ?").get(hostedSessionId(user(), CLIENT_ID, `${sessionID}/agent/${agent}`));

for (const mode of ["push", "tools-only"] as const) {
  test(`${mode}: a subagent's call runs as a child of the root, with via; the main agent's as the root; SubagentStop ends the child's session`, async () => {
    await seedGrant(srv, data, CLIENT_ID, EMAIL);
    const id = `sess-sub-${mode}`;
    const root = await plugin(id, mode === "push" ? {} : { flags: [] });
    runHook(root, "session-start", { hook_event_name: "SessionStart", source: "startup" });
    expect((await modelCall(root, "bind", { name: "lead", create: true })).error).toBe(false);
    if (mode === "push") await until(() => row(id)?.lease_deadline != null, 10_000, "the root's lease");
    else expect(row(id)?.lease_deadline ?? null).toBeNull();
    const peer = await plugin("sess-sub-peer");
    expect((await texts(peer, "bind", { name: "peer", create: true })).error).toBe(false);

    const child = hostedSessionId(user(), CLIENT_ID, `${id}/agent/a573e90bd84bce7ff`);
    const sent = await modelCall(root, "dm_send", { to: "peer", body: "from the subagent" }, { agent: "a573e90bd84bce7ff" });
    expect(sent.error).toBe(false);
    const own = await modelCall(root, "dm_send", { to: "peer", body: "from the main agent" });
    expect(own.error).toBe(false);
    const by = (body: string) => srv.app.db.query<{ sender: string; via: string | null }, [string]>("SELECT sender, via FROM messages WHERE body = ?").get(body);
    expect(by("from the subagent")).toEqual({ sender: `${EMAIL}/lead`, via: child });
    expect(by("from the main agent")).toEqual({ sender: `${EMAIL}/lead`, via: null });
    expect(childRow(id, "a573e90bd84bce7ff")?.root_session_id).toBe(hostedSessionId(user(), CLIENT_ID, id));
    // The peer's push carries the child as via; the main agent's carries none.
    const push = (body: string) => peer.pushes.find((p) => p.content.includes(body));
    await until(() => push("from the subagent") && push("from the main agent"), 10_000, "the peer's pushes");
    expect(push("from the subagent")!.meta).toMatchObject({ via: child });
    expect(push("from the main agent")!.meta).not.toHaveProperty("via");
    // The peer's history renders the child.
    const history = await texts(peer, "dm_history", {});
    expect(history.texts.join("\n")).toContain(child);
    // A child can't bind: it acts under its root's names.
    const bind = await modelCall(root, "bind", { name: "other", create: true }, { agent: "a573e90bd84bce7ff" });
    expect(bind.error).toBe(true);
    expect(bind.texts.join("\n")).toContain("child");

    if (mode === "tools-only") {
      // The server ends the root (the idle sweep, say), which ends its child; the
      // subagent's next call registers it again under the root, never as a root
      // of its own (#553 audit 3).
      srv.app.mcp.sessions.release(hostedSessionId(user(), CLIENT_ID, id), "idle");
      await until(() => !childRow(id, "a573e90bd84bce7ff"), 10_000, "the root's end to end its child");
      // The end freed the root's name, so the new root is unbound: the child is
      // refused as its subagent, and its row is a child again, not a root.
      const again = await modelCall(root, "dm_send", { to: "peer", body: "after the root's end" }, { agent: "a573e90bd84bce7ff" });
      expect(again.error).toBe(true);
      expect(again.texts.join("\n")).toContain("this session is a subagent of");
      expect(childRow(id, "a573e90bd84bce7ff")?.root_session_id).toBe(hostedSessionId(user(), CLIENT_ID, id));
      expect(by("after the root's end")).toBeNull();
      expect((await modelCall(root, "bind", { name: "lead", create: true })).error).toBe(false);
    }

    runHook(root, "subagent-stop", { hook_event_name: "SubagentStop", agent_id: "a573e90bd84bce7ff" });
    await until(() => !childRow(id, "a573e90bd84bce7ff"), 10_000, "the child's hosted session to end");
    // The root is untouched.
    expect(row(id)?.name).toBe("lead");
  }, 60_000);
}

test("a call whose PreToolUse record is missing or from a recycled pid is refused and writes nothing", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const root = await plugin("sess-sub-missing");
  runHook(root, "session-start", { hook_event_name: "SessionStart", source: "startup" });
  expect((await modelCall(root, "bind", { name: "solo", create: true })).error).toBe(false);
  const missing = await modelCall(root, "dm_send", { to: "solo", body: "unattributed" }, { hook: false });
  expect(missing.error).toBe(true);
  expect(missing.texts.join("\n")).toContain("couldn't tell which Claude Code agent made this call (the grayboard PreToolUse hook wrote no record for this call)");
  expect(root.stderr()).toContain("no agent record");
  const bad = await root.c.callTool({ name: "whoami", arguments: {}, _meta: { "claudecode/toolUseId": "../start" } });
  expect(bad.isError).toBe(true);
  // A start time that isn't Claude Code's: the dir belongs to an earlier process with this pid.
  writeFileSync(join(data, "claude-agents", String(claudePid(root)), "start"), "Mon Jan  1 00:00:00 2001");
  const recycled = await modelCall(root, "dm_send", { to: "solo", body: "unattributed" });
  expect(recycled.texts.join("\n")).toContain("an earlier process with the same pid");
  expect(srv.app.db.query("SELECT count(*) AS n FROM messages WHERE body = 'unattributed'").get()).toEqual({ n: 0 });
}, 40_000);

test("a subagent whose child id would pass the server's 1024 characters is refused client-side with the length, and writes nothing (#555 item 15)", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const id = "sess-sub-long";
  const root = await plugin(id);
  runHook(root, "session-start", { hook_event_name: "SessionStart", source: "startup" });
  expect((await modelCall(root, "bind", { name: "longroot", create: true })).error).toBe(false);
  // 1024 - "sess-sub-long/agent/".length = 1004 fits exactly; one more is over.
  const fits = "a".repeat(1024 - `${id}/agent/`.length), over = `${fits}b`;
  const ok = await modelCall(root, "dm_send", { to: "longroot", body: "at the limit" }, { agent: fits });
  expect(ok.error).toBe(false);
  const refused = await modelCall(root, "dm_send", { to: "longroot", body: "over the limit" }, { agent: over });
  expect(refused.error).toBe(true);
  expect(refused.texts.join("\n")).toContain("is 1025 characters, over the server's 1024-character limit");
  expect(root.stderr()).toContain("subagent child id is 1025 characters");
  expect(srv.app.db.query("SELECT count(*) AS n FROM messages WHERE body = 'over the limit'").get()).toEqual({ n: 0 });
  expect(childRow(id, over)).toBeNull();
  // The main agent's calls still work.
  expect((await modelCall(root, "whoami", {})).error).toBe(false);
}, 40_000);

test("the root reports the model and effort its hooks wrote (#545); a subagent's call reports none, and a bad fact file sends none", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const id = "sess-facts";
  const root = await plugin(id);
  const facts = (session: string) => srv.app.db.query<{ model: string | null; effort: string | null }, [string]>("SELECT model, effort FROM ids WHERE id = ?").get(session);
  const rootId = hostedSessionId(user(), CLIENT_ID, id), child = hostedSessionId(user(), CLIENT_ID, `${id}/agent/a1b2c3d4e5f6a7b8c`);
  runHook(root, "session-start", { hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" });
  expect((await modelCall(root, "bind", { name: "facts", create: true }, { effort: "medium" })).error).toBe(false);
  expect(facts(rootId)).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  // A confirmed /model switch, then a call under /effort high.
  runHook(root, "model-switch", { hook_event_name: "PostModelSwitch", from_model: "claude-opus-5-5", to_model: "claude-sonnet-5-5", source: "command" });
  expect((await modelCall(root, "whoami", {}, { effort: "high" })).error).toBe(false);
  expect(facts(rootId)).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  // A subagent's call: its child session gets no facts, and the root's stay.
  expect((await modelCall(root, "whoami", {}, { agent: "a1b2c3d4e5f6a7b8c", effort: "low" })).error).toBe(false);
  expect(facts(child)).toEqual({ model: null, effort: null });
  expect(facts(rootId)).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  // A model file that isn't one: the call still runs and sends the effort, and stderr says so once.
  writeFileSync(join(data, "claude-agents", String(claudePid(root)), "model"), "not a model");
  expect((await modelCall(root, "whoami", {}, { effort: "low" })).error).toBe(false);
  expect((await modelCall(root, "whoami", {}, { effort: "max" })).error).toBe(false);
  expect(facts(rootId)).toEqual({ model: "claude-sonnet-5-5", effort: "max" });
  expect(root.stderr().split("the server gets no model for this session").length - 1).toBe(1);
  expect(root.stderr()).not.toContain("couldn't read session");
}, 40_000);

test("an explicit BUS_IDENTITY binds at start (#443), created if new, with delivery; one the naming rule refuses is said in the first tool result", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  await plugin("sess-conf", { env: { BUS_IDENTITY: "Conf-Plug" } });
  await until(() => row("sess-conf")?.name === "conf-plug" && row("sess-conf")?.lease_deadline != null, 10_000, "the configured name's lease");

  const bad = await plugin("sess-conf-bad", { env: { BUS_IDENTITY: "no spaces" } });
  const first = await texts(bad, "whoami");
  expect(first.texts[0]).toMatch(/^grayboard: BUS_IDENTITY is ignored: invalid identity name "no spaces"/);
  expect(row("sess-conf-bad")?.name ?? null).toBeNull();
}, 30_000);

test("dm_send attaches a file from the session's directory, and attachment_get saves it in the other session", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const sender = await plugin("sess-send"), reader = await plugin("sess-read");
  await texts(sender, "bind", { name: "send", create: true });
  await texts(reader, "bind", { name: "read", create: true });
  const bytes = "plugin attachment\n";
  writeFileSync(join(dir, "work", "report.txt"), bytes);
  const sent = await texts(sender, "dm_send", { to: "read", body: "see attached", attachments: [join(dir, "work", "report.txt")] });
  expect(sent.error).toBe(false);
  const stored = srv.app.db.query<{ id: number }, []>("SELECT id FROM attachments WHERE filename = 'report.txt'").get()!;
  mkdirSync(join(dir, "work", "in"));
  const got = await texts(reader, "attachment_get", { id: stored.id, dir: join(dir, "work", "in") });
  expect(got.error).toBe(false);
  const saved = JSON.parse(got.texts.at(-1)!) as { path: string };
  expect(saved.path).toBe(join(dir, "work", "in", `${stored.id}-report.txt`));
  expect(readFileSync(saved.path, "utf8")).toBe(bytes);
}, 40_000);

test("two plugin processes on one data dir with an expired access token refresh it once", async () => {
  const seeded = await seedGrant(srv, data, CLIENT_ID, EMAIL, -1);
  const refreshTokens = () => srv.app.db.query<{ n: number; spent: number }, [string]>(
    "SELECT count(*) AS n, count(spent_at) AS spent FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh'").get(seeded.grantId)!;
  expect(refreshTokens()).toEqual({ n: 1, spent: 0 });
  const [a, b] = await Promise.all([plugin("sess-a"), plugin("sess-b")]);
  const [ra, rb] = await Promise.all([texts(a, "whoami"), texts(b, "whoami")]);
  expect(ra.error).toBe(false);
  expect(rb.error).toBe(false);
  expect(refreshTokens()).toEqual({ n: 2, spent: 1 });
  expect(a.elicits).toEqual([]);
  expect(b.elicits).toEqual([]);
}, 40_000);

test("a second process on the same session id runs tools-only and says why, then takes delivery when the first exits", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const first = await plugin("sess-same");
  await texts(first, "bind", { name: "same", create: true });
  await until(() => row("sess-same")?.lease_deadline != null, 10_000, "the first process's lease");

  const second = await plugin("sess-same");
  expect(second.c.getInstructions()).toContain(`Warning: ${HELD}`);
  const r = await texts(second, "whoami");
  expect(r.texts[0]).toBe(`grayboard: ${HELD}`);
  expect((await texts(second, "whoami")).texts[0]).not.toStartWith("grayboard:");
  // A tools-only process must not rebind the session the holder owns.
  const refused = await texts(second, "unbind", {});
  expect(refused.texts.join("\n")).toContain("work from the process that holds delivery");
  expect(row("sess-same")?.name).toBe("same");

  const other = await plugin("sess-other");
  await texts(other, "bind", { name: "other", create: true });
  await stopSession(first.c);
  // The second takes the lock, rebinds the name and receives the next DM.
  await until(async () => row("sess-same")?.lease_deadline != null && row("sess-same")?.name === "same", 15_000, "the second process to take delivery");
  await texts(other, "dm_send", { to: "same", body: "after handover" });
  await until(() => second.pushes.some(p => p.content === "after handover"), 10_000, "the push to the second process");
}, 50_000);

test("-p: no lease, no delivery lock, no sign-in prompt; a signed-out call names signing in elsewhere, and EOF ends the bound session with session_end", async () => {
  const signedOut = await plugin("sess-print-out", { flags: ["-p", ...FLAG] });
  // Tools list before any sign-in.
  expect((await signedOut.c.listTools()).tools.map(t => t.name)).toContain("bind");
  expect(signedOut.c.getInstructions()).toStartWith("Warning: this Claude Code session is tools-only");
  // -p's reason has no launch remedy: none is prescribed.
  expect(signedOut.c.getInstructions()).not.toContain("--dangerously-load-development-channels");
  const refused = await texts(signedOut, "whoami");
  expect(refused.error).toBe(true);
  expect(refused.texts.join("\n")).toContain(LOGIN_ELSEWHERE);
  // The off notice rides the first tool result, once.
  expect(refused.texts[0]).toStartWith("grayboard: Warning: this Claude Code session is tools-only");
  expect((await texts(signedOut, "whoami")).texts.join("\n")).not.toContain("tools-only");
  await Bun.sleep(300);
  expect(signedOut.elicits).toEqual([]);
  await stopSession(signedOut.c);

  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const p = await plugin("sess-print", { flags: ["-p", ...FLAG] });
  expect((await texts(p, "bind", { name: "printer", create: true })).error).toBe(false);
  const bound = row("sess-print")!;
  expect(bound).toMatchObject({ name: "printer", lease_deadline: null });
  expect(existsSync(deliveryPath(data, srv.resource, CLIENT_ID, "sess-print"))).toBe(false);
  const sender = await plugin("sess-print-sender");
  await texts(sender, "bind", { name: "print-sender", create: true });
  await texts(sender, "dm_send", { to: "printer", body: "not pushed" });
  await Bun.sleep(1_000);
  expect(p.pushes).toEqual([]);

  await stopSession(p.c);
  expect(row("sess-print")).toBeNull();
  expect(ownership(bound.ownership_id)).toMatchObject({ ended_at: expect.any(Number), end_reason: "closed" });
  expect(leaseClosed("sess-print")).toBe(0);
}, 50_000);

test("EOF on a session holding the lease releases it: the name is free at once", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const s = await plugin("sess-eof");
  await texts(s, "bind", { name: "eof", create: true });
  await until(() => row("sess-eof")?.lease_deadline != null, 10_000, "the lease");
  const ownershipId = row("sess-eof")!.ownership_id;
  await stopSession(s.c);
  expect(row("sess-eof")).toBeNull();
  expect(ownership(ownershipId)).toMatchObject({ ended_at: expect.any(Number), end_reason: "closed" });
  expect(leaseClosed("sess-eof")).toBe(1);
}, 30_000);

test("sign-in by URL elicitation: offered at startup, re-offered by the next call after a decline, one prompt for concurrent calls, completed after the browser returns", async () => {
  let decline = true;
  const s = await plugin("sess-login", {
    answer: async (e) => {
      if (decline) { decline = false; return "decline"; }
      void browse(srv.issuer, e.url, "Claude Code");
      return "accept";
    },
  });
  expect(s.c.getInstructions()).toContain("is signed out in Claude Code");
  await until(() => s.elicits.length === 1, 10_000, "the startup sign-in prompt");
  expect(s.elicits[0]!.url).toStartWith(`${srv.issuer}/`);
  expect(s.elicits[0]!.message).toContain(srv.issuer);
  await until(() => /sign-in failed \((?:startup|offer), elicitation [^)]+\): sign-in declined/.test(s.stderr()), 10_000, "the decline");
  // The declined flow's link went with it (#500).
  await until(() => !linkFile(s), 5_000, "the declined flow's link removed");
  expect(shown(s)).toBeUndefined();

  // Two calls while signed out: one prompt between them.
  const calls = await Promise.all([texts(s, "whoami"), texts(s, "peer_list")]);
  for (const c of calls) expect(c.error).toBe(true);
  await signedIn(s);
  expect(s.elicits).toHaveLength(2);
  await until(() => s.completed.length === 1, 10_000, "the elicitation's completion notice");
}, 40_000);

test("a prompt left unanswered (#497, #500): every signed-out call shows the user the link, no result carries it, opening it signs in, and the prompt is completed and withdrawn", async () => {
  const s = await plugin("sess-unanswered", { answer: () => new Promise(() => {}) });
  await until(() => s.elicits.length === 1, 10_000, "the startup sign-in prompt");
  const calls = await Promise.all([texts(s, "whoami"), texts(s, "peer_list")]);
  for (const c of calls) {
    expect(c.error).toBe(true);
    expect(c.texts[0]).toBe(STARTED);
    expect(c.texts.join("\n")).not.toContain(srv.issuer);
  }
  // The hook after each call shows the elicited URL, the user's line and not the model's.
  expect(shown(s)).toBe(`grayboard: open ${s.elicits[0]!.url} to sign in`);
  expect(s.c.getInstructions()).not.toContain(s.elicits[0]!.url);
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
  // A finished flow's link is gone: no later call shows it.
  expect(linkFile(s)).toBe(false);
  expect(shown(s)).toBeUndefined();
  await until(() => s.completed.length === 1, 10_000, "the elicitation's completion notice");
  // Completed, then its request withdrawn: Claude Code keeps no pending prompt (#501).
  await until(() => s.withdrawn.length === 1, 10_000, "the prompt's withdrawal");
  expect(s.withdrawn).toEqual(s.completed);
  expect(s.elicits).toHaveLength(1);
  const said = s.stderr();
  expect(said).toContain("sign-in prompt sent (elicitation ");
  expect(said).not.toMatch(/sign-in prompt \(elicitation [^)]+\) ended without an answer/);
  expect(said).not.toContain("sign-in failed");
}, 40_000);

test("a sign-in denied in the browser: the flow fails, its unanswered prompt is withdrawn and never completed (#501)", async () => {
  const s = await plugin("sess-denied", { answer: () => new Promise(() => {}) });
  await until(() => s.elicits.length === 1, 10_000, "the startup sign-in prompt");
  await browse(srv.issuer, s.elicits[0]!.url, "Claude Code", "deny");
  await until(() => s.stderr().includes("sign-in failed (startup"), 15_000, "the failed flow");
  await until(() => s.withdrawn.length === 1, 10_000, "the prompt's withdrawal");
  // The SDK's handler, which skips request id 0, aborted it too: the plugin spent id 0 on a ping (#713).
  await until(() => s.aborted.length === 1, 5_000, "the SDK's cancel handler to abort the prompt");
  expect(s.completed).toEqual([]);
  expect(linkFile(s)).toBe(false);
  // The withdrawal isn't an unanswered prompt: the flow's failure is the one line.
  expect(s.stderr()).not.toMatch(/sign-in prompt \(elicitation [^)]+\) ended without an answer/);
}, 40_000);

test("a prompt Claude Code cancels unshown (its connection-setup handler) is sent again; a cancel after it was shown is not", async () => {
  // First answer: an instant cancel, as 2.1.316 gives while still wiring the
  // connection. Second: shown, then Esc after the UNSHOWN_MS window.
  let n = 0;
  const s = await plugin("sess-unshown", {
    answer: async () => {
      if (n++ === 0) return "cancel";
      await Bun.sleep(1_200);
      return "cancel";
    },
  });
  await until(() => s.elicits.length === 2, 10_000, "the prompt sent again after the unshown cancel");
  expect(s.elicits[1]!.url).toBe(s.elicits[0]!.url);
  await until(() => /answered: cancel after \d{4,} ms/.test(s.stderr()), 10_000, "the shown prompt's Esc");
  // Esc keeps the flow and its link, and asks no more.
  const call = await texts(s, "whoami");
  expect(call.texts[0]).toBe(STARTED);
  expect(shown(s)).toBe(`grayboard: open ${s.elicits[0]!.url} to sign in`);
  expect(s.elicits).toHaveLength(2);
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
}, 40_000);

test("unshown cancels are re-sent at most RESENDS times: four instant cancels, four prompts, then the cap line (#506)", async () => {
  const s = await plugin("sess-cap", { answer: async () => "cancel" });
  await until(() => s.stderr().includes("sign-in prompt cancelled unshown 4 times; the link Claude Code shows under each grayboard call remains"), 15_000, "the cap line");
  expect(s.elicits).toHaveLength(4);
  expect(s.stderr().match(/sending it again \(\d\/3\)/g)).toEqual(["sending it again (1/3)", "sending it again (2/3)", "sending it again (3/3)"]);
  // The flow and its link stay; the user can still open it.
  const call = await texts(s, "whoami");
  expect(call.texts[0]).toBe(STARTED);
  expect(s.elicits).toHaveLength(4);
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
}, 40_000);

test("a flow that ends during the re-send wait sends no prompt (#506)", async () => {
  // Held after the RESEND_MS wait while the browser signs in.
  const release = join(dir, "resend.release");
  const s = await plugin("sess-resend-ended", {
    answer: async () => "cancel",
    env: { BUS_TEST_PAUSE: "claude-sign-in-resend", BUS_TEST_PAUSE_FILE: release },
  });
  await until(() => s.stderr().includes("test pause hit: claude-sign-in-resend"), 10_000, "the re-send wait");
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await until(() => s.stderr().includes("signed in (startup)"), 10_000, "the flow's end");
  writeFileSync(release, "");
  await until(() => s.stderr().includes("sign-in ended before the prompt was sent again"), 10_000, "the re-send skipped");
  expect(s.elicits).toHaveLength(1);
  await signedIn(s);
}, 40_000);

test("a re-send wait that ends after the browser answered, with the code exchange still running, sends no prompt (#506)", async () => {
  // Held after the RESEND_MS wait; the server holds the code exchange.
  const release = join(dir, "resend.release");
  const s = await plugin("sess-resend-answered", {
    answer: async () => "cancel",
    env: { BUS_TEST_PAUSE: "claude-sign-in-resend", BUS_TEST_PAUSE_FILE: release },
  });
  await until(() => s.stderr().includes("test pause hit: claude-sign-in-resend"), 10_000, "the re-send wait");
  const oauth = srv.app.oauth, fetch = oauth.fetch.bind(oauth);
  const exchange = Promise.withResolvers<void>();
  let held = false;
  oauth.fetch = async (req, context) => {
    if (req.method === "POST" && new URL(req.url).pathname === "/oauth/token" && new URLSearchParams(await req.clone().text()).get("grant_type") === "authorization_code") {
      held = true;
      await exchange.promise;
    }
    return fetch(req, context);
  };
  try {
    const browsed = browse(srv.issuer, s.elicits[0]!.url, "Claude Code");
    await until(() => held, 10_000, "the code exchange at the server");
    writeFileSync(release, "");
    await until(() => s.stderr().includes("the browser answered before the prompt was sent again"), 10_000, "the re-send skipped");
    expect(s.elicits).toHaveLength(1);
    expect(s.stderr()).not.toContain("sign-in ended before the prompt was sent again");
    exchange.resolve();
    expect(await browsed).toContain("Signed in to grayboard");
  } finally {
    exchange.resolve();
    oauth.fetch = fetch;
  }
  await until(() => s.stderr().includes("signed in (startup)"), 10_000, "the flow's end");
  expect(s.elicits).toHaveLength(1);
  await signedIn(s);
}, 40_000);

test("a decline on a re-sent prompt ends the flow, and the next call starts another (#506)", async () => {
  let n = 0;
  const s = await plugin("sess-resend-decline", {
    answer: async (e) => {
      n++;
      if (n === 1) return "cancel";
      if (n === 2) return "decline";
      void browse(srv.issuer, e.url, "Claude Code");
      return "accept";
    },
  });
  await until(() => /sign-in failed \((?:startup|offer), elicitation [^)]+\): sign-in declined/.test(s.stderr()), 10_000, "the decline");
  expect(s.elicits).toHaveLength(2);
  expect(s.stderr()).toContain("sending it again (1/3)");
  await until(() => !linkFile(s), 5_000, "the declined flow's link removed");
  expect((await texts(s, "whoami")).error).toBe(true);
  await signedIn(s);
  expect(s.elicits).toHaveLength(3);
  expect(s.elicits[2]!.url).not.toBe(s.elicits[0]!.url);
}, 40_000);

test("a sign-in that can't reach the server says why in the next result", async () => {
  const s = await plugin("sess-unreachable", { env: { GRAYBOARD_SERVER_URL: "http://127.0.0.1:1/mcp" } });
  await until(() => s.stderr().includes("sign-in failed (startup): "), 15_000, "the failed startup sign-in");
  const r = await texts(s, "whoami");
  expect(r.error).toBe(true);
  expect(r.texts.join("\n")).toMatch(/^grayboard: sign-in failed: /m);
}, 40_000);

test("two signed-out processes share one flow: the waiter shows the holder's link, only the holder's prompt is answered, and both say signed in (#581)", async () => {
  // Neither answers until both have prompted: the holder's link is the one
  // both show, and opening it completes the holder's flow.
  const urls: string[] = [];
  const answer = async (e: Elicit) => { urls.push(e.url); return new Promise<ElicitResult["action"]>(() => {}); };
  const [a, b] = await Promise.all([plugin("sess-x", { answer }), plugin("sess-y", { answer })]);
  await until(() => a.elicits.length === 1 && b.elicits.length === 1, 15_000, "both prompts");
  expect(a.elicits[0]!.url).toBe(b.elicits[0]!.url);
  const waiter = a.stderr().includes("sign-in in progress in another Claude Code session") ? a : b;
  // Each shows it under its own calls; no result carries it.
  const r = await texts(waiter, "whoami");
  expect(r.texts[0]).toBe(STARTED);
  expect(r.texts.join("\n")).not.toContain(srv.issuer);
  expect(shown(waiter)).toBe(`grayboard: open ${waiter.elicits[0]!.url} to sign in`);
  expect(await browse(srv.issuer, waiter.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await Promise.all([signedIn(a), signedIn(b)]);
  // The waiter's flow ended signed in on the holder's grant, not aborted by
  // the other process's sign-in (the deleted onChange abort).
  await until(() => a.stderr().includes("signed in (startup)") && b.stderr().includes("signed in (startup)"), 10_000, "both signed-in lines");
  expect(urls).toHaveLength(2);
}, 40_000);

test("a refused link file of another session's sign-in is said in the log only, never in a tool result (#592)", async () => {
  // This plugin's store, as another session's sign-in holds it with a link of another origin.
  const store = new Login({ resource: srv.resource, clientId: CLIENT_ID, stateDir: data, harness: "Claude Code", loginAction: "x", present: () => {}, notify: () => {}, diagnostic: () => {} });
  mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
  writeFileSync(`${store.path}.login.url`, JSON.stringify({ url: "https://elsewhere.example/oauth/authorize?state=x", at: Date.now() }));
  const held = tryAcquire(`${store.path}.login.lock`)!;
  let s: Plugin;
  try {
    s = await plugin("sess-refused", { answer: () => new Promise<ElicitResult["action"]>(() => {}) });
    await until(() => s.stderr().includes("sign-in link isn't shown here: not on this server's origin"), 15_000, "the refusal in the log");
    // With no link to show, a call waits LINK_MS (20 s), then names the other session's sign-in (#501).
    const waiting = await texts(s, "whoami");
    expect(waiting.error).toBe(true);
    expect(waiting.texts[0]).toBe("grayboard: sign-in in progress in another Claude Code session; finish it there, then call a grayboard tool again");
  } finally { held.release(); }
  // The waited-on sign-in ended without a grant; the next call starts this session's own.
  await until(() => s.stderr().includes("sign-in failed (startup): "), 15_000, "the startup flow's end");
  const r = await texts(s, "whoami");
  expect(r.texts[0]).toBe(STARTED);
  expect(r.texts.join("\n")).not.toContain("isn't shown here");
}, 40_000);

test("a client without URL elicitation: the hook shows the link under its next call, and the result names only where it is (#500)", async () => {
  const s = await plugin("sess-nourl", { elicit: false });
  await until(() => s.stderr().includes("to sign in to grayboard"), 10_000, "the sign-in URL");
  const url = new RegExp(`open (${RegExp.escape(srv.issuer)}/\\S+) to sign in to grayboard`).exec(s.stderr())![1]!;
  const r = await texts(s, "whoami");
  expect(r.texts[0]).toBe(STARTED);
  expect(r.texts.join("\n")).not.toContain(srv.issuer);
  expect(shown(s)).toBe(`grayboard: open ${url} to sign in`);
  expect(await browse(srv.issuer, url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
  expect(shown(s)).toBeUndefined();
}, 30_000);

test("a sign-in prompt that fails with the link in its error text: the flow's failure, which a later result can carry, says the prompt failed, never the link (#500)", async () => {
  const s = await plugin("sess-elicit-error", { answer: async (e) => { throw new Error(`could not open ${e.url}`); } });
  await until(() => /sign-in failed \((?:startup|offer), elicitation [^)]+\): /.test(s.stderr()), 10_000, "the failed prompt");
  // The prompt's own line keeps Claude Code's text (the log is the user's); the failure is scrubbed.
  expect(s.stderr()).toMatch(/ended without an answer: .*could not open /);
  expect(s.stderr()).toMatch(/sign-in failed \((?:startup|offer), elicitation [^)]+\): the sign-in prompt failed\n/);
  await until(() => !linkFile(s), 5_000, "the failed flow's link removed");
}, 30_000);

test("a call before the flow has a link says sign-in is starting; the hook shows the link once it is written (#500)", async () => {
  const release = join(dir, "present-released");
  const s = await plugin("sess-starting", { elicit: false, env: { BUS_TEST_PAUSE: "claude-sign-in-present", BUS_TEST_PAUSE_FILE: release } });
  await until(() => s.stderr().includes("test pause hit: claude-sign-in-present"), 10_000, "the flow paused before its link");
  const r = await texts(s, "whoami");
  expect(r.texts[0]).toBe("grayboard: sign-in is starting; Claude Code shows its link under the next grayboard call: ask the user to open it, then call a grayboard tool again");
  expect(shown(s)).toBeUndefined();
  writeFileSync(release, "");
  await until(() => s.stderr().includes("to sign in to grayboard"), 10_000, "the sign-in URL");
  const url = new RegExp(`open (${RegExp.escape(srv.issuer)}/\\S+) to sign in to grayboard`).exec(s.stderr())![1]!;
  expect(shown(s)).toBe(`grayboard: open ${url} to sign in`);
}, 60_000);

test("a sign-in prompt whose error carries a truncated copy of the link: still scrubbed, by the flow's state (#500)", async () => {
  const s = await plugin("sess-elicit-trunc", { answer: async (e) => {
    const state = new URL(e.url).searchParams.get("state")!;
    throw new Error(`could not open ${e.url.slice(0, e.url.indexOf(state) + state.length)}`);
  } });
  await until(() => /sign-in failed \((?:startup|offer), elicitation [^)]+\): /.test(s.stderr()), 10_000, "the failed prompt");
  expect(s.stderr()).toMatch(/sign-in failed \((?:startup|offer), elicitation [^)]+\): the sign-in prompt failed\n/);
}, 30_000);

test("a link a killed predecessor left in this Claude Code process's dir is removed at connect (#500)", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const pid = 4242;
  putSignIn(data, pid, `${srv.issuer}/authorize?state=dead`);
  const p = createPlugin({
    env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "sess-leftover", CLAUDE_PLUGIN_DATA: data, GRAYBOARD_SERVER_URL: srv.resource, HOME: join(dir, "home") },
    parentCmd: `claude ${FLAG.join(" ")}`,
    files: { platform: "linux", home: join(dir, "home"), user: "test", read: () => null, list: () => [], plist: () => null },
    version: "1.0.0", cwd: join(dir, "work"), claude: { pid, start: null }, log: () => {},
  });
  try {
    await p.connect(InMemoryTransport.createLinkedPair()[1]);
    expect(existsSync(join(sessionDir(data, pid), SIGN_IN))).toBe(false);
  } finally {
    await p.shutdown();
  }
}, 30_000);

// #444: the drift between the pi/omp and Claude Code copies of the hosted
// session shell, each resolved once in hosted-core's client.ts and root.ts.

const count = (text: string, part: string) => text.split(part).length - 1;
// Another process's logout of this data dir's grant store.
const logoutElsewhere = () => new Login({ resource: srv.resource, clientId: CLIENT_ID, stateDir: data, harness: "test", loginAction: "log in", present: () => {}, notify: () => {}, diagnostic: () => {} }).logout();

test("a lease release that fails at shutdown is said once on stderr: the server down, then EOF", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const s = await plugin("sess-downquit");
  await texts(s, "bind", { name: "downquit", create: true });
  await until(() => row("sess-downquit")?.lease_deadline != null, 10_000, "the lease");
  await srv.stop();
  stopped = true;
  await stopSession(s.c);
  expect(count(s.stderr(), "session_end failed (server_unreachable)")).toBe(1);
}, 30_000);

test("a lease release that fails at shutdown is said once on stderr: a logout elsewhere, then EOF", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const s = await plugin("sess-outquit");
  await texts(s, "bind", { name: "outquit", create: true });
  await until(() => row("sess-outquit")?.lease_deadline != null, 10_000, "the lease");
  await logoutElsewhere();
  await stopSession(s.c);
  expect(count(s.stderr(), "session_end failed")).toBe(1);
}, 30_000);

test("a logout elsewhere is said once on stderr; the next tool result says it too", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const s = await plugin("sess-signout", { answer: async () => "decline" });
  expect((await texts(s, "whoami")).error).toBe(false);
  await logoutElsewhere();
  const said = "Signed out of grayboard in Claude Code";
  await until(() => s.stderr().includes(said), 10_000, "the sign-out on stderr");
  const r = await texts(s, "whoami");
  expect(r.error).toBe(true);
  expect(r.texts.join("\n")).toContain(said);
  // The call offered a sign-in, declined: an event later than any sign-out line.
  await until(() => /sign-in failed \((?:startup|offer), elicitation [^)]+\): sign-in declined/.test(s.stderr()), 10_000, "the declined sign-in");
  expect(count(s.stderr(), said)).toBe(1);
}, 30_000);

test("a delivery lock that can't be opened (not BUSY) is said, and the session isn't told another process holds delivery; EOF ends the session its calls bound", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  mkdirSync(deliveryPath(data, srv.resource, CLIENT_ID, "sess-lockfail"), { recursive: true });
  const s = await plugin("sess-lockfail");
  expect(s.stderr()).toContain("couldn't take delivery: ");
  expect(s.c.getInstructions()).not.toContain(HELD);
  const bound = await texts(s, "bind", { name: "lockfail", create: true });
  expect(bound.error).toBe(false);
  expect(bound.texts.join("\n")).not.toContain(HELD);
  expect(row("sess-lockfail")?.name).toBe("lockfail");
  await stopSession(s.c);
  expect(row("sess-lockfail")).toBeNull();
}, 30_000);

test("a delivery lock that couldn't be opened is retried by the next tool call: the instructions say so, and once the obstacle is gone the call's result says delivery started and a bind takes the lease", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const path = deliveryPath(data, srv.resource, CLIENT_ID, "sess-relock");
  mkdirSync(path, { recursive: true });
  const s = await plugin("sess-relock");
  expect(s.c.getInstructions()).toContain("Warning: grayboard delivery couldn't start (couldn't take delivery: ");
  rmSync(path, { recursive: true });
  const r = await texts(s, "whoami");
  expect(r.error).toBe(false);
  expect(r.texts[0]).toMatch(/^grayboard: delivery couldn't start \(couldn't take delivery: .*\); retried: /);
  expect((await texts(s, "bind", { name: "relock", create: true })).error).toBe(false);
  await until(() => row("sess-relock")?.lease_deadline != null, 10_000, "the lease");
}, 30_000);

// In-process: the client end of the transport never initializes, so the item
// the run loop takes waits in admit until the shutdown.
test("a shutdown while an admit waits for `initialized` records no pause", async () => {
  await seedGrant(srv, data, CLIENT_ID, EMAIL);
  const { token } = issueOAuth(srv.app.repo, srv.resource, EMAIL, ["grayboard:delivery", "grayboard:tools"], Date.now(), CLIENT_ID);
  const proxy = new ToolProxy({
    wire: { url: srv.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT_ID, version: "1.0.0" }, delivery: { mode: "poll", source: SOURCE } },
    harness: "Claude Code", loginAction: "log in", auth: { token: async () => token }, report: () => {},
  });
  try {
    expect((await proxy.call("bind", { name: "waiter", create: true }, "sess-wait")).isError).toBeFalsy();
    expect((await proxy.call("bind", { name: "wait-sender", create: true }, "sess-wait-sender")).isError).toBeFalsy();
    expect((await proxy.call("dm_send", { to: "waiter", body: "waits for initialized" }, "sess-wait-sender")).isError).toBeFalsy();
  } finally { await proxy.close(); }

  const { promise: reached, resolve: admitting } = Promise.withResolvers<void>();
  const restore = Controller.prototype.restore;
  const restoreSpy = spyOn(Controller.prototype, "restore").mockImplementation(async function (this: Controller) {
    const port = this.port as { admit: (...args: never[]) => Promise<void> };
    const admit = port.admit;
    port.admit = (...args: never[]) => { admitting(); return admit(...args); };
    return restore.call(this);
  });
  const records: { state: string; operation: string; message: string }[] = [];
  const record = Diagnostics.prototype.record;
  const recordSpy = spyOn(Diagnostics.prototype, "record").mockImplementation(function (this: Diagnostics, input) {
    records.push({ state: input.state, operation: input.operation, message: input.message });
    return record.call(this, input);
  });
  const p = createPlugin({
    env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "sess-wait", CLAUDE_PLUGIN_DATA: data, GRAYBOARD_SERVER_URL: srv.resource, HOME: join(dir, "home") },
    parentCmd: `claude ${FLAG.join(" ")}`,
    files: { platform: "linux", home: join(dir, "home"), user: "test", read: () => null, list: () => [], plist: () => null },
    version: "1.0.0", cwd: join(dir, "work"), claude: { pid: process.pid, start: null }, log: () => {},
  });
  try {
    await p.connect(InMemoryTransport.createLinkedPair()[1]);
    await reached;
    await p.shutdown();
  } finally {
    restoreSpy.mockRestore();
    recordSpy.mockRestore();
  }
  expect(records.filter(r => r.state === "paused" && r.operation === "subscriber")).toEqual([]);
}, 30_000);
