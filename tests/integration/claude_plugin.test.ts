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
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { CLIENT_ID, LOGIN_ELSEWHERE, SOURCE } from "../../plugins/claude-code/src/plugin.ts";
import { browse, hostedServer, seedGrant, type HostedServer } from "../support/hosted_oauth.ts";
import { closeSessions, mcpSession, stopSession, type ClientShape, type Session } from "../support/mcp.ts";
import { until } from "../support/until.ts";

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
  "SELECT name, lease_deadline, ownership_id FROM hosted_sessions WHERE session_id = ?").get(hostedSessionId(user(), CLIENT_ID, id));
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
  await until(() => s.stderr().includes("sign-in failed: sign-in declined"), 10_000, "the decline");

  // Two calls while signed out: one prompt between them.
  const calls = await Promise.all([texts(s, "whoami"), texts(s, "peer_list")]);
  for (const c of calls) expect(c.error).toBe(true);
  await signedIn(s);
  expect(s.elicits).toHaveLength(2);
  await until(() => s.completed.length === 1, 10_000, "the elicitation's completion notice");
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
