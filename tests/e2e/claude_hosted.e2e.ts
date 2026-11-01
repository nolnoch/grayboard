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
// grayboard CLI process runs under Claude Code.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pinMarketplace } from "../../scripts/pin_claude_plugin.ts";
import { CLAUDE_PLUGIN } from "../../src/shared/claude_channels.ts";
import { CLAUDE_CODE_VERSION, claudeCli, claudeCodeBin, claudeHome, claudeTty, descendants, transcript } from "../support/claude_code.ts";
import { onChannelDm, onUserText, startFakeAnthropic } from "../support/fake_anthropic.ts";
import { hostedServer, seedGrant } from "../support/hosted_oauth.ts";
import { closeSessions } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { keep } from "../support/run_dir.ts";
import { until } from "../support/until.ts";

const SOURCE = "plugin:grayboard:grayboard";
const TOOL = (name: string) => `mcp__plugin_grayboard_grayboard__${name}`;
const TAG = process.env.GRAYBOARD_E2E_TAG;
const SHA = process.env.GRAYBOARD_E2E_SHA;

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

test(`Claude Code ${CLAUDE_CODE_VERSION}: the plugin binds, a DM arrives as a channel message, the reply reaches the peer`, async () => {
  const srv = hostedServer();
  const model = startFakeAnthropic([
    onUserText("BIND-NOW", SOURCE, TOOL("bind"),{ name: "alpha", create: true }),
    onChannelDm(SOURCE, "beta", (id) => ({ tool: TOOL("dm_send"), input: { to: "beta", body: "pong", parent_id: id } })),
  ]);
  const h = claudeHome(dir, model.url, ["mcp__plugin_grayboard_grayboard"]);
  const mp = join(dir, "mp");
  const from = marketplace(mp);
  let tty: ReturnType<typeof claudeTty> | undefined;
  try {
    // --strict on the plugin and on a marketplace with its entry (2.1.316
    // refuses the repo's empty pre-pin marketplace under --strict).
    claudeCli(bin, h, ["plugin", "validate", "--strict", join(ROOT, "plugins/claude-code")]);
    claudeCli(bin, h, ["plugin", "validate", "--strict", mp]);
    claudeCli(bin, h, ["plugin", "marketplace", "add", mp]);
    claudeCli(bin, h, ["plugin", "install", CLAUDE_PLUGIN, "--config", `server_url=${srv.resource}`]);
    await seedGrant(srv, join(h.config, "plugins/data/grayboard-grayboard"), "grayboard-claude-code");

    tty = claudeTty(bin, h, ["--permission-mode", "default", "--dangerously-load-development-channels", `plugin:${CLAUDE_PLUGIN}`]);
    const hosted = () => srv.app.db.query<{ source_session_id: string; name: string | null }, []>("SELECT source_session_id, name FROM hosted_sessions").all();
    await until(() => hosted().length > 0, 60_000, `the plugin (from ${from}) to open its hosted session`);
    const session = hosted()[0]!.source_session_id;

    await tty.submit("BIND-NOW");
    await until(() => hosted().some((r) => r.name === "alpha"), 30_000, "the model's bind call to name the session alpha");

    const beta = await srv.session(await srv.login("alice@example.com"), "beta");
    await beta.call("dm_send", { to: "alpha", body: "ping" });
    const tag = `<channel source="${SOURCE}" message_id="`;
    await until(() => model.requests.some((r) => JSON.stringify(r.body.messages).includes(JSON.stringify(tag).slice(1, -1))), 30_000, "the DM to reach the model as a channel message");
    await until(() => beta.pushes.some((p) => p.content === "pong"), 30_000, "the model's dm_send reply to reach beta");

    expect(transcript(h, session)).toContain(JSON.stringify(tag).slice(1, -1));
    // The plugin is the session's grayboard: no grayboard CLI runs under Claude Code.
    const tree = descendants(tty.proc.pid);
    expect(tree.some(([, cmd]) => cmd.includes("dist/grayboard.js"))).toBe(true);
    expect(tree.filter(([, cmd]) => /(^|\/)grayboard(\s|$)|src\/cli\/main\.ts/.test(cmd))).toEqual([]);
    expect(model.unhandled).toEqual([]);
  } finally {
    await tty?.stop();
    await closeSessions();
    model.stop();
    writeFileSync(join(dir, "model.jsonl"), model.requests.map((r) => JSON.stringify(r)).join("\n"));
    await srv.stop();
  }
}, 240_000);
