// The factory module (#293, docs/factory.md): its parser and authority
// check, persona resolution, store, config, the run loop over a fake bus and
// runner, the run loop over a real `grayboard mcp` child, and the Claude
// runner against the pinned Claude Code and a fake Anthropic API.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBus, sessionFree, toDelivery, type Delivery, type FactoryBus } from "../../adapters/factory/bus.ts";
import { ClaudeRunner } from "../../adapters/factory/claude/runner.ts";
import { parseDelegation, requestOf, type Request } from "../../adapters/factory/delegate.ts";
import { Factory } from "../../adapters/factory/factory.ts";
import { DEFAULTS, loadConfig } from "../../adapters/factory/main.ts";
import { parseAgent, readAgents, resolvePersona, type Agent, type Outcome, type Runner } from "../../adapters/factory/runner.ts";
import { Store } from "../../adapters/factory/store.ts";
import { delegationBody } from "../../src/core/delegation.ts";
import { claudeCodeBin, claudeHome } from "../support/claude_code.ts";
import { localEnv } from "../support/env.ts";
import { startFakeAnthropic, systemText, userTexts } from "../support/fake_anthropic.ts";
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
  expect(requestOf(dm(5, "sim", body))).toEqual({ request: { ...brief, id: 5 } });
  const forged = requestOf(dm(6, "mallory", body));
  expect(forged && "ignored" in forged && forged.ignored).toContain("mallory");
  expect(requestOf({ kind: "board", board: "e2e", from: "sim", body })).toBeNull();
  expect(requestOf(dm(7, "sim", "just chatting"))).toBeNull();
});

test("toDelivery reads grayboard's channel params and drops anything else", () => {
  expect(toDelivery({ content: "hi", meta: { message_id: "12", from: "sim", parent_id: "3" } })).toEqual({ kind: "dm", id: 12, from: "sim", parentId: 3, body: "hi" });
  expect(toDelivery({ content: "p", meta: { board: "e2e", post_id: "4", from: "be" } })).toEqual({ kind: "board", board: "e2e", postId: 4, from: "be", body: "p" });
  expect(toDelivery({ content: "x", meta: { message_id: "abc", from: "sim" } })).toBeNull();
  expect(toDelivery({ meta: { message_id: "1", from: "sim" } })).toBeNull();
  expect(toDelivery(undefined)).toBeNull();
});

// ── roster and persona ───────────────────────────────────────────────────────

const agents = (...names: string[]): Agent[] => names.map((name) => ({ name, file: `/x/${name}.md` }));

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
  expect(parseAgent("/a/x.md", "---\ndescription: d\n---\nbody")).toEqual({ file: "/a/x.md", name: "x", description: "d" });
  expect(parseAgent("/a/x.md", "---\nname: \"Writer\"\n---\n")?.name).toBe("Writer");
  const user = join(dir, "user"), project = join(dir, "project");
  mkdirSync(user); mkdirSync(project);
  writeFileSync(join(user, "a.md"), "---\nname: alpha\n---\n");
  writeFileSync(join(user, "b.md"), "---\nname: beta\n---\n");
  writeFileSync(join(project, "b2.md"), "---\nname: beta\n---\n");
  writeFileSync(join(project, "notes.txt"), "---\nname: gamma\n---\n");
  const r = readAgents([user, project, join(dir, "missing")]);
  expect(r.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  expect(r.find((a) => a.name === "beta")!.file).toBe(join(project, "b2.md"));
});

// ── store ────────────────────────────────────────────────────────────────────

const req = (id: number, persona = "researcher"): Request => ({ id, requester: "sim", persona, task: `task ${id}` });

test("store: a message id is admitted once; queued rows run in id order", () => {
  const s = new Store(":memory:");
  expect(s.admit(req(2), "researcher")).toBe(true);
  expect(s.admit(req(2), "researcher")).toBe(false);
  expect(s.admitFinished(req(2), "declined")).toBe(false);
  expect(s.admit(req(1), "researcher")).toBe(true);
  expect(s.queuedAhead(2)).toBe(1);
  expect(s.next()!.id).toBe(1);
  expect(s.next()!.id).toBe(2);
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
  s.markReplied(1);
  expect(s.unsent()).toEqual([]);
  expect(s.get(2)!.state).toBe("queued");
  s.close();
});

test("store: prune drops only replied rows past retention", () => {
  let t = 1_000;
  const s = new Store(":memory:", () => t);
  s.admitFinished(req(1), "a"); s.markReplied(1);
  s.admitFinished(req(2), "b");                    // unsent: kept
  t = 10_000;
  expect(s.prune(5_000)).toBe(1);
  expect(s.get(1)).toBeNull();
  expect(s.get(2)).not.toBeNull();
  s.close();
});

// ── config and env ───────────────────────────────────────────────────────────

test("config: defaults, the file's fields, FACTORY_GRAYBOARD, and type errors", () => {
  const c = loadConfig(dir, { HOME: dir });
  expect(c).toMatchObject({ ...DEFAULTS, grayboard: ["grayboard"], cwd: dir });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ identity: "fac", allowedTools: ["Read"], maxConcurrent: 4, cwd: "/srv/work" }));
  expect(loadConfig(dir, { FACTORY_GRAYBOARD: "bun src/cli/main.ts" })).toMatchObject({ identity: "fac", allowedTools: ["Read"], maxConcurrent: 4, cwd: "/srv/work", grayboard: ["bun", "src/cli/main.ts"] });
  for (const bad of [{ maxConcurrent: 0 }, { maxConcurrent: "2" }, { allowedTools: "Bash" }, { identity: "" }, [1]]) {
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
  sent: { tool: string; args: Record<string, unknown> }[] = [];
  fail = false;
  private q: Delivery[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private settle!: (w: string) => void;
  readonly closed = new Promise<string>((ok) => (this.settle = ok));
  deliver(d: Delivery) { this.q.push(d); this.wake?.(); }
  async call(tool: string, args: Record<string, unknown> = {}) {
    if (this.fail) throw new Error("bus down");
    this.sent.push({ tool, args });
    return { ok: true };
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
}

class FakeRunner implements Runner {
  readonly harness = "fake";
  readonly rosterSource = "/fake/agents";
  runs: { agent: string; id: number }[] = [];
  gates = new Map<number, PromiseWithResolvers<Outcome>>();
  constructor(public names = ["researcher"], private readonly hold = false) {}
  roster() { return agents(...this.names); }
  run(agent: Agent, r: Request, signal: AbortSignal): Promise<Outcome> {
    this.runs.push({ agent: agent.name, id: r.id });
    if (!this.hold) return Promise.resolve({ ok: true, text: `result for ${r.id}` });
    const g = Promise.withResolvers<Outcome>();
    this.gates.set(r.id, g);
    signal.addEventListener("abort", () => g.resolve({ ok: false, error: "aborted" }));
    return g.promise;
  }
}

function loop(o: { runner?: FakeRunner; store?: Store; maxConcurrent?: number; timeoutMs?: number } = {}) {
  const bus = new FakeBus(), runner = o.runner ?? new FakeRunner(), store = o.store ?? new Store(":memory:");
  const logs: string[] = [];
  const f = new Factory(bus, store, runner, { maxConcurrent: o.maxConcurrent ?? 2, timeoutMs: o.timeoutMs ?? 60_000, retentionMs: 60_000, log: (m) => logs.push(m) });
  const done = f.run();
  return { bus, runner, store, logs, done };
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
  expect(bus.sent.every((s) => s.tool === "dm_send" && s.args.to === "sim")).toBe(true);
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
  await until(() => a.store.get(40)?.state === "finished", 5000, "first run finishes");
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

test("loop: a failed send stays unsent and housekeeping retries it", async () => {
  const bus = new FakeBus(), store = new Store(":memory:");
  const f = new Factory(bus, store, new FakeRunner(), { maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, housekeepingMs: 100, log: () => {} });
  const done = f.run();
  bus.fail = true;
  bus.deliver(ask(50));
  await until(() => store.get(50)?.state === "finished", 5000, "run finishes");
  expect(store.get(50)!.replied).toBe(false);
  bus.fail = false;
  await until(() => store.get(50)?.replied, 5000, "housekeeping resend");
  expect(bus.replies(50).at(-1)).toContain("result for 50");
  await bus.close();
  await done;
});

// ── over a real grayboard mcp child ──────────────────────────────────────────

test("local bus: a delegate from a real session reaches the factory, which answers in the thread", async () => {
  const sim = await localSession(dir, "sim");
  const bus = await LocalBus.start({ command: [process.execPath, CLI], identity: "factory", version: "test", env: localEnv(dir), cwd: dir });
  expect(bus.handle).toBe("factory");
  const runner = new FakeRunner();
  const f = new Factory(bus, new Store(join(dir, "f.db")), runner, { maxConcurrent: 1, timeoutMs: 60_000, retentionMs: 60_000, log: () => {} });
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

// ── the Claude runner against pinned Claude Code ─────────────────────────────

test("claude runner: runs the named agent headless, prompt on stdin, and returns its result", async () => {
  const bin = claudeCodeBin();
  const model = startFakeAnthropic([
    (q) => (userTexts(q).some((t) => t.includes("-- FACTORY-TASK")) ? { text: systemText(q).includes("AGENT-PROMPT-7") ? "RESULT-42" : "wrong agent" } : undefined),
  ]);
  try {
    const h = claudeHome(dir, model.url);
    mkdirSync(join(h.config, "agents"), { recursive: true });
    writeFileSync(join(h.config, "agents", "researcher.md"), "---\nname: researcher\ndescription: researches\n---\nAGENT-PROMPT-7: you research.\n");
    const runner = new ClaudeRunner({ bin, cwd: h.work, allowedTools: [], env: h.env });
    expect(runner.roster().map((a) => a.name)).toEqual(["researcher"]);
    const agent = resolvePersona("a researcher", runner.roster())!;
    // A task starting with "-" would be a flag in argv; on stdin it's text.
    const out = await runner.run(agent, { id: 1, requester: "sim", persona: "a researcher", task: "-- FACTORY-TASK: find it" }, new AbortController().signal);
    expect(out).toEqual({ ok: true, text: "RESULT-42" });
    expect(model.unhandled).toEqual([]);
  } finally {
    model.stop();
  }
}, 120_000);
