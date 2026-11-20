// Liveness (#182 audit 9): a row is dead only on evidence, the pid gone or a
// start time that differs; an unknown start time counts as alive.
import { afterEach, expect, spyOn, test } from "bun:test";
import { aliveRows, claudeAmong, isAlive, isClaudeCode, parentOf, parentsOf, procStart, type AncestorFacts } from "./proc.ts";
import { until } from "../../tests/support/until.ts";

const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
});

// A pid that existed and is gone: a child that has exited and been reaped.
function deadPid(): number {
  const p = Bun.spawnSync(["true"]);
  return p.pid;
}

test("the running process is alive under its own start time, and dead under another", () => {
  const start = procStart(process.pid)!;
  expect(start).toBeString();
  expect(isAlive(process.pid, start)).toBe(true);
  expect(isAlive(process.pid, `${start}x`)).toBe(false);
  expect(aliveRows([{ pid: process.pid, proc_start: `${start}x` }]).dead).toHaveLength(1);
});

test("a gone pid is dead, and has no start time", () => {
  const pid = deadPid();
  expect(procStart(pid)).toBeUndefined();
  expect(isAlive(pid, null)).toBe(false);
  expect(aliveRows([{ pid, proc_start: "x" }]).dead).toHaveLength(1);
});

// #331: a zombie (exited, never reaped by its parent) still passes kill(pid, 0),
// so it reads as gone by its state. `sh` backgrounds `true`, then execs a
// sleep that never waits for it.
test("a zombie pid is dead, and has no start time", async () => {
  const parent = Bun.spawn(["sh", "-c", "true & echo $!; exec sleep 30"], { stdout: "pipe" });
  try {
    // The first line only: the sleep holds stdout open.
    const { value } = await parent.stdout.getReader().read();
    const pid = Number(new TextDecoder().decode(value).trim());
    expect(pid).toBeGreaterThan(0);
    await until(() => procStart(pid) === undefined, 5000, `pid ${pid} to read as gone once it's a zombie`);
    expect(isAlive(pid, null)).toBe(false);
    expect(aliveRows([{ pid, proc_start: null }]).dead).toHaveLength(1);
  } finally {
    parent.kill();
  }
});

test("a row with no recorded start time is alive while its pid exists, and says so once", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const rows = [{ pid: process.ppid, proc_start: null }];
    expect(aliveRows(rows).alive).toEqual(rows);
    expect(isAlive(process.ppid, null)).toBe(true);
    const said = err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes(`pid ${process.ppid}'s row has no start time`));
    expect(said).toHaveLength(1);
  } finally {
    err.mockRestore();
  }
});

test.skipIf(process.platform === "linux")("macOS: when ps can't run, a present pid's start time is unknown and its row stays alive", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.PATH = "/nonexistent";
    expect(procStart(process.pid)).toBeNull();
    const rows = [{ pid: process.pid, proc_start: "not its start time" }];
    expect(aliveRows(rows)).toEqual({ alive: rows, dead: [] });
    expect(err.mock.calls.some((c) => String(c[0]).includes("ps failed to run"))).toBe(true);
  } finally {
    err.mockRestore();
  }
});

// #1463: parent reads for adapter displacement, several pids in one call.
test.skipIf(process.platform !== "linux")("Linux: parentsOf reads each pid's parent, and none for a gone pid", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  try {
    const gone = deadPid();
    const parents = parentsOf([process.pid, gone, child.pid]);
    expect([...parents.keys()]).toEqual([process.pid, gone, child.pid]);
    expect(parents.get(process.pid)).toBe(process.ppid);
    expect(parents.get(gone)).toBeNull();
    expect(parents.get(child.pid)).toBe(process.pid);
    expect(parentOf(process.pid)).toBe(process.ppid);
    expect(parentOf(gone)).toBeNull();
    expect(parentsOf([])).toEqual(new Map());
  } finally {
    child.kill();
    await child.exited;
  }
});

test.skipIf(process.platform === "linux")("macOS: parentsOf reads every pid's parent with one ps, and none when ps can't run", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  const spawn = spyOn(Bun, "spawnSync");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const gone = deadPid();
    spawn.mockClear();
    const parents = parentsOf([process.pid, gone, child.pid]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(parents.get(process.pid)).toBe(process.ppid);
    expect(parents.get(gone)).toBeNull();
    expect(parents.get(child.pid)).toBe(process.pid);
    process.env.PATH = "/nonexistent";
    expect(parentsOf([process.pid, child.pid])).toEqual(new Map([[process.pid, null], [child.pid, null]]));
  } finally {
    spawn.mockRestore();
    err.mockRestore();
    child.kill();
    await child.exited;
  }
});

// #1403: what counts as Claude Code when it is this process's harness.
test("isClaudeCode: Claude Code's process titles, binaries and older npm installs; not other harnesses", () => {
  expect(isClaudeCode("claude", ["claude", "--resume"])).toBe(true);
  expect(isClaudeCode("claude daemon", [])).toBe(true);
  expect(isClaudeCode("claude.exe", [])).toBe(true);
  // A path holding spaces stays one argv[0] (Linux's NUL-split cmdline).
  expect(isClaudeCode("node", ["/Users/u/Library/Application Support/claude/claude"])).toBe(true);
  expect(isClaudeCode(null, ["/opt/n/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"])).toBe(true);
  expect(isClaudeCode("node", ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--resume"])).toBe(true);
  expect(isClaudeCode("node", ["/usr/bin/node", "--no-warnings", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe(true);
  // The legacy cli.js counts only as node's or bun's script, not as another harness's argument.
  expect(isClaudeCode("omp", ["omp", "--read", "/x/@anthropic-ai/claude-code/cli.js"])).toBe(false);
  expect(isClaudeCode("node", ["node", "/x/omp.js", "/x/@anthropic-ai/claude-code/cli.js"])).toBe(false);
  expect(isClaudeCode("omp", ["omp", "--mode", "acp"])).toBe(false);
  expect(isClaudeCode("bun", ["bun", "/home/u/claude-tools/run.ts"])).toBe(false);
  expect(isClaudeCode("claudette", ["claudette"])).toBe(false);
  expect(isClaudeCode(null, [])).toBe(false);
});

// #1403: the walk up to the harness sees through launchers (not WRAPPERS),
// which only moves it up to the real harness.
test("claudeAmong: launchers between Claude Code and grayboard are seen through; one under another harness doesn't make it Claude Code", () => {
  const p = (argv: string, wrapper = false, comm: string | null = argv.split(" ")[0]!.split("/").pop()!): AncestorFacts => ({ comm, argv: argv.split(" "), wrapper });
  const claude = p("claude --resume");
  const omp = p("omp --mode acp");
  expect(claudeAmong([p("timeout 600 grayboard mcp"), claude])).toBe(true);
  expect(claudeAmong([p("timeout 600 grayboard mcp"), omp, claude])).toBe(false);
  for (const launcher of ["nice -n 5", "ionice -c3", "nohup", "stdbuf -oL", "direnv exec .", "mise x --", "mise exec --", "/usr/bin/uv run", "uvx"]) {
    expect(claudeAmong([p(`${launcher} grayboard mcp`), claude])).toBe(true);
    expect(claudeAmong([p(`${launcher} grayboard mcp`), omp, claude])).toBe(false);
  }
  // A wrapper (wrapperName) and a launcher stack.
  expect(claudeAmong([p("sh -c x", true), p("uv run grayboard"), claude])).toBe(true);
  // Not a launcher verb: uv itself, or mise's other subcommands, are the harness.
  expect(claudeAmong([p("uv tool list"), claude])).toBe(false);
  expect(claudeAmong([p("mise run task"), claude])).toBe(false);
  // Options before the verb: flags, and the value of one that takes one.
  expect(claudeAmong([p("uv --quiet run grayboard"), claude])).toBe(true);
  expect(claudeAmong([p("mise -C d x -- grayboard"), claude])).toBe(true);
  expect(claudeAmong([p("uv --directory /w run grayboard"), claude])).toBe(true);
  expect(claudeAmong([p("uv --quiet run grayboard"), omp, claude])).toBe(false);
  expect(claudeAmong([p("mise -C run x"), claude])).toBe(true);
  expect(claudeAmong([p("mise --verbose run task"), claude])).toBe(false);
  // Nothing past the launchers, or an unreadable harness: unknown.
  expect(claudeAmong([p("timeout 5 x")])).toBeNull();
  expect(claudeAmong([{ comm: null, argv: [], wrapper: false }, claude])).toBeNull();
  expect(claudeAmong([])).toBeNull();
});
