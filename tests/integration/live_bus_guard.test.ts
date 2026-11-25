// A test run can't reach the developer's live bus (tests/support/preload.ts).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { localDbPath, openLocalDb, refuseForbiddenBus } from "../../src/local/open.ts";
import { writeRetentionSetting } from "../../src/local/retention.ts";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";

const LIVE = join(homedir(), ".claude-bus", "bus.db");

// `bun test` reads bunfig.toml from its working directory only. Below, this file
// spawns children onto the default path to prove them refused, so it stops here
// rather than run them where nothing refuses.
if (!process.env.GRAYBOARD_TEST_FORBID_BUS) throw new Error("the preload did not load: run `bun test` from the repo root");

test("this run's default bus is a throwaway, and the live one is named forbidden", () => {
  expect(process.env.GRAYBOARD_TEST_FORBID_BUS?.split(":")).toContain(LIVE);
  expect(localDbPath()).not.toBe(LIVE);
  expect(cleanEnv().GRAYBOARD_TEST_FORBID_BUS).toBe(process.env.GRAYBOARD_TEST_FORBID_BUS!);
});

test("every way to open the live path is refused before it touches the file", () => {
  const refused = "a test run tried to open the live bus";
  expect(() => refuseForbiddenBus(LIVE)).toThrow(refused);
  expect(() => localDbPath({ BUS_DB_PATH: LIVE })).toThrow(refused);
  expect(() => openLocalDb(LIVE)).toThrow(refused);
  expect(() => writeRetentionSetting(LIVE, null)).toThrow(refused);
});

// The two shapes of child a test spawns, run for real. A child that inherits this
// run's env stays on the throwaway bus; cleanEnv drops BUS_DB_PATH on purpose, so
// a child built from it with the real HOME resolves the default path, and refuses.
const main = join(ROOT, "src", "cli", "main.ts");
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

test("a child inheriting the run's env stays on the throwaway bus", () => {
  const r = Bun.spawnSync([process.execPath, main, "retention", "--json"], { env: { ...process.env } as Record<string, string> });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(decode(r.stdout)).path).toBe(process.env.BUS_DB_PATH!);
  expect(process.env.BUS_DB_PATH!).not.toBe(LIVE);
});

test("a child from cleanEnv with the real HOME is refused the default path: command and SessionStart hook", () => {
  const env = cleanEnv({ HOME: homedir() });
  expect(env.BUS_DB_PATH).toBeUndefined();

  const command = Bun.spawnSync([process.execPath, main, "retention", "--json"], { env });
  expect(command.exitCode).toBe(1);
  expect(decode(command.stderr)).toContain("a test run tried to open the live bus");

  const sock = mkdtempSync(join(tmpdir(), "gb-guard-"));
  // The hook reads the bus only for an explicit identity, and its title is
  // best-effort: a refusal is silent, so the control shows what it took away.
  const hook = (extra: Record<string, string>) => Bun.spawnSync([process.execPath, main, "hook", "claude", "session-start"], {
    stdin: new TextEncoder().encode(JSON.stringify({ source: "startup", session_id: "current" })),
    env: { ...env, BUS_IDENTITY: "web", BUS_SOCK_DIR: sock, CLAUDE_PID: String(process.pid), ...extra },
  });
  const control = hook({ BUS_DB_PATH: join(sock, "bus.db") });
  expect(control.exitCode).toBe(0);
  expect(decode(control.stdout)).toContain("web");
  const refused = hook({});
  expect(refused.exitCode).toBe(0);
  expect(decode(refused.stdout)).toBe("");
});

// The preload's cleanup runs once per pass, and flake repros rely on --rerun-each (#457).
test("every --rerun-each pass still has the run's throwaway dir", () => {
  const r = Bun.spawnSync([process.execPath, "test", "--rerun-each", "2", "tests/support/run_dir.test.ts"], { cwd: ROOT, env: { ...process.env } as Record<string, string> });
  expect(decode(r.stderr)).toContain(" 0 fail");
  expect(r.exitCode).toBe(0);
});

// These open the bus on import, and mcp.ts starts retention on it.
test("no test or test helper imports a module that opens the bus on load", () => {
  const byPath = /(?:from\s*|import\()["'][^"']*local\/(?:db|mcp|human|tail)\.ts["']/;
  const sibling = /(?:from\s*|import\()["']\.\/(?:db|mcp|human|tail)\.ts["']/;
  const offenders: string[] = [];
  const walk = (dir: string, pattern: RegExp, name: RegExp) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, pattern, name);
      else if (name.test(e.name) && pattern.test(readFileSync(path, "utf8"))) offenders.push(relative(ROOT, path));
    }
  };
  walk(join(ROOT, "tests"), byPath, /\.ts$/);
  walk(join(ROOT, "src"), byPath, /\.test\.ts$/);
  walk(join(ROOT, "src", "local"), sibling, /\.test\.ts$/);
  expect(offenders).toEqual([]);
});
