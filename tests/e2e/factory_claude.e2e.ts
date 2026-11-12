// The factory's Claude Code runner (#293, docs/factory.md §5) against the
// pinned Claude Code (tests/support/claude_code.ts) and a scripted fake
// Anthropic API: the agent runs headless with the prompt on stdin, and the
// operator's own settings never widen a child. Run it through
// `scripts/e2e.sh claude-local`; outside `bun test`'s discovery, so the
// pre-push hook never fetches Claude Code for it (#456).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunner } from "../../adapters/factory/claude/runner.ts";
import { resolvePersona } from "../../adapters/factory/runner.ts";
import { claudeCodeBin, claudeHome } from "../support/claude_code.ts";
import { called, startFakeAnthropic, systemText, toolResults, userTexts } from "../support/fake_anthropic.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "grayboard-factory-claude-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("claude runner: runs the named agent headless, prompt on stdin, and returns its result", async () => {
  const bin = claudeCodeBin();
  const model = startFakeAnthropic([
    (q) => (userTexts(q).some((t) => t.includes("-- FACTORY-TASK")) ? { text: systemText(q).includes("AGENT-PROMPT-7") ? "RESULT-42" : "wrong agent" } : undefined),
  ]);
  try {
    const h = claudeHome(dir, model.url);
    mkdirSync(join(h.config, "agents"), { recursive: true });
    writeFileSync(join(h.config, "agents", "researcher.md"), "---\nname: researcher\ndescription: researches\n---\nAGENT-PROMPT-7: you research.\n");
    const runner = new ClaudeRunner({ bin, cwd: h.work, allowedTools: [], env: h.env });
    expect(runner.roster().map((a) => a.name)).toEqual(["researcher"]);
    const agent = resolvePersona("a researcher", runner.roster())!;
    // A task starting with "-" would be a flag in argv; on stdin it's text.
    const out = await runner.run(agent, { id: 1, source: "dm", requester: "sim", persona: "a researcher", task: "-- FACTORY-TASK: find it" }, new AbortController().signal);
    expect(out).toEqual({ ok: true, text: "RESULT-42" });
    expect(model.unhandled).toEqual([]);
  } finally {
    model.stop();
  }
}, 120_000);

// The operator's own settings must not widen a child. The fake model has the
// agent run `touch MARKER` in the working directory; the marker shows whether
// the shell ran. Measured on the pinned Claude Code: without --restricted, a
// user rule allowing Bash lets the child's shell run.
async function shellTrial(user: string[], o: { tools?: string[]; allowedTools: string[] }): Promise<{ marker: boolean; result: string; agentPrompt: boolean }> {
  const model = startFakeAnthropic([
    (q) => !userTexts(q).some((t) => t.includes("FACTORY-SHELL")) ? undefined
      : called(q, "toolu_sh") ? { text: "ended" } : { tool: "Bash", id: "toolu_sh", input: { command: "touch MARKER", description: "touch a file" } },
  ]);
  try {
    const h = claudeHome(dir, model.url, user);
    mkdirSync(join(h.config, "agents"), { recursive: true });
    writeFileSync(join(h.config, "agents", "builder.md"), "---\nname: builder\ndescription: builds\n---\nAGENT-PROMPT-9\n");
    const runner = new ClaudeRunner({ bin: claudeCodeBin(), cwd: h.work, ...o, env: h.env });
    const out = await runner.run(runner.roster()[0]!, { id: 1, source: "dm", requester: "sim", persona: "builder", task: "FACTORY-SHELL" }, new AbortController().signal);
    expect(out).toEqual({ ok: true, text: "ended" });
    expect(model.unhandled).toEqual([]);
    return { marker: existsSync(join(h.work, "MARKER")), result: toolResults(model, "toolu_sh").join("\n"), agentPrompt: model.requests.some((r) => systemText(r.body).includes("AGENT-PROMPT-9")) };
  } finally {
    model.stop();
  }
}

test("claude runner: the operator's user allow rules don't reach a child; no shell unless the config names it", async () => {
  const t = await shellTrial(["Bash"], { allowedTools: [] });
  expect(t.agentPrompt).toBe(true);
  expect(t.marker).toBe(false);
  expect(t.result).toContain("No such tool available: Bash");
}, 120_000);

test("claude runner: a shell the config names in tools but not allowedTools is still denied, unprompted", async () => {
  const t = await shellTrial(["Bash"], { tools: ["Bash", "Read"], allowedTools: [] });
  expect(t.marker).toBe(false);
  expect(t.result).toContain("Permission for this tool use was denied");
}, 120_000);

test("claude runner: a shell the config names in both lists runs", async () => {
  const t = await shellTrial([], { tools: ["Bash", "Read"], allowedTools: ["Bash"] });
  expect(t.marker).toBe(true);
}, 120_000);
