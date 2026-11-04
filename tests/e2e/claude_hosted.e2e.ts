// The claude-hosted e2e suite (#281): real Claude Code (the pinned release,
// tests/support/claude_code.ts) with the hosted plugin, against an in-process
// hosted server and a scripted fake Anthropic API, so it runs without
// credentials. Run it through `scripts/e2e.sh claude-hosted`.
//
// The plugin comes from a scratch local-directory marketplace: a copy of this
// tree's plugins/claude-code by default (nightly), or, with
// GRAYBOARD_E2E_TAG=vX.Y.Z and GRAYBOARD_E2E_SHA=<its commit>, the
// Git-subdirectory entry the release's plugin pin writes
// (scripts/pin_claude_plugin.ts), which Claude Code fetches from GitHub.
//
// The session binds through the plugin's tool, a DM from a peer reaches the
// model as a channel message, the model's dm_send reaches the peer, and no
// grayboard CLI process runs under Claude Code. A session with no grant is
// shown a sign-in link under its first tool call, and opening it signs the
// session in (#497: Claude Code never received the prompt the plugin sent at
// startup); the link reaches the user, never the model (#500).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pinMarketplace } from "../../scripts/pin_claude_plugin.ts";
import { CLAUDE_PLUGIN } from "../../src/shared/claude_channels.ts";
import { CLAUDE_CODE_VERSION, type ClaudeHome, claudeCli, claudeCodeBin, claudeHome, claudeTty, descendants, transcript } from "../support/claude_code.ts";
import { onChannelDm, onUserText, startFakeAnthropic, toolResults } from "../support/fake_anthropic.ts";
import { browse, hostedServer, seedGrant } from "../support/hosted_oauth.ts";
import { direct } from "../support/events.ts";
import { ROOT } from "../support/paths.ts";
import { keep } from "../support/run_dir.ts";
import { until } from "../support/until.ts";
import { hostedRowCount } from "../support/hosted_rows.ts";

const SOURCE = "plugin:grayboard:grayboard";
const TOOL = (name: string) => `mcp__plugin_grayboard_grayboard__${name}`;
const TAG = process.env.GRAYBOARD_E2E_TAG;
const SHA = process.env.GRAYBOARD_E2E_SHA;
// A model the pinned Claude Code runs without an effort level: its root PreToolUse carries no `effort`.
const NO_EFFORT = "claude-haiku-4-5";

let bin: string;
let dir: string;
beforeAll(() => {
  if (TAG && !SHA) throw new Error("GRAYBOARD_E2E_TAG needs GRAYBOARD_E2E_SHA, the tag's commit");
  bin = claudeCodeBin();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-claude-hosted-")));
});
afterAll(() => {
  keep("claude-hosted", dir, (p) => basename(p) === "node_modules");
  rmSync(dir, { recursive: true, force: true });
});

// A marketplace named grayboard in `mp` whose one entry is the plugin under test.
function marketplace(mp: string): string {
  mkdirSync(join(mp, ".claude-plugin"), { recursive: true });
  // A description: 2.1.316's validate --strict refuses a marketplace without one.
  const doc = { name: "grayboard", owner: { name: "grayboard e2e" }, description: "Grayboard's Claude Code plugin under test.", plugins: [] as unknown[] };
  if (TAG) {
    writeFileSync(join(mp, ".claude-plugin/marketplace.json"), JSON.stringify(pinMarketplace(doc, TAG, SHA!)));
    return `${TAG} (${SHA})`;
  }
  cpSync(join(ROOT, "plugins/claude-code"), join(mp, "plugins/grayboard"), { recursive: true });
  doc.plugins = [{ name: "grayboard", source: "./plugins/grayboard" }];
  writeFileSync(join(mp, ".claude-plugin/marketplace.json"), JSON.stringify(doc));
  return "this tree";
}

// The plugin under test installed in `h`, configured for `srv`; returns where it came from.
function install(h: ClaudeHome, srv: ReturnType<typeof hostedServer>, mp: string): string {
  const from = marketplace(mp);
  claudeCli(bin, h, ["plugin", "marketplace", "add", mp]);
  claudeCli(bin, h, ["plugin", "install", CLAUDE_PLUGIN, "--config", `server_url=${srv.resource}`]);
  return from;
}

test(`Claude Code ${CLAUDE_CODE_VERSION}: the plugin binds, a DM arrives as a channel message, the reply reaches the peer`, async () => {
  const srv = hostedServer();
  const model = startFakeAnthropic([
    onUserText("BIND-NOW", SOURCE, TOOL("bind"),{ name: "alpha", create: true }),
    onChannelDm(SOURCE, "beta", (id) => ({ tool: TOOL("dm_send"), input: { to: "beta", body: "pong", parent_id: id } })),
  ]);
  const h = claudeHome(dir, model.url, ["mcp__plugin_grayboard_grayboard"]);
  const mp = join(dir, "mp");
  let from = "";
  let tty: ReturnType<typeof claudeTty> | undefined;
  try {
    // --strict on the plugin and on a marketplace with its entry (2.1.316
    // refuses the repo's empty pre-pin marketplace under --strict).
    claudeCli(bin, h, ["plugin", "validate", "--strict", join(ROOT, "plugins/claude-code")]);
    from = install(h, srv, mp);
    claudeCli(bin, h, ["plugin", "validate", "--strict", mp]);
    await seedGrant(srv, join(h.config, "plugins/data/grayboard-grayboard"), "grayboard-claude-code");

    tty = claudeTty(bin, h, ["--permission-mode", "default", "--dangerously-load-development-channels", `plugin:${CLAUDE_PLUGIN}`]);
    const hosted = () => srv.app.db.query<{ source_session_id: string; name: string | null }, []>("SELECT source_session_id, (SELECT substr(address, instr(address, '/') + 1) FROM alias_holds WHERE id = session_id ORDER BY bound_at, address LIMIT 1) AS name FROM hosted_sessions").all();
    await until(() => hosted().length > 0, 60_000, `the plugin (from ${from}) to open its hosted session`);
    const session = hosted()[0]!.source_session_id;

    await tty.submit("BIND-NOW");
    await until(() => hosted().some((r) => r.name === "alpha"), 30_000, "the model's bind call to name the session alpha");

    // The peer is a hosted session of the same user's.
    const beta = await srv.hosted("alice@example.com", "beta");
    await beta.call("dm_send", { to: "alpha", body: "ping" });
    const tag = `<channel source="${SOURCE}" message_id="`;
    await until(() => model.requests.some((r) => JSON.stringify(r.body.messages).includes(JSON.stringify(tag).slice(1, -1))), 30_000, "the DM to reach the model as a channel message");
    await beta.next(direct((m) => m.body === "pong"), 30_000);

    // Claude Code writes its transcript on its own schedule: the reply can reach beta first.
    await until(() => transcript(h, session).includes(JSON.stringify(tag).slice(1, -1)), 10_000, "the channel message in the session's transcript");
    // The plugin is the session's grayboard: no grayboard CLI runs under Claude Code.
    const tree = descendants(tty.proc.pid);
    expect(tree.some(([, cmd]) => cmd.includes("dist/grayboard.js"))).toBe(true);
    expect(tree.filter(([, cmd]) => /(^|\/)grayboard(\s|$)|src\/cli\/main\.ts/.test(cmd))).toEqual([]);
    expect(model.unhandled).toEqual([]);
  } finally {
    await tty?.stop();
    model.stop();
    writeFileSync(join(dir, "model.jsonl"), model.requests.map((r) => JSON.stringify(r)).join("\n"));
    await srv.stop();
  }
}, 240_000);

test(`Claude Code ${CLAUDE_CODE_VERSION}: the root reports its model and effort (#545), after /effort, a confirmed /model switch and /clear, and clears the effort on a model without one (#558)`, async () => {
  const srv = hostedServer();
  const model = startFakeAnthropic([
    onUserText("FACTS-1", SOURCE, TOOL("bind"), { name: "facts", create: true }),
    onUserText("FACTS-2", SOURCE, TOOL("whoami"), {}),
    onUserText("FACTS-3", SOURCE, TOOL("whoami"), {}),
    onUserText("FACTS-4", SOURCE, TOOL("whoami"), {}),
  ]);
  const home = join(dir, "facts");
  const h = claudeHome(home, model.url, ["mcp__plugin_grayboard_grayboard"]);
  let tty: ReturnType<typeof claudeTty> | undefined;
  try {
    const from = install(h, srv, join(home, "mp"));
    await seedGrant(srv, join(h.config, "plugins/data/grayboard-grayboard"), "grayboard-claude-code");
    tty = claudeTty(bin, h, ["--permission-mode", "default"]);
    const t = tty;
    const facts = () => srv.app.db.query<{ model: string | null; effort: string | null }, []>(
      "SELECT i.model, i.effort FROM hosted_sessions s JOIN ids i ON i.id = s.session_id WHERE s.root_session_id IS NULL").all();
    const changes = () => srv.app.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'id.facts_changed' ORDER BY id").all().map((r) => r.detail);
    // A slash command, typed, then answered; `seen` is what the screen shows once it ran.
    const slash = async (command: string, seen: string, confirm?: string) => {
      const mark = t.screen().length;
      await t.submit(command);
      if (confirm) {
        await until(() => t.screen().slice(mark).includes(confirm) || t.screen().slice(mark).includes(seen), 20_000, `${command} to ask or run`);
        if (!t.screen().slice(mark).includes(seen)) t.proc.terminal!.write("\r");
      }
      await until(() => t.screen().slice(mark).includes(seen), 20_000, `${command} to run`);
    };
    await until(() => t.screen().includes(`v${CLAUDE_CODE_VERSION}`), 60_000, "Claude Code's main screen");

    await t.submit("FACTS-1");
    await until(() => toolResults(model, "toolu_FACTS_1").length > 0, 60_000, `the bind (plugin from ${from})`);
    // The model Claude Code started on, as its first request named it.
    const started = model.requests[0]!.body.model;
    expect(facts()).toEqual([{ model: started, effort: expect.any(String) }]);

    await slash("/effort high", "Set effort level to high");
    await slash("/model claude-sonnet-5-5", "Set model to", "Switch model?");
    await t.submit("FACTS-2");
    await until(() => toolResults(model, "toolu_FACTS_2").length > 0, 60_000, "the whoami after the switch");
    expect(facts()).toEqual([{ model: "claude-sonnet-5-5", effort: "high" }]);

    // /clear: the plugin's root continues, and SessionStart(clear) reports the model it continues on.
    const changedBefore = changes();
    await t.submit("/clear");
    await t.submit("FACTS-3");
    await until(() => toolResults(model, "toolu_FACTS_3").length > 0, 60_000, "the whoami after /clear");
    expect(facts()).toEqual([{ model: "claude-sonnet-5-5", effort: "high" }]);
    // Every root grayboard call carries the effort, so repeated calls never clear and restore it (#558).
    expect(changes()).toEqual(changedBefore);

    // A model without effort: the root's next call says none, and the server clears it (#558).
    await slash(`/model ${NO_EFFORT}`, "Set model to", "Switch model?");
    await t.submit("FACTS-4");
    await until(() => toolResults(model, "toolu_FACTS_4").length > 0, 60_000, `the whoami on ${NO_EFFORT}`);
    expect(facts()).toEqual([{ model: NO_EFFORT, effort: null }]);
    expect(model.unhandled).toEqual([]);
  } finally {
    await tty?.stop();
    model.stop();
    writeFileSync(join(home, "model.jsonl"), model.requests.map((r) => JSON.stringify(r)).join("\n"));
    await srv.stop();
  }
}, 240_000);

test(`Claude Code ${CLAUDE_CODE_VERSION}: with no grant, the first tool call shows the sign-in link under the call, never in a request (also after --resume), and opening it signs the session in`, async () => {
  const srv = hostedServer();
  const model = startFakeAnthropic([
    onUserText("WHOAMI-FIRST", SOURCE, TOOL("whoami"), {}),
  ]);
  const signedOut = join(dir, "signed-out");
  const h = claudeHome(signedOut, model.url, ["mcp__plugin_grayboard_grayboard"]);
  const args = ["--permission-mode", "default", "--dangerously-load-development-channels", `plugin:${CLAUDE_PLUGIN}`];
  let tty: ReturnType<typeof claudeTty> | undefined;
  try {
    const from = install(h, srv, join(signedOut, "mp"));
    tty = claudeTty(bin, h, args);
    await until(() => tty!.screen().includes(`v${CLAUDE_CODE_VERSION}`), 60_000, "Claude Code's main screen");
    await tty.submit("WHOAMI-FIRST");
    const first = "toolu_WHOAMI_FIRST";
    await until(() => toolResults(model, first).length > 0, 60_000, `the first whoami result (plugin from ${from})`);
    const result = toolResults(model, first).join("\n");
    // The result says a sign-in waits on the user; the link is not in it (#500).
    expect(result).toContain("sign-in started: ask the user to open the sign-in link Claude Code shows under this call");
    expect(result).not.toContain("authorize?");
    // The hook's systemMessage: in the transcript as Claude Code's own record of what it showed, and on screen under the call.
    const projects = join(h.config, "projects", h.work.replace(/[^A-Za-z0-9]/g, "-"));
    const session = () => existsSync(projects) ? readdirSync(projects).find((f) => f.endsWith(".jsonl"))?.slice(0, -".jsonl".length) : undefined;
    const shownLink = () => {
      const id = session();
      return id ? new RegExp(`grayboard: open (${RegExp.escape(srv.issuer)}/[^\\s"\\\\]+) to sign in`).exec(transcript(h, id))?.[1] : undefined;
    };
    const url = await until(shownLink, 20_000, "the hook's sign-in line in the transcript");
    await until(() => tty!.screen().includes(`PostToolUseFailure:${TOOL("whoami")} says: grayboard: open ${srv.issuer}/`), 10_000, "the sign-in line on screen under the call");
    const requests = () => JSON.stringify(model.requests);
    expect(requests()).not.toContain(url);
    expect(requests()).not.toContain(new URL(url).searchParams.get("state")!);
    // A prompt that reached Claude Code while it was still wiring the
    // connection was cancelled unshown, and the plugin sends it again: the
    // user sees a prompt either way before opening the link.
    const debug = () => readFileSync(join(signedOut, "debug.log"), "utf8");
    await until(() => debug().includes("Received elicitation request: "), 10_000, "Claude Code to show the sign-in prompt");
    expect(await browse(srv.issuer, url, "Claude Code")).toContain("Signed in to grayboard");
    const hosted = () => hostedRowCount(srv.app.db);
    await until(() => hosted() > 0, 30_000, "the signed-in plugin to open its hosted session");
    // The plugin completes the prompt at the flow's end. 2.1.316 keeps the URL
    // prompt up after that (the user dismisses it with Esc, docs/guide/team.md); typing
    // past it in a pty is not asserted here: keys were lost on CI (#497).
    await until(() => debug().includes("Received elicitation completion notification"), 10_000, "the plugin to complete the sign-in prompt");
    expect(model.unhandled).toEqual([]);

    // --resume replays the transcript, the hook's line included: still none of it reaches the model.
    const id = session()!;
    await tty.stop();
    const before = model.requests.length;
    tty = claudeTty(bin, h, [...args, "--resume", id]);
    await until(() => tty!.screen().includes(`v${CLAUDE_CODE_VERSION}`), 60_000, "the resumed main screen");
    await tty.submit("AFTER-RESUME");
    await until(() => model.requests.slice(before).some((r) => JSON.stringify(r.body).includes("AFTER-RESUME")), 60_000, "the resumed session's request");
    const resumed = model.requests.slice(before).find((r) => JSON.stringify(r.body).includes("AFTER-RESUME"))!;
    // The resumed request carries the earlier call (it is a replay), and not the link.
    expect(JSON.stringify(resumed.body)).toContain("sign-in started");
    expect(requests()).not.toContain(url);
  } finally {
    await tty?.stop();
    model.stop();
    writeFileSync(join(signedOut, "model.jsonl"), model.requests.map((r) => JSON.stringify(r)).join("\n"));
    await srv.stop();
  }
}, 300_000);
