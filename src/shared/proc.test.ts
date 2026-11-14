// Liveness (#182 audit 9): a row is dead only on evidence, the pid gone or a
// start time that differs; an unknown start time counts as alive.
import { afterEach, expect, spyOn, test } from "bun:test";
import { aliveRows, isAlive, procStart } from "./proc.ts";
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
