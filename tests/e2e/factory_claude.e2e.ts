// The factory's Claude Code runner (#293, docs/factory.md §5) against the
// pinned Claude Code (tests/support/claude_code.ts) and a scripted fake
// Anthropic API: the agent runs headless with the prompt on stdin, and the
// operator's own settings never widen a child. Run it through
// `scripts/e2e.sh claude-local`; outside `bun test`'s discovery, so the
// pre-push hook never fetches Claude Code for it (#456).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    const runner = new ClaudeRunner({ bin, cwd: h.work, env: h.env });
    expect(runner.roster().map((a) => a.name)).toEqual(["researcher"]);
    const agent = resolvePersona("a researcher", runner.roster())!;
    // A task starting with "-" would be a flag in argv; on stdin it's text.
    const out = await runner.run(agent, { id: 1, source: "dm", requester: "sim", persona: "a researcher", task: "-- FACTORY-TASK: find it" }, new AbortController().signal, { allowedTools: [] }, { cwd: h.work, addDirs: [] }, join(dir, "t.jsonl"));
    expect(out).toMatchObject({ ok: true, text: "RESULT-42", run: { code: 0, turns: 1 } });
    expect(typeof out.run?.session).toBe("string");
    expect(model.unhandled).toEqual([]);
    // The transcript (#649): the child's stream-json events, 0600, ending in its result.
    expect(statSync(join(dir, "t.jsonl")).mode & 0o777).toBe(0o600);
    const events = readFileSync(join(dir, "t.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "RESULT-42", session_id: out.run?.session });
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
    const runner = new ClaudeRunner({ bin: claudeCodeBin(), cwd: h.work, env: h.env });
    const out = await runner.run(runner.roster()[0]!, { id: 1, source: "dm", requester: "sim", persona: "builder", task: "FACTORY-SHELL" }, new AbortController().signal, o, { cwd: h.work, addDirs: [] }, join(dir, "t.jsonl"));
    expect(out).toMatchObject({ ok: true, text: "ended" });
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

// Synthesis reads its subtasks' directories through --add-dir (#641), which
// restricted mode's file confinement includes. The fake model has the child
// Read a file in a sibling of its working directory, with the parent added
// and without.
async function readTrial(add: boolean): Promise<string> {
  const model = startFakeAnthropic([
    (q) => !userTexts(q).some((t) => t.includes("FACTORY-READ")) ? undefined
      : called(q, "toolu_rd") ? { text: "ended" } : { tool: "Read", id: "toolu_rd", input: { file_path: join(dir, "tree", "8", "out.txt") } },
  ]);
  try {
    const h = claudeHome(dir, model.url);
    mkdirSync(join(h.config, "agents"), { recursive: true });
    writeFileSync(join(h.config, "agents", "builder.md"), "---\nname: builder\ndescription: builds\n---\nAGENT-PROMPT-9\n");
    for (const d of ["main", "8"]) mkdirSync(join(dir, "tree", d), { recursive: true });
    writeFileSync(join(dir, "tree", "8", "out.txt"), "SUBTASK-OUTPUT-8\n");
    const runner = new ClaudeRunner({ bin: claudeCodeBin(), cwd: h.work, env: h.env });
    const place = { cwd: join(dir, "tree", "main"), addDirs: add ? [join(dir, "tree")] : [] };
    const out = await runner.run(runner.roster()[0]!, { id: 1, source: "dm", requester: "sim", persona: "builder", task: "FACTORY-READ" }, new AbortController().signal, { allowedTools: [] }, place, join(dir, "t.jsonl"));
    expect(out).toMatchObject({ ok: true, text: "ended" });
    expect(model.unhandled).toEqual([]);
    return toolResults(model, "toolu_rd").join("\n");
  } finally {
    model.stop();
  }
}

test("claude runner: a child reads a sibling directory only when the run adds it (#641)", async () => {
  expect(await readTrial(true)).toContain("SUBTASK-OUTPUT-8");
  expect(await readTrial(false)).not.toContain("SUBTASK-OUTPUT-8");
}, 240_000);

// A budget (#649): Claude Code checks it after each turn, so a child that
// would loop forever stops at the first turn past it, exit 1.
test("claude runner: a run past its budget stops, and the outcome says so", async () => {
  let n = 0;
  const model = startFakeAnthropic([
    (q) => (userTexts(q).some((t) => t.includes("FACTORY-LOOP")) ? { tool: "Read", id: `toolu_l${++n}`, input: { file_path: `/nonexistent/${n}` } } : undefined),
  ]);
  try {
    const h = claudeHome(dir, model.url);
    mkdirSync(join(h.config, "agents"), { recursive: true });
    writeFileSync(join(h.config, "agents", "builder.md"), "---\nname: builder\ndescription: builds\n---\nAGENT-PROMPT-9\n");
    const runner = new ClaudeRunner({ bin: claudeCodeBin(), cwd: h.work, env: h.env });
    const out = await runner.run(runner.roster()[0]!, { id: 1, source: "dm", requester: "sim", persona: "builder", task: "FACTORY-LOOP" }, new AbortController().signal, { allowedTools: [], budgetUsd: 0.00001 }, { cwd: h.work, addDirs: [] }, join(dir, "t.jsonl"));
    expect(out).toMatchObject({ ok: false, run: { code: 1, stop: "budget" } });
    expect(out.ok ? "" : out.error).toStartWith("stopped at its budget of $0.00001");
    expect(n).toBeLessThan(5); // stopped, not timed out
    const last = JSON.parse(readFileSync(join(dir, "t.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "result", subtype: "error_max_budget_usd" });
  } finally {
    model.stop();
  }
}, 120_000);
