// The run loop (docs/factory.md §4–§7), harness-neutral: take a
// delegation that passes the authority check, or a task posted on a fleet's
// queue board, record it before anything else, answer in its thread at
// once, run it on a free slot, and reply with the outcome. Every reply goes
// where the request came from, in its thread.
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Delivery, FactoryBus } from "./bus.ts";
import { oneLine, requestOf, type Key, type Request } from "./delegate.ts";
import { answerPrompt, askInstruction, NO_ANSWER, NO_MORE, parseAsk, reseeded, type Ask } from "./ask.ts";
import { fenced, notesInstruction, parsePlan, splitNotes, synthesisPrompt, triageInstruction, type Plan, type Result, type Round } from "./fanout.ts";
import { resolvePersona, type Agent, type Outcome, type Policy, type Resume, type Runner } from "./runner.ts";
import { MIRROR_TTL_MIN, mirrorNote, mirrorPrefix, RENEW_MS, repoId } from "./mirror.ts";
import type { ChildTools } from "./relay.ts";
import type { Admit, Hold, Row, RunOutcome, Store } from "./store.ts";
import type { Place, Workdir, Workspaces } from "./workdir.ts";

// A fleet (docs/factory.md §7): a queue board `<name>-tasks` the factory is
// a lane on, and the agent it runs each task with. The agent is the
// operator's choice, never the post's. `fanout` (default on) lets a task's
// run return a plan of subtasks instead of doing it (§7). `policy` and
// `workdir` are its profile's (#643, #641); absent, the factory's global ones.
// A project (#645) is a fleet whose `routes` are the profiles its plans may
// name, the lead's first; a fleet with a profile routes to that one alone.
export type Fleet = { name: string; agent: string; fanout?: boolean; profile?: string; policy?: Policy; workdir?: Workdir; routes?: Route[]; limits?: Limits };
// Spend and time limits (#655), config only. treeBudgetUsd: the most one
// request's tree (its runs, its subtasks', its synthesis) may spend.
// dailyBudgetUsd: the most spent in any 24 h, the global one across the
// whole factory, a fleet's across its own. deadlineMs: how long a tree may
// take from its admission. A fleet's tree budget and deadline replace the
// global ones; both daily caps apply. maxRounds (#658): how many plans a
// tree's lead may make, its triage's included (default 1: a review only
// combines); a fleet's replaces the global one.
export type Limits = { treeBudgetUsd?: number; dailyBudgetUsd?: number; deadlineMs?: number; maxRounds?: number };
// A grant under this is no budget at all.
export const MIN_GRANT_USD = 0.01;
const DAY_MS = 86_400_000;
export type Route = { profile: string; agent: string; policy: Policy; workdir: Workdir };
export const fleetBoard = (f: Fleet) => `${f.name}-tasks`;
// Where a fleet's fan-outs post their subtasks (#665): one standing broadcast
// board per fleet, named from the persona so a tree outlives a reload.
export const workBoard = (fleet: string) => `${fleet}-work`;

// Asking (#652): the most questions one request's tree may ask; how long a
// question waits before it's sent to your user, and how long after that
// before the run resumes on its own judgement; who your user is (absent,
// the bus's declared human).
export type AskPolicy = { max: number; escalateMs: number; giveUpMs: number; human?: string };
export const ASK_DEFAULTS: AskPolicy = { max: 3, escalateMs: 3_600_000, giveUpMs: 24 * 3_600_000 };

// What a config reload (#645) replaces; the rest needs a restart.
export type Reconfig = { fleets: Fleet[]; policy: Policy; workdir: Workdir; ask?: AskPolicy; limits?: Limits };

export type FactoryOptions = {
  fleets?: Fleet[];
  policy: Policy; // the global tool lists: delegations, and fleets without a profile
  workdir: Workdir; // the global working-directory mode, likewise
  workspaces: Workspaces; // where each run's directory is made, and swept once its tree is pruned
  runs: string; // the transcripts' directory (#649): <run id>.jsonl, 0700, swept once its run's row is pruned
  maxConcurrent: number;
  maxSubtasks?: number; // a fan-out plan's cap (default 5)
  timeoutMs: number;
  retentionMs: number;
  housekeepingMs?: number; // how often unsent replies are retried and the store pruned
  ask?: AskPolicy; // default ASK_DEFAULTS
  limits?: Limits; // the global limits (#655); default none
  askTickMs?: number; // how often parked questions' clocks are checked (default 30 s)
  mirrorRenewMs?: number; // how often live mirrored claims (#675) are renewed on the bus (default RENEW_MS)
  childTools?: ChildTools; // the relay (#669) a run whose policy has busTools gets; absent, such a run fails unspawned
  log(message: string): void;
};

// A DM body's cap is 64 KiB (src/core/boards.ts MAX_BODY_BYTES); leave room for the frame.
const MAX_REPLY_BYTES = 60 * 1024;

export class Factory {
  private running = 0;
  private stopping = false;
  private readonly children = new Set<AbortController>();
  private readonly inflight = new Set<Promise<void>>(); // running execs, awaited at shutdown
  private readonly sending = new Set<string>(); // keys whose outcome is being sent, so housekeeping can't send one twice
  private timer: ReturnType<typeof setInterval> | undefined;
  private askTimer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly joined = new Map<string, Fleet>(); // board → fleet, as the last sync left it
  private readonly queues = new Set<string>(); // every queue board, as the last sync saw them
  private readonly work = new Map<string, Promise<string | null>>(); // work boards opened or opening (#665); a failed open or mute is dropped to be tried again
  private readonly noFanout = new Set<string>(); // fleets whose work board's name is a queue board's, as the last sync saw them
  private readonly active = new Map<number, AbortController>(); // seq → its running child's controller
  private readonly planning = new Set<number>(); // reviews told they may plan (#658), so their grant keeps a quarter
  private readonly cancelledBy = new Map<number, Stop>(); // seq → what stopped it while it ran: a cancel (#651), a deadline or a spent tree budget (#655)
  private load = ""; // the peer_status text last set
  private warnedHuman: string | undefined; // a config `human` already logged as undeclared
  // Mirrored tree claims (#675): a sweep is owed (one failed);
  // the rows running with mirrored claims, swept after; the bus keys the
  // last sweep left held, and when it renewed them.
  private mirrorDirty = false;
  private readonly mirroredRuns = new Set<number>();
  private mirrorHeld = new Set<string>();
  private renewedAt = 0;
  private sweeping: Promise<void> | null = null;
  private sweepAgain = false;

  private cfg: Reconfig & { ask: AskPolicy; limits: Limits };

  constructor(private readonly bus: FactoryBus, private readonly store: Store, private readonly runner: Runner, private readonly o: FactoryOptions) {
    this.cfg = { fleets: o.fleets ?? [], policy: o.policy, workdir: o.workdir, ask: o.ask ?? ASK_DEFAULTS, limits: o.limits ?? {} };
    // A transcript holds whatever its child read and wrote.
    mkdirSync(o.runs, { recursive: true, mode: 0o700 });
    chmodSync(o.runs, 0o700);
  }

  // A config reload (#645): new runs read the new fleets, projects and
  // global lists; a run already started keeps what it started with. A
  // queued task whose fleet is gone fails when it would run (settingsFor).
  async reconfigure(c: Reconfig): Promise<void> {
    this.cfg = { ...c, ask: c.ask ?? this.cfg.ask, limits: c.limits ?? this.cfg.limits };
    await this.syncFleets();
    this.pump();
  }

  // Runs until the bus closes; resolves with why.
  async run(): Promise<string> {
    const again = (r: Row) => (r.parent !== null ? "The task's combined result will say this subtask was interrupted." : r.source === "dm" ? "Re-delegate it if it's still wanted." : "Post it again if it's still wanted.");
    for (const r of this.store.interrupted((r) => `[factory] interrupted: the factory stopped before this finished; nothing is running for it now. ${again(r)}`)) {
      this.o.log(`request ${r.id} was ${r.state} when the factory last stopped; reporting it interrupted`);
    }
    await this.syncFleets();
    await this.deadlines(); // trees that expired while the factory was down
    await this.housekeeping();
    // What a crash left held on the bus; a factory that mirrors nothing
    // leaves any to their TTL rather than list claims on every start.
    if (this.cfg.policy.mirrorClaims || this.fleets().some((f) => f.policy?.mirrorClaims || f.routes?.some((r) => r.policy.mirrorClaims))) this.sweepMirror();
    this.timer = setInterval(() => void this.housekeeping().catch((e) => this.o.log(`housekeeping: ${msg(e)}`)), this.o.housekeepingMs ?? 3_600_000);
    // Parked questions' clocks (#652) run from their stored times, so a
    // restart resumes them where they were.
    this.askTimer = setInterval(() => void this.askTick().catch((e) => this.o.log(`questions: ${msg(e)}`)), this.o.askTickMs ?? 30_000);
    this.pump();
    // One bad delivery must not end the loop: log it and take the next.
    const consume = (async () => {
      for await (const d of this.bus.deliveries()) await this.take(d).catch((e) => this.o.log(`couldn't take a delivery: ${msg(e)}`));
    })();
    const why = await this.bus.closed;
    this.stop();
    await consume.catch(() => {});
    await this.settle();
    return why;
  }

  // Mirrored tree claims (#675): the bus should hold, under this factory's
  // name, exactly the live tree claims' keys. Releases the rest (a run that
  // ended, a crash between the store and the bus) and renews the live ones
  // inside their TTL. One sweep at a time; one asked for during it runs again
  // after, since its snapshot may predate the ask.
  private sweepMirror(): void {
    if (this.stopping) return;
    if (this.sweeping) { this.sweepAgain = true; return; }
    this.sweeping = (async () => {
      do {
        this.sweepAgain = false;
        await this.mirrorOnce().catch((e) => this.o.log(`mirrored claims: ${msg(e)}`));
      } while (this.sweepAgain && !this.stopping);
    })().finally(() => { this.sweeping = null; });
  }

  private async mirrorOnce(): Promise<void> {
    // The bus first: a take in flight writes the store before the bus, so a
    // key listed here is live in the store read after it, unless it ended.
    const listed = await this.bus.call("claim_list", { prefix: "path:" });
    const live = this.store.liveBusKeys();
    const mine = (Array.isArray(listed) ? listed : []).filter((c): c is { key: string } => c !== null && typeof c === "object" && c.holder === this.bus.handle && typeof c.key === "string");
    let failed = false;
    for (const { key } of mine) {
      // Re-read each time: a take may have landed while an earlier call awaited.
      if (live.has(key) || this.store.liveBusKeys().has(key)) continue;
      try {
        await this.bus.call("claim_release", { key });
        this.o.log(`released ${key} on the bus: no subtask holds it now`);
      } catch (e) { failed = true; this.o.log(`couldn't release ${key} on the bus: ${msg(e)}`); }
    }
    const now = Date.now();
    if (live.size > 0 && now - this.renewedAt >= (this.o.mirrorRenewMs ?? RENEW_MS)) {
      this.renewedAt = now;
      for (const [key, holder] of live) {
        // A run that ended (and released) since the snapshot isn't taken back.
        if (!this.store.liveBusKeys().has(key)) continue;
        try {
          const r = (await this.bus.call("claim_take", { key, ttl_minutes: MIRROR_TTL_MIN, note: mirrorNote(holder) })) as { ok?: unknown; held_by?: unknown };
          if (r?.ok !== true) this.o.log(`${key} lapsed on the bus and ${typeof r?.held_by === "string" ? r.held_by : "someone else"} holds it now; the subtask still holds it in its tree`);
        } catch (e) { this.o.log(`couldn't renew ${key} on the bus: ${msg(e)}`); }
      }
    }
    this.mirrorHeld = new Set(live.keys());
    this.mirrorDirty = failed;
  }

  // Waits for running execs to record their outcome (stop() aborted their
  // children, whose groups get SIGKILL after a grace), so the caller can
  // close the store. A row still running past the deadline is reported
  // interrupted at the next start.
  private async settle(deadlineMs = 15_000): Promise<void> {
    if (!this.inflight.size) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((ok) => (t = setTimeout(() => { this.o.log(`${this.inflight.size} run(s) didn't finish within ${deadlineMs} ms of stopping`); ok(); }, deadlineMs)));
    await Promise.race([Promise.allSettled([...this.inflight]), late]);
    clearTimeout(t);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.askTimer) clearInterval(this.askTimer);
    for (const c of this.children) c.abort();
  }

  async take(d: Delivery): Promise<void> {
    if (await this.command(d)) return;
    if (d.kind === "board") return this.takePost(d);
    const v = requestOf(d);
    if (!v) return;
    if ("ignored" in v) { this.o.log(`ignored: ${v.ignored}`); return; }
    const r = v.request;
    const agent = resolvePersona(r.persona, this.runner.roster());
    if (!agent) {
      if (this.store.admitFinished(r, this.declineBody(r))) await this.send(this.store.get(r)!);
      return;
    }
    await this.admit(r, agent, `persona "${oneLine(r.persona)}"`);
  }

  // A fleet task: a top-level post on a fleet's board, delivered by the queue
  // rotation (reason "subscription", this lane holds its claim) or by an
  // @mention (no claim). Replies in a task's thread are its conversation,
  // not tasks. The poster is the requester: on a local bus every handle is
  // the same OS user, as with a delegation.
  private async takePost(d: Extract<Delivery, { kind: "board" }>): Promise<void> {
    if (d.parentId !== undefined || d.postId === undefined || !d.from) return;
    const key = `queue:${d.board}:${d.postId}`;
    const fleet = this.joined.get(d.board);
    if (!fleet) {
      // Not ours (a subscription the sync hasn't dropped yet): pass any claim on.
      // (A broadcast board's posts arrive with the same reason and hold no claim.)
      if (d.reason === "subscription" && this.queues.has(d.board)) await this.release(key, "not a factory fleet board");
      return;
    }
    const r: Request = { source: "board", board: d.board, id: d.postId, requester: d.from, persona: fleet.name, task: d.body };
    const agent = this.runner.roster().find((a) => a.name === fleet.agent);
    if (!agent) {
      const why = `fleet "${fleet.name}"'s agent \`${fleet.agent}\` isn't in the ${this.runner.harness} roster (${this.runner.rosterSource})`;
      // A claim passes to the next lane, which may run it; a mention has no
      // claim, so its poster hears why.
      if (d.reason === "subscription") { this.o.log(`post ${d.postId}: ${why}; passing it on`); await this.release(key, `factory: ${why}`); return; }
      if (this.store.admitFinished(r, `[factory] declined: ${why}. Nothing was spawned.`)) await this.send(this.store.get(r)!);
      return;
    }
    await this.admit(r, agent, `fleet "${fleet.name}"`, { fanout: fleet.fanout !== false && !this.noFanout.has(fleet.name) });
  }

  private async admit(r: Request, agent: Agent, label: string, o: Admit = {}): Promise<void> {
    if (!this.store.admit(r, agent.name, o)) { this.o.log(`${r.source} ${r.id} already taken; redelivery ignored`); return; }
    const seq = this.store.get(r)!.seq, hold = this.holdNote(seq);
    const where = hold ? `queued, ${hold}` : this.running < this.o.maxConcurrent ? "starting now" : `queued, ${this.store.queuedAhead(r)} ahead`;
    // §13's launcher contract: say it was taken before the work starts. On a
    // queue board this reply also acks the claim, so the rotation never
    // redelivers a task that's running. Not stored: a lost acknowledgement
    // costs nothing the outcome won't say.
    await this.reply(r, `[factory] taken: ${label} runs as ${this.runner.harness} agent \`${agent.name}\`, ${where}. The outcome follows in this thread; reply \`status\` or \`cancel\` to this message.`).catch((e) => this.o.log(`couldn't acknowledge ${r.source} ${r.id}: ${msg(e)}`));
    this.pump();
  }

  private async release(key: string, note: string): Promise<void> {
    await this.bus.call("claim_release", { key, note }).catch((e) => this.o.log(`couldn't release ${key}: ${msg(e)}`));
  }

  private fleets(): Fleet[] {
    return this.cfg.fleets;
  }

  // Makes the factory a lane on exactly its fleets' boards: creates a
  // missing board as a queue, subscribes to an existing one, and refuses a
  // fleet whose board exists as a broadcast board (every post there would
  // read as a task). Any other queue board it's a lane on is dropped: a lane
  // that ignores its deliveries holds each claim for the full TTL.
  async syncFleets(): Promise<void> {
    const listed = await this.bus.call("board_list");
    const boards = new Map((Array.isArray(listed) ? listed : []).map((b: { name: string; kind?: string; mode?: string | null }) => [b.name, b]));
    // Built aside and swapped in at the end: a reload (#645) runs this while
    // deliveries arrive, and one seen mid-sync must not find its fleet gone.
    const joined = new Map<string, Fleet>(), queues = new Set<string>(), noFanout = new Set<string>();
    for (const b of boards.values()) if (b.kind === "queue") queues.add(b.name);
    for (const f of this.fleets()) {
      const name = fleetBoard(f), b = boards.get(name);
      // A queue board where its subtasks would go (#665): the fleet runs each
      // task whole rather than pay for a triage whose plan can't be posted.
      if (f.fanout !== false && boards.get(workBoard(f.name))?.kind === "queue") {
        noFanout.add(f.name);
        this.o.log(`fleet ${f.name}: #${workBoard(f.name)} is a queue board, so its tasks don't fan out; rename the fleet to give it a work board`);
      }
      try {
        if (!b) await this.bus.call("board_create", { name, purpose: `Tasks for the ${f.name} fleet: each top-level post is one task, run by one lane; replies come in its thread.`, kind: "queue" });
        else if ((b.kind ?? "broadcast") !== "queue") { this.o.log(`fleet ${f.name}: #${name} exists as a ${b.kind ?? "broadcast"} board, not a queue; skipping it`); continue; }
        else if (b.mode !== "push") await this.bus.call("board_subscribe", { board: name, mode: "push" });
        joined.set(name, f);
        queues.add(name);
      } catch (e) {
        this.o.log(`fleet ${f.name}: couldn't join #${name}: ${msg(e)}`);
      }
    }
    this.joined.clear();
    for (const [k, v] of joined) this.joined.set(k, v);
    this.noFanout.clear();
    for (const n of noFanout) this.noFanout.add(n);
    this.queues.clear();
    for (const q of queues) this.queues.add(q);
    for (const b of boards.values()) {
      if (b.kind === "queue" && b.mode === "push" && !joined.has(b.name)) {
        await this.bus.call("board_subscribe", { board: b.name, mode: "off" }).catch((e) => this.o.log(`couldn't leave #${b.name}: ${msg(e)}`));
        this.o.log(`left #${b.name}: no fleet in the config uses it`);
      }
    }
  }

  private pump(): void {
    while (!this.stopping && this.running < this.o.maxConcurrent) {
      const row = this.store.next(this.hold());
      if (!row) break;
      this.running++;
      const p: Promise<void> = this.exec(row)
        .catch((e) => this.o.log(`request ${row.id}: ${msg(e)}`))
        .finally(() => { this.running--; this.inflight.delete(p); if (this.mirroredRuns.delete(row.seq)) this.sweepMirror(); this.pump(); });
      this.inflight.add(p);
    }
    this.showLoad();
  }

  // The factory's load in peer_list (#651), set when it changes.
  private showLoad(): void {
    if (this.stopping) return;
    const { running, queued, asking } = this.store.load();
    const held = queued ? this.store.heldCount(this.hold()) : 0;
    const text = running || queued || asking ? `${running} running, ${queued} queued${held ? ` (${held} held: daily budget spent)` : ""}${asking ? `, ${asking} asking` : ""}` : "idle";
    if (text === this.load) return;
    this.load = text;
    void this.bus.call("peer_status", { text }).catch((e) => this.o.log(`couldn't set peer_status: ${msg(e)}`));
  }

  // One slot's work: a request's run, a subtask's run, or a fanned-out
  // request's synthesis. A run that returns a plan fans out instead of
  // finishing; a subtask's end may queue its parent's synthesis. Never
  // throws past recording an outcome: anything unexpected finishes the row
  // failed.
  private async exec(row: Row): Promise<void> {
    let body: string | null;
    try {
      body = await this.outcome(row);
    } catch (e) {
      body = `[factory] failed: the factory couldn't run this: ${msg(e)}`;
    }
    this.cancelledBy.delete(row.seq);
    if (body === null) return; // fanned out (its synthesis finishes it) or asking (its resume does)
    this.store.finish(row, clip(body));
    // Before the send's await: a crash during it must not strand a parent
    // whose subtasks all finished.
    if (row.parent !== null && this.store.synthesizeWhenDone(row.parent)) this.o.log(`request ${row.parent}: every subtask finished; synthesizing`);
    await this.send(this.store.get(row)!);
  }

  // The row's reply, or null when its run fanned out or asked.
  private async outcome(row: Row): Promise<string | null> {
    const synth = row.phase === "synthesize";
    const max = this.o.maxSubtasks ?? 5;
    const set = this.settingsFor(row);
    if (typeof set === "string") return set;
    const ownDir = (s: Settings | string) => typeof s !== "string" && s.workdir.mode !== "shared";
    const routes = this.fleets().find((f) => f.name === row.persona)?.routes ?? [];
    const profiles = row.source === "board" ? routes.map((r) => ({ name: r.profile, agent: r.agent, tools: r.policy.tools?.join(", ") ?? "the default: no shell, no web fetch" })) : [];
    // Rounds (#658): the lead is a fan-out-capable root; its triage may plan,
    // and so may each review while the tree has rounds left.
    // Decided once per run: the prompt and the grant must agree.
    const lead = row.parent === null && row.fanout, maxRounds = this.limitsFor(row).maxRounds ?? 1, plans = this.canPlan(row);
    if (plans && synth) this.planning.add(row.seq);
    let body: string | null;
    try {
      body = await this.outcomeOf(row, set, { synth, max, ownDir, profiles, lead, maxRounds, plans });
    } finally {
      this.planning.delete(row.seq);
    }
    return body !== null && row.parent === null ? this.handBack(row, set.workdir, body) : body;
  }

  // A worktree-mode request's last reply names the branch its result is on
  // (#683), in the reply's first line so a clipped reply keeps it.
  private async handBack(row: Row, w: Workdir, body: string): Promise<string> {
    if (w.mode !== "worktree") return body;
    const name = `factory/${row.source === "board" ? row.board : "dm"}/${row.id}`;
    let note: string | null;
    try {
      const b = await this.o.workspaces.handBack(w, row.seq, name);
      note = b ? `the result is on branch \`${b.branch}\` at ${b.sha.slice(0, 12)} in ${w.repo}` : body.startsWith("[factory] done:") ? "no new commits, so no branch" : null;
    } catch (e) {
      this.o.log(`request ${row.id}: couldn't hand back a branch: ${msg(e)}`);
      note = `couldn't make its branch (${msg(e)}); its worktree stays until the store prunes the request`;
    }
    if (note === null) return body;
    const cut = body.indexOf("\n\n");
    return cut < 0 ? `${body.replace(/\.$/, "")}; ${note}.` : `${body.slice(0, cut)}; ${note}.${body.slice(cut)}`;
  }

  private async outcomeOf(row: Row, set: Settings, c: { synth: boolean; max: number; ownDir: (s: Settings | string) => boolean; profiles: { name: string; agent: string; tools: string }[]; lead: boolean; maxRounds: number; plans: boolean }): Promise<string | null> {
    const { synth, max, ownDir, profiles, lead, maxRounds, plans } = c;
    let input: Request = row;
    if (synth) {
      // The digest, built here from the store: the latest round's outcomes
      // in full, earlier rounds' in a line each, and the lead's notes.
      const subs = this.store.subtasks(row.seq);
      const res = (s: Row): Result => ({ title: s.title ?? "", reply: s.reply, dir: ownDir(this.settingsFor(s)) ? String(s.seq) : undefined, profile: s.profile });
      const earlier: Round[] = [];
      for (let k = 1; k < row.round; k++) earlier.push({ round: k, results: subs.filter((s) => s.round === k).map(res) });
      const next = plans ? { max, left: maxRounds - row.round, ownDirs: ownDir(set), worktree: set.workdir.mode === "worktree", profiles } : undefined;
      input = { ...row, task: synthesisPrompt(row.task, subs.filter((s) => s.round === row.round).map(res), { earlier, notes: row.notes, next, round: row.round }), context: undefined };
    } else if (row.fanout) input = { ...row, task: `${row.task}\n\n${triageInstruction(max, ownDir(set), profiles)}${lead && maxRounds > 1 ? `\n\n${notesInstruction()}` : ""}` };
    // An answered question (#652) resumes the conversation that asked it;
    // with no session to resume, a fresh run is told what it asked and what came back.
    let resume: Resume | undefined;
    const session = row.resume && row.answer !== null ? this.store.lastSession(row.seq) : null;
    if (session) resume = { session, input: row.answer!, priorUsd: this.store.sessionUsd(session) };
    else {
      const task = `${input.task}\n\n${askInstruction()}`;
      input = { ...input, task: row.resume && row.answer !== null ? reseeded(task, row.question ?? "", row.answer) : task };
    }
    const out = await this.runAgent(row, input, set, resume);
    const who = set.agent ?? row.agent;
    if (out === HELD) return null; // queued again: its fleet's day is spent
    const by = this.cancelledBy.get(row.seq);
    if (by !== undefined && typeof out !== "string") return `[factory] ${by.head} while ${this.runner.harness} agent \`${who}\` ran.`;
    let body: string;
    if (typeof out === "string") body = out;
    else if (!out.ok) body = `[factory] failed: ${this.runner.harness} agent \`${who}\`: ${this.stopping ? "the factory stopped while this ran" : out.error}`;
    else {
      // A lead's notes block is kept for its next review, never posted.
      let text = out.text;
      if (lead && maxRounds > 1) {
        const n = splitNotes(text);
        text = n.text;
        if (n.notes !== null) this.store.setNotes(row.seq, n.notes);
      }
      const q = parseAsk(text);
      if (q !== null) return typeof q === "string" ? `[factory] failed: ${this.runner.harness} agent \`${who}\` asked a question the factory can't use: ${q}.` : this.ask(row, q, who);
      const plan = plans ? parsePlan(text, max) : null;
      if (plan && typeof plan !== "string") {
        const res = await this.fanOut(row, plan);
        if (!res) return null;
        // A cancel that landed while the plan was being posted.
        const late = this.cancelledBy.get(row.seq), where = res.board ?? row.fanoutBoard ?? workBoard(row.persona);
        body = late !== undefined ? `[factory] ${late.head} while its ${synth ? `round ${row.round + 1} ` : ""}plan was being posted on #${where}; no subtask of it ran.` : `[factory] failed: ${res.error}${this.earlierOn(row)}`;
      } else if (typeof plan === "string") {
        body = `[factory] failed: ${this.runner.harness} agent \`${who}\` returned a plan the factory can't use: ${plan}. Nothing ${synth ? "more " : ""}was fanned out${this.earlierOn(row)}.`;
      } else {
        body = synth
          ? `[factory] done: ${this.runner.harness} agent \`${who}\`, combining ${this.store.subtasks(row.seq).length} subtasks${row.round > 1 ? ` over ${row.round} rounds` : ""} on #${row.fanoutBoard}\n\n${text}`
          : `[factory] done: ${this.runner.harness} agent \`${who}\`\n\n${text}`;
      }
    }
    return body;
  }

  // Whether this run may return a plan (#658): a fan-out-capable request's
  // triage always may; its review only while the tree has rounds left. A
  // review of round 0 is a store from before rounds: it only combines.
  // A review also needs a round's worth left: a grant of a quarter above the
  // floor, and two timeouts (the round, then its review) before the deadline;
  // short of either it only combines, so a tree near its limits still answers.
  private canPlan(row: Row): boolean {
    if (!row.fanout || row.parent !== null) return false;
    if (row.phase !== "synthesize") return true;
    const lim = this.limitsFor(row);
    if (!(row.round >= 1 && row.round < (lim.maxRounds ?? 1))) return false;
    if (lim.treeBudgetUsd !== undefined && (lim.treeBudgetUsd - this.store.treeSpent(row.seq)) / 4 < MIN_GRANT_USD) return false;
    if (lim.deadlineMs !== undefined && row.created_at + lim.deadlineMs - Date.now() < 2 * this.o.timeoutMs) return false;
    return true;
  }

  // Runs the row's agent on `input`; a string is a failure reply that needed
  // no run; HELD, the row went back to the queue (its day is spent).
  private async runAgent(row: Row, input: Request, set: Settings, resume?: Resume): Promise<Outcome | string> {
    const name = set.agent ?? row.agent;
    const agent = this.runner.roster().find((a) => a.name === name);
    if (!agent) return `[factory] failed: agent \`${name}\` left the ${this.runner.harness} roster before this ran; nothing was spawned.`;
    let place: Place;
    try {
      place = await this.o.workspaces.place(set.workdir, { tree: row.parent ?? row.seq, sub: row.parent !== null ? row.seq : null, synthesis: row.phase === "synthesize" });
    } catch (e) {
      return `[factory] failed: couldn't make the ${set.workdir.mode} working directory: ${msg(e)}; nothing was spawned.`;
    }
    // A cancel between the slot and the spawn: nothing runs.
    const early = this.cancelledBy.get(row.seq);
    if (early !== undefined) return `[factory] ${early.head} before it ran.`;
    // The tree's deadline and the money left (#655), decided here in code.
    const root = this.rootOf(row), lim = this.limitsFor(root);
    const deadline = lim.deadlineMs !== undefined ? root.created_at + lim.deadlineMs : undefined;
    if (deadline !== undefined && deadline <= Date.now()) {
      await this.stopTree(root, this.deadlineStop(lim.deadlineMs!));
      return `[factory] ${this.cancelledBy.get(row.seq)?.head ?? this.deadlineStop(lim.deadlineMs!).head} before it ran.`;
    }
    const g = this.grant(row, root, set, lim);
    if (g === HELD) { this.store.requeue(row.seq, row.resume); this.o.log(`request ${row.id}: held, the daily budget is spent`); return HELD; }
    if (typeof g === "string") {
      await this.stopTree(root, this.budgetStop(lim.treeBudgetUsd!, root));
      // The synthesis is the root itself, which stopTree leaves to this reply.
      return `[factory] ${g}${row.seq === root.seq && root.fanoutBoard ? `; nothing is combined, and each subtask's outcome is on #${root.fanoutBoard}${this.postsOf(root)}` : ""}`;
    }
    const policy: Policy = g === undefined ? set.policy : { ...set.policy, budgetUsd: g };
    // A fresh run holds no tree claims (#669) and has said nothing of its
    // progress; a resume keeps both.
    if (!row.resume) { this.store.clearClaims(row.seq); this.store.clearProgress(row.seq); }
    // Bus tools (#669): a token for this run only, revoked when it ends. A
    // subtask's also scopes it to its tree, for the tree claim tools; every
    // run's names its own row, for the progress tool.
    let tools: Awaited<ReturnType<ChildTools["grant"]>> | undefined;
    if (policy.busTools) {
      if (!this.o.childTools) return `[factory] failed: this run's profile has busTools on, but this factory has no relay for them; nothing was spawned.`;
      // Mirrored claims (#675) name the repository the subtask works in.
      let mirror: string | undefined;
      if (row.parent !== null && policy.mirrorClaims) {
        try { mirror = mirrorPrefix(await repoId(place.cwd)); } catch (e) {
          return `[factory] failed: this run's profile mirrors its claims to the bus, but its working directory ${place.cwd} isn't in a git repository (${msg(e)}); nothing was spawned.`;
        }
        this.mirroredRuns.add(row.seq); // its claims may end with its row: the sweep after it releases them
      }
      try { tools = await this.o.childTools.grant(row.parent !== null ? { tree: root.seq, holder: row.seq, ...(mirror !== undefined ? { mirror } : {}) } : undefined, row.seq); } catch (e) {
        return `[factory] failed: couldn't open the bus tools for this run: ${msg(e)}; nothing was spawned.`;
      }
      // The grant can take seconds (the reader's start), and until the lines
      // below a cancel or stop has no run to abort: check again.
      const late = this.cancelledBy.get(row.seq);
      if (late !== undefined || this.stopping) {
        tools.revoke();
        return late !== undefined ? `[factory] ${late.head} before it ran.` : `[factory] failed: the factory stopped before this ran; nothing was spawned.`;
      }
    }
    const ac = new AbortController();
    this.children.add(ac);
    this.active.set(row.seq, ac);
    // The timeout, clamped to the deadline. A deadline is re-read when it
    // fires, so a reload that moved it is honoured: past, the tree stops;
    // later, the timer re-arms.
    const timeoutAt = Date.now() + this.o.timeoutMs;
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = (end: number | undefined) => {
      const byDeadline = end !== undefined && end < timeoutAt;
      t = setTimeout(() => {
        if (byDeadline) {
          const ms = this.limitsFor(root).deadlineMs, moved = root.created_at + (ms ?? Infinity);
          if (moved > Date.now()) return arm(moved);
          void this.stopTree(this.store.bySeq(root.seq) ?? root, this.deadlineStop(ms!)).catch((e) => this.o.log(`request ${root.id}: ${msg(e)}`));
        }
        ac.abort();
      }, Math.max(0, (byDeadline ? end : timeoutAt) - Date.now()));
    };
    arm(deadline);
    this.o.log(`request ${row.id}: ${resume ? "resuming" : "running"} ${this.runner.harness} agent ${agent.name}${row.phase === "synthesize" ? " (synthesis)" : row.parent !== null ? " (subtask)" : ""} for ${row.requester}${g !== undefined ? `, granted $${g.toFixed(2)}` : ""}`);
    const run = this.store.startRun(row.seq, agent.name, g);
    let ended: RunOutcome = "failed";
    let out: Outcome | undefined;
    try {
      out = await this.runner.run(agent, input, ac.signal, policy, place, join(this.o.runs, `${run}.jsonl`), resume, tools?.server);
      ended = this.cancelledBy.get(row.seq)?.outcome ?? out.run?.stop ?? (out.ok ? "ok" : ac.signal.aborted ? "timeout" : "failed");
      return out;
    } catch (e) {
      return `[factory] failed: ${this.runner.harness} agent \`${agent.name}\` couldn't start: ${msg(e)}`;
    } finally {
      tools?.revoke();
      clearTimeout(t);
      this.children.delete(ac);
      this.active.delete(row.seq);
      this.store.endRun(run, ended, out?.run);
      const m = out?.run;
      this.o.log(`request ${row.id}: run ${run} ended ${ended}${m?.turns !== undefined ? `, ${m.turns} turn(s)` : ""}${m?.costUsd !== undefined ? `, $${m.costUsd.toFixed(4)}` : ""}`);
    }
  }

  // The run's policy and working-directory mode, from the config as it is
  // now: a fleet task and its subtasks (persona = the fleet's name) get the
  // fleet's; a delegation the global ones. A fleet gone from the config
  // fails the run rather than fall back to the global lists, which may be
  // wider than its profile.
  // A routed subtask (#645) gets its profile's, which must still be one of
  // its project's.
  private settingsFor(row: Row): Settings | string {
    const global: Settings = { policy: this.cfg.policy, workdir: this.cfg.workdir };
    if (row.source === "dm") return global;
    const f = this.fleets().find((f) => f.name === row.persona);
    if (!f) return `[factory] failed: fleet "${oneLine(row.persona)}" is no longer in the factory's config; nothing was spawned.`;
    if (row.profile !== null) {
      const r = f.routes?.find((r) => r.profile === row.profile);
      if (!r) return `[factory] failed: profile "${row.profile}" is no longer one of ${f.name}'s; nothing was spawned.`;
      return { policy: r.policy, workdir: r.workdir, agent: r.agent };
    }
    // The fleet's agent as the config now names it, so a reload never pairs
    // one agent with another's tool lists.
    return { policy: f.policy ?? global.policy, workdir: f.workdir ?? global.workdir, agent: f.agent };
  }

  // Opens the fleet's work board on its first fan-out (#665) and mutes the
  // factory's subscription: its posts and their threads are the factory's
  // to write, not to take. A queue board of that name would hand subtasks to
  // other lanes, so it's refused; a broadcast board someone else made is
  // used as is. Concurrent fan-outs share one open; a failed one, or a
  // failed mute, is tried again on the next. Returns why it couldn't, or null.
  private openWork(name: string, fleet: string): Promise<string | null> {
    let p = this.work.get(name);
    if (!p) {
      const o = this.openWorkOnce(name, fleet).catch((e) => ({ why: `couldn't open #${name} for the fan-out: ${msg(e)}`, keep: false }));
      p = o.then((r) => r.why);
      this.work.set(name, p);
      void o.then((r) => { if (!r.keep) this.work.delete(name); });
    }
    return p;
  }

  private async openWorkOnce(name: string, fleet: string): Promise<{ why: string | null; keep: boolean }> {
    for (let tries = 0; ; tries++) {
      const listed = await this.bus.call("board_list");
      const b = (Array.isArray(listed) ? listed : []).find((b: { name: string }) => b.name === name) as { kind?: string; mode?: string | null } | undefined;
      if (b && b.kind === "queue") return { why: `#${name}, where ${fleet}'s subtasks would go, is a queue board, which would hand them to other lanes; the ${fleet} fleet doesn't fan out while it is. Nothing was fanned out.`, keep: false };
      if (!b) {
        try {
          await this.bus.call("board_create", { name, purpose: `Subtasks the factory ${this.bus.handle} fans out for the ${fleet} fleet: one top-level post per subtask, naming the task it's part of, with its outcome in its thread.` });
        } catch (e) {
          if (tries < 1 && /already exists/.test(msg(e))) continue; // another handle or process made it first
          return { why: `couldn't open #${name} for the fan-out: ${msg(e)}`, keep: false };
        }
      }
      // Muting deletes the subscription, so a muted board lists with no mode.
      if (b && (b.mode ?? "off") === "off") return { why: null, keep: true };
      try {
        await this.bus.call("board_subscribe", { board: name, mode: "off" });
        return { why: null, keep: true };
      } catch (e) {
        this.o.log(`couldn't mute #${name}: ${msg(e)}`);
        return { why: null, keep: false };
      }
    }
  }

  // A plan's fan-out: one post per subtask on the fleet's work board, the
  // durable, visible record (anyone may read, subscribe or comment), each
  // run here on the worker pool with its outcome in its thread. The factory
  // can't be a lane for posts it wrote (the core never hands a poster its
  // own post), so the board is a record, not a queue. A tree that fanned
  // out on a `task-<post id>` board before #665 keeps it. Returns why it
  // couldn't, or null.
  private async fanOut(row: Row, plan: Plan): Promise<{ error: string; board?: string } | null> {
    if (row.source !== "board") return { error: "only a fleet task fans out" };
    // Routing (#645), checked before anything is posted: a subtask may name
    // only one of its project's profiles, so no plan widens what runs.
    const routes = this.fleets().find((f) => f.name === row.persona)?.routes ?? [];
    for (const [i, s] of plan.subtasks.entries()) {
      if (s.profile !== undefined && !routes.some((r) => r.profile === s.profile)) {
        return { error: `subtask ${i + 1} names profile "${oneLine(s.profile)}", which isn't one of ${row.persona}'s (${routes.length ? routes.map((r) => r.profile).join(", ") : "it names none"}). Nothing was fanned out.` };
      }
    }
    // A later round (#658) posts where the tree's first did.
    const board = row.fanoutBoard ?? workBoard(row.persona);
    if (row.fanoutBoard === null) {
      const why = await this.openWork(board, row.persona);
      if (why !== null) return { error: why };
    }
    const round = row.round + 1, label = round > 1 ? `${round}.` : "";
    const of = `for ${oneLine(row.requester)}'s post ${row.id} on #${row.board}`;
    const n = plan.subtasks.length, subtasks: { r: Request; title: string; profile?: string; agent?: string }[] = [];
    for (const [i, s] of plan.subtasks.entries()) {
      try {
        const route = s.profile !== undefined ? routes.find((r) => r.profile === s.profile)! : undefined;
        const res = (await this.bus.call("board_post", { board, body: `[factory] subtask ${label}${i + 1}/${n}${route ? ` (${route.profile})` : ""} ${of}: ${s.title}\n\n${s.task}` })) as { post_id?: unknown };
        if (typeof res?.post_id !== "number") throw new Error("board_post returned no post_id");
        subtasks.push({ r: { source: "board", board, id: res.post_id, requester: row.requester, persona: row.persona, task: s.task }, title: s.title, ...(route ? { profile: route.profile, agent: route.agent } : {}) });
      } catch (e) {
        // Name what was posted: those posts stay on the board, never run.
        const made = subtasks.length ? `${subtasks.length} posted: post${subtasks.length === 1 ? "" : "s"} ${subtasks.map((s) => s.r.id).join(", ")}` : "none posted";
        return { error: `couldn't post subtask ${i + 1} of ${n} on #${board} (${made}; none run): ${msg(e)}`, board };
      }
    }
    if (this.cancelledBy.has(row.seq)) return { error: "cancelled", board };
    this.store.fanOut(row, board, subtasks);
    this.o.log(`request ${row.id}: fanned out ${n} subtasks on #${board}${round > 1 ? `, round ${round}` : ""}`);
    const agents = [...new Set(subtasks.map((s) => s.agent ?? row.agent))];
    const as = agents.length === 1 ? `each run as \`${agents[0]}\`` : `each run as its profile's agent`;
    await this.reply(row, `[factory] fanned out${round > 1 ? `, round ${round}` : ""}: ${n} subtasks on #${board} (post${n === 1 ? "" : "s"} ${subtasks.map((s) => s.r.id).join(", ")}), ${as} with its outcome in its thread. The combined result follows in this thread.`).catch((e) => this.o.log(`couldn't announce the fan-out of ${row.source} ${row.id}: ${msg(e)}`));
    return null;
  }

  // ── asking (#652) ───────────────────────────────────────────────────────
  // A run ended on a question: the row parks (no slot held) and the
  // question goes in its request's thread; a subtask's goes in its parent's,
  // which the requester watches. Addressed to your user, it's sent to them
  // at once too. Past the tree's cap it isn't parked: the run resumes told
  // to decide, and asking again after that fails it. Returns a failure or
  // cancel reply, or null when the row parked or queued again.
  private async ask(row: Row, q: Ask, who: string): Promise<string | null> {
    const root = this.rootOf(row);
    const by = this.cancelledBy.get(row.seq);
    if (by !== undefined) return `[factory] ${by.head} while ${this.runner.harness} agent \`${who}\` ran.`;
    const max = this.cfg.ask.max;
    if (this.store.treeAsks(root.seq) >= max) {
      if (row.answer === NO_MORE) return `[factory] failed: ${this.runner.harness} agent \`${who}\` asked again after the task's ${max} question${max === 1 ? " was" : "s were"} used up. Its question: ${q.question}`;
      this.store.refuse(row.seq, q.question, NO_MORE);
      this.o.log(`request ${row.id}: a question past the cap of ${max}; resuming it told to decide`);
      return null;
    }
    this.store.park(row.seq, q.question, q.human);
    this.o.log(`request ${row.id}: asking ${q.human ? "your user" : root.requester}; parked`);
    const body = `[factory] question${this.subtaskLabel(row)} from ${this.runner.harness} agent \`${who}\`${q.human ? ", for your user" : ""}:\n\n${q.question}\n\nReply to this message with the answer; the run waits for it.`;
    try {
      const res = root.source === "board"
        ? await this.bus.call("board_post", { board: root.board, body, parent_id: root.id })
        : await this.bus.call("dm_send", { to: root.requester, body, parent_id: root.id });
      this.remember(root.source, res, row.seq);
    } catch (e) {
      this.o.log(`couldn't post request ${row.id}'s question; it goes to your user when it escalates: ${msg(e)}`);
    }
    // Answered or cancelled during the post: nothing to send. A failed send
    // leaves it unstamped, so the next tick sends it.
    const now = this.store.bySeq(row.seq);
    if (q.human && now?.state === "asking" && await this.escalate(now, root)) this.store.escalated(now.seq, now.askedAt);
    return null;
  }

  private rootOf(row: Row): Row {
    return (row.parent !== null ? this.store.bySeq(row.parent) : null) ?? row;
  }

  private subtaskLabel(row: Row): string {
    return row.parent !== null && row.source === "board" ? ` for subtask "${oneLine(row.title ?? "")}" on #${row.board}` : "";
  }

  // Your user: a declared human (the bus marks only theirs \`human="true"\`,
  // so only theirs can answer). Config \`human\` picks which; one that isn't
  // declared is logged and the first declared one is used.
  private human(): string | undefined {
    const declared = this.bus.humans ?? [], want = this.cfg.ask.human;
    if (want === undefined || declared.includes(want)) return want ?? declared[0];
    if (this.warnedHuman !== want) {
      this.warnedHuman = want;
      this.o.log(`config "human" ${want} isn't a declared human on this bus (\`grayboard human\`), so its replies couldn't answer; ${declared[0] ? `using ${declared[0]}` : "no one gets questions"}`);
    }
    return declared[0];
  }

  // The question in a DM to your user, once; their reply to it answers it.
  // True when it went, or when there's no one to send it to (so the
  // give-up clock runs); false when the send failed and should be retried.
  private async escalate(row: Row, root: Row): Promise<boolean> {
    const human = this.human();
    if (!human) { this.o.log(`request ${row.id}: no human handle to send its question to (declare one with \`grayboard human\`)`); return true; }
    const where = root.source === "board" ? `post ${root.id} on #${root.board}` : `a delegation by DM`;
    const why = row.askHuman ? "asks you" : `has waited ${ago(row.askedAt ?? Date.now())} for an answer from ${oneLine(root.requester)}`;
    const body = `[factory] ${oneLine(root.requester)}'s task (${where})${this.subtaskLabel(row)} ${why}:\n\n${row.question ?? ""}\n\nReply to this message with the answer. With none in ${dur(this.cfg.ask.giveUpMs)}, the run carries on with its own judgement.`;
    try {
      this.remember("dm", await this.bus.call("dm_send", { to: human, body }), row.seq);
      return true;
    } catch (e) {
      this.o.log(`couldn't send request ${row.id}'s question to ${human}; will retry: ${msg(e)}`);
      return false;
    }
  }

  // Parked questions' clocks: unanswered past escalateMs (or addressed to
  // your user and not yet sent) goes to your user once; past giveUpMs after
  // that, the run resumes on its own judgement.
  private async askTick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const a = this.cfg.ask, now = Date.now();
      for (const listed of this.store.asking()) {
        // Fresh: an earlier row's send awaited, and this one may have been
        // answered, or answered and parked on a new question, since the list.
        const r = this.store.bySeq(listed.seq);
        if (!r || r.state !== "asking" || r.askedAt !== listed.askedAt) continue;
        if (r.escalatedAt === null) {
          if (!r.askHuman && now - (r.askedAt ?? now) < a.escalateMs) continue;
          if (!r.askHuman) this.o.log(`request ${r.id}: question unanswered for ${ago(r.askedAt ?? now)}; sending it to your user`);
          if (await this.escalate(r, this.rootOf(r))) this.store.escalated(r.seq, r.askedAt);
        } else if (now - r.escalatedAt >= a.giveUpMs && this.store.answer(r.seq, NO_ANSWER) === "queued") {
          this.o.log(`request ${r.id}: question unanswered; resuming on its own judgement`);
          const root = this.rootOf(r);
          await this.reply(root, `[factory] no answer${this.subtaskLabel(r)}: the run carries on with its own judgement.`).catch((e) => this.o.log(`couldn't say so in request ${root.id}'s thread: ${msg(e)}`));
        }
      }
      await this.deadlines();
      // Mirrored claims (#675): a row that ended off the run path (a parked
      // run cancelled or stopped) left its key live on the bus; and live keys
      // are renewed inside their TTL.
      const live = this.store.liveBusKeys();
      if (this.mirrorDirty || [...this.mirrorHeld].some((k) => !live.has(k)) || (live.size > 0 && now - this.renewedAt >= (this.o.mirrorRenewMs ?? RENEW_MS))) this.sweepMirror();
      this.pump();
    } finally {
      this.ticking = false;
    }
  }

  // A free-text reply that answers a parked question: one to the question
  // (in the thread or the DM to your user) answers that row; one elsewhere
  // in the request's thread answers its tree's only open question. From the
  // requester or your user; anyone else's is chatter. False: not an answer.
  private async answerQuestion(d: Delivery, id: number, hit: Row, root: Row, inThread: boolean): Promise<boolean> {
    if (!(d.human === true || d.from === root.requester)) return false;
    const text = d.body.trim().replace(/^(@[\w.-]+[\s,:]*)+/, "").trim();
    if (!text) return false;
    let target: Row | undefined;
    if (hit.state === "asking") target = hit;
    else if (inThread) {
      const open = [root, ...this.store.subtasks(root.seq)].filter((r) => r.state === "asking");
      if (open.length > 1) {
        await this.answer(d, id, `[factory] ${open.length} questions are open in this task; reply to the one you're answering.`, root.seq);
        return true;
      }
      target = open[0];
    }
    const closed = () => this.answer(d, id, `[factory] that question is already closed; your reply wasn't used.`, hit.seq).then(() => true);
    // Your user replying to the DM that sent them a question answered since.
    if (!target) return d.human === true && d.kind === "dm" && hit.question !== null && hit.state !== "asking" ? closed() : false;
    const res = this.store.answer(target.seq, answerPrompt(oneLine(d.from!), text), { source: d.kind, id });
    if (res === "closed") return closed();
    if (res === "replay") { this.o.log(`${d.kind} ${id}: answer already taken; replay ignored`); return true; }
    this.o.log(`request ${target.id}: answered by ${d.from}; queued to resume`);
    await this.answer(d, id, `[factory] answered${this.subtaskLabel(target)}: the run resumes with it.`, target.seq);
    this.pump();
    return true;
  }

  private declineBody(r: Request): string {
    const names = this.runner.roster().map((a) => a.name).slice(0, 20);
    return `[factory] declined: no ${this.runner.harness} agent matches persona "${oneLine(r.persona)}" (roster: ${names.length ? names.join(", ") : "empty"}; read from ${this.runner.rosterSource}). Nothing was spawned. Re-delegate to another launcher or handle it yourself.`;
  }

  // A finished outcome's reply; it stays unsent (retried by housekeeping) if the send fails.
  private async send(k: Row): Promise<void> {
    const key = `${k.source}:${k.id}`;
    if (this.sending.has(key)) return;
    const row = this.store.get(k); // fresh: a caller's copy may predate another send
    if (!row || row.replied || row.reply === null) return;
    this.sending.add(key);
    try {
      await this.reply(row, row.reply);
      this.store.markReplied(row);
    } catch (e) {
      this.o.log(`couldn't send the outcome of request ${row.id}; will retry: ${msg(e)}`);
    } finally {
      this.sending.delete(key);
    }
  }

  // Every reply goes where the request came from, in its thread. Its id is
  // recorded, so a command answering it finds the request (#651).
  private async reply(r: Request, body: string): Promise<unknown> {
    const res = r.source === "board"
      ? await this.bus.call("board_post", { board: r.board, body, parent_id: r.id })
      : await this.bus.call("dm_send", { to: r.requester, body, parent_id: r.id });
    const seq = "seq" in r && typeof r.seq === "number" ? r.seq : this.store.get(r)?.seq;
    if (seq !== undefined) this.remember(r.source, res, seq);
    return res;
  }

  private remember(source: Key["source"], res: unknown, seq: number): void {
    const v = (res as { post_id?: unknown; message_id?: unknown } | null)?.[source === "board" ? "post_id" : "message_id"];
    if (typeof v === "number") this.store.recordReply({ source, id: v }, seq);
  }

  // ── thread commands (#651) ──────────────────────────────────────────────
  // A reply in a top-level request's thread (to the request itself, or to
  // one of the factory's replies) whose whole body is a command word. Code
  // reads it, never a model. True when the delivery was a command for one
  // of the factory's requests, acted on or refused; false lets take() treat
  // it as before.
  // A free-text reply may answer a parked question instead (#652).
  private async command(d: Delivery): Promise<boolean> {
    if (d.parentId === undefined || !d.from) return false;
    const id = d.kind === "dm" ? d.id : d.postId;
    if (id === undefined) return false;
    const hit = this.store.threadOf(d.kind, d.parentId);
    if (!hit) return false;
    // A subtask's question is posted in its request's thread, so a reply
    // there finds the subtask: commands act on the request it belongs to.
    const row = this.rootOf(hit);
    // Post ids are global, so the board check is belt and braces; a
    // subtask's thread on a fan-out board takes no commands. The DM that
    // sent a question to your user takes theirs.
    const inThread = d.kind === row.source && (d.kind !== "board" || (row.source === "board" && row.board === d.board));
    const verb = commandOf(d.body);
    if (!verb) return this.answerQuestion(d, id, hit, row, inThread);
    if (!inThread && !(d.kind === "dm" && d.human === true)) return false;
    const cmd: Key = { source: d.kind, id };
    if (!this.store.command(cmd, row.seq)) { this.o.log(`${d.kind} ${id}: command already acted on; replay ignored`); return true; }
    const answer = (body: string) => this.answer(d, id, body, row.seq);
    // A DM thread is its two parties' only; a board thread anyone on the board can read.
    const allowed = d.human === true || d.from === row.requester || (verb === "status" && row.source === "board");
    this.o.log(`request ${row.id}: ${verb} from ${d.from}${allowed ? "" : " refused"}`);
    if (!allowed) await answer(`[factory] ${verb}: only ${oneLine(row.requester)}, who asked for this, or your user can ${verb} it.`);
    else if (verb === "status") await answer(this.statusOf(row));
    else if (verb === "cancel") await this.cancel(row, d.from, answer);
    else await this.retry(row, d, cmd, answer);
    return true;
  }

  // A command's answer, in the command's own thread.
  private async answer(d: Delivery, id: number, body: string, seq: number): Promise<void> {
    try {
      const res = d.kind === "board" ? await this.bus.call("board_post", { board: d.board, body, parent_id: id }) : await this.bus.call("dm_send", { to: d.from, body, parent_id: id });
      this.remember(d.kind, res, seq);
    } catch (e) {
      this.o.log(`couldn't answer ${d.kind} ${id}: ${msg(e)}`);
    }
  }

  // Queued: finishes cancelled. Running: its child is stopped and the run
  // ends cancelled. Fanned out: queued subtasks finish cancelled, running
  // ones are stopped, and the request finishes without synthesizing.
  private async cancel(row: Row, by: string, answer: (b: string) => Promise<void>): Promise<void> {
    const who = oneLine(by);
    if (!await this.stopTree(row, { outcome: "cancelled", head: `cancelled: by ${who}`, sub: `cancelled: by ${who} with the task it belongs to`, after: "its subtasks stop and nothing is combined" })) {
      return answer(`[factory] cancel: this already finished; nothing to cancel. Reply \`retry\` to run it again.`);
    }
  }

  // The one stop path (#655) for a cancel, a deadline and a spent tree
  // budget: queued and asking members finish with the stop's reply, running
  // ones are killed and end with it, and the request never synthesizes.
  // False when the request had already finished.
  private async stopTree(root: Row, s: Stop): Promise<boolean> {
    const res = this.store.cancel(root.seq, (r) =>
      r.seq !== root.seq ? `[factory] ${s.sub}, ${r.state === "asking" ? "while it waited for an answer" : "before it ran"}.`
        : r.state === "waiting" ? `[factory] ${s.head} after it fanned out on #${r.fanoutBoard}${this.postsOf(r)}; ${s.after}.`
          : r.state === "asking" ? `[factory] ${s.head} while it waited for an answer.`
            : `[factory] ${s.head} before it ran.`);
    if (!res) return false;
    this.o.log(`request ${root.id}: ${s.head}`);
    for (const r of res.running) {
      if (!this.cancelledBy.has(r.seq)) this.cancelledBy.set(r.seq, s);
      this.active.get(r.seq)?.abort();
    }
    this.showLoad();
    for (const f of res.finished) await this.send(f);
    return true;
  }

  // ── limits (#655) ───────────────────────────────────────────────────────
  // A root's tree budget and deadline: its fleet's, else the global ones,
  // from the config as it is now. Daily caps are read in hold() and grant().
  private limitsFor(root: Row): Limits {
    const g = this.cfg.limits, f = root.source === "board" ? this.fleets().find((f) => f.name === root.persona)?.limits : undefined;
    return { treeBudgetUsd: f?.treeBudgetUsd ?? g.treeBudgetUsd, deadlineMs: f?.deadlineMs ?? g.deadlineMs, maxRounds: f?.maxRounds ?? g.maxRounds ?? 1 };
  }

  private fleetOf(root: Row): Fleet | undefined {
    return root.source === "board" ? this.fleets().find((f) => f.name === root.persona && fleetBoard(f) === root.board) : undefined;
  }

  // What a spent daily budget holds: everything (the global cap), or the
  // fleets whose own cap is spent. An open run's grant counts as spent.
  private hold(): Hold {
    const since = Date.now() - DAY_MS, g = this.cfg.limits.dailyBudgetUsd;
    if (g !== undefined && g - this.store.spentSince(since) < MIN_GRANT_USD) return { all: true, boards: [] };
    const boards = this.fleets().filter((f) => f.limits?.dailyBudgetUsd !== undefined && f.limits.dailyBudgetUsd - this.store.spentSince(since, fleetBoard(f)) < MIN_GRANT_USD).map(fleetBoard);
    return { all: false, boards };
  }

  // Why a queued row is held, with about when it frees; null when it isn't.
  private holdNote(seq: number): string | null {
    const h = this.hold();
    if (!this.store.heldCount(h, seq)) return null;
    const row = this.store.bySeq(seq)!, root = this.rootOf(row), since = Date.now() - DAY_MS;
    const board = h.all ? undefined : (root.source === "board" ? root.board : undefined);
    const cap = h.all ? this.cfg.limits.dailyBudgetUsd! : this.fleetOf(root)?.limits?.dailyBudgetUsd;
    const oldest = this.store.oldestSince(since, board);
    const roll = oldest !== null ? `about ${dur(oldest + DAY_MS - Date.now())}` : "";
    const when = this.store.openGrants(since, board) ? `; it may free when running work reports what it spent${roll ? `, and frees in ${roll} at most` : ""}` : roll ? `; it frees in ${roll}` : "";
    return `held: ${h.all ? "the factory's" : `fleet ${root.persona}'s`} daily budget${cap !== undefined ? ` of $${cap}` : ""} is spent${when}`;
  }

  // The most this run may spend: the least of its per-run cap, what the
  // tree has left over its remaining stages, and what each day cap has
  // left. undefined: no cap. HELD: a day is spent (the row waits). A
  // string: the tree's budget is spent (the tree stops).
  private grant(row: Row, root: Row, set: Settings, lim: Limits): number | undefined | string | typeof HELD {
    const caps: number[] = [];
    if (set.policy.budgetUsd !== undefined) caps.push(set.policy.budgetUsd);
    const since = Date.now() - DAY_MS, g = this.cfg.limits.dailyBudgetUsd, f = this.fleetOf(root)?.limits?.dailyBudgetUsd;
    if (g !== undefined) caps.push(g - this.store.spentSince(since));
    if (f !== undefined && root.source === "board") caps.push(f - this.store.spentSince(since, root.board));
    if (caps.slice(set.policy.budgetUsd !== undefined ? 1 : 0).some((c) => c < MIN_GRANT_USD)) return HELD;
    if (lim.treeBudgetUsd !== undefined) {
      // A subtask shares what's left with its siblings still to run and the
      // synthesis, so fan-out stays parallel and the synthesis keeps a share.
      // A review that may plan (#658) keeps a quarter: the rest is for its
      // round (at least two subtasks) and the review after it.
      const stages = row.parent !== null ? this.store.siblingsLeft(row.parent, row.seq) + 2 : this.planning.has(row.seq) ? 4 : 1;
      const left = lim.treeBudgetUsd - this.store.treeSpent(root.seq);
      if (left / stages < MIN_GRANT_USD) return `stopped: the task's budget of $${lim.treeBudgetUsd} is spent ($${Math.max(0, lim.treeBudgetUsd - left).toFixed(2)} used)`;
      caps.push(left / stages);
    }
    return caps.length ? Math.min(...caps) : undefined;
  }

  private deadlineStop(ms: number): Stop {
    return { outcome: "deadline", head: `stopped: the task passed its deadline of ${dur(ms)}`, sub: `stopped: its task passed its deadline of ${dur(ms)}`, after: "its subtasks stop and nothing is combined" };
  }

  private budgetStop(usd: number, root: Row): Stop {
    const where = root.fanoutBoard ? `; each finished subtask's outcome is on #${root.fanoutBoard}` : ""; // stopTree's reply names the posts
    return { outcome: "budget", head: `stopped: the task's budget of $${usd} is spent`, sub: `stopped: its task's budget of $${usd} is spent`, after: `nothing more runs and nothing is combined${where}` };
  }

  // Trees past their deadline stop, whatever their members are doing
  // (running, asking or held). Checked with the question clocks and at start.
  private async deadlines(): Promise<void> {
    const now = Date.now();
    for (const r of this.store.openRoots()) {
      const ms = this.limitsFor(r).deadlineMs;
      if (ms !== undefined && r.created_at + ms <= now) await this.stopTree(r, this.deadlineStop(ms));
    }
  }

  // A finished request's task again, as a new request keyed by the command
  // and answered in its thread. A DM's goes to whoever sent the command, the
  // only party in that thread.
  private async retry(row: Row, d: Delivery, cmd: Key, answer: (b: string) => Promise<void>): Promise<void> {
    if (row.state !== "finished") return answer(`[factory] retry: this is still ${row.state === "waiting" ? "running its subtasks" : row.state === "asking" ? "waiting for an answer" : row.state}; reply \`cancel\` first.`);
    const base = { id: cmd.id, persona: row.persona, task: row.task, ...(row.context !== undefined ? { context: row.context } : {}) };
    if (row.source === "dm") {
      const r: Request = { ...base, source: "dm", requester: d.from! };
      const agent = resolvePersona(r.persona, this.runner.roster());
      if (!agent) { if (this.store.admitFinished(r, this.declineBody(r))) await this.send(this.store.get(r)!); return; }
      return this.admit(r, agent, `persona "${oneLine(r.persona)}"`);
    }
    const r: Request = { ...base, source: "board", board: row.board, requester: row.requester };
    const fleet = this.fleets().find((f) => f.name === row.persona);
    const agent = fleet && this.runner.roster().find((a) => a.name === fleet.agent);
    if (!fleet || !agent) {
      const why = fleet ? `fleet "${fleet.name}"'s agent \`${fleet.agent}\` isn't in the ${this.runner.harness} roster (${this.runner.rosterSource})` : `fleet "${oneLine(row.persona)}" is no longer in the factory's config`;
      if (this.store.admitFinished(r, `[factory] declined: ${why}. Nothing was spawned.`)) await this.send(this.store.get(r)!);
      return;
    }
    return this.admit(r, agent, `fleet "${fleet.name}"`, { fanout: fleet.fanout !== false && !this.noFanout.has(fleet.name) });
  }

  // The tree's subtask posts (#668): a work board holds many trees' posts,
  // so a reply that points at it names this tree's.
  private postsOf(root: Row): string {
    const ids = this.store.subtasks(root.seq).filter((s) => s.source === "board" && s.board === root.fanoutBoard).map((s) => s.id);
    return ids.length ? ` (post${ids.length === 1 ? "" : "s"} ${ids.join(", ")})` : "";
  }

  // A failed review's pointer to the rounds it can't combine.
  private earlierOn(row: Row): string {
    return row.phase === "synthesize" && row.fanoutBoard ? `; nothing is combined, and each earlier subtask's outcome is on #${row.fanoutBoard}${this.postsOf(row)}` : "";
  }

  // State, and the turns and cost of the tree's finished runs so far.
  private statusOf(row: Row): string {
    const subs = this.store.subtasks(row.seq);
    const runs = [row, ...subs].flatMap((r) => this.store.runs(r.seq));
    const open = runs.filter((r) => r.ended_at === null);
    let state: string;
    if (row.state === "queued") state = `queued, ${this.holdNote(row.seq) ?? `${this.store.queuedAhead(row)} ahead`}`;
    else if (row.state === "running") state = open.length ? `running: ${this.runner.harness} agent \`${open[0]!.agent}\` for ${ago(open[0]!.started_at)}` : "running: starting";
    else if (row.state === "waiting") {
      const cur = subs.filter((s) => s.round === row.round), asking = cur.filter((s) => s.state === "asking").length, m = this.limitsFor(row).maxRounds ?? 1;
      state = `fanned out on #${row.fanoutBoard}${this.postsOf(row)}${m > 1 ? `, round ${row.round} of ${m}` : ""}: ${cur.filter((s) => s.state === "finished").length} of ${cur.length} subtasks finished${asking ? `, ${asking} asking` : ""}`;
    } else if (row.state === "asking") state = `asking${row.askHuman ? " your user" : ""}: "${oneLine((row.question ?? "").split("\n")[0] ?? "")}", for ${ago(row.askedAt ?? Date.now())}`;
    else state = `finished: ${oneLine((row.reply ?? "").split("\n")[0] ?? "")}`;
    const done = runs.filter((r) => r.ended_at !== null);
    const turns = done.reduce((n, r) => n + (r.turns ?? 0), 0), cost = done.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    return `[factory] status: ${state}. ${done.length} run${done.length === 1 ? "" : "s"} finished so far${done.length ? `: ${turns} turn${turns === 1 ? "" : "s"}, $${cost.toFixed(4)}` : ""}.${this.progressOf(row, subs)}`;
  }

  // The running rows' latest progress notes (#669). They're the runs' own
  // words, and the status reply goes to the bus: fenced, so a handle in one
  // wakes nobody.
  private progressOf(row: Row, subs: Row[]): string {
    const lines = [row, ...subs].filter((r) => r.state === "running" && r.progress !== null)
      .map((r) => `${r.seq === row.seq ? "this request" : `subtask ${r.seq}${r.title ? ` (${oneLine(r.title)})` : ""}`}, ${ago(r.progressAt ?? Date.now())} ago: ${r.progress}`);
    return lines.length ? `\nProgress, in the runs' own words:\n${fenced(lines.join("\n"))}` : "";
  }

  private async housekeeping(): Promise<void> {
    for (const row of this.store.unsent()) {
      if (this.stopping) return;
      await this.send(row);
    }
    const n = this.store.prune(this.o.retentionMs);
    if (n) this.o.log(`pruned ${n} finished request${n === 1 ? "" : "s"}`);
    // After the prune: a tree goes once its request's row has.
    const t = await this.o.workspaces.sweep((seq) => this.store.has(seq));
    if (t) this.o.log(`removed ${t} working director${t === 1 ? "y" : "ies"} of pruned requests`);
    const x = this.sweepTranscripts();
    if (x) this.o.log(`removed ${x} transcript${x === 1 ? "" : "s"} of pruned runs`);
  }

  // A transcript goes once its run's row has (pruned with its request).
  // Anything else in the directory is left alone.
  private sweepTranscripts(): number {
    let n = 0;
    let names: string[];
    try { names = readdirSync(this.o.runs); } catch { return 0; }
    for (const f of names) {
      const m = /^(\d+)\.jsonl(?:\.mcp\.json)?$/.exec(f); // a crashed run's --mcp-config file (#669) too
      if (!m || this.store.hasRun(Number(m[1]))) continue;
      try { rmSync(join(this.o.runs, f), { force: true }); n++; } catch {}
    }
    return n;
  }
}

type Settings = { policy: Policy; workdir: Workdir; agent?: string };
// What stopped a tree (#655): the run outcome its running members end with,
// the reply's head, and what the fanned-out request's reply adds.
type Stop = { outcome: RunOutcome; head: string; sub: string; after: string };
const HELD = "\u0000held";


function clip(body: string): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_REPLY_BYTES) return body;
  const cut = new TextDecoder().decode(bytes.slice(0, MAX_REPLY_BYTES)).replace(/�$/, "");
  return `${cut}\n\n[factory] output truncated at ${MAX_REPLY_BYTES} bytes.`;
}

// A thread command (#651): the whole body, leading @mentions stripped, case
// and trailing punctuation ignored.
export function commandOf(body: string): "cancel" | "retry" | "status" | null {
  const w = body.trim().replace(/^(@[\w.-]+[\s,:]*)+/, "").trim().toLowerCase().replace(/[.!?]+$/, "");
  return w === "cancel" || w === "retry" || w === "status" ? w : null;
}

function ago(t: number): string {
  return dur(Date.now() - t);
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
