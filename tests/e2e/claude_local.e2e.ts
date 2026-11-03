// The claude-local e2e suite (#551): real Claude Code (the pinned release,
// tests/support/claude_code.ts) with local-mode grayboard registered the way
// `grayboard setup` registers it (a user-scope `grayboard` MCP entry and the
// record hooks in user settings), against a scripted fake Anthropic API, so it
// runs without credentials. Run it through `scripts/e2e.sh claude-local`.
//
// The root session sends a DM, then starts a subagent that sends one and tries
// to bind. The subagent's DM carries its child session as `via`, its bind is
// refused child_session, and the root's carries none. A `/clear` follows and
// the same again: the record dir outlives SessionEnd(clear), and the second
// subagent is a child session of its own.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { installClaudeHooks } from "../../src/cli/claude_hooks.ts";
import { agentsRoot } from "../../src/shared/claude_agents.ts";
import { CLAUDE_CODE_VERSION, claudeCli, claudeCodeBin, claudeHome, claudeTty } from "../support/claude_code.ts";
import { localEnv } from "../support/env.ts";
import { onUserSteps, startFakeAnthropic, toolResults } from "../support/fake_anthropic.ts";
import { call, closeSessions, localSession } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { keep } from "../support/run_dir.ts";
import { until } from "../support/until.ts";

const SERVER = "grayboard";
const TOOL = (name: string) => `mcp__grayboard__${name}`;
const CLI = [process.execPath, join(ROOT, "src/cli/main.ts")];

let bin: string;
let dir: string;
beforeAll(() => {
  bin = claudeCodeBin();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-claude-local-")));
});
afterAll(async () => {
  await closeSessions();
  keep("claude-local", dir, (p) => basename(p) === "node_modules");
  rmSync(dir, { recursive: true, force: true });
});

// The root's script for round `n`: a DM, then a subagent whose prompt scripts it.
const root = (n: number) => onUserSteps(`ROOT-GO-${n}`, SERVER, [
  { tool: TOOL("dm_send"), input: { to: "peer", body: `from-root-${n}` } },
  { tool: "Agent", input: { description: `subtask ${n}`, prompt: `SUBTASK-${n}`, subagent_type: "general-purpose" } },
]);
// The subagent's: a DM, then a bind its child session is refused.
const sub = (n: number) => onUserSteps(`SUBTASK-${n}`, SERVER, [
  { tool: TOOL("dm_send"), input: { to: "peer", body: `from-child-${n}` } },
  { tool: TOOL("bind"), input: { name: `child-${n}`, create: true } },
]);

test(`Claude Code ${CLAUDE_CODE_VERSION}: a subagent's grayboard calls act as a child session of the root, across /clear`, async () => {
  // Subagent rules first: a subagent's conversation holds only its prompt, a root's never holds SUBTASK-n as user text.
  const model = startFakeAnthropic([sub(1), sub(2), root(1), root(2)]);
  const h = claudeHome(dir, model.url, ["mcp__grayboard", "Agent"]);
  const bus = join(dir, "bus");
  mkdirSync(bus, { recursive: true });
  const busEnv = localEnv(bus);
  // Claude Code, its hooks and its MCP server all see the one bus.
  for (const k of ["BUS_DB_PATH", "BUS_SOCK_DIR", "GRAYBOARD_CREDENTIALS", "GRAYBOARD_ATTACHMENTS_DIR"]) h.env[k] = busEnv[k]!;
  h.env.BUS_IDENTITY = "cc";
  let tty: ReturnType<typeof claudeTty> | undefined;
  try {
    // What `grayboard setup` does in local mode (registerClaudeLocal), aimed at the scratch config.
    claudeCli(bin, h, ["mcp", "add", "--scope", "user", "grayboard", "--", ...CLI, "mcp"]);
    expect(installClaudeHooks(CLI, join(h.config, "settings.json"))).toBe(true);
    const peer = await localSession(bus, "peer");

    tty = claudeTty(bin, h, ["--permission-mode", "default"]);
    await until(() => tty!.screen().includes(`v${CLAUDE_CODE_VERSION}`), 60_000, "Claude Code's main screen");
    const db = new Database(busEnv.BUS_DB_PATH!, { readonly: true });
    const dms = () => db.query<{ body: string; via: string | null }, []>("SELECT body, via FROM messages WHERE body LIKE 'from-%' ORDER BY id").all();
    const body = (b: string) => dms().find((r) => r.body === b);

    await tty.submit("ROOT-GO-1");
    await until(() => body("from-child-1") !== undefined && toolResults(model, "toolu_SUBTASK_1_1").length > 0, 120_000, "the first subagent's DM and bind");
    await tty.submit("/clear");
    const debug = () => readFileSync(join(dir, "debug.log"), "utf8");
    await until(() => /Hooks: SessionStart:clear \[[^\]]*hook claude session-start\] finished with status 0/.test(debug()), 30_000, "the record hook's SessionStart(clear)");
    // SessionEnd(clear) ran first and kept the session's record dir.
    expect(debug()).toMatch(/SessionEnd:clear \[[^\]]*hook claude session-end\] completed with status 0/);
    expect(readdirSync(agentsRoot(busEnv.BUS_SOCK_DIR!))).toEqual([String(tty.proc.pid)]);
    await tty.submit("ROOT-GO-2");
    await until(() => body("from-child-2") !== undefined && toolResults(model, "toolu_SUBTASK_2_1").length > 0, 120_000, "the second subagent's DM and bind");

    // The root's DMs carry no via; each subagent's names its own child session.
    const [r1, c1, r2, c2] = ["from-root-1", "from-child-1", "from-root-2", "from-child-2"].map((b) => body(b)!);
    expect([r1.via, r2.via]).toEqual([null, null]);
    expect(c1.via).toBeTruthy();
    expect(c2.via).toBeTruthy();
    expect(c2.via).not.toBe(c1.via);
    // Both children act under the one root session (its ID survives /clear: one grayboard mcp process).
    const rows = db.query<{ id: string; root_id: string | null }, [string, string]>("SELECT id, root_id FROM ids WHERE id IN (?, ?)").all(c1.via!, c2.via!);
    expect(rows.length).toBe(2);
    expect(rows[0]!.root_id).toBeTruthy();
    expect(rows.every((r) => r.root_id === rows[0]!.root_id)).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit_log WHERE action = 'id.child_seen'").get()!.n).toBeGreaterThanOrEqual(2);
    for (const n of [1, 2]) expect(toolResults(model, `toolu_SUBTASK_${n}_1`).join("\n")).toContain("child_session");
    // The peer receives all four, as from cc.
    const hist = await call(peer, "dm_history", { peer: "cc" });
    expect(JSON.stringify(hist)).toContain("from-child-2");
    expect(model.unhandled).toEqual([]);
    db.close();
  } finally {
    await tty?.stop();
    model.stop();
    writeFileSync(join(dir, "model.jsonl"), model.requests.map((r) => JSON.stringify(r)).join("\n"));
  }
}, 300_000);
