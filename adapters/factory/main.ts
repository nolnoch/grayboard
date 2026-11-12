// The factory's entry point (docs/factory.md §5–§6): read the
// operator's config, open the store, start the bus session, run until the
// bus goes away. Exits non-zero when it does, so a supervisor (systemd,
// launchd, a tmux loop) restarts it; the store makes a restart safe.
//
//   bun adapters/factory/main.ts            (config: $FACTORY_DATA_DIR/config.json)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBus, sessionFree } from "./bus.ts";
import { ClaudeRunner } from "./claude/runner.ts";
import { Factory, type Fleet } from "./factory.ts";
import { Store } from "./store.ts";

export const VERSION = "0.1.0";

export type Config = {
  identity: string;        // the bus name the factory binds (BUS_IDENTITY)
  grayboard: string[];     // the grayboard CLI command
  claude: string;          // the claude executable
  cwd: string;             // the children's working directory; default $FACTORY_DATA_DIR/work, never $HOME (the file tools reach all of it)
  tools?: string[];        // the tools a child has (--tools); absent, Claude Code's restricted default: no shell, no WebFetch
  allowedTools: string[];  // tools a child runs without a prompt; default none. A shell needs Bash in both lists
  fleets: Fleet[];         // queue boards `<name>-tasks` the factory is a lane on, each with the agent it runs
  maxConcurrent: number;
  timeoutMs: number;
  retentionMs: number;
};

const DAY = 86_400_000;
export const DEFAULTS = { identity: "factory", claude: "claude", allowedTools: [] as string[], maxConcurrent: 2, timeoutMs: 30 * 60_000, retentionMs: 30 * DAY };

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
  const fleets = raw.fleets ?? [];
  if (!Array.isArray(fleets)) throw new Error(`${path}: "fleets" must be an array of {name, agent}`);
  const seen = new Set<string>();
  for (const f of fleets as Record<string, unknown>[]) {
    // The board name `<name>-tasks` must fit a board name: [a-z0-9_-], max 32.
    if (typeof f !== "object" || f === null || typeof f.name !== "string" || !/^[a-z0-9_-]{1,26}$/.test(f.name)) throw new Error(`${path}: each fleet's "name" must be 1-26 characters of a-z 0-9 _ -`);
    if (typeof f.agent !== "string" || !f.agent.trim()) throw new Error(`${path}: fleet ${f.name}: "agent" must be a non-empty string`);
    if (seen.has(f.name)) throw new Error(`${path}: fleet ${f.name} is listed twice`);
    seen.add(f.name);
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
    ...(raw.tools !== undefined ? { tools: strs("tools", []) } : {}),
    allowedTools: strs("allowedTools", DEFAULTS.allowedTools),
    fleets: (fleets as Record<string, string>[]).map((f) => ({ name: f.name!, agent: f.agent!.trim() })),
    maxConcurrent: pos("maxConcurrent", DEFAULTS.maxConcurrent),
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
  const runner = new ClaudeRunner({ bin: cfg.claude, cwd: cfg.cwd, ...(cfg.tools ? { tools: cfg.tools } : {}), allowedTools: cfg.allowedTools, env: sessionFree(env) });
  let bus: LocalBus;
  try {
    bus = await LocalBus.start({ command: cfg.grayboard, identity: cfg.identity, version: VERSION, env: sessionFree(env) });
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    store.close();
    return 1;
  }
  log(`bound ${bus.handle}; ${runner.roster().length} ${runner.harness} agent(s) in ${runner.rosterSource}`);
  const factory = new Factory(bus, store, runner, { fleets: cfg.fleets, maxConcurrent: cfg.maxConcurrent, timeoutMs: cfg.timeoutMs, retentionMs: cfg.retentionMs, log });
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
