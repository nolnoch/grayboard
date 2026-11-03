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
// decline, and the URL in a tool result when the client can't elicit; the
// pre-2026-07-28 protocol; release on EOF with a lease, session_end without.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Controller } from "../../adapters/hosted-core/src/controller.ts";
import { Diagnostics } from "../../adapters/hosted-core/src/diagnostics.ts";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { ToolProxy } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
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
type Plugin = Session & { elicits: Elicit[]; completed: string[] };

// One Claude Code session's plugin server. `flags` are Claude Code's own;
// `answer` answers each URL elicitation (default: accept and complete the
// sign-in in the browser); `elicit: false` leaves the capability out.
async function plugin(id: string, o: {
  flags?: string[]; answer?: (e: Elicit) => Promise<ElicitResult["action"]>; elicit?: boolean; before?: ClientShape["before"]; env?: Record<string, string>;
} = {}): Promise<Plugin> {
  const elicits: Elicit[] = [], completed: string[] = [];
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
        c.setRequestHandler(ElicitRequestSchema, async (req) => {
          const p = req.params as { mode?: string; url: string; message: string };
          expect(p.mode).toBe("url");
          const e = { url: p.url, message: p.message };
          elicits.push(e);
          return { action: await answer(e) };
        });
        c.setNotificationHandler(ElicitationCompleteNotificationSchema, async (n) => { completed.push(n.params.elicitationId); });
      },
    },
  });
  return Object.assign(s, { elicits, completed });
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
  expect({ exit: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }).toEqual({ exit: 0, out: "", err: "" });
};
let uses = 0;
// One model call as Claude Code makes it: PreToolUse's record (an `agent` for a subagent's), then the call with its tool_use_id.
const modelCall = async (s: Session, name: string, args: Record<string, unknown>, o: { agent?: string; hook?: boolean } = {}) => {
  const id = `toolu_01Test${++uses}`;
  if (o.hook !== false) runHook(s, "pre-tool-use", { hook_event_name: "PreToolUse", tool_name: `mcp__plugin_grayboard_grayboard__${name}`, tool_use_id: id, ...(o.agent ? { agent_id: o.agent } : {}) });
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
    // The peer's history renders the child.
    const history = await texts(peer, "dm_history", {});
    expect(history.texts.join("\n")).toContain(child);
    // A child can't bind: it acts under its root's names.
    const bind = await modelCall(root, "bind", { name: "other", create: true }, { agent: "a573e90bd84bce7ff" });
    expect(bind.error).toBe(true);
    expect(bind.texts.join("\n")).toContain("child");

    runHook(root, "subagent-stop", { hook_event_name: "SubagentStop", agent_id: "a573e90bd84bce7ff" });
    await until(() => !childRow(id, "a573e90bd84bce7ff"), 10_000, "the child's hosted session to end");
    // The root is untouched.
    expect(row(id)?.name).toBe("lead");
  }, 60_000);
}

test("a call whose PreToolUse record is missing, stale or from a recycled pid is refused and writes nothing", async () => {
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
  await until(() => /sign-in failed \(elicitation [^)]+\): sign-in declined/.test(s.stderr()), 10_000, "the decline");

  // Two calls while signed out: one prompt between them.
  const calls = await Promise.all([texts(s, "whoami"), texts(s, "peer_list")]);
  for (const c of calls) expect(c.error).toBe(true);
  await signedIn(s);
  expect(s.elicits).toHaveLength(2);
  await until(() => s.completed.length === 1, 10_000, "the elicitation's completion notice");
}, 40_000);

test("a prompt left unanswered (#497): every signed-out result carries the link, opening it signs in, and the prompt is completed and withdrawn", async () => {
  const s = await plugin("sess-unanswered", { answer: () => new Promise(() => {}) });
  await until(() => s.elicits.length === 1, 10_000, "the startup sign-in prompt");
  const link = new RegExp(`^grayboard: open (${RegExp.escape(srv.issuer)}/\\S+) to sign in to grayboard$`);
  const calls = await Promise.all([texts(s, "whoami"), texts(s, "peer_list")]);
  for (const c of calls) expect(c.texts[0]).toMatch(link);
  expect(link.exec(calls[0]!.texts[0]!)![1]).toBe(s.elicits[0]!.url);
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
  await until(() => s.completed.length === 1, 10_000, "the elicitation's completion notice");
  expect(s.elicits).toHaveLength(1);
  const said = s.stderr();
  expect(said).toContain("sign-in prompt sent (elicitation ");
  expect(said).not.toContain("sign-in prompt ended without an answer");
  expect(said).not.toContain("sign-in failed");
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
  expect(call.texts[0]).toContain(`open ${s.elicits[0]!.url} to sign in to grayboard`);
  expect(s.elicits).toHaveLength(2);
  expect(await browse(srv.issuer, s.elicits[0]!.url, "Claude Code")).toContain("Signed in to grayboard");
  await signedIn(s);
}, 40_000);

test("a sign-in that can't reach the server says why in the next result", async () => {
  const s = await plugin("sess-unreachable", { env: { GRAYBOARD_SERVER_URL: "http://127.0.0.1:1/mcp" } });
  await until(() => s.stderr().includes("sign-in failed: "), 15_000, "the failed startup sign-in");
  const r = await texts(s, "whoami");
  expect(r.error).toBe(true);
  expect(r.texts.join("\n")).toMatch(/^grayboard: sign-in failed: /m);
}, 40_000);

test("two signed-out processes share one sign-in: one prompt between them, and both come up signed in", async () => {
  const [a, b] = await Promise.all([plugin("sess-x"), plugin("sess-y")]);
  await until(() => a.elicits.length + b.elicits.length > 0, 10_000, "a sign-in prompt");
  await Promise.all([signedIn(a), signedIn(b)]);
  expect(a.elicits.length + b.elicits.length).toBe(1);
}, 40_000);

test("a client without URL elicitation gets the sign-in URL in its next tool result", async () => {
  const s = await plugin("sess-nourl", { elicit: false });
  await until(() => s.stderr().includes("to sign in to grayboard"), 10_000, "the sign-in URL");
  const r = await texts(s, "whoami");
  expect(r.texts[0]).toMatch(new RegExp(`^grayboard: open ${srv.issuer.replace(/[.]/g, "\\.")}/\\S+ to sign in to grayboard$`));
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
  await until(() => /sign-in failed \(elicitation [^)]+\): sign-in declined/.test(s.stderr()), 10_000, "the declined sign-in");
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
