// The factory's entry point (docs/factory.md §5–§6): read the
// operator's config, open the store, start the bus session, run until the
// bus goes away. Exits non-zero when it does, so a supervisor (systemd,
// launchd, a tmux loop) restarts it; the store makes a restart safe.
//
//   bun adapters/factory/main.ts            (config: $FACTORY_DATA_DIR/config.json)
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBus, sessionFree } from "./bus.ts";
import { ClaudeRunner } from "./claude/runner.ts";
import { Factory, type Fleet } from "./factory.ts";
import type { Policy } from "./runner.ts";
import { Store } from "./store.ts";
import { WORKDIR_MODES, Workspaces, type Workdir, type WorkdirMode } from "./workdir.ts";

export const VERSION = "0.1.0";

export type Config = {
  identity: string;        // the bus name the factory binds (BUS_IDENTITY)
  grayboard: string[];     // the grayboard CLI command
  claude: string;          // the claude executable
  cwd: string;             // shared mode's working directory, and where project agents are read; default $FACTORY_DATA_DIR/work, never $HOME (the file tools reach all of it)
  workdir: Workdir;        // the global working-directory mode (#641): scratch (default), worktree (needs repo) or shared
  tools?: string[];        // the tools a child has (--tools); absent, Claude Code's restricted default: no shell, no WebFetch
  allowedTools: string[];  // tools a child runs without a prompt; default none. A shell needs Bash in both lists
  profiles: Profile[];     // named agent + tool lists a fleet runs under (#643)
  fleets: Fleet[];         // queue boards `<name>-tasks` the factory is a lane on, each with the agent (and policy) it runs
  maxConcurrent: number;
  maxSubtasks: number;     // the most subtasks a fleet task's plan may fan out to
  timeoutMs: number;
  retentionMs: number;
};

// A profile (#643): the agent, what its children may do and where they run
// (#641). Its tool lists, mode and repo fall back to the global ones field by field.
export type Profile = { name: string; agent: string; tools?: string[]; allowedTools?: string[]; workdir?: WorkdirMode; repo?: string };

const DAY = 86_400_000;
export const DEFAULTS = { identity: "factory", claude: "claude", allowedTools: [] as string[], maxConcurrent: 2, maxSubtasks: 5, timeoutMs: 30 * 60_000, retentionMs: 30 * DAY };

// The config file's fields over the defaults; FACTORY_GRAYBOARD (a command
// line, split on spaces) over the file's `grayboard`. A field of the wrong
// type (null included) is an error, never silently the default.
export function loadConfig(dataDir: string, env: Record<string, string | undefined>): Config {
  const path = join(dataDir, "config.json");
  const raw: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path}: not a JSON object`);
  const get = (k: string, d: unknown) => (raw[k] === undefined ? d : raw[k]);
  const str = (k: string, d: string) => {
    const v = get(k, d);
    if (typeof v !== "string" || !v.trim()) throw new Error(`${path}: "${k}" must be a non-empty string`);
    return v;
  };
  const strs = (k: string, d: string[]) => {
    const v = get(k, d);
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error(`${path}: "${k}" must be an array of non-empty strings`);
    return v as string[];
  };
  const pos = (k: string, d: number) => {
    const v = get(k, d);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${path}: "${k}" must be a positive integer`);
    return v;
  };
  const atLeast2 = (n: number) => { if (n < 2) throw new Error(`${path}: "maxSubtasks" must be at least 2`); return n; };
  const NAME = /^[a-z0-9_-]{1,26}$/;
  const list = (v: unknown, what: string) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error(`${path}: ${what} must be an array of non-empty strings`);
    return v as string[];
  };
  const tools = raw.tools !== undefined ? strs("tools", []) : undefined;
  const allowedTools = strs("allowedTools", DEFAULTS.allowedTools);
  const global: Policy = { ...(tools ? { tools } : {}), allowedTools };
  const mode = (v: unknown, what: string): WorkdirMode => {
    if (typeof v !== "string" || !(WORKDIR_MODES as readonly string[]).includes(v)) throw new Error(`${path}: ${what} must be one of ${WORKDIR_MODES.join(", ")}`);
    return v as WorkdirMode;
  };
  const repo = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${path}: ${what} must be a non-empty string`);
    const r = resolve(dataDir, v);
    let dir = false;
    try { dir = statSync(r).isDirectory(); } catch {}
    if (!dir) throw new Error(`${path}: ${what} ${r} isn't a directory`);
    return r;
  };
  // A worktree-mode run with no repo could never start: refuse the config instead.
  const workdirOf = (m: WorkdirMode, r: string | undefined, who: string): Workdir => {
    if (m === "worktree" && !r) throw new Error(`${path}: ${who}: "workdir": "worktree" needs "repo", a git checkout`);
    return { mode: m, ...(r ? { repo: r } : {}) };
  };
  const globalRepo = raw.repo !== undefined ? repo(raw.repo, `"repo"`) : undefined;
  const workdir = workdirOf(raw.workdir !== undefined ? mode(raw.workdir, `"workdir"`) : "scratch", globalRepo, "the global config");

  const rawProfiles = raw.profiles ?? [];
  if (!Array.isArray(rawProfiles)) throw new Error(`${path}: "profiles" must be an array of {name, agent, tools?, allowedTools?, workdir?, repo?}`);
  const profiles = new Map<string, Profile>();
  for (const p of rawProfiles as Record<string, unknown>[]) {
    if (typeof p !== "object" || p === null || typeof p.name !== "string" || !NAME.test(p.name)) throw new Error(`${path}: each profile's "name" must be 1-26 characters of a-z 0-9 _ -`);
    if (typeof p.agent !== "string" || !p.agent.trim()) throw new Error(`${path}: profile ${p.name}: "agent" must be a non-empty string`);
    if (profiles.has(p.name)) throw new Error(`${path}: profile ${p.name} is listed twice`);
    profiles.set(p.name, {
      name: p.name, agent: p.agent.trim(),
      ...(p.tools !== undefined ? { tools: list(p.tools, `profile ${p.name}: "tools"`) } : {}),
      ...(p.allowedTools !== undefined ? { allowedTools: list(p.allowedTools, `profile ${p.name}: "allowedTools"`) } : {}),
      ...(p.workdir !== undefined ? { workdir: mode(p.workdir, `profile ${p.name}: "workdir"`) } : {}),
      ...(p.repo !== undefined ? { repo: repo(p.repo, `profile ${p.name}: "repo"`) } : {}),
    });
    const q = profiles.get(p.name)!;
    workdirOf(q.workdir ?? workdir.mode, q.repo ?? workdir.repo, `profile ${p.name}`); // a profile no fleet uses yet must still be runnable
  }

  const rawFleets = raw.fleets ?? [];
  if (!Array.isArray(rawFleets)) throw new Error(`${path}: "fleets" must be an array of {name, agent} or {name, profile}`);
  const fleets: Fleet[] = [];
  for (const f of rawFleets as Record<string, unknown>[]) {
    // The board name `<name>-tasks` must fit a board name: [a-z0-9_-], max 32.
    if (typeof f !== "object" || f === null || typeof f.name !== "string" || !NAME.test(f.name)) throw new Error(`${path}: each fleet's "name" must be 1-26 characters of a-z 0-9 _ -`);
    if (f.fanout !== undefined && typeof f.fanout !== "boolean") throw new Error(`${path}: fleet ${f.name}: "fanout" must be true or false`);
    if (fleets.some((x) => x.name === f.name)) throw new Error(`${path}: fleet ${f.name} is listed twice`);
    const fanout = f.fanout === false ? { fanout: false } : {};
    if (f.profile !== undefined) {
      // A profile carries the agent: naming both would leave one ignored.
      if (f.agent !== undefined) throw new Error(`${path}: fleet ${f.name}: give "profile" or "agent", not both`);
      const p = typeof f.profile === "string" ? profiles.get(f.profile) : undefined;
      if (!p) throw new Error(`${path}: fleet ${f.name}: "profile" must name a profile in "profiles"`);
      const policy: Policy = { ...(p.tools ? { tools: p.tools } : tools ? { tools } : {}), allowedTools: p.allowedTools ?? allowedTools };
      fleets.push({ name: f.name, agent: p.agent, ...fanout, profile: p.name, policy, workdir: workdirOf(p.workdir ?? workdir.mode, p.repo ?? workdir.repo, `profile ${p.name}`) });
    } else {
      if (typeof f.agent !== "string" || !f.agent.trim()) throw new Error(`${path}: fleet ${f.name}: "agent" (or "profile") must be a non-empty string`);
      fleets.push({ name: f.name, agent: f.agent.trim(), ...fanout });
    }
  }
  const gb = env.FACTORY_GRAYBOARD?.trim() ? env.FACTORY_GRAYBOARD.trim().split(/\s+/) : strs("grayboard", ["grayboard"]);
  if (gb.length === 0) throw new Error(`${path}: "grayboard" must not be empty`);
  const identity = str("identity", DEFAULTS.identity);
  // A bus name (boards.md §3); anything else could never be bound.
  if (!/^[a-z0-9_-]{1,32}$/.test(identity)) throw new Error(`${path}: "identity" must be 1-32 characters of a-z 0-9 _ -`);
  return {
    identity,
    grayboard: gb,
    claude: str("claude", DEFAULTS.claude),
    cwd: resolve(dataDir, str("cwd", join(dataDir, "work"))),
    workdir,
    ...global,
    profiles: [...profiles.values()],
    fleets,
    maxConcurrent: pos("maxConcurrent", DEFAULTS.maxConcurrent),
    maxSubtasks: atLeast2(pos("maxSubtasks", DEFAULTS.maxSubtasks)),
    timeoutMs: pos("timeoutMs", DEFAULTS.timeoutMs),
    retentionMs: pos("retentionMs", DEFAULTS.retentionMs),
  };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const log = (m: string) => console.error(`[factory] ${m}`);
  const dataDir = resolve(env.FACTORY_DATA_DIR ?? join(env.HOME ?? homedir(), ".grayboard-factory"));
  const cfg = loadConfig(dataDir, env);
  mkdirSync(cfg.cwd, { recursive: true });
  const store = new Store(join(dataDir, "factory.db"));
  const runner = new ClaudeRunner({ bin: cfg.claude, cwd: cfg.cwd, env: sessionFree(env) });
  let bus: LocalBus;
  try {
    bus = await LocalBus.start({ command: cfg.grayboard, identity: cfg.identity, version: VERSION, env: sessionFree(env) });
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    store.close();
    return 1;
  }
  log(`bound ${bus.handle}; ${runner.roster().length} ${runner.harness} agent(s) in ${runner.rosterSource}`);
  const workspaces = new Workspaces(join(dataDir, "trees"), cfg.cwd);
  const factory = new Factory(bus, store, runner, { fleets: cfg.fleets, policy: { ...(cfg.tools ? { tools: cfg.tools } : {}), allowedTools: cfg.allowedTools }, workdir: cfg.workdir, workspaces, maxConcurrent: cfg.maxConcurrent, maxSubtasks: cfg.maxSubtasks, timeoutMs: cfg.timeoutMs, retentionMs: cfg.retentionMs, log });
  let signalled = false;
  const stop = () => { signalled = true; void bus.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const why = await factory.run();
  log(`stopping: ${why}`);
  store.close();
  return signalled ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
