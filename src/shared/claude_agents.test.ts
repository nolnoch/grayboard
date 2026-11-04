import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEFTOVER_TTL_MS, readFacts, RECORD_CAP, ROOT, runHook, sessionDir, takeEnded, takeRecord } from "./claude_agents.ts";
import { procStart } from "./proc.ts";

let base: string;
const pid = process.pid;
const env = { CLAUDE_PID: String(pid) };
const hook = (event: string, input: Record<string, unknown>, hosted = false, now?: number) =>
  runHook(event, JSON.stringify(input), { base, env, hosted, ...(now ? { now } : {}) });
const start = () => procStart(pid) ?? null;
const id = (n: number | string) => `toolu_01ABC${n}`;

beforeEach(() => { base = mkdtempSync(join(tmpdir(), "gb-agents-")); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("records", () => {
  test("a subagent's call names its agent; a main-agent call is the root", () => {
    hook("session-start", { hook_event_name: "SessionStart" });
    hook("pre-tool-use", { tool_use_id: id(1), agent_id: "a573e90bd84bce7ff" });
    hook("pre-tool-use", { tool_use_id: id(2) });
    expect(takeRecord(base, pid, start(), id(1))).toEqual({ agent: "a573e90bd84bce7ff" });
    expect(takeRecord(base, pid, start(), id(2))).toEqual({ agent: null });
    // Taken once.
    expect(takeRecord(base, pid, start(), id(1))).toEqual({ missing: "absent" });
    expect(readdirSync(sessionDir(base, pid)).sort()).toEqual(["start"]);
  });

  test("a bad tool_use_id is never written and always refused", () => {
    hook("session-start", {});
    for (const bad of ["../start", "toolu_", "toolu_a/b", "x".repeat(10), `toolu_${"a".repeat(129)}`]) {
      hook("pre-tool-use", { tool_use_id: bad, agent_id: "a1" });
      expect(takeRecord(base, pid, start(), bad)).toEqual({ missing: "bad_tool_use_id" });
    }
    expect(readdirSync(sessionDir(base, pid))).toEqual(["start"]);
  });

  test("a bad agent id writes nothing, and a forged bad record is refused", () => {
    hook("session-start", {});
    hook("pre-tool-use", { tool_use_id: id(1), agent_id: "a\nb" });
    hook("pre-tool-use", { tool_use_id: id(2), agent_id: ROOT });
    hook("pre-tool-use", { tool_use_id: id(3), agent_id: 7 });
    expect(readdirSync(sessionDir(base, pid))).toEqual(["start"]);
    writeFileSync(join(sessionDir(base, pid), id(4)), "x\u0000y");
    expect(takeRecord(base, pid, start(), id(4))).toEqual({ missing: "bad_record" });
  });

  test("no SessionStart and a recycled pid each count as absent; an old record is still taken", () => {
    hook("pre-tool-use", { tool_use_id: id(1) });
    expect(takeRecord(base, pid, start(), id(1))).toEqual({ missing: "no_session" });
    hook("session-start", {});
    hook("pre-tool-use", { tool_use_id: id(2) });
    // A call can wait on Claude Code's permission prompt for any time after PreToolUse.
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(join(sessionDir(base, pid), id(2)), old, old);
    expect(takeRecord(base, pid, start(), id(2))).toEqual({ agent: null });
    hook("pre-tool-use", { tool_use_id: id(3) });
    expect(takeRecord(base, pid, "Mon Jan  1 00:00:00 2001", id(3))).toEqual({ missing: "recycled_pid" });
    // An unknown start on the reader's side accepts the dir.
    expect(takeRecord(base, pid, null, id(3))).toEqual({ agent: null });
  });

  test("two concurrent takes give the record to one reader", async () => {
    hook("session-start", {});
    const n = 20;
    for (let i = 0; i < n; i++) hook("pre-tool-use", { tool_use_id: id(i), agent_id: `a${i}` });
    const script = join(base, "take.ts");
    writeFileSync(script, `import { takeRecord } from ${JSON.stringify(join(import.meta.dir, "claude_agents.ts"))};
const out = []; for (let i = 0; i < ${n}; i++) out.push(takeRecord(process.argv[2], ${pid}, null, "toolu_01ABC" + i));
console.log(JSON.stringify(out));`);
    const run = () => Bun.spawn(["bun", script, base], { stdout: "pipe" });
    const [a, b] = [run(), run()];
    const [ra, rb] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    const xs = JSON.parse(ra) as { agent?: string }[], ys = JSON.parse(rb) as { agent?: string }[];
    for (let i = 0; i < n; i++) {
      const got = [xs[i], ys[i]].filter(r => r && "agent" in r);
      expect(got).toEqual([{ agent: `a${i}` }]);
    }
  });

  test("the hook keeps at most RECORD_CAP records and prunes old takes", () => {
    hook("session-start", {});
    const dir = sessionDir(base, pid);
    const old = (Date.now() - LEFTOVER_TTL_MS - 1000) / 1000;
    writeFileSync(join(dir, `${id("x")}.taken.1`), "a");
    utimesSync(join(dir, `${id("x")}.taken.1`), old, old);
    writeFileSync(join(dir, `${id("y")}.taken.2`), "a");
    for (let i = 0; i < RECORD_CAP + 5; i++) {
      writeFileSync(join(dir, id(`r${i}`)), JSON.stringify({ agent: null }));
      const t = (Date.now() - (RECORD_CAP + 5 - i) * 1000) / 1000;
      utimesSync(join(dir, id(`r${i}`)), t, t);
    }
    hook("pre-tool-use", { tool_use_id: id("new") });
    const names = readdirSync(dir);
    expect(names.filter(n => /^toolu_[A-Za-z0-9_]+$/.test(n)).length).toBe(RECORD_CAP);
    expect(names).toContain(id("new"));
    expect(names).not.toContain(id("r0"));
    expect(names).not.toContain(`${id("x")}.taken.1`);
    expect(names).toContain(`${id("y")}.taken.2`);
  });
});

describe("session lifecycle", () => {
  test("SessionEnd removes the dir, except on /clear", () => {
    hook("session-start", {});
    hook("pre-tool-use", { tool_use_id: id(1) });
    hook("session-end", { reason: "clear" });
    expect(takeRecord(base, pid, start(), id(1))).toEqual({ agent: null });
    hook("session-end", { reason: "prompt_input_exit" });
    expect(existsSync(sessionDir(base, pid))).toBe(false);
  });

  test("SessionStart prunes a dead session's dir and keeps a live one's", () => {
    const dead = join(base, "claude-agents", "999999");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "start"), "x");
    const live = join(base, "claude-agents", String(process.ppid));
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "start"), procStart(process.ppid) ?? "");
    hook("session-start", {});
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("SubagentStop's marker is hosted-only and consumed once", () => {
    hook("session-start", {});
    hook("subagent-stop", { agent_id: "a1" });
    expect(takeEnded(base, pid)).toEqual([]);
    hook("subagent-stop", { agent_id: "a1" }, true);
    hook("subagent-stop", { agent_id: "a2" }, true);
    expect(takeEnded(base, pid).sort()).toEqual(["a1", "a2"]);
    expect(takeEnded(base, pid)).toEqual([]);
  });

  test("SubagentStop keeps at most RECORD_CAP undrained markers, dropping the oldest", () => {
    hook("session-start", {});
    for (let i = 0; i <= RECORD_CAP + 2; i++) {
      runHook("subagent-stop", JSON.stringify({ agent_id: `a${i}` }), { base, env: { CLAUDE_PID: String(pid) }, hosted: true, now: 1_000 + i });
    }
    const got = takeEnded(base, pid);
    expect(got.length).toBe(RECORD_CAP);
    expect(got).not.toContain("a0");
    expect(got).toContain(`a${RECORD_CAP + 2}`);
  });

  test("a hook without CLAUDE_PID or with bad input does nothing and never throws", () => {
    runHook("session-start", "{}", { base, env: {}, hosted: false });
    runHook("pre-tool-use", "not json", { base, env, hosted: false });
    expect(existsSync(join(base, "claude-agents"))).toBe(false);
  });
});

describe("facts (#545)", () => {
  const said: string[] = [];
  const facts = () => readFacts(base, pid, start(), (fact, error) => said.push(`${fact}: ${error}`));
  beforeEach(() => { said.length = 0; });

  test("SessionStart's model, then PostModelSwitch's; the root's PreToolUse effort", () => {
    hook("session-start", { source: "startup", model: "claude-opus-5-5" }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    hook("pre-tool-use", { tool_use_id: id(1), effort: { level: "medium" } }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    // A switch drops the old model's effort until the next root call names one.
    hook("model-switch", { from_model: "claude-opus-5-5", to_model: "claude-haiku-4-5" }, true);
    expect(facts()).toEqual({ model: "claude-haiku-4-5" });
    hook("pre-tool-use", { tool_use_id: id(2), effort: { level: "high" } }, true);
    expect(facts()).toEqual({ model: "claude-haiku-4-5", effort: "high" });
    // /clear: SessionStart rewrites the model; the effort stays.
    hook("session-start", { source: "clear", model: "claude-opus-5-5[1m]" }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5[1m]", effort: "high" });
    // A root call on a model without effort says it has none (#558): null, which the wire sends as a clear.
    hook("pre-tool-use", { tool_use_id: id(3) }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5[1m]", effort: null });
    // A switch makes it unknown again (left out, so the server keeps its value), not none.
    hook("model-switch", { from_model: "claude-opus-5-5[1m]", to_model: "claude-opus-5-5" }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    // A new process's SessionStart removes a none, too.
    hook("pre-tool-use", { tool_use_id: id(4) }, true);
    hook("session-start", { source: "startup", model: "claude-opus-5-5" }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    expect(said).toEqual([]);
  });

  test("a subagent's effort and malformed values write nothing", () => {
    hook("session-start", { model: "claude-opus-5-5" }, true);
    hook("pre-tool-use", { tool_use_id: id(1), effort: { level: "low" } }, true);
    hook("pre-tool-use", { tool_use_id: id(2), agent_id: "a1", effort: { level: "max" } }, true);
    hook("pre-tool-use", { tool_use_id: id(3), agent_id: "a1" }, true);
    for (const bad of ["", "has space", "x".repeat(65), 5, { level: "high" }, "bad\nline"]) {
      hook("pre-tool-use", { tool_use_id: id(4), effort: { level: bad } }, true);
      hook("model-switch", { to_model: bad }, true);
    }
    expect(facts()).toEqual({ model: "claude-opus-5-5", effort: "low" });
    // The server's limit is the hook's.
    hook("model-switch", { to_model: "x".repeat(64) }, true);
    expect(facts()?.model).toBe("x".repeat(64));
  });

  test("the local hook writes no facts", () => {
    hook("session-start", { model: "claude-opus-5-5" });
    hook("pre-tool-use", { tool_use_id: id(1), effort: { level: "high" } });
    hook("model-switch", { to_model: "claude-haiku-4-5" });
    expect(facts()).toEqual({});
    expect(readdirSync(sessionDir(base, pid)).sort()).toEqual(["start", id(1)]);
  });

  test("no SessionStart record, a recycled pid's dir, and a malformed file", () => {
    expect(facts()).toBeUndefined();
    hook("model-switch", { to_model: "claude-haiku-4-5" }, true);
    expect(facts()).toBeUndefined();
    hook("session-start", { model: "claude-opus-5-5" }, true);
    expect(readFacts(base, pid, "another start", () => {})).toBeUndefined();
    // A bad file is left out and said; the good one still reads.
    writeFileSync(join(sessionDir(base, pid), "effort"), "two words");
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    expect(said).toEqual([`effort: ${join(sessionDir(base, pid), "effort")} isn't a Claude Code effort`]);
  });

  test("a new process's SessionStart drops facts an earlier holder of the pid left; /clear keeps the effort", () => {
    hook("session-start", { source: "startup", model: "claude-opus-5-5" }, true);
    hook("pre-tool-use", { tool_use_id: id(1), effort: { level: "max" } }, true);
    hook("session-start", { source: "clear", model: "claude-opus-5-5" }, true);
    expect(facts()).toEqual({ model: "claude-opus-5-5", effort: "max" });
    hook("session-start", { source: "startup" }, true);
    expect(facts()).toEqual({});
  });

  test("a link, a FIFO or an oversized fact file is said and left out, never followed, waited on or read whole", () => {
    hook("session-start", { model: "claude-opus-5-5" }, true);
    const dir = sessionDir(base, pid);
    symlinkSync("/dev/zero", join(dir, "effort"));
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    rmSync(join(dir, "effort"));
    execFileSync("mkfifo", [join(dir, "effort")]);
    expect(facts()).toEqual({ model: "claude-opus-5-5" });
    rmSync(join(dir, "model"));
    writeFileSync(join(dir, "model"), "x".repeat(10_000));
    expect(facts()).toEqual({});
    expect(said.map(s => s.split(":")[0])).toEqual(["effort", "effort", "model", "effort"]);
  });
});
