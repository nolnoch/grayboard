// The factory's entry point (docs/factory.md §5–§6): read the
// operator's config, open the store, start the bus session, run until the
// bus goes away. Exits non-zero when it does, so a supervisor (systemd,
// launchd, a tmux loop) restarts it; the store makes a restart safe.
//
//   bun adapters/factory/main.ts            (config: $FACTORY_DATA_DIR/config.json)
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBus, sessionFree, startReader } from "./bus.ts";
import { ClaudeRunner } from "./claude/runner.ts";
import { ASK_DEFAULTS, Factory, type AskPolicy, type Fleet, type Limits, type Route } from "./factory.ts";
import { MIRROR_TTL_MIN } from "./mirror.ts";
import { Relay, shimCommand } from "./relay.ts";
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
  budgetUsd?: number;      // the most one run may spend, in USD (#649); absent, no cap
  busTools?: boolean;      // children get the read-only bus tools (#669); default off
  mirrorClaims?: boolean;  // subtasks' tree claims are also held on the bus (#675); needs busTools and a worktree or shared workdir; default off
  profiles: Profile[];     // named agent + tool lists a fleet runs under (#643)
  fleets: Fleet[];         // queue boards `<name>-tasks` the factory is a lane on, each with the agent (and policy) it runs; projects (#645) included, with their routes
  maxConcurrent: number;
  maxSubtasks: number;     // the most subtasks a fleet task's plan may fan out to
  timeoutMs: number;
  retentionMs: number;
  maxAsks: number;         // the most questions one request's runs may ask (#652)
  askEscalateMs: number;   // an unanswered question goes to your user after this long
  askGiveUpMs: number;     // and after this long more, the run resumes on its own judgement
  human?: string;          // who escalations go to; absent, the bus's first human
  limits: Limits;          // the whole factory's spend and time limits (#655); a fleet's or project's own sit on its Fleet
};

// A profile (#643): the agent, what its children may do and where they run
// (#641). Its tool lists, mode and repo fall back to the global ones field by field.
export type Profile = { name: string; agent: string; tools?: string[]; allowedTools?: string[]; budgetUsd?: number; busTools?: boolean; mirrorClaims?: boolean; workdir?: WorkdirMode; repo?: string };

// The fields a SIGHUP reload can't change: they shape the bus session, the
// runner or the worker pool, which live as long as the process.
const RESTART_ONLY = ["identity", "grayboard", "claude", "cwd", "maxConcurrent", "maxSubtasks", "timeoutMs", "retentionMs"] as const;

const DAY = 86_400_000;
const MAX_ROUNDS = 10;
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
  // A budget (#649): a positive number of dollars, fractions allowed.
  const usd = (v: unknown, what: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${path}: ${what} must be a positive number (USD)`);
    return v;
  };
  // Limits (#655), on the top level, a fleet or a project: each optional.
  const limitsIn = (o: Record<string, unknown>, what: string): Limits => {
    const at = (k: string) => (what ? `${what}: "${k}"` : `"${k}"`);
    const ms = (v: unknown, k: string) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${path}: ${at(k)} must be a positive integer`);
      return v;
    };
    const rounds = (v: unknown) => {
      if (ms(v, "maxRounds") > MAX_ROUNDS) throw new Error(`${path}: ${at("maxRounds")} must be at most ${MAX_ROUNDS}`);
      return v as number;
    };
    return {
      ...(o.treeBudgetUsd !== undefined ? { treeBudgetUsd: usd(o.treeBudgetUsd, at("treeBudgetUsd")) } : {}),
      ...(o.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: usd(o.dailyBudgetUsd, at("dailyBudgetUsd")) } : {}),
      ...(o.deadlineMs !== undefined ? { deadlineMs: ms(o.deadlineMs, "deadlineMs") } : {}),
      // Bounded so the digest's earlier rounds (a line per subtask) stay small (#658).
      ...(o.maxRounds !== undefined ? { maxRounds: rounds(o.maxRounds) } : {}),
    };
  };
  const withLimits = (f: Fleet, o: Record<string, unknown>, what: string): Fleet => {
    const l = limitsIn(o, what);
    return Object.keys(l).length ? { ...f, limits: l } : f;
  };
  const atLeast2 = (n: number) => { if (n < 2) throw new Error(`${path}: "maxSubtasks" must be at least 2`); return n; };
  const NAME = /^[a-z0-9_-]{1,26}$/;
  const list = (v: unknown, what: string) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error(`${path}: ${what} must be an array of non-empty strings`);
    return v as string[];
  };
  const tools = raw.tools !== undefined ? strs("tools", []) : undefined;
  const allowedTools = strs("allowedTools", DEFAULTS.allowedTools);
  const budgetUsd = raw.budgetUsd !== undefined ? usd(raw.budgetUsd, `"budgetUsd"`) : undefined;
  const bool = (v: unknown, what: string) => {
    if (typeof v !== "boolean") throw new Error(`${path}: ${what} must be true or false`);
    return v;
  };
  const busTools = raw.busTools !== undefined ? bool(raw.busTools, `"busTools"`) : false;
  const mirrorClaims = raw.mirrorClaims !== undefined ? bool(raw.mirrorClaims, `"mirrorClaims"`) : false;
  const global: Policy = { ...(tools ? { tools } : {}), allowedTools, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(busTools ? { busTools } : {}), ...(mirrorClaims ? { mirrorClaims } : {}) };
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
  // Mirrored claims (#675) ride on the tree claim tools, and name a
  // repository: a scratch directory has none another lane could share.
  const mirrorable = (m: boolean, bt: boolean, w: WorkdirMode, who: string) => {
    if (!m) return;
    if (!bt) throw new Error(`${path}: ${who}: "mirrorClaims" needs "busTools": the tree claims it mirrors are bus tools`);
    if (w === "scratch") throw new Error(`${path}: ${who}: "mirrorClaims" needs "workdir" "worktree" or "shared": a scratch directory is no repository other lanes edit`);
  };
  mirrorable(mirrorClaims, busTools, workdir.mode, "the global config");

  const rawProfiles = raw.profiles ?? [];
  if (!Array.isArray(rawProfiles)) throw new Error(`${path}: "profiles" must be an array of {name, agent, tools?, allowedTools?, budgetUsd?, busTools?, mirrorClaims?, workdir?, repo?}`);
  const profiles = new Map<string, Profile>();
  for (const p of rawProfiles as Record<string, unknown>[]) {
    if (typeof p !== "object" || p === null || typeof p.name !== "string" || !NAME.test(p.name)) throw new Error(`${path}: each profile's "name" must be 1-26 characters of a-z 0-9 _ -`);
    if (typeof p.agent !== "string" || !p.agent.trim()) throw new Error(`${path}: profile ${p.name}: "agent" must be a non-empty string`);
    if (profiles.has(p.name)) throw new Error(`${path}: profile ${p.name} is listed twice`);
    profiles.set(p.name, {
      name: p.name, agent: p.agent.trim(),
      ...(p.tools !== undefined ? { tools: list(p.tools, `profile ${p.name}: "tools"`) } : {}),
      ...(p.allowedTools !== undefined ? { allowedTools: list(p.allowedTools, `profile ${p.name}: "allowedTools"`) } : {}),
      ...(p.budgetUsd !== undefined ? { budgetUsd: usd(p.budgetUsd, `profile ${p.name}: "budgetUsd"`) } : {}),
      ...(p.busTools !== undefined ? { busTools: bool(p.busTools, `profile ${p.name}: "busTools"`) } : {}),
      ...(p.mirrorClaims !== undefined ? { mirrorClaims: bool(p.mirrorClaims, `profile ${p.name}: "mirrorClaims"`) } : {}),
      ...(p.workdir !== undefined ? { workdir: mode(p.workdir, `profile ${p.name}: "workdir"`) } : {}),
      ...(p.repo !== undefined ? { repo: repo(p.repo, `profile ${p.name}: "repo"`) } : {}),
    });
    const q = profiles.get(p.name)!;
    workdirOf(q.workdir ?? workdir.mode, q.repo ?? workdir.repo, `profile ${p.name}`); // a profile no fleet uses yet must still be runnable
    mirrorable(q.mirrorClaims ?? mirrorClaims, q.busTools ?? busTools, q.workdir ?? workdir.mode, `profile ${p.name}`);
  }

  // A profile as a route (#645): its agent, tool lists and working directory,
  // each falling back to the global one. `repoOver`: a project's repo, which
  // replaces the profile's.
  const routeOf = (p: Profile, repoOver?: string): Route => ({
    profile: p.name, agent: p.agent,
    policy: { ...(p.tools ? { tools: p.tools } : tools ? { tools } : {}), allowedTools: p.allowedTools ?? allowedTools, ...((p.budgetUsd ?? budgetUsd) !== undefined ? { budgetUsd: p.budgetUsd ?? budgetUsd } : {}), ...((p.busTools ?? busTools) ? { busTools: true } : {}), ...((p.mirrorClaims ?? mirrorClaims) ? { mirrorClaims: true } : {}) },
    workdir: workdirOf(p.workdir ?? workdir.mode, repoOver ?? p.repo ?? workdir.repo, `profile ${p.name}`),
  });
  const fromRoutes = (name: string, routes: Route[], fanout: { fanout?: boolean }): Fleet => {
    const lead = routes[0]!;
    return { name, agent: lead.agent, ...fanout, profile: lead.profile, policy: lead.policy, workdir: lead.workdir, routes };
  };

  const rawFleets = raw.fleets ?? [];
  if (!Array.isArray(rawFleets)) throw new Error(`${path}: "fleets" must be an array of {name, agent} or {name, profile}`);
  const fleets: Fleet[] = [];
  const fanoutOf = (f: Record<string, unknown>, what: string) => {
    if (f.fanout !== undefined && typeof f.fanout !== "boolean") throw new Error(`${path}: ${what} ${f.name}: "fanout" must be true or false`);
    return f.fanout === false ? { fanout: false } : {};
  };
  for (const f of rawFleets as Record<string, unknown>[]) {
    // The board name `<name>-tasks` must fit a board name: [a-z0-9_-], max 32.
    if (typeof f !== "object" || f === null || typeof f.name !== "string" || !NAME.test(f.name)) throw new Error(`${path}: each fleet's "name" must be 1-26 characters of a-z 0-9 _ -`);
    const fanout = fanoutOf(f, "fleet");
    if (fleets.some((x) => x.name === f.name)) throw new Error(`${path}: fleet ${f.name} is listed twice`);
    if (f.profile !== undefined) {
      // A profile carries the agent: naming both would leave one ignored.
      if (f.agent !== undefined) throw new Error(`${path}: fleet ${f.name}: give "profile" or "agent", not both`);
      const p = typeof f.profile === "string" ? profiles.get(f.profile) : undefined;
      if (!p) throw new Error(`${path}: fleet ${f.name}: "profile" must name a profile in "profiles"`);
      fleets.push(withLimits(fromRoutes(f.name, [routeOf(p)], fanout), f, `fleet ${f.name}`));
    } else {
      if (typeof f.agent !== "string" || !f.agent.trim()) throw new Error(`${path}: fleet ${f.name}: "agent" (or "profile") must be a non-empty string`);
      fleets.push(withLimits({ name: f.name, agent: f.agent.trim(), ...fanout }, f, `fleet ${f.name}`));
    }
  }

  // A project (#645): a fleet whose plans may route each subtask to one of
  // its profiles; the lead triages, runs unrouted subtasks and synthesizes.
  const rawProjects = raw.projects ?? [];
  if (!Array.isArray(rawProjects)) throw new Error(`${path}: "projects" must be an array of {name, lead, profiles, repo?, fanout?}`);
  for (const j of rawProjects as Record<string, unknown>[]) {
    if (typeof j !== "object" || j === null || typeof j.name !== "string" || !NAME.test(j.name)) throw new Error(`${path}: each project's "name" must be 1-26 characters of a-z 0-9 _ -`);
    if (fleets.some((x) => x.name === j.name)) throw new Error(`${path}: project ${j.name}: the name is already a fleet's or another project's (both get the board ${j.name}-tasks)`);
    const fanout = fanoutOf(j, "project");
    const names = list(j.profiles, `project ${j.name}: "profiles"`);
    if (names.length === 0) throw new Error(`${path}: project ${j.name}: "profiles" must name at least one profile`);
    if (new Set(names).size !== names.length) throw new Error(`${path}: project ${j.name}: "profiles" lists a profile twice`);
    for (const n of names) if (!profiles.has(n)) throw new Error(`${path}: project ${j.name}: profile ${n} isn't in "profiles"`);
    if (typeof j.lead !== "string" || !names.includes(j.lead)) throw new Error(`${path}: project ${j.name}: "lead" must be one of its "profiles"`);
    const projRepo = j.repo !== undefined ? repo(j.repo, `project ${j.name}: "repo"`) : undefined;
    const ordered = [j.lead, ...names.filter((n) => n !== j.lead)];
    fleets.push(withLimits(fromRoutes(j.name, ordered.map((n) => routeOf(profiles.get(n)!, projRepo)), fanout), j, `project ${j.name}`));
  }
  const gb = env.FACTORY_GRAYBOARD?.trim() ? env.FACTORY_GRAYBOARD.trim().split(/\s+/) : strs("grayboard", ["grayboard"]);
  if (gb.length === 0) throw new Error(`${path}: "grayboard" must not be empty`);
  const identity = str("identity", DEFAULTS.identity);
  // A bus name (boards.md §3); anything else could never be bound.
  if (!/^[a-z0-9_-]{1,32}$/.test(identity)) throw new Error(`${path}: "identity" must be 1-32 characters of a-z 0-9 _ -`);
  const human = raw.human !== undefined ? str("human", "") : undefined;
  if (human !== undefined && !/^[a-z0-9_-]{1,32}$/.test(human)) throw new Error(`${path}: "human" must be a bus handle, 1-32 characters of a-z 0-9 _ -`);
  const limits = limitsIn(raw, "");
  const retentionMs = pos("retentionMs", DEFAULTS.retentionMs);
  // A daily cap sums the last 24 hours of runs: pruning them sooner would undercount.
  const daily = [...(limits.dailyBudgetUsd !== undefined ? ["the global config"] : []), ...fleets.filter((f) => f.limits?.dailyBudgetUsd !== undefined).map((f) => f.name)];
  if (daily.length && retentionMs < DAY) throw new Error(`${path}: "dailyBudgetUsd" (${daily.join(", ")}) needs "retentionMs" of at least ${DAY} (a day)`);
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
    retentionMs,
    maxAsks: pos("maxAsks", ASK_DEFAULTS.max),
    askEscalateMs: pos("askEscalateMs", ASK_DEFAULTS.escalateMs),
    askGiveUpMs: pos("askGiveUpMs", ASK_DEFAULTS.giveUpMs),
    ...(human !== undefined ? { human } : {}),
    limits,
  };
}

// Whether any daily cap is set, globally or on a fleet or project (#655).
export function hasDailyCap(c: Config): boolean {
  return c.limits.dailyBudgetUsd !== undefined || c.fleets.some((f) => f.limits?.dailyBudgetUsd !== undefined);
}

// The asking policy (#652): reloadable, and read when each clock is checked.
export function askOf(c: Config): AskPolicy {
  return { max: c.maxAsks, escalateMs: c.askEscalateMs, giveUpMs: c.askGiveUpMs, ...(c.human ? { human: c.human } : {}) };
}

// The global policy: delegations, and fleets without a profile.
export function policyOf(c: Config): Policy {
  return { ...(c.tools ? { tools: c.tools } : {}), allowedTools: c.allowedTools, ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}), ...(c.busTools ? { busTools: true } : {}), ...(c.mirrorClaims ? { mirrorClaims: true } : {}) };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const log = (m: string) => console.error(`[factory] ${m}`);
  const dataDir = resolve(env.FACTORY_DATA_DIR ?? join(env.HOME ?? homedir(), ".grayboard-factory"));
  const cfg = loadConfig(dataDir, env);
  mkdirSync(cfg.cwd, { recursive: true });
  const store = new Store(join(dataDir, "factory.db"));
  const runner = new ClaudeRunner({ bin: cfg.claude, cwd: cfg.cwd, env: sessionFree(env) });
  let bus: LocalBus;
  // The id a bus reader (#669) names to act under this session.
  const harnessSession = `factory-${randomUUID()}`;
  try {
    bus = await LocalBus.start({ command: cfg.grayboard, identity: cfg.identity, version: VERSION, env: sessionFree(env), harnessSession });
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    store.close();
    return 1;
  }
  log(`bound ${bus.handle}; ${runner.roster().length} ${runner.harness} agent(s) in ${runner.rosterSource}`);
  const workspaces = new Workspaces(join(dataDir, "trees"), cfg.cwd);
  // The bus tools' relay (#669): opens its socket and reader on the first run that has them.
  const childTools = new Relay({
    dir: join(dataDir, "relay"),
    shim: shimCommand(join(dataDir, "relay"), join(import.meta.dir, "relay_shim.ts")),
    reader: () => startReader({ command: cfg.grayboard, parentSession: harnessSession, identity: bus.handle, version: VERSION, env: sessionFree(env) }),
    claims: store,
    // Mirrored tree claims (#675): held on the bus under the factory's name.
    mirror: {
      async take(key, note) {
        const r = (await bus.call("claim_take", { key, ttl_minutes: MIRROR_TTL_MIN, ...(note ? { note } : {}) })) as { ok?: unknown; held_by?: unknown; note?: unknown; expires_at?: unknown };
        if (r?.ok === true) return null;
        if (typeof r?.held_by !== "string") throw new Error(`claim_take answered without ok or held_by`);
        return { holder: r.held_by, note: typeof r.note === "string" ? r.note : null, expiresAt: typeof r.expires_at === "number" ? r.expires_at : 0 };
      },
      async release(key) { await bus.call("claim_release", { key }); },
    },
    log,
  });
  const factory = new Factory(bus, store, runner, { childTools, fleets: cfg.fleets, policy: policyOf(cfg), workdir: cfg.workdir, ask: askOf(cfg), workspaces, runs: join(dataDir, "runs"), maxConcurrent: cfg.maxConcurrent, maxSubtasks: cfg.maxSubtasks, timeoutMs: cfg.timeoutMs, retentionMs: cfg.retentionMs, limits: cfg.limits, log });
  let signalled = false;
  const stop = () => { signalled = true; void bus.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // SIGHUP reloads the config (#645): fleets, projects, profiles, the
  // global tool lists and working directory, the asking policy (#652) and the limits (#655). A config that doesn't load
  // leaves the running one in place; the other fields need a restart.
  let reloads = Promise.resolve();
  const reload = () => {
    reloads = reloads.then(async () => {
      let next: Config;
      try { next = loadConfig(dataDir, env); } catch (e) {
        log(`reload refused, the running config stays: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const refused = reloadRefusal(cfg, next);
      if (refused) { log(`reload refused, the running config stays: ${refused}`); return; }
      const restart = RESTART_ONLY.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cfg[k]));
      if (restart.length) log(`reload: ${restart.join(", ")} changed, which takes a restart; the running values stay`);
      await factory.reconfigure({ fleets: next.fleets, policy: policyOf(next), workdir: next.workdir, ask: askOf(next), limits: next.limits });
      log(`reloaded: ${next.fleets.length} fleet(s) and project(s)`);
    }).catch((e) => log(`reload failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  process.on("SIGHUP", reload);
  const why = await factory.run();
  process.off("SIGHUP", reload);
  log(`stopping: ${why}`);
  await childTools.close();
  store.close();
  return signalled ? 0 : 1;
}

// Why a config that loads still can't be taken by a reload (#645), or null.
export function reloadRefusal(running: Config, next: Config): string | null {
  // retentionMs takes a restart, so a daily cap is checked against the running one.
  if (hasDailyCap(next) && running.retentionMs < DAY) return `"dailyBudgetUsd" needs a running "retentionMs" of at least ${DAY} (a day); restart to change it`;
  return null;
}

if (import.meta.main) process.exit(await main());
