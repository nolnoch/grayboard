// The factory module (#293, docs/factory.md): its parser and authority
// check, persona resolution, store, config, the run loop over a fake bus and
// runner, and the run loop over a real `grayboard mcp` child. The Claude
// runner against the pinned Claude Code is tests/e2e/factory_claude.e2e.ts:
// here it would make the pre-push hook fetch Claude Code (#456).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humansOf, LocalBus, sessionFree, toDelivery, type Delivery, type FactoryBus } from "../../adapters/factory/bus.ts";
import { parseDelegation, requestOf, type Request } from "../../adapters/factory/delegate.ts";
import { Database } from "bun:sqlite";
import { ASK_DEFAULTS, commandOf, Factory, type AskPolicy, type Fleet, type Limits, type Route } from "../../adapters/factory/factory.ts";
import { parsePlan, synthesisPrompt, triageInstruction } from "../../adapters/factory/fanout.ts";
import { askOf, DEFAULTS, hasDailyCap, loadConfig, policyOf } from "../../adapters/factory/main.ts";
import { parseAgent, readAgents, resolvePersona, type Agent, type Outcome, type Policy, type Resume, type Runner, type RunMeta } from "../../adapters/factory/runner.ts";
import { askInstruction, NO_ANSWER, NO_MORE, parseAsk } from "../../adapters/factory/ask.ts";
import { humanInstruction } from "../../src/core/tools.ts";
import { Store } from "../../adapters/factory/store.ts";
import { Workspaces, type Place, type Workdir } from "../../adapters/factory/workdir.ts";
import { repositoryGitEnv } from "../../scripts/hosted-evidence.ts";
import { delegationBody } from "../../src/core/delegation.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession } from "../support/mcp.ts";
import { CLI } from "../support/paths.ts";
import { until } from "../support/until.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "grayboard-factory-")); });
afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const brief = { requester: "sim", persona: "a researcher", task: "summarize ```code``` and\nnewlines", context: "see #293" };
const dm = (id: number, from: string, body: string): Delivery => ({ kind: "dm", id, from, body });

// ── parser and authority ─────────────────────────────────────────────────────

test("the parser reads the core's own delegation body, fences and newlines included", () => {
  expect(parseDelegation(delegationBody(brief))).toEqual(brief);
  const { context: _, ...noContext } = brief;
  expect(parseDelegation(delegationBody(noContext))).toEqual(noContext);
});

test("the parser refuses hostile and malformed shapes", () => {
  const good = delegationBody(brief);
  const cases = [
    "hello",                                                           // no header
    good.replace("[delegation request from ", "[delegation from "),    // wrong header
    good.replace("````json", "```json"),                               // three-backtick fence
    good.replace(/\n````\n/, "\n"),                                    // unclosed block
    good.replace('"task"', '"task" garbage'),                           // bad JSON
    "[delegation request from sim]\n````json\n[1,2]\n````",             // not an object
    "[delegation request from sim]\n````json\n{\"requester\":\"sim\",\"persona\":\" \",\"task\":\"t\"}\n````",   // blank persona
    "[delegation request from sim]\n````json\n{\"requester\":\"sim\",\"persona\":\"p\"}\n````",                   // no task
    "[delegation request from sim]\n````json\n{\"requester\":\"sim\",\"persona\":\"p\",\"task\":\"t\",\"context\":7}\n````", // context not a string
  ];
  for (const c of cases) expect(parseDelegation(c)).toBeNull();
});

test("a request counts only when the channel sender is the payload's requester", () => {
  const body = delegationBody(brief);
  expect(requestOf(dm(5, "sim", body))).toEqual({ request: { ...brief, id: 5, source: "dm" } });
  const forged = requestOf(dm(6, "mallory", body));
  expect(forged && "ignored" in forged && forged.ignored).toContain("mallory");
  expect(requestOf({ kind: "board", board: "e2e", from: "sim", body })).toBeNull();
  expect(requestOf(dm(7, "sim", "just chatting"))).toBeNull();
});

test("toDelivery reads grayboard's channel params and drops anything else", () => {
  expect(toDelivery({ content: "hi", meta: { message_id: "12", from: "sim", parent_id: "3" } })).toEqual({ kind: "dm", id: 12, from: "sim", parentId: 3, body: "hi" });
  expect(toDelivery({ content: "p", meta: { board: "e2e", post_id: "4", from: "be" } })).toEqual({ kind: "board", board: "e2e", postId: 4, from: "be", body: "p" });
  expect(toDelivery({ content: "r", meta: { board: "e2e", post_id: "5", parent_id: "4", from: "be", reason: "thread" } })).toMatchObject({ kind: "board", postId: 5, parentId: 4, reason: "thread" });
  expect(toDelivery({ content: "x", meta: { message_id: "abc", from: "sim" } })).toBeNull();
  expect(toDelivery({ meta: { message_id: "1", from: "sim" } })).toBeNull();
  expect(toDelivery(undefined)).toBeNull();
  // Your user's authority rides on human="true" (#651); nothing else sets it.
  expect(toDelivery({ content: "cancel", meta: { message_id: "13", from: "you", parent_id: "3", human: "true" } })).toEqual({ kind: "dm", id: 13, from: "you", parentId: 3, human: true, body: "cancel" });
  expect(toDelivery({ content: "c", meta: { board: "e2e", post_id: "6", from: "you", human: "true" } })).toMatchObject({ human: true });
  expect(toDelivery({ content: "c", meta: { board: "e2e", post_id: "6", from: "be", human: "yes" } })).not.toHaveProperty("human");
});

// ── roster and persona ───────────────────────────────────────────────────────

const agents = (...names: string[]): Agent[] => names.map((name) => ({ name, file: `/x/${name}.md`, prompt: "" }));

test("persona resolution: exact, article-free, whole word, substring; the longest name wins a rung", () => {
  const roster = agents("researcher", "senior researcher", "reviewer", "doc");
  expect(resolvePersona("Reviewer", roster)?.name).toBe("reviewer");
  expect(resolvePersona("a researcher", roster)?.name).toBe("researcher");
  expect(resolvePersona("the senior researcher for #293", roster)?.name).toBe("senior researcher");
  expect(resolvePersona("someone to write docs", roster)?.name).toBe("doc");     // substring rung
  expect(resolvePersona("a release manager", roster)).toBeNull();
  expect(resolvePersona("re.iewer", agents("re.iewer", "reviewer"))?.name).toBe("re.iewer"); // names are literal, not regexes
});

test("agent files: frontmatter name or filename; later directories override by name", () => {
  expect(parseAgent("/a/x.md", "no frontmatter")).toBeNull();
  expect(parseAgent("/a/x.md", "---\ndescription: d\n---\nbody")).toEqual({ file: "/a/x.md", name: "x", description: "d", prompt: "body" });
  // Only tools and model come through; a field like permissionMode is never read.
  expect(parseAgent("/a/x.md", "---\nname: x\ntools: Read, Grep\nmodel: haiku\npermissionMode: bypassPermissions\n---\n\nline one\nline two\n")).toEqual({ file: "/a/x.md", name: "x", prompt: "line one\nline two", tools: ["Read", "Grep"], model: "haiku" });
  expect(parseAgent("/a/x.md", "---\nname: \"Writer\"\n---\n")?.name).toBe("Writer");
  // An empty field is absent; it never takes the next line's value.
  expect(parseAgent("/a/x.md", "---\nname: x\ndescription:\nmodel: haiku\n---\nb")).toEqual({ file: "/a/x.md", name: "x", prompt: "b", model: "haiku" });
  const user = join(dir, "user"), project = join(dir, "project");
  mkdirSync(user); mkdirSync(project);
  writeFileSync(join(user, "a.md"), "---\nname: alpha\n---\n");
  writeFileSync(join(user, "b.md"), "---\nname: beta\n---\n");
  writeFileSync(join(project, "b2.md"), "---\nname: beta\n---\n");
  writeFileSync(join(project, "notes.txt"), "---\nname: gamma\n---\n");
  // Neither a dangling symlink nor a directory named *.md empties the roster.
  symlinkSync(join(dir, "gone.md"), join(project, "dangling.md"));
  mkdirSync(join(project, "folder.md"));
  const r = readAgents([user, project, join(dir, "missing")]);
  expect(r.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  expect(r.find((a) => a.name === "beta")!.file).toBe(join(project, "b2.md"));
});

// ── store ────────────────────────────────────────────────────────────────────

const req = (id: number, persona = "researcher"): Request => ({ id, source: "dm", requester: "sim", persona, task: `task ${id}` });
const k = (id: number) => ({ source: "dm" as const, id });

test("store: a message id is admitted once; queued rows run in arrival order", () => {
  const s = new Store(":memory:");
  expect(s.admit(req(2), "researcher")).toBe(true);
  expect(s.admit(req(2), "researcher")).toBe(false);
  expect(s.admitFinished(req(2), "declined")).toBe(false);
  expect(s.admit(req(1), "researcher")).toBe(true);
  expect(s.queuedAhead(k(1))).toBe(1);
  expect(s.next()!.id).toBe(2);
  expect(s.next()!.id).toBe(1);
  expect(s.next()).toBeNull();
  s.close();
});

test("store: a restart finishes running rows as interrupted, and unsent outcomes wait for their send", () => {
  const path = join(dir, "f.db");
  let s = new Store(path);
  s.admit(req(1), "researcher");
  s.admit(req(2), "researcher");
  s.next();
  s.close();
  s = new Store(path); // a restart
  const hit = s.interrupted((r) => `interrupted ${r.id}`);
  expect(hit.map((r) => r.id)).toEqual([1]);
  expect(s.unsent().map((r) => [r.id, r.reply])).toEqual([[1, "interrupted 1"]]);
  s.markReplied(k(1));
  expect(s.unsent()).toEqual([]);
  expect(s.get(k(2))!.state).toBe("queued");
  s.close();
});

test("store: a DM and a board post with the same id are separate requests; a post keeps its reply route", () => {
  const s = new Store(":memory:");
  const post: Request = { id: 2, source: "board", board: "sim-tasks", requester: "fe", persona: "researcher", task: "t" };
  expect(s.admit(req(2), "researcher")).toBe(true);
  expect(s.admit(post, "researcher")).toBe(true);
  expect(s.admit(post, "researcher")).toBe(false);
  expect(s.get(k(2))).toMatchObject({ source: "dm", requester: "sim" });
  expect(s.get({ source: "board", id: 2 })).toMatchObject({ source: "board", board: "sim-tasks", requester: "fe" });
  expect(s.queuedAhead({ source: "board", id: 2 })).toBe(1);
  expect([s.next()!.source, s.next()!.source]).toEqual(["dm", "board"]);
  s.close();
});

test("store: prune drops only replied rows past retention", () => {
  let t = 1_000;
  const s = new Store(":memory:", () => t);
  s.admitFinished(req(1), "a"); s.markReplied(k(1));
  s.admitFinished(req(2), "b");                    // unsent: kept
  t = 10_000;
  expect(s.prune(5_000)).toBe(1);
  expect(s.get(k(1))).toBeNull();
  expect(s.get(k(2))).not.toBeNull();
  s.close();
});

test("store: runs record each child, a restart ends open ones as interrupted, and prune drops a pruned request's runs (#649)", () => {
  let t = 1_000;
  const path = join(dir, "f.db");
  let s = new Store(path, () => t);
  s.admit(req(1), "researcher");
  const row = s.next()!;
  const a = s.startRun(row.seq, "researcher");
  expect(s.runs(row.seq)).toMatchObject([{ id: a, seq: row.seq, agent: "researcher", started_at: 1_000, ended_at: null, outcome: null }]);
  t = 2_000;
  s.endRun(a, "budget", { code: 1, session: "sess", turns: 3, costUsd: 0.25 });
  const b = s.startRun(row.seq, "researcher"); // a second run (a synthesis), cut by a crash
  expect(s.runs(row.seq)[0]).toMatchObject({ ended_at: 2_000, outcome: "budget", code: 1, session: "sess", turns: 3, cost_usd: 0.25 });
  s.close();
  t = 3_000;
  s = new Store(path, () => t); // a restart
  s.interrupted(() => "interrupted");
  expect(s.runs(row.seq).map((r) => [r.id, r.outcome, r.ended_at])).toEqual([[a, "budget", 2_000], [b, "interrupted", 3_000]]);
  expect(statSync(dir).mode & 0o777).toBe(0o700); // the data directory: tasks, replies, transcripts
  s.markReplied(k(1));
  s.admitFinished(req(2), "b"); s.markReplied(k(2));
  const c = s.startRun(s.get(k(2))!.seq, "b");
  t = 10_000;
  s.markReplied(k(2)); // touched later: kept
  expect(s.prune(5_000)).toBe(1);
  expect([s.hasRun(a), s.hasRun(b), s.hasRun(c)]).toEqual([false, false, true]);
  s.close();
});

// ── config and env ───────────────────────────────────────────────────────────

test("config: defaults, the file's fields, FACTORY_GRAYBOARD, and type errors", () => {
  const c = loadConfig(dir, { HOME: dir });
  expect(c).toMatchObject({ ...DEFAULTS, grayboard: ["grayboard"], cwd: join(dir, "work"), workdir: { mode: "scratch" } }); // never $HOME
  writeFileSync(join(dir, "config.json"), JSON.stringify({ identity: "fac", allowedTools: ["Read"], maxConcurrent: 4, cwd: "/srv/work" }));
  expect(loadConfig(dir, { FACTORY_GRAYBOARD: "bun src/cli/main.ts" })).toMatchObject({ identity: "fac", allowedTools: ["Read"], maxConcurrent: 4, cwd: "/srv/work", grayboard: ["bun", "src/cli/main.ts"] });
  expect(loadConfig(dir, {}).tools).toBeUndefined();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ tools: ["Bash", "Read"] }));
  expect(loadConfig(dir, {}).tools).toEqual(["Bash", "Read"]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ maxSubtasks: 3, fleets: [{ name: "a", agent: "x" }, { name: "b", agent: "y", fanout: false }] }));
  expect(loadConfig(dir, {})).toMatchObject({ maxSubtasks: 3, fleets: [{ name: "a", agent: "x" }, { name: "b", agent: "y", fanout: false }] });
  expect(loadConfig(dir, {}).fleets[0]).not.toHaveProperty("fanout");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ tools: ["Read"], allowedTools: ["Read"], profiles: [{ name: "code", agent: "coder", tools: ["Bash", "Read"], allowedTools: ["Bash"] }, { name: "research", agent: " researcher ", allowedTools: [] }], fleets: [{ name: "app", profile: "code" }, { name: "lab", profile: "research", fanout: false }, { name: "old", agent: "x" }] }));
  const pc = loadConfig(dir, {});
  expect(pc.profiles.map((p) => p.name)).toEqual(["code", "research"]);
  expect(pc.fleets).toEqual([
    { name: "app", agent: "coder", profile: "code", policy: { tools: ["Bash", "Read"], allowedTools: ["Bash"] }, workdir: { mode: "scratch" }, routes: [{ profile: "code", agent: "coder", policy: { tools: ["Bash", "Read"], allowedTools: ["Bash"] }, workdir: { mode: "scratch" } }] },
    { name: "lab", agent: "researcher", fanout: false, profile: "research", policy: { tools: ["Read"], allowedTools: [] }, workdir: { mode: "scratch" }, routes: [{ profile: "research", agent: "researcher", policy: { tools: ["Read"], allowedTools: [] }, workdir: { mode: "scratch" } }] }, // tools fall back to the global list, field by field
    { name: "old", agent: "x" }, // no profile: the global lists at run time
  ]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ budgetUsd: 2.5, profiles: [{ name: "cheap", agent: "x", budgetUsd: 0.5 }, { name: "std", agent: "y" }], fleets: [{ name: "a", profile: "cheap" }, { name: "b", profile: "std" }] }));
  const bc = loadConfig(dir, {});
  expect(policyOf(bc)).toEqual({ allowedTools: [], budgetUsd: 2.5 });
  expect(bc.fleets.map((f) => f.policy?.budgetUsd)).toEqual([0.5, 2.5]); // a profile's own, else the global one (#649)
  writeFileSync(join(dir, "config.json"), "{}");
  expect(policyOf(loadConfig(dir, {}))).toEqual({ allowedTools: [] }); // absent: no cap
  expect(askOf(loadConfig(dir, {}))).toEqual(ASK_DEFAULTS); // absent: the defaults, and the bus's first human (#652)
  writeFileSync(join(dir, "config.json"), JSON.stringify({ maxAsks: 1, askEscalateMs: 60_000, askGiveUpMs: 120_000, human: "ops" }));
  expect(askOf(loadConfig(dir, {}))).toEqual({ max: 1, escalateMs: 60_000, giveUpMs: 120_000, human: "ops" });
  for (const bad of [{ budgetUsd: 0 }, { budgetUsd: -1 }, { budgetUsd: "1" }, { budgetUsd: null }, { profiles: [{ name: "p", agent: "x", budgetUsd: 0 }] }, { maxSubtasks: 1 }, { fleets: [{ name: "a", agent: "x", fanout: "yes" }] },
    { profiles: [{ name: "p", agent: "x" }], fleets: [{ name: "a", profile: "p", agent: "x" }] }, { fleets: [{ name: "a", profile: "nope" }] },
    { profiles: [{ name: "p", agent: "x" }, { name: "p", agent: "y" }] }, { profiles: [{ name: "p" }] }, { profiles: [{ name: "P", agent: "x" }] },
    { profiles: [{ name: "p", agent: "x", tools: "Bash" }] }, { profiles: [{ name: "p", agent: "x", allowedTools: [""] }] }, { profiles: {} }, { tools: "Bash" }, { maxConcurrent: 0 }, { maxConcurrent: "2" }, { allowedTools: "Bash" }, { identity: "" }, { identity: "Factory" }, { maxConcurrent: null }, { cwd: null }, [1],
    { workdir: "tmp" }, { workdir: "worktree" }, { repo: "nope" }, { profiles: [{ name: "p", agent: "x", workdir: "worktree" }] }, { profiles: [{ name: "p", agent: "x", repo: 7 }] },
    { maxAsks: 0 }, { askEscalateMs: 1.5 }, { askGiveUpMs: "1h" }, { human: "" }, { human: "You" }, { human: null }]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir, {})).toThrow();
  }
});

test("child envs carry no session of the harness the factory was launched from", () => {
  const env = sessionFree({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", BUS_IDENTITY: "x", BUS_HARNESS_SESSION: "h", BUS_DB_PATH: "/d", BUS_SOCK_DIR: "/s", UNSET: undefined });
  expect(env).toEqual({ PATH: "/bin", BUS_DB_PATH: "/d", BUS_SOCK_DIR: "/s" });
});

// ── run loop over a fake bus and runner ──────────────────────────────────────

class FakeBus implements FactoryBus {
  readonly handle = "factory";
  humans: string[] = [];
  sent: { tool: string; args: Record<string, unknown> }[] = [];
  fail = false;
  refuse: (tool: string, args: Record<string, unknown>) => boolean = () => false; // a call that fails, as one send would
  boards: { name: string; kind: string; mode: string | null }[] = [];
  private nextPost = 1000;
  private nextMsg = 5000;
  delayMs = 0;
  private q: Delivery[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private settle!: (w: string) => void;
  readonly closed = new Promise<string>((ok) => (this.settle = ok));
  deliver(d: Delivery) { this.q.push(d); this.wake?.(); }
  async call(tool: string, args: Record<string, unknown> = {}) {
    if (this.fail || this.refuse(tool, args)) throw new Error("bus down");
    if (this.delayMs) await Bun.sleep(this.delayMs);
    this.sent.push({ tool, args });
    if (tool === "board_post") return { post_id: this.nextPost++ };
    if (tool === "dm_send") return { message_id: this.nextMsg++ };
    return tool === "board_list" ? this.boards : { ok: true };
  }
  async *deliveries() {
    for (;;) {
      const d = this.q.shift();
      if (d) { yield d; continue; }
      if (this.done) return;
      await new Promise<void>((ok) => (this.wake = ok));
    }
  }
  async close() { this.done = true; this.settle("closed"); this.wake?.(); }
  replies(id: number) { return this.sent.filter((s) => s.args.parent_id === id).map((s) => String(s.args.body)); }
  // The id the bus gave the nth reply (0-based) in `id`'s thread.
  replyId(id: number, n = 0) { let i = 0, mid = 5000, pid = 1000; for (const s of this.sent) { const own = s.tool === "dm_send" ? mid++ : s.tool === "board_post" ? pid++ : -1; if (s.args.parent_id === id && i++ === n) return own; } throw new Error(`no reply ${n} in ${id}'s thread`); }
  statuses() { return this.sent.filter((s) => s.tool === "peer_status").map((s) => String(s.args.text)); }
}

const GLOBAL: Policy = { allowedTools: ["Read"] };
const SHARED: Workdir = { mode: "shared" };
// The working-directory options: shared mode (today's single directory) unless a test picks another (#641).
// Transcripts go to dir/runs (#649).
const wd = (workdir: Workdir = SHARED) => ({ workdir, workspaces: new Workspaces(join(dir, "trees"), join(dir, "work")), runs: join(dir, "runs") });

class FakeRunner implements Runner {
  readonly harness = "fake";
  readonly rosterSource = "/fake/agents";
  runs: { agent: string; id: number }[] = [];
  policies: Policy[] = []; // each run's policy, in run order
  inputs: string[] = []; // each run's task text, in run order, less the ask instruction every run gets (#652)
  raw: string[] = []; // the same, as the runner got it
  resumes: (Resume | undefined)[] = []; // each run's resume (#652), in run order
  gates = new Map<number, PromiseWithResolvers<Outcome>>();
  // A run's text when it returns one (a plan, say); otherwise `result for <id>`.
  script: (r: Request) => string | undefined = () => undefined;
  broken = false; // roster() throws, as a filesystem error would
  abortLagMs = 0; // how long a held run takes to end once aborted, as a child's SIGTERM grace
  constructor(public names = ["researcher"], private readonly hold = false) {}
  roster() { if (this.broken) throw new Error("EIO: roster unreadable"); return agents(...this.names); }
  places: Place[] = []; // each run's place, in run order
  transcripts: string[] = []; // each run's transcript path, in run order; a run writes one line to it
  meta: (r: Request) => RunMeta | undefined = () => undefined; // what a run reports about itself (#649)
  run(agent: Agent, r: Request, signal: AbortSignal, policy: Policy, place: Place, transcript: string, resume?: Resume): Promise<Outcome> {
    this.runs.push({ agent: agent.name, id: r.id });
    this.policies.push(policy);
    this.places.push(place);
    const suffix = `\n\n${askInstruction()}`;
    this.raw.push(r.task);
    this.inputs.push(r.task.endsWith(suffix) ? r.task.slice(0, -suffix.length) : r.task);
    this.resumes.push(resume);
    this.transcripts.push(transcript);
    writeFileSync(transcript, `{"type":"result","id":${r.id}}\n`, { mode: 0o600 });
    const m = this.meta(r);
    if (m?.stop === "budget") return Promise.resolve({ ok: false, error: "stopped at its budget", run: m });
    if (!this.hold) return Promise.resolve({ ok: true, text: this.script(r) ?? `result for ${r.id}`, ...(m ? { run: m } : {}) });
    const g = Promise.withResolvers<Outcome>();
    this.gates.set(r.id, g);
    signal.addEventListener("abort", () => setTimeout(() => g.resolve({ ok: false, error: "aborted" }), this.abortLagMs));
    return g.promise;
  }
}

function loop(o: { runner?: FakeRunner; store?: Store; maxConcurrent?: number; timeoutMs?: number; fleets?: Fleet[]; bus?: FakeBus; workdir?: Workdir; ask?: AskPolicy; askTickMs?: number; limits?: Limits } = {}) {
  const bus = o.bus ?? new FakeBus(), runner = o.runner ?? new FakeRunner(), store = o.store ?? new Store(":memory:");
  const logs: string[] = [];
  const f = new Factory(bus, store, runner, { policy: GLOBAL, ...wd(o.workdir), fleets: o.fleets ?? [], maxConcurrent: o.maxConcurrent ?? 2, timeoutMs: o.timeoutMs ?? 60_000, retentionMs: 60_000, log: (m) => logs.push(m), ...(o.ask ? { ask: o.ask } : {}), ...(o.askTickMs ? { askTickMs: o.askTickMs } : {}), ...(o.limits ? { limits: o.limits } : {}) });
  const done = f.run();
  return { bus, runner, store, logs, done, f };
}
const ask = (id: number, persona = "a researcher", from = "sim") => dm(id, from, delegationBody({ requester: from, persona, task: `task ${id}` }));

test("loop: a request is acknowledged, run once, and answered in its thread", async () => {
  const { bus, runner, done } = loop();
  bus.deliver(ask(10));
  await until(() => bus.replies(10).length === 2, 5000, "ack and outcome");
  const [ack, out] = bus.replies(10);
  expect(ack).toStartWith("[factory] taken:");
  expect(ack).toContain("agent `researcher`, starting now");
  expect(out).toBe("[factory] done: fake agent `researcher`\n\nresult for 10");
  expect(bus.sent.filter((s) => s.tool !== "board_list" && s.tool !== "peer_status").every((s) => s.tool === "dm_send" && s.args.to === "sim")).toBe(true);
  bus.deliver(ask(10)); // a redelivery
  bus.deliver(ask(11, "a release manager"));
  await until(() => bus.replies(11).length === 1, 5000, "decline");
  expect(bus.replies(11)[0]).toStartWith('[factory] declined: no fake agent matches persona "a release manager" (roster: researcher;');
  expect(runner.runs).toEqual([{ agent: "researcher", id: 10 }]);
  expect(bus.replies(10)).toHaveLength(2);
  await bus.close();
  await done;
});

test("loop: a forged requester gets nothing, and the third party named gets nothing", async () => {
  const { bus, runner, logs, done } = loop();
  bus.deliver(dm(20, "mallory", delegationBody({ requester: "sim", persona: "researcher", task: "t" })));
  bus.deliver(ask(21));
  await until(() => bus.replies(21).length === 2, 5000, "the genuine request's outcome");
  expect(bus.replies(20)).toEqual([]);
  expect(runner.runs.map((r) => r.id)).toEqual([21]);
  expect(logs.some((l) => l.includes("message 20") && l.includes("mallory"))).toBe(true);
  await bus.close();
  await done;
});

test("loop: past maxConcurrent a request queues; a timeout stops its child and says so", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, done } = loop({ runner, maxConcurrent: 1, timeoutMs: 300 });
  bus.deliver(ask(30));
  bus.deliver(ask(31));
  await until(() => bus.replies(31).length === 1, 5000, "second ack");
  expect(bus.replies(31)[0]).toContain("queued, 0 ahead");
  await until(() => bus.replies(30).length === 2, 5000, "first times out");
  expect(bus.replies(30)[1]).toBe("[factory] failed: fake agent `researcher`: aborted");
  await until(() => runner.gates.has(31), 5000, "second starts");
  runner.gates.get(31)!.resolve({ ok: true, text: "fine" });
  await until(() => bus.replies(31).length === 2, 5000, "second outcome");
  await bus.close();
  await done;
});

test("loop: an outcome whose send failed is sent on restart; a run cut by a crash is reported interrupted", async () => {
  const path = join(dir, "f.db");
  const a = loop({ store: new Store(path) });
  a.bus.deliver(ask(40));
  await until(() => a.store.get(k(40))?.state === "finished", 5000, "first run finishes");
  await a.bus.close();
  await a.done;
  const s = new Store(path);
  // Simulate: 40's reply never sent, 41 running when the process died.
  s.admit(req(41), "researcher"); s.next();
  (s as unknown as { db: { exec(q: string): void } }).db.exec("UPDATE requests SET replied = 0 WHERE id = 40");
  const b = loop({ store: s });
  await until(() => b.bus.replies(40).length === 1 && b.bus.replies(41).length === 1, 5000, "resend and interrupted");
  expect(b.bus.replies(40)[0]).toContain("result for 40");
  expect(b.bus.replies(41)[0]).toStartWith("[factory] interrupted:");
  expect(b.runner.runs).toEqual([]);
  await b.bus.close();
  await b.done;
});

test("loop: a restart mid fan-out interrupts only the running subtask, runs the queued one and synthesizes (#642)", async () => {
  const s = new Store(":memory:");
  const sub = (id: number): { r: Request; title: string } => ({ r: { id, source: "board", board: "task-7", requester: "fe", persona: "sim", task: `part ${id}` }, title: `t${id}` });
  s.admit({ id: 7, source: "board", board: "sim-tasks", requester: "fe", persona: "sim", task: "big" }, "researcher", { fanout: true });
  s.fanOut(s.next()!, "task-7", [sub(100), sub(101)]);
  s.next(); // 100 was running when the process died; 101 never started
  const { bus, runner, done } = loop({ store: s, fleets: [{ name: "sim", agent: "researcher" }] });
  await until(() => bus.replies(7).length === 1, 5000, "synthesis");
  expect(bus.replies(100)).toEqual(["[factory] interrupted: the factory stopped before this finished; nothing is running for it now. The task's combined result will say this subtask was interrupted."]);
  expect(bus.replies(101)).toEqual(["[factory] done: fake agent `researcher`\n\nresult for 101"]);
  expect(bus.replies(7)[0]).toStartWith("[factory] done: fake agent `researcher`, combining 2 subtasks on #task-7");
  expect(runner.runs.map((r) => r.id)).toEqual([101, 7]);
  await bus.close();
  await done;
});

test("loop: each run gets a row with what it reported, and a 0600 transcript in a 0700 directory; a budget stop is recorded as one (#649)", async () => {
  const runner = new FakeRunner();
  runner.meta = (r) => r.id === 81 ? { code: 1, turns: 2, costUsd: 0.5, stop: "budget" } : { code: 0, session: "s80", turns: 4, costUsd: 0.125 };
  const { bus, store, logs, done } = loop({ runner });
  bus.deliver(ask(80));
  await until(() => bus.replies(80).length === 2, 5000, "80 answered");
  bus.deliver(ask(81));
  await until(() => bus.replies(81).length === 2, 5000, "81 answered");
  expect(bus.replies(81)[1]).toStartWith("[factory] failed:");
  expect(bus.replies(81)[1]).toContain("stopped at its budget");
  const r80 = store.runs(store.get(k(80))!.seq), r81 = store.runs(store.get(k(81))!.seq);
  expect(r80).toMatchObject([{ agent: "researcher", outcome: "ok", code: 0, session: "s80", turns: 4, cost_usd: 0.125 }]);
  expect(r81).toMatchObject([{ outcome: "budget", code: 1, turns: 2, cost_usd: 0.5 }]);
  expect(runner.transcripts).toEqual([join(dir, "runs", `${r80[0]!.id}.jsonl`), join(dir, "runs", `${r81[0]!.id}.jsonl`)]);
  expect(statSync(join(dir, "runs")).mode & 0o777).toBe(0o700);
  expect(statSync(runner.transcripts[0]!).mode & 0o777).toBe(0o600);
  expect(logs).toContain(`request 80: run ${r80[0]!.id} ended ok, 4 turn(s), $0.1250`);
  await bus.close();
  await done;
});

test("loop: housekeeping removes the transcripts of pruned runs and leaves other files alone (#649)", async () => {
  let t = 1_000;
  const bus = new FakeBus(), store = new Store(":memory:", () => t), runner = new FakeRunner();
  const f = new Factory(bus, store, runner, { policy: GLOBAL, ...wd(), maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 5_000, housekeepingMs: 20, log: () => {} });
  writeFileSync(join(dir, "runs", "notes.txt"), "mine");
  const done = f.run();
  bus.deliver(ask(90));
  await until(() => store.get(k(90))?.replied, 5000, "90 answered");
  expect(readdirSync(join(dir, "runs")).sort()).toEqual(["1.jsonl", "notes.txt"]);
  t = 100_000; // past retention: the row, its run and then its transcript go
  await until(() => !existsSync(join(dir, "runs", "1.jsonl")), 5000, "transcript swept");
  expect(store.get(k(90))).toBeNull();
  expect(readdirSync(join(dir, "runs"))).toEqual(["notes.txt"]);
  await bus.close();
  await done;
});

test("loop: a failed send stays unsent and housekeeping retries it", async () => {
  const bus = new FakeBus(), store = new Store(":memory:");
  const f = new Factory(bus, store, new FakeRunner(), { policy: GLOBAL, ...wd(), maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, housekeepingMs: 100, log: () => {} });
  const done = f.run();
  bus.fail = true;
  bus.deliver(ask(50));
  await until(() => store.get(k(50))?.state === "finished", 5000, "run finishes");
  expect(store.get(k(50))!.replied).toBe(false);
  bus.fail = false;
  await until(() => store.get(k(50))?.replied, 5000, "housekeeping resend");
  expect(bus.replies(50).at(-1)).toContain("result for 50");
  await bus.close();
  await done;
});

test("loop: a throw while taking a delivery is logged and the loop takes the next", async () => {
  const runner = new FakeRunner();
  const { bus, store, logs, done } = loop({ runner });
  runner.broken = true;
  bus.deliver(ask(56)); // take() reads the roster
  await until(() => logs.some((l) => l.includes("couldn't take a delivery") && l.includes("EIO")), 5000, "take's throw logged");
  runner.broken = false;
  bus.deliver(ask(57));
  await until(() => bus.replies(57).length === 2, 5000, "the next request runs");
  expect(store.get(k(56))).toBeNull();
  await bus.close();
  await done;
});

test("loop: a run whose roster read throws finishes failed, not stuck running", async () => {
  const runner = new FakeRunner(["researcher"]);
  const store = new Store(":memory:");
  store.admit(req(60), "researcher"); // admitted before the roster broke
  runner.broken = true;
  const { bus, done } = loop({ runner, store });
  await until(() => store.get(k(60))?.state === "finished", 5000, "60 finishes");
  expect(store.get(k(60))!.reply).toStartWith("[factory] failed: the factory couldn't run this: EIO");
  await until(() => bus.replies(60).length === 1, 5000, "60 answered");
  await bus.close();
  await done;
});

test("loop: stopping waits for a running child's outcome before run() returns", async () => {
  const runner = new FakeRunner(["researcher"], true);
  runner.abortLagMs = 200;
  const { bus, store, done } = loop({ runner });
  bus.deliver(ask(65));
  await until(() => runner.gates.has(65), 5000, "run starts");
  await bus.close();
  await done;
  // Recorded before the caller closes the store; sent at the next start.
  expect(store.get(k(65))).toMatchObject({ state: "finished", reply: "[factory] failed: fake agent `researcher`: the factory stopped while this ran" });
});

test("loop: housekeeping never sends an outcome a send in flight is already sending", async () => {
  const bus = new FakeBus(), store = new Store(":memory:");
  const f = new Factory(bus, store, new FakeRunner(), { policy: GLOBAL, ...wd(), maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, housekeepingMs: 20, log: () => {} });
  const done = f.run();
  bus.delayMs = 300; // every send outlasts several housekeeping passes
  bus.deliver(ask(70));
  await until(() => store.get(k(70))?.replied, 5000, "sent");
  await Bun.sleep(200);
  expect(bus.replies(70).filter((b) => b.startsWith("[factory] done:"))).toHaveLength(1);
  await bus.close();
  await done;
});

// ── over a real grayboard mcp child ──────────────────────────────────────────

test("local bus: a delegate from a real session reaches the factory, which answers in the thread", async () => {
  const sim = await localSession(dir, "sim");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  expect(bus.handle).toBe("factory");
  const runner = new FakeRunner();
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { policy: GLOBAL, ...wd(), maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
  const done = f.run();
  // The factory is a launcher: delegate's auto-pick finds it.
  const peers = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
  expect(peers.find((p) => p.handle === "factory")?.launcher).toBe(true);
  // A forged request first: sim's DM naming another requester.
  await call(sim.c, "dm_send", { to: "factory", body: delegationBody({ requester: "be", persona: "researcher", task: "t" }) });
  const r = await call(sim.c, "delegate", { persona: "a researcher", task: "read the spec" });
  expect(r.to).toBe("factory");
  const thread = () => sim.pushes.filter((p) => p.meta.parent_id === String(r.message_id)).map((p) => p.content);
  await until(() => thread().length === 2, 15_000, "ack and outcome in sim's thread");
  expect(thread()[0]).toStartWith("[factory] taken:");
  expect(thread()[1]).toBe(`[factory] done: fake agent \`researcher\`\n\nresult for ${r.message_id}`);
  expect(runner.runs).toEqual([{ agent: "researcher", id: r.message_id }]);
  expect(sim.pushes.every((p) => p.meta.from === "factory")).toBe(true);
  expect(sim.pushes).toHaveLength(2); // nothing for the forged one
  await bus.close();
  expect(await done).toBe("closed");
}, 30_000);

test("local bus: a second factory on a live name refuses to start", async () => {
  const first = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  await expect(LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir })).rejects.toThrow("didn't bind factory");
  await first.close();
}, 30_000);

// ── fleets: the factory as a lane on queue boards ────────────────────────────

const task = (postId: number, o: { board?: string; reason?: string; parentId?: number; from?: string } = {}): Delivery =>
  ({ kind: "board", board: o.board ?? "sim-tasks", postId, from: o.from ?? "fe", reason: o.reason ?? "subscription", ...(o.parentId !== undefined ? { parentId: o.parentId } : {}), body: `do ${postId}` });

test("fleets: the sync creates a missing board as a queue, joins an existing queue, refuses a broadcast board, and leaves a queue no fleet uses", async () => {
  const bus = new FakeBus();
  bus.boards = [
    { name: "be-tasks", kind: "queue", mode: null },
    { name: "fe-tasks", kind: "broadcast", mode: "push" },
    { name: "old-tasks", kind: "queue", mode: "push" },
    { name: "e2e", kind: "broadcast", mode: "push" },
  ];
  const { runner, logs, done } = loop({ bus, fleets: [{ name: "sim", agent: "researcher" }, { name: "be", agent: "researcher" }, { name: "fe", agent: "researcher" }] });
  await until(() => bus.sent.some((c) => c.args.board === "old-tasks"), 5000, "sync");
  expect(bus.sent.filter((c) => c.tool !== "board_list" && c.tool !== "peer_status")).toEqual([
    { tool: "board_create", args: { name: "sim-tasks", purpose: expect.any(String), kind: "queue" } },
    { tool: "board_subscribe", args: { board: "be-tasks", mode: "push" } },
    { tool: "board_subscribe", args: { board: "old-tasks", mode: "off" } },
  ]);
  expect(logs.some((l) => l.includes("#fe-tasks exists as a broadcast board"))).toBe(true);
  // A post on the refused board is not a task.
  bus.deliver(task(5, { board: "fe-tasks" }));
  bus.deliver(task(6));
  await until(() => bus.replies(6).length === 2, 5000, "the sim task runs");
  expect(runner.runs).toEqual([{ agent: "researcher", id: 6 }]);
  await bus.close();
  await done;
});

test("fleets: a task is answered in its board thread, runs once on redelivery, and thread replies aren't tasks", async () => {
  const { bus, runner, done } = loop({ fleets: [{ name: "sim", agent: "researcher" }] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 2, 5000, "taken and done");
  const posts = bus.sent.filter((c) => c.args.parent_id === 7);
  expect(posts.every((c) => c.tool === "board_post" && c.args.board === "sim-tasks")).toBe(true);
  expect(bus.replies(7)[0]).toStartWith('[factory] taken: fleet "sim" runs as fake agent `researcher`, starting now.');
  expect(bus.replies(7)[1]).toBe("[factory] done: fake agent `researcher`\n\nresult for 7");
  bus.deliver(task(7));                     // a redelivery
  bus.deliver(task(8, { parentId: 7 }));    // chatter in the thread
  bus.deliver(task(9, { reason: "mention" })); // a direct @mention is a task too
  await until(() => bus.replies(9).length === 2, 5000, "the mention runs");
  expect(runner.runs).toEqual([{ agent: "researcher", id: 7 }, { agent: "researcher", id: 9 }]);
  expect(bus.replies(7)).toHaveLength(2);
  await bus.close();
  await done;
});

test("fleets: a task whose agent is missing passes its claim to the next lane; a mention, which has no claim, is declined", async () => {
  const { bus, runner, done } = loop({ fleets: [{ name: "sim", agent: "builder" }] });
  bus.deliver(task(11));
  bus.deliver(task(12, { reason: "mention" }));
  await until(() => bus.replies(12).length === 1, 5000, "decline");
  await until(() => bus.sent.some((c) => c.tool === "claim_release"), 5000, "release");
  expect(bus.sent.find((c) => c.tool === "claim_release")!.args).toEqual({ key: "queue:sim-tasks:11", note: expect.stringContaining("`builder` isn't in the fake roster") });
  expect(bus.replies(11)).toEqual([]);
  expect(bus.replies(12)[0]).toStartWith('[factory] declined: fleet "sim"\'s agent `builder` isn\'t in the fake roster');
  expect(runner.runs).toEqual([]);
  await bus.close();
  await done;
});

test("local bus: a fleet task posted on the queue board is run by the factory lane and answered in its thread; the reply acks the claim", async () => {
  const fe = await localSession(dir, "fe");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  const runner = new FakeRunner();
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { policy: GLOBAL, ...wd(), fleets: [{ name: "sim", agent: "researcher" }], maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
  const done = f.run();
  await until(async () => ((await call(fe.c, "board_list")) as { name: string }[]).some((b) => b.name === "sim-tasks"), 15_000, "the factory creates its fleet board");
  const p = await call(fe.c, "board_post", { board: "sim-tasks", body: "summarize the spec" });
  const thread = () => fe.pushes.filter((x) => x.meta.parent_id === String(p.post_id)).map((x) => x.content);
  await until(() => thread().length === 2, 15_000, "taken and done in fe's thread");
  expect(thread()[0]).toStartWith('[factory] taken: fleet "sim"');
  expect(thread()[1]).toBe(`[factory] done: fake agent \`researcher\`\n\nresult for ${p.post_id}`);
  expect(runner.runs).toEqual([{ agent: "researcher", id: p.post_id }]);
  expect(await call(fe.c, "claim_list", { prefix: "queue:" })).toEqual([]);
  await bus.close();
  expect(await done).toBe("closed");
}, 30_000);

test("local bus: a factory without the fleet's agent passes the task to another lane", async () => {
  const fe = await localSession(dir, "fe"), be = await localSession(dir, "be");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  const runner = new FakeRunner();
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { policy: GLOBAL, ...wd(), fleets: [{ name: "sim", agent: "builder" }], maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
  const done = f.run();
  await until(async () => ((await call(fe.c, "board_list")) as { name: string }[]).some((b) => b.name === "sim-tasks"), 15_000, "the factory creates its fleet board");
  // The rotation offers never-woken lanes first, by handle: the first post
  // goes to be, the second to the factory, which passes it on to be. Had the
  // factory kept it, its claim would name the factory.
  await call(be.c, "board_subscribe", { board: "sim-tasks", mode: "push" });
  const first = await call(fe.c, "board_post", { board: "sim-tasks", body: "one" });
  const second = await call(fe.c, "board_post", { board: "sim-tasks", body: "two" });
  const got = (id: number) => be.pushes.some((x) => x.meta.post_id === String(id));
  await until(() => got(first.post_id) && got(second.post_id), 15_000, "both tasks reach be: one by rotation, one passed on by the factory");
  expect(runner.runs).toEqual([]);
  const claims = (await call(be.c, "claim_list", { prefix: "queue:" })) as { key: string; holder: string }[];
  expect(claims.map((c) => [c.key, c.holder]).sort()).toEqual([[`queue:sim-tasks:${first.post_id}`, "be"], [`queue:sim-tasks:${second.post_id}`, "be"]]);
  await bus.close();
  expect(await done).toBe("closed");
}, 30_000);

// ── fan-out: a fleet task's run returns a plan ──────────────────────────────

const PLAN = (n = 2, extra = "") => `\`\`\`\`factory-plan\n${JSON.stringify({ subtasks: Array.from({ length: n }, (_, i) => ({ title: `part ${i + 1}`, task: `do part ${i + 1}` })) })}\n\`\`\`\`${extra}`;

test("fan-out: the plan parser finds a plan, refuses unusable ones, and reads a plain result as no plan", () => {
  expect(parsePlan("just the answer", 5)).toBeNull();
  expect(parsePlan("inline ````factory-plan\n{}\n````", 5)).toBeNull(); // a fence starts a line
  expect(parsePlan(PLAN(), 5)).toEqual({ subtasks: [{ title: "part 1", task: "do part 1" }, { title: "part 2", task: "do part 2" }] });
  expect(parsePlan(`Here is the format:\n\n${PLAN()}`, 5)).toBeNull(); // an answer quoting a plan isn't one
  expect(parsePlan(`  \n${PLAN()}\n`, 5)).not.toBeNull();
  expect(parsePlan('````factory-plan\n{"subtasks":[{"title":"a","task":"' + "x".repeat(70_000) + '"},{"title":"b","task":"y"}]}\n````', 5)).toContain("over 60 KiB");
  expect(parsePlan(PLAN(1), 5)).toContain("needs 2 to 5");
  expect(parsePlan(PLAN(6), 5)).toContain("needs 2 to 5");
  expect(parsePlan("````factory-plan\n{not json\n````", 5)).toBe("the plan isn't valid JSON");
  expect(parsePlan("````factory-plan\n{}\n", 5)).toBe("the plan block isn't closed");
  expect(parsePlan('````factory-plan\n{"subtasks":[{"title":"a","task":""},{"title":"b","task":"x"}]}\n````', 5)).toContain("subtask 1 needs");
  expect(parsePlan('````factory-plan\n{"subtasks":[{"title":"a\\nb","task":"```code```"},{"title":"c","task":"x"}]}\n````', 5)).toEqual({ subtasks: [{ title: "a b", task: "```code```" }, { title: "c", task: "x" }] });
  expect(triageInstruction(4)).toContain("2 to 4 independent parts");
  const big = synthesisPrompt("the task", [{ title: "a", reply: "x".repeat(20_000) }, { title: "b", reply: null }]);
  expect(big).toStartWith("the task\n");
  expect(big).toContain("(result truncated at 16384 characters)");
  expect(big).toContain("### 2. b\n\n(no outcome)");
});

test("store: a fan-out waits on its subtasks, synthesizes once they finish, and survives a restart", () => {
  const path = join(dir, "f.db");
  let s = new Store(path);
  const parent: Request = { id: 7, source: "board", board: "sim-tasks", requester: "fe", persona: "sim", task: "big" };
  const sub = (id: number): { r: Request; title: string } => ({ r: { id, source: "board", board: "task-7", requester: "fe", persona: "sim", task: `part ${id}` }, title: `t${id}` });
  s.admit(parent, "researcher", { fanout: true });
  const row = s.next()!;
  expect(row).toMatchObject({ fanout: true, phase: "run", parent: null });
  s.fanOut(row, "task-7", [sub(100), sub(101)]);
  expect(s.get({ source: "board", id: 7 })).toMatchObject({ state: "waiting", fanoutBoard: "task-7" });
  expect(s.subtasks(row.seq).map((r) => [r.id, r.title, r.fanout, r.agent])).toEqual([[100, "t100", false, "researcher"], [101, "t101", false, "researcher"]]);
  const a = s.next()!;
  s.finish(a, "done 100");
  expect(s.synthesizeWhenDone(row.seq)).toBe(false);
  s.close();
  s = new Store(path); // a crash with one subtask finished, one queued (#642)
  expect(s.interrupted(() => "interrupted")).toEqual([]);
  expect(s.get({ source: "board", id: 7 })).toMatchObject({ state: "waiting" });
  const b = s.next()!;
  expect(b).toMatchObject({ id: 101, state: "running" });
  s.close();
  s = new Store(path); // another crash, the last subtask running: it's interrupted, and the parent synthesizes
  expect(s.interrupted((r) => `interrupted ${r.id}`).map((r) => r.id)).toEqual([101]);
  expect(s.subtasks(row.seq).map((r) => r.reply)).toEqual(["done 100", "interrupted 101"]);
  expect(s.next()).toMatchObject({ id: 7, phase: "synthesize", state: "running" });
  s.close();
  s = new Store(path); // a crash during the synthesis: the request itself is interrupted
  expect(s.interrupted(() => "interrupted").map((r) => r.id)).toEqual([7]);
  expect(s.next()).toBeNull();
  s.close();

  s = new Store(":memory:");
  s.admit(parent, "researcher", { fanout: true });
  const p2 = s.next()!;
  s.fanOut(p2, "task-7", [sub(100), sub(101)]);
  for (const r of [s.next()!, s.next()!]) s.finish(r, `done ${r.id}`);
  expect(s.synthesizeWhenDone(p2.seq)).toBe(true);
  expect(s.synthesizeWhenDone(p2.seq)).toBe(false); // once
  expect(s.next()).toMatchObject({ id: 7, phase: "synthesize", state: "running" });
  s.close();
});

test("fan-out: a plan opens a task board, runs each subtask once with its outcome in its thread, then synthesizes into the original thread", async () => {
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? PLAN() : undefined);
  const { bus, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher" }] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "taken, fanned out, done");
  const [taken, fanned, out] = bus.replies(7);
  expect(taken).toStartWith("[factory] taken:");
  expect(fanned).toBe("[factory] fanned out: 2 subtasks on #task-7, each run as `researcher` with its outcome in its thread. The combined result follows in this thread.");
  expect(out).toBe("[factory] done: fake agent `researcher`, combining 2 subtasks on #task-7\n\nresult for 7");
  const created = bus.sent.find((c) => c.tool === "board_create" && c.args.name === "task-7")!;
  expect(created.args.kind).toBeUndefined(); // broadcast: a record, not a queue
  expect(bus.sent.find((c) => c.tool === "board_subscribe" && c.args.board === "task-7")!.args.mode).toBe("off");
  const subPosts = bus.sent.filter((c) => c.tool === "board_post" && c.args.board === "task-7" && c.args.parent_id === undefined).map((c) => c.args.body);
  expect(subPosts).toEqual(["[factory] subtask 1/2: part 1\n\ndo part 1", "[factory] subtask 2/2: part 2\n\ndo part 2"]);
  const [, s1, s2] = runner.runs.map((r) => r.id); // the subtasks' post ids (the fake bus numbers every post)
  expect(bus.replies(s1!)).toEqual([`[factory] done: fake agent \`researcher\`\n\nresult for ${s1}`]);
  expect(bus.replies(s2)).toEqual([`[factory] done: fake agent \`researcher\`\n\nresult for ${s2}`]);
  expect(runner.runs.map((r) => r.id)).toEqual([7, s1, s2, 7]);
  expect(runner.inputs[0]).toContain("## Before you start");          // the task's run may plan
  expect(runner.inputs[1]).toBe("do part 1");                          // a subtask's run may not
  expect(runner.inputs[3]).toContain(`### 1. part 1\n\n[factory] done: fake agent \`researcher\`\n\nresult for ${s1}`);
  expect(runner.inputs[3]).not.toContain("## Before you start");
  bus.deliver(task(7)); // a redelivery spawns nothing
  await bus.close();
  await done;
  expect(runner.runs).toHaveLength(4);
});

test("fan-out: an unusable plan fails the task; a fleet with fanout off never gets the instruction", async () => {
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 ? PLAN(9) : r.id === 8 ? PLAN() : undefined);
  const { bus, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher" }, { name: "solo", agent: "researcher", fanout: false }] });
  bus.deliver(task(7));
  bus.deliver(task(8, { board: "solo-tasks" }));
  await until(() => bus.replies(7).length === 2 && bus.replies(8).length === 2, 5000, "both outcomes");
  expect(bus.replies(7)[1]).toBe("[factory] failed: fake agent `researcher` returned a plan the factory can't use: the plan has 9 subtasks; it needs 2 to 5. Nothing was fanned out.");
  expect(bus.replies(8)[1]).toStartWith("[factory] done: fake agent `researcher`\n\n````factory-plan"); // just text, without fan-out
  expect(runner.inputs[1]).toBe("do 8");
  expect(bus.sent.some((c) => c.tool === "board_create" && String(c.args.name).startsWith("task-"))).toBe(false);
  await bus.close();
  await done;
});

test("local bus: a fan-out's subtasks and outcomes are posts on a task board other sessions can read", async () => {
  const fe = await localSession(dir, "fe");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  const runner = new FakeRunner();
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { policy: GLOBAL, ...wd(), fleets: [{ name: "sim", agent: "researcher" }], maxConcurrent: 2, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
  const done = f.run();
  await until(async () => ((await call(fe.c, "board_list")) as { name: string }[]).some((b) => b.name === "sim-tasks"), 15_000, "the factory creates its fleet board");
  const p = await call(fe.c, "board_post", { board: "sim-tasks", body: "summarize three specs" });
  runner.script = (r) => (r.id === p.post_id && !r.task.includes("## Subtask results") ? PLAN(3) : undefined);
  const thread = () => fe.pushes.filter((x) => x.meta.parent_id === String(p.post_id)).map((x) => x.content);
  await until(() => thread().length === 3, 15_000, "taken, fanned out and done in fe's thread");
  expect(thread()[1]).toContain(`3 subtasks on #task-${p.post_id}`);
  expect(thread()[2]).toStartWith(`[factory] done: fake agent \`researcher\`, combining 3 subtasks on #task-${p.post_id}`);
  const posts = (await call(fe.c, "board_read", { board: `task-${p.post_id}` })) as { posts?: { body: string; parent_id: number | null }[] } | { body: string; parent_id: number | null }[];
  const list = Array.isArray(posts) ? posts : posts.posts ?? [];
  expect(list.filter((x) => x.parent_id === null).map((x) => x.body.split("\n")[0])).toEqual(["[factory] subtask 1/3: part 1", "[factory] subtask 2/3: part 2", "[factory] subtask 3/3: part 3"]);
  expect(list.filter((x) => x.parent_id !== null && x.body.startsWith("[factory] done:"))).toHaveLength(3);
  expect(runner.runs).toHaveLength(5);
  await bus.close();
  expect(await done).toBe("closed");
}, 30_000);

test("profiles: a fleet task and its subtasks run under the fleet's policy, a delegation under the global one, and a fleet gone from the config runs nothing (#643)", async () => {
  const code: Policy = { tools: ["Bash", "Read"], allowedTools: ["Bash"] };
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? PLAN() : undefined);
  const fleets: Fleet[] = [{ name: "sim", agent: "researcher", profile: "code", policy: code }, { name: "old", agent: "researcher" }];
  const { bus, store, done } = loop({ runner, fleets });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "fan-out and synthesis");
  bus.deliver(task(50, { board: "old-tasks" }));
  await until(() => bus.replies(50).length === 2, 5000, "profile-less fleet task");
  bus.deliver(ask(60));
  await until(() => bus.replies(60).length === 2, 5000, "delegation");
  expect(runner.policies).toEqual([code, code, code, code, GLOBAL, GLOBAL]); // 7, its 2 subtasks, its synthesis; 50; 60
  // A queued task whose fleet left the config: no run, and it says why.
  store.admit({ id: 70, source: "board", board: "gone-tasks", requester: "fe", persona: "gone", task: "x" }, "researcher");
  bus.deliver(ask(61)); // pumps the queue
  await until(() => bus.replies(70).length === 1, 5000, "gone fleet fails");
  expect(bus.replies(70)[0]).toBe('[factory] failed: fleet "gone" is no longer in the factory\'s config; nothing was spawned.');
  expect(runner.runs.map((r) => r.id)).not.toContain(70);
  await bus.close();
  await done;
});

// ── working directories (#641) ───────────────────────────────────────────────

test("config: working-directory modes and repos fall back field by field (#641)", () => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ workdir: "shared", profiles: [{ name: "wt", agent: "coder", workdir: "worktree", repo: "repo" }, { name: "s", agent: "x", workdir: "scratch" }, { name: "inh", agent: "y" }], fleets: [{ name: "a", profile: "wt" }, { name: "b", profile: "s" }, { name: "c", profile: "inh" }, { name: "d", agent: "z" }] }));
  const c = loadConfig(dir, {});
  expect(c.workdir).toEqual({ mode: "shared" });
  expect(c.fleets.map((f) => f.workdir)).toEqual([{ mode: "worktree", repo }, { mode: "scratch" }, { mode: "shared" }, undefined]); // d: the global mode at run time
  writeFileSync(join(dir, "config.json"), JSON.stringify({ workdir: "worktree", repo: "repo", profiles: [{ name: "p", agent: "x" }], fleets: [{ name: "a", profile: "p" }] }));
  expect(loadConfig(dir, {})).toMatchObject({ workdir: { mode: "worktree", repo }, fleets: [{ workdir: { mode: "worktree", repo } }] });
});

test("workspaces: scratch gives a tree a directory, each subtask one inside it, synthesis all of them; sweep removes pruned trees (#641)", async () => {
  const ws = new Workspaces(join(dir, "trees"), join(dir, "work"));
  const scratch: Workdir = { mode: "scratch" };
  const tree = join(dir, "trees", "4");
  expect(await ws.place(scratch, { tree: 4, sub: null, synthesis: false })).toEqual({ cwd: join(tree, "main"), addDirs: [] });
  expect(await ws.place(scratch, { tree: 4, sub: 5, synthesis: false })).toEqual({ cwd: join(tree, "5"), addDirs: [] });
  expect(await ws.place(scratch, { tree: 4, sub: null, synthesis: true })).toEqual({ cwd: join(tree, "main"), addDirs: [tree] });
  expect(existsSync(join(tree, "5"))).toBe(true);
  expect(await ws.place(SHARED, { tree: 9, sub: null, synthesis: true })).toEqual({ cwd: join(dir, "work"), addDirs: [] });
  expect(existsSync(join(dir, "trees", "9"))).toBe(false);
  await ws.place(scratch, { tree: 6, sub: null, synthesis: false });
  mkdirSync(join(dir, "trees", "notes")); // not a tree: never touched
  expect(await ws.sweep((t) => t === 6)).toBe(1);
  expect([existsSync(tree), existsSync(join(dir, "trees", "6")), existsSync(join(dir, "trees", "notes"))]).toEqual([false, true, true]);
});

test("workspaces: worktree mode makes detached worktrees, a subtask's from its request's HEAD, and sweep has git forget them (#641)", async () => {
  const env = repositoryGitEnv();
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "a");
  const wt: Workdir = { mode: "worktree", repo };
  const ws = new Workspaces(join(dir, "trees"), join(dir, "work"));
  const main = await ws.place(wt, { tree: 3, sub: null, synthesis: false });
  expect(main.cwd).toBe(join(dir, "trees", "3", "main"));
  expect(readFileSync(join(main.cwd, "a.txt"), "utf8")).toBe("a\n");
  writeFileSync(join(main.cwd, "b.txt"), "b\n");
  git(main.cwd, "add", "b.txt");
  git(main.cwd, "commit", "-qm", "b"); // what the planning run committed
  const [s1, s2] = await Promise.all([ws.place(wt, { tree: 3, sub: 8, synthesis: false }), ws.place(wt, { tree: 3, sub: 9, synthesis: false })]);
  expect(git(s1.cwd, "rev-parse", "HEAD")).toBe(git(main.cwd, "rev-parse", "HEAD"));
  expect(existsSync(join(s2.cwd, "b.txt"))).toBe(true);
  expect(await ws.place(wt, { tree: 3, sub: null, synthesis: true })).toEqual({ cwd: main.cwd, addDirs: [join(dir, "trees", "3")] }); // a restart reuses it
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(4);
  expect(await ws.sweep(() => false)).toBe(1);
  expect(existsSync(join(dir, "trees", "3"))).toBe(false);
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  await expect(ws.place({ mode: "worktree", repo: join(dir, "work") }, { tree: 4, sub: null, synthesis: false })).rejects.toThrow("git rev-parse");
});

test("loop: scratch mode runs a fan-out's request, subtasks and synthesis in their tree, sweeps pruned trees, and a failed directory spawns nothing (#641)", async () => {
  mkdirSync(join(dir, "trees", "999"), { recursive: true }); // a tree whose request was pruned while the factory was down
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? PLAN() : undefined);
  const fleets: Fleet[] = [{ name: "sim", agent: "researcher" }, { name: "ro", agent: "researcher", workdir: SHARED }, { name: "bad", agent: "researcher", workdir: { mode: "worktree", repo: join(dir, "work") } }];
  const { bus, store, done } = loop({ runner, fleets, workdir: { mode: "scratch" } });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "fan-out and synthesis");
  const seq = store.get({ source: "board", id: 7 })!.seq, tree = join(dir, "trees", String(seq));
  const subs = store.subtasks(seq).map((s) => s.seq);
  expect(runner.places).toEqual([
    { cwd: join(tree, "main"), addDirs: [] },
    { cwd: join(tree, String(subs[0])), addDirs: [] },
    { cwd: join(tree, String(subs[1])), addDirs: [] },
    { cwd: join(tree, "main"), addDirs: [tree] },
  ]);
  expect(runner.inputs[0]).toContain("a working directory of its own");
  expect(runner.inputs[3]).toContain(`Its files: \`../${subs[0]}\``);
  expect(existsSync(join(dir, "trees", "999"))).toBe(false);
  bus.deliver(task(20, { board: "ro-tasks" }));
  await until(() => bus.replies(20).length === 2, 5000, "shared fleet task");
  expect(runner.places[4]).toEqual({ cwd: join(dir, "work"), addDirs: [] });
  expect(runner.inputs[4]).toContain("the same tools as you, your working directory");
  bus.deliver(task(30, { board: "bad-tasks" }));
  await until(() => bus.replies(30).length === 2, 5000, "worktree failure");
  expect(bus.replies(30)[1]).toStartWith("[factory] failed: couldn't make the worktree working directory: git rev-parse");
  expect(runner.runs.map((r) => r.id)).not.toContain(30);
  await bus.close();
  await done;
});

// ── projects (#645) ──────────────────────────────────────────────────────────

test("config: a project routes to its profiles, lead first; its repo replaces theirs; a bad one is refused (#645)", () => {
  const repo = join(dir, "repo"), other = join(dir, "other");
  mkdirSync(repo);
  mkdirSync(other);
  const profiles = [{ name: "lead", agent: "planner", tools: ["Read"] }, { name: "code", agent: "coder", tools: ["Bash", "Read"], allowedTools: ["Bash"], workdir: "worktree", repo: "other" }, { name: "docs", agent: "writer" }];
  writeFileSync(join(dir, "config.json"), JSON.stringify({ allowedTools: ["Read"], profiles, projects: [{ name: "app", lead: "lead", profiles: ["code", "lead"], repo: "repo", fanout: false }], fleets: [{ name: "d", profile: "docs" }] }));
  const c = loadConfig(dir, {});
  const lead: Route = { profile: "lead", agent: "planner", policy: { tools: ["Read"], allowedTools: ["Read"] }, workdir: { mode: "scratch", repo } };
  const code: Route = { profile: "code", agent: "coder", policy: { tools: ["Bash", "Read"], allowedTools: ["Bash"] }, workdir: { mode: "worktree", repo } }; // the project's repo, not the profile's
  expect(c.fleets).toEqual([
    { name: "d", agent: "writer", profile: "docs", policy: { allowedTools: ["Read"] }, workdir: { mode: "scratch" }, routes: [{ profile: "docs", agent: "writer", policy: { allowedTools: ["Read"] }, workdir: { mode: "scratch" } }] },
    { name: "app", agent: "planner", fanout: false, profile: "lead", policy: lead.policy, workdir: lead.workdir, routes: [lead, code] },
  ]);
  for (const bad of [
    { profiles, projects: [{ name: "d", lead: "lead", profiles: ["lead"] }], fleets: [{ name: "d", agent: "x" }] }, // the fleet's board
    { profiles, projects: [{ name: "a", lead: "lead", profiles: ["lead"] }, { name: "a", lead: "lead", profiles: ["lead"] }] },
    { profiles, projects: [{ name: "a", lead: "docs", profiles: ["lead"] }] },
    { profiles, projects: [{ name: "a", profiles: ["lead"] }] },
    { profiles, projects: [{ name: "a", lead: "lead", profiles: ["lead", "nope"] }] },
    { profiles, projects: [{ name: "a", lead: "lead", profiles: [] }] },
    { profiles, projects: [{ name: "a", lead: "lead", profiles: ["lead", "lead"] }] },
    { profiles, projects: [{ name: "a", lead: "lead", profiles: ["lead"], repo: "nope" }] },
    { profiles, projects: [{ name: "a", lead: "lead", profiles: ["lead"], fanout: 1 }] },
    { profiles, projects: [{ name: "A", lead: "lead", profiles: ["lead"] }] },
    { profiles, projects: {} },
  ]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir, {})).toThrow();
  }
});

const LEAD: Policy = { tools: ["Read"], allowedTools: ["Read"] };
const CODE: Policy = { tools: ["Bash", "Read"], allowedTools: ["Bash"] };
const project = (routes: Route[] = [{ profile: "lead", agent: "researcher", policy: LEAD, workdir: SHARED }, { profile: "code", agent: "coder", policy: CODE, workdir: SHARED }]): Fleet =>
  ({ name: "sim", agent: routes[0]!.agent, profile: routes[0]!.profile, policy: routes[0]!.policy, workdir: routes[0]!.workdir, routes });
const ROUTED = (subtasks: { title: string; task: string; profile?: string }[]) => `\`\`\`\`factory-plan\n${JSON.stringify({ subtasks })}\n\`\`\`\``;

test("projects: the lead's triage lists the profiles; a routed subtask runs as its profile's agent under its policy, an unrouted one as the lead (#645)", async () => {
  const runner = new FakeRunner(["researcher", "coder"]);
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? ROUTED([{ title: "a", task: "do a", profile: "code" }, { title: "b", task: "do b" }]) : undefined);
  const { bus, done } = loop({ runner, fleets: [project()] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "taken, fanned out, done");
  expect(runner.inputs[0]).toContain('"profile" picks who runs a subtask; without it, `lead` does.');
  expect(runner.inputs[0]).toContain("`code` (agent coder; tools: Bash, Read)");
  expect(bus.replies(7)[1]).toContain("each run as its profile's agent");
  const subPosts = bus.sent.filter((c) => c.tool === "board_post" && c.args.board === "task-7" && c.args.parent_id === undefined).map((c) => c.args.body);
  expect(subPosts).toEqual(["[factory] subtask 1/2 (code): a\n\ndo a", "[factory] subtask 2/2: b\n\ndo b"]);
  const byTask = new Map(runner.inputs.map((t, i) => [t, { agent: runner.runs[i]!.agent, policy: runner.policies[i] }]));
  expect(byTask.get("do a")).toEqual({ agent: "coder", policy: CODE });
  expect(byTask.get("do b")).toEqual({ agent: "researcher", policy: LEAD });
  const s1 = runner.runs.find((r) => r.agent === "coder")!.id;
  expect(bus.replies(s1)).toEqual([`[factory] done: fake agent \`coder\`\n\nresult for ${s1}`]);
  expect(runner.runs.at(-1)).toEqual({ agent: "researcher", id: 7 }); // the lead synthesizes
  await bus.close();
  await done;
});

test("projects: a plan naming a profile outside the project fails with nothing posted; a lone-profile fleet gets no routing text (#645)", async () => {
  const runner = new FakeRunner(["researcher", "coder"]);
  runner.script = (r) => (r.id === 7 ? ROUTED([{ title: "a", task: "do a", profile: "ops" }, { title: "b", task: "do b" }]) : undefined);
  const solo: Fleet = { name: "solo", agent: "researcher", profile: "lead", policy: LEAD, workdir: SHARED, routes: [{ profile: "lead", agent: "researcher", policy: LEAD, workdir: SHARED }] };
  const { bus, done } = loop({ runner, fleets: [project(), solo] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 2, 5000, "the failure");
  expect(bus.replies(7)[1]).toBe('[factory] failed: subtask 1 names profile "ops", which isn\'t one of sim\'s (lead, code). Nothing was fanned out.');
  expect(bus.sent.some((c) => c.tool === "board_create" && String(c.args.name).startsWith("task-"))).toBe(false);
  bus.deliver(task(8, { board: "solo-tasks" }));
  await until(() => bus.replies(8).length === 2, 5000, "solo task");
  expect(runner.inputs[1]).toContain("## Before you start");
  expect(runner.inputs[1]).not.toContain('"profile"');
  await bus.close();
  await done;
});

test("projects: a reload adds a fleet's board, and a queued subtask whose profile it removed fails without a run (#645)", async () => {
  const runner = new FakeRunner(["researcher", "coder"], true);
  const { bus, f, store, done } = loop({ runner, fleets: [project()], maxConcurrent: 1 });
  bus.deliver(task(7));
  await until(() => runner.gates.has(7), 5000, "the lead's run");
  runner.gates.get(7)!.resolve({ ok: true, text: ROUTED([{ title: "a", task: "do a" }, { title: "b", task: "do b", profile: "code" }]) });
  await until(() => runner.runs.length === 2, 5000, "subtask 1 running, subtask 2 queued");
  const subs = store.subtasks(store.get({ source: "board", id: 7 })!.seq);
  const s1 = subs.find((x) => x.profile === null)!.id, s2 = subs.find((x) => x.profile === "code")!.id;
  expect(runner.runs[1]!.id).toBe(s1);
  await f.reconfigure({ fleets: [project([{ profile: "lead", agent: "researcher", policy: LEAD, workdir: SHARED }]), { name: "new", agent: "researcher" }], policy: GLOBAL, workdir: SHARED });
  expect(bus.sent.some((c) => c.tool === "board_create" && c.args.name === "new-tasks" && c.args.kind === "queue")).toBe(true);
  runner.gates.get(s1)!.resolve({ ok: true, text: "a done" });
  await until(() => bus.replies(s2).length === 1, 5000, "the removed profile's subtask fails");
  expect(bus.replies(s2)[0]).toBe('[factory] failed: profile "code" is no longer one of sim\'s; nothing was spawned.');
  await until(() => runner.gates.has(7) && runner.runs.length === 3, 5000, "synthesis");
  expect(runner.runs.map((r) => r.agent)).toEqual(["researcher", "researcher", "researcher"]); // the coder never ran
  runner.gates.get(7)!.resolve({ ok: true, text: "combined" });
  await until(() => bus.replies(7).length === 3, 5000, "the combined result");
  await bus.close();
  await done;
});

test("store: a store written before projects opens with the profile column added, its rows unrouted (#645)", () => {
  const path = join(dir, "old.db");
  const db = new Database(path, { create: true, strict: true });
  db.exec(`CREATE TABLE requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, id INTEGER NOT NULL, board TEXT, requester TEXT NOT NULL, persona TEXT NOT NULL, task TEXT NOT NULL, context TEXT, agent TEXT NOT NULL, state TEXT NOT NULL, reply TEXT, replied INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'run', fanout INTEGER NOT NULL DEFAULT 0, parent INTEGER, title TEXT, fanout_board TEXT, UNIQUE (source, id))`);
  db.exec(`INSERT INTO requests (source, id, board, requester, persona, task, agent, state, created_at, updated_at) VALUES ('board', 5, 'sim-tasks', 'fe', 'sim', 'old task', 'researcher', 'queued', 1, 1)`);
  db.close();
  const store = new Store(path);
  expect(store.get({ source: "board", id: 5 })).toMatchObject({ task: "old task", profile: null });
  const parent = store.get({ source: "board", id: 5 })!;
  store.fanOut(parent, "task-5", [{ r: { source: "board", board: "task-5", id: 6, requester: "fe", persona: "sim", task: "t" }, title: "t", profile: "code", agent: "coder" }]);
  expect(store.get({ source: "board", id: 6 })).toMatchObject({ profile: "code", agent: "coder", parent: parent.seq });
  store.close();
});

// ── thread commands (#651) ───────────────────────────────────────────────────

test("commands: the whole body, leading @mentions, case and trailing punctuation aside", () => {
  expect(["cancel", " Cancel.", "@factory cancel", "@factory, @be: STATUS?", "retry!"].map(commandOf)).toEqual(["cancel", "cancel", "cancel", "status", "retry"]);
  expect(["please cancel", "cancel it", "cancel\nnow", "", "@factory", "stat us"].map(commandOf)).toEqual([null, null, null, null, null, null]);
});

const reply = (id: number, parentId: number, body: string, from = "sim", human = false): Delivery => ({ kind: "dm", id, from, parentId, ...(human ? { human: true as const } : {}), body });

test("commands: status and cancel on a running delegation; a stranger is refused, a replay does nothing, retry runs it again in the command's thread", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, store, done } = loop({ runner });
  bus.deliver(ask(50));
  await until(() => runner.gates.has(50), 5000, "50 runs");
  const ack = bus.replyId(50);
  bus.deliver(reply(51, ack, "status", "mallory"));          // a DM thread is its parties' only
  bus.deliver(reply(52, 50, "@factory status"));             // on the request itself
  await until(() => bus.replies(52).length === 1 && bus.replies(51).length === 1, 5000, "status answers");
  expect(bus.replies(51)[0]).toBe("[factory] status: only sim, who asked for this, or your user can status it.");
  expect(bus.replies(52)[0]).toMatch(/^\[factory\] status: running: fake agent `researcher` for \d+s\. 0 runs finished so far\.$/);
  expect(bus.sent.find((s) => s.args.parent_id === 52)!.args.to).toBe("sim");
  bus.deliver(reply(53, ack, "cancel", "mallory"));
  await until(() => bus.replies(53).length === 1, 5000, "refusal");
  expect(runner.gates.has(50) && store.get(k(50))!.state).toBe("running");
  bus.deliver(reply(54, ack, "Cancel."));
  await until(() => bus.replies(50).length === 2, 5000, "cancelled");
  expect(bus.replies(50)[1]).toBe("[factory] cancelled: by sim while fake agent `researcher` ran.");
  expect(store.runs(store.get(k(50))!.seq).map((r) => r.outcome)).toEqual(["cancelled"]);
  bus.deliver(reply(54, ack, "cancel"));                     // a replay
  bus.deliver(reply(55, bus.replyId(50, 1), "cancel"));      // on the outcome: already finished
  await until(() => bus.replies(55).length === 1, 5000, "already finished");
  expect(bus.replies(55)[0]).toStartWith("[factory] cancel: this already finished");
  expect(bus.replies(54)).toEqual([]);
  bus.deliver(reply(56, ack, "retry", "you", true));       // your user may, from anywhere in the thread
  await until(() => runner.gates.has(56), 5000, "the retry runs");
  expect(store.get(k(56))).toMatchObject({ requester: "you", task: "task 50", persona: "a researcher" });
  runner.gates.get(56)!.resolve({ ok: true, text: "again" });
  await until(() => bus.replies(56).length === 2, 5000, "retry answered in its thread");
  expect(bus.replies(56)).toEqual([expect.stringMatching(/^\[factory\] taken:/), "[factory] done: fake agent `researcher`\n\nagain"]);
  expect(bus.sent.filter((s) => s.args.parent_id === 56).every((s) => s.args.to === "you")).toBe(true);
  expect(runner.runs.map((r) => r.id)).toEqual([50, 56]);
  expect(bus.statuses()).toEqual(["idle", "1 running, 0 queued", "idle", "1 running, 0 queued", "idle"]);
  await bus.close();
  await done;
});

test("commands: a queued request cancels without a run; retry while queued says cancel first", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, store, done } = loop({ runner, maxConcurrent: 1 });
  bus.deliver(ask(60));
  bus.deliver(ask(61));
  await until(() => bus.replies(61).length === 1 && runner.gates.has(60), 5000, "60 runs, 61 queued");
  bus.deliver(reply(62, 61, "status"));
  bus.deliver(reply(63, 61, "retry"));
  await until(() => bus.replies(62).length === 1 && bus.replies(63).length === 1, 5000, "answers");
  expect(bus.replies(62)[0]).toBe("[factory] status: queued, 0 ahead. 0 runs finished so far.");
  expect(bus.replies(63)[0]).toBe("[factory] retry: this is still queued; reply `cancel` first.");
  bus.deliver(reply(64, bus.replyId(61), "cancel"));
  await until(() => bus.replies(61).length === 2, 5000, "61 cancelled");
  expect(bus.replies(61)[1]).toBe("[factory] cancelled: by sim before it ran.");
  runner.gates.get(60)!.resolve({ ok: true, text: "fine" });
  await until(() => bus.replies(60).length === 2, 5000, "60 done");
  expect(runner.runs.map((r) => r.id)).toEqual([60]);
  expect(store.runs(store.get(k(61))!.seq)).toEqual([]);
  expect(bus.statuses()).toEqual(["idle", "1 running, 0 queued", "1 running, 1 queued", "1 running, 0 queued", "idle"]);
  await bus.close();
  await done;
});

test("commands: cancelling a fan-out stops its running subtask, finishes the queued one and never synthesizes; anyone on the board may ask status", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, store, done } = loop({ runner, maxConcurrent: 1, fleets: [{ name: "sim", agent: "researcher" }] });
  bus.deliver(task(7));
  await until(() => runner.gates.has(7), 5000, "triage runs");
  runner.gates.get(7)!.resolve({ ok: true, text: PLAN() });
  await until(() => bus.replies(7).length === 2 && runner.runs.length === 2, 5000, "fanned out, first subtask runs");
  const [s1, s2] = store.subtasks(store.get({ source: "board", id: 7 })!.seq).map((s) => s.id);
  const fanned = bus.replyId(7, 1);
  bus.deliver(task(70, { parentId: fanned, from: "be" }));                   // chatter, not a command
  bus.deliver({ ...task(71, { parentId: fanned, from: "be" }), body: "status" });
  bus.deliver({ ...task(72, { parentId: 7, from: "fe" }), body: "retry" });
  bus.deliver({ ...task(73, { board: "task-7", parentId: s1!, from: "fe" }), body: "cancel" }); // a subtask's thread takes none
  await until(() => bus.replies(71).length === 1 && bus.replies(72).length === 1, 5000, "answers");
  expect(bus.replies(71)[0]).toBe("[factory] status: fanned out on #task-7: 0 of 2 subtasks finished. 1 run finished so far: 0 turns, $0.0000.");
  expect(bus.replies(72)[0]).toBe("[factory] retry: this is still running its subtasks; reply `cancel` first.");
  expect(bus.sent.find((s) => s.args.parent_id === 71)!.args).toMatchObject({ board: "sim-tasks" });
  bus.deliver({ ...task(74, { parentId: fanned, from: "fe" }), body: "cancel" });
  await until(() => bus.replies(7).length === 3 && bus.replies(s1!).length === 1 && bus.replies(s2!).length === 1, 5000, "all cancelled");
  expect(bus.replies(7)[2]).toBe("[factory] cancelled: by fe after it fanned out on #task-7; its subtasks stop and nothing is combined.");
  expect(bus.replies(s1!)).toEqual(["[factory] cancelled: by fe while fake agent `researcher` ran."]);
  expect(bus.replies(s2!)).toEqual(["[factory] cancelled: by fe with the task it belongs to, before it ran."]);
  expect(bus.replies(70)).toEqual([]);
  expect(bus.replies(73)).toEqual([]);
  expect(runner.runs.map((r) => r.id)).toEqual([7, s1]);
  await until(() => bus.statuses().at(-1) === "idle", 5000, "idle");
  await bus.close();
  await done;
});

test("store: threads and commands map back to their request and go with it at prune (#651)", () => {
  let t = 1_000;
  const s = new Store(":memory:", () => t);
  s.admit(req(1), "researcher");
  const seq = s.get(k(1))!.seq;
  s.recordReply({ source: "dm", id: 900 }, seq);
  expect(s.threadOf("dm", 1)!.seq).toBe(seq);
  expect(s.threadOf("dm", 900)!.seq).toBe(seq);
  expect(s.threadOf("board", 900)).toBeNull();
  expect(s.command({ source: "dm", id: 901 }, seq)).toBe(true);
  expect(s.command({ source: "dm", id: 901 }, seq)).toBe(false);
  expect(s.cancel(seq, () => "c")).toMatchObject({ finished: [{ state: "finished", reply: "c" }], running: [] });
  expect(s.cancel(seq, () => "c")).toBeNull();
  s.markReplied(k(1));
  t = 10_000;
  expect(s.prune(5_000)).toBe(1);
  expect(s.threadOf("dm", 900)).toBeNull();
  expect(s.command({ source: "dm", id: 901 }, seq)).toBe(true); // its record went with the request
  s.close();
});

test("local bus: a status reply to the factory's ack wakes it and is answered in the command's thread; its peer_status shows its load (#651)", async () => {
  const fe = await localSession(dir, "fe");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  const runner = new FakeRunner(["researcher"], true);
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { policy: GLOBAL, ...wd(), fleets: [{ name: "sim", agent: "researcher" }], maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
  const done = f.run();
  await until(async () => ((await call(fe.c, "board_list")) as { name: string }[]).some((b) => b.name === "sim-tasks"), 15_000, "the factory creates its fleet board");
  const p = await call(fe.c, "board_post", { board: "sim-tasks", body: "summarize the spec" });
  const ack = await until(() => fe.pushes.find((x) => x.meta.parent_id === String(p.post_id)), 15_000, "taken");
  const status = async () => ((await call(fe.c, "peer_list")) as { peers: { handle: string; status?: string }[] }).peers.find((x) => x.handle === "factory")?.status;
  await until(async () => (await status()) === "1 running, 0 queued", 15_000, "load in peer_list");
  const cmd = await call(fe.c, "board_post", { board: "sim-tasks", body: "status", parent_id: Number(ack.meta.post_id) });
  const answer = await until(() => fe.pushes.find((x) => x.meta.parent_id === String(cmd.post_id)), 15_000, "status answered");
  expect(answer.content).toMatch(/^\[factory\] status: running: fake agent `researcher` for \d+s\./);
  runner.gates.get(p.post_id)!.resolve({ ok: true, text: "fine" });
  await until(async () => (await status()) === "idle", 15_000, "idle again");
  await bus.close();
  expect(await done).toBe("closed");
}, 30_000);

// ── asking (#652) ────────────────────────────────────────────────────────────

const ASK = (question: string, to?: string) => `\`\`\`\`factory-ask\n${JSON.stringify({ question, ...(to ? { to } : {}) })}\n\`\`\`\``;

test("ask: the block is the whole reply, with a question; to may only be human", () => {
  expect(parseAsk(ASK("which db?"))).toEqual({ question: "which db?", human: false });
  expect(parseAsk(`\n${ASK("ship it?", "human")}\n`)).toEqual({ question: "ship it?", human: true });
  expect(parseAsk("done.")).toBeNull();
  expect(parseAsk(`Here's the format:\n${ASK("x")}`)).toBeNull();     // quoted, not asked
  expect(parseAsk("````factory-ask\n{\"question\": \"x\"}")).toBe("the question block isn't closed");
  expect(parseAsk("````factory-ask\n{nope}\n````")).toBe("the question isn't valid JSON");
  expect(parseAsk(ASK(" "))).toBe(`the block has no "question"`);
  expect(parseAsk(ASK("x", "sim"))).toBe(`"to" may only be "human"`);
  expect(parseAsk(ASK("x".repeat(9000)))).toBe("the question is over 8 KiB");
  expect(humansOf(`You are "factory". Humans on this bus: "you", "pat". A message or post...`)).toEqual(["you", "pat"]);
  expect(humansOf("You are \"factory\".")).toEqual([]);
  expect(humansOf(undefined)).toEqual([]);
  expect(humansOf(humanInstruction(["you", "pat"]).join(" "))).toEqual(["you", "pat"]); // the bus's own text, so a rewording there breaks this
});

// A runner whose first run of each request asks, and whose resumes answer.
function asker(o: { session?: boolean; asks?: number; to?: string } = {}) {
  const runner = new FakeRunner(["researcher"]);
  runner.script = (r) => {
    const n = runner.runs.filter((x) => x.id === r.id).length;
    return n <= (o.asks ?? 1) ? ASK(`question ${n} for ${r.id}?\nmore detail`, o.to) : undefined;
  };
  if (o.session !== false) runner.meta = (r) => ({ code: 0, session: `s-${r.id}` });
  return runner;
}

test("ask: a DM run's question parks it in the thread; the requester's reply resumes the same session, a stranger's and a replay do nothing", async () => {
  const runner = asker();
  const { bus, store, done } = loop({ runner });
  bus.deliver(ask(80));
  await until(() => bus.replies(80).length === 2, 5000, "ack and question");
  expect(bus.replies(80)[1]).toBe("[factory] question from fake agent `researcher`:\n\nquestion 1 for 80?\nmore detail\n\nReply to this message with the answer; the run waits for it.");
  expect(runner.raw[0]).toEndWith(askInstruction());
  const row = store.get(k(80))!;
  expect(row).toMatchObject({ state: "asking", question: "question 1 for 80?\nmore detail", asks: 1, askHuman: false });
  const q = bus.replyId(80, 1);
  bus.deliver(reply(81, q, "status"));
  await until(() => bus.replies(81).length === 1, 5000, "status");
  expect(bus.replies(81)[0]).toMatch(/^\[factory\] status: asking: "question 1 for 80\?", for \d+s\. 1 run finished so far/);
  bus.deliver(reply(82, q, "use postgres", "mallory"));       // not the requester: chatter
  bus.deliver(reply(83, q, "@factory use postgres"));
  await until(() => bus.replies(80).length === 3, 5000, "resumed and done");
  expect(bus.replies(82)).toEqual([]);
  expect(bus.replies(83)).toEqual(["[factory] answered: the run resumes with it."]);
  expect(bus.replies(80)[2]).toBe("[factory] done: fake agent `researcher`\n\nresult for 80");
  expect(runner.resumes).toEqual([undefined, { session: "s-80", input: "The answer to your question, from sim:\n\nuse postgres\n\nContinue the task.", priorUsd: 0 }]);
  bus.deliver(reply(83, q, "@factory use postgres"));           // a replay
  bus.deliver(reply(84, q, "and mysql"));                       // nothing open now
  await until(() => bus.statuses().at(-1) === "idle", 5000, "idle");
  expect(runner.runs.length).toBe(2);
  expect(bus.replies(84)).toEqual([]);
  expect(store.runs(row.seq).map((r) => r.outcome)).toEqual(["ok", "ok"]);
  expect(bus.statuses()).toEqual(["idle", "1 running, 0 queued", "0 running, 0 queued, 1 asking", "1 running, 0 queued", "idle"]);
  await bus.close();
  await done;
});

test("ask: with no session to resume, a fresh run is told its question and the answer", async () => {
  const runner = asker({ session: false });
  const { bus, done } = loop({ runner });
  bus.deliver(ask(85));
  await until(() => bus.replies(85).length === 2, 5000, "question");
  bus.deliver(reply(86, 85, "42"));                             // on the request itself: its only open question
  await until(() => bus.replies(85).length === 3, 5000, "done");
  expect(runner.resumes).toEqual([undefined, undefined]);
  expect(runner.raw[1]).toStartWith(`task 85\n\n${askInstruction()}\n\n## Your earlier question`);
  expect(runner.raw[1]).toContain("question 1 for 85?\nmore detail\n\nThe answer to your question, from sim:\n\n42");
  await bus.close();
  await done;
});

test("ask: a subtask's question goes in its request's thread and parks only it; a reply there resumes it and the request synthesizes", async () => {
  const runner = new FakeRunner(["researcher"]);
  runner.meta = (r) => ({ code: 0, session: `s-${r.id}` });
  runner.script = (r) => r.id === 9 && runner.runs.filter((x) => x.id === 9).length === 1 ? PLAN()
    : r.task.startsWith("do part 1") && runner.runs.filter((x) => x.id === r.id).length === 1 ? ASK("which part?") : undefined;
  const { bus, store, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher" }] });
  bus.deliver(task(9));
  await until(() => bus.replies(9).length === 3, 5000, "ack, fan-out, question");
  expect(bus.replies(9)[2]).toBe("[factory] question for subtask \"part 1\" on #task-9 from fake agent `researcher`:\n\nwhich part?\n\nReply to this message with the answer; the run waits for it.");
  const root = store.get({ source: "board", id: 9 })!;
  const [s1] = store.subtasks(root.seq);
  expect(s1!.state).toBe("asking");
  expect(root.state).toBe("waiting");
  bus.deliver({ ...task(90, { parentId: 9, from: "be" }), body: "status" });
  await until(() => bus.replies(90).length === 1, 5000, "status");
  expect(bus.replies(90)[0]).toStartWith("[factory] status: fanned out on #task-9: 1 of 2 subtasks finished, 1 asking.");
  bus.deliver({ ...task(91, { parentId: 9, from: "be" }), body: "the first" });   // not the requester (fe)
  bus.deliver({ ...task(92, { parentId: bus.replyId(9, 2), from: "fe" }), body: "the first" });
  await until(() => bus.replies(9).length === 4, 5000, "answered and synthesized");
  expect(bus.replies(92)).toEqual(["[factory] answered for subtask \"part 1\" on #task-9: the run resumes with it."]);
  expect(bus.replies(91)).toEqual([]);
  expect(bus.replies(9)[3]).toStartWith("[factory] done: fake agent `researcher`, combining 2 subtasks on #task-9");
  expect(bus.replies(s1!.id)).toEqual(["[factory] done: fake agent `researcher`\n\nresult for " + s1!.id]);
  expect(runner.resumes.filter(Boolean)).toEqual([{ session: `s-${s1!.id}`, input: "The answer to your question, from fe:\n\nthe first\n\nContinue the task.", priorUsd: 0 }]);
  await bus.close();
  await done;
});

test("ask: unanswered, the question goes to your user once, then the run resumes on its own judgement", async () => {
  const runner = asker();
  const bus = new FakeBus();
  bus.humans = ["you"];
  const { store, done } = loop({ runner, bus, ask: { max: 3, escalateMs: 40, giveUpMs: 150 }, askTickMs: 10 });
  bus.deliver(ask(87));
  await until(() => bus.sent.some((s) => s.tool === "dm_send" && s.args.to === "you"), 5000, "escalated");
  const esc = bus.sent.filter((s) => s.args.to === "you");
  expect(esc.length).toBe(1);
  expect(esc[0]!.args.parent_id).toBeUndefined();
  expect(String(esc[0]!.args.body)).toMatch(/^\[factory\] sim's task \(a delegation by DM\) has waited \d+s for an answer from sim:\n\nquestion 1 for 87\?\nmore detail\n\nReply to this message with the answer\. With none in 0s, the run carries on with its own judgement\.$/);
  await until(() => bus.replies(87).length === 4, 5000, "gave up and finished");
  expect(bus.replies(87)[2]).toBe("[factory] no answer: the run carries on with its own judgement.");
  expect(bus.replies(87)[3]).toBe("[factory] done: fake agent `researcher`\n\nresult for 87");
  expect(runner.resumes[1]).toEqual({ session: "s-87", input: NO_ANSWER, priorUsd: 0 });
  expect(bus.sent.filter((s) => s.args.to === "you").length).toBe(1);
  expect(store.get(k(87))!.escalatedAt).not.toBeNull();
  await bus.close();
  await done;
});

test("ask: a question for your user reaches them at once, and their DM reply answers it", async () => {
  const runner = asker({ to: "human" });
  const bus = new FakeBus();
  bus.humans = ["pat", "you"];                                        // config `human` picks which declared one
  const { done } = loop({ runner, bus, ask: { ...ASK_DEFAULTS, human: "you" } });
  bus.deliver(ask(88));
  await until(() => bus.sent.some((s) => s.args.to === "you"), 5000, "sent to your user");
  expect(bus.replies(88)[1]).toContain(", for your user:");
  const esc = bus.sent.findIndex((s) => s.args.to === "you");
  const escId = 5000 + bus.sent.slice(0, esc).filter((s) => s.tool === "dm_send").length;
  expect(String(bus.sent[esc]!.args.body)).toStartWith("[factory] sim's task (a delegation by DM) asks you:\n\nquestion 1 for 88?");
  bus.deliver(reply(89, escId, "ship it", "pat"));                   // not your user, not the requester
  bus.deliver(reply(890, escId, "status", "you", true));            // your user's commands work there too
  bus.deliver(reply(891, escId, "ship it", "you", true));
  await until(() => bus.replies(88).length === 3, 5000, "done");
  expect(bus.replies(891)).toEqual(["[factory] answered: the run resumes with it."]);
  expect(bus.sent.find((s) => s.args.parent_id === 891)!.args.to).toBe("you");
  expect(bus.replies(89)).toEqual([]);
  expect(bus.replies(890)[0]).toStartWith(`[factory] status: asking your user: "question 1 for 88?", for `);
  expect(runner.resumes[1]!.input).toContain("from you:\n\nship it");
  bus.deliver(reply(892, escId, "actually, wait", "you", true));     // the question closed: said so, not dropped
  await until(() => bus.replies(892).length === 1, 5000, "closed");
  expect(bus.replies(892)).toEqual(["[factory] that question is already closed; your reply wasn't used."]);
  expect(runner.runs.length).toBe(2);
  await bus.close();
  await done;
});

test("ask: a config human who isn't declared on the bus is logged and the declared one gets the question; a failed send is retried, stamped only once sent", async () => {
  const runner = asker({ to: "human" });
  const bus = new FakeBus();
  bus.humans = ["you"];
  let down = true;
  bus.refuse = (tool, args) => down && tool === "dm_send" && args.to === "you";
  const { store, logs, done } = loop({ runner, bus, ask: { ...ASK_DEFAULTS, human: "ops" }, askTickMs: 10 });
  bus.deliver(ask(300));
  await until(() => logs.some((l) => l.includes("couldn't send request 300's question to you; will retry")), 5000, "a failed send");
  expect(logs.some((l) => l.includes(`config "human" ops isn't a declared human on this bus`) && l.includes("using you"))).toBe(true);
  expect(store.get(k(300))!.escalatedAt).toBeNull();               // not sent, so the give-up clock hasn't started
  down = false;
  await until(() => bus.sent.some((s) => s.args.to === "you"), 5000, "sent on a later tick");
  expect(bus.sent.filter((s) => s.args.to === "you").length).toBe(1);
  await until(() => store.get(k(300))!.escalatedAt !== null, 5000, "stamped");
  expect(bus.sent.some((s) => s.args.to === "ops")).toBe(false);
  await bus.close();
  await done;
});

test("ask: with several questions open, a reply that isn't to one asks which; retry refuses while asking; cancel stops the tree and its asking subtasks", async () => {
  const runner = new FakeRunner(["researcher"]);
  runner.meta = (r) => ({ code: 0, session: `s-${r.id}` });
  runner.script = (r) => r.id === 301 ? PLAN() : r.task.startsWith("do part") ? ASK(`which ${r.id}?`) : undefined;
  const { bus, store, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher" }] });
  bus.deliver(task(301));
  await until(() => bus.replies(301).length === 4, 5000, "ack, fan-out, two questions");
  bus.deliver({ ...task(302, { parentId: 301 }), body: "the first" });   // on the task, not on a question
  await until(() => bus.replies(302).length === 1, 5000, "which one");
  expect(bus.replies(302)).toEqual(["[factory] 2 questions are open in this task; reply to the one you're answering."]);
  bus.deliver({ ...task(303, { parentId: 301 }), body: "retry" });
  await until(() => bus.replies(303).length === 1, 5000, "retry refused");
  expect(bus.replies(303)[0]).toBe("[factory] retry: this is still running its subtasks; reply `cancel` first.");
  bus.deliver({ ...task(304, { parentId: 301 }), body: "cancel" });
  await until(() => bus.replies(301).length === 5, 5000, "cancelled");
  const root = store.get({ source: "board", id: 301 })!;
  expect(root.reply).toStartWith("[factory] cancelled: by fe after it fanned out");
  for (const s of store.subtasks(root.seq)) expect(s).toMatchObject({ state: "finished", reply: "[factory] cancelled: by fe with the task it belongs to, while it waited for an answer." });
  expect(runner.runs.length).toBe(3);                               // triage and two subtasks; no resume, no synthesis
  await bus.close();
  await done;
});

test("ask: retry on an asking delegation says to cancel first", async () => {
  const { bus, done } = loop({ runner: asker() });
  bus.deliver(ask(305));
  await until(() => bus.replies(305).length === 2, 5000, "question");
  bus.deliver(reply(306, 305, "retry"));
  await until(() => bus.replies(306).length === 1, 5000, "refused");
  expect(bus.replies(306)[0]).toBe("[factory] retry: this is still waiting for an answer; reply `cancel` first.");
  await bus.close();
  await done;
});

test("ask: an unusable ask block fails the run with the reason", async () => {
  const runner = new FakeRunner(["researcher"]);
  runner.script = () => "````factory-ask\n{nope}\n````";
  const { bus, store, done } = loop({ runner });
  bus.deliver(ask(307));
  await until(() => bus.replies(307).length === 2, 5000, "failed");
  expect(bus.replies(307)[1]).toBe("[factory] failed: fake agent `researcher` asked a question the factory can't use: the question isn't valid JSON.");
  expect(store.get(k(307))!.asks).toBe(0);
  await bus.close();
  await done;
});

test("ask: with no human on the bus, a subtask's unanswered question is only logged, then gives up and its task still synthesizes", async () => {
  const runner = new FakeRunner(["researcher"]);
  runner.meta = (r) => ({ code: 0, session: `s-${r.id}`, costUsd: 0.25 });
  runner.script = (r) => r.id === 308 && runner.runs.filter((x) => x.id === 308).length === 1 ? PLAN()
    : r.task.startsWith("do part 1") && runner.runs.filter((x) => x.id === r.id).length === 1 ? ASK("which part?") : undefined;
  const { bus, store, logs, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher" }], ask: { max: 3, escalateMs: 20, giveUpMs: 60 }, askTickMs: 10 });
  bus.deliver(task(308));
  await until(() => bus.replies(308).length === 5, 5000, "question, no answer, synthesis");
  expect(bus.replies(308)[3]).toBe("[factory] no answer for subtask \"part 1\" on #task-308: the run carries on with its own judgement.");
  expect(bus.replies(308)[4]).toStartWith("[factory] done: fake agent `researcher`, combining 2 subtasks on #task-308");
  expect(logs.some((l) => l.includes("no human handle to send its question to"))).toBe(true);
  expect(bus.sent.filter((s) => s.tool === "dm_send")).toEqual([]);
  const [s1] = store.subtasks(store.get({ source: "board", id: 308 })!.seq);
  // The resume is told what the session's earlier run cost, which the runner subtracts from its running total.
  expect(runner.resumes.filter(Boolean)).toEqual([{ session: `s-${s1!.id}`, input: NO_ANSWER, priorUsd: 0.25 }]);
  await bus.close();
  await done;
});

test("ask: past the tree's cap a question is answered 'decide' without parking; asking again fails it", async () => {
  const runner = asker({ asks: 3 });
  const { bus, store, done } = loop({ runner, ask: { ...ASK_DEFAULTS, max: 1 } });
  bus.deliver(ask(93));
  await until(() => bus.replies(93).length === 2, 5000, "first question");
  bus.deliver(reply(94, 93, "yes"));
  await until(() => bus.replies(93).length === 3, 5000, "failed");
  expect(runner.resumes.map((r) => r?.input)).toEqual([undefined, expect.stringContaining("yes"), NO_MORE]);
  expect(bus.replies(93)[2]).toBe("[factory] failed: fake agent `researcher` asked again after the task's 1 question was used up. Its question: question 3 for 93?\nmore detail");
  expect(store.get(k(93))!.asks).toBe(2);
  await bus.close();
  await done;
});

test("ask: cancel finishes a parked question; a restart keeps it parked and an answer still resumes it", async () => {
  const runner = asker();
  const path = join(dir, "f.db");
  let store = new Store(path);
  let l = loop({ runner, store });
  l.bus.deliver(ask(95));
  l.bus.deliver(ask(96));
  await until(() => l.bus.replies(95).length === 2 && l.bus.replies(96).length === 2, 5000, "both asking");
  l.bus.deliver(reply(97, l.bus.replyId(95, 1), "cancel"));
  await until(() => l.bus.replies(95).length === 3, 5000, "cancelled");
  expect(l.bus.replies(95)[2]).toBe("[factory] cancelled: by sim while it waited for an answer.");
  await l.bus.close();
  await l.done;
  store.close();
  store = new Store(path);
  expect(store.get(k(96))!.state).toBe("asking");
  const q = l.bus.replyId(96, 1);
  l = loop({ runner, store });
  l.bus.deliver(reply(98, q, "go"));
  await until(() => l.bus.replies(96).length === 1, 5000, "resumed and done");
  expect(l.bus.replies(98)).toEqual(["[factory] answered: the run resumes with it."]);
  expect(l.bus.replies(96)[0]).toBe("[factory] done: fake agent `researcher`\n\nresult for 96");
  expect(runner.resumes.at(-1)).toEqual({ session: "s-96", input: expect.stringContaining("go"), priorUsd: 0 });
  await l.bus.close();
  await l.done;
  store.close();
});

// ── limits (#655) ─────────────────────────────────────────────────────────

test("config: limits on the top level, a fleet and a project; a daily cap needs a day's retention (#655)", () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    treeBudgetUsd: 5, dailyBudgetUsd: 100, deadlineMs: 3_600_000,
    profiles: [{ name: "p", agent: "x" }],
    fleets: [{ name: "a", agent: "x", treeBudgetUsd: 1.5 }, { name: "b", profile: "p", dailyBudgetUsd: 10 }, { name: "c", agent: "y" }],
    projects: [{ name: "j", lead: "p", profiles: ["p"], deadlineMs: 60_000 }],
  }));
  const c = loadConfig(dir, {});
  expect(c.limits).toEqual({ treeBudgetUsd: 5, dailyBudgetUsd: 100, deadlineMs: 3_600_000 });
  expect(c.fleets.map((f) => f.limits)).toEqual([{ treeBudgetUsd: 1.5 }, { dailyBudgetUsd: 10 }, undefined, { deadlineMs: 60_000 }]);
  expect(hasDailyCap(c)).toBe(true);
  writeFileSync(join(dir, "config.json"), "{}");
  expect(loadConfig(dir, {}).limits).toEqual({}); // absent: no cap and no deadline
  expect(hasDailyCap(loadConfig(dir, {}))).toBe(false);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ retentionMs: 3_600_000, fleets: [{ name: "a", agent: "x", treeBudgetUsd: 1 }] }));
  expect(loadConfig(dir, {}).retentionMs).toBe(3_600_000); // a short retention is fine without a daily cap
  for (const bad of [{ treeBudgetUsd: 0 }, { dailyBudgetUsd: "1" }, { deadlineMs: 1.5 }, { deadlineMs: 0 }, { fleets: [{ name: "a", agent: "x", treeBudgetUsd: -1 }] },
    { projects: [{ name: "j", lead: "p", profiles: ["p"], deadlineMs: null }], profiles: [{ name: "p", agent: "x" }] },
    { dailyBudgetUsd: 1, retentionMs: 3_600_000 }, { retentionMs: 3_600_000, fleets: [{ name: "a", agent: "x", dailyBudgetUsd: 1 }] }]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir, {})).toThrow();
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dailyBudgetUsd: 1, retentionMs: 3_600_000 }));
  expect(() => loadConfig(dir, {})).toThrow(/"dailyBudgetUsd" \(the global config\) needs "retentionMs" of at least 86400000/);
});

test("limits: a tree budget is split over the stages left: triage gets it all, a subtask shares with its queued siblings and the synthesis (#655)", async () => {
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? PLAN() : undefined);
  runner.meta = () => ({ code: 0, costUsd: 0.1 });
  const { bus, logs, done } = loop({ runner, maxConcurrent: 1, fleets: [{ name: "sim", agent: "researcher", limits: { treeBudgetUsd: 1 } }] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "taken, fanned out, done");
  // triage: $1 over 1 stage; subtask 1: $0.90 over itself, 1 queued sibling and the synthesis; subtask 2: $0.80 over 2; synthesis: $0.70.
  const grants = runner.policies.map((p) => p.budgetUsd!);
  expect(grants).toHaveLength(4);
  [1, 0.3, 0.4, 0.7].forEach((g, i) => expect(grants[i]).toBeCloseTo(g, 9));
  expect(logs.some((l) => l.includes("granted $0.30"))).toBe(true);
  await bus.close();
  await done;
});

test("limits: a spent tree budget stops the tree; the request's thread names the cap and its task board (#655)", async () => {
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 ? PLAN() : undefined);
  runner.meta = () => ({ code: 0, costUsd: 0.5 });
  const { bus, store, done } = loop({ runner, maxConcurrent: 1, fleets: [{ name: "sim", agent: "researcher", limits: { treeBudgetUsd: 0.5 } }] });
  bus.deliver(task(7));
  await until(() => store.get({ source: "board", id: 7 })?.state === "finished" && bus.replies(7).length === 3, 5000, "stopped");
  expect(runner.runs.map((r) => r.id)).toEqual([7]); // the triage spent it all: no subtask ran
  expect(bus.replies(7)[2]).toBe("[factory] stopped: the task's budget of $0.5 is spent after it fanned out on #task-7; nothing more runs and nothing is combined; each finished subtask's outcome is on #task-7.");
  const subs = store.subtasks(store.get({ source: "board", id: 7 })!.seq);
  expect(subs.map((s) => s.state)).toEqual(["finished", "finished"]);
  for (const s of subs) expect(bus.replies(s.id)[0]).toStartWith("[factory] stopped:");
  await until(() => bus.statuses().at(-1) === "idle", 5000, "idle");
  await bus.close();
  await done;
});

test("limits: a spent daily budget holds new work, a killed run is charged its grant, a reload or the day's passing frees it (#655)", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, store, f, done } = loop({ runner, timeoutMs: 200, askTickMs: 50, limits: { dailyBudgetUsd: 1 } });
  bus.deliver(ask(90));
  await until(() => runner.gates.has(90), 5000, "90 runs");
  expect(runner.policies[0]!.budgetUsd).toBe(1); // the day's whole budget, as nothing else runs
  bus.deliver(ask(91));
  await until(() => bus.replies(91).length === 1, 5000, "91 taken");
  expect(bus.replies(91)[0]).toMatch(/queued, held: the factory's daily budget of \$1 is spent; it may free when running work reports what it spent, and frees in about [\d.]+h at most\./);
  await until(() => bus.replies(90).length === 2, 5000, "90 timed out"); // killed with no cost reported: its grant is what it spent
  expect(store.runs(store.get(k(90))!.seq)).toMatchObject([{ outcome: "timeout", cost_usd: null, granted_usd: 1 }]);
  await until(() => bus.statuses().includes("0 running, 1 queued (1 held: daily budget spent)"), 5000, "a free slot, and 91 still held");
  expect(runner.runs.map((r) => r.id)).toEqual([90]);
  expect(store.get(k(91))!.state).toBe("queued");
  bus.deliver(reply(92, bus.replyId(91), "status"));
  await until(() => bus.replies(92).length === 1, 5000, "status");
  expect(bus.replies(92)[0]).toMatch(/^\[factory\] status: queued, held: the factory's daily budget of \$1 is spent; it frees in about [\d.]+h\./); // 90 ended: only the window frees it
  await f.reconfigure({ fleets: [], policy: GLOBAL, workdir: SHARED, limits: { dailyBudgetUsd: 2 } }); // a reload raises the cap
  await until(() => runner.gates.has(91), 5000, "91 runs");
  expect(runner.policies[1]!.budgetUsd).toBeCloseTo(1, 9);
  runner.gates.get(91)!.resolve({ ok: true, text: "fine", run: { code: 0, costUsd: 1 } });
  await until(() => bus.replies(91).length === 2, 5000, "91 done");
  bus.deliver(ask(93));
  await until(() => bus.replies(93).length === 1, 5000, "93 taken");
  expect(bus.replies(93)[0]).toContain("held: the factory's daily budget of $2 is spent");
  // A day on, what was spent ages out of the window.
  (store as unknown as { db: { exec(q: string): void } }).db.exec(`UPDATE runs SET started_at = started_at - ${86_400_000 + 1000}`);
  await until(() => runner.gates.has(93), 5000, "93 runs once the day passes");
  expect(runner.policies[2]!.budgetUsd).toBe(2);
  runner.gates.get(93)!.resolve({ ok: true, text: "fine" });
  await until(() => bus.replies(93).length === 2, 5000, "93 done");
  await bus.close();
  await done;
});

test("limits: a fleet's daily cap holds only its own board; a delegation still runs (#655)", async () => {
  const runner = new FakeRunner();
  runner.meta = () => ({ code: 0, costUsd: 3 });
  const { bus, store, done } = loop({ runner, fleets: [{ name: "sim", agent: "researcher", fanout: false, limits: { dailyBudgetUsd: 3 } }] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 2, 5000, "7 done");
  bus.deliver(task(8));
  await until(() => bus.replies(8).length === 1, 5000, "8 taken");
  expect(bus.replies(8)[0]).toContain("queued, held: fleet sim's daily budget of $3 is spent");
  bus.deliver(ask(9));
  await until(() => bus.replies(9).length === 2, 5000, "the delegation runs");
  expect(store.get({ source: "board", id: 8 })!.state).toBe("queued");
  expect(runner.runs.map((r) => r.id)).toEqual([7, 9]);
  await bus.close();
  await done;
});

test("limits: a deadline stops a running tree, one parked on a question, and at start one that passed it while the factory was down (#655)", async () => {
  // Running: the deadline (not the 60 s timeout) kills the child.
  const runner = new FakeRunner(["researcher"], true);
  const a = loop({ runner, limits: { deadlineMs: 300 } });
  a.bus.deliver(ask(70));
  await until(() => a.bus.replies(70).length === 2, 5000, "70 stopped");
  expect(a.bus.replies(70)[1]).toBe("[factory] stopped: the task passed its deadline of 0s while fake agent `researcher` ran.");
  expect(a.store.runs(a.store.get(k(70))!.seq)).toMatchObject([{ outcome: "deadline" }]);
  await a.bus.close();
  await a.done;

  // Asking: the question clock's tick stops it.
  const b = loop({ runner: asker(), askTickMs: 50, limits: { deadlineMs: 1500 } });
  b.bus.deliver(ask(71));
  await until(() => b.bus.replies(71).length === 3, 5000, "71 asked, then stopped");
  expect(b.bus.replies(71)[2]).toBe("[factory] stopped: the task passed its deadline of 2s while it waited for an answer.");
  await b.bus.close();
  await b.done;

  // At start: a queued request older than its deadline never runs.
  const s = new Store(":memory:");
  s.admit(req(72), "researcher");
  (s as unknown as { db: { exec(q: string): void } }).db.exec("UPDATE requests SET created_at = 0");
  const c = loop({ store: s, limits: { deadlineMs: 60_000 } });
  await until(() => c.bus.replies(72).length === 1, 5000, "72 stopped at start");
  expect(c.bus.replies(72)[0]).toBe("[factory] stopped: the task passed its deadline of 60s before it ran.");
  expect(c.runner.runs).toEqual([]);
  await c.bus.close();
  await c.done;
});

test("limits: parallel subtasks split the tree's remainder evenly, counting siblings taken but not yet granted (#655)", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, done } = loop({ runner, maxConcurrent: 3, fleets: [{ name: "sim", agent: "researcher", limits: { treeBudgetUsd: 1 } }] });
  bus.deliver(task(7));
  await until(() => runner.gates.has(7), 5000, "triage runs");
  runner.gates.get(7)!.resolve({ ok: true, text: PLAN(3), run: { code: 0, costUsd: 0.1 } });
  await until(() => runner.runs.length === 4, 5000, "three subtasks run at once");
  // $0.90 over three subtasks and the synthesis: each gets $0.225, whatever order they reach their grant in.
  runner.policies.slice(1).forEach((p) => expect(p.budgetUsd!).toBeCloseTo(0.225, 9));
  for (const r of runner.runs.slice(1)) runner.gates.get(r.id)!.resolve({ ok: true, text: "part", run: { code: 0, costUsd: 0.1 } });
  await until(() => runner.runs.length === 5, 5000, "synthesis runs");
  expect(runner.policies[4]!.budgetUsd!).toBeCloseTo(0.6, 9);
  runner.gates.get(7)!.resolve({ ok: true, text: "combined" });
  await until(() => bus.replies(7).length === 3, 5000, "done");
  await bus.close();
  await done;
});

test("limits: a tree spent by the time it would synthesize stops there, pointing at its task board (#655)", async () => {
  const runner = new FakeRunner();
  runner.script = (r) => (r.id === 7 && !r.task.includes("## Subtask results") ? PLAN() : undefined);
  runner.meta = (r) => ({ code: 0, costUsd: r.id === 7 ? 0.1 : 0.45 }); // each subtask overshoots its grant by a turn
  const { bus, done } = loop({ runner, maxConcurrent: 1, fleets: [{ name: "sim", agent: "researcher", limits: { treeBudgetUsd: 1 } }] });
  bus.deliver(task(7));
  await until(() => bus.replies(7).length === 3, 5000, "taken, fanned out, stopped");
  expect(bus.replies(7)[2]).toBe("[factory] stopped: the task's budget of $1 is spent ($1.00 used); nothing is combined, and each subtask's outcome is on #task-7");
  expect(runner.runs).toHaveLength(3); // triage and two subtasks; no synthesis
  await bus.close();
  await done;
});

test("limits: a reload that extends a deadline is honoured by a run already clamped to it (#655)", async () => {
  const runner = new FakeRunner(["researcher"], true);
  const { bus, f, done } = loop({ runner, limits: { deadlineMs: 300 } });
  const t0 = Date.now();
  bus.deliver(ask(75));
  await until(() => runner.gates.has(75), 5000, "75 runs");
  await f.reconfigure({ fleets: [], policy: GLOBAL, workdir: SHARED, limits: { deadlineMs: 1200 } });
  await until(() => bus.replies(75).length === 2, 5000, "stopped at the new deadline");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1100);
  expect(bus.replies(75)[1]).toBe("[factory] stopped: the task passed its deadline of 1s while fake agent `researcher` ran.");
  await bus.close();
  await done;
});
