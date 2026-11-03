import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORD_CAP, RECORD_TTL_MS, ROOT, runHook, sessionDir, takeEnded, takeRecord } from "./claude_agents.ts";
import { procStart } from "./proc.ts";

let base: string;
const pid = process.pid;
const env = { CLAUDE_PID: String(pid) };
const hook = (event: string, input: Record<string, unknown>, ended = false, now?: number) =>
  runHook(event, JSON.stringify(input), { base, env, ended, ...(now ? { now } : {}) });
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

  test("no SessionStart, a stale record and a recycled pid each count as absent", () => {
    hook("pre-tool-use", { tool_use_id: id(1) });
    expect(takeRecord(base, pid, start(), id(1))).toEqual({ missing: "no_session" });
    hook("session-start", {});
    hook("pre-tool-use", { tool_use_id: id(2) });
    const old = (Date.now() - RECORD_TTL_MS - 1000) / 1000;
    utimesSync(join(sessionDir(base, pid), id(2)), old, old);
    expect(takeRecord(base, pid, start(), id(2))).toEqual({ missing: "stale" });
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
    const old = (Date.now() - RECORD_TTL_MS - 1000) / 1000;
    writeFileSync(join(dir, `${id("x")}.taken.1`), "a");
    utimesSync(join(dir, `${id("x")}.taken.1`), old, old);
    writeFileSync(join(dir, `${id("y")}.taken.2`), "a");
    for (let i = 0; i < RECORD_CAP + 5; i++) {
      writeFileSync(join(dir, id(`r${i}`)), ROOT);
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

  test("a hook without CLAUDE_PID or with bad input does nothing and never throws", () => {
    runHook("session-start", "{}", { base, env: {}, ended: false });
    runHook("pre-tool-use", "not json", { base, env, ended: false });
    expect(existsSync(join(base, "claude-agents"))).toBe(false);
  });
});
